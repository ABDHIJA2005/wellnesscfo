'use strict';

const MAX_AVATAR_BYTES = 512 * 1024;
const DATE_FORMATS = new Set(['en-IN', 'numeric']);
const AVATAR_SIGNATURES = {
  'image/png': bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  'image/webp': bytes => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
};

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanOptional(value, label, maxLength) {
  if (value == null) return null;
  if (typeof value !== 'string') throw validationError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw validationError(`${label} must be ${maxLength} characters or fewer`);
  return trimmed || null;
}

function ensureUserProfile(db, userId) {
  db.prepare(`INSERT OR IGNORE INTO user_profiles (user_id, name, finance_motto)
    SELECT id, name, motto FROM users WHERE id = ?`).run(userId);
  db.prepare(`INSERT OR IGNORE INTO user_preferences (user_id) SELECT id FROM users WHERE id = ?`).run(userId);
}

function getProfile(db, userId) {
  ensureUserProfile(db, userId);
  const row = db.prepare(`
    SELECT u.email, p.name, p.something_love, p.finance_motto,
      EXISTS(SELECT 1 FROM profile_avatars a WHERE a.user_id = u.id) AS has_avatar
    FROM users u JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?
  `).get(userId);
  if (!row) return null;
  return {
    name: row.name,
    email: row.email,
    somethingILove: row.something_love || '',
    financeMotto: row.finance_motto || '',
    avatarText: Array.from(row.name.trim())[0]?.toUpperCase() || 'A',
    hasAvatar: Boolean(row.has_avatar)
  };
}

function updateProfile(db, userId, input = {}) {
  ensureUserProfile(db, userId);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw validationError('Name is required');
  if (Array.from(name).length > 80) throw validationError('Name must be 80 characters or fewer');
  const somethingLove = cleanOptional(input.somethingILove, 'Something I love', 120);
  const motto = cleanOptional(input.financeMotto, 'Finance motto', 160);
  const avatarText = Array.from(name)[0]?.toUpperCase() || 'A';

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE user_profiles SET name = ?, something_love = ?, finance_motto = ?, updated_at = ? WHERE user_id = ?')
      .run(name, somethingLove, motto, new Date().toISOString(), userId);
    // Keep the existing authenticated-user and dashboard name fields in sync.
    db.prepare('UPDATE users SET name = ?, motto = ?, avatar_text = ? WHERE id = ?')
      .run(name, motto, avatarText, userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getProfile(db, userId);
}

function getPreferences(db, userId) {
  ensureUserProfile(db, userId);
  const row = db.prepare('SELECT currency, date_format FROM user_preferences WHERE user_id = ?').get(userId);
  return { currency: row.currency, dateFormat: row.date_format };
}

function updatePreferences(db, userId, input = {}) {
  ensureUserProfile(db, userId);
  const currency = input.currency ?? 'INR';
  const dateFormat = input.dateFormat ?? 'en-IN';
  if (currency !== 'INR') throw validationError('INR is the only supported calculation currency');
  if (!DATE_FORMATS.has(dateFormat)) throw validationError('Choose a supported date format');
  db.prepare('UPDATE user_preferences SET currency = ?, date_format = ?, updated_at = ? WHERE user_id = ?')
    .run(currency, dateFormat, new Date().toISOString(), userId);
  return getPreferences(db, userId);
}

function decodeAvatarDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw validationError('Choose a PNG, JPEG, or WebP image');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw validationError('Choose a PNG, JPEG, or WebP image');
  const [, mimeType, encoded] = match;
  if (encoded.length % 4 !== 0) throw validationError('The image data is invalid');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) throw validationError('Avatar images must be 512 KB or smaller');
  if (bytes.toString('base64') !== encoded || !AVATAR_SIGNATURES[mimeType](bytes)) {
    throw validationError('The image contents do not match the selected file type');
  }
  return { mimeType, bytes };
}

function saveAvatar(db, userId, dataUrl) {
  const { mimeType, bytes } = decodeAvatarDataUrl(dataUrl);
  db.prepare(`INSERT INTO profile_avatars (user_id, mime_type, image_data, byte_size, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET mime_type=excluded.mime_type, image_data=excluded.image_data,
      byte_size=excluded.byte_size, updated_at=excluded.updated_at`)
    .run(userId, mimeType, bytes, bytes.length, new Date().toISOString());
  return { hasAvatar: true };
}

function getAvatarDataUrl(db, userId) {
  const row = db.prepare('SELECT mime_type, image_data FROM profile_avatars WHERE user_id = ?').get(userId);
  return row ? `data:${row.mime_type};base64,${Buffer.from(row.image_data).toString('base64')}` : null;
}

function deleteAvatar(db, userId) {
  db.prepare('DELETE FROM profile_avatars WHERE user_id = ?').run(userId);
  return { hasAvatar: false };
}

module.exports = {
  MAX_AVATAR_BYTES,
  ensureUserProfile,
  getProfile,
  updateProfile,
  getPreferences,
  updatePreferences,
  saveAvatar,
  getAvatarDataUrl,
  deleteAvatar
};
