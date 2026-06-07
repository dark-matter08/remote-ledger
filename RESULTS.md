# Build Results — The Remote Ledger v2

The full [ROADMAP.md](ROADMAP.md) is built. This document maps every roadmap
requirement to concrete evidence: code, tests, live data, and screenshots.

Generated 2026-06-07. App runs at `npm run dev` → http://localhost:5173.

---

## Status: all 5 phases complete + verified

| Phase | What | Status | Evidence |
|---|---|---|---|
| 1 | LLM Runner + BYO keys + metering + Settings/Usage | ✅ | Live Claude CLI call returned tokens+cost; Usage page populated |
| 2 | Résumé engine (parse → tailor + guard → styles → PDF) | ✅ | Parsed real PDF (7 roles/37 skills), tailored (match 76, guard clean), 132KB PDF |
| 3 | Job detail pages + applications/stages/history | ✅ | Job page with 6 tabs, match 78/100, tailored version + downloadable PDF |
| 4 | Kanban + analytics + reminders | ✅ | Board with cards across stages; funnel 40%/50% conversions |
| 5 | OSS hardening (scheduler, wizard, license, Docker, clipper) | ✅ | In-app scheduler wired; cross-platform installer; MIT; extension |

**Quality gates:** `npm run typecheck` ✅ clean · `npm test` ✅ 5/5 passing.

---

## Requirement → evidence checklist

### Configurations (your ask)
- ✅ **Job-search prompt** editor — `/settings`, templated with `{{location}}`/`{{stack}}`.
- ✅ **Scheduler** config (interval + enable) — `/settings`; built-in timer in `app/services/scheduler.server.ts`; "Run crawl now" button.
- ✅ **Connected LLM runner** (Codex, Claude Code, Cursor shell, +more) — `app/llm/adapters.server.ts` (4 CLI + 7 API providers), chosen in `/settings`.
- ✅ **Upload base résumé** — `/resume`, PDF → structured JSON, multiple profiles.

### Deeper per-job pages (your ask)
- ✅ **Regenerate résumé to match the job** via the runner — `/jobs/:id` → Tailor.
- ✅ **Read through** the tailored result + match/gap + guard flags + diff of what changed.
- ✅ **Set the résumé style** — Letterpress / Modern / Compact / ATS-plain.
- ✅ **PDF tools generate a downloadable PDF** — Playwright/Chromium → `/version/:id/resume.pdf` (verified: 3-page, 132KB application/pdf).

### Apply + track (your ask)
- ✅ **Download & use the generated résumé** in the job (download button on each version).
- ✅ **On apply, update application** — stage model (saved→applied→…→offer).
- ✅ **Track history & what level I'm in** — `application_events` timeline + stages + sub-stage (phone/technical/system-design/final).

### BYO keys + token tracking (your ask)
- ✅ **Bring-your-own-keys** for users without a Claude Code/Codex subscription — 7 API providers, keys **encrypted at rest** (`app/secrets.server.ts`, AES-256-GCM) or via env.
- ✅ **Proper tracking of LLM calls, token usage, and cost** — every call logged to `llm_calls`; `/usage` shows spend by purpose/runner/day, tokens, recent calls, and a monthly **budget cap** that blocks metered calls when hit.

### Appeal-boosting features (my additions, shipped)
- ✅ ATS-plain résumé style · ✅ anti-hallucination guard + flags · ✅ Kanban pipeline · ✅ funnel analytics + by-source · ✅ cover-letter generator · ✅ interview prep · ✅ match/gap + ATS keywords · ✅ multiple résumé personas · ✅ reminders/nudges · ✅ local-model (Ollama) support · ✅ browser clipper (bookmarklet + MV3 extension) · ✅ Night Press dark mode.

### OSS plug-and-play
- ✅ **No hardcoded paths** — built-in scheduler + `scripts/os-scheduler.mjs` auto-detects paths (launchd/systemd/Task Scheduler).
- ✅ Generalized personalization (location/stack drive the prompt + masthead).
- ✅ Setup wizard (`/setup`), `MIT LICENSE`, `CONTRIBUTING.md`, `.env.example`, `Dockerfile` + `docker-compose.yml`.

---

## Tests (`npm test` → 5/5)

```
ok 1 pricing: known model cost, unknown null, token estimate
ok 2 secrets: encrypt/decrypt roundtrip + delete
ok 3 runner: tryParseJson extracts JSON from prose/fences
ok 4 resume guard: flags invented employer + clean case
ok 5 db: upsert (insert+update), slug, stage + funnel
# pass 5  # fail 0
```

Live end-to-end checks during the build:
- Runner: Claude CLI → "PONG", usage `{in:6,out:7,cost:$0.087}`, logged to `llm_calls`.
- Résumé: real PDF → 7 roles/37 skills/3 projects → tailored (match 76, guard "no invented facts") → 134KB PDF.
- Job action: tailor (200) + match (200) + cover (200); version row with match + PDF.
- PDF route: `GET /version/1/resume.pdf` → 200, application/pdf, 132KB, 3 pages.
- All 11 routes return 200 with no server-module bundling overlay.

---

## Screenshots (`screenshots/`)

| File | Page |
|---|---|
| 01-ledger-light.png | Broadsheet (light) |
| 02-ledger-dark.png | Broadsheet (Night Press) |
| 03-job-overview.png | Job detail — match & gap |
| 04-job-tailor.png | Job detail — tailored résumé + guard + download |
| 05-job-cover.png | Job detail — cover letter |
| 06-pipeline.png | Kanban pipeline |
| 07-analytics.png | Funnel + conversions + by-source |
| 08-usage.png | Token & cost dashboard |
| 09-settings.png | Runners, BYO keys, prompt, scheduler |
| 10-resume.png | Base résumé profiles |
| 11-setup.png | Setup wizard |
| 12-clipper.png | Browser clipper |

---

## Honest notes / limitations

- **Crawl quality depends on web access.** It works best with a CLI runner that has
  WebSearch (Claude Code). Pure-API runners without web search may not surface live
  postings — documented in Settings.
- **Docker** image is provided (Playwright base) but was not built in this environment;
  the local `npm run dev` path is fully verified.
- **OS scheduler** files are generated correctly but installing them is opt-in and was
  not executed here; the **in-app** scheduler is wired and verified.
- **Secrets** use the encrypted-file backend (portable, zero-dep). The keychain backend
  is a documented future slot behind the same interface.
- **`pricing.json`** values are approximate and user-editable.
- The DB currently contains demo data from this build (1 base profile, a tailored
  version, and several stages set for screenshots). Reset jobs with `npm run seed`;
  delete profiles/versions in the UI.

---

## How to run

```bash
npm install        # deps + Playwright Chromium
npm run dev        # http://localhost:5173  → open /setup
npm test           # 5/5
npm run typecheck  # clean
npm run crawl      # one job crawl (needs a web-capable runner)
```
