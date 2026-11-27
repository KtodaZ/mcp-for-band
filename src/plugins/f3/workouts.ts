// Workouts are built from wherever they were reported: a BAND event and its comments, a feed post,
// a post comment, or a reply. Every field carries its source; unknown stays unknown.
import { extractAttendance, siteFromReport, milestoneSuggestions, type SourceComment } from "./parse";
import { stripMarkup } from "../../store";
import { localDate } from "../../helpers";
export { localDate };

export interface Report {
  itemId: string;
  kind: string;
  bandNo: number;
  author: string | null;
  createdAt: string;
  url: string | null;
  body: string;
  /** Title of the event or post the report belongs to, if any. */
  context?: string | null;
  /** Event start, when the report is an event comment. */
  eventStart?: string | null;
  eventId?: string | null;
}

export interface Workout {
  id: string;
  bandNo: number;
  date: string; // YYYY-MM-DD in the band's time zone
  dateSource: "event" | "text" | "posted";
  title: string | null;
  ao: string | null;
  q: string[];
  coQs: string[];
  pax: string[];
  statedCount: number | null;
  listedCount: number;
  /** Best count: stated if present, else listed if any names, else null (unknown). */
  count: number | null;
  countSource: "stated" | "listed" | "unknown";
  milestones: string[];
  confidence: "high" | "medium" | "low";
  sources: { itemId: string; kind: string; author: string | null; url: string | null; excerpt: string }[];
  notes: string[];
}

const BACKBLAST_RE = /\b(back\s*blast|backblast|bb\b|t-?claps|total\s+pax|pax\s*(count|list)?\s*[:\-–]|qic\s*[:\-–]|^q\s*[:\-–])/im;

export function looksLikeBackblast(body: string) {
  return BACKBLAST_RE.test(stripMarkup(body));
}

function cleanName(raw: string) {
  return stripMarkup(raw).replace(/^@/, "").replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim();
}

function splitNames(raw: string) {
  return stripMarkup(raw).split(/,|&|\band\b|\/|;|\+/i).map(cleanName).filter((n) => n.length > 1 && n.length <= 40 && !/^(n\/?a|none|tbd)$/i.test(n));
}

