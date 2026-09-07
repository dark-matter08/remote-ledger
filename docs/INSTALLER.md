# The one-click installer

A single downloadable file that takes someone from nothing to a running Ledger,
with no terminal, no Node, and no idea what a package manager is.

Status: **plan**. Nothing here is built yet.

## What it has to overcome

The Ledger is not hard to install if you already live in a terminal. For everyone
else the current path is six steps and three prerequisites, any of which ends the
attempt. Measured on a working install:

| | |
|---|---|
| Node required | **≥ 22.5** — the app uses `node:sqlite`, which does not exist before that |
| Dependencies | **665 MB** in `node_modules` |
| Playwright Chromium | a further ~150 MB, pulled by `postinstall` |
| Total first run | roughly **900 MB and 5–15 minutes** |

Two of those are worse than they look. Distro Node is usually far older than 22.5,
so "install Node" through `apt` produces an app that crashes on first query. And
900 MB with no progress indicator reads as a hang.

## Why a Go binary

The installer runs on a machine with **no runtime installed** — that is the whole
premise — so it cannot be written in the language it is about to install. Go
cross-compiles to static binaries from one machine, needs nothing at runtime, and
its standard library already covers everything required here: `net/http`,
`archive/tar`, `archive/zip`, `compress/gzip`, `os/exec`.

Rejected: **Bun/Deno `compile`** ship a 60–100 MB JavaScript runtime in order to
install a JavaScript runtime. **Node SEA** needs a Node binary per target, which is
the problem restated. **Shell + PowerShell** is not a file you can double-click.

Expected size: ~6 MB per binary.

## Three files

| File | Target | Built with |
|---|---|---|
| `remote-ledger-macos` | Intel + Apple Silicon | two builds joined with `lipo -create` |
| `remote-ledger-windows.exe` | x86-64 | `GOOS=windows GOARCH=amd64` |
| `remote-ledger-linux` | x86-64 | `GOOS=linux GOARCH=amd64` |

A universal macOS binary is what keeps this to three files rather than five. Linux
arm64 is a fourth build if anyone asks; desktop Linux on arm is rare enough to wait
for a request.

## Most of this already exists

`scripts/ledger.mjs` is already the non-technical path, and its own header says the
thing this plan should obey: *"This orchestrates; it does not reimplement."*

`npm run ledger start` today installs dependencies (choosing pnpm or npm by what it
finds), installs Caddy, installs and configures dropport for a real HTTPS hostname,
builds, starts the app detached, and registers it to come back at login.

So the binary is **not** an installer for the Ledger. It is a bootstrap for the four
things `ledger.mjs` cannot do for itself, because they are what it is written in:

- get **git** onto the machine
- get **Node ≥ 22.5** onto the machine, without touching the system
- get the **source** onto the machine
- then run `npm run ledger start` and stay out of the way

Everything after that is already written, already tested, and already the path an
existing user takes. Re-implementing it in Go would mean two things to keep in step,
and the Go one would be the one nobody runs.

## What gets installed, and what is optional

One screen of checkboxes, before anything downloads. Sensible defaults, so the
answer to all of it is Enter.

| | Component | Default | Cost |
|---|---|---|---|
| ☑ | **The Ledger** | required | ~900 MB |
| ☑ | **dropport** — a real address, `https://remoteledger.dp.local`, instead of `localhost:5173` | **on** | Caddy, plus three password prompts |
| ☐ | **Local AI** — Ollama and a model, so the whole thing runs free on this machine | off | 2–8 GB depending on the model |

**dropport is on by default** because `ledger.mjs` already installs and configures it
as part of `npm run ledger start`, and because a memorable HTTPS address is the
difference between an app someone returns to and a port number they forget. It needs
Caddy and three sudo prompts, which is the reason it stays a choice rather than an
assumption. Turning it off is not a degraded install — the app runs identically, just
at `localhost:5173`.

Making it *optional* is the new part: `ledger.mjs` currently always attempts it, and
only skips when Caddy or dropport cannot be installed. It needs a switch —
`LEDGER_SKIP_PROXY=1`, checked at the top of `setupDropport()`.

**Local AI is off by default**, and that is a judgement worth challenging. Ollama
plus a usable model is 2–8 GB on top of an install that is already ~900 MB, and the
`/setup` wizard offers free hosted options that cost nothing and download nothing. So
the default optimises for finishing the install. The checkbox is there because for
someone who wants nothing leaving their machine, this is the only answer — and
Settings → Local can do it later, at a moment when a 5 GB download is expected.

Everything else about AI stays with the `/setup` wizard, which asks the right
questions and proves each answer with a live call. The installer does not compete
with it.

## What it does, in order

Every phase is idempotent. Re-running the installer on a working install repairs it
rather than duplicating it.

