// Structured resume model (the canonical form everything operates on).

export interface ResumeLink { label: string; url: string }
export interface ResumeContact {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  location?: string;
  links?: ResumeLink[];
}
export interface ResumeExperience {
  company: string;
  role: string;
  start?: string;
  end?: string;
  location?: string;
  bullets: string[];
}
export interface ResumeProject {
  name: string;
  role?: string;
  start?: string;
  end?: string;
  url?: string;
  bullets: string[];
}
export interface ResumeEducation {
  school: string;
  degree?: string;
  start?: string;
  end?: string;
  detail?: string;
}
export interface Resume {
  contact: ResumeContact;
  summary?: string;
  skills: string[];
  experience: ResumeExperience[];
  projects: ResumeProject[];
  education: ResumeEducation[];
}

export interface MatchAnalysis {
  score: number; // 0..100, summed in code from `dimensions` when they are present
  matched: string[];
  missing: string[];
  atsKeywords: string[]; // keywords the resume should contain for ATS
  /**
   * How the score was arrived at. Absent on matches analysed before the rubric existed,
   * which is why everything reading a match still has to cope without it.
   */
  dimensions?: { key: string; label: string; score: number; max: number; evidence: string }[];
  /** Which rubric produced it. Scores from different versions are not comparable. */
  rubricVersion?: number;
}

export interface TailorFlag {
  severity: "info" | "warn";
  message: string;
}

// JSON shape we ask the model to produce when parsing/tailoring.
export const RESUME_JSON_SHAPE = `{
  "contact": { "name": "", "title": "", "email": "", "phone": "", "location": "", "links": [{"label":"","url":""}] },
  "summary": "",
  "skills": ["..."],
  "experience": [{"company":"","role":"","start":"","end":"","location":"","bullets":["..."]}],
  "projects": [{"name":"","role":"","start":"","end":"","url":"","bullets":["..."]}],
  "education": [{"school":"","degree":"","start":"","end":"","detail":""}]
}`;

export function emptyResume(): Resume {
  return { contact: { name: "" }, summary: "", skills: [], experience: [], projects: [], education: [] };
}
