-- The Remote Ledger — SQLite schema (single source of truth, read by app + scripts)

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,          -- stable slug: company--role
  company      TEXT NOT NULL,
  role         TEXT NOT NULL,
  category     TEXT NOT NULL,             -- high | medium | stretch
  fit_score    INTEGER NOT NULL,          -- 0..100
  stack        TEXT,                      -- short fine-print: tech match
  eligibility  TEXT,                      -- eligibility note
  seniority    TEXT,
  apply_url    TEXT NOT NULL,
  source       TEXT,                      -- board / company found on

  closes_at    TEXT,                      -- nullable ISO date (deadline)

  -- user-owned fields: NEVER overwritten by a crawl
  status       TEXT NOT NULL DEFAULT 'to-apply',  -- to-apply|applied|interviewing|offer|passed
  notes        TEXT NOT NULL DEFAULT '',

  -- crawl bookkeeping
  active       INTEGER NOT NULL DEFAULT 1, -- 1 = seen in latest crawl, 0 = gone
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_category ON jobs(category);
CREATE INDEX IF NOT EXISTS idx_jobs_fit ON jobs(fit_score);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- v2: copilot tables (LLM runner, secrets, resumes, applications)
-- ---------------------------------------------------------------------------

-- user configuration (runner choice, prompt, scheduler interval, budget, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- BYO API keys, encrypted at rest with the local master key (data/.master.key)
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,   -- e.g. anthropic_api_key
  ciphertext TEXT NOT NULL,      -- base64(iv).base64(tag).base64(data)
  updated_at TEXT NOT NULL
);

-- every LLM call, for token + cost tracking
CREATE TABLE IF NOT EXISTS llm_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  runner      TEXT NOT NULL,      -- claude-cli | anthropic-api | ollama | ...
  model       TEXT,
  purpose     TEXT NOT NULL,      -- job-research | resume-tailor | cover-letter | match | parse-resume | interview-prep
  job_id      TEXT,
  in_tok      INTEGER NOT NULL DEFAULT 0,
  out_tok     INTEGER NOT NULL DEFAULT 0,
  cached_tok  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL NOT NULL DEFAULT 0,
  metered     INTEGER NOT NULL DEFAULT 1,  -- 0 = subscription (cost not billed per-token)
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'ok',
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_ts ON llm_calls(ts);
CREATE INDEX IF NOT EXISTS idx_llm_job ON llm_calls(job_id);

-- base resume profiles (parsed to structured JSON)
CREATE TABLE IF NOT EXISTS resume_profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  data_json   TEXT NOT NULL,     -- structured resume
  raw_text    TEXT,
  source_file TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- tailored resumes / cover letters per job
CREATE TABLE IF NOT EXISTS resume_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  profile_id  TEXT,
  kind        TEXT NOT NULL DEFAULT 'resume',  -- resume | cover-letter
  style       TEXT NOT NULL DEFAULT 'letterpress',
  data_json   TEXT,             -- tailored structured resume
  content_md  TEXT,             -- cover letter / free text
  flags_json  TEXT,             -- anti-hallucination findings
  match_json  TEXT,             -- match/gap analysis
  llm_call_id INTEGER,
  pdf_path    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rv_job ON resume_versions(job_id);

-- application pipeline state (one row per job once it enters the pipeline)
CREATE TABLE IF NOT EXISTS applications (
  job_id            TEXT PRIMARY KEY,
  stage             TEXT NOT NULL DEFAULT 'saved', -- saved|applied|screening|interview|offer|rejected|withdrawn
  sub_stage         TEXT,                          -- phone|technical|system-design|final
  applied_at        TEXT,
  resume_version_id INTEGER,
  next_action       TEXT,
  next_action_at    TEXT,
  updated_at        TEXT NOT NULL
);

-- timeline of everything that happened to an application
CREATE TABLE IF NOT EXISTS application_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,   -- stage_change|note|resume_generated|cover_generated|interview|reminder|applied|created
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ae_job ON application_events(job_id);

-- ---------------------------------------------------------------------------
-- v3: manual auto-apply sessions, logs, question pool, answer bank
-- ---------------------------------------------------------------------------

-- a manually-started run of the auto-apply assistant over matching jobs
CREATE TABLE IF NOT EXISTS apply_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'running', -- running | done | stopped | error
  mode        TEXT NOT NULL DEFAULT 'draft',   -- draft (headless) | assist (visible prefill)
  rules_json  TEXT,                            -- {categories, minFit, stages, max, requireJd}
  total       INTEGER NOT NULL DEFAULT 0,
  processed   INTEGER NOT NULL DEFAULT 0,
  needs_input INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

-- per-job outcome within a session
CREATE TABLE IF NOT EXISTS apply_session_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  job_id      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued', -- queued|applying|drafted|needs_input|skipped|failed
  questions   INTEGER NOT NULL DEFAULT 0,
  unanswered  INTEGER NOT NULL DEFAULT 0,
  shot_path   TEXT,
  started_at  TEXT,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_asj_session ON apply_session_jobs(session_id);

-- full activity log of a session (agent actions, answers, screenshots, errors)
CREATE TABLE IF NOT EXISTS apply_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL,
  job_id      TEXT,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- action | answer | screenshot | note | error
  text        TEXT,
  shot_path   TEXT
);
CREATE INDEX IF NOT EXISTS idx_al_session ON apply_logs(session_id);

-- pool of questions the agent could not answer; user answers them here
CREATE TABLE IF NOT EXISTS apply_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER,
  job_id      TEXT,
  question    TEXT NOT NULL,
  answer      TEXT,
  answered_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aq_open ON apply_questions(answer);

-- reusable knowledge base: a question -> your saved answer, reused across jobs
CREATE TABLE IF NOT EXISTS answer_bank (
  key        TEXT PRIMARY KEY,  -- normalized question
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- v4: crawl runs + logs (the Crawl Shell)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL DEFAULT 'find',     -- find | update | full
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  received   INTEGER NOT NULL DEFAULT 0,
  inserted   INTEGER NOT NULL DEFAULT 0,
  updated    INTEGER NOT NULL DEFAULT 0,
  scraped    INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  trigger    TEXT,                              -- manual | scheduler | cli
  note       TEXT
);
CREATE TABLE IF NOT EXISTS crawl_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  kind    TEXT NOT NULL,   -- note | step | reasoning | result | error
  text    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cl_run ON crawl_logs(run_id);

-- ===== Knowledge base (what the agent knows about you, for résumé building) =====
CREATE TABLE IF NOT EXISTS kb_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL DEFAULT 'project',  -- project | experience | skill | fact
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',       -- JSON array of tech/skills
  source      TEXT NOT NULL DEFAULT 'manual',   -- manual | scan
  source_path TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER,
  question    TEXT NOT NULL,
  answer      TEXT,
  created_at  TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kbq_item ON kb_questions(item_id);
CREATE TABLE IF NOT EXISTS kb_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER,
  section     TEXT NOT NULL DEFAULT 'project',  -- project | experience | skill | summary
  bullet      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kbs_status ON kb_suggestions(status);
CREATE TABLE IF NOT EXISTS kb_scans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',  -- running | done | error
  found       INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
