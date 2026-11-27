// This module uploads photo and video attachments for posts and comments, mapped on the test
// band on 2026-11-26 in docs/band-web-api.md. Because BAND signs uploads itself, the server uses
// BAND's comment-box file input in a separate tab. DevTools passes Chrome the local file path
// through DOM.setFileInputFiles without a size limit, and the server reads the upload response.
// That tab posts nothing, and the write runs through call() with the uploaded ids.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { BandError } from "./band";
import { context } from "./chrome";
import { DATA_DIR } from "./config";

export type MediaKind = "photo" | "video";
export interface Attachment { path: string; sha256: string; kind: MediaKind; bytes: number }
export interface Uploaded { kind: MediaKind; id: string; url: string; width: number; height: number; title: string }

const PHOTO = /\.(jpe?g|png|gif|heic|webp)$/i;
const VIDEO = /\.(mp4|mov|m4v|avi|wmv|mpe?g|3gp|mts|ts|flv)$/i;

const sha256File = (p: string) => new Promise<string>((resolve, reject) => {
  const h = crypto.createHash("sha256");
  fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
});

/** Hash each file so the approval is bound to these exact bytes. */
export async function attachments(photos: string[] = [], videos: string[] = []): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const [kind, list, re] of [["photo", photos, PHOTO], ["video", videos, VIDEO]] as const) {
    for (const raw of list) {
      const p = path.resolve(raw);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new BandError("unsupported", `No such file: ${raw}`);
      if (!re.test(p)) throw new BandError("unsupported", `${path.basename(p)} doesn't look like a ${kind}`);
      out.push({ path: p, sha256: await sha256File(p), kind, bytes: fs.statSync(p).size });
    }
  }
  return out;
}

export const describe = (a: Attachment) => `${path.basename(a.path)}${a.kind === "video" ? ` (${(a.bytes / 1024 ** 2).toFixed(1)} MB)` : ""}`;

/**
 * Upload each attachment through BAND's comment box on `pageUrl` (any page in the band with a
 * comment box: the post or event itself, or the band's feed). One file per page load, so a
 * photo and a video never share a box. Refuses a file that changed since it was approved.
 */
export async function upload(pageUrl: string, items: Attachment[]): Promise<Uploaded[]> {
  if (!items.length) return [];
  // Copy every file privately and check each copy against its approved hash before opening Chrome,
  // so a changed file stops the write before anything is uploaded, and can't change mid-upload.
  const stage = fs.mkdtempSync(path.join(DATA_DIR, "upload-"));
  let page: Page | undefined;
  try {
    const copies = [];
    for (const [i, a] of items.entries()) {
      const title = path.basename(a.path);
      const copy = path.join(stage, `${i}${path.extname(a.path)}`);
      try { fs.copyFileSync(a.path, copy); } catch { throw new BandError("unsupported", `Can't read ${title} any more; prepare the write again`); }
      if ((await sha256File(copy)) !== a.sha256) throw new BandError("unsupported", `${title} changed since it was approved; prepare the write again`);
      copies.push({ a: { ...a, path: copy }, title });
    }
    page = await (await context()).newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => undefined));
    const out: Uploaded[] = [];
    for (const { a, title } of copies) out.push(await uploadOne(page, pageUrl, a, title));
    return out;
  } finally {
    await page?.close().catch(() => undefined);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function uploadOne(page: Page, pageUrl: string, a: Attachment, title: string): Promise<Uploaded> {
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (/auth\.band\.us|\/login\b/.test(page.url())) throw new BandError("auth", "BAND sign-in needed. Call the sign_in tool.");
  await page.waitForSelector("input._mediaUploadInput", { state: "attached", timeout: 20_000 })
    .catch(() => { throw new BandError("unsupported", "No comment box on that BAND page to upload through"); });
  // Allow about 200 KB/s, and at least two minutes.
  const timeout = Math.max(120_000, Math.ceil(a.bytes / 200_000) * 1000);
  const done = page.waitForResponse((r) => /^https:\/\/[\w-]*up\.band\.us\/v\d+\/upload_(photo|video)/.test(r.url()) && r.request().method() === "POST", { timeout });
  done.catch(() => undefined); // awaited below; this keeps an early failure from going unhandled
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input._mediaUploadInput" }) as { nodeId: number };
    if (!nodeId) throw new BandError("unsupported", "BAND's upload input disappeared");
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [a.path] });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  const res = await done.catch(() => { throw new BandError("network", `Uploading ${title} to BAND timed out`); });
  const json = await res.json().catch(() => null) as any;
  const d = json?.result_data;
  if (json?.result_code !== 1 || !d?.url) throw new BandError("network", `BAND refused the upload of ${title} (result_code ${json?.result_code ?? "none"})`);
  const kind: MediaKind = /upload_video/.test(res.url()) ? "video" : "photo";
  if (kind !== a.kind) throw new BandError("shape", `BAND took ${title} as a ${kind}`);
  return { kind, id: String(d.id ?? ""), url: String(d.url), width: Number(d.width) || 0, height: Number(d.height) || 0, title };
}

/** create_post fields: attachment tags after the text, and photo/video maps keyed by those tag ids. */
export function postFields(content: string, up: Uploaded[]) {
  const photo: Record<string, object> = {};
  const video: Record<string, object> = {};
  let tags = "";
  up.forEach((u, i) => {
    const key = `c${i + 1}`;
    tags += `<band:attachment type="${u.kind}" id="${key}" />`;
    if (u.kind === "photo") photo[key] = { url: u.url, width: u.width, height: u.height };
    else video[key] = { id: u.id, url: u.url, width: u.width, height: u.height, title: u.title, is_gif: false, live_id: "", is_soundless: false };
  });
  return {
    content: tags ? `${content}${content ? "\n" : ""}${tags}` : content,
    ...(Object.keys(photo).length ? { photo: JSON.stringify(photo) } : {}),
    ...(Object.keys(video).length ? { video: JSON.stringify(video) } : {}),
  };
}

/** create_comment fields: several photos, or one video. */
export function commentFields(up: Uploaded[]) {
  const photos = up.filter((u) => u.kind === "photo");
  const videos = up.filter((u) => u.kind === "video");
  return {
    photos: photos.length ? JSON.stringify(photos.map((u) => ({ url: u.url, width: u.width, height: u.height }))) : "",
    video: videos.length ? JSON.stringify({ id: videos[0]!.id, url: videos[0]!.url, width: videos[0]!.width, height: videos[0]!.height, title: videos[0]!.title, is_gif: false }) : "",
  };
}

/** BAND comments take photos or a single video, not both. */
export function checkCommentMedia(items: Attachment[]) {
  const v = items.filter((a) => a.kind === "video").length;
  if (v > 1 || (v && items.length > v)) throw new BandError("unsupported", "A BAND comment can have several photos or one video, not both");
}
