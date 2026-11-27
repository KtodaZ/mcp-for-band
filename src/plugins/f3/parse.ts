// This module parses workout event comments into unverified suggestions. It parses attendance
// for data compatibility outside the editor, and volunteers confirm only milestone suggestions
// in the review UI. A sampled backblast uses "Total Pax:3" followed by one attendee per line,
// sometimes wrapped in BAND's <band:refer> markup. Keep the source text alongside suggestions.

export type { SourceComment } from "./types";
import type { AttendanceCandidate, MilestoneKind, MilestoneSuggestion, SourceComment } from "./types";

const RSVP_RE = /^\s*(hc|h\.c\.|hard\s*commit|soft\s*commit|sc|i'?m\s+in|in|count\s+me\s+in|see\s+you\s+there|rsvp)\b[\s!.👍💪]*$/i;
const REPORT_HEADER_RE = /\b(backblast|bb|attendance|pax\s*(list|count)?|t-?claps)\b/i;
const COUNT_RE = /\b(?:count|total\s+pax|total|pax\s*count|#\s*pax|pax\s*#|attendance|num(?:ber)?\s*of\s*pax)\s*[:=#-]?\s*(\d{1,3})\b/i;
const COUNT_ALT_RE = /\b(\d{1,3})\s+(?:pax|posted|men|hims)\b/i;
const PAX_LINE_RE = /^\s*(?:pax|attendees|posted|in attendance)\s*[:\-–]\s*(.+)$/im;
const Q_LINE_RE = /^\s*(?:q|qic|the q)\s*[:\-–]\s*(.+)$/im;
const SITE_LINE_RE = /^\s*(?:ao|site|location|where)\s*[:\-–]\s*(.+)$/im;

export function sourceCommentExcerpt(body: string): string {
  const plainText = body
    .replace(/<band:refer\b[^>]*>([\s\S]*?)<\/band:refer>/gi, (_match: string, name: string) => `@${name.replace(/^@/, "")}`)
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/<\/?[a-z][^>]*$/gi, "");
  return plainText.length > 400 ? `${plainText.slice(0, 400)}…` : plainText;
}

export function isRsvpComment(body: string): boolean {
  return RSVP_RE.test(body.trim());
}

function splitNames(list: string): string[] {
  return list
    .replace(/\(([^)]*)\)/g, " ") // drop parentheticals like "(FNG)" from the name itself
    .split(/[,;\n]|\s+&\s+|\band\b/i)
    .map((s) => s.replace(/^[\s@*•\-–]+|[\s.*]+$/g, ""))
    .filter((s) => s.length > 0 && s.length <= 40 && !/^\d+$/.test(s));
}

