// 75 Hard Tracker — server.js
// Node.js HTTP server + tiny JSON-file datastore. The one intentional
// dependency is `web-push` (daily 9am reminder notifications) — implementing
// the Web Push encryption/VAPID protocol by hand is exactly the kind of thing
// not worth doing from scratch. Everything else stays Node built-ins.
// Serves index.html for the page and a small JSON API for auth + daily task updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const PHOTO_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:tbjordan@gmail.com';
// AI Scan (meal-photo calorie/protein estimation) calls the Claude API
// directly over fetch (built into Node 18+) rather than pulling in
// @anthropic-ai/sdk — one JSON POST doesn't earn a new dependency, unlike
// web-push's fiddly encryption/VAPID protocol. Requires ANTHROPIC_API_KEY;
// the feature cleanly reports itself unconfigured if it's unset.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const STATIC_FILES = {
  '/manifest.json': { file: path.join(__dirname, 'manifest.json'), type: 'application/manifest+json' },
  '/sw.js': { file: path.join(__dirname, 'sw.js'), type: 'application/javascript' },
  '/icons/icon-192.png': { file: path.join(__dirname, 'icons', 'icon-192.png'), type: 'image/png' },
  '/icons/icon-512.png': { file: path.join(__dirname, 'icons', 'icon-512.png'), type: 'image/png' },
  '/icons/apple-touch-icon.png': { file: path.join(__dirname, 'icons', 'apple-touch-icon.png'), type: 'image/png' },
};

// The checkbox rules of 75 Hard — but two of them flex per person:
//
// - "Follow a diet" is NOT a checkbox. People in the same group are cutting,
//   bulking, or maintaining, so it's replaced by a personal calorie/protein
//   tracker (see nutritionStatus) with its own per-user targets.
// - Workout count flexes with goal mode: standard mode keeps the original two
//   workouts/day (one outdoors); "bulk" mode swaps that for one strength &
//   hypertrophy-focused session/day, since two-a-days fight muscle growth.
//
// Both are configured via POST /api/goals and stored on user.goals.
const STANDARD_TASKS = [
  { key: 'workout1', label: 'Workout #1 — 45 minutes' },
  { key: 'workout2', label: 'Workout #2 — 45 minutes, outdoors' },
  { key: 'water', label: 'Drink 1 gallon of water' },
  { key: 'reading', label: 'Read 10 pages (non-fiction)' },
  { key: 'photo', label: 'Take a progress photo' },
];
const BULK_TASKS = [
  { key: 'workout1', label: 'Workout — 45+ min, strength & hypertrophy focus' },
  { key: 'water', label: 'Drink 1 gallon of water' },
  { key: 'reading', label: 'Read 10 pages (non-fiction)' },
  { key: 'photo', label: 'Take a progress photo' },
];

function tasksForUser(user) {
  return user.goals && user.goals.mode === 'bulk' ? BULK_TASKS : STANDARD_TASKS;
}

const MEALS = ['breakfast', 'lunch', 'dinner'];

// Body weight: purely informational, never counts toward dayComplete/scoring.
// A goal is a one-time setup (unit + starting weight + target weight by day
// 75); day-to-day entries are logged onto user.days[date].weight like food.
const WEIGHT_RANGE = { lb: [50, 700], kg: [20, 320] };
function validWeight(unit, n) {
  const range = WEIGHT_RANGE[unit] || WEIGHT_RANGE.lb;
  return Number.isFinite(n) && n >= range[0] && n <= range[1];
}

