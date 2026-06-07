# The Remote Ledger — project notes for Claude

Local-first, open-source job-application copilot. React Router 7 (framework mode, SSR)
+ better-sqlite3. Finds remote roles, tailors a résumé per job with the user's own AI
(CLI subscription OR BYO API key), renders downloadable PDFs, and tracks the pipeline.
Privacy: data + keys stay on the machine; only the chosen AI provider is called.

## Architecture
- `app/sqlite.server.ts` — single SQLite connection, schema bootstrap, settings + migrations.
- `app/secrets.server.ts` — encrypted BYO-key store (AES-256-GCM, local master key; env vars override).
- `app/llm/` — runner layer. `types.ts`, `adapters.server.ts` (CLI: claude/codex/cursor/gemini;
  API: anthropic/openai/google/openrouter/groq/mistral/ollama), `runner.server.ts`
  (dispatch + cost + budget + `llm_calls` logging), `pricing.server.ts`, + root `pricing.json`.
- `app/resume/` — `profiles.server.ts` (PDF→JSON parse, CRUD), `ai.server.ts` (tailor with
  anti-hallucination guard, match, cover, prep), `templates.server.ts` (4 styles),
  `pdf.server.ts` (Playwright), `versions.server.ts`, `types.ts`.
- `app/db.server.ts` — jobs, applications/stages, events, board, funnel, source stats, crawl upsert.
- `app/services/` — `crawl.server.ts` (in-process crawl via runner), `scheduler.server.ts` (in-app timer).
- `app/routes/` — pages + resource routes: `api/crawl`, `api/clip`, `version/:vid/resume.pdf`.
- `scripts/` — `run-crawl.ts` (CLI crawl), `os-scheduler.mjs` (cross-platform OS schedule),
  `seed.mjs` + `seed-jobs.json` + `db.mjs` (initial seed), `schema.sql`, `prompt.md` (templated).
- `extension/` — MV3 browser clipper.
- `data/` (gitignored) — `jobs.db`, `pdfs/`, `.master.key`.

## Design System
Always read DESIGN.md before any visual/UI change (Heritage Press: Fraunces / Spectral /
IBM Plex Mono; ink on antique paper; spot red; hard shadows; zero border-radius). Reuse the
shared `Shell`, `Nav`, and the `.panel/.field/.btn/.stat/.badge` primitives in app.css.

## Conventions
- `*.server.ts` = server-only; never import into client components.
- better-sqlite3 is synchronous — fine in loaders/actions.
- Jobs keyed by `company--role` slug (re-crawls upsert, not duplicate).
- User-owned fields (application stage, notes) are NEVER overwritten by a crawl.
- The crawl needs web access; it works best with a CLI runner that has WebSearch (Claude Code).
- Keep `npm run typecheck` green.
