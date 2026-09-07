//go:build darwin

package main

import (
	"os/exec"
	"strings"
	"syscall"
)

// defaultBrowser reads the http handler out of LaunchServices. There is no supported
// API for this, and the plist is binary, so plutil converting it to text is the least
// bad route — and a miss here is harmless: we fall through to asking.
func defaultBrowser() string {
	out, err := exec.Command("plutil", "-convert", "xml1", "-o", "-",
		homeDir()+"/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist").Output()
	if err != nil {
		return ""
	}
	text := string(out)
	// entries pair a scheme with the bundle id that claims it; find the one for http
	idx := strings.Index(text, "<string>http</string>")
	if idx < 0 {
		return ""
	}
	tail := text[idx:]
	end := strings.Index(tail, "LSHandlerRoleAll")
	if end < 0 || end > 400 {
		end = min(400, len(tail))
	}
	return tail[:end]
}

func freeDiskBytes(path string) uint64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return st.Bavail * uint64(st.Bsize)
}
