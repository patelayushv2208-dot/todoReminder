'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value) {
  return EMAIL_RE.test(String(value || '').trim());
}

/** Keep digits only: "+91 98765-43210" -> "919876543210" */
function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Validate a full international number (country code included).
 * Returns digits (E.164 without "+") or null.
 */
function normalizePhone(value) {
  let d = digitsOnly(value);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length < 8 || d.length > 15) return null;
  if (d.startsWith('0')) return null;
  return d;
}

/**
 * For login: the user may type "9876543210", "09876543210" or "+91 9876543210".
 * Returns every stored form that could match.
 */
function phoneCandidates(value, defaultCountryCode = '91') {
  let d = digitsOnly(value);
  if (d.startsWith('00')) d = d.slice(2);
  if (!d) return [];
  const out = new Set();
  if (d.length >= 8 && d.length <= 15 && !d.startsWith('0')) out.add(d);
  const national = d.replace(/^0+/, '');
  if (national.length >= 6 && national.length <= 11) out.add(defaultCountryCode + national);
  return [...out];
}

/** Mask a phone number for display: 919876543210 -> +91*******210 */
function maskPhone(digits) {
  const d = String(digits || '');
  if (d.length < 7) return '';
  return `+${d.slice(0, 2)}${'*'.repeat(d.length - 5)}${d.slice(-3)}`;
}

function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(timestamp));
  const get = type => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

/** Convert a wall-clock date/time in a given IANA timezone to a real UTC Date. */
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [h, min] = String(timeStr || '23:59').split(':').map(Number);
  if (![y, m, d, h, min].every(Number.isFinite)) return null;
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  const result = new Date(utc);
  return Number.isNaN(result.getTime()) ? null : result;
}

function formatDue(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone, day: '2-digit', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

module.exports = {
  normalizeEmail, isEmail, digitsOnly, normalizePhone, phoneCandidates, maskPhone,
  isValidTimezone, zonedToUtc, formatDue
};
