// This module manages a standard Chrome instance without automation flags, using a dedicated
// profile and a DevTools port on 127.0.0.1. Its window is an ordinary Chrome window, minimized by
// default; sign-in brings it to the front. Any server process can start or attach to it so
// multiple Claude sessions share one signed-in BAND session. Scripts type credentials and codes
// only from user-supplied files, and this module never prints them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CDP_PORT, CHROME_PATHS, PROFILE_DIR, ensureDataDir, loadSettings } from "./config";

const CDP = `http://127.0.0.1:${CDP_PORT}`;

async function cdpUp() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ensureChrome(): Promise<void> {
  if (await cdpUp()) return;
  ensureDataDir();
  const exe = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Chrome not found; set BAND_MCP_CHROME");
  const child = spawn(exe, [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    // A normal window, minimized once it's up (see applyWindowMode). Chrome slows down minimized
    // and hidden windows, so turn that off: the server works in this window while it's minimized.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-position=200,80",
    "--window-size=1100,850",
    "about:blank",
  ], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await cdpUp()) return;
  }
  throw new Error("Chrome did not open its DevTools port");
}

let browser: Browser | null = null;

export async function context(): Promise<BrowserContext> {
  if (!browser || !browser.isConnected()) {
    await ensureChrome();
    browser = await chromium.connectOverCDP(CDP);
    await closeOrphanTabs(browser.contexts()[0]!).catch(() => undefined);
    await applyWindowMode(browser.contexts()[0]!).catch(() => undefined);
  }
  return browser.contexts()[0]!;
}

/**
 * A new tab owned by this process. Its window.name records the process id, so a later process
 * can close the tabs of one that died without closing them (killed servers used to leave tabs).
 */
export async function ownPage(ctx?: BrowserContext): Promise<Page> {
  const page = await newTab(ctx ?? (await context()));
  const mark = `window.name = "bmcp-${process.pid}"`;
  await page.addInitScript(mark);
  await page.evaluate(mark).catch(() => undefined);
  // Opening a tab restores a minimized window, so minimize it again.
  if (windowMode() === "minimized") await setWindow(page, { windowState: "minimized" }).catch(() => undefined);
  return page;
}

/**
 * Open a tab without activating it. Playwright's newPage() makes the new tab active, which on macOS
 * brings Chrome in front of the app you're using, and on Windows restores the minimized window.
 */
async function newTab(ctx: BrowserContext): Promise<Page> {
  const b = ctx.browser();
  if (!b) return ctx.newPage();
  const cdp = await b.newBrowserCDPSession();
  try {
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank", background: true })) as { targetId: string };
    // Other processes may open tabs in the same Chrome, so match this one by its target id.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const p of ctx.pages()) {
        const s = await ctx.newCDPSession(p).catch(() => null);
        if (!s) continue;
        const info = (await s.send("Target.getTargetInfo").catch(() => null)) as { targetInfo?: { targetId: string } } | null;
        await s.detach().catch(() => undefined);
        if (info?.targetInfo?.targetId === targetId) return p;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw new Error("Chrome opened a tab but it never appeared");
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Close tabs left by server processes that are gone: marked with a dead pid, or unmarked BAND tabs from older versions. */
async function closeOrphanTabs(ctx: BrowserContext) {
  const pages = ctx.pages();
  const doomed: Page[] = [];
  for (const p of pages) {
    const name = await p.evaluate("window.name").catch(() => null) as string | null;
    const pid = /^bmcp-(\d+)$/.exec(name ?? "")?.[1];
    if (pid ? !alive(Number(pid)) : name === "" && /^https:\/\/(www|auth)\.band\.us\//.test(p.url())) doomed.push(p);
  }
  // Keep one tab, or Chrome closes the window and quits.
  if (doomed.length && doomed.length === pages.length) await newTab(ctx);
  for (const p of doomed) await p.close().catch(() => undefined);
}

/** "minimized" (default) or "visible", from BAND_MCP_WINDOW or settings.json `window`. */
export function windowMode(): "minimized" | "visible" {
  const v = process.env.BAND_MCP_WINDOW || loadSettings().window;
  return v === "visible" ? "visible" : "minimized";
}

type Bounds = { left?: number; top?: number; width?: number; height?: number; windowState?: "normal" | "minimized" | "maximized" };
async function setWindow(page: Page, bounds: Bounds) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds: now } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number; bounds: Bounds };
    // Older versions parked the window off-screen; bring it back first so it restores on-screen.
    const offScreen = (now.left ?? 0) < -1000;
    if (offScreen || bounds.windowState === "normal") {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      if (offScreen) await cdp.send("Browser.setWindowBounds", { windowId, bounds: { left: 200, top: 80, width: 1100, height: 850 } });
    }
    if (bounds.windowState !== "normal") {
      // Windows ignores a minimize sent right after a move, so let the move land first.
      if (offScreen) await new Promise((r) => setTimeout(r, 500));
      await cdp.send("Browser.setWindowBounds", { windowId, bounds });
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Put the server's Chrome window in the configured state: minimized, or left as an ordinary window. */
async function applyWindowMode(ctx: BrowserContext) {
  const page = ctx.pages()[0] ?? (await newTab(ctx));
  await setWindow(page, { windowState: windowMode() === "minimized" ? "minimized" : "normal" });
}

/** This process's own BAND tab, kept open between calls. */
let tab: Page | null = null;
export async function bandTab(): Promise<Page> {
  if (tab && !tab.isClosed()) return tab;
  const ctx = await context();
  tab = await ownPage(ctx);
  return tab;
}

export async function disconnect() {
  try { if (tab && !tab.isClosed()) await tab.close(); } catch { /* gone */ }
  tab = null;
  // Disconnects from a CDP-attached browser; Chrome keeps running for other clients.
  try { await browser?.close(); } catch { /* gone */ }
  browser = null;
}

/**
 * Show the MCP's Chrome window on BAND's home page and wait for the user to sign in, then hide it
 * again. The user types their own credentials in BAND's page; nothing here reads or stores them.
 */
export async function signIn(timeoutMs = 10 * 60_000): Promise<boolean> {
  const page = await ownPage();
  const signedIn = async () => /^https:\/\/www\.band\.us\/(home|band|discover|feed)/.test(page.url()) && !(await page.$("a[href*='login'], .loginBtn").catch(() => null));
  try {
    await page.goto("https://www.band.us/home");
    await page.waitForTimeout(1500);
    if (await signedIn()) return true;
    await setWindow(page, { windowState: "normal" });
    await page.bringToFront();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (await signedIn()) return true;
    }
    return false;
  } catch (e) {
    // The user closed the tab or window: not signed in.
    if (page.isClosed() || /closed|Target.*(gone|crashed)/i.test(String((e as Error)?.message))) return false;
    throw e;
  } finally {
    if (windowMode() === "minimized") await setWindow(page, { windowState: "minimized" }).catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}
