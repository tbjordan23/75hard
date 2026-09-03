# CLAUDE.md — 75hard

Guidance for Claude Code when working in this project specifically. See the parent repo's `CLAUDE.md` for org-wide context.

## What this is

A shared **75 Hard challenge tracker** for a small group (Travis + friends/family), with a soft-penalty scoring rule, per-person nutrition goals (broken out by meal), progress-photo history, a friends system for photo-based accountability, daily motivational quotes, and a day-complete celebration. Visual style is a single dark theme (no light mode), modeled after Frame.io.

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
- `index.html` — all CSS/JS inline, fetches the API and renders login → quote of the day → today's checklist/photo/nutrition (with a motivational quote strip between each card) → progress → 75-day calendar → my photo gallery → friends → group table.

## The scoring rule (important — this diverges from "real" 75 Hard)

Standard 75 Hard resets you to Day 1 on any missed day. **This tracker does not do that.** Per the user's explicit request:

> Instead of restarting if you miss a day, 2 days are added to the total if all goals are not met for 1 day.

So: `targetDays = 75 + 2 × missedDays`, and progress (`completedDays`) never zeroes out — it just needs to reach a growing target. This logic lives in `computeStatus()` in `server.js`. Only *finalized* past days (before today) count as "missed"; today is never judged incomplete while still in progress.

## Nutrition instead of a blanket "diet" checkbox

People in the same group are cutting, bulking, or maintaining, so "follow a diet" isn't a single checkbox — each user sets their own daily calorie + protein target (`POST /api/goals`), logs food throughout the day, and a day's nutrition is "met" when protein clears the target and calories land within ±10%/±100 (whichever is larger) of it, in either direction. See `nutritionStatus()`.

Food entries are tagged with a `meal` (`breakfast`/`lunch`/`dinner`, see `MEALS` in `server.js`) — `POST /api/food/add` requires and validates it. The UI (`renderNutritionTracker()`) groups entries into three sections with per-meal subtotals; daily totals/targets stay aggregated across all three (`foodTotals()` sums the whole day regardless of meal — that part is unchanged).

## Goal mode flexes the workout requirement

`user.goals.mode` is `'standard'` (2 workouts/day, one outdoors — the original 75 Hard rule) or `'bulk'` (1 workout/day, strength & hypertrophy focus — per the user's request, since two-a-days fight muscle growth). `tasksForUser()` picks `STANDARD_TASKS` or `BULK_TASKS` accordingly, and this determines both the checklist shown and what counts toward `dayComplete()`. Applied retroactively across a user's history (goals aren't versioned per-day) — same simplification as the nutrition targets above.

## Progress photos

The `photo` task is **not a manual toggle** — `POST /api/toggle` rejects it. Completion is derived from an actual uploaded image (`day.photo = {ext, uploadedAt}`), stored as a file under `data/photos/`, named by a hash of the owner's key + date (not the raw key, just to keep filesystem paths predictable). `GET /api/photo` streams it back, gated to the owner or a confirmed friend. No new server endpoint was needed for the two features below — both are read entirely from data `/api/state` already returns.

- **Take photo vs. choose from library**: the Today card has two separate hidden `<input type="file">` elements (`photo-camera-input` has `capture="environment"`, `photo-library-input` doesn't) behind two explicit buttons, both funneled through the shared `handlePhotoFile()` uploader. That function guards on `creds` being non-null in the (async) `FileReader.onload` callback — a user can log out while a large file is still being read, and without the guard the stale closure throws trying to read `creds.name`.
- **My photo gallery**: a "My photos" grid at the bottom of the Your Progress card (`renderPhotoGallery()`) lists every date in `me.days` that has a `.photo`, newest first, each linking to the full-size `/api/photo` URL. This is the user's own full history, same unbounded treatment as a friend's photo strip.

## Friends (accountability)

`user.friends` / `user.incoming` / `user.outgoing` form a simple mutual-request graph (see `/api/friends/*`). `GET /api/state` returns `me.friends` as rich summaries (`friendSummary()` in `server.js`) — each friend's today checklist breakdown, nutrition status, and **full** progress-photo history (newest first, no cap) — so the Friends card shows both whether they're hitting today's goals and lets you browse back through their photos, not just a leaderboard number. The flat "Group" table (all registered users, lightweight) is kept separately for a quick overview; Friends is the detailed, opt-in accountability view.

## Persistence on Railway

`data/` is gitignored — it's runtime state, not source, and now includes both `data.json` and uploaded photo files. On Railway, the filesystem is ephemeral across redeploys, so **attach a Railway Volume** mounted at (e.g.) `/app/data` and set `DATA_DIR=/app/data` in the service's environment variables, or logged progress and photos will be lost on every deploy.

## Tasks (the checkbox rules)

Defined in `server.js` as `STANDARD_TASKS` / `BULK_TASKS` (picked per-user by `tasksForUser()`) and returned to the client via `/api/state` — don't hardcode a task list in `index.html`. The client treats the `photo` key specially (upload UI, not a checkbox); every other task key renders as a generic checkbox row.

## Motivational quotes

`QUOTES` in `index.html` is a static bank of short attributed sayings. Selection is entirely client-side and deterministic per UTC calendar date: `quotesForToday(dateStr, 5)` hashes the date string and Fisher-Yates shuffles the bank with that seed, so everyone in the group sees the same "quote of the day" (rendered prominently above the Today card) and the same 4 divider quotes between the other cards, and they only change once a day — not on every reload. No server involvement; don't add an endpoint for this.

## Visual design: single dark theme, Frame.io-inspired

Per explicit request, this is **dark-only** — there's no light-mode branch (no `prefers-color-scheme`/`data-theme` handling), unlike the `dataviz`-skill convention used elsewhere. All colors are CSS custom properties on `:root` in `index.html`'s `<style>` block (`--page`, `--surface`, `--surface-2`, `--accent`/`--accent-2` violet, `--good` emerald, `--critical` red, etc.) — change the palette there, not by hunting for hardcoded hex values in rules. `body` layers a couple of soft radial-gradient violet glows behind the page for the ambient look; `.card`/`.qotd` use a subtle linear-gradient + `box-shadow: var(--shadow)` for depth.

**No emoji anywhere in the UI** — a small inline SVG line-icon set (`ICONS.camera`, `.cameraLg`, `.image`, `.check`) replaces what used to be 📷/🖼️/✅/⏳/💪. Keep new icons in that same set (stroke-based, `currentColor`, ~1.8 stroke-width) rather than reaching for emoji or an icon font/library.

## Day-complete celebration

When `me.status.todayComplete` flips from `false` to `true` within a session (checking the last remaining task, hitting a nutrition target, or uploading the day's photo — whichever completes it), `celebrateDayComplete()` fires: a brief pulse on the Today banner (`.celebrate`, CSS `@keyframes celebrate-pulse`) plus a small burst of rising/fading sparkle dots (`.confetti-piece`, `@keyframes sparkle-rise`), auto-removed after ~1s. Respects `prefers-reduced-motion`.

The transition is tracked via the module-level `lastTodayComplete` var in `index.html`, compared each time `renderTasks()` runs (i.e., after every mutating API call reloads state). It's seeded to `null` on login/page-load specifically so reloading an *already*-complete day doesn't replay the celebration — only a live `false → true` flip does. Reset to `null` on logout so a fresh login doesn't inherit the previous user's transition state.
