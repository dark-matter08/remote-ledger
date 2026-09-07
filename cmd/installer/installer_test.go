package main

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestClassifyBrowser(t *testing.T) {
	// The only question that matters is whether it speaks the DevTools Protocol,
	// because that is what auto-apply drives. Firefox does not, and no amount of
	// work here changes that — so it must never be classified as Chromium.
	chromium := []string{
		"com.google.chrome", "ChromeHTML", "google-chrome.desktop",
		"MSEdgeHTM", "com.microsoft.edgemac",
		"com.brave.browser", "brave-browser.desktop",
		"com.vivaldi.vivaldi", "Opera", "chromium.desktop",
	}
	for _, id := range chromium {
		if b := classify(id); !b.Chromium {
			t.Errorf("classify(%q) = %+v, want Chromium", id, b)
		}
	}
	notChromium := []string{"FirefoxURL", "firefox.desktop", "org.mozilla.firefox", "com.apple.safari"}
	for _, id := range notChromium {
		if b := classify(id); b.Chromium {
			t.Errorf("classify(%q) = %+v, want not Chromium", id, b)
		}
	}
	if got := classify("").Name; got != "" {
		t.Errorf("an unknown browser should have no name, got %q", got)
	}
	// Edge must not be caught by the chrome branch: "msedge" contains no "chrome",
	// but a careless contains-check on "edge" would also match "wedge"
	if got := classify("MSEdgeHTM").Name; got != "Edge" {
		t.Errorf("MSEdgeHTM classified as %q, want Edge", got)
	}
}

func TestParseVersion(t *testing.T) {
	cases := map[string][2]int{"v22.20.0": {22, 20}, "22.5.1": {22, 5}, "v24.0.0": {24, 0}}
	for in, want := range cases {
		major, minor, ok := parseVersion(in)
		if !ok || major != want[0] || minor != want[1] {
			t.Errorf("parseVersion(%q) = %d,%d,%v want %d,%d,true", in, major, minor, ok, want[0], want[1])
		}
	}
	if _, _, ok := parseVersion("garbage"); ok {
		t.Error("parseVersion should reject nonsense rather than returning zeroes")
	}
}

func TestNodeTarget(t *testing.T) {
	name, isZip := nodeTarget("v22.20.0")
	if !strings.Contains(name, "v22.20.0") {
		t.Errorf("target %q does not carry the version", name)
	}
	switch runtime.GOOS {
	case "windows":
		if !isZip || !strings.HasSuffix(name, ".zip") {
			t.Errorf("windows should want a zip, got %q", name)
		}
	default:
		if isZip || !strings.HasSuffix(name, ".tar.gz") {
			t.Errorf("unix should want a tarball, got %q", name)
		}
	}
	// nodejs.org calls it x64, not amd64 — getting this wrong 404s the download
	if runtime.GOARCH == "amd64" && !strings.Contains(name, "x64") {
		t.Errorf("amd64 must map to x64 in %q", name)
	}
}

func TestSafeJoinRefusesEscapes(t *testing.T) {
	dest := filepath.Join("tmp", "unpack")
	// we unpack an archive downloaded over the network, as the user, into their home
	// directory — an entry that climbs out of the destination is an attack, not a bug
	for _, bad := range []string{"../escaped", "../../.ssh/authorized_keys", "a/../../out"} {
		if _, err := safeJoin(dest, bad); err == nil {
			t.Errorf("safeJoin allowed %q to escape", bad)
		}
	}
	good, err := safeJoin(dest, "node-v22/bin/node")
	if err != nil {
		t.Fatalf("safeJoin rejected a normal entry: %v", err)
	}
	if !strings.HasPrefix(good, filepath.Clean(dest)) {
		t.Errorf("safeJoin produced %q, outside %q", good, dest)
	}
}

func TestBytes(t *testing.T) {
	for in, want := range map[int64]string{0: "0 B", 512: "512 B", 1536: "1.5 KB"} {
		if got := bytes(in); got != want {
			t.Errorf("bytes(%d) = %q want %q", in, got, want)
		}
	}
	if got := bytes(900 << 20); !strings.HasSuffix(got, "MB") {
		t.Errorf("bytes(900MiB) = %q, want megabytes", got)
	}
}
