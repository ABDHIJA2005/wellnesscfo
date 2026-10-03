// Privacy & Data Sanitization Layer for WellnessCFO AI Services

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';

  return text
    // 1. Redact Indian Aadhaar numbers (e.g. 1234 5678 9012 or aadhaar: 123456789012)
    .replace(/(?:aadhaar|uidai)?[\s:]*\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/gi, '[AADHAAR_REDACTED]')
    .replace(/(?:aadhaar|uidai)[\s:]*\b\d{12}\b/gi, '[AADHAAR_REDACTED]')
    // 2. Redact Indian PAN numbers (5 letters, 4 digits, 1 letter)
    .replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, '[PAN_REDACTED]')
    // 3. Redact Indian Phone Numbers (10 digits starting with 6-9, or prefixed with phone/mob/+91)
    .replace(/(?:phone|mob|mobile|call)?\s*(?:\+91[\-\s]?)?\b[6-9]\d{9}\b/gi, '[PHONE_REDACTED]')
    // 4. Redact Bank Account Numbers (remaining 9 to 18 continuous digits)
    .replace(/\b\d{9,18}\b/g, '[ACCOUNT_REDACTED]')
    // 5. Redact Email addresses
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]')
    // 6. Redact 4 to 6 digit OTP/PIN codes
    .replace(/\b(?:otp|pin|code)[\s:]*([0-9]{4,6})\b/gi, '[CODE_REDACTED]')
    // 7. Redact UPI IDs (e.g. user@okhdfcbank, user@upi)
    .replace(/\b[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}\b/g, '[UPI_REDACTED]')
    // 8. Redact bearer tokens and session identifiers
    .replace(/(?:bearer|token|session|auth)[\s:]+[A-Za-z0-9._~+/-]{8,}/gi, '[TOKEN_REDACTED]');
}

function sanitizeForLogs(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return sanitizeText(text)
    .replace(/(?:authorization|auth|token|session)[\s:]+[A-Za-z0-9._~+/-]{6,}/gi, '[TOKEN_REDACTED]')
    .replace(/\b(?:\d{9,18}|\d{4}[\s-]?\d{4}[\s-]?\d{4}|[6-9]\d{9})\b/g, '[ACCOUNT_REDACTED]');
}

function sanitizeTransactionForAI(tx) {
  if (!tx) return null;
  return {
    date: tx.date,
    amount: tx.amount,
    type: tx.type,
    category: tx.category || 'General',
    necessity: tx.necessity || 'Unclear',
    description: sanitizeText(tx.description || '')
  };
}

function sanitizeFinancialContext(context) {
  if (!context) return {};
  const sanitized = { ...context };

  // Strip internal database keys & tokens
  delete sanitized.userId;
  delete sanitized.sessionId;
  delete sanitized.token;

  if (Array.isArray(sanitized.transactions)) {
    sanitized.transactions = sanitized.transactions.map(sanitizeTransactionForAI);
  }

  if (Array.isArray(sanitized.accounts)) {
    sanitized.accounts = sanitized.accounts.map(a => ({
      name: sanitizeText(a.name),
      type: a.type,
      balance: a.balance
    }));
  }

  if (Array.isArray(sanitized.buckets)) {
    sanitized.buckets = sanitized.buckets.map(b => ({
      name: sanitizeText(b.name),
      type: b.type,
      balance: b.balance,
      target_amount: b.target_amount
    }));
  }

  return sanitized;
}

module.exports = {
  sanitizeText,
  sanitizeForLogs,
  sanitizeTransactionForAI,
  sanitizeFinancialContext
};
