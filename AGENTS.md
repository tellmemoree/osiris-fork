<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Read the architecture map first

Before exploring the codebase, read **`ARCHITECTURE.md`** — it maps the data flow,
key files, the recipe for adding a map layer, API-route conventions, env vars, the
branch/dev workflow, and known-dead upstreams. It exists so you don't re-read the
whole tree each session.

**Keep it current:** when you add or materially change code (a new route, layer,
panel, env var, convention, or you discover a dead upstream), update the relevant
section of `ARCHITECTURE.md` in the *same* commit. A stale map is worse than none.


# Standing workflow rules (this repo)

- **Never push without explicit user approval.** Do not push to any remote branch unless the user has explicitly reviewed the changes and said "go for it" (or equivalent). This is a hard rule — no exceptions.
- **Rebuild after code changes.** After ANY code change, rebuild + restart the :3001
  dev server (see ARCHITECTURE.md → "Rebuild + restart :3001"). Committed/pushed code
  is NOT live until rebuilt — `next start` does not hot-reload.
- **`pkill` is its own command.** Always send `pkill`/`kill` as a standalone Bash call.
  Chaining anything after it aborts the rest of the script (exit 144), so the follow-up
  silently doesn't run and must be resent. One call kills; a separate call relaunches.
- **One feature per branch.** Never bundle multiple features or fixes into one `feat/*` branch. Each gets its own branch.
- **feat/* branches merge into the weekly branch on Friday only.** Complete your feat/* branch and leave it. Do NOT merge it into `week/YYYY-WNN` mid-week. The weekly branch is a Friday integration point. The only exception is an explicitly user-tagged hotfix.
