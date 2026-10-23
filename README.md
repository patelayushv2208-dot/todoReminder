# MyToDo Pro

Live-design task manager with **email / phone login**, **OTP password reset**, and **WhatsApp reminders** when a task is due soon or overdue.

## Features
- Login with **email or phone number** + your own MyToDo password
- Create account (name, email, WhatsApp number, password with strength meter)
- Forgot password → 6-digit OTP by **Email** (and optionally **WhatsApp**) → set a new password
- Animated live background, glass UI, dark/light theme, mobile friendly
- Tasks saved in MongoDB per user: add, edit, complete, delete, search, filters, priority, category
- WhatsApp message to the **user's own number**: reminder before due time + alert when overdue
- Security: bcrypt hashing, JWT sessions (invalidated after password reset), rate limiting, Helmet headers, OTP attempt limit

## 1. Setup (5 minutes)
```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
```
Edit `.env` and fill at least `MONGODB_URI` and `JWT_SECRET`. Then verify:
```bash
npm run check             # tells you exactly what is missing
npm start                 # open http://localhost:3000
```
> Always open the site through `http://localhost:3000`. Do not open `index.html` directly and do not use Live Server.

### MongoDB Atlas
1. Create a free cluster → Database Access: create a user → Network Access: add your IP (or `0.0.0.0/0` for hosting).
2. Copy the connection string into `MONGODB_URI`. Special characters in the password must be URL-encoded.

### Email OTP (Gmail)
Turn on 2-Step Verification, create a **Google App Password**, put it in `SMTP_PASS` (never your normal password). Startup prints `SMTP connection verified.`

## 2. WhatsApp reminders — what you must know
WhatsApp does **not** allow apps to send free-text messages to people first. Business-initiated messages must use **pre-approved templates**. So:

1. Go to [developers.facebook.com](https://developers.facebook.com) → create an app → add **WhatsApp** → note the **Phone number ID** and create a **permanent token** (System User token; the temporary one expires in 24 h).
2. In **WhatsApp Manager → Message templates** create these (category *Utility*, language English (US) = `en_US`):

| Template name | Body text |
|---|---|
| `task_reminder` | `⏰ Reminder: {{1}} is due at {{2}}.` |
| `task_overdue` | `⚠️ Task overdue: {{1}} was due at {{2}}. Please complete it.` |

3. Wait until both show **Approved**, then fill in `.env`:
```env
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_REMINDER_TEMPLATE=task_reminder
WHATSAPP_OVERDUE_TEMPLATE=task_overdue
WHATSAPP_TEMPLATE_LANGUAGE=en_US
```
4. Restart, log in, open **Manage WhatsApp** in the dashboard and press **Send test message**.

Notes
- While your Meta app is in **test mode**, you can only message numbers you added under *API Setup → To* (verified recipients). Go live / add the real numbers for other users.
- Meta charges per conversation/message according to its pricing.
- Optional **OTP over WhatsApp**: create an *Authentication* template (copy-code button) and set `WHATSAPP_OTP_TEMPLATE`. Otherwise OTP is sent by email only.
- Each user is messaged on **their own saved number** (change it any time in *Manage WhatsApp*). Due times use each user's own timezone.

### How reminders work
The server checks every minute. For every unfinished task it sends **one** reminder (`WHATSAPP_REMINDER_MINUTES` before due) and **one** overdue alert (when the due time passes). Duplicates are prevented, failed sends are retried up to 3 times, and tasks overdue for more than 48 h are not sent (prevents floods after downtime).

> **Hosting tip:** reminders are sent by the running server, so it must stay awake 24×7. Free plans that sleep (e.g. Render free) will delay reminders until the server wakes up. Use an always-on plan or a small VPS.

## 3. Deploy checklist
- Set the environment variables from `.env.example` on your host (never upload `.env` to Git)
- `TRUST_PROXY=true` when behind a proxy/host, HTTPS enabled
- Use a strong `JWT_SECRET`; keep `WHATSAPP_TOKEN` and `SMTP_PASS` private

## Project structure
```
src/server.js     API, auth, tasks, WhatsApp scheduler
src/whatsapp.js   WhatsApp Cloud API client
src/mailer.js     OTP emails
src/utils.js      phone / timezone helpers
public/           website (index.html, css/style.css, js/app.js, js/background.js)
scripts/check-env.js
```
Only the `public/` folder is served to browsers, so `.env` and the server code can never be downloaded.

## Troubleshooting
| Problem | Fix |
|---|---|
| `MongoDB connection failed` | Check `MONGODB_URI`, DB user password and Atlas Network Access |
| OTP email not arriving | `SMTP_PASS` must be a Gmail App Password; check spam; startup should say `SMTP connection verified.` |
| WhatsApp test fails with *template not found* | Template name/language in `.env` must match the approved template exactly |
| WhatsApp test fails with *recipient not in allowed list* | Add the number in Meta API Setup (test mode) or go live |
| "Too many attempts" | Rate limit; wait a few minutes |
