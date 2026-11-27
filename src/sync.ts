// This module syncs BAND into the cache. BAND's web JSON is undocumented, so extraction walks
// each response and matches field names like post_no and content, comment_id and body,
// schedule_id and start_at, or band_no and name. Syncs run JSON requests through call() in
// band.ts without page loads or scrolling. See docs/band-web-api.md for endpoints.

import { call, bandUrl, BandError } from "./band";
import { localDate } from "./helpers";
import * as store from "./store";
import type { Item } from "./store";

type J = Record<string, any>;
const isObj = (v: unknown): v is J => !!v && typeof v === "object" && !Array.isArray(v);

export function walk(v: unknown, visit: (o: J) => void, depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(v)) for (const x of v) walk(x, visit, depth + 1);
  else if (isObj(v)) {
    visit(v);
    for (const x of Object.values(v)) if (x && typeof x === "object") walk(x, visit, depth + 1);
  }
}

export function toIso(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string" && /^\d{12,}$/.test(v)) return new Date(Number(v)).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");
const authorOf = (o: J) => (isObj(o.author) ? { name: String(o.author.name ?? "Unknown"), key: (o.author.member_key ?? o.author.user_key ?? o.author.user_no ?? null) as string | null } : { name: null, key: null });
const photos = (o: J) => (Array.isArray(o.photos) ? o.photos.length : isObj(o.photo) ? 1 : 0);
const photoUrls = (o: J): string[] => [...(Array.isArray(o.photos) ? o.photos : []), ...(isObj(o.photo) ? [o.photo] : [])].map((x: J) => x?.url).filter((u: unknown): u is string => typeof u === "string");
const videos = (o: J) => (isObj(o.video) ? 1 : Array.isArray(o.videos) ? o.videos.length : 0);

export function extractBands(json: unknown) {
  const out = new Map<number, { bandNo: number; name: string; memberCount?: number; role?: string; raw: unknown }>();
  walk(json, (o) => {
    if (typeof o.band_no === "number" && typeof o.name === "string" && !("schedule_id" in o) && !("post_no" in o) && ("member_count" in o || "cover" in o || "band_color" in o)) {
      out.set(o.band_no, { bandNo: o.band_no, name: o.name, memberCount: typeof o.member_count === "number" ? o.member_count : undefined, role: typeof o.role === "string" ? o.role : undefined, raw: { band_no: o.band_no, name: o.name } });
    }
  });
  return [...out.values()];
}

export function extractPosts(json: unknown, bandNo: number): Item[] {
  const out = new Map<string, Item>();
  walk(json, (o) => {
    const postNo = o.post_no ?? o.post_key;
    if ((typeof postNo === "number" || typeof postNo === "string") && ("content" in o || "body" in o) && !("comment_id" in o)) {
      const band = typeof o.band_no === "number" ? o.band_no : isObj(o.band) && typeof o.band.band_no === "number" ? o.band.band_no : bandNo;
      const a = authorOf(o);
      const id = `post:${band}:${postNo}`;
      out.set(id, {
        id, kind: "post", bandNo: band, author: a.name, authorKey: a.key, body: text(o.content ?? o.body),
        createdAt: toIso(o.created_at) ?? new Date(0).toISOString(), url: bandUrl.post(band, postNo),
        photoCount: photos(o), videoCount: videos(o), deleted: o.is_deleted === true,
        raw: { photos: photoUrls(o), comment_count: o.comment_count, emotion_count: o.emotion_count, read_count: o.read_count ?? o.post_read_count, is_notice: o.is_notice ?? o.notice, updated_at: o.updated_at },
      });
    }
  });
  return [...out.values()];
}

/** Comments (and embedded replies) under a post or event. */
export function extractComments(json: unknown, parent: { kind: "post_comment" | "event_comment"; bandNo: number; parentId: string; url: string }): Item[] {
  const out = new Map<string, Item>();
  const add = (o: J, replyTo?: string) => {
    const cid = replyTo ? o.schedule_comment_id ?? o.comment_id ?? o.comment_key : o.comment_id ?? o.schedule_comment_id ?? o.comment_key;
    if (cid === undefined || cid === null) return;
    const id = `${parent.kind}:${parent.bandNo}:${parent.parentId.split(":").slice(2).join(":")}:${cid}`;
    const a = authorOf(o);
    out.set(id, {
      id, kind: parent.kind, bandNo: parent.bandNo, parentId: replyTo ?? parent.parentId, author: a.name, authorKey: a.key,
      body: text(o.body ?? o.content), createdAt: toIso(o.created_at) ?? new Date(0).toISOString(), url: parent.url,
      photoCount: photos(o), videoCount: videos(o), deleted: o.is_deleted === true, raw: { photos: photoUrls(o) },
    });
    return id;
  };
  walk(json, (o) => {
    if (!("comment_id" in o || "comment_key" in o || "schedule_comment_id" in o) || !("body" in o || "content" in o)) return;
    if (out.has(`${parent.kind}:${parent.bandNo}:${parent.parentId.split(":").slice(2).join(":")}:${o.comment_id ?? o.schedule_comment_id ?? o.comment_key}`)) return;
    const top = add(o);
    if (top) for (const r of Array.isArray(o.latest_comment) ? o.latest_comment : []) if (isObj(r)) add(r, top);
  });
  return [...out.values()];
}

