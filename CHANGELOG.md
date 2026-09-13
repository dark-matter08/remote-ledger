# Changelog

What changed, in the order it changed, written for the person using the app rather than
the person who wrote it.

This file is the source the landing page reads, so a release and its notes live in the
same repository and land in the same pull request. A version cannot ship without them.

---

## v0.2.1 — a score you can check, prep for every round, and Windows that finds your agent

**A match score you can check.** Match used to hand back one number with nothing
behind it — 82 for one posting, 68 for another, and no way to say what the difference
meant. It now scores five things separately (the must-have skills, seniority, domain,
eligibility, nice-to-haves), quotes the posting for each, and adds them up in code. You
can see why it is 62 rather than being told that it is.

**A minimum that can act on it.** Settings → Scheduler takes a minimum match score.
Autopilot checks it right after the match and before the three steps that cost money;
below the line it stops, keeps the match, and offers *Apply anyway*. Turn on advise mode
first and it tells you what it *would* have stopped for a week before it stops anything.

**Applying in batches.** The Auto-Apply page can run autopilot over a selection, applying
the minimum to each posting and collecting the ones it skipped for you to force one by
one — and it says what the batch will cost before it starts, priced from this machine's
own past calls.

**Interview prep, one session per round.** There was one prep per job, and preparing for
the technical round overwrote the screening one. Each round is its own session now:
name it, say what you know, and drop in screenshots of the invite, the recruiter's
thread or a colleague's account — up to ten. They are read by a runner that can look at
a picture, and the prep opens with what it read so you can check it against the
original. The questions come with answers, drawn from your knowledge base and citing
the entry each one comes from; where the base has nothing, the prep says so and tells
you what to prepare, rather than inventing an experience.

**Autopilot shows its work.** Starting it used to freeze the button for ten minutes while
a browser opened on its own with nothing on screen to explain it. It now returns at
once, ticks off each step as it lands, and can be stopped; close the tab and it keeps
going, and picks the watch back up when you return.

### Fixed

- **On Windows, Claude Code was installed and the Ledger said it was not.** Three faults
  from a Unix-shaped runner layer — PATH joined with the wrong separator, a search that
  needed Git Bash, and no way to run npm's `.cmd` shim. Agents are now found where their
  installers put them. The wizard also stopped telling Windows users to run `npm` (the
  app's own Node is private to it): it gives `winget install Anthropic.ClaudeCode` and
  the other vendors' installers instead, per platform.
- **The quick filters above the board** were three hardcoded engineering categories,
  whoever you were. They are now built from your own keywords, counted against the
  postings on screen.
- **Job boards read "never checked"** while the crawl log showed them being mined; only
  feed-backed companies were ever marked. Every source records that it was read, and the
  table tells "never" from "checked, found nothing".
- **The job page forgot its tab** on reload; it is in the address bar now, like Settings.
- **A tab left open across an update** kept running old code — its buttons did nothing.
  It now notices the new build, says so in the rail, and reloads on its next move.
- **Model-written text** (the prep, cover letters) showed raw `##` and `**`; it is typeset.
- **OpenRouter** now says the provider's own words instead of "Provider returned error",
  keeps a picture-capable model in the fallback chain when a screenshot is attached, and
  moves on when a reasoning model spends its whole budget thinking and writes nothing.

---

## v0.2.0 — more than one search, and a button that does the whole application

**Job profiles.** One search per line of work. If you are applying as an engineer *and*
as a designer, you no longer have to throw one away to look for the other. A profile
keeps its own field, location and skills, its own job boards and tracked companies, its
own résumés, its own application mail and apply history, and its own copies of the
postings it finds. Each runs on its own schedule and gets the whole crawl budget — two
searches cost two crawls, which is the honest price of looking for two things.

Your knowledge base stays shared, on purpose: it records what you have actually done,
and that does not change because you are chasing a different kind of role. What each
profile chooses is which parts of it to build résumés from.

**Autopilot.** One button on the Guided Application tab runs the whole thing — match,
build from your knowledge base, tailor the résumé, write the cover letter, read the
application form, draft its questions. Anything you already did by hand is skipped
rather than paid for twice, and if a step fails the run stops there and picks up from it
next time.

It stops before submitting, and always will. When it finishes you choose: open the form
and fill it yourself, or open it prefilled with what the app is sure of.

**Moving to another machine.** Settings → Data writes everything you have collected to
one file, and reads it back on the other side. Your API keys and email passwords are not
in it — not filtered out on the way, never read at all — and the file says what it left
behind so the new machine tells you what to re-enter. Backups also became configurable:
how often, how many to keep, where they go, and optionally a folder to drop a portable
export into on the same schedule.

### Fixed

- **A job you had already applied to kept coming back as new.** Two links to the same
  Consensys posting — one with `?gh_jid=` repeating the id already in the path — counted
  as two different jobs. Five duplicate postings were merged on this install, keeping the
  row that carried the application.
- **A company's acknowledgement now moves you to screening**, and is no longer lost when
  the mail is scanned before you mark the job applied. Held mail is re-read against jobs
  applied since the last scan.
- **The knowledge base page** was twelve screens tall with every entry open. Entries fold
  now: four screens, nothing removed.
- Switching profile tabs in Settings keeps its place in the address bar, so a link can
  open one directly.

---

## v0.1.x — the installer

Everything before this went into making the Ledger installable by someone who does not
use a terminal: one binary per operating system that fetches its own Node, clones the
app, sets up an https address, starts it, and brings it back after a reboot.

That took fourteen releases, most of them fixing things only a real Windows machine would
reveal — a console window flashing on screen every twelve seconds, an update that pulled
and rebuilt but never restarted, a permission prompt raised at login where nobody could
answer it. The Linux and macOS builds arrived alongside, and the certificate for the
local https address is now trusted by the browser rather than only by the system.