/** Q and co-Qs from the usual backblast lines. */
export function extractQs(body: string): { q: string[]; coQs: string[] } {
  const text = stripMarkup(body);
  const q: string[] = [];
  const coQs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const co = line.match(/^\s*co[-\s]?qs?\s*[:\-–]\s*(.+)$/i);
    if (co) { coQs.push(...splitNames(co[1]!)); continue; }
    const m = line.match(/^\s*(?:the\s+)?(?:q|qic|q'?s|vq)\s*[:\-–]\s*(.+)$/i);
    if (m && /^source\b/i.test(m[1]!)) continue; // "Q-Source" is a program, not a Q line
    if (m) { q.push(...splitNames(m[1]!)); continue; }
    const led = line.match(/\b(?:led|q['’]?d|qed)\s+by\s+@?([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)?)/);
    if (led && !q.length) q.push(cleanName(led[1]!));
  }
  // A "Q: A & B" line names co-Qs.
  if (q.length > 1) coQs.push(...q.splice(1));
  return { q: [...new Set(q)], coQs: [...new Set(coQs)].filter((n) => !q.includes(n)) };
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

/** A workout date stated in the text ("Date: 11/18", "11/18/26", "Nov 18"), resolved against the posting date. */
export function dateFromText(body: string, postedAt: string): string | null {
  const text = stripMarkup(body);
  const posted = new Date(postedAt);
  const year = Number(localDate(postedAt).slice(0, 4));
  const pick = (m: number, d: number, y?: number) => {
    let yy = y ? (y < 100 ? 2000 + y : y) : year;
    let iso = `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    // A date "in the future" relative to the post without a year means last year (e.g. a January post about Dec 30).
    if (!y && new Date(`${iso}T12:00:00Z`).getTime() - posted.getTime() > 7 * 86_400_000) iso = `${yy - 1}${iso.slice(4)}`;
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? iso : null;
  };
  const dateLine = text.match(/^\s*(?:date|when)\s*[:\-–]\s*(.+)$/im)?.[1] ?? text.slice(0, 200);
  const num = dateLine.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (num) return pick(Number(num[1]), Number(num[2]), num[3] ? Number(num[3]) : undefined);
  const named = dateLine.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i"));
  if (named) {
    const m = MONTHS.split("|").indexOf(named[1]!.toLowerCase().slice(0, 3)) + 1;
    return pick(m, Number(named[2]), named[3] ? Number(named[3]) : undefined);
  }
  return null;
}


const tidy = (s: string) => s.replace(/[^\p{L}\p{N}.'’&\s-]+/gu, " ").replace(/\s+/g, " ").replace(/^[\s.:|–-]+|[\s.:|–-]+$/g, "").trim();

/** AO and planned Q from an event title such as "Ridgeline: Q: Moose Call" or "Otter Pond Q: Cheese Grater". */
export function parseEventTitle(title: string | null | undefined): { ao: string | null; q: string | null } {
  if (!title) return { ao: null, q: null };
  const m = title.match(/^(.*)\bQ\s*[:\-–]\s*(.+)$/i);
  if (!m) {
    // "Riverbend: Quokka" names the AO, then the Q.
    const [ao, q] = title.split(/:\s*/, 2);
    return q !== undefined && tidy(q) ? { ao: tidy(ao!) || null, q: tidy(q) } : { ao: tidy(title) || null, q: null };
  }
  const q = tidy(m[2]!.split(/\s[-–|]\s|\|/)[0]!);
  return { ao: tidy(m[1]!) || null, q: q || null };
}

function asComment(r: Report): SourceComment {
  return { id: r.itemId, author: r.author ?? "Unknown", body: r.body, createdAt: r.createdAt, attachments: [] } as SourceComment;
}

/** Parse one report. Returns null when it doesn't read as a backblast. */
export function parseReport(r: Report): Workout | null {
  const att = extractAttendance(asComment(r));
  const qs = extractQs(r.body);
  const fromTitle = r.eventStart ? parseEventTitle(r.context) : { ao: null, q: null };
  if (!qs.q.length && fromTitle.q) qs.q.push(fromTitle.q);
  if (!att && !looksLikeBackblast(r.body)) return null;
  if (!att && !qs.q.length) return null;
  const textDate = dateFromText(r.body, r.createdAt);
  const date = r.eventStart ? localDate(r.eventStart) : textDate ?? localDate(r.createdAt);
  // The core parser treats lines under a header as names. Only trust them as attendees when the
  // report has an explicit PAX/attendee line, a stated total, or tagged members; narrative lines aren't PAX.
  const explicitList = /^\s*(?:pax|attendees|posted|in attendance)\b/im.test(stripMarkup(r.body)) || /<band:refer\b/i.test(r.body) || att?.statedCount != null;
  const pax = explicitList ? att?.names.map(cleanName).filter(Boolean) ?? [] : [];
  const statedCount = att?.statedCount ?? null;
  const listedCount = new Set(pax.map((n) => n.toLowerCase())).size;
  const count = statedCount ?? (listedCount ? listedCount : null);
  const notes: string[] = [];
  if (att?.discrepancy) notes.push(`stated ${statedCount} but ${listedCount} names listed`);
  if (!r.eventStart && !textDate) notes.push("workout date assumed from posting date");
  const confidence: Workout["confidence"] = statedCount !== null && qs.q.length && listedCount ? "high" : (statedCount !== null || listedCount) && (qs.q.length || r.eventStart) ? "medium" : "low";
  return {
    id: r.eventId ? `event:${r.eventId}` : `report:${r.itemId}`,
    bandNo: r.bandNo,
    date,
    dateSource: r.eventStart ? "event" : textDate ? "text" : "posted",
    title: r.context ?? null,
    ao: siteFromReport([asComment(r)]) ?? fromTitle.ao,
    q: qs.q,
    coQs: qs.coQs,
    pax,
    statedCount,
    listedCount,
    count,
    countSource: statedCount !== null ? "stated" : listedCount ? "listed" : "unknown",
    milestones: milestoneSuggestions([asComment(r)]).map((m) => `${m.kind}${m.person ? `: ${m.person}` : ""}`),
    confidence,
    sources: [{ itemId: r.itemId, kind: r.kind, author: r.author, url: r.url, excerpt: stripMarkup(r.body).slice(0, 160) }],
    notes,
  };
}

function overlap(a: string[], b: string[]) {
  const A = new Set(a.map((x) => x.toLowerCase()));
  const shared = b.filter((x) => A.has(x.toLowerCase())).length;
  return shared / Math.max(1, Math.min(a.length, b.length));
}

/** Merge reports of the same workout (same band and date, same event, or overlapping Q/PAX). */
export function mergeWorkouts(list: Workout[]): Workout[] {
  const out: Workout[] = [];
  for (const w of list.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : b.confidence === "high" ? 1 : a.confidence === "medium" ? -1 : 1))) {
    const same = out.find((o) => o.bandNo === w.bandNo && o.date === w.date && (o.id === w.id || (o.q.length && w.q.length && overlap(o.q, w.q) > 0) || (o.pax.length > 2 && w.pax.length > 2 && overlap(o.pax, w.pax) >= 0.5)));
    if (!same) { out.push({ ...w, sources: [...w.sources], notes: [...w.notes] }); continue; }
    same.sources.push(...w.sources);
    same.q = same.q.length ? same.q : w.q;
    same.coQs = [...new Set([...same.coQs, ...w.coQs])];
    same.ao ??= w.ao;
    same.title ??= w.title;
    if (same.statedCount === null && w.statedCount !== null) { same.statedCount = w.statedCount; same.count = w.statedCount; same.countSource = "stated"; }
    if (w.statedCount !== null && same.statedCount !== null && w.statedCount !== same.statedCount) same.notes.push(`reports disagree on count (${same.statedCount} vs ${w.statedCount})`);
    if (!same.pax.length && w.pax.length) { same.pax = w.pax; same.listedCount = w.listedCount; if (same.countSource === "unknown") { same.count = w.listedCount; same.countSource = "listed"; } }
    same.milestones = [...new Set([...same.milestones, ...w.milestones])];
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function stats(workouts: Workout[]) {
  const counted = workouts.filter((w) => w.count !== null);
  const byQ = new Map<string, number>();
  const byAo = new Map<string, { workouts: number; pax: number; counted: number }>();
  for (const w of workouts) {
    for (const q of w.q) byQ.set(q, (byQ.get(q) ?? 0) + 1);
    const ao = w.ao ?? w.title ?? "unknown";
    const a = byAo.get(ao) ?? { workouts: 0, pax: 0, counted: 0 };
    a.workouts++;
    if (w.count !== null) { a.pax += w.count; a.counted++; }
    byAo.set(ao, a);
  }
  return {
    workouts: workouts.length,
    withCount: counted.length,
    withQ: workouts.filter((w) => w.q.length).length,
    totalPax: counted.reduce((s, w) => s + (w.count ?? 0), 0),
    averagePax: counted.length ? Math.round((counted.reduce((s, w) => s + (w.count ?? 0), 0) / counted.length) * 10) / 10 : null,
    byQ: Object.fromEntries([...byQ].sort((a, b) => b[1] - a[1])),
    byAo: Object.fromEntries(byAo),
    coverageNote: `Q known for ${workouts.filter((w) => w.q.length).length} of ${workouts.length}; count known for ${counted.length} of ${workouts.length}. Totals cover counted workouts only.`,
  };
}
