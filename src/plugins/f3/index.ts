// This plugin extracts F3 Q, PAX count, attendees, and AO from backblasts in event comments,
// feed posts, and post comments. Enable it in settings.json with { "plugins": ["f3"] }.
import * as store from "../../store";
import { type Tool, UNTRUSTED, bands, date, resolveBands, defaultBands, bandName, day, dayEnd, coverageNote } from "../../helpers";
import type { Plugin } from "..";
import { mergeWorkouts, parseReport, stats, type Workout } from "./workouts";

/** Build workouts for bands and dates from the cache. */
export function workoutsFor(bandNos: number[], from: string, to: string): Workout[] {
  const found: Workout[] = [];
  for (const bandNo of bandNos) {
    const events = store.itemsInRange(bandNo, ["event"], day(from), dayEnd(to));
    const eventIds = new Set(events.map((e) => e.id));
    for (const e of events) {
      const raw = e.raw ? JSON.parse(e.raw) : {};
      for (const c of store.children(e.id)) {
        const w = parseReport({ itemId: c.id, kind: c.kind, bandNo, author: c.author, createdAt: c.created_at, url: c.url, body: c.body, context: e.title, eventStart: raw.start_at ?? e.created_at, eventId: raw.schedule_id ?? e.id });
        if (w) found.push(w);
      }
    }
    // Feed reports can be posted a few days late.
    const late = new Date(new Date(dayEnd(to)).getTime() + 3 * 86_400_000).toISOString();
    for (const p of store.itemsInRange(bandNo, ["post", "post_comment"], day(from), late)) {
      if (p.parent_id && eventIds.has(p.parent_id)) continue;
      const parent = p.parent_id ? store.getItem(p.parent_id) : undefined;
      const w = parseReport({ itemId: p.id, kind: p.kind, bandNo, author: p.author, createdAt: p.created_at, url: p.url, body: p.body, context: parent ? store.stripMarkup(parent.body).split("\n")[0]!.slice(0, 80) : store.stripMarkup(p.body).split("\n")[0]!.slice(0, 80) });
      if (w && w.date >= from && w.date <= to) found.push(w);
    }
  }
  return mergeWorkouts(found);
}


const tools: Tool[] = [
  {
    name: "list_workouts",
    description: `Workouts on a day or range, built from backblasts wherever they were posted (event comments, feed posts, post comments). Each has the Q, co-Qs, PAX, count (stated, listed or unknown), AO, confidence and source links. Unknown counts are null, never 0. Sync the range first. ${UNTRUSTED}`,
    inputSchema: { type: "object", properties: { bands, from: date("YYYY-MM-DD"), to: date("YYYY-MM-DD (default = from)") }, required: ["from"] },
    run: async (a) => {
      const bs = resolveBands(a.bands) ?? store.listBands().map((b) => b.band_no);
      const ws = workoutsFor(bs, a.from, a.to ?? a.from);
      return { workouts: ws.map((w) => ({ ...w, band: bandName(w.bandNo) })), covered: coverageNote(bs) };
    },
  },
  {
    name: "workout_stats",
    description: `Totals over a range: workouts, PAX (counted workouts only), average, per Q and per AO, with how many workouts had a known Q and count. ${UNTRUSTED}`,
    inputSchema: { type: "object", properties: { bands, from: date("YYYY-MM-DD"), to: date("YYYY-MM-DD") }, required: ["from", "to"] },
    run: async (a) => {
      const bs = resolveBands(a.bands) ?? defaultBands();
      return { ...stats(workoutsFor(bs, a.from, a.to)), covered: coverageNote(bs) };
    },
  },
  {
    name: "who_qd",
    description: `Who led (Q'd) workouts in a range, or one person's Q history when name is given. ${UNTRUSTED}`,
    inputSchema: { type: "object", properties: { bands, from: date("YYYY-MM-DD"), to: date("YYYY-MM-DD"), name: { type: "string" } }, required: ["from", "to"] },
    run: async (a) => {
      const bs = resolveBands(a.bands) ?? defaultBands();
      let ws = workoutsFor(bs, a.from, a.to);
      if (a.name) ws = ws.filter((w) => [...w.q, ...w.coQs].some((q) => q.toLowerCase().includes(String(a.name).toLowerCase())));
      return { workouts: ws.map((w) => ({ date: w.date, band: bandName(w.bandNo), title: w.title, ao: w.ao, q: w.q, coQs: w.coQs, count: w.count, source: w.sources[0]?.url })), unknownQ: ws.filter((w) => !w.q.length).length, covered: coverageNote(bs) };
    },
  },
];

const plugin: Plugin = {
  name: "f3",
  description: "F3 workouts from backblasts: list_workouts, workout_stats, who_qd",
  tools,
  instructions: "Workouts come from backblasts wherever they were posted; sync the range first. Unknown counts are unknown, not zero.",
};
export default plugin;