// ---------- motivational quotes (for the daily push notification) ----------
// MUST stay byte-for-byte identical to the QUOTES array in index.html — the
// deterministic per-date pick only matches what the app displays if both
// copies agree. If you edit one, edit the other.
const QUOTES = [
  { text: "Discipline is the bridge between goals and accomplishment.", author: "Jim Rohn" },
  { text: "Motivation is what gets you started. Habit is what keeps you going.", author: "Jim Ryun" },
  { text: "The successful warrior is the average man, with laser-like focus.", author: "Bruce Lee" },
  { text: "You don't have to be extreme, just consistent.", author: "Unknown" },
  { text: "Suffer the pain of discipline or suffer the pain of regret.", author: "Jim Rohn" },
  { text: "The pain you feel today will be the strength you feel tomorrow.", author: "Unknown" },
  { text: "It's supposed to be hard. If it wasn't hard, everyone would do it.", author: "Tom Hanks" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", author: "Will Durant" },
  { text: "The only bad workout is the one that didn't happen.", author: "Unknown" },
  { text: "Discipline equals freedom.", author: "Jocko Willink" },
  { text: "Don't count the days, make the days count.", author: "Muhammad Ali" },
  { text: "No one is going to come help you. No one's coming to save you.", author: "David Goggins" },
  { text: "The mind will always give up before the body.", author: "David Goggins" },
  { text: "You have to be able to endure hardship and pain.", author: "David Goggins" },
  { text: "It's not who's going to let me; it's who's going to stop me.", author: "Ayn Rand" },
  { text: "Champions keep playing until they get it right.", author: "Billie Jean King" },
  { text: "The difference between the impossible and the possible lies in a person's determination.", author: "Tommy Lasorda" },
  { text: "Whether you think you can or you think you can't, you're right.", author: "Henry Ford" },
  { text: "The body achieves what the mind believes.", author: "Napoleon Hill" },
  { text: "Strength does not come from winning. Your struggles develop your strengths.", author: "Arnold Schwarzenegger" },
  { text: "A champion is someone who gets up when they can't.", author: "Jack Dempsey" },
  { text: "Consistency is what transforms average into excellence.", author: "Unknown" },
  { text: "Do something today that your future self will thank you for.", author: "Unknown" },
  { text: "Small daily improvements are the key to staggering long-term results.", author: "Unknown" },
  { text: "The only way to finish is to start.", author: "Unknown" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Comfort is the enemy of progress.", author: "P.T. Barnum" },
  { text: "You are your only limit.", author: "Unknown" },
  { text: "What seems impossible today will one day become your warm-up.", author: "Unknown" },
  { text: "The cave you fear to enter holds the treasure you seek.", author: "Joseph Campbell" },
  { text: "Nothing will work unless you do.", author: "Maya Angelou" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin" },
  { text: "You will never always be motivated, so you must learn to be disciplined.", author: "Unknown" },
  { text: "The moment you want to quit is the moment you need to keep pushing.", author: "Unknown" },
  { text: "Effort only fully releases its reward after a person refuses to quit.", author: "Napoleon Hill" },
  { text: "Fall seven times, stand up eight.", author: "Japanese proverb" },
  { text: "Great things never came from comfort zones.", author: "Unknown" },
  { text: "Push yourself, because no one else is going to do it for you.", author: "Unknown" },
  { text: "One day or day one — you decide.", author: "Unknown" },
  { text: "Excuses don't get you results.", author: "Unknown" },
];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function quoteOfTheDay(dateStr) {
  const rand = mulberry32(hashStr(dateStr));
  const idxs = QUOTES.map((_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = idxs[i]; idxs[i] = idxs[j]; idxs[j] = tmp;
  }
  return QUOTES[idxs[0]];
}

// A day's calorie/protein target is "met" if protein clears the goal (protein
// minimums matter whether you're cutting or bulking) and calories land within
// this tolerance of the goal in either direction. Nobody without goals set yet
// is held to a nutrition requirement.
const CALORIE_TOLERANCE_PCT = 0.10;
const CALORIE_TOLERANCE_MIN = 100;

// ---------- datastore ----------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2));
}

function loadData() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read data file, starting fresh:', e);
    return { users: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// VAPID keys authenticate this server to push services (Google/Mozilla/Apple)
// for Web Push. Auto-generated once and persisted to the data store (which
// lives on the Railway volume) rather than requiring env-var setup — same
// zero-config philosophy as the rest of this app. Call once at boot.
function ensureVapidKeys() {
  const data = loadData();
  if (!data.vapid) {
    data.vapid = webpush.generateVAPIDKeys();
    saveData(data);
    console.log('Generated new VAPID keypair for push notifications.');
  }
  webpush.setVapidDetails(VAPID_CONTACT, data.vapid.publicKey, data.vapid.privateKey);
  return data.vapid;
}

// ---------- date helpers (YYYY-MM-DD strings) ----------
//
// "Today" is local-midnight-based, not UTC-based: a day boundary at UTC
// midnight would flip the date up to several hours off from what a user
// actually sees on their clock (e.g. it rolls over mid-evening for anyone
// west of UTC), which visibly undercounts a day-number the day after
// someone starts. Each user's IANA timezone (detected client-side via
// `Intl.DateTimeFormat().resolvedOptions().timeZone`, same trick already
// used for push-notification scheduling) is captured on login/requests and
// stored as user.timezone; todayStr() computes "today" in that zone,
// falling back to UTC only when no timezone is known yet (e.g. a request
// that predates this feature, or an invalid zone).

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch (e) { return false; }
}

function localDateKey(timeZone) {
  return new Date().toLocaleDateString('en-CA', { timeZone }); // en-CA -> YYYY-MM-DD
}

function todayStr(timeZone) {
  if (timeZone) {
    try { return localDateKey(timeZone); } catch (e) { /* fall through */ }
  }
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

// ---------- auth ----------

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

function makeSalt() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- progress photos ----------
// Stored as plain files on disk (not base64 in the JSON store, to keep that file
// small and fast to parse). Filenames use a hash of the owner's key rather than
// the key itself, just to keep filesystem paths predictable/safe.

function ensurePhotosDir() {
  if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

function ownerFileKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function photoFilePath(ownerKey, date, ext) {
  return path.join(PHOTOS_DIR, `${ownerFileKey(ownerKey)}_${date}.${ext}`);
}

function parseImageDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([a-zA-Z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');
  return { ext, buffer };
}

// ---------- nutrition ----------

function foodTotals(rec) {
  const food = (rec && rec.food) || [];
  return food.reduce((acc, f) => {
    acc.calories += Number(f.calories) || 0;
    acc.protein += Number(f.protein) || 0;
    return acc;
  }, { calories: 0, protein: 0 });
}

// Returns whether a given day's logged food meets the user's current goals.
// Goals are applied "as configured now" retroactively across history — simpler
// than versioning goals per-day, and goals are expected to change rarely.
function nutritionStatus(user, rec) {
  const totals = foodTotals(rec);
  const goals = user.goals;
  if (!goals || !goals.calories || !goals.protein) {
    return { required: false, met: true, calories: totals.calories, protein: totals.protein };
  }
  const tolerance = Math.max(CALORIE_TOLERANCE_MIN, goals.calories * CALORIE_TOLERANCE_PCT);
  const proteinOk = totals.protein >= goals.protein;
  const calorieOk = Math.abs(totals.calories - goals.calories) <= tolerance;
  return {
    required: true,
    met: proteinOk && calorieOk,
    calories: totals.calories,
    protein: totals.protein,
    calorieGoal: goals.calories,
    proteinGoal: goals.protein,
    calorieTolerance: Math.round(tolerance),
    proteinOk,
    calorieOk,
  };
}

// AI Scan: asks Claude to estimate a meal photo's calories/protein via a
// forced tool call, so the response is structured JSON rather than prose to
// parse. Best-effort by design — the prompt tells it never to refuse or ask
// a follow-up, since a rough estimate the user can correct beats a refusal.
async function estimateMealFromImage(mediaType, base64Data) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error('AI scan is not configured on this server (missing ANTHROPIC_API_KEY).');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const tool = {
    name: 'log_meal_estimate',
    description: 'Record a best-effort nutrition estimate for the meal shown in the photo.',
    input_schema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short description of the meal, e.g. "Grilled chicken, rice, broccoli".' },
        calories: { type: 'integer', description: 'Estimated total calories for everything shown.' },
        protein: { type: 'integer', description: 'Estimated total protein in grams for everything shown.' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How confident this estimate is.' },
      },
      required: ['label', 'calories', 'protein', 'confidence'],
    },
  };

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 512,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'log_meal_estimate' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            {
              type: 'text',
              text: 'Estimate calories and protein for the meal in this photo, for a personal fitness ' +
                "tracker. Give your best numeric estimate even if you're not fully certain — never refuse " +
                'or ask a follow-up question. If multiple items are visible, estimate the total for everything shown.',
            },
          ],
        }],
      }),
    });
  } catch (e) {
    const err = new Error('Could not reach the AI scan service.');
    err.code = 'API_ERROR';
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('Anthropic API error', res.status, text.slice(0, 500));
    const err = new Error('AI scan request failed (' + res.status + ').');
    err.code = 'API_ERROR';
    throw err;
  }

  const json = await res.json();
  const toolUse = (json.content || []).find(b => b.type === 'tool_use' && b.name === 'log_meal_estimate');
  const input = toolUse && toolUse.input;
  const calories = input && Math.round(Number(input.calories));
  const protein = input && Math.round(Number(input.protein));
  if (!input || !Number.isFinite(calories) || !Number.isFinite(protein)) {
    const err = new Error('AI scan could not produce an estimate for that photo.');
    err.code = 'NO_ESTIMATE';
    throw err;
  }

  return {
    label: String(input.label || 'Meal').trim().slice(0, 120) || 'Meal',
    calories: Math.min(10000, Math.max(0, calories)),
    protein: Math.min(1000, Math.max(0, protein)),
    confidence: ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'medium',
  };
}

