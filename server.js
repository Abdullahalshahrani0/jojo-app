require('dotenv').config();

const express  = require('express');
const webpush  = require('web-push');
const cron     = require('node-cron');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

// ── VAPID key setup ───────────────────────────────────────────────────────────
// Generate on first run and persist to .env
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY  = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  const envPath = path.join(__dirname, '.env');
  const line = `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`;
  try {
    fs.writeFileSync(envPath, line, { flag: 'w' });
    console.log('✅ Generated VAPID keys → .env');
  } catch {
    console.log('⚠️  Could not write .env — keys are in memory only (restart will regenerate)');
  }
  console.log('🔑 Public key:', keys.publicKey);
}

webpush.setVapidDetails(
  'mailto:hello@jojo.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Data file ─────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return d.getUTCFullYear() * 100 + Math.ceil((((d - y) / 86400000) + 1) / 7);
}

function todayStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isQuiet(settings) {
  if (!settings || !settings.quietHours) return false;
  const now   = new Date();
  const cur   = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = (settings.quietStart || '23:00').split(':').map(Number);
  const [eh, em] = (settings.quietEnd   || '08:00').split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start > end ? (cur >= start || cur < end) : (cur >= start && cur < end);
}

// ── Push helper ───────────────────────────────────────────────────────────────
async function push(subscription, title, body) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
    console.log(`📨 Sent: "${body}"`);
  } catch (err) {
    console.error('Push error', err.statusCode, err.body);
    // Subscription expired or gone — remove it
    if (err.statusCode === 410 || err.statusCode === 404) {
      const data = loadData();
      delete data.subscription;
      saveData(data);
      console.log('🗑️  Removed expired subscription');
    }
  }
}

// ── Friend rotation ───────────────────────────────────────────────────────────
function advancePick(data) {
  const week    = isoWeek(new Date());
  const friends = (data.friends || []).filter(f => f.active !== false);
  if (friends.length === 0) return null;

  // Same week — return existing pick
  if (data.currentPick && data.currentPick.isoWeek === week) {
    return (friends.find(f => f.id === data.currentPick.id) || null);
  }

  // New week — advance queue
  let queue = (data.friendQueue || []).filter(id => friends.some(f => f.id === id));
  if (queue.length === 0) queue = shuffle(friends.map(f => f.id));

  const nextId      = queue.shift();
  data.friendQueue  = queue;
  data.currentPick  = { id: nextId, isoWeek: week };
  return friends.find(f => f.id === nextId) || null;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function runScheduler() {
  const data = loadData();
  const s    = data.settings || {};

  if (!s.masterOn)       return;
  if (!data.subscription) return;
  if (isQuiet(s))        return;

  const now        = new Date();
  const dayOfWeek  = now.getDay();
  const hhmm       = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const today      = todayStr(now);
  const week       = isoWeek(now);
  let changed      = false;

  if (!data.sentToday) data.sentToday = { familyIds: {}, friendWeek: null };

  // ── Friends: one push per week ──
  const friendDay  = Number(s.friendDay ?? 5);
  const friendTime = s.friendTime || '09:00';

  if (dayOfWeek === friendDay && hhmm === friendTime && data.sentToday.friendWeek !== week) {
    const friend = advancePick(data);
    if (friend) {
      await push(data.subscription, 'JOJO 🍓', `Hey Jomana! Reach out to ${friend.name} this week 🍓`);
      data.sentToday.friendWeek = week;
      changed = true;
    }
  }

  // ── Family: per-member schedule ──
  for (const m of (data.family || [])) {
    if (m.active === false)                         continue;
    if (!m.days.includes(dayOfWeek))                continue;
    if (m.time !== hhmm)                            continue;
    if (data.sentToday.familyIds[m.id] === today)   continue;

    await push(data.subscription, 'JOJO 🍓', `Hey Jomana! Time to call ${m.name} today 🍓`);
    data.sentToday.familyIds[m.id] = today;
    changed = true;
  }

  if (changed) saveData(data);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Return VAPID public key to frontend
app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Save push subscription
app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const data = loadData();
  data.subscription = sub;
  saveData(data);
  console.log('✅ Push subscription saved');
  res.json({ ok: true });
});

// Save full schedule / state from frontend
app.post('/schedule', (req, res) => {
  const { settings, friends, family, friendQueue, currentPick, sentToday } = req.body;
  const data = loadData();
  if (settings    !== undefined) data.settings    = settings;
  if (friends     !== undefined) data.friends     = friends;
  if (family      !== undefined) data.family      = family;
  if (friendQueue !== undefined) data.friendQueue = friendQueue;
  if (currentPick !== undefined) data.currentPick = currentPick;
  if (sentToday   !== undefined) data.sentToday   = sentToday;
  saveData(data);
  res.json({ ok: true });
});

// ── Cron: every minute ────────────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  runScheduler().catch(err => console.error('Scheduler error:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍓 JOJO server running on http://localhost:${PORT}`);
});
