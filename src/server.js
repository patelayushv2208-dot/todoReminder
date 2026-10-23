'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const mailer = require('./mailer');
const whatsapp = require('./whatsapp');
const {
  normalizeEmail, isEmail, normalizePhone, phoneCandidates, maskPhone,
  isValidTimezone, zonedToUtc, formatDue
} = require('./utils');

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';
const DEFAULT_TZ = isValidTimezone(process.env.DEFAULT_TIMEZONE) ? process.env.DEFAULT_TIMEZONE : 'Asia/Kolkata';
const REMINDER_MINUTES = Math.max(1, Number(process.env.WHATSAPP_REMINDER_MINUTES || 10));
const OVERDUE_LOOKBACK_HOURS = Math.max(1, Number(process.env.WHATSAPP_OVERDUE_LOOKBACK_HOURS || 48));
const MAX_WA_ATTEMPTS = 3;

/* ───────────────────────────── App setup ───────────────────────────── */
const app = express();
if (String(process.env.TRUST_PROXY || 'false') === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'upgrade-insecure-requests': null
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use((req, _res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

const limiterOpts = (windowMs, limit, message) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { success: false, message }
});
const authLimiter = limiterOpts(15 * 60 * 1000, Number(process.env.AUTH_RATE_LIMIT || 60), 'Too many attempts. Please wait a few minutes and try again.');
const otpLimiter = limiterOpts(15 * 60 * 1000, Number(process.env.OTP_RATE_LIMIT || 10), 'Too many OTP requests. Please wait a few minutes and try again.');
const testLimiter = limiterOpts(10 * 60 * 1000, 5, 'Too many test messages. Please wait a few minutes.');

/* ───────────────────────────── Models ───────────────────────────── */
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, unique: true, sparse: true },            // digits incl. country code, e.g. 919876543210
  passwordHash: { type: String, required: true },
  passwordChangedAt: { type: Date, default: () => new Date(0) },
  timezone: { type: String, default: DEFAULT_TZ },
  whatsappEnabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const User = mongoose.model('User', userSchema);

const resetSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  channel: { type: String, enum: ['email', 'whatsapp'], required: true },
  otpHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const PasswordReset = mongoose.model('PasswordReset', resetSchema);

const taskSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  desc: { type: String, default: '', maxlength: 220 },
  dueDate: { type: String, default: '' },
  dueTime: { type: String, default: '' },
  dueAt: { type: Date, default: null },                         // exact due moment (UTC) used by the reminder scheduler
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  category: { type: String, default: 'personal' },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  createdAt: { type: Number, required: true }
}, { timestamps: true, versionKey: false });
taskSchema.index({ completed: 1, dueAt: 1 });
const Task = mongoose.model('Task', taskSchema);

const waLogSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  taskId: { type: String, required: true, index: true },
  type: { type: String, enum: ['reminder', 'overdue'], required: true },
  status: { type: String, enum: ['pending', 'sent'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  lastError: { type: String, default: '' },
  sentAt: { type: Date, default: null }
}, { versionKey: false });
const WhatsAppLog = mongoose.model('WhatsAppLog', waLogSchema);

/* ───────────────────────────── Helpers ───────────────────────────── */
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = u => ({
  id: String(u._id), name: u.name, email: u.email, phone: u.phone || '',
  whatsappEnabled: u.whatsappEnabled !== false, timezone: u.timezone || DEFAULT_TZ
});
const pv = u => (u.passwordChangedAt ? new Date(u.passwordChangedAt).getTime() : 0);
const createToken = u => jwt.sign({ sub: String(u._id), pv: pv(u) }, JWT_SECRET, { expiresIn: '7d' });
const hashOtp = (userId, otp) => crypto.createHmac('sha256', JWT_SECRET).update(`${userId}:${otp}`).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tzOf = u => (isValidTimezone(u?.timezone) ? u.timezone : DEFAULT_TZ);

function validatePassword(password) {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password is too long.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain at least one letter and one number.';
  return '';
}

async function findUserByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  if (raw.includes('@')) return User.findOne({ email: normalizeEmail(raw) });
  const candidates = phoneCandidates(raw, DEFAULT_CC);
  if (!candidates.length) return null;
  return User.findOne({ phone: { $in: candidates } });
}