function dayComplete(user, rec) {
  const tasks = tasksForUser(user);
  const checksOk = tasks.every(t => !!(rec && rec[t.key]));
  return checksOk && nutritionStatus(user, rec).met;
}

// ---------- 75-hard (soft-penalty variant) status computation ----------
// No reset-to-day-1. Instead: every fully-passed day (yesterday or earlier) that
// wasn't 100% complete adds 2 days to the total required, but progress keeps
// accumulating rather than zeroing out. Today is never judged as "missed" while
// it's still in progress — only finalized past days count against you.
function computeStatus(user, today) {
  const days = user.days || {};
  let completedDays = 0;
  let missedDays = 0;
  const completeByDate = {};

  if (user.startDate) {
    let cursor = user.startDate;
    while (cursor < today) {
      const rec = days[cursor] || {};
      const complete = dayComplete(user, rec);
      completeByDate[cursor] = complete;
      if (complete) completedDays += 1; else missedDays += 1;
      cursor = addDays(cursor, 1);
    }
  }

  const todayRec = days[today] || {};
  const todayTasksComplete = tasksForUser(user).every(t => !!todayRec[t.key]);
  const todayNutrition = nutritionStatus(user, todayRec);
  const todayComplete = todayTasksComplete && todayNutrition.met;
  completeByDate[today] = todayComplete;
  if (todayComplete) completedDays += 1;

  const targetDays = 75 + 2 * missedDays;
  const dayNumber = user.startDate ? daysBetween(user.startDate, today) + 1 : 1;
  const finished = completedDays >= targetDays;

  return {
    dayNumber,
    completedDays,
    missedDays,
    targetDays,
    remaining: Math.max(0, targetDays - completedDays),
    todayTasksComplete,
    todayNutrition,
    todayComplete,
    finished,
    completeByDate,
  };
}

