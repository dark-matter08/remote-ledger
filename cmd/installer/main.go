// The Remote Ledger, installed in one run, for someone who does not own a terminal.
//
// This is a bootstrap, not an installer. scripts/ledger.mjs already installs the
// dependencies, Caddy and dropport, builds the app, starts it and registers it to
// come back at login — and it is the command existing users already run. So this
// binary does only the four things ledger.mjs cannot do for itself, because they are
// what it is written in: git, a private Node, the source, and then hand over.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

var version = "dev" // set by the release workflow

// Where the app ends up depends on whether the proxy came up, and only the setup
// itself knows — so it writes the answer down rather than us guessing.
const fallbackURL = "http://localhost:5173"

func homeDir() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return h
}

type choices struct {
	proxy   bool // dropport: a real https address instead of a port
	localAI bool // ollama, later: the app can do this from Settings
}

func main() {
	ui := NewUI()
	for _, a := range os.Args[1:] {
		if a == "--version" || a == "-v" {
			fmt.Printf("remote-ledger installer %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
			ui.HoldOpen()
			return
		}
	}

	ui.Title("The Remote Ledger")
	ui.Say("A job-application copilot that runs entirely on your own machine.")
	ui.Say("This sets it up. It downloads about 900 MB and takes 5 to 15 minutes.")

	root := filepath.Join(homeDir(), ".remote-ledger")
	appDir := filepath.Join(root, "app")
	runtimeDir := filepath.Join(root, "runtime")

	pick := ask(ui)

	// ---- preflight ---------------------------------------------------------
	ui.Title("Checking this computer")
	ui.Done("%s on %s", runtime.GOOS, runtime.GOARCH)

	if err := os.MkdirAll(root, 0o755); err != nil {
		ui.Fail("Cannot create "+root, err, "Check the permissions on your home folder.")
	}
	if free := freeDiskBytes(root); free > 0 {
		if free < 2<<30 {
			ui.Fail(
				fmt.Sprintf("Not enough disk space — %s free, and this needs about 2 GB", bytes(int64(free))),
				nil, "Free some space and run this again.")
		}
		ui.Done("%s free", bytes(int64(free)))
	}

	if err := ensureGit(ui); err != nil {
		ui.Fail("git is needed and is not installed", err,
			"The Ledger updates itself with git, so it is not optional. Install it, then run this again.")
	}

	// ---- node --------------------------------------------------------------
	ui.Title("Node")
	ui.Say("A private copy, used only by the Ledger. Nothing you already have changes.")
	nodeExe, err := installNode(runtimeDir, ui)
	if err != nil {
		ui.Fail("Could not set up Node", err, "Check your internet connection and run this again.")
	}
	ui.Done("Node ready")

	// ---- source ------------------------------------------------------------
	ui.Title("The app")
	if err := cloneOrUpdate(appDir, ui); err != nil {
		ui.Fail("Could not download the app", err,
			"If you are behind a company network, it may be blocking github.com.")
	}
	ui.Done("In %s", appDir)

	// ---- hand off to the project's own setup -------------------------------
	ui.Title("Installing")
	if err := handOff(appDir, nodeExe, pick.proxy, ui); err != nil {
		ui.Fail("The setup did not finish", err,
			"Run it again — it carries on from where it stopped rather than starting over.")
	}

	// ---- browser -----------------------------------------------------------
	ui.Title("Your browser")
	configureBrowser(ui)

	if pick.localAI {
		ui.Title("Local AI")
		ui.Say("Open Settings → Local once the app starts. It installs Ollama and a model")
		ui.Say("from there, with a progress bar and a size for each one before you commit.")
	}

	// ---- done --------------------------------------------------------------
	ui.Title("Ready")
	ui.Say("The Ledger is running, and starts again every time you log in.")
	ui.Say("")
	addr := finalAddress(appDir)
	ui.Say("Opening %s — the first screen asks what work you are looking for.", addr)
	openURL(addr)
	fmt.Println()
	ui.HoldOpen()
}

// ask presents the component screen. Defaults are chosen so that pressing Enter
// through the whole thing is a reasonable install.
func ask(ui *UI) choices {
	ui.Title("What to install")
	c := choices{proxy: true}

	ui.Say("A real web address — https://remoteledger.dp.local instead of a port number.")
	if runtime.GOOS == "windows" {
		ui.Say("Windows will ask for administrator access once, for the hosts file.")
	} else {
		ui.Say("Asks for your password a few times while setting it up.")
	}
	c.proxy = ui.Ask("Set that up?", true)

	fmt.Println()
	ui.Say("Local AI — runs the AI on this machine, free, nothing leaves it.")
	ui.Say("Downloads a further 2-8 GB. You can also do this later from Settings.")
	c.localAI = ui.Ask("Set that up too?", false)

	return c
}

// configureBrowser works out what auto-apply can drive here.
//
// Auto-apply drives a browser over the Chrome DevTools Protocol. Edge, Brave, Vivaldi
// and Opera are Chromium underneath and work today. Firefox removed its CDP support,
// so this is a protocol wall rather than a missing feature — which is why it asks
// instead of quietly setting something that will not work.
func configureBrowser(ui *UI) {
	b := classify(defaultBrowser())
	if b.Name == "" {
		ui.Warn("Could not tell what your default browser is")
	} else {
		ui.Done("Default browser: %s", b.Name)
	}

	if b.Chromium {
		ui.Say("Auto-apply can open tabs in it and keep you logged in. Nothing to choose.")
		return
	}

	what := b.Name
	if what == "" {
		what = "Your browser"
	}
	ui.Say("%s cannot be driven the way auto-apply needs — that interface does not", what)
	ui.Say("exist in it. Three ways round, none of them wrong:")

	switch ui.Choose("How would you like applications handled?", []string{
		fmt.Sprintf("Keep %s. Job pages open there and the Ledger shows you what to paste.", what),
		"Use a separate automated browser. Fills forms, but you log in to each board again.",
		"I will install Chrome or Edge myself, for the apply flow only.",
	}, 0) {
	case 1:
		ui.Say("Set Settings → Scheduler → Apply browser to \"Fresh browser\" once it opens.")
	case 2:
		ui.Say("Install it, then set Settings → Scheduler → Apply browser to \"My Chrome\".")
	default:
		ui.Say("Nothing to install. The Ledger will show you the answers to paste.")
	}
}