const auth = wrap(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail(res, 401, 'Please log in first.');
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return fail(res, 401, 'Your session has expired. Please log in again.'); }
  const user = await User.findById(payload.sub);
  if (!user || pv(user) !== (payload.pv || 0)) return fail(res, 401, 'Your session has expired. Please log in again.');
  req.user = user;
  next();
});

function buildTask(body, user, existing = null) {
  const title = String(body.title ?? existing?.title ?? '').trim();
  if (!title) return { error: 'Task title is required.' };
  if (title.length > 140) return { error: 'Task title is too long (max 140 characters).' };
  const desc = String(body.desc ?? existing?.desc ?? '').trim();
  if (desc.length > 220) return { error: 'Description is too long (max 220 characters).' };

  const dueDate = String(body.dueDate ?? existing?.dueDate ?? '').trim();
  let dueTime = String(body.dueTime ?? existing?.dueTime ?? '').trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return { error: 'Invalid due date.' };
  if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) return { error: 'Invalid due time.' };
  if (!dueDate) dueTime = '';

  let dueAt = null;
  if (dueDate) {
    const fromClient = body.dueAt ? new Date(body.dueAt) : null;
    dueAt = fromClient && !Number.isNaN(fromClient.getTime()) ? fromClient : zonedToUtc(dueDate, dueTime || '23:59', tzOf(user));
    if (!dueAt) return { error: 'Invalid due date.' };
  }

  const priority = ['low', 'medium', 'high'].includes(body.priority) ? body.priority : (existing?.priority || 'medium');
  const category = ['personal', 'work', 'study', 'shopping', 'other'].includes(String(body.category || '').toLowerCase())
    ? String(body.category).toLowerCase() : (existing?.category || 'personal');
  const completed = body.completed === undefined ? Boolean(existing?.completed) : Boolean(body.completed);
  const completedAt = completed ? (existing?.completedAt || new Date()) : null;
  return { value: { title, desc, dueDate, dueTime, dueAt, priority, category, completed, completedAt } };
}

/* ───────────────────────────── Routes: meta ───────────────────────────── */
app.get('/api/health', (_req, res) => res.json({
  success: true,
  database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  email: mailer.isConfigured() ? 'configured' : 'not_configured',
  whatsapp: whatsapp.isConfigured() ? 'configured' : 'not_configured',
  whatsappOtp: whatsapp.isOtpConfigured() ? 'configured' : 'not_configured',
  defaultCountryCode: DEFAULT_CC
}));

/* ───────────────────────────── Routes: auth ───────────────────────────── */
app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  const timezone = isValidTimezone(req.body.timezone) ? req.body.timezone : DEFAULT_TZ;

  if (name.length < 2) return fail(res, 400, 'Please enter your name.');
  if (!isEmail(email)) return fail(res, 400, 'Please enter a valid email address.');
  if (!phone) return fail(res, 400, 'Please enter a valid WhatsApp number with country code.');
  const pwError = validatePassword(password);
  if (pwError) return fail(res, 400, pwError);

  if (await User.exists({ email })) return fail(res, 409, 'An account with this email already exists. Please sign in.');
  if (await User.exists({ phone })) return fail(res, 409, 'An account with this phone number already exists. Please sign in.');

  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try { user = await User.create({ name, email, phone, passwordHash, timezone }); }
  catch (error) {
    if (error.code === 11000) return fail(res, 409, 'An account with this email or phone already exists.');
    throw error;
  }
  res.status(201).json({ success: true, token: createToken(user), user: publicUser(user) });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const identifier = String(req.body.identifier ?? req.body.email ?? '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) return fail(res, 400, 'Enter your email or phone number and password.');
  const user = await findUserByIdentifier(identifier);
  const ok = user && await bcrypt.compare(password, user.passwordHash);
  if (!ok) return fail(res, 401, 'Incorrect email/phone or password.');
  if (isValidTimezone(req.body.timezone) && req.body.timezone !== user.timezone) {
    user.timezone = req.body.timezone;
    await user.save();
  }
  res.json({ success: true, token: createToken(user), user: publicUser(user) });
}));

