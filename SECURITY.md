# Security

The Remote Ledger runs on your machine and holds your résumé, your application history
and your AI provider keys. This is what it does with them, and how to tell us if any of
it is wrong.

## What leaves your machine

Only two things, and both are your choice:

1. **The call to the AI provider you configured.** Anthropic, OpenAI, Google,
   OpenRouter, Groq, Mistral — or nothing at all if you point it at Ollama, which runs
   locally and makes no external request.
2. **The job boards it crawls**, which are ordinary web requests to public pages.

There is no account, no analytics, no crash reporting and no phone-home. Nothing is
sent to us, because there is no "us" to send it to — there is no server component.

One optional exception, off by default: **Settings → Community** can open a pull
request against the upstream repository suggesting job boards you found useful. It
sends board URLs and nothing else, only when you turn it on, and it shows you exactly
what it will submit first.

## Where your secrets are kept

- **API keys** are encrypted at rest with AES-256-GCM in `data/jobs.db`, using a master
  key generated on first run and stored in `data/.master.key`. Environment variables
  override the stored keys and are never written to disk.
- **Email passwords** for the IMAP inbox are held the same way.
- **`data/` is gitignored** in its entirety — the database, the PDFs, the backups and
  the master key.

If you are backing up the machine, `data/.master.key` is the file that matters. Without
it the stored keys cannot be decrypted; with it, they can. Treat it as a secret.

## Reporting a vulnerability

Please **do not open a public issue** for anything that would expose someone's data or
keys.

Use GitHub's private reporting — the **Security** tab on the repository, then *Report a
vulnerability*. That opens a channel only the maintainers can read.

Include what you did, what happened, and what you expected. A proof of concept is
welcome but not required; a clear description is worth more than a vague one with an
exploit attached.

You should get an acknowledgement within a week. This is a small project maintained in
spare time — if a fix is going to take longer than that, you will be told so rather than
left waiting.

## Supported versions

The latest release is the supported one. Fixes land on `main` and go out in the next
tag; there are no long-lived maintenance branches to back-port to.
