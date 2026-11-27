// Invented data only: no member names, comment bodies or media from BAND.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "band-mcp-"));
process.env.BAND_MCP_DIR = dir;
process.env.BAND_MCP_TZ = "America/Los_Angeles";
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ plugins: ["f3"] }));

const store = await import("../src/store");
const sync = await import("../src/sync");
const wk = await import("../src/plugins/f3/workouts");
const writes = await import("../src/writes");
const tools = await import("../src/tools");

const BAND = 111;

beforeAll(() => {
  store.upsertBands([{ bandNo: BAND, name: "Test Region" }, { bandNo: 222, name: "Pine Hollow Test" }]);
});

describe("extractors", () => {
  it("finds posts, comments with replies, events and bands anywhere in a response", () => {
    const feed = { result_code: 1, result_data: { items: [{ post_no: 5, band: { band_no: BAND }, content: "Backblast <band:refer user_no=\"1\">Comet</band:refer>", author: { name: "Quokka", member_key: "k1" }, created_at: 1763900000000, comment_count: 2, photos: [{ url: "https://coresos-phinf.pstatic.net/a.jpg" }] }] } };
    const posts = sync.extractPosts(feed, BAND);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: `post:${BAND}:5`, author: "Quokka", authorKey: "k1" });
    expect((posts[0]!.raw as any).photos).toEqual(["https://coresos-phinf.pstatic.net/a.jpg"]);

    const comments = sync.extractComments({ result_data: { items: [{ comment_id: 9, body: "Total Pax: 3", author: { name: "Quokka" }, created_at: 1763900000000, latest_comment: [{ comment_id: 9, schedule_comment_id: "r1", body: "nice", author: { name: "Marmot" }, created_at: 1763900100000 }] }] } }, { kind: "post_comment", bandNo: BAND, parentId: `post:${BAND}:5`, url: "u" });
    expect(comments.map((c) => c.parentId)).toEqual([`post:${BAND}:5`, `post_comment:${BAND}:5:9`]);

    const events = sync.extractEvents({ result_data: { items: [{ schedule_id: "4/111/1", name: "Ridgeline", start_at: 1763900000000, comment_count: 4 }, { schedule_id: "5/3/464/1", name: "Holiday", start_at: 1763900000000 }] } }, BAND);
    expect(events.map((e) => e.title)).toEqual(["Ridgeline"]);

    const parent = { id: `event:${BAND}:4/111/1`, bandNo: BAND, url: "u" };
    const top = sync.commentRows([{ comment_id: 7, body: "Total Pax: 3", author: { name: "Quokka" }, created_at: 1763900000000, comment_count: 1 }], parent, "event_comment");
    const replies = sync.commentRows([{ comment_id: 1, body: "nice", author: { name: "Marmot" }, created_at: 1763900100000 }], parent, "event_comment", top[0]!.id);
    expect(top[0]!.id).toBe(`event_comment:${BAND}:4/111/1:7`);
    expect(replies[0]).toMatchObject({ id: `event_comment:${BAND}:4/111/1:7:1`, parentId: top[0]!.id });
    expect(sync.extractMembers({ result_data: { members: [{ user_no: 42, name: "Quokka" }] } })).toEqual([{ key: "42", name: "Quokka", role: undefined }]);

    expect(sync.extractBands({ result_data: { bands: [{ band_no: 222, name: "Pine Hollow Test", member_count: 40 }] } })).toEqual([expect.objectContaining({ bandNo: 222, memberCount: 40 })]);
  });
});

