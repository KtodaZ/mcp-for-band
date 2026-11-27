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
