'use strict';
const nodemailer = require('nodemailer');

let transport = null;

function isConfigured() {
  const e = process.env;
  return Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS && (e.MAIL_FROM || e.SMTP_USER));
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });
  }
  return transport;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendOtpEmail(to, name, otp) {
  if (!isConfigured()) throw new Error('Email service is not configured.');
  const safeName = escapeHtml(name || 'there');
  await getTransport().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject: `${otp} is your MyToDo password reset code`,
    text: `Hi ${name || 'there'},\n\nYour MyToDo password reset code is ${otp}. It expires in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `<!doctype html><html><body style="margin:0;background:#0b0d1c;font-family:Arial,Helvetica,sans-serif;color:#f4f5fb;padding:32px 16px">
<div style="max-width:480px;margin:auto;background:#151935;border:1px solid #2b315a;border-radius:22px;padding:32px">
<div style="font-size:26px;font-weight:800;margin-bottom:18px">&#10003; MyToDo</div>
<p style="color:#b3bad6;margin:0 0 14px">Hi ${safeName},</p>
<p style="margin:0 0 18px">Use this one-time code to reset your MyToDo password:</p>
<div style="font-size:34px;letter-spacing:10px;font-weight:800;background:#0b0e22;border-radius:14px;padding:18px;text-align:center;color:#fff">${otp}</div>
<p style="color:#b3bad6;margin:18px 0 0">This code expires in <b style="color:#fff">10 minutes</b>.</p>
<p style="color:#7f88a8;font-size:12px;margin:18px 0 0">If you did not request a password reset, you can safely ignore this email.</p>
</div></body></html>`
  });
}

async function verify() {
  return getTransport().verify();
}

module.exports = { isConfigured, sendOtpEmail, verify };