function publicUser(name, user, today) {
  const status = computeStatus(user, today);
  return {
    name: user.displayName,
    dayNumber: status.dayNumber,
    completedDays: status.completedDays,
    missedDays: status.missedDays,
    targetDays: status.targetDays,
    remaining: status.remaining,
    todayComplete: status.todayComplete,
    finished: status.finished,
    startDate: user.startDate,
    mode: user.goals && user.goals.mode === 'bulk' ? 'bulk' : 'standard',
  };
}

// Richer view of one friend for the accountability panel: today's task-by-task
// breakdown, nutrition status, and their full progress-photo history (newest
// first) — not just the latest one, so you can browse back through it.
function friendSummary(friendKey, friendUser, today) {
  const status = computeStatus(friendUser, today);
  const tasks = tasksForUser(friendUser);
  const todayRec = (friendUser.days || {})[today] || {};
  const todayTasks = tasks.map(t => ({ key: t.key, label: t.label, done: !!todayRec[t.key] }));
  const photoDates = Object.keys(friendUser.days || {})
    .filter(d => d <= today && friendUser.days[d] && friendUser.days[d].photo)
    .sort()
    .reverse();

  return {
    key: friendKey,
    name: friendUser.displayName,
    mode: friendUser.goals && friendUser.goals.mode === 'bulk' ? 'bulk' : 'standard',
    dayNumber: status.dayNumber,
    completedDays: status.completedDays,
    targetDays: status.targetDays,
    missedDays: status.missedDays,
    finished: status.finished,
    todayComplete: status.todayComplete,
    today: { tasks: todayTasks, nutrition: status.todayNutrition },
    photoDates,
  };
}

// ---------- HTTP helpers ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes) {
  const limit = maxBytes || 1e6;
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function authenticate(data, name, pin, tz) {
  const key = normalizeName(name);
  const user = data.users[key];
  if (!user || hashPin(String(pin || ''), user.salt) !== user.pinHash) return null;
  // Defensively backfill fields for users created before a given feature shipped.
  user.days = user.days || {};
  user.goals = user.goals || null;
  user.friends = user.friends || [];
  user.incoming = user.incoming || [];
  user.outgoing = user.outgoing || [];
  user.weightGoal = user.weightGoal || null;
  user.pushSubscriptions = user.pushSubscriptions || [];
  user.timezone = user.timezone || null;
  // Every authenticated request from the client carries its device's current
  // IANA zone (see LOCAL_TZ in index.html) — keep it fresh so "today" tracks
  // wherever the user actually is, not just whatever it was at signup.
  let tzChanged = false;
  if (tz && isValidTimezone(tz) && tz !== user.timezone) {
    user.timezone = tz;
    tzChanged = true;
  }
  return { key, user, tzChanged };
}

function resolveUser(data, name) {
  const key = normalizeName(name);
  const user = data.users[key];
  if (!user) return null;
  user.days = user.days || {};
  user.goals = user.goals || null;
  user.friends = user.friends || [];
  user.incoming = user.incoming || [];
  user.outgoing = user.outgoing || [];
  user.weightGoal = user.weightGoal || null;
  user.pushSubscriptions = user.pushSubscriptions || [];
  return { key, user };
}

