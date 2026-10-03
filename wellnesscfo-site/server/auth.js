const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const derivedKey = crypto.scryptSync(password, salt, 64);
  const hashBuffer = Buffer.from(hash, 'hex');
  if (derivedKey.length !== hashBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedKey, hashBuffer);
}

function createSession(db, userId, daysValid = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + daysValid * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, now.toISOString(), expires.toISOString());

  return { token, expiresAt: expires.toISOString() };
}

function getUserFromSession(db, token) {
  if (!token) return null;
  const now = new Date().toISOString();
  const session = db.prepare(`
    SELECT s.token, s.user_id, s.expires_at, u.id, u.email, u.name, u.motto, u.avatar_text
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);

  return session || null;
}

function deleteSession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromSession,
  deleteSession
};