**1 · Preflight.** OS, architecture, ≥ 2 GB free disk, reachable network. Refuse
early and say which one failed, rather than dying 700 MB in.

**2 · git.** Needed because the app's own updater shells out to it (`git rev-parse`,
`git fetch`, `git rev-list` in `app/services/updates.server.ts`) — a tarball install
would silently break in-app updates. If git is missing:

- macOS — `xcode-select --install`, which is a GUI prompt the user can accept
- Windows — `winget install --id Git.Git -e`
- Linux — the distro's command, printed, since we will not assume a package manager

**3 · Node, vendored.** Download the official build for the platform, verify it
against `SHASUMS256.txt` from nodejs.org, extract to `~/.remote-ledger/runtime/`.

Vendoring rather than installing system-wide is deliberate: no admin rights, no
collision with a Node the user already depends on, and it sidesteps the distro
problem entirely. Everything afterwards runs through this interpreter by absolute
path — never `node` from `PATH`.

> That last point is not theoretical. On the development machine, `which python3`
> resolves into an unrelated project's virtualenv. The same class of accident with
> Node would install the Ledger's dependencies into somebody else's project.

**4 · Source.** `git clone --depth 1` into `~/.remote-ledger/app`, or a directory
the user picks. A shallow clone still supports `git fetch`, so the updater works.

**5 · Hand off.** `npm run ledger start`, through the vendored Node, in the cloned
directory. That single command covers dependencies, Caddy, dropport, the build, the
background service and login-start — all of it code that already exists and that
existing users already run.

The installer streams its output rather than hiding it. This is the phase that takes
ten minutes, and silence reads as failure.

**6 · Windows.** `ledger.mjs` delegates login-start to `serve.mjs`, which has no
Windows implementation — it prints "Windows has no equivalent here" and exits 1.
Until that is filled in, the Windows binary installs and launches, but the app will
not come back after a reboot. That is app work, not installer work, and it is the
one place where the three platforms are not equal.

**6b · dropport**, if chosen. Already inside `npm run ledger start`; the installer
only passes the choice through. Caddy is installed first, and the three password
prompts are announced before they appear.

**7 · Browser.** Below.

**8 · Open.** Launch the app and open `http://localhost:5173/setup`, handing off to
the six-step wizard that already exists. The installer does not ask about AI
providers, job boards or résumés — that is the wizard's job and it does it better.

## The browser decision tree

Auto-apply drives a browser over the **Chrome DevTools Protocol**. Edge, Brave,
Vivaldi and Opera are Chromium underneath, so they work today. **Firefox does not
speak CDP** — Mozilla removed its partial implementation in favour of WebDriver BiDi.
No amount of work on our side changes that.

So the installer detects the default browser and branches:

```
default browser?
├── Chromium family  →  attach mode. Full auto-apply, your logins, your profile.
│                        Sets apply_browser=attach and starts the debug profile.
│
├── Firefox          →  ask, because all three answers are legitimate:
│      1. Keep Firefox.  Pages open in Firefox; the app fills from its own copy.
│                        No automation. Nothing to install.            [NEW MODE]
│      2. Playwright's Firefox. Real automation, but a blank profile —
│                        you sign in to every board again.             [NEW MODE]
│      3. Install Chrome or Edge for the apply flow only, and keep
│                        Firefox as your everyday browser.
│
└── none / unknown   →  offer to install Chrome, else fall back to option 1.
```

Detection, per OS:

- macOS — the `http` handler in `com.apple.launchservices.secure.plist`
- Windows — `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice\ProgId`
- Linux — `xdg-settings get default-web-browser`

**Options 1 and 2 do not exist in the app.** `apply_browser` understands exactly two
values today, `playwright` and `attach`. Both new modes are application work that
has to land before the installer can offer them.

## Distribution and trust

Unsigned binaries *and* package managers, so there is a route for people who will
click through a warning and a route for people who will not.

**GitHub Releases** — the three files plus `SHA256SUMS`.

macOS shows *"cannot be opened because it is from an unidentified developer"*.
Windows shows a SmartScreen interstitial. Both are documented in `INSTALL.md`, and
both are the exact moment a non-technical user gives up — which is the argument for
the second route.

**Package managers**, where trust is already solved. None of these is published yet —
they are the plan, not a route anyone can take today:

- macOS — a Homebrew tap: `brew install dark-matter08/tap/remote-ledger`
- Windows — a Scoop bucket first (a manifest in our own repo), winget later
  (its manifest lives in a Microsoft-owned repo and needs a PR per release)
- Linux — `curl -fsSL https://remoteledger.dev/install.sh | sh`

Signing is deferred, not dismissed. The release pipeline should be built so an Apple
Developer ID ($99/yr) and a Windows certificate can be slotted in without rework —
sign the same artifacts, publish the same way.