// ---------- request handler ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // PWA static files (manifest, service worker, icons) — needed for "Add to
    // Home Screen" installability and for the service worker to receive pushes.
    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      const entry = STATIC_FILES[url.pathname];
      if (!fs.existsSync(entry.file)) { res.writeHead(404); return res.end('Not found'); }
      const buf = fs.readFileSync(entry.file);
      const headers = { 'Content-Type': entry.type, 'Content-Length': buf.length };
      if (url.pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      return res.end(buf);
    }

    // The public half of the VAPID keypair — needed client-side to subscribe.
    // Not a secret; the private half never leaves the server.
    if (req.method === 'GET' && url.pathname === '/api/push/vapid-key') {
      return sendJson(res, 200, { publicKey: ensureVapidKeys().publicKey });
    }

    // Register (or update) a push subscription for the logged-in user's device.
    // Dedupes by endpoint — resubscribing the same device updates its timezone
    // instead of creating a duplicate entry.
    if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const sub = body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
        return sendJson(res, 400, { error: 'Invalid push subscription.' });
      }
      const timezone = String(body.timezone || '');
      if (!isValidTimezone(timezone)) return sendJson(res, 400, { error: 'Invalid timezone.' });

      const existing = user.pushSubscriptions.find(s => s.endpoint === sub.endpoint);
      if (existing) {
        existing.keys = sub.keys;
        existing.timezone = timezone;
      } else {
        user.pushSubscriptions.push({
          endpoint: sub.endpoint,
          keys: sub.keys,
          timezone,
          lastSentDate: null,
          createdAt: new Date().toISOString(),
        });
      }
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // Unsubscribe one device from push (user turned reminders off on that device).
    if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const endpoint = String(body.endpoint || '');
      user.pushSubscriptions = user.pushSubscriptions.filter(s => s.endpoint !== endpoint);
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // Login / register: creates a user on first use, validates PIN on subsequent uses.
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const key = normalizeName(body.name);
      const pin = String(body.pin || '');
      if (!key) return sendJson(res, 400, { error: 'Name is required.' });
      if (!/^\d{4,6}$/.test(pin)) return sendJson(res, 400, { error: 'PIN must be 4-6 digits.' });

      const data = loadData();
      let user = data.users[key];
      const tz = isValidTimezone(body.tz) ? body.tz : null;
      if (!user) {
        const salt = makeSalt();
        user = {
          displayName: String(body.name).trim(),
          salt,
          pinHash: hashPin(pin, salt),
          startDate: todayStr(tz),
          days: {},
          goals: null,
          friends: [],
          incoming: [],
          outgoing: [],
          weightGoal: null,
          pushSubscriptions: [],
          timezone: tz,
        };
        data.users[key] = user;
        saveData(data);
      } else {
        if (hashPin(pin, user.salt) !== user.pinHash) {
          return sendJson(res, 401, { error: 'Wrong PIN for that name.' });
        }
        if (tz && tz !== user.timezone) { user.timezone = tz; saveData(data); }
      }
      return sendJson(res, 200, { ok: true, key, name: user.displayName });
    }

    // Full state for the logged-in user: their task history + everyone's group summary.
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const data = loadData();
      const auth = authenticate(data, url.searchParams.get('name'), url.searchParams.get('pin'), url.searchParams.get('tz'));
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;
      if (auth.tzChanged) saveData(data);

      const today = todayStr(user.timezone);
      const status = computeStatus(user, today);
      const group = Object.entries(data.users)
        .map(([k, u]) => publicUser(k, u, today))
        .sort((a, b) => b.completedDays - a.completedDays || a.name.localeCompare(b.name));

      const friends = user.friends
        .map(k => (data.users[k] ? friendSummary(k, data.users[k], today) : null))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      const incomingRequests = user.incoming
        .map(k => (data.users[k] ? { key: k, name: data.users[k].displayName } : null))
        .filter(Boolean);
      const outgoingRequests = user.outgoing
        .map(k => (data.users[k] ? { key: k, name: data.users[k].displayName } : null))
        .filter(Boolean);

      return sendJson(res, 200, {
        tasks: tasksForUser(user),
        meals: MEALS,
        today,
        me: {
          key: auth.key,
          name: user.displayName,
          startDate: user.startDate,
          goals: user.goals,
          weightGoal: user.weightGoal,
          days: user.days,
          status,
          friends,
          incomingRequests,
          outgoingRequests,
        },
        group,
      });
    }

    // Toggle one task for one date for the logged-in user.
    if (req.method === 'POST' && url.pathname === '/api/toggle') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      const task = String(body.task || '');
      const taskKeys = tasksForUser(user).map(t => t.key).filter(k => k !== 'photo');
      if (task === 'photo') return sendJson(res, 400, { error: 'Upload a photo instead of toggling — see POST /api/photo.' });
      if (!taskKeys.includes(task)) return sendJson(res, 400, { error: 'Unknown task.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr(user.timezone);
      if (date > today) return sendJson(res, 400, { error: 'Cannot log a future day.' });
      if (date < user.startDate) return sendJson(res, 400, { error: 'Before your start date.' });

      user.days[date] = user.days[date] || {};
      user.days[date][task] = !user.days[date][task];
      saveData(data);

      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date], status });
    }

    // Set or update a user's goal mode + calorie/protein targets.
    if (req.method === 'POST' && url.pathname === '/api/goals') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const mode = body.mode === 'bulk' ? 'bulk' : 'standard';
      const calories = Number(body.calories);
      const protein = Number(body.protein);
      if (!Number.isFinite(calories) || calories <= 0 || calories > 20000) {
        return sendJson(res, 400, { error: 'Enter a valid calorie target.' });
      }
      if (!Number.isFinite(protein) || protein <= 0 || protein > 1000) {
        return sendJson(res, 400, { error: 'Enter a valid protein target.' });
      }

      user.goals = { mode, calories: Math.round(calories), protein: Math.round(protein) };
      saveData(data);

      const today = todayStr(user.timezone);
      return sendJson(res, 200, { ok: true, goals: user.goals, tasks: tasksForUser(user), status: computeStatus(user, today) });
    }

    // Set or update the weight goal: unit + Day 1 starting weight + target by
    // day 75. Purely informational — never affects dayComplete/scoring. Also
    // seeds user.days[startDate].weight with the starting weight if that day
    // doesn't already have a logged entry, so Day 1 shows up in the history.
    if (req.method === 'POST' && url.pathname === '/api/weight/goal') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const unit = body.unit === 'kg' ? 'kg' : 'lb';
      const startWeight = Number(body.startWeight);
      const goalWeight = Number(body.goalWeight);
      if (!validWeight(unit, startWeight)) return sendJson(res, 400, { error: 'Enter a valid starting weight.' });
      if (!validWeight(unit, goalWeight)) return sendJson(res, 400, { error: 'Enter a valid goal weight.' });

      user.weightGoal = {
        unit,
        startWeight: Math.round(startWeight * 10) / 10,
        goalWeight: Math.round(goalWeight * 10) / 10,
      };
      user.days[user.startDate] = user.days[user.startDate] || {};
      if (user.days[user.startDate].weight === undefined) {
        user.days[user.startDate].weight = user.weightGoal.startWeight;
      }
      saveData(data);
      return sendJson(res, 200, { ok: true, weightGoal: user.weightGoal, days: user.days });
    }

    // Log (or overwrite) one day's weigh-in.
    if (req.method === 'POST' && url.pathname === '/api/weight/log') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      if (!user.weightGoal) return sendJson(res, 400, { error: 'Set your weight goal first.' });
      const date = String(body.date || '');
      const weight = Number(body.weight);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr(user.timezone);
      if (date > today) return sendJson(res, 400, { error: 'Cannot log a future day.' });
      if (date < user.startDate) return sendJson(res, 400, { error: 'Before your start date.' });
      if (!validWeight(user.weightGoal.unit, weight)) return sendJson(res, 400, { error: 'Enter a valid weight.' });

      user.days[date] = user.days[date] || {};
      user.days[date].weight = Math.round(weight * 10) / 10;
      saveData(data);
      return sendJson(res, 200, { ok: true, day: user.days[date] });
    }

    // Remove one day's weigh-in (e.g. to fix a typo).
    if (req.method === 'POST' && url.pathname === '/api/weight/log/remove') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      if (user.days[date]) delete user.days[date].weight;
      saveData(data);
      return sendJson(res, 200, { ok: true, day: user.days[date] || {} });
    }

    // AI Scan: send a meal photo to Claude for a best-effort calorie/protein
    // estimate. Returns the estimate to the client to review/edit — it never
    // writes to the food log itself, that still goes through POST
    // /api/food/add once the user taps "Add" on the (possibly-edited) result.
    if (req.method === 'POST' && url.pathname === '/api/food/ai-scan') {
      const body = await readBody(req, MAX_PHOTO_BYTES + 100000);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      if (auth.tzChanged) saveData(data);

      const parsed = parseImageDataUrl(body.dataUrl);
      if (!parsed) return sendJson(res, 400, { error: 'Unsupported image format (use JPG, PNG, WEBP, or GIF).' });
      if (parsed.buffer.length > MAX_PHOTO_BYTES) return sendJson(res, 400, { error: 'Image too large (max 6MB).' });

      try {
        const estimate = await estimateMealFromImage(PHOTO_MIME[parsed.ext], parsed.buffer.toString('base64'));
        return sendJson(res, 200, { ok: true, estimate });
      } catch (err) {
        console.error('AI scan failed:', err.message);
        const code = err.code === 'NOT_CONFIGURED' ? 501 : 502;
        return sendJson(res, code, { error: err.message || 'AI scan failed — enter the meal manually instead.' });
      }
    }

    // Add one food log entry to a given date.
    if (req.method === 'POST' && url.pathname === '/api/food/add') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      const label = String(body.label || '').trim().slice(0, 120) || 'Food';
      const meal = MEALS.includes(body.meal) ? body.meal : null;
      const calories = Number(body.calories);
      const protein = Number(body.protein);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      if (!meal) return sendJson(res, 400, { error: 'Meal must be breakfast, lunch, or dinner.' });
      const today = todayStr(user.timezone);
      if (date > today) return sendJson(res, 400, { error: 'Cannot log a future day.' });
      if (date < user.startDate) return sendJson(res, 400, { error: 'Before your start date.' });
      if (!Number.isFinite(calories) || calories < 0 || calories > 10000) {
        return sendJson(res, 400, { error: 'Enter valid calories.' });
      }
      if (!Number.isFinite(protein) || protein < 0 || protein > 1000) {
        return sendJson(res, 400, { error: 'Enter valid protein.' });
      }

      user.days[date] = user.days[date] || {};
      user.days[date].food = user.days[date].food || [];
      user.days[date].food.push({
        id: crypto.randomUUID(),
        label,
        meal,
        calories: Math.round(calories),
        protein: Math.round(protein),
      });
      saveData(data);

      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date], status });
    }

    // Remove one food log entry from a given date.
    if (req.method === 'POST' && url.pathname === '/api/food/remove') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      const id = String(body.id || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const rec = user.days[date];
      if (rec && Array.isArray(rec.food)) {
        rec.food = rec.food.filter(f => f.id !== id);
      }
      saveData(data);

      const today = todayStr(user.timezone);
      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date] || {}, status });
    }

    // Everyone registered, except yourself — for picking who to send a friend request to.
    if (req.method === 'GET' && url.pathname === '/api/directory') {
      const data = loadData();
      const auth = authenticate(data, url.searchParams.get('name'), url.searchParams.get('pin'));
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const people = Object.entries(data.users)
        .filter(([k]) => k !== auth.key)
        .map(([k, u]) => ({ key: k, name: u.displayName }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { people });
    }

    // Send a friend request. If the other person already requested you, this
    // instead auto-accepts and the two of you become friends immediately.
    if (req.method === 'POST' && url.pathname === '/api/friends/request') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const target = resolveUser(data, body.friendName);
      if (!target) return sendJson(res, 404, { error: 'No one registered with that name.' });
      if (target.key === key) return sendJson(res, 400, { error: "You can't friend yourself." });

      if (user.friends.includes(target.key)) {
        return sendJson(res, 200, { ok: true, alreadyFriends: true });
      }
      if (user.incoming.includes(target.key)) {
        // They already asked us — accept instead of double-requesting.
        user.incoming = user.incoming.filter(k => k !== target.key);
        target.user.outgoing = target.user.outgoing.filter(k => k !== key);
        user.friends.push(target.key);
        target.user.friends.push(key);
      } else {
        if (!user.outgoing.includes(target.key)) user.outgoing.push(target.key);
        if (!target.user.incoming.includes(key)) target.user.incoming.push(key);
      }
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // Accept an incoming friend request.
    if (req.method === 'POST' && url.pathname === '/api/friends/accept') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const target = resolveUser(data, body.friendKey);
      if (!target || !user.incoming.includes(target.key)) {
        return sendJson(res, 400, { error: 'No pending request from that person.' });
      }
      user.incoming = user.incoming.filter(k => k !== target.key);
      target.user.outgoing = target.user.outgoing.filter(k => k !== key);
      if (!user.friends.includes(target.key)) user.friends.push(target.key);
      if (!target.user.friends.includes(key)) target.user.friends.push(key);
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // Decline an incoming request, or cancel one you sent — symmetric cleanup either way.
    if (req.method === 'POST' && url.pathname === '/api/friends/decline') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const target = resolveUser(data, body.friendKey);
      if (target) {
        user.incoming = user.incoming.filter(k => k !== target.key);
        user.outgoing = user.outgoing.filter(k => k !== target.key);
        target.user.incoming = target.user.incoming.filter(k => k !== key);
        target.user.outgoing = target.user.outgoing.filter(k => k !== key);
        saveData(data);
      }
      return sendJson(res, 200, { ok: true });
    }

    // Unfriend.
    if (req.method === 'POST' && url.pathname === '/api/friends/remove') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const target = resolveUser(data, body.friendKey);
      if (target) {
        user.friends = user.friends.filter(k => k !== target.key);
        target.user.friends = target.user.friends.filter(k => k !== key);
        saveData(data);
      }
      return sendJson(res, 200, { ok: true });
    }

    // Fetch a progress photo. Viewable by its owner, or by a confirmed friend.
    if (req.method === 'GET' && url.pathname === '/api/photo') {
      const data = loadData();
      const auth = authenticate(data, url.searchParams.get('name'), url.searchParams.get('pin'));
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });

      const owner = resolveUser(data, url.searchParams.get('owner'));
      const date = String(url.searchParams.get('date') || '');
      if (!owner) return sendJson(res, 404, { error: 'Unknown user.' });
      const isSelf = owner.key === auth.key;
      const isFriend = owner.user.friends.includes(auth.key);
      if (!isSelf && !isFriend) return sendJson(res, 403, { error: 'Not friends with that person.' });

      const rec = owner.user.days[date];
      if (!rec || !rec.photo) return sendJson(res, 404, { error: 'No photo for that day.' });
      const filePath = photoFilePath(owner.key, date, rec.photo.ext);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Photo file missing.' });
      const buf = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': PHOTO_MIME[rec.photo.ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(buf);
    }

    // Upload (or replace) today's — or any past day's — progress photo.
    if (req.method === 'POST' && url.pathname === '/api/photo') {
      const body = await readBody(req, MAX_PHOTO_BYTES + 100000);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr(user.timezone);
      if (date > today) return sendJson(res, 400, { error: 'Cannot log a future day.' });
      if (date < user.startDate) return sendJson(res, 400, { error: 'Before your start date.' });

      const parsed = parseImageDataUrl(body.dataUrl);
      if (!parsed) return sendJson(res, 400, { error: 'Unsupported image format (use JPG, PNG, WEBP, or GIF).' });
      if (parsed.buffer.length > MAX_PHOTO_BYTES) return sendJson(res, 400, { error: 'Image too large (max 6MB).' });

      ensurePhotosDir();
      user.days[date] = user.days[date] || {};
      const existing = user.days[date].photo;
      if (existing && existing.ext !== parsed.ext) {
        try { fs.unlinkSync(photoFilePath(key, date, existing.ext)); } catch (e) {}
      }
      fs.writeFileSync(photoFilePath(key, date, parsed.ext), parsed.buffer);
      user.days[date].photo = { ext: parsed.ext, uploadedAt: new Date().toISOString() };
      saveData(data);

      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date], status });
    }

    // Remove a progress photo from a given day.
    if (req.method === 'POST' && url.pathname === '/api/photo/remove') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const date = String(body.date || '');
      const rec = user.days[date];
      if (rec && rec.photo) {
        try { fs.unlinkSync(photoFilePath(key, date, rec.photo.ext)); } catch (e) {}
        delete rec.photo;
        saveData(data);
      }
      const today = todayStr(user.timezone);
      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date] || {}, status });
    }

    // Explicit full wipe, in case someone wants to abandon their history and start
    // completely over. This is manual only — a missed day no longer triggers this
    // automatically; it just adds 2 days to the target instead (see computeStatus).
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin, body.tz);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      user.startDate = todayStr(user.timezone);
      user.days = {};
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Server error.' });
  }
});

