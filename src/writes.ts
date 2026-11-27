// The server prepares each write, gets user approval, and executes it once.
//
// The user approves each write: through MCP elicitation when the client supports it, otherwise by
// saying yes in chat to the exact preview, which confirm_write records. Content from BAND cannot
// approve writes or change policy. The writes and write_events journal tables store the request,
// preview, approval, BAND's response, and the previous version for edits.
import crypto from "node:crypto";
import { open } from "./store";
import { loadSettings } from "./config";
import { BandError } from "./band";

export type WriteAction = "post" | "edit_post" | "comment" | "message" | "add_notice" | "remove_notice" | "delete_post" | "delete_comment";
export const DESTRUCTIVE: WriteAction[] = ["delete_post", "delete_comment"];
const destructiveAllowed = () => loadSettings().allowDestructive || process.env.BAND_MCP_ALLOW_DESTRUCTIVE === "1";

export interface WritePayload {
  bandNo: number;
  /** post or comment id in the cache, for edits, comments, notices and deletes */
  target?: string;
  text?: string;
  /** resolved mentions: name → member key */
  mentions?: { name: string; key: string }[];
  /** photo and video files, bound to their sha256 at approval */
  media?: import("./media").Attachment[];
  push?: boolean;
  /** chat room or member for messages */
  to?: string;
}

export interface WriteRow {
  id: string;
  created_at: string;
  action: WriteAction;
  band_no: number;
  payload: string;
  payload_hash: string;
  preview: string;
  target_version: string | null;
  status: "pending" | "approved" | "executing" | "done" | "failed" | "unknown" | "rejected" | "expired";
  expires_at: string;
  approved_at: string | null;
  approved_via: string | null;
  result: string | null;
  before: string | null;
}

const TTL_MS = 10 * 60_000;
const now = () => new Date().toISOString();

export function hashPayload(action: string, p: WritePayload) {
  return crypto.createHash("sha256").update(JSON.stringify({ action, p })).digest("hex");
}

function event(id: string, ev: string, detail?: unknown) {
  open().prepare("INSERT INTO write_events (write_id, at, event, detail) VALUES (?, ?, ?, ?)").run(id, now(), ev, detail === undefined ? null : JSON.stringify(detail));
}