app.post('/api/auth/forgot-password', otpLimiter, wrap(async (req, res) => {
  const channel = req.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
  if (channel === 'email' && !mailer.isConfigured()) return fail(res, 503, 'Email OTP is not set up on this server yet. Add the SMTP settings in .env.');
  if (channel === 'whatsapp' && !whatsapp.isOtpConfigured()) return fail(res, 503, 'WhatsApp OTP is not set up on this server yet. Use Email OTP instead.');

  const user = await findUserByIdentifier(req.body.identifier);
  if (!user) return fail(res, 404, 'No MyToDo account found with this email or phone number.');
  if (channel === 'whatsapp' && !user.phone) return fail(res, 400, 'This account has no WhatsApp number saved. Use Email OTP.');

  const recent = await PasswordReset.findOne({ userId: String(user._id) }).sort({ createdAt: -1 });
  if (recent && Date.now() - new Date(recent.createdAt).getTime() < 30000) {
    return fail(res, 429, 'Please wait 30 seconds before requesting another OTP.');
  }

  const otp = String(crypto.randomInt(100000, 1000000));
  await PasswordReset.deleteMany({ userId: String(user._id) });
  const record = await PasswordReset.create({
    userId: String(user._id), channel, otpHash: hashOtp(String(user._id), otp),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });

  try {
    if (channel === 'email') await mailer.sendOtpEmail(user.email, user.name, otp);
    else await whatsapp.sendOtp(user.phone, otp);
  } catch (error) {
    await PasswordReset.deleteOne({ _id: record._id }).catch(() => {});
    console.error(`[otp:${channel}]`, error.message);
    const hint = channel === 'email'
      ? 'Could not send the email. Check the SMTP settings (Gmail needs an App Password).'
      : 'Could not send the WhatsApp message. Check the WhatsApp OTP template settings.';
    return fail(res, 502, hint);
  }

  const sentTo = channel === 'email' ? user.email.replace(/^(.).*(@.*)$/, '$1***$2') : maskPhone(user.phone);
  res.json({ success: true, channel, sentTo, message: `OTP sent to ${sentTo}. It expires in 10 minutes.` });
}));

app.post('/api/auth/reset-password', otpLimiter, wrap(async (req, res) => {
  const otp = String(req.body.otp || '').trim();
  const password = String(req.body.password || '');
  if (!/^\d{6}$/.test(otp)) return fail(res, 400, 'Enter the 6-digit OTP.');
  const pwError = validatePassword(password);
  if (pwError) return fail(res, 400, pwError);

  const user = await findUserByIdentifier(req.body.identifier);
  const invalid = () => fail(res, 400, 'OTP is invalid or expired. Request a new one.');
  if (!user) return invalid();
  const reset = await PasswordReset.findOne({ userId: String(user._id) });
  if (!reset || reset.expiresAt.getTime() < Date.now()) {
    if (reset) await reset.deleteOne();
    return invalid();
  }
  if (reset.attempts >= 5) {
    await reset.deleteOne();
    return fail(res, 429, 'Too many wrong attempts. Please request a new OTP.');
  }
  if (!safeEqual(hashOtp(String(user._id), otp), reset.otpHash)) {
    reset.attempts += 1;
    await reset.save();
    return fail(res, 400, `Incorrect OTP. ${Math.max(0, 5 - reset.attempts)} attempt(s) left.`);
  }
  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordChangedAt = new Date();
  await user.save();
  await PasswordReset.deleteMany({ userId: String(user._id) });
  res.json({ success: true, message: 'Password updated. You can sign in now.' });
}));

app.get('/api/auth/me', auth, (req, res) => res.json({ success: true, user: publicUser(req.user) }));

/* ───────────────────────────── Routes: settings / WhatsApp ───────────────────────────── */
app.put('/api/me/settings', auth, wrap(async (req, res) => {
  const user = req.user;
  const b = req.body;
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (name.length < 2 || name.length > 60) return fail(res, 400, 'Please enter a valid name.');
    user.name = name;
  }
  if (b.phone !== undefined) {
    if (b.phone === '' || b.phone === null) {
      user.phone = undefined;
    } else {
      const phone = normalizePhone(b.phone);
      if (!phone) return fail(res, 400, 'Please enter a valid WhatsApp number with country code.');
      const taken = await User.exists({ phone, _id: { $ne: user._id } });
      if (taken) return fail(res, 409, 'This phone number is already used by another account.');
      user.phone = phone;
    }
  }
  if (b.whatsappEnabled !== undefined) user.whatsappEnabled = Boolean(b.whatsappEnabled);
  if (b.timezone !== undefined && isValidTimezone(b.timezone)) user.timezone = b.timezone;
  try { await user.save(); }
  catch (error) {
    if (error.code === 11000) return fail(res, 409, 'This phone number is already used by another account.');
    throw error;
  }
  res.json({ success: true, user: publicUser(user) });
}));

