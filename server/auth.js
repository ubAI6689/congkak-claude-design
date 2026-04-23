// Auth + magic-link helpers (Phase 6).
// - HTTP handlers for POST /auth/request and GET /auth/verify
// - Session cookie parser (reads from Cookie header, works on HTTP req and WS upgrade req)
// - Magic-link email dispatch via nodemailer/SES SMTP; falls back to stdout log in dev
//
// Env:
//   BASE_URL        e.g. https://congkak.ubaidrac.xyz/beta  (used in the email link)
//   SMTP_HOST       e.g. email-smtp.ap-southeast-1.amazonaws.com
//   SMTP_PORT       587 (STARTTLS) or 465 (TLS)
//   SMTP_USER       SES SMTP username (IAM user's SMTP credential)
//   SMTP_PASS       SES SMTP password
//   FROM_EMAIL      e.g. noreply@ubaidrac.xyz
// If SMTP_* are unset, we log the link to stdout instead of sending.

const db = require('./db.js');

const TOKEN_TTL_MS = 15 * 60_000;         // 15 min to click the link
const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days
const COOKIE_NAME = 'ckg_sid';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionFromReq(req) {
  const cookies = parseCookies(req.headers.cookie);
  return db.getSession(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, sessionId, maxAgeMs) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
}

function isValidEmail(s) {
  // Minimal sanity check — not RFC5322. Real validation is "did they click the link."
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 254;
}

async function sendMagicLink(email, token) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:8787';
  const link = `${baseUrl.replace(/\/$/, '')}/auth/verify?token=${token}`;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    // Dev / stub mode — log to stdout so testing works without SES configured.
    console.log(`[${new Date().toISOString()}] MAGIC-LINK for ${email}: ${link}`);
    return { sent: false, stub: true };
  }

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transport.sendMail({
    from: process.env.FROM_EMAIL || 'noreply@ubaidrac.xyz',
    to: email,
    subject: 'Your Congkak sign-in link',
    text: `Click to sign in: ${link}\n\nThe link expires in 15 minutes. If you didn't request this, ignore this email.`,
    html: `<p>Click to sign in: <a href="${link}">${link}</a></p><p>The link expires in 15 minutes. If you didn't request this, ignore this email.</p>`,
  });

  return { sent: true };
}

// --- HTTP route handlers ---

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleRequest(req, res) {
  // POST /auth/request  body: {email}
  try {
    const body = await readBody(req);
    let email;
    try { email = JSON.parse(body).email; } catch { return json(res, 400, { error: 'bad-json' }); }
    if (!isValidEmail(email)) return json(res, 400, { error: 'invalid-email' });
    const token = db.createMagicToken(email, TOKEN_TTL_MS);
    await sendMagicLink(email, token);
    // Always respond 200 so enumeration isn't possible (we create the user lazily on verify).
    return json(res, 200, { ok: true });
  } catch (e) {
    console.log(`[auth/request] ${e.message}`);
    return json(res, 500, { error: 'send-failed' });
  }
}

function handleVerify(req, res) {
  // GET /auth/verify?token=...
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (!token) return html(res, 400, 'Missing token.');
  const result = db.consumeMagicToken(token);
  if (!result.ok) {
    const msg = result.reason === 'expired'   ? 'This sign-in link has expired. Request a new one.' :
                result.reason === 'already-used' ? 'This link was already used. Request a new one.' :
                                                   'Invalid sign-in link.';
    return html(res, 400, msg);
  }
  const user = db.getOrCreateUser(result.email);
  const session = db.createSession(user.id, SESSION_TTL_MS);
  setSessionCookie(res, session.id, SESSION_TTL_MS);
  // Redirect back into the app. BASE_URL should point at the client root.
  const back = (process.env.BASE_URL || '/').replace(/\/$/, '') + '/';
  res.writeHead(302, { Location: back });
  res.end();
}

function handleMe(req, res) {
  // GET /auth/me  → {user: {id, email}} or {user: null}
  const s = sessionFromReq(req);
  return json(res, 200, { user: s ? { id: s.user.id, email: s.user.email } : null });
}

function handleLogout(req, res) {
  // POST /auth/logout
  const cookies = parseCookies(req.headers.cookie);
  db.deleteSession(cookies[COOKIE_NAME]);
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#333}</style><h1>Sign-in</h1><p>${body}</p><p><a href="/">Back to Congkak</a></p>`);
}

async function route(req, res) {
  // Returns true if we handled it.
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/auth/request' && req.method === 'POST')  { await handleRequest(req, res); return true; }
  if (p === '/auth/verify'  && req.method === 'GET')   { handleVerify(req, res); return true; }
  if (p === '/auth/me'      && req.method === 'GET')   { handleMe(req, res); return true; }
  if (p === '/auth/logout'  && req.method === 'POST')  { handleLogout(req, res); return true; }
  return false;
}

module.exports = { route, sessionFromReq, COOKIE_NAME, parseCookies };
