// This module manages a standard Chrome instance without automation flags, using a dedicated
// profile and a DevTools port on 127.0.0.1. Its window is an ordinary Chrome window, minimized by
// default; sign-in brings it to the front. Any server process can start or attach to it so
// multiple Claude sessions share one signed-in BAND session. Scripts type credentials and codes
// only from user-supplied files, and this module never prints them.
import { execFile, spawn } from "node:child_process";
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

// macOS brings a newly started Chrome to the front. These read and restore the app that was in
// front before, by process id, through AppKit (no Accessibility or Automation permission needed).
const jxa = (code: string) => new Promise<string>((resolve) => {
  execFile("osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit");${code}`], { timeout: 3000 }, (e, out) => resolve(e ? "" : String(out).trim()));
});
const frontPid = async () => Number(await jxa("$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier")) || null;
const activatePid = (pid: number) => jxa(`$.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).activateWithOptions(0)`);

/**
 * Put the app that was in front before Chrome started back in front, but only while the Chrome we
 * started is the one in front. Chrome can take focus a moment after it's up, so check a few times.
 * If the user switches to another app meanwhile, leave it.
 */
async function restoreFront({ prev, chrome }: Launch) {
  for (let i = 0; i < 4; i++) {
    const now = await frontPid();
    if (now === chrome) await activatePid(prev);
    else if (now !== prev) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

type Launch = { prev: number; chrome: number };

/** Start Chrome if it isn't running. On macOS, returns the app that was in front and Chrome's pid, so focus can go back. */
export async function ensureChrome(): Promise<Launch | null> {
  if (await cdpUp()) return null;
  ensureDataDir();
  const exe = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Chrome not found; set BAND_MCP_CHROME");
  const front = process.platform === "darwin" ? await frontPid() : null;
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
    if (await cdpUp()) return front && child.pid ? { prev: front, chrome: child.pid } : null;
  }
  throw new Error("Chrome did not open its DevTools port");
}

let browser: Browser | null = null;

export async function context(): Promise<BrowserContext> {
  if (!browser || !browser.isConnected()) {
    const launch = await ensureChrome();
    browser = await chromium.connectOverCDP(CDP);
    await closeOrphanTabs(browser.contexts()[0]!).catch(() => undefined);
    await applyWindowMode(browser.contexts()[0]!).catch(() => undefined);
    if (launch) await restoreFront(launch);
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
  // Opening a tab can restore a minimized window, so minimize it again.
  if (windowMode() === "minimized") await minimize(page);
  return page;
}

/** A sign-in tab marks itself so other processes don't minimize the window while the user signs in. */
const SIGNIN = /^bmcp-signin-(\d+)$/;
const nameOf = (p: Page) => p.evaluate("window.name").catch(() => null) as Promise<string | null>;

/** Minimize the window unless a live process is waiting for the user to sign in. */
async function minimize(page: Page) {
  for (const p of page.context().pages()) {
    const pid = SIGNIN.exec((await nameOf(p)) ?? "")?.[1];
    if (pid && alive(Number(pid))) return;
  }
  await setWindow(page, { windowState: "minimized" }).catch(() => undefined);
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

/** Close tabs left by server processes that are gone. Unmarked tabs may be the user's own, so they stay. */
async function closeOrphanTabs(ctx: BrowserContext) {
  const pages = ctx.pages();
  const doomed: Page[] = [];
  for (const p of pages) {
    const pid = /^bmcp-(?:signin-)?(\d+)$/.exec((await nameOf(p)) ?? "")?.[1];
    if (pid && !alive(Number(pid))) doomed.push(p);
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
  if (windowMode() === "minimized") await minimize(page);
  else await setWindow(page, { windowState: "normal" });
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
  const mark = `window.name = "bmcp-signin-${process.pid}"`;
  await page.addInitScript(mark); // runs after ownPage's mark, so this name wins
  await page.evaluate(mark).catch(() => undefined);
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
