// This module accesses the BAND web API through the signed-in Chrome tab.
//
// BAND's web client signs every api*.band.us request with md and akey headers using its own
// JavaScript. This module fetches data through BAND's client code without forging signatures:
//   1. capture() loads a BAND page and collects the JSON responses that the page requests. It
//      takes a few seconds per page and records each captured URL's path and parameter names.
//   2. call() sends a request through BAND's API client in the page so BAND signs it. Each call
//      takes a few hundred milliseconds and handles all reads and writes for known endpoints.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { bandTab } from "./chrome";
import { DATA_DIR } from "./config";

export class BandError extends Error {
  constructor(public readonly kind: "auth" | "network" | "shape" | "rate_limited" | "unsupported", message: string) {
    super(message);
  }
}

const ORIGIN = "https://www.band.us";
const API_RE = /^https:\/\/api[\w-]*\.band\.us\//;
const ENDPOINTS_PATH = path.join(DATA_DIR, "endpoints.json");

export type Captured = { url: string; method: string; status: number; json: any };

let lastRenewal = 0;

/** Make sure the tab is on band.us and signed in. BAND renews its 5-minute session cookie by itself on page load. */
export async function ensureSession(page?: Page): Promise<Page> {
  const p = page ?? (await bandTab());
  const onBand = p.url().startsWith(ORIGIN);
  if (!onBand || Date.now() - lastRenewal > 4 * 60_000) {
    await p.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    for (let i = 0; i < 30 && /auth\.band\.us\/(refresh|.*callback)/.test(p.url()); i++) await p.waitForTimeout(300);
    await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    lastRenewal = Date.now();
  }
  if (/auth\.band\.us\/(?!refresh)|\/login\b/.test(p.url())) {
    throw new BandError("auth", "BAND sign-in needed. Run `band-mcp signin` (or ask Claude to sign the BAND MCP in).");
  }
  return p;
}

export async function signedIn(): Promise<{ signedIn: boolean; url: string }> {
  try {
    const p = await ensureSession();
    return { signedIn: true, url: p.url() };
  } catch (e) {
    if (e instanceof BandError && e.kind === "auth") return { signedIn: false, url: (await bandTab()).url() };
    throw e;
  }
}

function recordEndpoints(caps: Captured[]) {
  let known: Record<string, { method: string; params: string[]; seen: string }> = {};
  try { known = JSON.parse(fs.readFileSync(ENDPOINTS_PATH, "utf8")); } catch { /* first run */ }
  let changed = false;
  for (const c of caps) {
    const u = new URL(c.url);
    const key = `${c.method} ${u.host}${u.pathname}`;
    const params = [...new Set([...(known[key]?.params ?? []), ...u.searchParams.keys()])].sort();
    if (!known[key] || known[key]!.params.length !== params.length) {
      known[key] = { method: c.method, params, seen: new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(ENDPOINTS_PATH, JSON.stringify(known, null, 2));
}

/**
 * Load a BAND page and collect JSON responses from BAND's API whose URL matches `match`.
 * `then` can interact with the page (scroll, click "previous comments") while capture runs.
 */
export async function capture(url: string, match: RegExp, opts: { settleMs?: number; then?: (page: Page, caps: Captured[]) => Promise<void> } = {}): Promise<Captured[]> {
  const page = await ensureSession();
  const caps: Captured[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: import("playwright-core").Response) => {
    const u = res.url();
    if (!API_RE.test(u)) return;
    pending.push((async () => {
      try {
        const json = await res.json();
        const c = { url: u, method: res.request().method(), status: res.status(), json };
        recordEndpoints([c]);
        if (match.test(u)) caps.push(c);
      } catch { /* not JSON */ }
    })());
  };
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: opts.settleMs ?? 8000 }).catch(() => undefined);
    await Promise.all(pending);
    if (opts.then) {
      await opts.then(page, caps);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      await Promise.all(pending);
    }
  } finally {
    page.off("response", onResponse);
  }
  if (/auth\.band\.us|\/login\b/.test(page.url())) throw new BandError("auth", "BAND sign-in needed");
  for (const c of caps) checkResult(c);
  return caps;
}

function checkResult(c: Captured) {
  const code = c.json?.result_code;
  if (c.status === 429 || code === 1003) throw new BandError("rate_limited", "BAND is rate limiting requests; stopped.");
  if (code === 2 || code === 401 || c.status === 401) throw new BandError("auth", "BAND rejected the session");
}

