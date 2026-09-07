//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// defaultBrowser reads the user's http association from the registry. reg.exe rather
// than a registry binding keeps this binary dependency-free, which matters for a
// bootstrap: it has to build anywhere, from a clean checkout, with no module cache.
func defaultBrowser() string {
	out, err := exec.Command("reg", "query",
		`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`,
		"/v", "ProgId").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "ProgId") {
			f := strings.Fields(line)
			return f[len(f)-1] // "ChromeHTML", "MSEdgeHTM", "FirefoxURL", ...
		}
	}
	return ""
}

// GetDiskFreeSpaceExW through stdlib syscall, rather than pulling in golang.org/x/sys
// for one call.
func freeDiskBytes(path string) uint64 {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GetDiskFreeSpaceExW")
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var freeForCaller uint64
	r, _, _ := proc.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&freeForCaller)), 0, 0)
	if r == 0 {
		return 0
	}
	return freeForCaller
}

// gitCandidates is where Git for Windows actually lands, for the window between
// installing it and the PATH being visible to a process that started before it.
func gitCandidates() []string {
	var out []string
	for _, base := range []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs"),
		`C:\Program Files`,
	} {
		if base == "" {
			continue
		}
		out = append(out,
			filepath.Join(base, "Git", "cmd", "git.exe"),
			filepath.Join(base, "Git", "bin", "git.exe"),
		)
	}
	return out
}

// ownsConsole reports whether this process is the only one attached to the console,
// which is what a double-click looks like. When it is, the window closes the instant
// main returns — taking every error message with it.
func ownsConsole() bool {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleProcessList")
	var pids [8]uint32
	n, _, _ := proc.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
	return n == 1
}
