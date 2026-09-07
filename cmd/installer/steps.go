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

// ensureGit does not install git itself. Each platform has one blessed way to do it
// that shows a dialog the user already trusts, and a silent background install of a
// developer toolchain is not a thing an installer should attempt.
func ensureGit(ui *UI) error {
	if have("git") {
		ui.Done("git is installed")
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
			if err := runAt("", "winget", []string{"install", "--id", "Git.Git", "-e", "--source", "winget"}, nil); err == nil && have("git") {
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
	npm := filepath.Join(nodeBin, "npm")
	if runtime.GOOS == "windows" {
		npm = filepath.Join(nodeBin, "npm.cmd")
	}

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
	fmt.Println()
	return runAt(appDir, npm, []string{"run", "ledger", "start"}, env)
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
