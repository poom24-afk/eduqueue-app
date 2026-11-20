const crypto = require('node:crypto');

const SESSION_COOKIE = 'eduqueue_session';
const SESSION_TTL_DAYS = 7;

/**
 * Hash a plaintext password using scrypt with a random 16-byte salt.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Verify a plaintext password against a stored `salt:hash` string.
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHex] = storedHash.split(':');
  const derived = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(originalHex, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

/**
 * Parse the `Cookie` header into a key/value map without extra dependencies.
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

/**
 * Create a persisted session for the given user and return its token.
 */
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expiresAt);
  return { token, expiresAt };
}

/**
 * Look up an active, non-expired session and its associated user.
 */
function getSessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.student_code, u.role, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    studentCode: row.student_code,
    role: row.role,
    createdAt: row.created_at,
  };
}

/**
 * Set or clear the HTTP-only session cookie.
 */
function setSessionCookie(res, token) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

/**
 * Extract bearer token or session cookie from request.
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  extractToken,
};