describe("workouts", () => {
  it("extracts Q and co-Qs from common backblast lines", () => {
    expect(wk.extractQs("Q: Comet\nCo-Q: Marmot & Pinata\nPAX: a, b")).toEqual({ q: ["Comet"], coQs: ["Marmot", "Pinata"] });
    expect(wk.extractQs("QIC - <band:refer user_no=\"2\">Fizz</band:refer>")).toEqual({ q: ["Fizz"], coQs: [] });
    expect(wk.extractQs("Great beatdown led by Kazoo today")).toEqual({ q: ["Kazoo"], coQs: [] });
  });

  it("reads a workout date from the text and resolves the year", () => {
    expect(wk.dateFromText("Date: 11/18\nQ: X", "2026-11-19T15:00:00Z")).toBe("2026-11-18");
    expect(wk.dateFromText("Backblast Dec 30", "2027-01-02T15:00:00Z")).toBe("2026-12-30");
  });

  it("keeps unknown counts unknown and merges duplicate reports", () => {
    const base = { kind: "post_comment", bandNo: BAND, author: "Quokka", url: null };
    const a = wk.parseReport({ ...base, itemId: "a", createdAt: "2026-11-18T14:30:00Z", body: "Backblast Ridgeline\nDate: 11/18\nQ: Comet\nTotal Pax: 4\nPAX: Comet, Marmot, Pinata, Teapot" })!;
    const b = wk.parseReport({ ...base, itemId: "b", createdAt: "2026-11-18T20:00:00Z", body: "Backblast\nQ: Comet\nGreat work today" })!;
    expect(a).toMatchObject({ q: ["Comet"], statedCount: 4, count: 4, countSource: "stated", confidence: "high", dateSource: "text" });
    expect(b.count).toBeNull();
    expect(b.countSource).toBe("unknown");
    const merged = wk.mergeWorkouts([b, a]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toHaveLength(2);
    expect(wk.stats(merged)).toMatchObject({ workouts: 1, withCount: 1, totalPax: 4 });
  });

  it("reads the AO and planned Q from event titles", () => {
    expect(wk.parseEventTitle("Ridgeline: Q: Moose Call")).toEqual({ ao: "Ridgeline", q: "Moose Call" });
    expect(wk.parseEventTitle("Otter Pond Q: Comet 🍦")).toEqual({ ao: "Otter Pond", q: "Comet" });
    expect(wk.parseEventTitle("Kettle Corn | Q: Marmot - NEW LOCATION / TIME")).toEqual({ ao: "Kettle Corn", q: "Marmot" });
    expect(wk.parseEventTitle("Big Huddle")).toEqual({ ao: "Big Huddle", q: null });
    const w = wk.parseReport({ itemId: "e1", kind: "event_comment", bandNo: BAND, author: "A", url: null, createdAt: "2026-11-21T14:30:00Z", eventStart: "2026-11-21T14:00:00Z", context: "Lookout: Q: Zipline", body: "Backblast\nTotal Pax: 4" })!;
    expect(w).toMatchObject({ ao: "Lookout", q: ["Zipline"], count: 4 });
  });

  it("ignores RSVPs and chatter", () => {
    expect(wk.parseReport({ itemId: "x", kind: "post_comment", bandNo: BAND, author: "A", url: null, createdAt: "2026-11-18T14:30:00Z", body: "HC" })).toBeNull();
  });
});

describe("cache and search", () => {
  it("searches across bands with prefix matching and coverage", async () => {
    store.upsertItems([
      { id: `post:${BAND}:1`, kind: "post", bandNo: BAND, author: "Quokka", body: "Weekly announcements: big huddle Saturday", createdAt: "2026-11-20T16:00:00Z" },
      { id: "post:222:7", kind: "post", bandNo: 222, author: "Yodel", body: "Backblast from the quarry\nQ: Gravel\nTotal pax 6", createdAt: "2026-11-19T14:00:00Z" },
    ]);
    store.setCoverage(222, "posts", "2026-11-01", "2026-11-24", true);
    const res: any = await tools.callTool("search", { query: "backbl" }, { canWrite: false });
    expect(res.results.map((r: any) => r.band)).toEqual(["Pine Hollow Test"]);
    expect(res.covered.join(" ")).toContain("Pine Hollow Test: posts");
    const ws: any = await tools.callTool("list_workouts", { bands: ["pine hollow test"], from: "2026-11-19" }, { canWrite: false });
    expect(ws.workouts[0]).toMatchObject({ q: ["Gravel"], count: 6 });
  });

  it("marks items BAND stopped returning as deleted", () => {
    expect(store.markMissingDeleted(BAND, "post", null, [])).toBe(1);
    expect(store.search({ query: "big huddle" })).toHaveLength(0);
  });
});

describe("writes", () => {
  const ctx = { canWrite: true };

  it("never sends without the user's approval", async () => {
    const prep: any = await tools.callTool("prepare_post", { band: BAND, text: "Hello" }, ctx);
    expect(prep.preview).toContain("BAND's usual new-post notification");
    const res: any = await tools.callTool("confirm_write", { write_id: prep.write_id }, ctx);
    expect(res.status).toBe("waiting_for_approval");
    expect(writes.get(prep.write_id)!.status).toBe("pending");
  });

  it("records a yes given in chat, and the client's answer wins when it can ask", async () => {
    const prep: any = await tools.callTool("prepare_post", { band: BAND, text: "Chat yes" }, ctx);
    await tools.callTool("confirm_write", { write_id: prep.write_id, user_approved: true }, ctx);
    expect(writes.get(prep.write_id)!.approved_via).toBe("chat");
    const prep2: any = await tools.callTool("prepare_post", { band: BAND, text: "Client no" }, ctx);
    const res: any = await tools.callTool("confirm_write", { write_id: prep2.write_id, user_approved: true }, { ...ctx, elicit: async () => "decline" });
    expect(res.status).toBe("rejected");
  });

  it("approves a batch with one prompt and runs each write", async () => {
    let prompts = 0;
    const ids = [];
    for (const t of ["One", "Two", "Three"]) ids.push(((await tools.callTool("prepare_post", { band: BAND, text: t }, ctx)) as any).write_id);
    const waiting: any = await tools.callTool("confirm_write", { write_ids: ids }, ctx);
    expect(waiting.previews).toHaveLength(3);
    const res: any = await tools.callTool("confirm_write", { write_ids: ids }, { ...ctx, elicit: async (m: string) => { prompts++; expect(m).toContain("3 BAND writes"); return "accept"; } });
    expect(prompts).toBe(1);
    expect(res.results.map((r: any) => r.write_id)).toEqual(ids);
    expect(ids.every((id) => writes.get(id)!.approved_via === "elicitation")).toBe(true);
  });

  it("asks through elicitation and treats decline as rejected", async () => {
    const prep: any = await tools.callTool("prepare_post", { band: BAND, text: "Hi" }, ctx);
    const res: any = await tools.callTool("confirm_write", { write_id: prep.write_id }, { ...ctx, elicit: async () => "decline" });
    expect(res.status).toBe("rejected");
  });

  it("runs an approved write once and fails safely without a verified executor", async () => {
    const prep: any = await tools.callTool("prepare_post", { band: BAND, text: "Hi again" }, ctx);
    const res: any = await tools.callTool("confirm_write", { write_id: prep.write_id }, { ...ctx, elicit: async () => "accept" });
    expect(res.status).toBe("failed");
    expect(res.result.error).toContain("isn't enabled yet");
    await expect(writes.execute(prep.write_id)).rejects.toThrow(/failed/);
  });

  it("executes a registered write exactly once", async () => {
    let calls = 0;
    writes.registerExecutor("comment", async () => { calls++; return { ok: true }; });
    store.upsertItems([{ id: `post:${BAND}:2`, kind: "post", bandNo: BAND, body: "post", createdAt: "2026-11-21T00:00:00Z" }]);
    const prep: any = await tools.callTool("prepare_comment", { id: `post:${BAND}:2`, text: "Nice" }, ctx);
    writes.decide(prep.write_id, true, "chat");
    const [r1, r2] = await Promise.allSettled([tools.callTool("confirm_write", { write_id: prep.write_id }, ctx), tools.callTool("confirm_write", { write_id: prep.write_id }, ctx)]);
    expect(calls).toBe(1);
    expect([r1, r2].some((r) => r.status === "fulfilled" && (r.value as any).status === "done")).toBe(true);
  });

  it("refuses an edit when the post changed after the preview", async () => {
    writes.registerExecutor("edit_post", async () => ({ ok: true }));
    store.upsertItems([{ id: `post:${BAND}:3`, kind: "post", bandNo: BAND, body: "v1", createdAt: "2026-11-21T00:00:00Z" }]);
    const prep: any = await tools.callTool("prepare_edit_post", { id: `post:${BAND}:3`, text: "v2" }, ctx);
    store.upsertItems([{ id: `post:${BAND}:3`, kind: "post", bandNo: BAND, body: "someone else edited", createdAt: "2026-11-21T00:00:00Z" }]);
    writes.decide(prep.write_id, true, "chat");
    const res: any = await tools.callTool("confirm_write", { write_id: prep.write_id }, ctx);
    expect(res.status).toBe("failed");
    expect(res.result.error).toContain("target changed");
  });

  it("keeps destructive actions off by default and hides writes from read-only connections", async () => {
    await expect(tools.callTool("prepare_delete", { id: `post:${BAND}:2` }, ctx)).rejects.toThrow(/Destructive actions are off/);
    await expect(tools.callTool("prepare_post", { band: BAND, text: "x" }, { ...ctx, canWrite: false })).rejects.toThrow(/read-only/);
  });

  it("builds BAND mention markup and parses targets", async () => {
    const ex = await import("../src/executors");
    expect(ex.withMentions("Thanks @Quokka & crew", [{ name: "Quokka", key: "42" }])).toBe('Thanks <band:refer user_no="42">Quokka</band:refer> &amp; crew');
    expect(ex.withMentions("Hi", [{ name: "Marmot", key: "7" }])).toBe('Hi <band:refer user_no="7">Marmot</band:refer>');
    expect(ex.parseTarget(`event_comment:${BAND}:4/111/9/20261121:5:2`)).toEqual({ kind: "event_comment", bandNo: BAND, scheduleId: "4/111/9/20261121", commentId: 5 });
    expect(ex.parseTarget(`post:${BAND}:12`)).toEqual({ kind: "post", bandNo: BAND, postNo: 12 });
  });

  it("binds attachments to their bytes and builds BAND's media fields", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmcp-media-"));
    const jpg = path.join(dir, "a.jpg"), mp4 = path.join(dir, "b.mp4");
    fs.writeFileSync(jpg, "jpg"); fs.writeFileSync(mp4, "mp4");
    await expect(tools.callTool("prepare_post", { band: BAND, text: "x", photos: [path.join(dir, "nope.jpg")] }, ctx)).rejects.toThrow(/No such file/);
    await expect(tools.callTool("prepare_post", { band: BAND, text: "x", photos: [mp4] }, ctx)).rejects.toThrow(/doesn't look like a photo/);
    const r = (await tools.callTool("prepare_post", { band: BAND, text: "Recap", photos: [jpg], videos: [mp4] }, ctx)) as any;
    expect(r.preview).toContain("Photos: a.jpg");
    expect(r.preview).toMatch(/Videos: b\.mp4 \(0\.0 MB\)/);
    await expect(tools.callTool("prepare_comment", { id: `post:${BAND}:2`, text: "x", photos: [jpg], videos: [mp4] }, ctx)).rejects.toThrow(/several photos or one video/);
    await expect(tools.callTool("prepare_edit_post", { id: `post:${BAND}:2`, text: "x", photos: [jpg] }, ctx)).rejects.toThrow(/Edits can't add/);

    const media = await import("../src/media");
    const [a] = await media.attachments([jpg]);
    fs.writeFileSync(jpg, "changed");
    await expect(media.upload("https://www.band.us/band/1", [a!])).rejects.toThrow(/changed since it was approved/);

    const up = [
      { kind: "photo" as const, id: "/p.jpg", url: "http://x/p.jpg", width: 4, height: 3, title: "p.jpg" },
      { kind: "video" as const, id: "/v.mp4", url: "http://x/v.jpg", width: 16, height: 9, title: "v.mp4" },
    ];
    const f = media.postFields("Hi", up);
    expect(f.content).toBe('Hi\n<band:attachment type="photo" id="c1" /><band:attachment type="video" id="c2" />');
    expect(JSON.parse(f.photo!)).toEqual({ c1: { url: "http://x/p.jpg", width: 4, height: 3 } });
    expect(JSON.parse(f.video!).c2).toMatchObject({ id: "/v.mp4", title: "v.mp4", is_gif: false });
    expect(media.postFields("Hi", [])).toEqual({ content: "Hi" });
    expect(JSON.parse(media.commentFields([up[0]!]).photos)).toEqual([{ url: "http://x/p.jpg", width: 4, height: 3 }]);
    expect(media.commentFields([up[1]!]).photos).toBe("");
  });

  it("refuses chat messages until they're mapped", async () => {
    await expect(tools.callTool("prepare_message", { band: BAND, to: "Quokka", text: "x" }, ctx)).rejects.toThrow(/chat messages/);
  });

  it("turns plugin tools on and off from settings.json", async () => {
    const settingsPath = path.join(dir, "settings.json");
    const names = () => tools.allTools().map((t) => t.name);
    expect(names()).toContain("who_qd");
    fs.writeFileSync(settingsPath, JSON.stringify({ plugins: [] }));
    expect(names()).not.toContain("who_qd");
    await expect(tools.callTool("who_qd", { from: "2026-11-01", to: "2026-11-30" }, ctx)).rejects.toThrow(/Unknown tool/);
    fs.writeFileSync(settingsPath, JSON.stringify({ plugins: ["nope"] }));
    expect(() => names()).toThrow(/Unknown plugin "nope"/);
    fs.writeFileSync(settingsPath, JSON.stringify({ plugins: ["f3"] }));
  });

  it("finds local midnight in the configured time zone, across DST", async () => {
    const h = await import("../src/helpers");
    expect(h.day("2026-11-18")).toBe("2026-11-18T08:00:00.000Z");
    expect(h.day("2026-07-01")).toBe("2026-07-01T07:00:00.000Z");
    expect(h.day("2026-03-08")).toBe("2026-03-08T08:00:00.000Z");
    expect(h.dayEnd("2026-03-08")).toBe("2026-03-09T07:00:00.000Z"); // next local midnight, not into the next day
    expect(h.localDate("2026-11-18T07:59:00Z")).toBe("2026-11-17");
  });

});
