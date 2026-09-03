# 75 Hard Tracker

A shared 75 Hard challenge tracker for a small group of friends/family — daily checklist, per-person nutrition goals, progress photos, and a friends system for accountability.

## Features

- **Daily checklist**, mode-dependent:
  - *Cutting/maintaining* — 2 workouts/day (one outdoors), water, reading, photo.
  - *Bulking* — 1 workout/day (strength & hypertrophy focus), water, reading, photo.
- **Nutrition tracking** instead of a one-size-fits-all "diet" checkbox — each person sets their own daily calorie + protein target and logs food by meal (breakfast/lunch/dinner); a day's nutrition counts as met when protein clears the target and calories land close to it (±10%, whichever is looser).
- **Soft-penalty scoring** — missing a day doesn't reset you to Day 1. Instead it adds 2 days to your total (`75 + 2 × missed days`), and your progress keeps accumulating.
- **Body weight goal** — record your weight on Day 1, set a goal for Day 75, and log weigh-ins along the way with a progress bar toward the goal. Private to you — never shown to friends or the group.
- **Progress photos** — take a photo or choose one from your library each day instead of just checking a box, and browse your full photo history any time.
- **Friends** — send/accept friend requests, then see a friend's daily checklist, nutrition status, and full progress-photo history to keep each other honest.
- **Daily motivational quotes** — a shared "quote of the day" plus a rotating quote between each section, both synced across the group by date.
- **A celebration** when you complete a full day — a quick pulse + sparkle burst on the "Today complete" banner.
- A **Group** leaderboard of everyone in the tracker.
- **Dark, Frame.io-inspired design** — single dark theme, violet accent, no emoji (a small line-icon set instead).

## Stack

Vanilla JS single-page app, no build step, no framework, no npm dependencies. `server.js` is a plain Node `http` server (auth, JSON API, file-based storage); `index.html` is the entire frontend.

## Run locally

```
node server.js
```

Serves on `http://localhost:3000`. Data persists to `data/data.json` and `data/photos/` (both gitignored). Override the location with `DATA_DIR`.

## Deploy (Railway)

Push to this repo; Railway autodeploys. **Attach a Railway Volume** mounted at e.g. `/app/data` and set `DATA_DIR=/app/data`, or logged progress and photos will be lost on every redeploy — the container filesystem is otherwise ephemeral.

## Login

Enter a name + a 4–6 digit PIN. First use of a name creates the profile; the PIN is hashed (salted) before storage. This is intentionally lightweight auth for a small trusted group, not a real identity system.
