# Changelog

What changed, in the order it changed, written for the person using the app rather than
the person who wrote it.

This file is the source the landing page reads, so a release and its notes live in the
same repository and land in the same pull request. A version cannot ship without them.

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
