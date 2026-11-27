// Dev helper for the write spike on the private test band: run a short Playwright snippet against
// the drive tab (window.name "bmcp-drive"), then print the non-GET BAND API requests the step made (test band only: values are printed).
//   ui.ts '<js using page>' [shot.png]
import { chromium } from "playwright-core";
import fs from "node:fs";
const [arg, shot] = process.argv.slice(2);
// Pass a .js file instead of inline code on Windows, where multi-line arguments break the shim.
const code = arg!.endsWith(".js") && fs.existsSync(arg!) ? fs.readFileSync(arg!, "utf8") : arg!;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0]!;
let page: any = null;
for (const p of ctx.pages()) if ((await p.evaluate("window.name").catch(() => "")) === "bmcp-drive") page = p;
if (!page) throw new Error("no drive tab");
const log: any[] = [];
page.on("request", (r: any) => {
  const u = r.url();
  // BAND sends some writes as GET (set_band_notice_state), so match write-like names too.
  const write = r.method() !== "GET" || /\/(set|create|update|edit|modify|delete|remove|add|write|send|upload|register|unset)_/.test(u);
  if (!u.includes("band.us/") || !write || !/^https:\/\/([\w]+-)?(api|up|bapi)[\w-]*\./.test(u)) return;
  const entry: any = { method: r.method(), url: r.method() === "GET" ? u.replace(/([?&])ts=\d+&?/, "$1") : u.split("?")[0], body: r.postData()?.slice(0, 600) ?? null, type: r.headers()["content-type"] ?? null };
  log.push(entry);
  r.response().then(async (res: any) => { const j = await res?.json().catch(() => null); entry.rc = j?.result_code; entry.data = JSON.stringify(j?.result_data ?? null).slice(0, 300); }).catch(() => undefined);
});
const fn = new Function("page", `return (async () => { ${code} })()`);
try { const r = await fn(page); if (r !== undefined) console.log(typeof r === "string" ? r : JSON.stringify(r)); }
finally {
  await page.waitForTimeout(1500);
  if (shot) await page.screenshot({ path: shot });
  for (const l of log) console.log("REQ", JSON.stringify(l));
  await browser.close().catch(() => undefined);
}
