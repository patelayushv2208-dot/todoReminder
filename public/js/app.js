(function () {
  'use strict';

  /* ───────────── Helpers ───────────── */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TOKEN_KEY = 'mytodo_token';
  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  let token = store.get(TOKEN_KEY);
  let user = null, tasks = [], filter = 'all', editingId = null, health = {}, waStatus = null;
  const knownOverdue = new Set();
  const renderedIds = new Set();

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = name => `<svg class="ico"><use href="#i-${name}"/></svg>`;
  const pad = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const authView = $('#auth-view'), appView = $('#app-view');

  async function api(path, { method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'The server is taking too long. Please try again.' : 'Cannot reach the MyToDo server. Check your internet connection.');
    } finally { clearTimeout(timer); }
    let data = {};
    try { data = await res.json(); } catch { /* non-json */ }
    if (res.status === 401 && token && !path.startsWith('/auth/login')) {
      logout('Your session expired. Please sign in again.');
      throw new Error(data.message || 'Session expired.');
    }
    if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
    return data;
  }

  let toastTimer;
  function toast(text, type = '') {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function setBusy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }

  /* ───────────── Countries / phone ───────────── */
  const COUNTRIES = [
    ['IN', '🇮🇳', '91'], ['US', '🇺🇸', '1'], ['GB', '🇬🇧', '44'], ['AE', '🇦🇪', '971'], ['SA', '🇸🇦', '966'], ['PK', '🇵🇰', '92'],
    ['BD', '🇧🇩', '880'], ['NP', '🇳🇵', '977'], ['LK', '🇱🇰', '94'], ['AU', '🇦🇺', '61'], ['NZ', '🇳🇿', '64'], ['SG', '🇸🇬', '65'],
    ['MY', '🇲🇾', '60'], ['ID', '🇮🇩', '62'], ['PH', '🇵🇭', '63'], ['TH', '🇹🇭', '66'], ['JP', '🇯🇵', '81'], ['KR', '🇰🇷', '82'],
    ['CN', '🇨🇳', '86'], ['DE', '🇩🇪', '49'], ['FR', '🇫🇷', '33'], ['IT', '🇮🇹', '39'], ['ES', '🇪🇸', '34'], ['NL', '🇳🇱', '31'],
    ['RU', '🇷🇺', '7'], ['TR', '🇹🇷', '90'], ['EG', '🇪🇬', '20'], ['ZA', '🇿🇦', '27'], ['NG', '🇳🇬', '234'], ['KE', '🇰🇪', '254'],
    ['BR', '🇧🇷', '55'], ['MX', '🇲🇽', '52'], ['AR', '🇦🇷', '54'], ['QA', '🇶🇦', '974'], ['KW', '🇰🇼', '965'], ['OM', '🇴🇲', '968']
  ];
  const CC_BY_LENGTH = [...COUNTRIES].sort((a, b) => b[2].length - a[2].length);

  function fillCountrySelect(sel, selected) {
    sel.innerHTML = COUNTRIES.map(([iso, flag, code]) => `<option value="${code}" title="${iso}">${flag} +${code}</option>`).join('');
    sel.value = COUNTRIES.some(c => c[2] === selected) ? selected : '91';
  }

  /** Combine country code + typed number into "+<digits>". */
  function buildPhone(ccEl, inputEl) {
    const raw = inputEl.value.trim();
    if (!raw) return '';
    let d = raw.replace(/\D/g, '');
    if (raw.startsWith('+')) return '+' + d;
    if (d.startsWith('00')) return '+' + d.slice(2);
    d = d.replace(/^0+/, '');
    const cc = ccEl.value;
    if (d.startsWith(cc) && d.length - cc.length >= 9 && d.length - cc.length <= 11) return '+' + d; // user already typed the country code
    return '+' + cc + d;
  }
  const phoneOk = p => { const n = p.replace(/\D/g, ''); return n.length >= 8 && n.length <= 15; };

  function splitPhone(digits) {
    for (const [, , code] of CC_BY_LENGTH) {
      if (digits.startsWith(code) && digits.length - code.length >= 6 && digits.length - code.length <= 12) return { cc: code, national: digits.slice(code.length) };
    }
    return { cc: null, national: '+' + digits };
  }

  /* ───────────── Auth UI ───────────── */
  const msgEl = $('#auth-message');
  function setMsg(text, type = 'error') {
    msgEl.className = 'auth-message' + (text ? ` show ${type}` : '');
    msgEl.textContent = text || '';
  }
  function markInvalid(input, bad = true) {
    const wrap = input.closest('.input-wrap') || input;
    wrap.classList.toggle('invalid', bad);
  }
  function failField(input, text) {
    markInvalid(input);
    setMsg(text, 'error');
    input.focus();
    return false;
  }
  document.addEventListener('input', e => {
    if (e.target.matches('input, select')) { markInvalid(e.target, false); }
  });

  const MODES = {
    login: { eyebrow: 'WELCOME BACK', title: 'Sign in to MyToDo', sub: 'Use your email or phone number with your MyToDo password.' },
    register: { eyebrow: 'GET STARTED', title: 'Create your account', sub: 'Free forever. Your private workspace is ready in seconds.' },
    forgot: { eyebrow: 'ACCOUNT RECOVERY', title: 'Reset your password', sub: 'We will send a 6-digit OTP to verify it is you.' }
  };
  let mode = 'login', resendTimer = null;

  function setMode(next, keepMessage = false) {
    mode = next;
    $('#login-form').classList.toggle('hidden', next !== 'login');
    $('#register-form').classList.toggle('hidden', next !== 'register');
    $('#forgot-form').classList.toggle('hidden', next !== 'forgot');
    $('#auth-tabs').classList.toggle('hide', next === 'forgot');
    $('#auth-tabs').classList.toggle('register', next === 'register');
    $('#login-tab').classList.toggle('active', next !== 'register');
    $('#register-tab').classList.toggle('active', next === 'register');
    $('#login-tab').setAttribute('aria-selected', String(next !== 'register'));
    $('#register-tab').setAttribute('aria-selected', String(next === 'register'));
    $('#auth-eyebrow').textContent = MODES[next].eyebrow;
    $('#auth-title').textContent = MODES[next].title;
    $('#auth-subtitle').textContent = MODES[next].sub;
    if (!keepMessage) setMsg('');
    $$('.input-wrap.invalid').forEach(w => w.classList.remove('invalid'));
    if (next === 'forgot') resetForgotUi();
    const first = $(`#${next}-form input:not([type=hidden])`);
    if (first && window.innerWidth > 700) setTimeout(() => first.focus(), 60);
  }

  $('#login-tab').onclick = () => setMode('login');
  $('#register-tab').onclick = () => setMode('register');
  $('#go-register').onclick = () => setMode('register');
  $('#go-login').onclick = () => setMode('login');
  $('#back-login').onclick = () => setMode('login');
  $('#forgot-link').onclick = () => {
    const id = $('#login-identifier').value.trim();
    setMode('forgot');
    if (id) $('#forgot-identifier').value = id;
  };

  $$('.eye').forEach(btn => btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.target);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = icon(show ? 'eye-off' : 'eye');
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));

  function strengthOf(pw) {
    if (!pw) return { s: 0, label: 'Enter a password' };
    let s = 0;
    if (pw.length >= 8) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw) || pw.length >= 12) s++;
    if (pw.length < 8) s = Math.min(s, 1);
    s = Math.max(s, 1);
    return { s, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][s] };
  }
  function bindStrength(inputSel, meterSel) {
    const input = $(inputSel), meter = $(meterSel);
    input.addEventListener('input', () => {
      const r = strengthOf(input.value);
      meter.dataset.s = String(r.s);
      $('b', meter).textContent = r.label;
    });
  }
  bindStrength('#register-password', '#register-strength');
  bindStrength('#reset-password', '#reset-strength');

  function passwordError(pw) {
    if (pw.length < 8) return 'Password must be at least 8 characters.';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number.';
    return '';
  }
  const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  /* Login */
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const idEl = $('#login-identifier'), pwEl = $('#login-password'), btn = $('button[type=submit]', e.target);
    const identifier = idEl.value.trim();
    if (!identifier) return failField(idEl, 'Enter your email or phone number.');
    if (!pwEl.value) return failField(pwEl, 'Enter your password.');
    setMsg('');
    setBusy(btn, true);
    try {
      const d = await api('/auth/login', { method: 'POST', body: { identifier, password: pwEl.value, timezone: browserTz } });
      await startSession(d);
    } catch (err) { setMsg(err.message); }
    finally { setBusy(btn, false); }
  });

  /* Register */
  $('#register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const nameEl = $('#register-name'), emailEl = $('#register-email'), phoneEl = $('#register-phone');
    const pwEl = $('#register-password'), cfEl = $('#register-confirm'), btn = $('button[type=submit]', e.target);
    const name = nameEl.value.trim(), email = emailEl.value.trim(), phone = buildPhone($('#register-cc'), phoneEl);
    if (name.length < 2) return failField(nameEl, 'Please enter your name.');
    if (!emailOk(email)) return failField(emailEl, 'Please enter a valid email address.');
    if (!phone || !phoneOk(phone)) return failField(phoneEl, 'Please enter a valid WhatsApp number.');
    const pe = passwordError(pwEl.value);
    if (pe) return failField(pwEl, pe);
    if (pwEl.value !== cfEl.value) return failField(cfEl, 'Passwords do not match.');
    setMsg('');
    setBusy(btn, true);
    try {
      const d = await api('/auth/register', { method: 'POST', body: { name, email, phone, password: pwEl.value, timezone: browserTz } });
      await startSession(d);
    } catch (err) { setMsg(err.message); }
    finally { setBusy(btn, false); }
  });

  /* Forgot password */
  let channel = 'email';
  function resetForgotUi() {
    clearInterval(resendTimer);
    $('#forgot-step1').classList.remove('hidden');
    $('#forgot-step2').classList.add('hidden');
    $$('.otp-box').forEach(b => { b.value = ''; b.classList.remove('filled'); });
    ['#reset-password', '#reset-confirm'].forEach(s => { $(s).value = ''; });
    $('#reset-strength').dataset.s = '0';
    $('#reset-strength b').textContent = 'Enter a password';
    const emailOn = health.email === 'configured', waOn = health.whatsappOtp === 'configured';
    const eb = $('[data-channel=email]'), wb = $('[data-channel=whatsapp]');
    eb.disabled = !emailOn; wb.disabled = !waOn;
    if (!emailOn && waOn) channel = 'whatsapp'; else if (!waOn) channel = 'email';
    $$('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.channel === channel));
    const hint = $('#channel-hint');
    if (!emailOn && !waOn) hint.textContent = 'OTP delivery is not set up on this server yet. Ask the site admin to add the SMTP settings.';
    else if (!waOn) hint.textContent = 'WhatsApp OTP is not enabled on this server — we will email your code.';
    else if (!emailOn) hint.textContent = 'Email OTP is not enabled on this server — we will use WhatsApp.';
    else hint.textContent = 'Choose where you would like to receive your 6-digit code.';
    $('#send-otp-btn').disabled = !emailOn && !waOn;
  }
  $$('.seg-btn').forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    channel = b.dataset.channel;
    $$('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
  }));

  function startResendCountdown(seconds = 30) {
    clearInterval(resendTimer);
    const btn = $('#resend-otp');
    let left = seconds;
    btn.disabled = true; btn.textContent = `Resend in ${left}s`;
    resendTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(resendTimer); btn.disabled = false; btn.textContent = 'Resend OTP'; }
      else btn.textContent = `Resend in ${left}s`;
    }, 1000);
  }

  async function sendOtp(isResend) {
    const idEl = $('#forgot-identifier'), btn = $('#send-otp-btn');
    const identifier = idEl.value.trim();
    if (!identifier) return failField(idEl, 'Enter your email or phone number.');
    setMsg('');
    setBusy(btn, true);
    if (isResend) $('#resend-otp').disabled = true;
    try {
      const d = await api('/auth/forgot-password', { method: 'POST', body: { identifier, channel } });
      $('#forgot-step1').classList.add('hidden');
      $('#forgot-step2').classList.remove('hidden');
      $('#otp-sent-to').textContent = `Sent to ${d.sentTo}`;
      setMsg(d.message, 'success');
      startResendCountdown(30);
      $$('.otp-box')[0].focus();
    } catch (err) {
      setMsg(err.message);
      if (isResend) startResendCountdown(10);
    } finally { setBusy(btn, false); }
  }
  async function doReset() {
    const otp = getOtp(), pwEl = $('#reset-password'), cfEl = $('#reset-confirm'), btn = $('#reset-password-btn');
    if (otp.length !== 6) { $$('.otp-box').find(b => !b.value)?.focus(); return setMsg('Enter the 6-digit OTP.'); }
    const pe = passwordError(pwEl.value);
    if (pe) return failField(pwEl, pe);
    if (pwEl.value !== cfEl.value) return failField(cfEl, 'Passwords do not match.');
    setMsg('');
    setBusy(btn, true);
    try {
      const identifier = $('#forgot-identifier').value.trim();
      const d = await api('/auth/reset-password', { method: 'POST', body: { identifier, otp, password: pwEl.value } });
      setMode('login', true);
      $('#login-identifier').value = identifier;
      $('#login-password').value = '';
      setMsg(d.message, 'success');
      $('#login-password').focus();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(btn, false); }
  }
  $('#forgot-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!$('#forgot-step2').classList.contains('hidden')) doReset(); else sendOtp(false);
  });
  $('#reset-password-btn').onclick = doReset;
  $('#resend-otp').onclick = () => sendOtp(true);

  /* OTP boxes */
  const otpBoxes = $$('.otp-box');
  const getOtp = () => otpBoxes.map(b => b.value).join('');
  otpBoxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      box.classList.toggle('filled', Boolean(box.value));
      if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) { otpBoxes[i - 1].focus(); otpBoxes[i - 1].value = ''; otpBoxes[i - 1].classList.remove('filled'); }
      else if (e.key === 'ArrowLeft' && i > 0) otpBoxes[i - 1].focus();
      else if (e.key === 'ArrowRight' && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
      else if (e.key === 'Enter') { e.preventDefault(); $('#reset-password').focus(); }
    });
    box.addEventListener('focus', () => box.select());
    box.addEventListener('paste', e => {
      e.preventDefault();
      const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      digits.split('').forEach((ch, k) => { otpBoxes[k].value = ch; otpBoxes[k].classList.add('filled'); });
      otpBoxes[Math.min(digits.length, 5)].focus();
    });
  });

  /* ───────────── Session ───────────── */
  async function startSession(d) {
    token = d.token;
    store.set(TOKEN_KEY, token);
    user = d.user;
    await showApp();
  }

  function logout(message) {
    token = null; user = null; tasks = []; editingId = null;
    knownOverdue.clear(); renderedIds.clear();
    store.del(TOKEN_KEY);
    appView.classList.add('hidden');
    authView.classList.remove('hidden');
    closeModals();
    $('#login-password').value = '';
    setMode('login', true);
    setMsg(typeof message === 'string' ? message : '', 'info');
    window.scrollTo(0, 0);
  }
  $('#logout-btn').onclick = () => logout('You have been signed out.');

  /* ───────────── App ───────────── */
  async function showApp() {
    authView.classList.add('hidden');
    appView.classList.remove('hidden');
    window.scrollTo(0, 0);
    paintProfile();
    resetForm();
    updateClock();
    $('#loading').classList.remove('hidden');
    $('#empty').classList.add('hidden');
    await Promise.all([loadTasks(), loadWaStatus()]);
    $('#loading').classList.add('hidden');
    tasks.forEach(t => { if (isOverdue(t)) knownOverdue.add(t.id); });
    render();
    if (browserTz && user.timezone !== browserTz) api('/me/settings', { method: 'PUT', body: { timezone: browserTz } }).then(d => { user = d.user; }).catch(() => {});
  }

  function paintProfile() {
    $('#profile-name').textContent = user.name;
    $('#profile-email').textContent = user.email;
    $('#avatar').textContent = (user.name || '?').trim()[0].toUpperCase();
  }

  async function loadTasks() {
    try { tasks = (await api('/tasks')).tasks || []; }
    catch (e) { if (token) toast(e.message, 'error'); }
  }

  /* Due-date helpers */
  function getDue(t) {
    if (t.dueAt) { const d = new Date(t.dueAt); if (!Number.isNaN(d.getTime())) return d; }
    if (t.dueDate) { const d = new Date(`${t.dueDate}T${t.dueTime || '23:59'}`); if (!Number.isNaN(d.getTime())) return d; }
    return null;
  }
  const isOverdue = t => { if (t.completed) return false; const d = getDue(t); return Boolean(d) && d.getTime() < Date.now(); };
  const isToday = t => !t.completed && Boolean(t.dueDate) && t.dueDate === localDate(new Date());

  function relative(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hr`;
    return `${Math.round(h / 24)} days`;
  }
  function dueInfo(t) {
    const due = getDue(t);
    if (!due) return null;
    const now = new Date(), diff = due - now;
    const time = t.dueTime ? due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const dayStr = due.toLocaleDateString([], { day: 'numeric', month: 'short' });
    if (t.completed) return { cls: 'due', text: `${dayStr}${time ? ' · ' + time : ''}` };
    if (diff < 0) return { cls: 'late', text: `Overdue · ${relative(-diff)} ago` };
    if (diff < 3600000) return { cls: 'soon', text: `Due in ${relative(diff)}` };
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    let day = dayStr;
    if (localDate(due) === localDate(now)) day = 'Today';
    else if (localDate(due) === localDate(tomorrow)) day = 'Tomorrow';
    return { cls: 'due', text: `${day}${time ? ' · ' + time : ''}` };
  }

  /* Stats / ring */
  function animateNumber(el, to) {
    if (el.dataset.v === String(to)) return;
    const from = Number(el.dataset.v || 0);
    el.dataset.v = String(to);
    cancelAnimationFrame(el._raf);
    if (reduceMotion) { el.textContent = to; return; }
    const start = performance.now(), dur = 600;
    const step = now => {
      const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  function renderStats() {
    const total = tasks.length, done = tasks.filter(t => t.completed).length;
    const stats = { total, active: total - done, completed: done, today: tasks.filter(isToday).length, overdue: tasks.filter(isOverdue).length };
    Object.entries(stats).forEach(([k, v]) => animateNumber($('#stat-' + k), v));
    Object.entries({ all: total, active: stats.active, today: stats.today, overdue: stats.overdue, completed: done }).forEach(([k, v]) => { $('#c-' + k).textContent = v; });
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('#ring-pct').textContent = pct + '%';
    $('#ring-fg').style.strokeDashoffset = String(326.7 * (1 - pct / 100));
    const sub = $('#hero-subtitle');
    if (!total) sub.textContent = 'Add your first task to get started.';
    else if (stats.overdue) sub.textContent = `You have ${stats.overdue} overdue task${stats.overdue > 1 ? 's' : ''}. Let's clear ${stats.overdue > 1 ? 'them' : 'it'}!`;
    else if (stats.active) sub.textContent = `${stats.active} task${stats.active > 1 ? 's' : ''} left. You've got this.`;
    else sub.textContent = 'All caught up. Amazing work! 🎉';
  }

  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const da = getDue(a), db = getDue(b);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function render() {
    renderStats();
    const q = $('#search').value.trim().toLowerCase();
    const list = sortTasks(tasks.filter(t => {
      const matches = !q || `${t.title} ${t.desc || ''} ${t.category || ''}`.toLowerCase().includes(q);
      const type = filter === 'all' || (filter === 'active' && !t.completed) || (filter === 'completed' && t.completed) ||
        (filter === 'today' && isToday(t)) || (filter === 'overdue' && isOverdue(t));
      return matches && type;
    }));

    let n = 0;
    $('#task-list').innerHTML = list.map(t => {
      const info = dueInfo(t), isNew = !renderedIds.has(t.id);
      const delay = isNew ? `style="animation-delay:${Math.min(n++, 10) * 45}ms"` : '';
      return `<article class="task p-${esc(t.priority)}${t.completed ? ' done' : ''}${isOverdue(t) ? ' overdue' : ''}${isNew ? '' : ' no-anim'}" data-id="${esc(t.id)}" ${delay}>
        <button class="check${t.completed ? ' done' : ''}" data-action="toggle" aria-label="${t.completed ? 'Mark as not done' : 'Mark as done'}" aria-pressed="${t.completed}">${icon('check')}</button>
        <div class="task-main"><h4 class="t-title">${esc(t.title)}</h4>${t.desc ? `<p class="t-desc">${esc(t.desc)}</p>` : ''}
          <div class="meta"><span class="pill ${esc(t.priority)}">${esc(t.priority)}</span><span class="pill">${esc(t.category || 'personal')}</span>${info ? `<span class="pill ${info.cls}">${icon('clock')}${esc(info.text)}</span>` : ''}</div></div>
        <div class="task-actions"><button class="act" data-action="edit" aria-label="Edit task" title="Edit">${icon('edit')}</button><button class="act del" data-action="delete" aria-label="Delete task" title="Delete">${icon('trash')}</button></div>
      </article>`;
    }).join('');
    list.forEach(t => renderedIds.add(t.id));

    const empty = $('#empty');
    empty.classList.toggle('hidden', list.length > 0);
    if (!list.length) {
      const searching = q || filter !== 'all';
      $('#empty-title').textContent = searching ? 'No matching tasks' : 'Nothing here yet';
      $('#empty-text').textContent = searching ? 'Try a different search or filter.' : 'Add your first task and make today count.';
    }
  }

  /* Task list actions (event delegation) */
  $('#task-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.task');
    const t = tasks.find(x => x.id === card.dataset.id);
    if (!t) return;
    if (btn.dataset.action === 'toggle') toggleTask(t, btn);
    else if (btn.dataset.action === 'edit') startEdit(t);
    else if (btn.dataset.action === 'delete') deleteTask(t, card);
  });

  async function toggleTask(t, btn) {
    btn.disabled = true;
    try {
      const d = await api('/tasks/' + t.id, { method: 'PUT', body: { completed: !t.completed } });
      const wasDone = t.completed;
      tasks = tasks.map(x => (x.id === t.id ? d.task : x));
      if (!wasDone) { const r = btn.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2); toast('Nice! Task completed 🎉', 'success'); }
      render();
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  }

  async function deleteTask(t, card) {
    const yes = await confirmBox(`"${t.title}" will be permanently deleted.`, 'Delete');
    if (!yes) return;
    try {
      await api('/tasks/' + t.id, { method: 'DELETE' });
      card.classList.add('leaving');
      setTimeout(() => { tasks = tasks.filter(x => x.id !== t.id); renderedIds.delete(t.id); knownOverdue.delete(t.id); if (editingId === t.id) resetForm(); render(); }, reduceMotion ? 0 : 320);
      toast('Task deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* Task form */
  function resetForm() {
    editingId = null;
    $('#task-form').reset();
    $('#form-heading').textContent = 'Add a new task';
    $('#save-task .btn-label').textContent = 'Add task';
    $('#cancel-edit').classList.add('hidden');
    $$('#task-form .invalid').forEach(x => x.classList.remove('invalid'));
  }
  function startEdit(t) {
    editingId = t.id;
    $('#task-title').value = t.title;
    $('#task-desc').value = t.desc || '';
    $('#task-date').value = t.dueDate || '';
    $('#task-time').value = t.dueTime || '';
    $('#task-priority').value = t.priority || 'medium';
    $('#task-category').value = t.category || 'personal';
    $('#form-heading').textContent = 'Edit task';
    $('#save-task .btn-label').textContent = 'Save changes';
    $('#cancel-edit').classList.remove('hidden');
    $('#task-form').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    setTimeout(() => $('#task-title').focus({ preventScroll: true }), 250);
  }
  $('#cancel-edit').onclick = resetForm;

  $('#task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const titleEl = $('#task-title'), btn = $('#save-task');
    const title = titleEl.value.trim(), date = $('#task-date').value, time = $('#task-time').value;
    if (!title) { markInvalid(titleEl); titleEl.focus(); return toast('Please enter a task title.', 'error'); }
    if (time && !date) { markInvalid($('#task-date')); $('#task-date').focus(); return toast('Pick a due date for the time you chose.', 'error'); }
    const body = {
      title, desc: $('#task-desc').value.trim(), dueDate: date, dueTime: date ? time : '',
      dueAt: date ? new Date(`${date}T${time || '23:59'}`).toISOString() : null,
      priority: $('#task-priority').value, category: $('#task-category').value
    };
    setBusy(btn, true);
    try {
      if (editingId) {
        const d = await api('/tasks/' + editingId, { method: 'PUT', body });
        tasks = tasks.map(t => (t.id === editingId ? d.task : t));
        toast('Task updated', 'success');
      } else {
        const d = await api('/tasks', { method: 'POST', body });
        tasks.unshift(d.task);
        toast('Task added', 'success');
      }
      resetForm();
      render();
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(btn, false); }
  });

  /* Filters / search / clear */
  $('#filters').addEventListener('click', e => {
    const b = e.target.closest('.chip-btn');
    if (!b) return;
    filter = b.dataset.filter;
    $$('.chip-btn').forEach(x => x.classList.toggle('active', x === b));
    render();
  });
  $('#search').addEventListener('input', render);
  $('#clear-completed').onclick = async () => {
    const ids = tasks.filter(t => t.completed).map(t => t.id);
    if (!ids.length) return toast('No completed tasks to clear.');
    if (!(await confirmBox(`${ids.length} completed task${ids.length > 1 ? 's' : ''} will be deleted.`, 'Clear'))) return;
    try {
      await api('/tasks', { method: 'DELETE', body: { ids } });
      tasks = tasks.filter(t => !t.completed);
      render();
      toast('Completed tasks cleared', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  /* ───────────── WhatsApp card + modal ───────────── */
  async function loadWaStatus() {
    try { waStatus = await api('/whatsapp/status'); } catch { waStatus = null; }
    paintWa();
  }
  function paintWa() {
    const chip = $('#wa-chip'), sub = $('#wa-sub'), text = $('#wa-text');
    chip.className = 'chip';
    if (!waStatus) { chip.textContent = '—'; sub.textContent = 'Status unavailable'; text.textContent = ''; return; }
    if (!waStatus.serverConfigured) {
      chip.textContent = 'Setup needed'; chip.classList.add('warn'); sub.textContent = 'Server not connected to WhatsApp';
      text.textContent = 'Reminders start working as soon as the WhatsApp Cloud API keys are added to the server.';
    } else if (!user.phone) {
      chip.textContent = 'Add number'; chip.classList.add('warn'); sub.textContent = 'No number saved';
      text.textContent = 'Add your WhatsApp number to get a message when a task is late.';
    } else if (user.whatsappEnabled === false) {
      chip.textContent = 'Off'; chip.classList.add('off'); sub.textContent = '+' + user.phone;
      text.textContent = 'Reminders are paused. Turn them on to get overdue alerts.';
    } else {
      chip.textContent = 'Active'; chip.classList.add('ok'); sub.textContent = '+' + user.phone;
      text.textContent = `We message you ${waStatus.reminderMinutes} min before a task is due and the moment it becomes overdue.`;
    }
  }

  const waMsg = $('#wa-modal-msg');
  const setWaMsg = (t, type = 'error') => { waMsg.className = 'auth-message' + (t ? ` show ${type}` : ''); waMsg.textContent = t || ''; };
  fillCountrySelect($('#wa-cc'), '91');

  function openWaModal() {
    const sp = user.phone ? splitPhone(user.phone) : { cc: health.defaultCountryCode || '91', national: '' };
    fillCountrySelect($('#wa-cc'), sp.cc || health.defaultCountryCode || '91');
    $('#wa-phone').value = sp.national;
    $('#wa-enabled').checked = user.whatsappEnabled !== false;
    $('#wa-modal-desc').textContent = waStatus && !waStatus.serverConfigured
      ? 'Save your number now. Messages will begin once the server administrator connects the WhatsApp Cloud API.'
      : `Get a WhatsApp message on your own number before a task is due and when it becomes overdue.`;
    setWaMsg('');
    openModal($('#wa-modal'));
    setTimeout(() => $('#wa-phone').focus(), 80);
  }
  $('#wa-manage').onclick = openWaModal;

  async function saveWa(silent) {
    const phone = buildPhone($('#wa-cc'), $('#wa-phone'));
    if (phone && !phoneOk(phone)) { setWaMsg('Please enter a valid WhatsApp number.'); $('#wa-phone').focus(); return false; }
    try {
      const d = await api('/me/settings', { method: 'PUT', body: { phone, whatsappEnabled: $('#wa-enabled').checked } });
      user = d.user;
      paintWa();
      if (!silent) setWaMsg('Saved. Your WhatsApp settings are updated.', 'success');
      return true;
    } catch (e) { setWaMsg(e.message); return false; }
  }
  $('#wa-save').onclick = async () => { const b = $('#wa-save'); setBusy(b, true); await saveWa(false); setBusy(b, false); };
  $('#wa-test').onclick = async () => {
    const b = $('#wa-test');
    setBusy(b, true); setWaMsg('');
    try {
      if (!(await saveWa(true))) return;
      if (!user.phone) return setWaMsg('Add your WhatsApp number first.');
      const d = await api('/whatsapp/test', { method: 'POST' });
      setWaMsg(d.message, 'success');
    } catch (e) { setWaMsg(e.message); }
    finally { setBusy(b, false); }
  };

  /* ───────────── Modals ───────────── */
  let lastFocus = null, confirmResolve = null;
  function openModal(m) { lastFocus = document.activeElement; m.classList.remove('hidden'); }
  function closeModals() {
    $$('.modal').forEach(m => m.classList.add('hidden'));
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }
  $$('.modal').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) closeModals(); }));
  $$('[data-close]').forEach(b => b.addEventListener('click', closeModals));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $$('.modal:not(.hidden)').length) closeModals(); });

  function confirmBox(text, yesLabel) {
    return new Promise(resolve => {
      $('#confirm-text').textContent = text;
      $('#confirm-yes').textContent = yesLabel || 'Confirm';
      confirmResolve = resolve;
      openModal($('#confirm-modal'));
      $('#confirm-no').focus();
    });
  }
  $('#confirm-yes').onclick = () => { const r = confirmResolve; confirmResolve = null; closeModals(); if (r) r(true); };
  $('#confirm-no').onclick = closeModals;

  /* ───────────── Theme, clock, effects ───────────── */
  function paintThemeIcon() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    $('#theme-btn').innerHTML = icon(light ? 'moon' : 'sun');
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', light ? '#eef0fc' : '#070817');
  }
  $('#theme-btn').onclick = () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    store.set('mytodo_theme', next);
    paintThemeIcon();
  };
  paintThemeIcon();

  function updateClock() {
    if (!user) return;
    const n = new Date(), hr = n.getHours();
    $('#clock').textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#date').textContent = n.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const greet = hr < 12 ? 'GOOD MORNING' : hr < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
    $('#greeting').textContent = `${greet}, ${user.name.split(' ')[0].toUpperCase()}`;
  }
  setInterval(updateClock, 1000);

  // Re-evaluate overdue state while the tab is open
  setInterval(() => {
    if (!user || document.hidden) return;
    let changed = false;
    tasks.forEach(t => {
      if (isOverdue(t) && !knownOverdue.has(t.id)) {
        knownOverdue.add(t.id); changed = true;
        toast(`⚠ "${t.title}" is now overdue`, 'error');
      }
    });
    render();
    if (changed) { /* toast already shown */ }
  }, 30000);

  /* Spotlight hover glow + button ripple + 3D tilt */
  document.addEventListener('pointermove', e => {
    const el = e.target.closest && e.target.closest('.spot');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.btn');
    if (!btn || btn.disabled || reduceMotion) return;
    const r = btn.getBoundingClientRect(), size = Math.max(r.width, r.height);
    const rip = document.createElement('span');
    rip.className = 'ripple';
    rip.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    btn.appendChild(rip);
    setTimeout(() => rip.remove(), 650);
  });

  const card = $('#auth-card');
  if (card && !reduceMotion && window.matchMedia('(hover: hover)').matches) {
    const panel = $('.auth-panel');
    panel.addEventListener('pointermove', e => {
      if (window.innerWidth < 980) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - (r.left + r.width / 2)) / window.innerWidth, y = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      card.style.transform = `rotateY(${(x * 7).toFixed(2)}deg) rotateX(${(-y * 7).toFixed(2)}deg)`;
    });
    panel.addEventListener('pointerleave', () => { card.style.transform = ''; });
  }

  /* Confetti burst when a task is completed */
  const fx = $('#fx'), fxCtx = fx && fx.getContext ? fx.getContext('2d') : null;
  function confetti(x, y) {
    if (!fxCtx || reduceMotion) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.width = window.innerWidth * dpr; fx.height = window.innerHeight * dpr;
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#7c5cff', '#22d3ee', '#ff5ca8', '#fbbf24', '#34d399'];
    const parts = Array.from({ length: 36 }, () => {
      const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 6;
      return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 3, r: 3 + Math.random() * 4, c: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 6, life: 1 };
    });
    let last = performance.now();
    (function tick(now) {
      const dt = Math.min(2, (now - last) / 16.7); last = now;
      fxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let alive = false;
      parts.forEach(p => {
        p.vy += 0.28 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += 0.2 * dt; p.life -= 0.016 * dt;
        if (p.life <= 0) return;
        alive = true;
        fxCtx.save(); fxCtx.globalAlpha = Math.max(0, p.life); fxCtx.translate(p.x, p.y); fxCtx.rotate(p.rot);
        fxCtx.fillStyle = p.c; fxCtx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); fxCtx.restore();
      });
      if (alive) requestAnimationFrame(tick); else fxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    })(last);
  }

  /* ───────────── Boot ───────────── */
  fillCountrySelect($('#register-cc'), '91');
  async function loadHealth() {
    try {
      health = await api('/health');
      if (health.defaultCountryCode) { fillCountrySelect($('#register-cc'), health.defaultCountryCode); fillCountrySelect($('#wa-cc'), health.defaultCountryCode); }
      if (health.database !== 'connected') setMsg('The database is not connected right now. Please try again shortly.', 'error');
    } catch { /* offline: handled on submit */ }
  }

  (async function init() {
    loadHealth();
    if (!token) return;
    authView.classList.add('hidden');
    try {
      const d = await api('/auth/me');
      user = d.user;
      await showApp();
    } catch {
      token = null; store.del(TOKEN_KEY);
      authView.classList.remove('hidden');
    }
  })();
})();