export function prepare(action: WriteAction, payload: WritePayload, preview: string, targetVersion?: string | null, before?: unknown): WriteRow {
  if (DESTRUCTIVE.includes(action) && !destructiveAllowed()) {
    throw new BandError("unsupported", "Destructive actions are off. The user can enable them with BAND_MCP_ALLOW_DESTRUCTIVE=1.");
  }
  const id = `w_${crypto.randomBytes(6).toString("hex")}`;
  const row = {
    id, created_at: now(), action, band_no: payload.bandNo, payload: JSON.stringify(payload), payload_hash: hashPayload(action, payload),
    preview, target_version: targetVersion ?? null, status: "pending" as const, expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    approved_at: null, approved_via: null, result: null, before: before === undefined ? null : JSON.stringify(before),
  };
  open().prepare(`INSERT INTO writes (id, created_at, action, band_no, payload, payload_hash, preview, target_version, status, expires_at, before, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.created_at, action, row.band_no, row.payload, row.payload_hash, preview, row.target_version, "pending", row.expires_at, row.before, now());
  event(id, "prepared");
  return row;
}

export function get(id: string): WriteRow | undefined {
  const row = open().prepare("SELECT * FROM writes WHERE id = ?").get(id) as WriteRow | undefined;
  if (row && row.status === "pending" && row.expires_at < now()) {
    // Only a still-pending row expires, so this can't overwrite an approval made meanwhile.
    const res = open().prepare("UPDATE writes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at < ?").run(now(), id, now());
    if (res.changes === 1) event(id, "expired");
    return open().prepare("SELECT * FROM writes WHERE id = ?").get(id) as WriteRow | undefined;
  }
  return row;
}

function setStatus(id: string, status: WriteRow["status"], extra: Partial<Pick<WriteRow, "approved_via" | "result">> = {}) {
  open().prepare("UPDATE writes SET status = ?, approved_via = COALESCE(?, approved_via), approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END, result = COALESCE(?, result), updated_at = ? WHERE id = ?")
    .run(status, extra.approved_via ?? null, status, now(), extra.result ?? null, now(), id);
  event(id, status, extra);
}

/** Record the user's decision on one write. Only a pending, unexpired write can change. */
export function decide(id: string, approve: boolean, via: "elicitation" | "chat"): WriteRow {
  return decideAll([id], approve, via)[0]!;
}

/**
 * Record one decision for a batch, all or nothing: every write must still be pending and
 * unexpired, or none changes. A rejection leaves approved_at empty.
 */
export function decideAll(ids: string[], approve: boolean, via: "elicitation" | "chat"): WriteRow[] {
  const d = open();
  d.exec("BEGIN IMMEDIATE");
  try {
    const t = now();
    for (const id of ids) {
      const row = get(id);
      if (!row) throw new BandError("unsupported", `No write ${id}`);
      if (row.status !== "pending") throw new BandError("unsupported", `Write ${id} is ${row.status}`);
      const res = d.prepare("UPDATE writes SET status = ?, approved_via = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at >= ?")
        .run(approve ? "approved" : "rejected", via, approve ? t : null, t, id, t);
      if (res.changes !== 1) throw new BandError("unsupported", `Write ${id} changed while deciding`);
      event(id, approve ? "approved" : "rejected", { via });
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return ids.map((id) => get(id)!);
}

/** An approval is good for this long; after that the write must be prepared and approved again. */
const APPROVAL_TTL_MS = 10 * 60_000;

export type Executor = (row: WriteRow, payload: WritePayload) => Promise<unknown>;

/** Executors are registered once each write path is verified on the test band (see docs/band-web-api.md). */
const executors = new Map<WriteAction, Executor>();
export function registerExecutor(action: WriteAction, fn: Executor) { executors.set(action, fn); }
/** For scripts/try-write.ts, which runs an executor on the private test band only. */
export const executorFor = (action: WriteAction) => executors.get(action);

let queue: Promise<unknown> = Promise.resolve();

/** Execute an approved write once. Writes run one at a time. */
export function execute(id: string, currentVersion?: () => Promise<string | null>): Promise<WriteRow> {
  const run = async () => {
    const row = get(id);
    if (!row) throw new BandError("unsupported", `No write ${id}`);
    if (row.status !== "approved") throw new BandError("unsupported", `Write ${id} is ${row.status}; it needs the user's approval first`);
    if (!row.approved_at || Date.parse(row.approved_at) < Date.now() - APPROVAL_TTL_MS) {
      setStatus(id, "expired");
      throw new BandError("unsupported", `The approval for ${id} is over 10 minutes old; prepare it again`);
    }
    if (DESTRUCTIVE.includes(row.action) && !destructiveAllowed()) throw new BandError("unsupported", "Deletes were turned off after this was approved");
    const payload = JSON.parse(row.payload) as WritePayload;
    if (hashPayload(row.action, payload) !== row.payload_hash) throw new BandError("unsupported", "Payload changed after approval; prepare it again");
    const claim = open().prepare("UPDATE writes SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'approved'").run(now(), id);
    if (claim.changes !== 1) throw new BandError("unsupported", `Write ${id} is already running or done`);
    event(id, "executing");
    try {
      if (row.target_version && currentVersion) {
        const v = await currentVersion();
        if (v !== row.target_version) {
          setStatus(id, "failed", { result: JSON.stringify({ error: "target changed since the preview; prepare again" }) });
          return get(id)!;
        }
      }
      const fn = executors.get(row.action);
      if (!fn) {
        setStatus(id, "failed", { result: JSON.stringify({ error: `${row.action} isn't enabled yet: its BAND request hasn't been verified on the test band` }) });
        return get(id)!;
      }
      const result = await fn(row, payload);
      setStatus(id, "done", { result: JSON.stringify(result ?? null) });
    } catch (e) {
      // A network failure mid-write may still have reached BAND: don't retry blindly.
      const definite = e instanceof BandError && (e.kind === "auth" || e.kind === "unsupported" || e.kind === "shape");
      setStatus(id, definite ? "failed" : "unknown", { result: JSON.stringify({ error: (e as Error).message }) });
    }
    return get(id)!;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export function list(limit = 20) {
  return open().prepare("SELECT id, created_at, action, band_no, status, approved_via, result FROM writes ORDER BY created_at DESC LIMIT ?").all(limit);
}

