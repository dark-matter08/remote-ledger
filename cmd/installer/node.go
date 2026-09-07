package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// The Ledger uses node:sqlite, which does not exist before this. Installing anything
// older produces an app that starts and then dies on its first query, which is a far
// worse outcome than refusing.
const minNodeMajor = 22
const minNodeMinor = 5

type nodeRelease struct {
	Version string          `json:"version"` // "v22.20.0"
	LTS     json.RawMessage `json:"lts"`     // false, or a codename string
	Files   []string        `json:"files"`
}

// nodeTarget is the archive name nodejs.org publishes for this machine.
func nodeTarget(version string) (name string, isZip bool) {
	arch := runtime.GOARCH // amd64 -> x64 is the only rename that matters
	if arch == "amd64" {
		arch = "x64"
	}
	switch runtime.GOOS {
	case "windows":
		return fmt.Sprintf("node-%s-win-%s.zip", version, arch), true
	case "darwin":
		return fmt.Sprintf("node-%s-darwin-%s.tar.gz", version, arch), false
	default:
		return fmt.Sprintf("node-%s-linux-%s.tar.gz", version, arch), false
	}
}

// pickNode asks nodejs.org for the newest LTS at or above our floor.
//
// Pinning a version in source would mean shipping a binary that installs an
// increasingly stale Node, and re-releasing the installer to fix it. Asking costs one
// request and keeps working.
func pickNode() (string, error) {
	resp, err := http.Get("https://nodejs.org/dist/index.json")
	if err != nil {
		return "", fmt.Errorf("could not reach nodejs.org: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("nodejs.org answered %d", resp.StatusCode)
	}

	var releases []nodeRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", fmt.Errorf("could not read the version list: %w", err)
	}

	// the list is newest first
	for _, r := range releases {
		if string(r.LTS) == "false" {
			continue // a current release is not what an installer should pick
		}
		major, minor, ok := parseVersion(r.Version)
		if !ok || major < minNodeMajor || (major == minNodeMajor && minor < minNodeMinor) {
			continue
		}
		return r.Version, nil
	}
	return "", fmt.Errorf("nodejs.org lists no LTS at or above %d.%d", minNodeMajor, minNodeMinor)
}

func parseVersion(v string) (major, minor int, ok bool) {
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	return major, minor, err1 == nil && err2 == nil
}

// expectedSum reads SHASUMS256.txt and returns the digest for one file.
func expectedSum(version, file string) (string, error) {
	url := fmt.Sprintf("https://nodejs.org/dist/%s/SHASUMS256.txt", version)
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == file {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("%s is not listed in SHASUMS256.txt", file)
}

// installNode downloads, verifies and unpacks Node into dir, returning the path to
// the interpreter. Everything afterwards uses that path directly — never `node` from
// PATH, which on a developer's machine can resolve into someone else's environment.
func installNode(dir string, ui *UI) (string, error) {
	version, err := pickNode()
	if err != nil {
		return "", err
	}
	file, isZip := nodeTarget(version)
	root := filepath.Join(dir, strings.TrimSuffix(strings.TrimSuffix(file, ".tar.gz"), ".zip"))

	if exe := nodeExe(root); fileExists(exe) {
		ui.Done("Node %s already installed", version)
		return exe, nil
	}

	ui.Step("Downloading Node %s (about 50 MB)", version)
	want, err := expectedSum(version, file)
	if err != nil {
		return "", fmt.Errorf("could not get the checksum: %w", err)
	}

	archive := filepath.Join(dir, file)
	if err := download(fmt.Sprintf("https://nodejs.org/dist/%s/%s", version, file), archive, ui); err != nil {
		return "", err
	}

	got, err := sha256File(archive)
	if err != nil {
		return "", err
	}
	if got != want {
		os.Remove(archive)
		return "", fmt.Errorf("the download does not match its published checksum — refusing to run it")
	}
	ui.Done("Checksum verified")

	ui.Step("Unpacking Node")
	if isZip {
		err = unzip(archive, dir)
	} else {
		err = untargz(archive, dir)
	}
	if err != nil {
		return "", err
	}
	os.Remove(archive)

	exe := nodeExe(root)
	if !fileExists(exe) {
		return "", fmt.Errorf("unpacked Node but found no interpreter at %s", exe)
	}
	return exe, nil
}

func nodeExe(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "node.exe")
	}
	return filepath.Join(root, "bin", "node")
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func untargz(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(dest, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			out.Close()
		}
	}
}

func unzip(archive, dest string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		target, err := safeJoin(dest, f.Name)
		if err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// safeJoin refuses paths that escape the destination. An archive entry named
// "../../.ssh/authorized_keys" is a real attack, and we are unpacking as the user.
func safeJoin(dest, name string) (string, error) {
	target := filepath.Join(dest, name)
	if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
		return "", fmt.Errorf("archive entry %q escapes the destination", name)
	}
	return target, nil
}
