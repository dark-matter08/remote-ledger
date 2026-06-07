# Design System — The Remote Ledger

## Product Context
- **What this is:** A personal, local-first job-hunt tracker. It crawls remote + Cameroon-eligible engineering roles every 4 hours into a local SQLite DB and renders them as a living broadsheet you work through (apply, mark status, filter, sort).
- **Who it's for:** Nde Che Lucien — a Yaoundé-based fullstack + infrastructure engineer (TypeScript/Node/NestJS/React/React Native, Docker/Terraform/CI-CD, Python, AI/LLM).
- **Space/industry:** Personal productivity / job search dashboard.
- **Project type:** Local web app (React Router 7 framework mode, SSR, SQLite).
- **Memorable thing:** "My job hunt, printed like a newspaper." The hunt should feel like a hand-set classified ledger you can't wait to read the next edition of.

## Aesthetic Direction
- **Direction:** Heritage letterpress / editorial broadsheet — 19th-century printing house rendered crisp and modern.
- **Decoration level:** Intentional → expressive. Paper grain, hairline + double rules, fleurons (❦), drop caps, registration/crop marks in the page corners, spot-color red. Decoration serves the metaphor; it never blocks scanning data.
- **Mood:** Tactile, authored, deliberate. Ink on warm paper. Two-color press (black + one spot red). Quiet confidence, not loud SaaS.
- **Reference feel:** old newspaper mastheads, letterpress classifieds, printer's proofs with crop marks, rubber-stamp office workflow.

## Typography
- **Display/Masthead:** **Fraunces** (variable, optical-size + weight axes) — high contrast, reads like cut metal type. Weights 400/600/900, italic for accents.
- **Body/editorial:** **Spectral** — screen-tuned heritage serif. 400/500/600 + italic for role titles.
- **UI/Labels/Data/Meters:** **IBM Plex Mono** — the ledger/typewriter voice. Used for all numbers, fine-print, labels, toolbar, status. Small-caps via `text-transform:uppercase` + `letter-spacing`.
- **Code:** IBM Plex Mono (same).
- **Loading:** Google Fonts (`Fraunces`, `Spectral`, `IBM+Plex+Mono`). Self-host later if going offline.
- **Scale (px):** display clamp(46–108); h2 26; h3 (entry) 21; body 17; role 16; fine 10.5; label 11.
- **CSS vars:** `--display`, `--serif`, `--mono`.

## Color
- **Approach:** Restrained two-color press. Black ink + one spot red carry the system; category coding adds two earth tones used sparingly as accents only.
- **Paper:** `#EFE6D2` (ground), `#E7DCC4` (paper-2), `#F4ECDA` (card/hover).
- **Ink:** `#1A1714` (warm near-black), `#473F36` (soft), `#7A6E5E` (faint).
- **Spot red — Pressman's Vermillion:** `#B23A2E` — masthead accent, rules of emphasis, high-priority, stamps, the live crawl dot.
- **Category coding:** High = Vermillion `#B23A2E`; Medium = Ledger Green `#3E5641`; Stretch = Sepia Ochre `#8A6D3B`.
- **Status coding:** to-apply = ink-faint; applied = green; interviewing = ochre; offer = vermillion; passed = ink-faint + strikethrough.
- **Rules:** `--rule:#1A1714`, `--rule-faint:#C8BBA0`.
- **Semantic:** success `#3E5641`, warning `#8A6D3B`, error/info-emphasis `#B23A2E`.
- **Dark mode ("Press at Night"):** invert ground to deep ink `#17120E`/`#1E1813`, type to cream `#EFE6D2`, desaturate spots (vermillion `#D7584B`, green `#7FA07F`, ochre `#C5A35E`). Toggle via `data-theme="night"` on `<html>`.

## Spacing
- **Base unit:** 8px.
- **Density:** comfortable-editorial. Entries breathe; toolbar is compact.
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).

## Layout
- **Approach:** Editorial broadsheet. Centered sheet, max width ~1080px, generous side margins, fixed crop marks at the four page corners.
- **Structure:** Masthead (eyebrow → big title → double rule → dateline with live crawl timestamp → double rule) ▸ fleuron ▸ toolbar (filter chips + sort, mono small-caps) ▸ three sections (High / Medium / Stretch) each with a section-head (title + type tag + count) ▸ a 2-column ledger of entries.
- **Entry (the classified card):** left category accent bar; № index; company in display; role in italic; ink-fill fit meter + `NN/100`; mono uppercase fine-print (stack + eligibility); actions row (stamp Apply button + custom status dropdown); optional HOT OFF THE PRESS stamp (new since last crawl) and a faint status stamp overlay.
- **Grid:** ledger `1fr 1fr` desktop, single column ≤720px. Rules between cells (right + bottom borders).
- **Border radius:** 0 everywhere. Letterpress has no rounded corners. Hard offset shadows only (`14px 16px 0 -6px`), never soft blurs.

## Motion
- **Approach:** Intentional, mechanical — motion mimics ink and stamping, not bouncy UI.
- **Easing:** enter `cubic-bezier(.2,.8,.2,1)`; press `ease`; default `ease`.
- **Duration:** micro 80–120ms (press/caret), short 150–250ms (hover/menu), meters 1.1s ink-fill.
- **Signature interactions:**
  - Fit meters fill like spreading ink on scroll-into-view (IntersectionObserver).
  - Entries lift `translateY(-3px)` + hard shadow on hover.
  - Apply button presses down (`active` collapses its vermillion offset shadow).
  - Status change slams a faint red rubber stamp onto the entry.
  - Custom dropdown: caret flips, menu drops with hard shadow; the open entry lifts above siblings (`z-index`).
  - Live crawl dot blinks; FLIP-animated re-sort.
- **Respect** `prefers-reduced-motion`: disable meter animation + stamps, keep instant states.

## Component Notes
- **Custom status dropdown (no native `<select>`):** render a custom typeset menu over a hidden `<select>` (data source + a11y). Trigger = mono small-caps + status dot + flipping caret; inverts ink-on-paper when open. Menu = paper panel, hard shadow, hairline-ruled rows, hover inverts row, ✓ on selected. Close on outside-click / Esc; one open at a time.
- **Buttons:** "stamp" style — ink fill, paper text, hard vermillion offset shadow that collapses on press. No gradients.
- **Stamps:** double-border boxes rotated a few degrees, vermillion, low opacity for overlays.

## Anti-slop guardrails (do NOT do)
- No rounded corners, no soft drop shadows, no purple/violet, no gradients, no icon-in-circle grids, no centered-everything SaaS hero, no system-ui/Inter as display or body.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-07 | Heritage Press system created | /design-consultation; user approved after live HTML preview + custom-dropdown fix |
| 2026-06-07 | Custom dropdown over native select | Native select broke the letterpress aesthetic (OS font/arrow); custom menu keeps the press voice, hidden select keeps a11y |
