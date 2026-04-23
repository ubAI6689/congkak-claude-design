// SQLite wrapper for Congkak accounts (Phase 6).
// Schema is created on first run; migrations live in MIGRATIONS array.
// DB path from DB_PATH env var (defaults to ./congkak.db alongside this file).

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'congkak.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Idempotent schema. Add a new statement to MIGRATIONS and bump user_version.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS magic_tokens (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_email ON magic_tokens(email)`,
];

for (const sql of MIGRATIONS) db.prepare(sql).run();

// Prepared statements
const stmts = {
  findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  findUserById:    db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser:      db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)'),
  insertSession:   db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  findSession:     db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
  deleteSession:   db.prepare('DELETE FROM sessions WHERE id = ?'),
  insertToken:     db.prepare('INSERT INTO magic_tokens (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  findToken:       db.prepare('SELECT * FROM magic_tokens WHERE token = ?'),
  consumeToken:    db.prepare('UPDATE magic_tokens SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL'),
  pruneExpired:    db.prepare('DELETE FROM magic_tokens WHERE expires_at < ?'),
  pruneSessions:   db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

function getOrCreateUser(email) {
  const row = stmts.findUserByEmail.get(email);
  if (row) return row;
  const now = Date.now();
  const info = stmts.insertUser.run(email.toLowerCase(), now);
  return stmts.findUserById.get(info.lastInsertRowid);
}

function createSession(userId, ttlMs) {
  const crypto = require('crypto');
  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmts.insertSession.run(id, userId, now, now + ttlMs);
  return { id, userId, expiresAt: now + ttlMs };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const row = stmts.findSession.get(sessionId, Date.now());
  if (!row) return null;
  const user = stmts.findUserById.get(row.user_id);
  return user ? { sessionId: row.id, user } : null;
}

function deleteSession(sessionId) {
  if (sessionId) stmts.deleteSession.run(sessionId);
}

function createMagicToken(email, ttlMs) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmts.insertToken.run(token, email.toLowerCase(), now, now + ttlMs);
  return token;
}

function consumeMagicToken(token) {
  const row = stmts.findToken.get(token);
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.consumed_at) return { ok: false, reason: 'already-used' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  const info = stmts.consumeToken.run(Date.now(), token);
  if (info.changes === 0) return { ok: false, reason: 'race' };
  return { ok: true, email: row.email };
}

function pruneExpired() {
  const now = Date.now();
  stmts.pruneExpired.run(now);
  stmts.pruneSessions.run(now);
}

module.exports = {
  db, DB_PATH,
  getOrCreateUser, createSession, getSession, deleteSession,
  createMagicToken, consumeMagicToken, pruneExpired,
};