app.get('/api/whatsapp/status', auth, (req, res) => res.json({
  success: true,
  serverConfigured: whatsapp.isConfigured(),
  hasNumber: Boolean(req.user.phone),
  enabled: req.user.whatsappEnabled !== false,
  reminderMinutes: REMINDER_MINUTES
}));

app.post('/api/whatsapp/test', auth, testLimiter, wrap(async (req, res) => {
  if (!whatsapp.isConfigured()) return fail(res, 503, 'WhatsApp is not configured on the server yet (see README).');
  if (!req.user.phone) return fail(res, 400, 'Add your WhatsApp number first.');
  try {
    await whatsapp.sendTaskReminder(req.user.phone, 'Test reminder from MyToDo', formatDue(new Date(), tzOf(req.user)));
  } catch (error) {
    console.error('[whatsapp:test]', error.message);
    return fail(res, 502, `WhatsApp could not deliver the test message: ${error.message}`);
  }
  res.json({ success: true, message: 'Test message sent. Check your WhatsApp.' });
}));

/* ───────────────────────────── Routes: tasks ───────────────────────────── */
app.get('/api/tasks', auth, wrap(async (req, res) => {
  const tasks = await Task.find({ userId: String(req.user._id) }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, tasks });
}));

app.post('/api/tasks', auth, wrap(async (req, res) => {
  const built = buildTask(req.body, req.user);
  if (built.error) return fail(res, 400, built.error);
  const created = await Task.create({ id: crypto.randomUUID(), userId: String(req.user._id), createdAt: Date.now(), ...built.value });
  res.status(201).json({ success: true, task: created.toObject() });
}));

app.put('/api/tasks/:id', auth, wrap(async (req, res) => {
  const existing = await Task.findOne({ id: req.params.id, userId: String(req.user._id) });
  if (!existing) return fail(res, 404, 'Task not found.');
  const built = buildTask(req.body, req.user, existing);
  if (built.error) return fail(res, 400, built.error);
  existing.set(built.value);
  await existing.save();
  res.json({ success: true, task: existing.toObject() });
}));

app.delete('/api/tasks/:id', auth, wrap(async (req, res) => {
  const deleted = await Task.findOneAndDelete({ id: req.params.id, userId: String(req.user._id) });
  if (!deleted) return fail(res, 404, 'Task not found.');
  res.json({ success: true });
}));

app.delete('/api/tasks', auth, wrap(async (req, res) => {
  const filter = { userId: String(req.user._id) };
  if (Array.isArray(req.body.ids)) filter.id = { $in: req.body.ids.map(String) };
  else filter.completed = true;
  const result = await Task.deleteMany(filter);
  res.json({ success: true, deletedCount: result.deletedCount });
}));

/* ───────────────────────────── WhatsApp scheduler ───────────────────────────── */
let schedulerRunning = false;

