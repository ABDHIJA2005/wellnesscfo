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

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function safelyMatchesTokenHash(storedHash, candidateHash) {
  if (!/^[a-f0-9]{64}$/i.test(storedHash || '') || !/^[a-f0-9]{64}$/i.test(candidateHash || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(candidateHash, 'hex'));
}

function createSession(db, userId, daysValid = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expires = new Date(now.getTime() + daysValid * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash, userId, now.toISOString(), expires.toISOString());

  return { token, expiresAt: expires.toISOString() };
}

function getUserFromSession(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const now = new Date().toISOString();
  const selectSession = `
    SELECT s.token, s.user_id, s.expires_at, u.id, u.email, u.name, u.motto, u.avatar_text
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `;
  const tokenHash = hashSessionToken(token);
  const hashedSession = db.prepare(selectSession).get(tokenHash, now);
  if (hashedSession && safelyMatchesTokenHash(hashedSession.token, tokenHash)) {
    delete hashedSession.token;
    return hashedSession;
  }

  // Upgrade valid sessions created by older versions without logging the user out.
  const legacySession = db.prepare(selectSession).get(token, now);
  if (!legacySession || !safelyMatchesTokenHash(hashSessionToken(legacySession.token), tokenHash)) return null;
  db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(tokenHash, token);
  delete legacySession.token;
  return legacySession;

}

function deleteSession(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return;
  db.prepare('DELETE FROM sessions WHERE token IN (?, ?)').run(hashSessionToken(token), token);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromSession,
  deleteSession
};
