package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Terminal output for someone who is not a developer and is watching a progress bar
// for ten minutes. Plain sentences, no jargon, and never silence: the install is long
// enough that quiet reads as a crash.
type UI struct{ in *bufio.Reader }

func NewUI() *UI { return &UI{in: bufio.NewReader(os.Stdin)} }

func (u *UI) Title(s string) {
	fmt.Printf("\n%s\n%s\n\n", s, strings.Repeat("─", len([]rune(s))))
}
func (u *UI) Step(f string, a ...any) { fmt.Printf("  → %s\n", fmt.Sprintf(f, a...)) }
func (u *UI) Done(f string, a ...any) { fmt.Printf("  ✓ %s\n", fmt.Sprintf(f, a...)) }
func (u *UI) Warn(f string, a ...any) { fmt.Printf("  ! %s\n", fmt.Sprintf(f, a...)) }
func (u *UI) Say(f string, a ...any)  { fmt.Printf("    %s\n", fmt.Sprintf(f, a...)) }

// Fail says what went wrong and what to do about it, then stops. An installer that
// exits with a stack trace has told a non-technical user nothing.
func (u *UI) Fail(what string, err error, advice string) {
	fmt.Printf("\n  ✗ %s\n", what)
	if err != nil {
		fmt.Printf("    %s\n", err)
	}
	if advice != "" {
		fmt.Printf("\n    %s\n", advice)
	}
	fmt.Println()
	os.Exit(1)
}

// Ask returns true unless the answer clearly starts with n.
func (u *UI) Ask(question string, def bool) bool {
	hint := "[Y/n]"
	if !def {
		hint = "[y/N]"
	}
	fmt.Printf("  %s %s ", question, hint)
	line, _ := u.in.ReadString('\n')
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "":
		return def
	case "y", "yes":
		return true
	case "n", "no":
		return false
	default:
		return def
	}
}

// Choose presents a numbered list and returns the index picked.
func (u *UI) Choose(question string, options []string, def int) int {
	fmt.Printf("\n  %s\n\n", question)
	for i, o := range options {
		mark := " "
		if i == def {
			mark = "*"
		}
		fmt.Printf("   %s %d. %s\n", mark, i+1, o)
	}
	fmt.Printf("\n  Which? [%d] ", def+1)
	line, _ := u.in.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	for i := range options {
		if line == fmt.Sprint(i+1) {
			return i
		}
	}
	return def
}

// download streams to disk, reporting progress on one rewritten line.
func download(url, dest string, ui *UI) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("%s answered %d", url, resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, &progressReader{r: resp.Body, total: resp.ContentLength, start: time.Now()})
	fmt.Println()
	return err
}

type progressReader struct {
	r      io.Reader
	n      int64
	total  int64
	start  time.Time
	lastAt time.Time
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.n += int64(n)
	// once every 200ms: often enough to look alive, rarely enough not to flicker
	if time.Since(p.lastAt) > 200*time.Millisecond || err == io.EOF {
		p.lastAt = time.Now()
		if p.total > 0 {
			pct := float64(p.n) / float64(p.total) * 100
			fmt.Printf("\r    %s of %s  (%.0f%%)      ", bytes(p.n), bytes(p.total), pct)
		} else {
			fmt.Printf("\r    %s      ", bytes(p.n))
		}
	}
	return n, err
}

func bytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGT"[exp])
}