async function claimNotification(key, task, type) {
  try { await WhatsAppLog.updateOne({ key }, { $setOnInsert: { key, taskId: task.id, type } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  const now = new Date();
  return WhatsAppLog.findOneAndUpdate(
    {
      key, status: 'pending', attempts: { $lt: MAX_WA_ATTEMPTS },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }]
    },
    { $set: { lockedUntil: new Date(now.getTime() + 55000) }, $inc: { attempts: 1 } },
    { new: true }
  );
}

async function runWhatsAppScheduler() {
  if (schedulerRunning || !whatsapp.isConfigured() || mongoose.connection.readyState !== 1) return;
  schedulerRunning = true;
  try {
    const now = Date.now();
    const tasks = await Task.find({
      completed: false,
      dueAt: { $ne: null, $gte: new Date(now - OVERDUE_LOOKBACK_HOURS * 3600000), $lte: new Date(now + REMINDER_MINUTES * 60000) }
    }).lean();
    if (!tasks.length) return;

    const users = await User.find({ _id: { $in: [...new Set(tasks.map(t => t.userId))] } }).lean();
    const byId = new Map(users.map(u => [String(u._id), u]));

    for (const task of tasks) {
      const user = byId.get(task.userId);
      if (!user || user.whatsappEnabled === false || !user.phone) continue;
      const due = new Date(task.dueAt);
      const type = due.getTime() <= now ? 'overdue' : 'reminder';
      const key = `${type}:${task.id}:${due.getTime()}`;
      const claimed = await claimNotification(key, task, type);
      if (!claimed) continue;
      const dueText = formatDue(due, tzOf(user));
      try {
        if (type === 'overdue') await whatsapp.sendTaskOverdue(user.phone, task.title, dueText);
        else await whatsapp.sendTaskReminder(user.phone, task.title, dueText);
        await WhatsAppLog.updateOne({ key }, { $set: { status: 'sent', sentAt: new Date(), lastError: '' } });
        console.log(`[whatsapp] ${type} sent for task "${task.title}"`);
      } catch (error) {
        await WhatsAppLog.updateOne({ key }, { $set: { lastError: String(error.message).slice(0, 300) } });
        console.error(`[whatsapp] ${type} failed (attempt ${claimed.attempts}/${MAX_WA_ATTEMPTS}):`, error.message);
      }
    }
  } catch (error) {
    console.error('[whatsapp scheduler]', error.message);
  } finally {
    schedulerRunning = false;
  }
}

/** Old tasks created before v3 have no exact dueAt: compute it once. */
async function backfillDueAt() {
  const old = await Task.find({ dueDate: { $ne: '' }, dueAt: null }).lean();
  if (!old.length) return;
  const users = await User.find({ _id: { $in: [...new Set(old.map(t => t.userId))] } }).lean();
  const byId = new Map(users.map(u => [String(u._id), u]));
  let count = 0;
  for (const t of old) {
    const dueAt = zonedToUtc(t.dueDate, t.dueTime || '23:59', tzOf(byId.get(t.userId)));
    if (dueAt) { await Task.updateOne({ _id: t._id }, { $set: { dueAt } }); count++; }
  }
  console.log(`Migrated ${count} older task(s) to the new reminder format.`);
}

/* ───────────────────────────── Static + errors ───────────────────────────── */
app.use('/api', (_req, res) => fail(res, 404, 'Not found.'));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
app.get(/.*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Invalid request data.');
  if (err.type === 'entity.too.large') return fail(res, 413, 'Request is too large.');
  if (err.name === 'ValidationError') return fail(res, 400, Object.values(err.errors)[0]?.message || 'Invalid data.');
  console.error('[error]', err);
  fail(res, 500, 'Something went wrong on the server. Please try again.');
});

/* ───────────────────────────── Start ───────────────────────────── */
async function start() {
  if (!MONGODB_URI) { console.error('MONGODB_URI is missing. Copy .env.example to .env and fill it in.'); process.exit(1); }
  if (!JWT_SECRET || JWT_SECRET.length < 16) { console.error('JWT_SECRET is missing or too short (use at least 16 random characters).'); process.exit(1); }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    console.log('MongoDB connected successfully.');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
  await Promise.all([User.init(), Task.init(), WhatsAppLog.init(), PasswordReset.init()]).catch(e => console.error('Index warning:', e.message));
  await backfillDueAt().catch(e => console.error('Migration warning:', e.message));

  app.listen(PORT, () => {
    console.log(`MyToDo Pro running at http://localhost:${PORT}`);
    console.log(`Email OTP : ${mailer.isConfigured() ? 'configured' : 'NOT configured'}`);
    console.log(`WhatsApp  : ${whatsapp.isConfigured() ? 'configured' : 'NOT configured'} (OTP via WhatsApp: ${whatsapp.isOtpConfigured() ? 'yes' : 'no'})`);
    if (mailer.isConfigured()) mailer.verify().then(() => console.log('SMTP connection verified.')).catch(e => console.error('SMTP verification failed:', e.message));
    if (whatsapp.isConfigured()) {
      cron.schedule('* * * * *', runWhatsAppScheduler);
      runWhatsAppScheduler();
    }
  });
}

process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));
if (require.main === module) start();
module.exports = { app, start, runWhatsAppScheduler, User, Task, WhatsAppLog };
