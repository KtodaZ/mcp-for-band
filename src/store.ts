// This module stores the write journal and a local SQLite FTS5 cache of data read from BAND.
// The database lives in DATA_DIR outside Git because it holds member content.
import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDataDir } from "./config";

export type ItemKind = "post" | "post_comment" | "event" | "event_comment" | "chat";

export interface Item {
  id: string; // kind-scoped stable id, e.g. "post_comment:<band>:<post>:<comment>"
  kind: ItemKind;
  bandNo: number;
  parentId?: string | null;
  author?: string | null;
  authorKey?: string | null;
  body: string;
  title?: string | null;
  createdAt: string; // ISO
  url?: string | null;
  photoCount?: number;
  videoCount?: number;
  deleted?: boolean;
  raw?: unknown;
}

let db: DatabaseSync | null = null;

export function open(file = DB_PATH): DatabaseSync {
  if (db) return db;
  if (file === DB_PATH) ensureDataDir();
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS bands (
      band_no INTEGER PRIMARY KEY, name TEXT NOT NULL, member_count INTEGER, role TEXT, raw TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, band_no INTEGER NOT NULL, parent_id TEXT, author TEXT, author_key TEXT,
      body TEXT NOT NULL DEFAULT '', title TEXT, created_at TEXT NOT NULL, url TEXT, photo_count INTEGER DEFAULT 0,
      video_count INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, raw TEXT, synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_band_time ON items(band_no, created_at);
    CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, body, author, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS coverage (
      band_no INTEGER NOT NULL, source TEXT NOT NULL, range_start TEXT NOT NULL, range_end TEXT NOT NULL,
      complete INTEGER NOT NULL, note TEXT, synced_at TEXT NOT NULL,
      PRIMARY KEY (band_no, source, range_start, range_end)
    );
    CREATE TABLE IF NOT EXISTS members (
      band_no INTEGER NOT NULL, member_key TEXT NOT NULL, name TEXT NOT NULL, role TEXT, raw TEXT, updated_at TEXT,
      PRIMARY KEY (band_no, member_key)
    );
    CREATE TABLE IF NOT EXISTS writes (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, action TEXT NOT NULL, band_no INTEGER NOT NULL,
      payload TEXT NOT NULL, payload_hash TEXT NOT NULL, preview TEXT NOT NULL, target_version TEXT,
      status TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, approved_via TEXT,
      result TEXT, before TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS write_events (
      write_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT
    );
  `);
  return db;
}

const now = () => new Date().toISOString();

export function upsertItems(items: Item[]) {
  const d = open();
  const put = d.prepare(`INSERT INTO items (id, kind, band_no, parent_id, author, author_key, body, title, created_at, url, photo_count, video_count, deleted, raw, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, author=excluded.author, author_key=excluded.author_key, body=excluded.body,
      title=excluded.title, created_at=excluded.created_at, url=excluded.url, photo_count=excluded.photo_count,
      video_count=excluded.video_count, deleted=excluded.deleted, raw=excluded.raw, synced_at=excluded.synced_at`);
  const delFts = d.prepare("DELETE FROM items_fts WHERE id = ?");
  const putFts = d.prepare("INSERT INTO items_fts (id, title, body, author) VALUES (?, ?, ?, ?)");
  d.exec("BEGIN");
  try {
    for (const it of items) {
      put.run(it.id, it.kind, it.bandNo, it.parentId ?? null, it.author ?? null, it.authorKey ?? null, it.body ?? "", it.title ?? null,
        it.createdAt, it.url ?? null, it.photoCount ?? 0, it.videoCount ?? 0, it.deleted ? 1 : 0, it.raw === undefined ? null : JSON.stringify(it.raw), now());
      delFts.run(it.id);
      if (!it.deleted) putFts.run(it.id, it.title ?? "", stripMarkup(it.body ?? ""), it.author ?? "");
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Mark items in a fully re-read scope that BAND no longer returned as deleted. */
export function markDeleted(id: string) {
  const d = open();
  d.prepare("UPDATE items SET deleted = 1, synced_at = ? WHERE id = ?").run(now(), id);
  d.prepare("DELETE FROM items_fts WHERE id = ?").run(id);
}

export function markMissingDeleted(bandNo: number, kind: ItemKind, parentId: string | null, seenIds: string[], since?: string) {
  const d = open();
  const rows = d.prepare(`SELECT id FROM items WHERE band_no = ? AND kind = ? AND deleted = 0 AND ${parentId ? "parent_id = ?" : "parent_id IS NULL"} ${since ? "AND created_at >= ?" : ""}`)
    .all(...([bandNo, kind, parentId, since].filter((v) => v !== null && v !== undefined) as (string | number)[])) as { id: string }[];
  const seen = new Set(seenIds);
  const gone = rows.map((r) => r.id).filter((id) => !seen.has(id));
  for (const id of gone) {
    d.prepare("UPDATE items SET deleted = 1, synced_at = ? WHERE id = ?").run(now(), id);
    d.prepare("DELETE FROM items_fts WHERE id = ?").run(id);
  }
  return gone.length;
}

export function stripMarkup(body: string) {
  return body.replace(/<band:refer\b[^>]*>([^<]*)<\/band:refer>/gi, "@$1").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
}

export interface SearchOpts {
  query?: string;
  bands?: number[];
  kinds?: ItemKind[];
  author?: string;
  from?: string;
  to?: string;
  hasPhoto?: boolean;
  limit?: number;
}

export function search(o: SearchOpts) {
  const d = open();
  const where: string[] = ["i.deleted = 0"];
  const args: (string | number)[] = [];
  let from = "items i";
  if (o.query?.trim()) {
    from = "items_fts f JOIN items i ON i.id = f.id";
    where.push("items_fts MATCH ?");
    args.push(ftsQuery(o.query));
  }
  if (o.bands?.length) { where.push(`i.band_no IN (${o.bands.map(() => "?").join(",")})`); args.push(...o.bands); }
  if (o.kinds?.length) { where.push(`i.kind IN (${o.kinds.map(() => "?").join(",")})`); args.push(...o.kinds); }
  if (o.author) { where.push("i.author LIKE ?"); args.push(`%${o.author}%`); }
  if (o.from) { where.push("i.created_at >= ?"); args.push(o.from); }
  if (o.to) { where.push("i.created_at < ?"); args.push(o.to); }
  if (o.hasPhoto) where.push("i.photo_count > 0");
  const order = o.query?.trim() ? "ORDER BY bm25(items_fts), i.created_at DESC" : "ORDER BY i.created_at DESC";
  args.push(Math.min(o.limit ?? 25, 200));
  const sql = `SELECT i.id, i.kind, i.band_no, i.parent_id, i.author, i.title, i.body, i.created_at, i.url, i.photo_count, i.video_count
    FROM ${from} WHERE ${where.join(" AND ")} ${order} LIMIT ?`;
  try {
    return d.prepare(sql).all(...args) as Record<string, any>[];
  } catch (e) {
    // A query with FTS syntax that doesn't parse ("a AND", an unclosed quote): search its words instead.
    if (!o.query?.trim() || !/fts5|syntax|unterminated|no such column/i.test(String((e as Error).message))) throw e;
    args[args.indexOf(ftsQuery(o.query))] = plainQuery(o.query);
    return d.prepare(sql).all(...args) as Record<string, any>[];
  }
}

const plainQuery = (q: string) => q.split(/\s+/).map((w) => w.replace(/["*()]/g, "")).filter(Boolean).map((w) => `"${w}"*`).join(" ") || '""';

/** Plain words become prefix-matched AND terms; quoted phrases and FTS operators pass through. */
export function ftsQuery(q: string) {
  if (/["*()]|\b(AND|OR|NOT|NEAR)\b/.test(q)) return q;
  return plainQuery(q);
}

export function getItem(id: string) {
  return open().prepare("SELECT * FROM items WHERE id = ?").get(id) as Record<string, any> | undefined;
}

export function children(parentId: string) {
  return open().prepare("SELECT * FROM items WHERE parent_id = ? AND deleted = 0 ORDER BY created_at").all(parentId) as Record<string, any>[];
}

export function itemsInRange(bandNo: number, kinds: ItemKind[], from: string, to: string) {
  return open().prepare(`SELECT * FROM items WHERE band_no = ? AND deleted = 0 AND kind IN (${kinds.map(() => "?").join(",")}) AND created_at >= ? AND created_at < ? ORDER BY created_at`)
    .all(bandNo, ...kinds, from, to) as Record<string, any>[];
}

export function setCoverage(bandNo: number, source: string, start: string, end: string, complete: boolean, note?: string) {
  open().prepare(`INSERT INTO coverage (band_no, source, range_start, range_end, complete, note, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET complete=excluded.complete, note=excluded.note, synced_at=excluded.synced_at`)
    .run(bandNo, source, start, end, complete ? 1 : 0, note ?? null, now());
}

export function coverage(bandNo?: number) {
  const d = open();
  return (bandNo === undefined
    ? d.prepare("SELECT * FROM coverage ORDER BY band_no, source, range_start").all()
    : d.prepare("SELECT * FROM coverage WHERE band_no = ? ORDER BY source, range_start").all(bandNo)) as Record<string, any>[];
}

export function upsertBands(bands: { bandNo: number; name: string; memberCount?: number; role?: string; raw?: unknown }[]) {
  const st = open().prepare(`INSERT INTO bands (band_no, name, member_count, role, raw, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(band_no) DO UPDATE SET name=excluded.name, member_count=excluded.member_count, role=excluded.role, raw=excluded.raw, updated_at=excluded.updated_at`);
  for (const b of bands) st.run(b.bandNo, b.name, b.memberCount ?? null, b.role ?? null, b.raw === undefined ? null : JSON.stringify(b.raw), now());
}

export function listBands() {
  return open().prepare("SELECT band_no, name, member_count, role, updated_at FROM bands ORDER BY name").all() as { band_no: number; name: string; member_count: number | null; role: string | null }[];
}

export function upsertMembers(bandNo: number, members: { key: string; name: string; role?: string; raw?: unknown }[]) {
  const st = open().prepare(`INSERT INTO members (band_no, member_key, name, role, raw, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET name=excluded.name, role=excluded.role, raw=excluded.raw, updated_at=excluded.updated_at`);
  for (const m of members) st.run(bandNo, m.key, m.name, m.role ?? null, m.raw === undefined ? null : JSON.stringify(m.raw), now());
}

export function findMembers(bandNo: number, name: string) {
  return open().prepare("SELECT member_key, name, role FROM members WHERE band_no = ? AND name LIKE ? ESCAPE '!' ORDER BY name LIMIT 20").all(bandNo, `%${name.replace(/[!%_]/g, "!$&")}%`) as { member_key: string; name: string; role: string | null }[];
}

export function resetForTests() {
  db?.close();
  db = null;
}
