require('dotenv').config();

const express  = require('express');
const webpush  = require('web-push');
const cron     = require('node-cron');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

// ── VAPID key setup ───────────────────────────────────────────────────────────
// On Render: keys come from environment variables (set in dashboard).
// Locally: generated on first run and saved to .env.
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
    console.log('⚠️  Could not write .env — keys live in memory only (restart will regenerate them)');
  }
  console.log('🔑 VAPID public key:', keys.publicKey);
} else {
  console.log('🔑 VAPID public key loaded from env:', process.env.VAPID_PUBLIC_KEY);
}

webpush.setVapidDetails(
  'mailto:hello@jojo.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Data file ─────────────────────────────────────────────────────────────────
// NOTE: On Render free tier the filesystem is ephemeral — data.json is wiped
// on every restart/sleep cycle. The frontend re-subscribes and re-syncs on
// every page load, so data is restored as soon as Jomana opens the app.
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return d;
  } catch {
    return {};
  }
}

function saveData(d) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
  } catch (e) {
    console.error('❌ Could not write data.json:', e.message);
  }
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
  // Server runs on UTC — convert to Saudi Arabia time (UTC+3)
  const now   = new Date();
  const saudiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 180) % 1440;
  const [sh, sm] = (settings.quietStart || '23:00').split(':').map(Number);
  const [eh, em] = (settings.quietEnd   || '08:00').split(':').map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start > end
    ? (saudiMinutes >= start || saudiMinutes < end)
    : (saudiMinutes >= start && saudiMinutes < end);
}

// ── Push helper ───────────────────────────────────────────────────────────────
async function push(subscription, title, body) {
  console.log(`📤 Attempting push: "${body}"`);
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body }));
    console.log(`✅ Push sent successfully: "${body}"`);
  } catch (err) {
    console.error(`❌ Push failed — status: ${err.statusCode}, body: ${err.body}`);
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('🗑️  Subscription expired/gone — removing from data.json');
      const data = loadData();
      delete data.subscription;
      saveData(data);
    }
  }
}

// ── Friend rotation ───────────────────────────────────────────────────────────
function advancePick(data) {
  const week    = isoWeek(new Date());
  const friends = (data.friends || []).filter(f => f.active !== false);
  if (friends.length === 0) return null;

  if (data.currentPick && data.currentPick.isoWeek === week) {
    return friends.find(f => f.id === data.currentPick.id) || null;
  }

  let queue = (data.friendQueue || []).filter(id => friends.some(f => f.id === id));
  if (queue.length === 0) queue = shuffle(friends.map(f => f.id));

  const nextId     = queue.shift();
  data.friendQueue = queue;
  data.currentPick = { id: nextId, isoWeek: week };
  return friends.find(f => f.id === nextId) || null;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function runScheduler() {
  const now          = new Date();
  // All schedule comparisons use Saudi Arabia time (UTC+3)
  const saudiMs      = now.getTime() + 3 * 60 * 60 * 1000;
  const saudi        = new Date(saudiMs);
  const hhmm         = String(saudi.getUTCHours()).padStart(2,'0') + ':' + String(saudi.getUTCMinutes()).padStart(2,'0');
  const dayOfWeek    = saudi.getUTCDay();
  const today        = `${saudi.getUTCFullYear()}-${String(saudi.getUTCMonth()+1).padStart(2,'0')}-${String(saudi.getUTCDate()).padStart(2,'0')}`;
  const week         = isoWeek(saudi);
  console.log(`⏰ Cron tick — UTC:${now.toISOString()} | Saudi:${hhmm} day:${dayOfWeek}`);

  const data = loadData();
  const s    = data.settings || {};

  if (!s.masterOn) {
    console.log('⏭️  Skip: masterOn is off');
    return;
  }
  if (!data.subscription) {
    console.log('⏭️  Skip: no push subscription saved');
    return;
  }
  if (isQuiet(s)) {
    console.log('⏭️  Skip: quiet hours active');
    return;
  }
  let changed     = false;

  console.log(`📋 State — day:${dayOfWeek}, time:${hhmm}, week:${week}, friends:${(data.friends||[]).length}, family:${(data.family||[]).length}`);

  if (!data.sentToday) data.sentToday = { familyIds: {}, friendWeek: null };

  // ── Friends: one push per week ──
  const friendDay  = Number(s.friendDay ?? 5);
  const friendTime = s.friendTime || '09:00';
  console.log(`👯 Friend schedule — day:${friendDay}, time:${friendTime} | current day:${dayOfWeek}, current time:${hhmm} | sentThisWeek:${data.sentToday.friendWeek === week}`);

  if (dayOfWeek === friendDay && hhmm === friendTime && data.sentToday.friendWeek !== week) {
    console.log('👯 Friend schedule matched — picking friend...');
    const friend = advancePick(data);
    if (friend) {
      await push(data.subscription, 'JOJO 🍓', `Hey Jomana! Reach out to ${friend.name} this week 🍓`);
      data.sentToday.friendWeek = week;
      changed = true;
    } else {
      console.log('⏭️  No active friends to pick');
    }
  }

  // ── Family: per-member schedule ──
  for (const m of (data.family || [])) {
    if (m.active === false) { console.log(`⏭️  ${m.name}: paused`); continue; }
    if (!m.days.includes(dayOfWeek)) continue;
    if (m.time !== hhmm) continue;
    if (data.sentToday.familyIds[m.id] === today) { console.log(`⏭️  ${m.name}: already sent today`); continue; }

    console.log(`🏡 Family match: ${m.name}`);
    await push(data.subscription, 'JOJO 🍓', `Hey Jomana! Time to call ${m.name} today 🍓`);
    data.sentToday.familyIds[m.id] = today;
    changed = true;
  }

  if (changed) {
    saveData(data);
    console.log('💾 data.json updated');
  } else {
    console.log('ℹ️  No notifications sent this tick');
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors()); // open to all origins
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/health', (_req, res) => {
  const data = loadData();
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasSubscription: !!data.subscription,
    masterOn: !!(data.settings && data.settings.masterOn),
    friendCount: (data.friends || []).length,
    familyCount: (data.family  || []).length,
  });
});

app.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    console.error('❌ /subscribe: invalid body', req.body);
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const data = loadData();
  data.subscription = sub;
  saveData(data);
  console.log('✅ Push subscription saved — endpoint:', sub.endpoint.slice(0, 60) + '...');
  res.json({ ok: true });
});

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
  console.log(`✅ Schedule synced — masterOn:${!!(data.settings&&data.settings.masterOn)}, friends:${(data.friends||[]).length}, family:${(data.family||[]).length}`);
  res.json({ ok: true });
});

// ── Cron: every minute ────────────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
  runScheduler().catch(err => console.error('❌ Scheduler crash:', err));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🍓 JOJO server started on port ${PORT}`);
  console.log(`🕐 Server time: ${new Date().toISOString()}`);
  const data = loadData();
  console.log(`📦 data.json — subscription:${!!data.subscription}, masterOn:${!!(data.settings&&data.settings.masterOn)}, friends:${(data.friends||[]).length}, family:${(data.family||[]).length}`);
  console.log(`🔑 VAPID public key: ${process.env.VAPID_PUBLIC_KEY}\n`);
});