// ---------- daily 9am push reminder ----------
// Each device subscribed via /api/push/subscribe carries its own IANA
// timezone (detected client-side at subscribe time), so "9am" means 9am in
// THAT device's zone, not one fixed server time. Checked every 30s; a
// per-subscription `lastSentDate` (that device's local calendar date)
// guards against sending twice in the same 09:00 minute and survives
// server restarts since it's persisted with everything else.
function localHourMinute(timeZone) {
  return new Date().toLocaleString('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' });
}

async function tickPushScheduler() {
  const data = loadData();
  let changed = false;

  for (const key of Object.keys(data.users)) {
    const user = data.users[key];
    const subs = user.pushSubscriptions || [];
    for (const sub of subs) {
      let hm, dateKey;
      try {
        hm = localHourMinute(sub.timezone);
        dateKey = localDateKey(sub.timezone);
      } catch (e) {
        continue; // malformed timezone saved somehow — skip rather than crash the tick
      }
      if (hm !== '09:00' || sub.lastSentDate === dateKey) continue;

      sub.lastSentDate = dateKey; // mark first, so a slow/failed send can't cause a duplicate this tick
      changed = true;
      const quote = quoteOfTheDay(dateKey);
      const payload = JSON.stringify({
        title: '75 Hard — stay locked in',
        body: '“' + quote.text + '” — ' + quote.author,
      });
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload).catch(err => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          // Subscription is gone (browser unregistered it) — drop it so we stop retrying.
          user.pushSubscriptions = user.pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
          saveData(loadData_mergeRemoval(user, key));
        } else {
          console.error('Push send failed for', key, err && err.message);
        }
      });
    }
  }

  if (changed) saveData(data);
}

// Re-reads the latest data from disk and applies just this one user's current
// pushSubscriptions list, so a slow failed-send cleanup can't clobber writes
// made by other requests in between.
function loadData_mergeRemoval(user, key) {
  const fresh = loadData();
  if (fresh.users[key]) fresh.users[key].pushSubscriptions = user.pushSubscriptions;
  return fresh;
}

server.listen(PORT, () => {
  console.log(`75 Hard tracker listening on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  ensureVapidKeys();
  setInterval(tickPushScheduler, 30 * 1000);
});