export function extractEvents(json: unknown, bandNo: number): Item[] {
  const out = new Map<string, Item>();
  walk(json, (o) => {
    if (typeof o.schedule_id !== "string" || typeof o.name !== "string" || o.start_at === undefined) return;
    if (/^5\//.test(o.schedule_id)) return; // BAND's public-holiday calendar
    const band = typeof o.band_no === "number" ? o.band_no : bandNo;
    const id = `event:${band}:${o.schedule_id}`;
    const loc = isObj(o.location) ? String(o.location.name ?? o.location.address ?? "") : "";
    out.set(id, {
      id, kind: "event", bandNo: band, title: o.name, body: [text(o.description), loc && `Location: ${loc}`].filter(Boolean).join("\n"),
      createdAt: toIso(o.start_at)!, url: bandUrl.event(band, o.schedule_id), deleted: o.is_delete === true,
      raw: { schedule_id: o.schedule_id, start_at: toIso(o.start_at), end_at: toIso(o.end_at), location: loc || null, comment_count: o.comment_count, rsvp: o.rsvp ?? o.rsvp_count ?? null },
    });
  });
  return [...out.values()];
}

export function extractMembers(json: unknown) {
  const out = new Map<string, { key: string; name: string; role?: string }>();
  walk(json, (o) => {
    const key = o.user_no ?? o.member_key ?? o.user_key;
    if ((typeof key === "string" || typeof key === "number") && typeof o.name === "string" && !("body" in o) && !("content" in o)) out.set(String(key), { key: String(key), name: o.name, role: typeof o.role === "string" ? o.role : undefined });
  });
  return [...out.values()];
}

// ── Sync operations ───────────────────────────────────────────────────────

const ymd = (d: string) => d.slice(0, 10).replace(/-/g, "");

export async function syncBands() {
  const json: any = await call("v2.3.0/get_band_list", {}, "POST");
  const bands = extractBands(json);
  if (!bands.length) throw new BandError("shape", "Couldn't find the band list in BAND's response; see endpoints.json");
  store.upsertBands(bands);
  return bands;
}

/** Feed posts back to `since` (newest first, 20 per request), then each post's comments when it has any. */
export async function syncPosts(bandNo: number, since: string, opts: { comments?: boolean; maxPages?: number } = {}) {
  const posts = new Map<string, Item>();
  let params: Record<string, unknown> | null = { band_no: bandNo, order_by: "created_at_desc", resolution_type: 4, limit: 20 };
  let reachedStart = false;
  for (let page = 0; params && page < (opts.maxPages ?? 200); page++) {
    const json: any = await call("v2.0.0/get_posts_and_announcements", params);
    const got = extractPosts(json, bandNo).filter((p) => p.bandNo === bandNo);
    for (const p of got) posts.set(p.id, p);
    // Notices can be old and still sit at the top of the feed, so only regular posts end the walk.
    if (got.some((p) => !(p.raw as J)?.is_notice && p.createdAt < since)) { reachedStart = true; break; }
    params = json.result_data?.paging?.next_params ?? null;
    if (!params) reachedStart = true; // the feed ended
  }
  const inRange = [...posts.values()].filter((p) => p.createdAt >= since);
  store.upsertItems(inRange);
  let commentsRead = 0;
  let incomplete = 0;
  if (opts.comments !== false) {
    for (const p of inRange) {
      // No comments now: any cached ones were deleted.
      if (!Number((p.raw as J)?.comment_count ?? 0)) { store.markMissingDeleted(bandNo, "post_comment", p.id, []); continue; }
      const got = await syncComments(bandNo, p, { content_type: "post", post_no: Number(p.id.split(":")[2]) }, "post_comment");
      commentsRead += got.count;
      if (!got.complete) incomplete++;
    }
  }
  store.setCoverage(bandNo, "posts", since, new Date().toISOString(), incomplete === 0 && reachedStart, incomplete ? `${incomplete} posts' comments not fully read` : !reachedStart ? "stopped before the start date" : undefined);
  return { posts: inRange.length, comments: commentsRead, incompletePosts: incomplete };
}

/** Rows for BAND comment objects. A reply's id extends its top comment's id. */
export function commentRows(list: unknown[], parent: Pick<Item, "id" | "bandNo" | "url">, kind: "post_comment" | "event_comment", replyTo?: string): Item[] {
  const local = parent.id.split(":").slice(2).join(":");
  return list.filter(isObj).map((o) => {
    const cid = String(o.comment_id ?? o.schedule_comment_id);
    const a = authorOf(o);
    return {
      id: replyTo ? `${replyTo}:${cid}` : `${kind}:${parent.bandNo}:${local}:${cid}`,
      kind, bandNo: parent.bandNo, parentId: replyTo ?? parent.id, author: a.name, authorKey: a.key,
      body: text(o.body ?? o.content), createdAt: toIso(o.created_at) ?? new Date(0).toISOString(), url: parent.url,
      photoCount: photos(o), videoCount: videos(o), deleted: o.is_deleted === true,
      raw: { photos: photoUrls(o), comment_id: o.comment_id, reply_count: o.comment_count },
    };
  });
}

async function readComments(bandNo: number, contentKey: J) {
  const items: J[] = [];
  let params: Record<string, unknown> | null = { band_no: bandNo, content_key: JSON.stringify(contentKey), resolution_type: 4 };
  let total: number | null = null;
  for (let i = 0; params && i < 50; i++) {
    const json: any = await call("v2.3.0/get_comments", params);
    const d: any = json.result_data ?? {};
    items.push(...(Array.isArray(d.items) ? d.items : []));
    total ??= typeof d.total === "number" ? d.total : null;
    params = d.paging?.previous_params ?? null; // older comments
  }
  return { items, total, done: params === null };
}

/** All comments and replies on a post or event. `complete` compares with BAND's own total. */
export async function syncComments(bandNo: number, parent: Item, contentKey: J, kind: "post_comment" | "event_comment") {
  const top = await readComments(bandNo, contentKey);
  const topRows = commentRows(top.items, parent, kind);
  const rows = [...topRows];
  const replyType = contentKey.content_type === "post" ? "post_comment" : "schedule_comment";
  for (const [i, c] of top.items.entries()) {
    if (!Number(c.comment_count ?? 0)) continue;
    const replies = await readComments(bandNo, { ...contentKey, content_type: replyType, comment_id: c.comment_id });
    rows.push(...commentRows(replies.items, parent, kind, topRows[i]!.id));
  }
  store.upsertItems(rows);
  // Only a full read shows that a missing comment was deleted; one cut off at the page limit doesn't.
  if (top.done) store.markMissingDeleted(bandNo, kind, parent.id, topRows.map((r) => r.id));
  return { count: rows.length, complete: top.done && (top.total === null || rows.length >= top.total) };
}

/** Events between two dates (YYYY-MM-DD), with all comments of events that have any. */
export async function syncEvents(bandNo: number, from: string, to: string, opts: { comments?: boolean } = {}) {
  const events = new Map<string, Item>();
  let params: Record<string, unknown> | null = { band_no: bandNo, start_at: ymd(from), future_end_at: ymd(to), calendars: "null" };
  for (let i = 0; params && i < 50; i++) {
    const json: any = await call("v1.6.0/get_schedules", params);
    for (const e of extractEvents(json, bandNo)) events.set(e.id, e);
    params = json.result_data?.paging?.next_params ?? null;
  }
  // Compare local dates: an evening event's UTC date is often the next day.
  const inRange = [...events.values()].filter((e) => { const d = localDate(e.createdAt); return d >= from && d <= to && e.bandNo === bandNo; });
  store.upsertItems(inRange);
  let comments = 0;
  let incomplete = 0;
  if (opts.comments !== false) {
    for (const e of inRange) {
      if (!Number((e.raw as J)?.comment_count ?? 0)) { store.markMissingDeleted(bandNo, "event_comment", e.id, []); continue; }
      const got = await syncComments(bandNo, e, { content_type: "schedule", schedule_id: (e.raw as J).schedule_id }, "event_comment");
      comments += got.count;
      if (!got.complete) incomplete++;
    }
  }
  store.setCoverage(bandNo, "events", from, to, incomplete === 0, incomplete ? `${incomplete} events' comments not fully read` : undefined);
  return { events: inRange.length, comments, incompleteEvents: incomplete };
}

export async function syncMembers(bandNo: number) {
  const json: any = await call("v2.0.0/get_members_of_band_with_filter", { band_no: bandNo, filter: "" });
  const members = extractMembers(json);
  store.upsertMembers(bandNo, members);
  return members.length;
}

/** The band's notices, live from BAND (not the cache). */
export async function liveNotices(bandNo: number) {
  const json: any = await call("v2.0.0/get_band_notices", { band_no: bandNo, limit: 50 });
  const items: J[] = json.result_data?.items ?? [];
  return items.map((n) => ({
    id: `post:${bandNo}:${n.post_no}`,
    title: typeof n.title === "string" ? n.title : null,
    major: n.is_major === true,
    author: isObj(n.author) ? String(n.author.name ?? "") : null,
    noticeSince: toIso(n.notice_created_at) ?? null,
    postedAt: toIso(n.post_created_at) ?? null,
    url: bandUrl.post(bandNo, n.post_no),
  }));
}
