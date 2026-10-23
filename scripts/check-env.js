'use strict';
// Run:  npm run check   - validates your .env before you start the server
require('dotenv').config();
const e = process.env;
let problems = 0;
const line = (ok, msg, hint) => { console.log(`${ok ? '✅' : '❌'} ${msg}${!ok && hint ? `\n     → ${hint}` : ''}`); if (!ok) problems++; };
const info = (ok, msg, hint) => console.log(`${ok ? '✅' : '⚠️ '} ${msg}${!ok && hint ? `\n     → ${hint}` : ''}`);

line(Boolean(e.MONGODB_URI) && !e.MONGODB_URI.includes('USERNAME:PASSWORD'), 'MONGODB_URI is set', 'Paste your MongoDB Atlas connection string into .env');
line(Boolean(e.JWT_SECRET) && e.JWT_SECRET.length >= 16 && !e.JWT_SECRET.startsWith('replace_this'), 'JWT_SECRET is set and long enough', 'Use a random string of 32+ characters');
info(Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS) && !String(e.SMTP_USER).includes('your-email'), 'Email OTP (SMTP) configured', 'Forgot-password by email will not work until SMTP_* are filled in');
info(Boolean(e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID), 'WhatsApp reminders configured', 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are empty - reminders are disabled');
info(Boolean(e.WHATSAPP_OTP_TEMPLATE), 'WhatsApp OTP template set (optional)', 'Optional. Without it, password-reset OTP is sent by email only');

(async () => {
  if (e.MONGODB_URI && !e.MONGODB_URI.includes('USERNAME:PASSWORD')) {
    try {
      const mongoose = require('mongoose');
      await mongoose.connect(e.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
      line(true, 'MongoDB connection works');
      await mongoose.disconnect();
    } catch (err) { line(false, `MongoDB connection failed: ${err.message}`, 'Check password, and add your IP (or 0.0.0.0/0) in Atlas → Network Access'); }
  }
  console.log(problems ? `\n${problems} problem(s) found. Fix them and run again.` : '\nAll required settings look good. Start with: npm start');
  process.exit(problems ? 1 : 0);
})();
