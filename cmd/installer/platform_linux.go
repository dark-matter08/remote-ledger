//go:build linux

package main

import (
	"os/exec"
	"strings"
	"syscall"
)

func defaultBrowser() string {
	out, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out)) // e.g. "firefox.desktop"
}

func freeDiskBytes(path string) uint64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return st.Bavail * uint64(st.Bsize)
}

func gitCandidates() []string {
	return []string{"/usr/bin/git", "/usr/local/bin/git", "/bin/git"}
}

func ownsConsole() bool { return false }
