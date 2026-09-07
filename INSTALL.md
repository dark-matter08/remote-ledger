# Installing The Remote Ledger

> The one-click installer described here is **planned, not built**. Until it ships,
> use *The long way* at the bottom — it works today.

The Ledger runs entirely on your own machine. Nothing here sends your résumé,
your salary history or your notes anywhere except the AI provider you choose.

---

## The short way

Download the file for your computer, open it, and answer the questions.

| Your computer | File |
|---|---|
| Mac (any, 2016 onwards) | `remote-ledger-macos` |
| Windows | `remote-ledger-windows.exe` |
| Linux | `remote-ledger-linux` |

It takes **5 to 15 minutes** and downloads about **1 GB**. Most of that is a browser
engine the Ledger uses to read job postings for you. You can leave it running and
come back.

When it finishes, your browser opens on a six-step setup that asks what work you are
looking for and which AI you want to use.

### "macOS cannot open this because it is from an unidentified developer"

Expected. The installer is not signed yet — code signing costs money per year and
this is a free, open project. The file is exactly what is published on GitHub, and
you can check that yourself against `SHA256SUMS` in the release.

To open it anyway: **right-click the file → Open → Open**. You only do this once.

*Not* a double-click. macOS deliberately only offers the "open anyway" button on the
right-click menu.

### "Windows protected your PC"

Same reason. Click **More info**, then **Run anyway**.

### If you would rather not click through a warning

Fair. Use a package manager, where the trust is handled for you:

```bash
# macOS
brew install dark-matter08/tap/remote-ledger

# Windows
scoop bucket add dark-matter08 https://github.com/dark-matter08/scoop-bucket
scoop install remote-ledger

# Linux
curl -fsSL https://remoteledger.dev/install.sh | sh
```

---

## What the installer actually does

No surprises, in this order:

1. Checks your operating system, free disk space and network
2. Installs **git** if you do not have it (a standard prompt from Apple or Microsoft)
3. Downloads its **own private copy of Node.js** into `~/.remote-ledger/runtime` —
   it does not touch any Node you already have, and needs no admin password
4. Downloads the Ledger itself into `~/.remote-ledger/app`
5. Runs the Ledger's own setup, which installs its dependencies and a browser engine
   for reading job pages, builds it, and sets it to start when you log in
6. Works out your default browser and sets up the apply flow to match
7. Opens the Ledger

Step 5 is the long one, and it prints what it is doing as it goes.

Everything lives under `~/.remote-ledger`. Deleting that folder removes the Ledger
completely.

## About your browser

The Ledger can fill in job applications for you, which means driving a real browser.

**Chrome, Edge, Brave, Vivaldi or Opera** — this works fully. It opens a tab in a
browser you stay logged into, so applications are filled in as you.

**Firefox** — Firefox cannot be driven this way. Mozilla removed the interface that
makes it possible, so this is not something we can fix. The installer will notice
and offer you three choices:

1. **Keep Firefox.** Job pages open in Firefox and the Ledger shows you the answers
   to paste. Nothing gets installed, nothing is automated.
2. **Use a separate automated Firefox.** Applications are filled in automatically,
   but in a fresh profile — you will sign in to each job board again.
3. **Install Chrome or Edge** for the apply flow only, and keep Firefox for
   everything else.

None of these is wrong; it depends on whether you would rather not install another
browser, or would rather not type your answers.

## Requirements

- macOS 12+, Windows 10+, or a Linux desktop from the last few years
- About **2 GB** of free disk space
- An internet connection for the install
- An AI provider — the setup wizard walks you through the options, including
  several that cost nothing

You do **not** need Node.js, npm, or any developer tooling. The installer brings
its own.

---

## The long way

Works today, if you are comfortable in a terminal.

```bash
git clone https://github.com/dark-matter08/remote-ledger.git
cd remote-ledger
npm install          # ~665 MB, and pulls a Chromium build
npm run build
npm run serve enable # start it at login
```

Then open `http://localhost:5173`.

**Node 22.5 or newer is required** — the Ledger uses Node's built-in SQLite, which
does not exist in earlier versions. `node --version` to check. Note that the Node
in most Linux distributions' repositories is older than this.

For a real hostname and HTTPS instead of `localhost:5173`, see
[dropport](https://github.com/dark-matter08/dropport):

```bash
npm install -g dropport
dropport add remoteledger 5173      # -> remoteledger.dp.local
dropport up
```
