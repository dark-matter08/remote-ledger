# Telling people it exists

A plan for posting The Remote Ledger to Reddit, Hacker News and the dev blogs, written
to be followed in order. It assumes you have not posted about the project anywhere yet.

The short version: **communities can smell a launch.** Everything below is arranged so
that what you post is true, specific, and useful to the person reading it even if they
never install anything. That is not a nicety — it is the only version that survives
moderation and gets upvoted rather than removed.

---

## 0. Before you post anything

Do these once. Skipping them is the most common way a good post dies at zero.

**Check your account.** Most of the subreddits below auto-remove posts from accounts
that are new, low-karma, or have never commented in that community. If your account is
fresh, spend a week commenting normally — on anything — before you post. There is no
way around this and no point fighting it.

**Read the rules of each subreddit on the day you post.** They change, moderators
change, and a rule that allowed project posts last year may not now. The sidebar and
the "posting guidelines" wiki page are the authority, not this document.

**Decide what you are asking for.** "Feedback on the crawl accuracy" gets a different
reception than "check out my project". The first is a conversation; the second is an
advert. Ask for something specific you actually want.

**Have these ready before the first post:**

- A 20–40 second screen recording of a crawl finding a job and a résumé being tailored.
  Static screenshots are fine, but movement stops the scroll.
- The install command, tested that morning on a clean machine.
- An hour free after posting. A post you abandon for six hours is worse than no post,
  because the comments go unanswered while it is on the front page of the sub.

---

## 1. One line, three audiences

The same project, described in the words each audience actually uses. Use the matching
line as your opening sentence — do not reuse the same paragraph across communities.

| Audience | The line |
|---|---|
| Self-hosters | Local-first job tracker: SQLite on disk, Docker or bare Node, IMAP for application mail, zero telemetry. |
| Job hunters | A free, open-source alternative to Teal and Huntr that tailors your résumé per job and keeps everything on your own machine. |
| Developers | I got tired of paying a subscription to store my own job applications, so I built one that runs locally and uses an AI key I already have. |

All three are true of the same build. Pick by room.

---

## 2. Channel by channel

Ordered by how likely they are to go well. **Do not post to all of them in one day** —
see the schedule in §4.

### r/selfhosted — best fit, start here

The audience is people who run things on their own hardware and dislike SaaS on
principle. They will care about the architecture and not at all about the job-hunting
angle. Lead with what it *is*, not what it is *for*.

- **Fit:** very high. Local-first, SQLite, Docker, no telemetry is exactly their brief.
- **Rules to check:** most self-promotion is permitted if the project is genuinely
  self-hostable and you are open about being the author. Confirm the current sidebar.
- **Angle:** the stack. Mention that data and keys never leave the machine, that the
  only outbound call is to the AI provider you pick, and that there is a Docker compose
  file. Say you are the author in the first line.
- **What they will ask:** "Does it phone home?", "Can I use a local model?", "ARM
  build?", "Does it work without an API key?" Have honest answers, including where the
  answer is no.

### r/opensource and r/SideProject — friendly, lower traffic

Both accept "I built this" posts with disclosure. Lower ceiling than r/selfhosted but
almost no risk. Good places to post *second*, once you have refined your answers.

### r/jobsearchhacks — the right users, be careful

Actual job hunters, and smaller than it sounds. A tool post can do well if it reads as
"here is a thing that helped me" rather than a product announcement.

- **Angle:** the problem first. What you were doing manually, how long it took, what
  the tool does instead. The tool is the last paragraph, not the first.
- **Risk:** this sub gets a lot of low-quality tool spam, so moderators are quick.
  Disclosure and a real story are what separate you from that.

### r/cscareerquestions — **the proposal is wrong about this one**

The proposal recommends it for reach. Its reach is real, but the sub has a
long-standing, actively enforced prohibition on self-promotion and tool posts of any
kind. Posting the project there is very likely to be removed and can earn a ban that
also costs you the account you would have used elsewhere.

**Recommendation: do not post the project there.** If you want that audience, the
legitimate route is to be a useful commenter in résumé and job-search threads for a few
weeks, with the project in your profile, and let people find it. That works slowly and
does not risk anything.

The same caution applies to most of the large careers subs — r/jobs, r/recruitinghell.
Check each one; assume promotion is banned unless the sidebar says otherwise.

### r/privacy, r/degoogle — narrow but receptive

Only worth it if you lead with the data story: nothing leaves the machine, no account,
no telemetry, keys held locally and encrypted. Do not mention job hunting until the
second paragraph. Smaller return, very low risk.

### r/EngineeringResumes, r/resumes — do not post the tool

Résumé subs almost universally ban tools and AI-generated résumé services. Skip them.

---

## 3. Drafts

Paste-ready. Edit the personal details so they are true of you — the specifics are what
make these work, and invented ones will not survive the comments.

### r/selfhosted

> **Title:** Remote Ledger — a self-hosted job tracker that tailors your résumé locally, no telemetry
>
> I built this because every job-tracking tool I found wanted my CV on their server and
> a monthly fee to keep it there.
>
> It runs on your own machine. SQLite on disk, Docker compose or bare Node 22, IMAP to
> pull application mail into a pipeline, and Playwright to render the PDFs. The only
> outbound request it ever makes is to whichever AI provider you configure — there is no
> account, no analytics, and no phone-home. You can point it at Ollama and it makes no
> external calls at all.
>
> The part I actually use: it crawls remote job boards, then rewrites my résumé against
> each posting using an AI subscription I already pay for, or an API key, or a local
> model. The rewrite is constrained so it cannot invent experience I do not have.
>
> Author here, MIT licensed, and I would genuinely like to be told what is wrong with it.
>
> [repo] [screenshot or 30s clip]

