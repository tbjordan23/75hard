# CLAUDE.md — 75hard

Guidance for Claude Code when working in this project specifically. See the parent repo's `CLAUDE.md` for org-wide context.

## What this is

A shared **75 Hard challenge tracker** for a small group (Travis + friends/family), with a soft-penalty scoring rule, per-person nutrition goals, and a friends system for photo-based accountability.

**Stack:** Vanilla JS single-page app, same pattern as `mindmeter/` — no build step, no framework, no npm dependencies. `server.js` is the entire backend; `index.html` is the entire frontend. Login is name + 4-6 digit PIN (no email, no real auth — this is low-stakes and scoped to people you trust).

**Run locally:**
```
cd 75hard
node server.js        # serves on http://localhost:3000
```

## Architecture

- `server.js` — Node built-ins only (`http`, `fs`, `crypto`), no npm dependencies. Persists state to a JSON file (`data/data.json` by default, override with `DATA_DIR` env var) plus progress-photo files under `data/photos/`. Key endpoints:
  - `POST /api/login` — creates a user on first use (hashes the PIN with a per-user salt), validates PIN on return visits.
  - `GET /api/state?name=&pin=` — full state: the caller's task history, nutrition, friends, and everyone's group summary.
  - `POST /api/toggle` — flips one checkbox task for one date (not `photo` — see below).
  - `POST /api/goals` — sets a user's goal mode (`standard`/`bulk`) + calorie/protein targets.
  - `POST /api/food/add`, `POST /api/food/remove` — daily food log entries.
  - `POST /api/photo`, `GET /api/photo`, `POST /api/photo/remove` — progress photo upload/fetch/delete. Fetch is access-controlled: viewable only by the owner or a confirmed friend.
  - `POST /api/friends/request`, `/accept`, `/decline`, `/remove`, `GET /api/directory` — mutual friend graph.
  - `POST /api/restart` — manual full wipe of a user's history (not triggered automatically — see scoring rule below).
- `index.html` — all CSS/JS inline, fetches the API and renders login → today's checklist/photo/nutrition → progress → 75-day calendar → friends → group table.

## The scoring rule (important — this diverges from "real" 75 Hard)

Standard 75 Hard resets you to Day 1 on any missed day. **This tracker does not do that.** Per the user's explicit request:

> Instead of restarting if you miss a day, 2 days are added to the total if all goals are not met for 1 day.

So: `targetDays = 75 + 2 × missedDays`, and progress (`completedDays`) never zeroes out — it just needs to reach a growing target. This logic lives in `computeStatus()` in `server.js`. Only *finalized* past days (before today) count as "missed"; today is never judged incomplete while still in progress.

## Nutrition instead of a blanket "diet" checkbox

People in the same group are cutting, bulking, or maintaining, so "follow a diet" isn't a single checkbox — each user sets their own daily calorie + protein target (`POST /api/goals`), logs food throughout the day, and a day's nutrition is "met" when protein clears the target and calories land within ±10%/±100 (whichever is larger) of it, in either direction. See `nutritionStatus()`.

## Goal mode flexes the workout requirement

`user.goals.mode` is `'standard'` (2 workouts/day, one outdoors — the original 75 Hard rule) or `'bulk'` (1 workout/day, strength & hypertrophy focus — per the user's request, since two-a-days fight muscle growth). `tasksForUser()` picks `STANDARD_TASKS` or `BULK_TASKS` accordingly, and this determines both the checklist shown and what counts toward `dayComplete()`. Applied retroactively across a user's history (goals aren't versioned per-day) — same simplification as the nutrition targets above.

## Progress photos

The `photo` task is **not a manual toggle** — `POST /api/toggle` rejects it. Completion is derived from an actual uploaded image (`day.photo = {ext, uploadedAt}`), stored as a file under `data/photos/`, named by a hash of the owner's key + date (not the raw key, just to keep filesystem paths predictable). `GET /api/photo` streams it back, gated to the owner or a confirmed friend.

## Friends (accountability)

`user.friends` / `user.incoming` / `user.outgoing` form a simple mutual-request graph (see `/api/friends/*`). `GET /api/state` returns `me.friends` as rich summaries (`friendSummary()` in `server.js`) — each friend's today checklist breakdown, nutrition status, and last-5 photo dates — so the Friends card can show whether they're hitting their goals *today*, not just a leaderboard number. The flat "Group" table (all registered users, lightweight) is kept separately for a quick overview; Friends is the detailed, opt-in accountability view.

## Persistence on Railway

`data/` is gitignored — it's runtime state, not source, and now includes both `data.json` and uploaded photo files. On Railway, the filesystem is ephemeral across redeploys, so **attach a Railway Volume** mounted at (e.g.) `/app/data` and set `DATA_DIR=/app/data` in the service's environment variables, or logged progress and photos will be lost on every deploy.

## Tasks (the checkbox rules)

Defined in `server.js` as `STANDARD_TASKS` / `BULK_TASKS` (picked per-user by `tasksForUser()`) and returned to the client via `/api/state` — don't hardcode a task list in `index.html`. The client treats the `photo` key specially (upload UI, not a checkbox); every other task key renders as a generic checkbox row.