// A line that is only a count: "PAX 13", "PAX: 15", "Pax:8", "Total pax 6", "Total Pax: 12", "Count - 9".
const COUNT_LINE_RE = /^\s*(?:total\s+)?(?:pax|count|attendance|posted)\s*(?:count|#)?\s*[:=#\-–]?\s*(\d{1,3})\s*$/i;
const Q_HEADER_RE = /^\s*(?:q|qic|the q)\s*[:\-–]\s*(.*)$/i;
const TAG_RE = /<band:refer\b[^>]*>([^<]+)<\/band:refer>/gi;

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

/** Names on one line of an attendee list, or null when the line isn't a list of names. */
function namesOnLine(raw: string): string[] | null {
  const tagged = [...raw.matchAll(TAG_RE)].map((m) => decode(m[1]!).replace(/^@/, "").trim());
  const rest = decode(raw.replace(TAG_RE, " ")).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // What's left besides tags may only be joiners ("&", ",", "and") or typed names ("@Quokka", "Trombone").
  const plain = rest.replace(/^(?:[,&;]|and\b)\s*|\s*(?:[,&;]|\band)$/gi, "").trim();
  if (!plain) return tagged.length ? tagged : null;
  // "@John Smith Gizmo", "@Z.E.B.R.A. not in photo": words after a tag describe that person.
  if (tagged.length && !/[,&;]|\band\b/i.test(plain) && !plain.startsWith("@")) return plain.length <= 60 && !/[:<>?]/.test(plain) ? tagged : null;
  if (plain.length > 60 || /[:<>!?]/.test(plain) || /^\d+$/.test(plain)) return null;
  const typed = splitNames(plain);
  if (!typed.length || typed.some((n) => n.split(/\s+/).length > 4)) return null;
  return [...tagged, ...typed];
}

/** Attendees listed one per line after the count or Q line (a common backblast shape). */
function namesAfterHeader(body: string): { names: string[]; q: string | null } {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => COUNT_LINE_RE.test(l) || /\btotal\s+pax\s*[:=#-]?\s*\d{1,3}\b/i.test(l) || Q_HEADER_RE.test(l));
  if (start < 0) return { names: [], q: null };
  const names: string[] = [];
  let q: string | null = null;
  for (const raw of lines.slice(start, start + 120)) {
    const line = raw.trim();
    if (!line) {
      if (names.length) break;
      continue;
    }
    if (COUNT_LINE_RE.test(line) || /\btotal\s+pax\s*[:=#-]?\s*\d{1,3}\b/i.test(line)) continue;
    const qm = line.match(Q_HEADER_RE);
    if (qm && !q) {
      const qNames = namesOnLine(qm[1] ?? "");
      q = qNames?.[0] ?? null;
      continue;
    }
    const found = namesOnLine(line);
    if (!found) break;
    names.push(...found);
  }
  return { names, q };
}

export function extractAttendance(comment: SourceComment): AttendanceCandidate | null {
  const body = comment.body ?? "";
  if (!body.trim() || isRsvpComment(body)) return null;

  const reasons: string[] = [];
  let score = 0;

  if (REPORT_HEADER_RE.test(body)) {
    score += 2;
    reasons.push("report keywords");
  }

  let statedCount: number | null = null;
  const countLine = body.split(/\r?\n/).map((l) => l.match(COUNT_LINE_RE)).find(Boolean);
  const countMatch = countLine ?? body.match(COUNT_RE) ?? body.match(COUNT_ALT_RE);
  if (countMatch) {
    const n = Number(countMatch[1]);
    if (n > 0 && n < 300) {
      statedCount = n;
      score += 2;
      reasons.push(`stated count ${n}`);
    }
  }

  let names: string[] = [];
  const paxLine = body.match(PAX_LINE_RE);
  if (paxLine?.[1]) {
    names = splitNames(paxLine[1]);
    // PAX lists sometimes continue on following lines; accept up to 5 continuation lines of comma lists.
    const after = body.slice(body.indexOf(paxLine[0]) + paxLine[0].length).split("\n").slice(1, 6);
    for (const line of after) {
      if (!line.includes(",") || /:\s/.test(line)) break;
      names.push(...splitNames(line));
    }
    if (names.length > 0) {
      score += 2;
      reasons.push(`${names.length} names listed`);
    }
  }
  let listQ: string | null = null;
  if (names.length === 0) {
    const listed = namesAfterHeader(body);
    names = listed.names;
    listQ = listed.q;
    if (names.length > 0) {
      score += 2;
      reasons.push(`${names.length} names listed`);
    }
  }
  // Some Qs put themselves only on the Q line, then list the other PAX below. Include the Q
  // when that reconciles the stated total, or when there's no total to check against.
  const qRaw = body.match(Q_LINE_RE)?.[1];
  const qName = listQ ?? qRaw?.replace(/<band:refer\b[^>]*>([^<]+)<\/band:refer>/gi, "$1").replace(/<[^>]*>/g, "").replace(/^@/, "").trim();
  const qListed = qName && names.some((name) => name.toLowerCase() === qName.toLowerCase());
  if (qName && qName.length <= 40 && !/[:<>!?]/.test(qName) && !qListed && names.length > 0 && (statedCount === names.length + 1 || (statedCount === null && listQ !== null))) {
    names.unshift(qName);
    reasons.push(statedCount === null ? "Q listed above the PAX" : "Q included in stated total");
  }
  if (Q_LINE_RE.test(body)) {
    score += 1;
    reasons.push("Q line");
  }

  if (score < 3) return null;

  const unique = [...new Set(names.map((n) => n.toLowerCase()))];
  const listedCount = unique.length;
  return {
    commentId: comment.id,
    author: comment.author,
    at: comment.createdAt,
    statedCount,
    names,
    listedCount,
    discrepancy: statedCount !== null && listedCount > 0 && statedCount !== listedCount,
    score,
    reasons,
    excerpt: sourceCommentExcerpt(body),
  };
}

/** Attendance candidates, best first. Several candidates means the editor must pick one. */
export function attendanceCandidates(comments: SourceComment[]): AttendanceCandidate[] {
  return comments
    .filter((c) => !c.deleted)
    .map(extractAttendance)
    .filter((c): c is AttendanceCandidate => c !== null)
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
}

export function siteFromReport(comments: SourceComment[]): string | undefined {
  for (const c of comments) {
    const m = c.body?.match(SITE_LINE_RE);
    if (m?.[1]) return m[1].trim().slice(0, 60);
  }
  return undefined;
}

interface Rule {
  kind: MilestoneKind;
  re: RegExp;
  confidence: "high" | "low";
}

// Word-boundary patterns. `100` requires milestone context so addresses, counts, reps, and
// dates are not promoted. Plain "100" with no context is not suggested at all.
const RULES: Rule[] = [
  { kind: "FNG", re: /\bFNGs?\b\s*[:\-–]?\s*([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)?)?/g, confidence: "high" },
  { kind: "VQ", re: /\b(?:VQ|virgin\s+Q)\b/gi, confidence: "high" },
  { kind: "100", re: /💯|\b100(?:th)?\s+(?:post|posts|beatdown|beatdowns|workout|workouts)\b|\b(?:hit|reached|celebrat\w*|congrats\s+on)\s+(?:his\s+|their\s+)?100(?:th)?\b|#100\b|\b100th\b/gi, confidence: "high" },
];

function isFutureOrQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence) || /\b(bring|invite|looking for|hope|any|will|next week|tomorrow|upcoming)\b/i.test(sentence);
}

function sentenceAround(body: string, index: number): string {
  const start = Math.max(body.lastIndexOf("\n", index), body.lastIndexOf(". ", index)) + 1;
  const rest = body.slice(index).search(/\n|[.!?](?=\s)/);
  const end = rest === -1 ? body.length : index + rest + 1;
  return body.slice(start, end).trim();
}

function milestonePerson(kind: MilestoneKind, match: RegExpExecArray, sentence: string): string | undefined {
  const name = String.raw`([A-Z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)?)`;
  if (kind === "FNG") {
    // "@Sprocket (FNG EH'd by Snorkel)": the name before the parenthesis.
    // "@corkscrew (former FNG Ferris)": the @handle, not the name in the parenthesis.
    const lead = String.raw`\s*\(\s*(?:former\s+|ex-?\s*)?\+?FNGs?\b`;
    const handle = sentence.match(new RegExp(String.raw`@([A-Za-z][\w'’.-]*(?:\s+[A-Z][\w'’.-]*)?)${lead}`))?.[1]?.trim();
    if (handle) return handle.charAt(0).toUpperCase() + handle.slice(1);
    const before = sentence.match(new RegExp(String.raw`${name}${lead}`))?.[1]?.trim();
    if (before) return before;
    const after = match[1]?.trim();
    return after && !/^(?:EH|EH['’]?d|by|from|welcome|today|this|was|is)\b/i.test(after) ? after : undefined;
  }
  const patterns = kind === "VQ"
    ? [
        new RegExp(String.raw`\b(?:VQ|virgin\s+Q)\s+(?:from|by|for)\s+${name}\b`, "i"),
        new RegExp(String.raw`\b${name}(?:['’]s|\s+is)?\s+(?:VQ|virgin\s+Q)\b`, "i"),
        new RegExp(String.raw`\b${name}\s*\(\s*(?:VQ|virgin\s+Q)\b`, "i"),
      ]
    : kind === "100"
      ? [
          new RegExp(String.raw`\b(?:congrats|congratulations)(?:\s+to)?\s+${name}\b`, "i"),
          new RegExp(String.raw`\b${name}\s+(?:hit|reached|celebrat\w*)\b[^.\n]*\b100(?:th)?\b`, "i"),
          new RegExp(String.raw`\b100(?:th)?\s+(?:post|beatdown|workout)\s+(?:for\s+)?${name}\b`, "i"),
        ]
      : [];
  for (const pattern of patterns) {
    const found = sentence.match(pattern)?.[1]?.trim().replace(/\s+(?:on|today|his|her|their|at|for)$/i, "");
    if (found) return found;
  }
  return undefined;
}

export function milestoneSuggestions(comments: SourceComment[]): MilestoneSuggestion[] {
  const out: MilestoneSuggestion[] = [];
  const people = new Set<string>(); // one question per kind and person across the whole post
  for (const c of comments) {
    const seen = new Set<string>();
    if (c.deleted || !c.body || isRsvpComment(c.body)) continue;
    const body = c.body.replace(/https?:\/\/\S+/g, " ");
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = rule.re.exec(body))) {
        const sentence = sentenceAround(body, m.index);
        let confidence = rule.confidence;
        if (isFutureOrQuestion(sentence)) confidence = "low";
        const person = milestonePerson(rule.kind, m, sentence);
        // One suggestion per kind/person/sentence: "100 posts 💯" is a single milestone.
        const dedupe = `${rule.kind}|${person ?? ""}|${sentence}`;
        if (seen.has(dedupe)) {
          if (m[0].length === 0) rule.re.lastIndex++;
          continue;
        }
        seen.add(dedupe);
        const personKey = person ? `${rule.kind}|${person.toLowerCase()}` : null;
        // "Anyone want to bring an FNG next week?" names no one and isn't a milestone; the same
        // person's VQ mentioned in two comments is one question. (The index still advances so the
        // ids of later suggestions, which saved answers point at, don't shift.)
        if ((confidence === "low" && !person) || (personKey && people.has(personKey))) {
          i++;
          if (m[0].length === 0) rule.re.lastIndex++;
          continue;
        }
        if (personKey) people.add(personKey);
        out.push({
          id: `${c.id}:${rule.kind}:${i++}`,
          kind: rule.kind,
          person,
          sourceCommentId: c.id,
          sourceText: sentence.slice(0, 240),
          confidence,
        });
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
  }
  return out;
}
