// Dev helper: bring the MCP's Chrome window to the front (show) or minimize it again (hide).
//   show.ts show [url]   |   show.ts hide
import { chromium } from "playwright-core";
import { CDP_PORT } from "../src/config";
const hide = process.argv[2] === "hide";
const url = process.argv[3];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0]!;
const page = ctx.pages().find((p) => p.url().startsWith("http")) ?? (await ctx.newPage());
if (url) await page.goto(url);
const cdp = await ctx.newCDPSession(page);
const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: hide ? "minimized" : "normal" } });
if (!hide) await page.bringToFront();
console.log(page.url());
await browser.close();
