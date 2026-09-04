# CLAUDE.md — 75hard

Guidance for Claude Code when working in this project specifically. See the parent repo's `CLAUDE.md` for org-wide context.

## What this is

A shared **75 Hard challenge tracker** for a small group (Travis + friends/family), with a soft-penalty scoring rule, per-person nutrition goals (broken out by meal), body-weight goal tracking, progress-photo history, a friends system for photo-based accountability, daily motivational quotes, a day-complete celebration, and a daily 9am push-notification reminder. Visual style is a single dark theme (no light mode), modeled after Frame.io.

**Stack:** Vanilla JS single-page app, same pattern as `mindmeter/` — no build step, no framework. `server.js` is the entire backend; `index.html` is the entire frontend. Login is name + 4-6 digit PIN (no email, no real auth — this is low-stakes and scoped to people you trust). One intentional npm dependency: **`web-push`** (see the Push notifications section) — everything else is still Node built-ins only. Run `npm install` once before first use.

**Run locally:**
```
cd 75hard
npm install            # one-time: installs web-push
node server.js         # serves on http://localhost:3000
```

## Architecture

- `server.js` — Node built-ins only (`http`, `fs`, `crypto`), no npm dependencies. Persists state to a JSON file (`data/data.json` by default, override with `DATA_DIR` env var) plus progress-photo files under `data/photos/`. Key endpoints:
  - `POST /api/login` — creates a user on first use (hashes the PIN with a per-user salt), validates PIN on return visits.
  - `GET /api/state?name=&pin=` — full state: the caller's task history, nutrition, friends, and everyone's group summary.
  - `POST /api/toggle` — flips one checkbox task for one date (not `photo` — see below).
  - `POST /api/goals` — sets a user's goal mode (`standard`/`bulk`) + calorie/protein targets.
  - `POST /api/food/add`, `POST /api/food/remove` — daily food log entries.
  - `POST /api/weight/goal` — sets/updates unit + Day 1 weight + goal weight. `POST /api/weight/log`, `POST /api/weight/log/remove` — daily weigh-ins.
  - `POST /api/photo`, `GET /api/photo`, `POST /api/photo/remove` — progress photo upload/fetch/delete. Fetch is access-controlled: viewable only by the owner or a confirmed friend.
  - `POST /api/friends/request`, `/accept`, `/decline`, `/remove`, `GET /api/directory` — mutual friend graph.
  - `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe` — daily 9am reminder push notifications (see dedicated section below).
  - `POST /api/restart` — manual full wipe of a user's history (not triggered automatically — see scoring rule below).
  - Static: `GET /manifest.json`, `GET /sw.js`, `GET /icons/*` — PWA install + service-worker files, served from `STATIC_FILES` in `server.js` (not a general static-file server; add new static assets to that map, don't build a generic file server for this app).
- `index.html` — all CSS/JS inline, single-page app with two client-side tabs (`#tab-today` / `#tab-progress`, toggled via `switchTab()` — no routing, no page reload). **Today** tab: quote of the day → checklist/photo/nutrition/body weight (with a motivational quote strip between each card) → progress → 75-day calendar → friends → group table. **Progress** tab: every progress photo in chronological order. A photo-viewing modal (`openPhotoModal()`) is shared by both — calendar cells and Progress-tab thumbnails both open it.

## The scoring rule (important — this diverges from "real" 75 Hard)

Standard 75 Hard resets you to Day 1 on any missed day. **This tracker does not do that.** Per the user's explicit request:

> Instead of restarting if you miss a day, 2 days are added to the total if all goals are not met for 1 day.

So: `targetDays = 75 + 2 × missedDays`, and progress (`completedDays`) never zeroes out — it just needs to reach a growing target. This logic lives in `computeStatus()` in `server.js`. Only *finalized* past days (before today) count as "missed"; today is never judged incomplete while still in progress.

## Day boundary: local midnight, not UTC

"Today" is computed per-user at **local midnight**, not server/UTC midnight — a UTC-based boundary flips the date up to several hours off from what's actually on a user's clock (mid-evening for anyone west of UTC), which visibly undercounted `dayNumber` the day after someone started. The client detects its own IANA zone once (`LOCAL_TZ` in `index.html`, via `Intl.DateTimeFormat().resolvedOptions().timeZone` — the same trick already used for push scheduling) and sends it as `tz` on every request (`api()` auto-injects it into POST bodies; `loadState()` appends it to the `/api/state` query string). `authenticate()` in `server.js` persists it to `user.timezone`, kept fresh on every request rather than fixed at signup. `todayStr(timeZone)` computes the date via `localDateKey()` (an `Intl`/`toLocaleDateString('en-CA', …)` call) in that zone, falling back to UTC only when no timezone is known yet (pre-feature accounts that haven't made a request since). Every handler that needs "today" — state, toggle, goals, food, weight, photo, restart, and `startDate` at signup — reads `user.timezone`, not the server clock.

**One-time data fix for accounts predating this fix**: `migrateDayBoundary()` in `server.js` runs once at boot (guarded by `data.dayBoundaryMigrated`, so it can never fire twice) and repairs accounts whose `startDate`/day record got filed under `2026-09-03` by the old UTC-based logic instead of the correct `2026-09-02`. It's intentionally left in permanently rather than run-and-delete, since it's inert after the first boot and self-documents what happened. Skips (and leaves for manual review) any account that already has real data on the corrected date.

## Nutrition instead of a blanket "diet" checkbox

People in the same group are cutting, bulking, or maintaining, so "follow a diet" isn't a single checkbox — each user sets their own daily calorie + protein target (`POST /api/goals`), logs food throughout the day, and a day's nutrition is "met" when protein clears the target and calories land within ±10%/±100 (whichever is larger) of it, in either direction. See `nutritionStatus()`.

Food entries are tagged with a `meal` (`breakfast`/`lunch`/`dinner`, see `MEALS` in `server.js`) — `POST /api/food/add` requires and validates it. The UI (`renderNutritionTracker()`) groups entries into three sections with per-meal subtotals; daily totals/targets stay aggregated across all three (`foodTotals()` sums the whole day regardless of meal — that part is unchanged).

## Goal mode flexes the workout requirement

`user.goals.mode` is `'standard'` (2 workouts/day, one outdoors — the original 75 Hard rule) or `'bulk'` (1 workout/day, strength & hypertrophy focus — per the user's request, since two-a-days fight muscle growth). `tasksForUser()` picks `STANDARD_TASKS` or `BULK_TASKS` accordingly, and this determines both the checklist shown and what counts toward `dayComplete()`. Applied retroactively across a user's history (goals aren't versioned per-day) — same simplification as the nutrition targets above.

## Progress photos

The `photo` task is **not a manual toggle** — `POST /api/toggle` rejects it. Completion is derived from an actual uploaded image (`day.photo = {ext, uploadedAt}`), stored as a file under `data/photos/`, named by a hash of the owner's key + date (not the raw key, just to keep filesystem paths predictable). `GET /api/photo` streams it back, gated to the owner or a confirmed friend. No new server endpoint was needed for the two features below — both are read entirely from data `/api/state` already returns.

- **Take photo vs. choose from library**: the Today card has two separate hidden `<input type="file">` elements (`photo-camera-input` has `capture="environment"`, `photo-library-input` doesn't) behind two explicit buttons, both funneled through the shared `handlePhotoFile()` uploader. That function guards on `creds` being non-null in the (async) `FileReader.onload` callback — a user can log out while a large file is still being read, and without the guard the stale closure throws trying to read `creds.name`.
- **Progress tab** (`renderProgressTimeline()`): every date in `me.days` with a `.photo`, in **ascending** date order (oldest first — a before-to-now progression, the opposite order from the friend/group photo strips, which are newest-first) with a "Day N" badge (`dayNumberFor()`) and that day's weight if logged. This replaced an earlier "My photos" grid embedded in the Your Progress card — don't re-add that; the Progress tab is the one place for browsing your own photo history now, and the calendar section links to it.
- **Calendar click-to-view** (`openPhotoModal()` / `#photo-modal-backdrop`): clicking any past-or-today calendar cell, or any Progress-tab thumbnail, opens a shared lightbox modal showing that day's photo (or a "no photo logged" empty state). Closes via the × button, backdrop click, or Escape. **Gotcha already hit once**: give `[hidden]` elements an explicit `[hidden] { display: none; }` override wherever you also set a non-`none` `display` on the same selector (as `.photo-modal-backdrop` does for its `flex` layout) — otherwise the attribute-based hide silently loses to the class rule's specificity and the element stays visible.

## Body weight

Per the user's request: record your weight on Day 1, and set a goal weight for Day 75. This is **purely informational and private** — `computeStatus()`/`dayComplete()` never look at it, it's not shown to friends or in the group table (unlike everything else, body weight is treated as sensitive-by-default), and it has no bearing on scoring.

- `user.weightGoal = { unit: 'lb'|'kg', startWeight, goalWeight }`, set via `POST /api/weight/goal`. Setting it also seeds `user.days[user.startDate].weight = startWeight` (if that day doesn't already have an entry) so Day 1 shows up in the history automatically.
- Day-to-day weigh-ins live on `user.days[date].weight` (a plain number), the same day-scoped pattern as food/photo — `POST /api/weight/log` / `POST /api/weight/log/remove`.
- "Current weight" (client-side, `renderWeightTracker()` in `index.html`) is the most recent logged entry ≤ today, falling back to `startWeight` if nothing's been logged since Day 1. Progress toward goal is `(current - start) / (goal - start)`, clamped 0–100% — this formula works unmodified whether the goal is a loss (`goal < start`) or a gain (`goal > start`).
- Validated ranges live in `WEIGHT_RANGE` in `server.js` (50–700 lb / 20–320 kg) — sanity bounds, not real limits.

## Journal

A third top-level tab (`#tab-journal`, alongside Today/Progress — `switchTab()` in `index.html` now takes three states) for free-text reflection: your goals, your "why" for doing 75 Hard, how the challenge is changing you. Per the user's request, it's **one entry per day** and, like body weight, **purely private** — `friendSummary()`/`publicUser()`/the group table never include it, and it's excluded from `tasksForUser()`/`dayComplete()`/`computeStatus()` entirely, so it has no bearing on scoring.

- `user.days[date].journal` (a plain string), the same day-scoped pattern as weight/food/photo. `POST /api/journal/save` (`{name, pin, tz, date, text}`) upserts it — there's no separate remove endpoint; saving with empty/whitespace-only text deletes the key instead of storing a blank string, so clearing today's box and hitting Save is how you undo an entry.
- The Journal tab shows only **today's** entry as an editable textarea (prefilled with `me.days[TODAY].journal` if present, capped at `JOURNAL_MAX_LENGTH` = 4000 chars both client- and server-side), with three prompt suggestions shown above it (why / goals / how the challenge has bettered you) — hints only, not required or validated.
- Every other day with a saved entry lives behind a "Past Journal Entries" button, which opens a modal (`openJournalHistory()`, sharing the `.journal-modal-*` styling pattern established for the friend-photo gallery) listing them newest-first, each labeled "Day N" + full date, full text shown with `white-space: pre-wrap` (not truncated).

## Friends (accountability)

`user.friends` / `user.incoming` / `user.outgoing` form a simple mutual-request graph (see `/api/friends/*`). `GET /api/state` returns `me.friends` as rich summaries (`friendSummary()` in `server.js`) — each friend's today checklist breakdown, nutrition status, and **full** progress-photo history (newest first, no cap) — so the Friends card shows both whether they're hitting today's goals and lets you browse back through their photos, not just a leaderboard number. The flat "Group" table (all registered users, lightweight) is kept separately for a quick overview; Friends is the detailed, opt-in accountability view.

## Persistence on Railway

`data/` is gitignored — it's runtime state, not source, and now includes both `data.json` and uploaded photo files. On Railway, the filesystem is ephemeral across redeploys, so **attach a Railway Volume** mounted at (e.g.) `/app/data` and set `DATA_DIR=/app/data` in the service's environment variables, or logged progress and photos will be lost on every deploy.

## Tasks (the checkbox rules)

Defined in `server.js` as `STANDARD_TASKS` / `BULK_TASKS` (picked per-user by `tasksForUser()`) and returned to the client via `/api/state` — don't hardcode a task list in `index.html`. The client treats the `photo` key specially (upload UI, not a checkbox); every other task key renders as a generic checkbox row.

## Motivational quotes

`QUOTES` in `index.html` is a static bank of short attributed sayings — per the user's request, all 28 are from David Goggins, Ronnie Coleman, or Arnold Schwarzenegger (only genuinely-documented lines; Larry Wheels was asked for too but skipped for now, see the note in the session that made this change — not enough well-attested quotable material to include him without risking a fabricated attribution). Selection is entirely client-side and deterministic per UTC calendar date: `quotesForToday(dateStr, 5)` hashes the date string and Fisher-Yates shuffles the bank with that seed, so everyone in the group sees the same "quote of the day" (rendered prominently above the Today card) and the same 4 divider quotes between the other cards, and they only change once a day — not on every reload. `QUOTES` is also duplicated byte-for-byte in `server.js` for the push notification (see Push notifications section below) — edit both if you touch the bank.

## Push notifications: daily 9am reminder

Per the user's explicit request, each subscribed device gets a push notification at **9am in that device's own local timezone** (not one fixed server time), saying "75 Hard — stay locked in" plus the quote of the day.

- **The one intentional dependency**: `web-push` (`package.json`). Implementing Web Push's payload encryption (RFC 8291) and VAPID auth (RFC 8292) by hand would be a lot of fiddly crypto code to get exactly right for a feature that has to actually work — using the standard, well-vetted library was the deliberate tradeoff against this project's usual zero-dependency rule. Don't add further dependencies without a similarly strong reason; this app should otherwise stay boring/built-in.
- **VAPID keys** are generated once (`ensureVapidKeys()`) and persisted as `data.vapid = {publicKey, privateKey}` in the same JSON store as everything else — not env vars, so a fresh clone/deploy just works with zero config, consistent with the rest of the app. `GET /api/push/vapid-key` exposes only the public half.
- **Subscriptions** live per-user at `user.pushSubscriptions[]`, each `{ endpoint, keys: {p256dh, auth}, timezone, lastSentDate, createdAt }`, deduped by `endpoint`. `timezone` is whatever `Intl.DateTimeFormat().resolvedOptions().timeZone` reports client-side at subscribe time — validated server-side by trying to construct an `Intl.DateTimeFormat` with it (invalid IANA strings throw).
- **The scheduler** (`tickPushScheduler()`, `setInterval` every 30s from server boot) computes each subscription's current local `HH:mm` and local calendar date (`en-CA` locale trick for a clean `YYYY-MM-DD`), and sends when the local time reads exactly `09:00` **and** `lastSentDate` isn't already today's date for that subscription — that guard is what prevents a duplicate send within the same minute-window and survives server restarts (it's persisted, not in-memory). `lastSentDate` is set *before* the async send call resolves, deliberately, so a slow send can't cause a second attempt later in the same tick.
- **Same quote-of-the-day algorithm exists twice**: `QUOTES` + the hash/shuffle picker in `server.js` is a byte-for-byte copy of the one in `index.html`, so the push notification's quote matches what the app shows that day. **Edit both if you ever touch the quotes bank or the picker logic** — there is no shared module to import from (no build step), so this is a deliberate, documented duplication, not an oversight.
- **Expired subscriptions self-clean**: a `404`/`410` from the push service means the browser unregistered it — the scheduler removes it from `user.pushSubscriptions` on that response so it stops retrying forever.
- **Client-side gating** (`initNotifyCard()` in `index.html`) shows one of four states in a small card above the quote of the day: unsupported browsers get nothing (card stays `hidden`); iOS Safari not running as an installed PWA gets an "Add to Home Screen" instructional card (iOS only allows web push for installed home-screen apps — a bare Safari tab cannot receive it at all, no workaround); a supported context with no active subscription gets an "Enable" button; an active subscription shows "reminder is on" with a "Turn off" button.
- **Shared-device self-healing**: whenever `initNotifyCard()` runs and the browser already has a push subscription (from `pushManager.getSubscription()`), it silently re-POSTs that subscription under whichever account is *currently* logged in. So if two people share one phone, the reminder always belongs to whoever's logged in when the app was last opened on that device — there's no explicit "this subscription belongs to user X" conflict UI, it just always re-claims on load.
- **Icons**: `icons/icon-192.png`, `icons/icon-512.png`, `icons/apple-touch-icon.png` are generated with Pillow — black badge with a violet radial glow and violet border ring, bold white "75" in Impact with a black outline and a slight italic shear for a tougher look (per the user's request; went through a "75" wordmark on a flat violet gradient and a white flame-silhouette mark before landing here — a real person's photo was considered and declined along the way, since using someone's likeness as product branding without rights is a real exposure, not just a style choice). No in-repo generation script; see git history if you need to regenerate or tweak them.
- Manual testing note: a real Notification-permission grant requires an actual interactive click in a real browser — it cannot be scripted or automated (that's the platform's security model working as intended), so the subscribe flow always needs a live human test on a real device, not just an automated one.

## Pull-to-refresh (installed-PWA only)

`display: standalone` (the installed/home-screen mode) opts out of the browser chrome that gives a regular mobile tab its native pull-to-refresh gesture, so it's hand-rolled: an IIFE near the end of `index.html`'s script, gated on the same `isStandalone` check `initNotifyCard()` uses (so a normal browser tab is untouched — it already has this gesture, and layering a second one on top would fight the native behavior). Tracks `touchstart`/`touchmove`/`touchend` on `document`, only engages when a downward drag starts with the page already scrolled to the very top, shows a damped pull indicator (`#ptr-indicator`) that reads "Pull to refresh" → "Release to refresh" as it crosses the threshold, and triggers a real `location.reload()` on release past that point — deliberately a full reload (matching "refreshing a website," which is what was asked for) rather than a lighter in-place `loadState()`.

## Visual design: single dark theme, Frame.io-inspired

Per explicit request, this is **dark-only** — there's no light-mode branch (no `prefers-color-scheme`/`data-theme` handling), unlike the `dataviz`-skill convention used elsewhere. All colors are CSS custom properties on `:root` in `index.html`'s `<style>` block (`--page`, `--surface`, `--surface-2`, `--accent`/`--accent-2` violet, `--good` emerald, `--critical` red, etc.) — change the palette there, not by hunting for hardcoded hex values in rules. `body` layers a couple of soft radial-gradient violet glows behind the page for the ambient look; `.card`/`.qotd` use a subtle linear-gradient + `box-shadow: var(--shadow)` for depth.

**No emoji anywhere in the UI** — a small inline SVG line-icon set (`ICONS.camera`, `.cameraLg`, `.image`, `.check`) replaces what used to be 📷/🖼️/✅/⏳/💪. Keep new icons in that same set (stroke-based, `currentColor`, ~1.8 stroke-width) rather than reaching for emoji or an icon font/library.

## Day-complete celebration

When `me.status.todayComplete` flips from `false` to `true` within a session (checking the last remaining task, hitting a nutrition target, or uploading the day's photo — whichever completes it), `celebrateDayComplete()` fires: a brief pulse on the Today banner (`.celebrate`, CSS `@keyframes celebrate-pulse`) plus a small burst of rising/fading sparkle dots (`.confetti-piece`, `@keyframes sparkle-rise`), auto-removed after ~1s. Respects `prefers-reduced-motion`.

The transition is tracked via the module-level `lastTodayComplete` var in `index.html`, compared each time `renderTasks()` runs (i.e., after every mutating API call reloads state). It's seeded to `null` on login/page-load specifically so reloading an *already*-complete day doesn't replay the celebration — only a live `false → true` flip does. Reset to `null` on logout so a fresh login doesn't inherit the previous user's transition state.
