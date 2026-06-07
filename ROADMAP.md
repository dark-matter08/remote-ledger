# Roadmap — The Remote Ledger → a local-first job-application copilot

Goal: an **open-source, plug-and-play, local-first** tool anyone can run on their own
machine to find remote roles, tailor a resume per job with their own AI, generate a
downloadable PDF, apply, and track the whole pipeline — using **either** an existing
AI CLI subscription (Claude Code / Codex / Cursor / Gemini / Ollama) **or** their own
API keys, with full token & cost tracking for the latter.

Privacy is the pitch: **your data and your keys never leave your machine** except the
direct call to the AI provider you chose.

---

## Locked decisions (2026-06-07)

| Area | Decision |
|---|---|
| Scheduler | **Built-in Node scheduler** (runs while app runs, cross-platform) **+ optional OS installer** that generates launchd/systemd/cron from auto-detected paths |
| BYO key storage | **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret) with an **age/libsodium encrypted-file fallback** (passphrase) |
| Resume → PDF | **Headless Chromium (Playwright) + HTML/CSS templates** |
| Base resume format | **Parse uploaded PDF → structured JSON** (sections), raw text retained |

---

## 1. Keystone: the LLM Runner layer

One interface for all AI work (job research, resume tailoring, cover letters, match
analysis). Implementation detail is hidden behind:

```ts
interface LLMRunner {
  id: string;            // "claude-cli" | "anthropic-api" | "ollama" | ...
  detect(): Promise<boolean>;
  run(req: {
    purpose: Purpose;    // job-research | resume-tailor | cover-letter | match | parse-resume
    system?: string;
    prompt: string;
    files?: string[];
    jsonSchema?: object;
    jobId?: string;
  }): Promise<{
    text: string;
    usage: { inTok: number; outTok: number; cachedTok: number; costUsd: number; metered: boolean };
    runner: string; model: string; durationMs: number;
  }>;
}
```

Two families:

- **Agent CLI runners** (shell subprocess, use the user's own subscription / local model):
  `claude -p --output-format json`, `codex exec`, `cursor-agent`, `gemini`, `aider`,
  `ollama run`. Usage parsed when the CLI reports it; otherwise estimated via a
  tokenizer and cost marked `metered:false` ("covered by subscription").
- **Direct API runners** (BYO keys, exact usage): Anthropic, OpenAI, Google,
  OpenRouter, Groq, Mistral, local OpenAI-compatible (Ollama/LM Studio).

Behaviour:
- Auto-detect available runners on first launch (`which …` + configured keys).
- Per-task runner override + a fallback chain (e.g. claude-cli → anthropic-api).
- Adapters are pure and small so new providers are trivial to add.

## 2. BYO keys + token & cost tracking

- **Secrets store**: keychain-backed with encrypted-file fallback. Never written to
  git; only ever sent to the chosen provider.
- **`llm_calls`** table: `id, ts, runner, model, purpose, job_id?, in_tok, out_tok,
  cached_tok, cost_usd, metered, duration_ms, status, error`.
- **`pricing.json`** (in-repo, user-editable): per-model $/Mtok in/out/cache → cost.
- **Usage dashboard**: spend over time, by purpose/model/job; per-run cost shown
  before confirming expensive generations; **monthly budget cap** (soft warn + hard
  stop). Subscription CLI runs show tokens with `$0.00 (subscription)`.

## 3. Resume engine

- **Base profiles**: upload PDF → one-time LLM parse → structured JSON
  (`contact, summary, skills, experience[], projects[], education[]`) + raw text.
  Editable in-app. **Multiple profiles** (e.g. Backend vs DevOps).
- **Tailoring per job**: runner reorders/reweights/rewrites base against the JD.
  **Anti-hallucination guard**: may only use facts present in the base; invented
  claims are flagged and rejected. **Diff view** vs base before accepting.
- **Styles**: HTML/CSS templates — `Letterpress` (matches app), `Modern`, `Compact`,
  **`ATS-plain`** (machine-parseable). Default + per-job override.
- **PDF**: Playwright renders template + data → downloadable, versioned PDF; each
  version links the `llm_call` that produced it.

## 4. Job detail pages (`/jobs/:id`)

Tabs: **Overview · Tailor Resume · Cover Letter · Application · History**
- JD ingestion (paste URL → fetch+extract, or raw text).
- Match & gap analysis + ATS keyword coverage %.
- Tailor / cover-letter generate → preview → edit → download PDF (cost shown).
- Interview prep: likely questions from JD × resume + company brief.

## 5. Application tracking + pipeline

- Stages: `Saved → Tailoring → Applied → Screening → Interview(phone/technical/
  system-design/final) → Offer / Rejected / Withdrawn`.
- **`application_events`** timeline per job + global activity feed.
- **Kanban board** view (drag across stages) beside the broadsheet.
- Reminders (follow-up nudges, interview dates, closing-soon).
- **Funnel analytics**: applied→screen→interview→offer; response-rate by resume
  style/source (A/B).

## 6. Configurations page

Job-search prompt editor · scheduler interval/enable · runner setup + default/
fallback + **BYO key entry** · base-resume upload & profiles · default style · budget.

## Data model (new tables)

`resume_profiles`, `resume_versions`, `applications`, `application_events`,
`llm_calls`, `settings`, `secrets`, `pricing` (+ existing `jobs`, `meta`).

---

## Features that boost appeal (prioritized backlog)

1. ATS-plain mode + ATS score
2. Anti-hallucination guard + resume diff view
3. Kanban pipeline + funnel analytics
4. Browser extension / bookmarklet "send this job to my ledger"
5. Cover letter + outreach (referral DM / recruiter email) generator
6. Local-model support (Ollama) so it's free to run
7. Interview prep + STAR story bank
8. Daily digest + desktop notifications
9. Multiple personas/profiles
10. Skill-gap → learning suggestions
11. One-command setup wizard + Docker
12. Full data export (JSON/CSV) + privacy positioning

Later/heavier: email-inbox parsing to auto-advance stages; ToS-safe semi-automated
form-fill ("we fill, you click submit").

---

## Open-source hardening

- **Remove hardcoded paths** (current launchd plist + `update-jobs.sh` are machine-
  pinned). Built-in Node scheduler by default; optional OS installer generates the
  schedule from detected paths.
- **Generalize the personalization**: location, target stack, and the seed/prompt are
  currently Cameroon/Lucien-specific → drive from the user's profile + Settings.
- First-run **setup wizard**, `.env.example`, **MIT license**, `CONTRIBUTING.md`,
  Docker compose, bundled Chromium for PDF.

## Phases

1. LLM Runner layer + BYO keys + token/cost tracking + Settings page
2. Resume engine (parse, tailor + guard, styles, PDF, diff)
3. Job detail pages + application stages/events/history
4. Kanban + funnel analytics + reminders
5. OSS hardening (cross-platform scheduler, wizard, Docker, license) + clipper extension
