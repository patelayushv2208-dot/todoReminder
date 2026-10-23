'use strict';
/**
 * WhatsApp Cloud API (Meta) helper.
 *
 * IMPORTANT: WhatsApp only allows business-initiated messages through
 * APPROVED TEMPLATES. Create these templates in Meta WhatsApp Manager
 * (see README) and put their names in .env.
 */

const env = () => process.env;

function isConfigured() {
  return Boolean(env().WHATSAPP_TOKEN && env().WHATSAPP_PHONE_NUMBER_ID);
}

function isOtpConfigured() {
  return isConfigured() && Boolean(env().WHATSAPP_OTP_TEMPLATE);
}

function graphUrl() {
  const version = env().WHATSAPP_GRAPH_API_VERSION || 'v23.0';
  const base = (env().WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '');
  return `${base}/${version}/${env().WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

/** Template body variables cannot contain new lines, tabs or 4+ spaces. */
function cleanParam(value, max = 200) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
  return text || '-';
}

async function sendTemplate({ to, name, language, bodyParams = [], otpButton = null }) {
  if (!isConfigured()) {
    const e = new Error('WhatsApp is not configured on the server.');
    e.code = 'WA_NOT_CONFIGURED';
    throw e;
  }
  const recipient = String(to || '').replace(/\D/g, '');
  if (!recipient) throw new Error('No WhatsApp number available for this user.');

  const components = [];
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: cleanParam(t) })) });
  }
  if (otpButton) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: cleanParam(otpButton, 15) }] });
  }

  const response = await fetch(graphUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env().WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: { name, language: { code: language }, ...(components.length ? { components } : {}) }
    }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `WhatsApp API returned HTTP ${response.status}`);
    error.status = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

const lang = () => env().WHATSAPP_TEMPLATE_LANGUAGE || 'en_US';

/** Template body suggestion: "⏰ Reminder: {{1}} is due at {{2}}." */
function sendTaskReminder(to, title, dueText) {
  return sendTemplate({
    to, name: env().WHATSAPP_REMINDER_TEMPLATE || 'task_reminder', language: lang(),
    bodyParams: [title, dueText]
  });
}

/** Template body suggestion: "⚠️ Task overdue: {{1}} was due at {{2}}. Please complete it." */
function sendTaskOverdue(to, title, dueText) {
  return sendTemplate({
    to, name: env().WHATSAPP_OVERDUE_TEMPLATE || 'task_overdue', language: lang(),
    bodyParams: [title, dueText]
  });
}

/** Meta "Authentication" template: body {{1}} = code, plus a copy-code button. */
function sendOtp(to, otp) {
  return sendTemplate({
    to, name: env().WHATSAPP_OTP_TEMPLATE, language: env().WHATSAPP_OTP_TEMPLATE_LANGUAGE || lang(),
    bodyParams: [otp], otpButton: otp
  });
}

module.exports = { isConfigured, isOtpConfigured, sendTaskReminder, sendTaskOverdue, sendOtp };