### r/jobsearchhacks

> **Title:** I was tracking 60 applications in a spreadsheet and rewriting my CV by hand, so I built the thing I wanted
>
> Six months of applying taught me that the two jobs are admin: remembering where you
> applied and what you said, and rewriting the same CV for the fortieth time.
>
> Teal and Huntr both do this well and both want a subscription and a copy of my CV. I
> wanted neither, so I built a local one.
>
> It finds remote roles, rewrites my résumé for each posting, drafts the cover letter,
> and tracks every application through the stages. It runs on my laptop — no account,
> nothing uploaded. The AI part uses a subscription I already had.
>
> Free and open source. I am the author. Happy to answer anything, including where it is
> still rough.
>
> [repo]

### Hacker News (Show HN)

> **Title:** Show HN: Remote Ledger – local-first job tracker that tailors résumés with your own AI
>
> First comment, posted by you immediately after submitting:
>
> I built this after a long job hunt where the admin was worse than the interviews.
> Everything runs on your own machine: SQLite for storage, your own AI key or CLI
> subscription for the rewriting, and no account or telemetry of any kind. Point it at
> Ollama and it makes no external calls.
>
> The interesting problem was stopping the model inventing experience. The tailor step
> only reorders and rephrases what is already in your résumé, and there is a check that
> refuses output containing claims not backed by the source document.
>
> It is React Router 7 with node:sqlite, so there are no native modules to build. MIT.

**Timing:** Tuesday or Wednesday, 08:00–10:00 US Eastern. Post it yourself, never ask
anyone to upvote — vote rings are detected and will bury the submission permanently.

### Dev.to / Hashnode

> **Title:** Why I built a local-first job tracker instead of paying for Teal
>
> 1200–1800 words. Structure: the admin problem → why the SaaS options did not fit →
> the local-first constraint and what it forced → the anti-hallucination rule in the
> résumé tailor → what I would do differently. Link the repo twice, once early and once
> at the end.

This one is the long game. It keeps returning search traffic for months, which none of
the Reddit posts will.

---

## 4. The schedule

Spreading it out is not politeness — the same link posted everywhere in one day looks
like a campaign, and cross-posting patterns are exactly what spam filters look for.

| When | What |
|---|---|
| Week 0 | Comment normally in r/selfhosted. Record the clip. Test the install on a clean machine. |
| Week 1, Tue | **r/selfhosted.** Stay for the afternoon and answer everything. |
| Week 1, Fri | Fix whatever the comments exposed. This matters more than the next post. |
| Week 2, Tue | **Show HN**, 08:00 ET. Own first comment ready to paste. |
| Week 2, Thu | **r/opensource** or **r/SideProject**, rewritten, not copy-pasted. |
| Week 3 | **Dev.to** post. Then **r/jobsearchhacks**, which can link the article. |
| Ongoing | Answer issues within a day. The second wave comes from people who checked whether the project is alive. |

If a post does well, do not immediately post the next one. Finish the conversation.

---

## 5. In the comments

This is where the launch is actually won or lost.

- **Answer every question for the first three hours**, including the hostile ones,
  especially the hostile ones. A calm reply to "this is pointless" convinces the fifty
  people reading who did not comment.
- **Concede what is true.** "You are right, it does not do X yet" costs nothing and buys
  the room. Arguing a real limitation is how threads turn.
- **Never argue with a moderator in public.** If a post is removed, message modmail
  once, politely, and accept the answer.
- **Do not vote-beg, do not DM people links, and do not post from a second account.**
  All three are detectable and all three are fatal.
- **Turn feedback into commits while the thread is live.** "Fixed, thanks — it's in
  main" is the single most persuasive thing you can say.

---

## 6. What gets you removed

In rough order of how often it happens:

1. Posting where self-promotion is banned. Read the sidebar.
2. Not disclosing that you are the author. Say it in the first line, every time.
3. An account too new or with no history in that community.
4. The same text posted to several subreddits close together.
5. A title that reads like an advert. Describe the thing; do not sell it.
6. Linking a landing page instead of the repo. On technical subs, link the code.

---

## 7. What to measure

Vanity numbers will mislead you. Watch these instead, and write them down after each
post so you can tell which channel is actually worth repeating.

- **GitHub stars in the 48 hours after each post** — attributable, unlike traffic.
- **Issues and questions opened by people who are not you** — the real signal that
  someone installed it.
- **Installs you can infer from release asset download counts** (`gh release view --json assets`).
- **Which questions repeat.** Three people asking the same thing is a documentation bug,
  and fixing it is worth more than the next post.

---

## 8. Honest expectations

A first post to r/selfhosted that goes well is on the order of a few hundred upvotes and
a few dozen stars. A Show HN that does not reach the front page still brings a handful
of the most technical users you will get all year. Most posts do less than you hope.

The compounding channels are the Dev.to article and the GitHub topics and README, which
keep working after the threads are archived. The Reddit posts are a spike; the writing
is the floor. Do both, in that order of effort.
