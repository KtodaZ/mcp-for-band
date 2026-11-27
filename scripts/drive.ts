// Dev helper: drive the MCP's Chrome (CDP on 127.0.0.1:9333) one step at a time.
//   drive.ts shot <png>                 screenshot + list inputs/buttons
//   drive.ts fill <selector> <file>     type a value read from a file (never printed)
//   drive.ts click <text|css=selector>  click
//   drive.ts goto <url>
import { chromium } from "playwright-core";
import fs from "node:fs";
const [cmd, a, b] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0]!;
// Own tab, marked by window.name, so the server's tab is never touched.
let page = null as import("playwright-core").Page | null;
for (const p of ctx.pages()) if ((await p.evaluate("window.name").catch(() => "")) === "bmcp-drive") page = p;
if (!page) { page = await ctx.newPage(); await page.goto("https://www.band.us/"); await page.evaluate("window.name = \"bmcp-drive\""); }
if (cmd === "goto") { await page.goto(a!); await page.evaluate("window.name = \"bmcp-drive\""); }
if (cmd === "fill") { await page.locator(a!).fill(fs.readFileSync(b!, "utf8").trim()); }
if (cmd === "click") { await (a!.startsWith("css=") ? page.locator(a!.slice(4)) : page.getByText(a!, { exact: false })).first().click(); }
if (cmd !== "shot") await page.waitForTimeout(3000);
console.log("url:", page.url());
const ui = await page.evaluate(() => [...document.querySelectorAll("input:not([type=hidden]),button,a[role=button]")].filter((e) => (e as HTMLElement).offsetParent).map((e) => `${e.tagName.toLowerCase()}${(e as HTMLInputElement).name ? "[name=" + (e as HTMLInputElement).name + "]" : ""}${(e as HTMLInputElement).type ? ":" + (e as HTMLInputElement).type : ""} "${(e.textContent || (e as HTMLInputElement).placeholder || "").trim().slice(0, 40)}"`));
console.log(ui.join("\n"));
if (cmd === "shot" && a) await page.screenshot({ path: a });
await browser.close().catch(() => undefined);
