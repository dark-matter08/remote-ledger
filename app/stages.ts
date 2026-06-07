// Client-safe shared types + constants (NO server imports). Both server modules
// and client components import from here, so the broadsheet/board/job pages can use
// stage labels without pulling better-sqlite3 into the browser bundle.

export type Category = "high" | "medium" | "stretch";

export type Stage =
  | "saved"
  | "applied"
  | "screening"
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn";

export const STAGES: Stage[] = [
  "saved",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
];

// compact set shown in the broadsheet's inline dropdown
export const QUICK_STAGES: Stage[] = ["saved", "applied", "interview", "offer", "rejected"];

export const STAGE_LABEL: Record<Stage, string> = {
  saved: "Saved",
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export interface Job {
  id: string;
  company: string;
  role: string;
  category: Category;
  fit_score: number;
  stack: string | null;
  eligibility: string | null;
  seniority: string | null;
  apply_url: string;
  source: string | null;
  closes_at: string | null;
  jd: string | null;
  notes: string;
  active: number;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  stage: Stage;
  sub_stage: string | null;
  applied_at: string | null;
  is_new?: boolean;
  closing_soon?: boolean;
}
