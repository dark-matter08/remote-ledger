# The Remote Ledger — project notes for Claude

Local-first, open-source job-application copilot. React Router 7 (framework mode, SSR)
+ node:sqlite (built into Node — no native deps). Finds remote roles, tailors a résumé per job with the user's own AI
(CLI subscription OR BYO API key), renders downloadable PDFs, and tracks the pipeline.
Privacy: data + keys stay on the machine; only the chosen AI provider is called.

## Architecture
- `app/sqlite.server.ts` — single SQLite connection, schema bootstrap, settings + migrations.
- `app/secrets.server.ts` — encrypted BYO-key store (AES-256-GCM, local master key; env vars override).
- `app/llm/` — runner layer. `types.ts`, `adapters.server.ts` (CLI: claude/codex/cursor/gemini;
  API: anthropic/openai/google/openrouter/groq/mistral/ollama), `runner.server.ts`
  (dispatch + cost + budget + `llm_calls` logging), `pricing.server.ts`, + root `pricing.json`,
  `openrouter.server.ts` (catalogue: free-tier detection, price tiers, live cost, 6h disk cache).
- `app/resume/` — `profiles.server.ts` (PDF→JSON parse, CRUD), `ai.server.ts` (tailor with
  anti-hallucination guard, match, cover, prep), `templates.server.ts` (4 styles),
  `pdf.server.ts` (Playwright), `versions.server.ts`, `types.ts`.
- `app/db.server.ts` — jobs, applications/stages, events, board, funnel, source stats, crawl upsert.
- `app/profiles.server.ts` — job profiles: one per line of work. Owns field/location/stack,
  its prompt, its boards and companies, and its own copies of the postings it finds. The old
  `profile_field`/`profile_location`/`profile_stack` settings rows are written through from the
  current profile for one release, then removed. Job ids are namespaced `<profile>--<slug>`
  except on `default`, which keeps bare ids so pre-profiles installs are untouched.
  Dedup is per-profile and enforced in `upsertJobs`, deliberately not by a unique index —
  an index makes the legacy-duplicate state unrepresentable and would lock out the fold
  that repairs it.
- `app/default-boards.ts` — job boards seeded into every install (per-URL, so a deletion sticks).
- `app/fields.ts` — the line of work (`profile_field`). Selects the crawl's relevance
  vocabulary, the board-side feed filters, and the noun interpolated into the scorer and
  prompt.md. Was a hardcoded engineering regex; see the commit for the measurements.
- `app/services/autopilot.server.ts` — runs the guided steps in order (match → build from KB →
  tailor → cover → read form → draft answers). Adds no capability; sequences what exists.
  Steps are data with skip conditions, a failure stops the run and resumes on the next one,
  and it **never submits** — a test asserts the file contains nothing that could. Logs to
  `crawl_runs`/`crawl_logs` with `type='autopilot'`; `activeCrawl()` filters to the real crawl
  types so it cannot block the scheduler.
- `app/services/portability.server.ts` — export/import for moving machines. Whole install or
  one profile, gzipped JSON. **The `secrets` table is never read**, so keys cannot travel; the
  file names what it omitted. Refuses a newer-version file rather than guessing at columns.
- `app/services/` — `crawl.server.ts` (in-process crawl via runner; searches every active
  profile in one run and divides the configured budget between them, with a 4-minute floor
  below which it rotates instead of overspending), `feeds.server.ts` (keyless
  public job feeds, asked for the user's field where the board takes a parameter; RemoteOK is
  excluded from both category-trust and field-filtering, measured, see the file),
  `documents.server.ts` (read .pdf/.docx/.md/.txt out of a folder — the KB is not repo-only),
  `scheduler.server.ts` (in-app timer),
  `backup.server.ts` (VACUUM INTO, 6-hourly, keep 10), `reset.server.ts` (Settings → Danger zone:
  per-scope wipe, backs up first, re-seeds the shipped boards, sends you back to `/setup`).
- `app/routes/setup.tsx` — the onboarding wizard: six steps, one on screen at a time, `?step=N`.
  Each step ends in a real proof (`api/setup`: a live model call, a live feed read, the crawl log).
- `app/routes/` — pages + resource routes: `api/crawl`, `api/clip`, `api/setup`, `version/:vid/resume.pdf`.
- `scripts/` — `run-crawl.ts` (CLI crawl), `os-scheduler.mjs` (cross-platform OS schedule),
  `seed.mjs` + `seed-jobs.json` + `db.mjs` (initial seed), `schema.sql`, `prompt.md` (templated).
- `extension/` — MV3 browser clipper.
- `data/` (gitignored) — `jobs.db`, `pdfs/`, `apply/`, `backups/`, `.master.key`.

## Design System
Always read DESIGN.md before any visual/UI change (Heritage Press: Fraunces / Spectral /
IBM Plex Mono; ink on antique paper; spot red; hard shadows; zero border-radius). Reuse the
shared `Shell`, `Nav`, and the `.panel/.field/.btn/.stat/.badge` primitives in app.css.

## Conventions
- `*.server.ts` = server-only; never import into client components.
- node:sqlite (`DatabaseSync`) is synchronous — fine in loaders/actions. It has no
  `db.transaction()`; use the `transaction()` helper exported from `app/sqlite.server.ts`.
- Jobs keyed by `company--role` slug (re-crawls upsert, not duplicate).
- User-owned fields (application stage, notes) are NEVER overwritten by a crawl.
- The crawl needs web access; it works best with a CLI runner that has WebSearch (Claude Code).
- Keep `npm run typecheck` green.
