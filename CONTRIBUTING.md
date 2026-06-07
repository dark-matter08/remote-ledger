# Contributing to The Remote Ledger

Thanks for helping! This is a local-first, plug-and-play job-application copilot. The
guiding principles: **your data and keys never leave your machine**, and it should run
with `npm install && npm run dev` on any OS.

## Dev setup

```bash
npm install            # also installs Playwright Chromium (postinstall)
npm run seed           # optional: load starter jobs
npm run dev            # http://localhost:5173
npm run typecheck      # react-router typegen && tsc — keep this green
```

## Architecture (where things live)

- `app/sqlite.server.ts` — single SQLite connection + schema + settings helpers.
- `app/secrets.server.ts` — encrypted BYO-key store (AES-256-GCM, local master key).
- `app/llm/` — the **runner layer**: `types.ts`, `adapters.server.ts` (CLI + API),
  `runner.server.ts` (dispatch, cost, budget, logging), `pricing.server.ts`.
- `app/resume/` — resume engine: `profiles.server.ts` (parse PDF → JSON), `ai.server.ts`
  (tailor + guard, cover, prep, match), `templates.server.ts`, `pdf.server.ts`, `versions.server.ts`.
- `app/db.server.ts` — jobs, applications/stages, events, analytics, crawl upsert.
- `app/services/` — `crawl.server.ts` (in-process crawl), `scheduler.server.ts`.
- `app/routes/` — pages + resource routes (`api/crawl`, `api/clip`, `version/...pdf`).
- `pricing.json` — per-model token prices (edit freely).
- `scripts/` — `run-crawl.ts`, `os-scheduler.mjs`, `seed.mjs`, `schema.sql`, `prompt.md`.

## Adding an LLM provider

Add an adapter in `app/llm/adapters.server.ts` implementing `RunnerAdapter`
(`info()` + `run()`), push it into `ADAPTERS`, and add prices to `pricing.json`.
That's it — it appears in Settings, gets metered, and works everywhere.

## Adding a resume style

Add a template to `CSS`/`RESUME_STYLES` in `app/resume/templates.server.ts`.

## Rules

- Follow `DESIGN.md` (Heritage Press). No new colors/fonts without updating it.
- Keep `npm run typecheck` green.
- Server-only code lives in `*.server.ts`; never import it into client components.
- Don't commit `data/` (DB, PDFs, master key) — it's gitignored.

## PRs

Small, focused PRs. Describe the change and how you verified it (screenshots welcome).
