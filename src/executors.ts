// BAND requests behind each approved write. Each was verified on a private test band
// on 2026-11-24; see docs/band-web-api.md. Only the server
// registers these (registerExecutors in main.ts), so tests never reach BAND.
import crypto from "node:crypto";
import { call, bandUrl, BandError } from "./band";
import { registerExecutor, type WritePayload } from "./writes";
import { extractPosts, liveNotices } from "./sync";
import * as store from "./store";
import * as media from "./media";
import { TIME_ZONE } from "./config";

type Target =
  | { kind: "post"; bandNo: number; postNo: number }
  | { kind: "event"; bandNo: number; scheduleId: string }
  | { kind: "post_comment"; bandNo: number; postNo: number; commentId: number }
  | { kind: "event_comment"; bandNo: number; scheduleId: string; commentId: number };

/** Parse a cache id. Replies resolve to their top comment (BAND replies are one level deep). */
export function parseTarget(id: string): Target {
  const [kind, band, ...rest] = id.split(":");
  const bandNo = Number(band);
  if (!bandNo) throw new BandError("unsupported", `Bad id ${id}`);
  if (kind === "post" && rest.length === 1) return { kind, bandNo, postNo: Number(rest[0]) };
  if (kind === "event" && rest.length === 1) return { kind, bandNo, scheduleId: rest[0]! };
  if (kind === "post_comment" && rest.length >= 2) return { kind, bandNo, postNo: Number(rest[0]), commentId: Number(rest[1]) };
  if (kind === "event_comment" && rest.length >= 2) return { kind, bandNo, scheduleId: rest[0]!, commentId: Number(rest[1]) };
  throw new BandError("unsupported", `Can't act on ${id}`);
}

const isReply = (id: string) => id.split(":").length > 4;