// BAND's webpack bundle has an API client class (module 283 today) whose send() adds the akey and
// md headers and refreshes the session. An init script captures webpack's require on page load so
// call() can use that class. The module is found by shape, not by id, in case the bundle changes.
const HOOK = `(() => {
  if (window.__bmcpReq) return;
  const orig = Function.prototype.call;
  Function.prototype.call = function (...args) {
    const r = args[3];
    if (typeof r === "function" && r.m && r.c) { window.__bmcpReq = r; Function.prototype.call = orig; }
    return orig.apply(this, args);
  };
  setTimeout(() => { if (Function.prototype.call !== orig) Function.prototype.call = orig; }, 30000);
})()`;
const FIND_CLIENT = `(() => {
  const req = window.__bmcpReq;
  if (!req) return null;
  if (window.__bmcpClient) return true;
  for (const id of Object.keys(req.c)) {
    const ex = req.c[id] && req.c[id].exports;
    if (typeof ex === "function" && ex.prototype && typeof ex.prototype.send === "function" && typeof ex.prototype.__send === "function") {
      window.__bmcpClient = new ex({ bandApi: true });
      return true;
    }
  }
  return false;
})()`;
const hooked = new WeakSet<Page>();

async function clientPage(): Promise<Page> {
  const page = await bandTab();
  if (!hooked.has(page)) {
    await page.addInitScript(HOOK);
    hooked.add(page);
    lastRenewal = 0; // reload so the hook sees the bundle start
  }
  await ensureSession(page);
  let found = await page.evaluate(FIND_CLIENT);
  if (found === null) {
    lastRenewal = 0;
    await ensureSession(page);
    found = await page.evaluate(FIND_CLIENT);
  }
  if (!found) throw new BandError("unsupported", "Couldn't find BAND's API client in the page; BAND may have changed its web app");
  return page;
}

/**
 * Call a BAND API endpoint through BAND's own client in the page, so BAND signs the request.
 * `endpoint` is a path such as "v2.0.0/get_posts_and_announcements".
 */
// Requests from this process go one at a time, at most about 3 per second, to stay well clear of BAND's limits.
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const MIN_GAP_MS = 300;

export function call(endpoint: string, data: Record<string, unknown> = {}, method: "GET" | "POST" = "GET"): Promise<any> {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await callNow(endpoint, data, method); } finally { lastCall = Date.now(); }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function callNow(endpoint: string, data: Record<string, unknown>, method: "GET" | "POST"): Promise<any> {
  const page = await clientPage();
  const url = `https://api.band.us/${endpoint.replace(/^\//, "")}`;
  const out = await page.evaluate(`new Promise((resolve) => {
    window.__bmcpClient.send({ url: ${JSON.stringify(url)}, data: ${JSON.stringify(data)}, method: ${JSON.stringify(method)} })
      .then((json) => resolve({ ok: true, status: 200, json }), (json, _t, xhr) => resolve({ ok: false, status: (xhr && xhr.status) || 0, json: json && typeof json === "object" ? json : null }));
  })`) as { ok: boolean; status: number; json: any };
  const cap = { url: `${url}?${new URLSearchParams(Object.keys(data).map((k) => [k, ""]))}`, method, status: out.status, json: out.json };
  checkResult(cap);
  if (!out.ok || out.json?.result_code !== 1) {
    throw new BandError("network", `BAND ${endpoint} failed (HTTP ${out.status}, result_code ${out.json?.result_code ?? "none"}${out.json?.result_data?.message ? `: ${String(out.json.result_data.message).slice(0, 200)}` : ""})`);
  }
  recordEndpoints([cap]);
  return out.json;
}

/** Run a page interaction step (used by sign-in and write flows). */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return fn(await bandTab());
}

export const bandUrl = {
  home: () => `${ORIGIN}/`,
  band: (no: number) => `${ORIGIN}/band/${no}`,
  posts: (no: number) => `${ORIGIN}/band/${no}/post`,
  post: (no: number, postNo: string | number) => `${ORIGIN}/band/${no}/post/${postNo}`,
  events: (no: number, month: string) => `${ORIGIN}/band/${no}/event?currentDate=${month}`,
  event: (no: number, scheduleId: string) => `${ORIGIN}/band/${no}/schedule/${encodeURIComponent(scheduleId)}`,
  members: (no: number) => `${ORIGIN}/band/${no}/member`,
  search: (no: number, q: string) => `${ORIGIN}/band/${no}/search?keyword=${encodeURIComponent(q)}`,
  chats: () => `${ORIGIN}/chat`,
};
