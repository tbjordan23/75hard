// 75 Hard Tracker — server.js
// Node.js HTTP server + tiny JSON-file datastore. No external dependencies.
// Serves index.html for the page and a small JSON API for auth + daily task updates.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const PHOTO_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

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

// ---------- date helpers (all in UTC, YYYY-MM-DD strings) ----------

function todayStr() {
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
// breakdown, nutrition status, and their most recent progress photos.
function friendSummary(friendKey, friendUser, today) {
  const status = computeStatus(friendUser, today);
  const tasks = tasksForUser(friendUser);
  const todayRec = (friendUser.days || {})[today] || {};
  const todayTasks = tasks.map(t => ({ key: t.key, label: t.label, done: !!todayRec[t.key] }));
  const photoDates = Object.keys(friendUser.days || {})
    .filter(d => d <= today && friendUser.days[d] && friendUser.days[d].photo)
    .sort()
    .reverse()
    .slice(0, 5);

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

function authenticate(data, name, pin) {
  const key = normalizeName(name);
  const user = data.users[key];
  if (!user || hashPin(String(pin || ''), user.salt) !== user.pinHash) return null;
  // Defensively backfill fields for users created before a given feature shipped.
  user.days = user.days || {};
  user.goals = user.goals || null;
  user.friends = user.friends || [];
  user.incoming = user.incoming || [];
  user.outgoing = user.outgoing || [];
  return { key, user };
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

    // Login / register: creates a user on first use, validates PIN on subsequent uses.
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req);
      const key = normalizeName(body.name);
      const pin = String(body.pin || '');
      if (!key) return sendJson(res, 400, { error: 'Name is required.' });
      if (!/^\d{4,6}$/.test(pin)) return sendJson(res, 400, { error: 'PIN must be 4-6 digits.' });

      const data = loadData();
      let user = data.users[key];
      if (!user) {
        const salt = makeSalt();
        user = {
          displayName: String(body.name).trim(),
          salt,
          pinHash: hashPin(pin, salt),
          startDate: todayStr(),
          days: {},
          goals: null,
          friends: [],
          incoming: [],
          outgoing: [],
        };
        data.users[key] = user;
        saveData(data);
      } else {
        if (hashPin(pin, user.salt) !== user.pinHash) {
          return sendJson(res, 401, { error: 'Wrong PIN for that name.' });
        }
      }
      return sendJson(res, 200, { ok: true, key, name: user.displayName });
    }

    // Full state for the logged-in user: their task history + everyone's group summary.
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const data = loadData();
      const auth = authenticate(data, url.searchParams.get('name'), url.searchParams.get('pin'));
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const today = todayStr();
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
        today,
        me: {
          key: auth.key,
          name: user.displayName,
          startDate: user.startDate,
          goals: user.goals,
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
      const auth = authenticate(data, body.name, body.pin);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      const task = String(body.task || '');
      const taskKeys = tasksForUser(user).map(t => t.key).filter(k => k !== 'photo');
      if (task === 'photo') return sendJson(res, 400, { error: 'Upload a photo instead of toggling — see POST /api/photo.' });
      if (!taskKeys.includes(task)) return sendJson(res, 400, { error: 'Unknown task.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr();
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
      const auth = authenticate(data, body.name, body.pin);
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

      const today = todayStr();
      return sendJson(res, 200, { ok: true, goals: user.goals, tasks: tasksForUser(user), status: computeStatus(user, today) });
    }

    // Add one food log entry to a given date.
    if (req.method === 'POST' && url.pathname === '/api/food/add') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      const date = String(body.date || '');
      const label = String(body.label || '').trim().slice(0, 120) || 'Food';
      const calories = Number(body.calories);
      const protein = Number(body.protein);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr();
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
      const auth = authenticate(data, body.name, body.pin);
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

      const today = todayStr();
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
      const auth = authenticate(data, body.name, body.pin);
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
      const auth = authenticate(data, body.name, body.pin);
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
      const auth = authenticate(data, body.name, body.pin);
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
      const auth = authenticate(data, body.name, body.pin);
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
      const auth = authenticate(data, body.name, body.pin);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'Bad date.' });
      const today = todayStr();
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
      const auth = authenticate(data, body.name, body.pin);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { key, user } = auth;

      const date = String(body.date || '');
      const rec = user.days[date];
      if (rec && rec.photo) {
        try { fs.unlinkSync(photoFilePath(key, date, rec.photo.ext)); } catch (e) {}
        delete rec.photo;
        saveData(data);
      }
      const today = todayStr();
      const status = computeStatus(user, today);
      return sendJson(res, 200, { ok: true, day: user.days[date] || {}, status });
    }

    // Explicit full wipe, in case someone wants to abandon their history and start
    // completely over. This is manual only — a missed day no longer triggers this
    // automatically; it just adds 2 days to the target instead (see computeStatus).
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      const body = await readBody(req);
      const data = loadData();
      const auth = authenticate(data, body.name, body.pin);
      if (!auth) return sendJson(res, 401, { error: 'Not authenticated.' });
      const { user } = auth;

      user.startDate = todayStr();
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

server.listen(PORT, () => {
  console.log(`75 Hard tracker listening on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
