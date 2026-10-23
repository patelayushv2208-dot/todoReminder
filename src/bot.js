'use strict';
/**
 * WhatsApp two-way bot for MyToDo: add / list / done.
 *
 * Mount once from server.js (after User, Task and tzOf are defined):
 *   require('./bot')({ app, User, Task, tzOf });
 *
 * Needs in .env:
 *   WHATSAPP_VERIFY_TOKEN  any random string you also type in Meta's webhook setup
 *   WHATSAPP_APP_SECRET    Meta app secret (App settings -> Basic). Used to verify that
 *                          calls really come from Meta. Without it every call is rejected.
 */
const crypto = require('crypto');
const { zonedToUtc, formatDue } = require('./utils');
const whatsapp = require('./whatsapp');

const LIST_SHOWN = 10;
const LIST_FETCH = 100;
const LIST_TTL_MS = 30 * 60 * 1000;
const SEEN_TTL_MS = 10 * 60 * 1000;
const TITLE_MAX = 140;

const lastLists = new Map(); // phone -> { ids: [task.id], at }
const seen = new Map();      // WhatsApp message id -> timestamp (Meta retries webhooks)

const HELP = [
  'MyToDo bot 👋',
  '',
  '• add Pay bill kal 6pm  (naya task)',
  '• add Gym aaj 18:30',
  '• list  (pending tasks)',
  '• done 2  (list ka task #2 complete)',
  '',
  'Time: 6pm, 6:30pm ya 18:30. Date: aaj, kal ya 2026-10-20.'
].join('\n');

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function todayIn(tz, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * "Pay bill kal 6pm" -> { title, dueDate, dueTime, dueAt } or { error }
 * Date words: aaj/today, kal/tomorrow, YYYY-MM-DD. Time: 6pm, 6:30 pm, 18:30.
 */
function parseAdd(raw, tz, now = Date.now()) {
  let text = ` ${raw} `;
  let date = null;
  let time = null;
  const today = todayIn(tz, now);
  let m;

  if ((m = text.match(/\s(\d{4}-\d{2}-\d{2})\s/))) {
    if (!isRealDate(m[1])) return { error: 'Ye date sahi nahi lag rahi. Aise likho: 2026-10-20' };
    date = m[1];
    text = text.replace(m[0], ' ');
  } else if ((m = text.match(/\s(aaj|today)\s/i))) {
    date = today;
    text = text.replace(m[0], ' ');
  } else if ((m = text.match(/\s(kal|tomorrow|tmrw)\s/i))) {
    date = addDays(today, 1);
    text = text.replace(m[0], ' ');
  }

  if ((m = text.match(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s/i))) {
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (h < 1 || h > 12 || min > 59) return { error: 'Time sahi nahi lag raha. Aise likho: 6pm ya 18:30' };
    const pm = m[3].toLowerCase() === 'pm';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    time = hhmm(h, min);
    text = text.replace(m[0], ' ');
  } else if ((m = text.match(/\s([01]?\d|2[0-3]):([0-5]\d)\s/))) {
    time = hhmm(Number(m[1]), Number(m[2]));
    text = text.replace(m[0], ' ');
  } else if (/\s\d{1,2}\s*baje\s/i.test(text)) {
    return { error: '"baje" ki jagah 6pm ya 18:30 likho, taaki AM/PM ka confusion na ho.' };
  }

  const title = text.replace(/\s+/g, ' ').trim().replace(/^task\b[\s:,-]*/i, '').trim();
  if (!title) return { error: 'Task ka naam likho, jaise: add Pay bill kal 6pm' };
  if (title.length > TITLE_MAX) return { error: `Naam ${TITLE_MAX} akshar se chhota rakho.` };

  if (!date && !time) return { title, dueDate: '', dueTime: '', dueAt: null };

  let dueDate = date || today;
  let dueAt = zonedToUtc(dueDate, time || '23:59', tz);
  if (!dueAt) return { error: 'Date/time samajh nahi aaya. Aise likho: add Pay bill kal 6pm' };

  if (!date && dueAt.getTime() <= now) {
    // only a time was given and it already passed today -> tomorrow
    dueDate = addDays(today, 1);
    dueAt = zonedToUtc(dueDate, time, tz);
  } else if (date && dueAt.getTime() < now - 60000) {
    return { error: 'Ye time nikal chuka hai. Aage ka time likho.' };
  }
  return { title, dueDate, dueTime: time || '', dueAt };
}

function remember(id) {
  if (!id) return true;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

function validSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) { console.error('[bot] WHATSAPP_APP_SECRET missing in .env, rejecting webhook call'); return false; }
  if (!req.rawBody) { console.error('[bot] req.rawBody missing: add the verify option to express.json (see setup steps)'); return false; }
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  const got = Buffer.from(req.get('x-hub-signature-256') || '');
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function send(to, text) {
  try { await whatsapp.sendText(to, text); }
  catch (error) { console.error('[bot] reply failed:', error.message); }
}

async function pendingFor(Task, user) {
  const tasks = await Task.find({ userId: String(user._id), completed: false })
    .sort({ createdAt: 1 }).limit(LIST_FETCH).lean();
  const key = t => (t.dueAt ? new Date(t.dueAt).getTime() : Infinity);
  return tasks.sort((a, b) => {
    const x = key(a), y = key(b);
    return x === y ? 0 : (x < y ? -1 : 1);
  });
}

async function handleMessage(msg, { User, Task, tzOf }) {
  const from = String(msg.from || '').replace(/\D/g, '');
  if (!from || !remember(msg.id)) return;

  const user = await User.findOne({ phone: from }).lean();
  if (!user) {
    return send(from, 'Is number se koi MyToDo account nahi mila. Pehle web app me signup karo (yahi WhatsApp number daalke), phir yahan message bhejo.');
  }
  if (user.whatsappEnabled === false) {
    return send(from, 'Aapke account me WhatsApp abhi band hai. Web app me chalu karke dobara try karo.');
  }
  if (msg.type !== 'text') return send(from, 'Abhi main sirf text samajhta hoon. "help" likho.');

  const text = String(msg.text?.body || '').trim();
  const [first = '', ...rest] = text.split(/\s+/);
  const cmd = first.toLowerCase().replace(/[:.!,]+$/, '');
  const arg = rest.join(' ').trim();
  const tz = tzOf(user);
  const userId = String(user._id);

  if (cmd === 'add' || cmd === 'new') {
    if (!arg) return send(from, 'Task ka naam likho, jaise: add Pay bill kal 6pm');
    const p = parseAdd(arg, tz);
    if (p.error) return send(from, `⚠️ ${p.error}`);
    await Task.create({
      id: crypto.randomUUID(), userId, title: p.title, desc: '',
      dueDate: p.dueDate, dueTime: p.dueTime, dueAt: p.dueAt,
      priority: 'medium', category: 'personal',
      completed: false, completedAt: null, createdAt: Date.now()
    });
    const when = p.dueAt ? `⏰ ${formatDue(p.dueAt, tz)}` : 'Koi time nahi diya, to reminder nahi aayega.';
    return send(from, `✅ Task add ho gaya: ${p.title}\n${when}`);
  }

  if (cmd === 'list' || cmd === 'tasks' || cmd === 'ls') {
    const all = await pendingFor(Task, user);
    if (!all.length) return send(from, '🎉 Koi pending task nahi hai.');
    const shown = all.slice(0, LIST_SHOWN);
    lastLists.set(from, { ids: shown.map(t => t.id), at: Date.now() });
    const now = Date.now();
    const lines = shown.map((t, i) => {
      const due = t.dueAt ? new Date(t.dueAt) : null;
      const when = due ? `\n    ⏰ ${formatDue(due, tz)}${due.getTime() < now ? ' ⚠️' : ''}` : '';
      return `${i + 1}. ${t.title}${when}`;
    });
    const extra = all.length > shown.length ? `\n(+${all.length - shown.length} aur tasks web app me)` : '';
    return send(from, `📝 Pending tasks:\n${lines.join('\n')}${extra}\n\nComplete karne ke liye: done 1`);
  }

  if (cmd === 'done' || cmd === 'complete') {
    const n = Number.parseInt(arg, 10);
    if (!Number.isInteger(n) || n < 1) return send(from, 'Aise likho: done 2 (pehle "list" bhejke number dekh lo).');
    const entry = lastLists.get(from);
    if (!entry || Date.now() - entry.at > LIST_TTL_MS) {
      return send(from, 'Pehle "list" bhejo, phir done <number> likho, taaki galat task complete na ho.');
    }
    const id = entry.ids[n - 1];
    if (!id) return send(from, `List me ${n} number ka task nahi hai.`);
    const task = await Task.findOneAndUpdate(
      { id, userId, completed: false },
      { $set: { completed: true, completedAt: new Date() } },
      { new: true }
    ).lean();
    return send(from, task ? `✅ Complete: ${task.title}` : 'Ye task pehle hi complete ho chuka hai ya mil nahi raha.');
  }

  return send(from, HELP);
}

function mountWhatsAppBot({ app, User, Task, tzOf }) {
  // Meta calls this once when you save the webhook in the developer dashboard.
  app.get('/webhook/whatsapp', (req, res) => {
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    return res.sendStatus(403);
  });

  app.post('/webhook/whatsapp', (req, res) => {
    if (!validSignature(req)) return res.sendStatus(403);
    res.sendStatus(200); // answer Meta fast, work after

    const ownNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const messages = [];
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const pid = change.value?.metadata?.phone_number_id;
        if (pid && ownNumberId && pid !== ownNumberId) continue;
        for (const msg of change.value?.messages || []) messages.push(msg);
      }
    }
    (async () => {
      for (const msg of messages) {
        try { await handleMessage(msg, { User, Task, tzOf }); }
        catch (error) { console.error('[bot]', error.message); }
      }
    })();
  });
}

mountWhatsAppBot.parseAdd = parseAdd;
module.exports = mountWhatsAppBot;