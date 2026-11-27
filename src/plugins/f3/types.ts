export type MilestoneKind = "FNG" | "VQ" | "100" | "BQ" | "OTHER";

export interface MilestoneSuggestion {
  id: string; // stable: `${commentId}:${kind}:${index}`
  kind: MilestoneKind;
  person?: string;
  sourceCommentId: string;
  sourceText: string;
  confidence: "high" | "low";
}

export interface AttendanceCandidate {
  commentId: string;
  author: string;
  at: string;
  statedCount: number | null;
  names: string[];
  listedCount: number;
  discrepancy: boolean;
  score: number;
  reasons: string[];
  excerpt: string;
}

export interface SourceComment {
  id: string;
  parentId?: string;
  author: string;
  authorKey?: string;
  body: string;
  createdAt: string;
  attachments: unknown[];
  deleted?: boolean;
  edited?: boolean;
}