## Failure modes worth designing for

**It looks like a hang.** 900 MB across four downloads. Needs a real progress bar
with bytes and phase names, not a spinner.

**Antivirus.** An unsigned binary that downloads executables and runs them is a
textbook heuristic match. Expect Windows Defender false positives; another argument
for Scoop.

**Corporate machines.** Proxies, blocked GitHub, no admin. Detect and fail with a
clear message rather than retrying into a timeout.

**A half-finished install.** Every phase writes a marker; a re-run resumes rather
than starting over. `installed.json` records what completed and which versions.

**Disk.** Refuse below 2 GB free, and say what it needs.

## What it deliberately does not do

- **It does not choose an AI provider.** The `/setup` wizard already asks, and proves
  each answer with a live call before it lets you past. A second, worse version of
  that conversation in a terminal helps nobody.
- **It does not install anything system-wide, and never asks for admin** — except for
  dropport, which genuinely needs it to bind ports 80 and 443 and to trust a local
  certificate authority. That is announced, and it is the reason dropport is a
  checkbox rather than a step.
- **It does not manage dropport after installing it.** `dropport` is its own tool with
  its own commands; the installer sets it up once and gets out of the way.

## Building it locally

```bash
go test ./cmd/...        # unit tests for the pure logic
go build ./cmd/installer # a binary for this machine
```

**Go 1.22 does not work on current macOS.** Its internal linker emits binaries with
no `LC_UUID`, and the system refuses to run them — including the test binary, so
`go test` aborts before running a single test. Either use a current Go, or pass
`-ldflags=-linkmode=external`. CI uses `stable` for the same reason, and that matters
most for releases: the macOS artifacts are built there, and 1.22 would ship a binary
that cannot start on the machines it is meant for.

### macOS will kill an unsigned binary

Three separate things, found by running the thing rather than reasoning about it:

| build | what macOS 26 does |
|---|---|
| Go 1.22, internal linker | no `LC_UUID` — dyld refuses to load it |
| external linker | loads, then **SIGKILL** — the signature is rejected |
| external linker + `codesign -s -` | runs |

So the release must ad-hoc sign, **after** `lipo`, which discards its inputs'
signatures. Skip it and the download is killed on launch with no message at all —
indistinguishable, to the person who downloaded it, from us shipping a broken file.

Ad-hoc signing is not notarization. It makes the binary runnable; Gatekeeper still
shows "unidentified developer" the first time, which is the warning `INSTALL.md`
walks through. Two different problems that look similar.

## Open questions, before any code

1. **Two lockfiles.** `package-lock.json` and `pnpm-lock.yaml` are both committed with
   no `packageManager` field. `ledger.mjs` resolves this at runtime — pnpm if its
   lockfile is present *and* pnpm is installed, otherwise npm — so nothing is broken.
   But it means two machines can resolve different dependency trees from the same
   commit, which is worth closing regardless of this plan.
2. **Windows autostart** does not exist in `serve.mjs`. Scheduled Task or a Startup
   shortcut. Without it the Windows binary is a second-class install.
3. **The two Firefox apply modes** are application work, not installer work.
4. **Updating the installer itself** — re-download, or teach it to self-update? The
   app already updates itself through git, so this only matters for the bootstrap.
5. **`LEDGER_SKIP_PROXY`** does not exist. `setupDropport()` always runs and only
   skips when Caddy or dropport cannot be installed — there is no way to decline it.
   Small, but it is what makes the dropport checkbox real rather than decorative.

## Milestones

| | |
|---|---|
| 0 | ~~`LEDGER_SKIP_PROXY` in `ledger.mjs`~~ — done. |
| 1 | ~~Go skeleton: component screen → preflight → git → vendored Node → clone → `ledger start` → open~~ — done, and it cross-compiles to all four targets rather than macOS only. Not yet run end to end on a clean machine. |
| 2 | Run it on a clean machine and fix what that finds. Windows still needs milestone 5 to be a fair comparison. |
| 3 | Resume-a-failed-install markers, and a progress display worth looking at for ten minutes. |
| 4 | Browser detection and the Chromium branch. Firefox gets option 3 (install Chrome) for free, since it needs no app changes. |
| 5 | Windows autostart in `serve.mjs`. Unblocks a real Windows release. |
| 6 | The two new Firefox apply modes in the app, then the rest of the tree. |
| 7 | ~~Release pipeline: 3 artifacts, checksums~~ — done, untested until the first tag. Homebrew tap and Scoop bucket still to do. |
| 8 | The Local AI checkbox — drive the Ollama install the Settings tab already does. |
| — | Pin one lockfile. Independent of all of the above; do it whenever. |
