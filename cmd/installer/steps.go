package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const repoURL = "https://github.com/dark-matter08/remote-ledger.git"

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func have(bin string) bool { _, err := exec.LookPath(bin); return err == nil }

// runAt streams a command's output as it happens. The dependency install takes
// minutes and prints continuously; buffering it would turn the liveliest part of the
// install into the quietest.
func runAt(dir, bin string, args []string, env []string) error {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

// ---- git -------------------------------------------------------------------

// adoptGit finds git and makes it usable by this process.
//
// LookPath searches the PATH this process was started with. An installer that has
// just installed git is exactly the case where that is stale: winget writes the new
// PATH to the environment for *future* processes, so git is on disk, on the PATH
// every new shell will see, and invisible to us. Reported as "installed git, then
// exited and nothing happened".
//
// So when PATH does not have it, look where the installers actually put it, and
// prepend that directory to our own PATH so everything downstream — including the
// clone, and npm's own git calls — can find it too.
func adoptGit(ui *UI) bool {
	if have("git") {
		ui.Done("git is installed")
		return true
	}
	for _, candidate := range gitCandidates() {
		if !fileExists(candidate) {
			continue
		}
		dir := filepath.Dir(candidate)
		os.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		if have("git") {
			ui.Done("git is installed (%s)", candidate)
			return true
		}
	}
	return false
}

// ensureGit does not install git itself. Each platform has one blessed way to do it
// that shows a dialog the user already trusts, and a silent background install of a
// developer toolchain is not a thing an installer should attempt.
func ensureGit(ui *UI) error {
	if adoptGit(ui) {
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		ui.Step("git is missing — asking macOS to install the developer tools")
		ui.Say("A system dialog will appear. Accept it, wait for it to finish, then run this again.")
		_ = exec.Command("xcode-select", "--install").Run()
		return fmt.Errorf("waiting on the macOS developer tools")
	case "windows":
		if have("winget") {
			ui.Step("git is missing — installing it with winget")
			ui.Say("Windows may ask you to approve this. Accept it and wait.")
			// Not checking winget's exit code: it reports non-zero for cases that are
			// fine (already installed, a reboot suggested), and the only question that
			// matters is whether git is on disk afterwards.
			_ = runAt("", "winget", []string{
				"install", "--id", "Git.Git", "-e", "--source", "winget",
				"--accept-source-agreements", "--accept-package-agreements",
			}, nil)
			if adoptGit(ui) {
				return nil
			}
		}
		return fmt.Errorf("git is not installed — get it from https://git-scm.com/download/win, then run this again")
	default:
		return fmt.Errorf("git is not installed — install it with your package manager (apt install git, dnf install git, pacman -S git), then run this again")
	}
}

// ---- source ----------------------------------------------------------------

// cloneOrUpdate keeps a real git checkout, because the app updates itself by shelling
// out to git. A downloaded tarball would work exactly once and then never update.
func cloneOrUpdate(dir string, ui *UI) error {
	if fileExists(filepath.Join(dir, ".git")) {
		ui.Step("Updating the copy already here")
		if err := runAt(dir, "git", []string{"pull", "--ff-only"}, nil); err != nil {
			ui.Warn("could not update it — carrying on with what is on disk")
		}
		return nil
	}
	ui.Step("Downloading The Remote Ledger")
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	return runAt("", "git", []string{"clone", "--depth", "1", repoURL, dir}, nil)
}

// ---- handoff ---------------------------------------------------------------

// handOff runs the project's own setup, which already installs dependencies, Caddy
// and dropport, builds, starts the app detached and registers it to come back at
// login. Reimplementing any of that here would leave two versions to keep in step,
// and this would be the one nobody runs.
func handOff(appDir, nodeExe string, wantProxy bool, ui *UI) error {
	nodeBin := filepath.Dir(nodeExe)

	env := []string{
		// put the vendored Node first so every child process finds this one and not
		// whatever a shell profile happens to point at
		"PATH=" + nodeBin + string(os.PathListSeparator) + os.Getenv("PATH"),
	}
	if !wantProxy {
		env = append(env, "LEDGER_SKIP_PROXY=1")
	}

	ui.Step("Setting up the app — this is the long part, several minutes")
	ui.Say("It installs about 900 MB. Everything it prints below is its own.")
	if wantProxy && runtime.GOOS == "windows" {
		// A permission prompt several minutes into a ten-minute install is the one that
		// gets missed, because by then nobody is watching. Say when it is coming.
		ui.Say("")
		ui.Say("Partway through, Windows will ask once for administrator access — that is")
		ui.Say("the hosts file, and it is the only thing here that needs it. Nothing else")
		ui.Say("runs elevated: not the download, not the install, not the app itself.")
	}
	fmt.Println()

	// `npm run ledger start` would mean executing npm.cmd on Windows, which needs a
	// shell — CreateProcess cannot run a batch file. The script npm would run is
	// scripts/ledger.mjs, and we are holding the interpreter, so run it directly and
	// skip the shim entirely. npm stays on PATH above for ledger.mjs's own use.
	return runAt(appDir, nodeExe, []string{filepath.Join("scripts", "ledger.mjs"), "start"}, env)
}

// ---- browser ---------------------------------------------------------------

type browser struct {
	Name     string
	Chromium bool // speaks the DevTools Protocol, so auto-apply can drive it
}

// chromiumFamily is the question that actually matters. Firefox is absent on purpose:
// Mozilla removed CDP support, so no amount of work here makes it drivable.
func classify(id string) browser {
	l := strings.ToLower(id)
	switch {
	case strings.Contains(l, "chrome"):
		return browser{"Chrome", true}
	case strings.Contains(l, "edge") || strings.Contains(l, "msedge"):
		return browser{"Edge", true}
	case strings.Contains(l, "brave"):
		return browser{"Brave", true}
	case strings.Contains(l, "vivaldi"):
		return browser{"Vivaldi", true}
	case strings.Contains(l, "opera"):
		return browser{"Opera", true}
	case strings.Contains(l, "chromium"):
		return browser{"Chromium", true}
	case strings.Contains(l, "firefox"):
		return browser{"Firefox", false}
	case strings.Contains(l, "safari"):
		return browser{"Safari", false}
	default:
		return browser{"", false}
	}
}

func openURL(url string) {
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", url).Start()
	case "windows":
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		_ = exec.Command("xdg-open", url).Start()
	}
}