function sameBand(t: { bandNo: number }, p: WritePayload) {
  if (t.bandNo !== p.bandNo) throw new BandError("unsupported", "Target is in a different band than the approved write");
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text with BAND mention markup for the approved tags: "@Name" in the text, else appended. */
export function withMentions(text: string, mentions: WritePayload["mentions"] = []) {
  let out = escapeText(text);
  for (const m of mentions) {
    const tag = `<band:refer user_no="${m.key}">${escapeText(m.name)}</band:refer>`;
    const at = `@${escapeText(m.name)}`;
    out = out.includes(at) ? out.replace(at, tag) : `${out} ${tag}`;
  }
  return out;
}

const contentKey = (o: object) => JSON.stringify(o);

async function livePost(bandNo: number, postNo: number) {
  const json = await call("v2.0.0/get_post", { band_no: bandNo, post_no: postNo, resolution_type: 4 });
  const post = json.result_data?.post;
  if (!post) throw new BandError("shape", "BAND returned no post");
  return post as Record<string, any>;
}

function cacheFrom(json: unknown, bandNo: number) {
  const posts = extractPosts(json, bandNo);
  if (posts.length) store.upsertItems(posts);
  return posts[0];
}

export function registerExecutors() {
  registerExecutor("post", async (_row, p) => {
    const up = await media.upload(bandUrl.band(p.bandNo), p.media ?? []);
    const json = await call("v2.0.2/create_post", {
      band_no: p.bandNo, ...media.postFields(withMentions(p.text ?? "", p.mentions), up), set_band_notice: false, set_major_band_notice: false,
      set_linked_band_notice: "", copiable_state: "", should_disable_comment: false, band_notice_unset_at: "", purpose: "create",
    }, "POST");
    const item = cacheFrom(json, p.bandNo);
    return { id: item?.id, url: item?.url };
  });

  registerExecutor("edit_post", async (row, p) => {
    if (p.media?.length) throw new BandError("unsupported", "Edits can't add photos or videos yet");
    const t = parseTarget(p.target!);
    if (t.kind !== "post") throw new BandError("unsupported", "Only posts can be edited");
    sameBand(t, p);
    const post = await livePost(t.bandNo, t.postNo);
    // Re-check against BAND itself, not just the cache: refuse if anyone changed it since the preview.
    if (row.target_version && crypto.createHash("sha256").update(String(post.content ?? "")).digest("hex") !== row.target_version) {
      throw new BandError("unsupported", "The post changed on BAND since the preview; prepare the edit again");
    }
    // The edit request resends attachments; until that's mapped, don't risk dropping them.
    const att = post.attachment ?? {};
    if (Number(post.photo_count ?? 0) || Number(post.video_count ?? 0) || Object.values(att).some((v) => v && typeof v === "object" && Object.keys(v).length)) {
      throw new BandError("unsupported", "This post has attachments, which edits can't keep yet. Edit it in BAND");
    }
    const isNotice = (await liveNotices(t.bandNo)).some((n) => n.id === p.target);
    const json = await call("v2.0.2/update_post", {
      band_no: t.bandNo, post_no: t.postNo, content: withMentions(p.text ?? "", p.mentions), set_linked_band_notice: "",
      copiable_state: post.copiable_state ?? "unassigned", should_disable_comment: post.should_disable_comment === true,
      notice_state: isNotice ? "notice" : "off", band_notice_unset_at: "",
    }, "POST");
    const item = cacheFrom(json, t.bandNo);
    return { id: item?.id ?? p.target, url: bandUrl.post(t.bandNo, t.postNo), notice_kept: isNotice };
  });

  registerExecutor("comment", async (_row, p) => {
    const t = parseTarget(p.target!);
    sameBand(t, p);
    if (p.media?.length) media.checkCommentMedia(p.media);
    const page = t.kind === "post" || t.kind === "post_comment" ? bandUrl.post(t.bandNo, t.postNo) : bandUrl.event(t.bandNo, t.scheduleId);
    const up = await media.upload(page, p.media ?? []);
    const key =
      t.kind === "post" ? { content_type: "post", post_no: t.postNo }
      : t.kind === "event" ? { content_type: "schedule", schedule_id: t.scheduleId }
      : t.kind === "post_comment" ? { content_type: "post_comment", post_no: t.postNo, comment_id: t.commentId }
      : { content_type: "schedule_comment", schedule_id: t.scheduleId, comment_id: t.commentId };
    const json = await call("v2.3.0/create_comment", {
      band_no: t.bandNo, member_type: "membership", body: withMentions(p.text ?? "", p.mentions), file: "", ...media.commentFields(up),
      content_key: contentKey(key), is_secret: false, resolution_type: 4,
    }, "POST");
    return { comment_id: json.result_data?.comment?.comment_id ?? null, on: p.target };
  });

  const setNotice = (state: "notice" | "off") => async (_row: unknown, p: WritePayload) => {
    const t = parseTarget(p.target!);
    if (t.kind !== "post") throw new BandError("unsupported", "Only posts can be notices");
    sameBand(t, p);
    await call("v2.0.1/set_band_notice_state", state === "notice"
      ? { band_no: t.bandNo, post_no: t.postNo, state, unset_at: "", time_zone_id: TIME_ZONE }
      : { band_no: t.bandNo, post_no: t.postNo, state, set_linked_band_notice: false }, "GET");
    const now = (await liveNotices(t.bandNo)).some((n) => n.id === p.target);
    if (now !== (state === "notice")) throw new BandError("shape", "BAND accepted the change but the notice list doesn't show it");
    return { id: p.target, notice: now };
  };
  registerExecutor("add_notice", setNotice("notice"));
  registerExecutor("remove_notice", setNotice("off"));

  registerExecutor("delete_post", async (_row, p) => {
    const t = parseTarget(p.target!);
    if (t.kind !== "post") throw new BandError("unsupported", "Not a post");
    sameBand(t, p);
    await call("v1.5.0/delete_post", { band_no: t.bandNo, post_no: t.postNo, version: "20140508" }, "GET");
    store.markDeleted(p.target!);
    return { deleted: p.target };
  });

  registerExecutor("delete_comment", async (_row, p) => {
    if (isReply(p.target!)) throw new BandError("unsupported", "Deleting a reply isn't supported yet. Delete it in BAND");
    const t = parseTarget(p.target!);
    sameBand(t, p);
    const key = t.kind === "post_comment" ? { content_type: "post_comment", post_no: t.postNo, comment_id: t.commentId }
      : t.kind === "event_comment" ? { content_type: "schedule_comment", schedule_id: t.scheduleId, comment_id: t.commentId }
      : null;
    if (!key) throw new BandError("unsupported", "Not a comment");
    await call("v2.0.0/delete_comment", { band_no: t.bandNo, content_key: contentKey(key) }, "GET");
    store.markDeleted(p.target!);
    return { deleted: p.target };
  });
}
