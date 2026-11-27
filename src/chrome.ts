// This module manages a standard Chrome instance without automation flags, using a dedicated
// profile and a DevTools port on 127.0.0.1. Any server process can start or attach to it so
// multiple Claude sessions share one signed-in BAND session. Scripts type credentials and codes
// only from user-supplied files, and this module never prints them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CDP_PORT, CHROME_PATHS, PROFILE_DIR, ensureDataDir } from "./config";

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
    // Off-screen rather than headless: headless Chrome announces itself in its user agent.
    "--window-position=-2400,0",
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
  }
  return browser.contexts()[0]!;
}

/** This process's own BAND tab, kept open between calls. */
let tab: Page | null = null;
export async function bandTab(): Promise<Page> {
  if (tab && !tab.isClosed()) return tab;
  const ctx = await context();
  tab = await ctx.newPage();
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
  const page = await (await context()).newPage();
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
  const place = (left: number) => cdp.send("Browser.setWindowBounds", { windowId, bounds: { left, top: 80, width: 1100, height: 850 } });
  const signedIn = async () => /^https:\/\/www\.band\.us\/(home|band|discover|feed)/.test(page.url()) && !(await page.$("a[href*='login'], .loginBtn").catch(() => null));
  try {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await page.goto("https://www.band.us/home");
    await page.waitForTimeout(1500);
    if (await signedIn()) return true;
    await place(200);
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
    await place(-2400).catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}
