// Dev helper: bring the MCP's Chrome window on-screen (show) or move it back off-screen (hide).
import { chromium } from "playwright-core";
const hide = process.argv[2] === "hide";
const url = process.argv[3];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0]!;
const page = ctx.pages().find((p) => p.url().startsWith("http")) ?? (await ctx.newPage());
if (url) await page.goto(url);
const cdp = await ctx.newCDPSession(page);
const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
await cdp.send("Browser.setWindowBounds", { windowId, bounds: hide ? { left: -2400, top: 0, width: 1100, height: 850 } : { left: 200, top: 80, width: 1100, height: 850 } });
if (!hide) await page.bringToFront();
console.log(page.url());
await browser.close();
