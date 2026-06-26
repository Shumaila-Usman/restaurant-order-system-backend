/**
 * credentialCrypto.js
 *
 * AES-256-GCM encryption/decryption for credential vault fields.
 *
 * Storage format: "<iv_base64>:<authTag_base64>:<ciphertext_base64>"
 * All three segments are base64-encoded and joined with colons.
 *
 * Key setup:
 *   Set CREDENTIAL_ENCRYPTION_KEY in .env as a 32-byte base64 string.
 *   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV — recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

// ─── Key loading ──────────────────────────────────────────────────────────────

let _key = null;

function getKey() {
  // Return cached key — same key used for all encrypt/decrypt in this process
  if (_key) return _key;

  const raw = (process.env.CREDENTIAL_ENCRYPTION_KEY || '').trim();

  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[CredentialCrypto] CREDENTIAL_ENCRYPTION_KEY is required in production. ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }
    // Dev fallback — deterministic, same key every restart
    console.warn(
      '[CredentialCrypto] WARNING: CREDENTIAL_ENCRYPTION_KEY not set. ' +
      'Using insecure dev fallback key. Set this env var before deploying to production.'
    );
    _key = crypto.scryptSync('dev-fallback-key-do-not-use-in-prod', 'salt-v1', 32);
    return _key;
  }

  // Try base64 first (preferred format)
  const b64Buf = Buffer.from(raw, 'base64');
  if (b64Buf.length === 32) {
    _key = b64Buf;
    return _key;
  }

  // Try hex
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    _key = Buffer.from(raw, 'hex');
    return _key;
  }

  throw new Error(
    `[CredentialCrypto] CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes. ` +
    `Got ${b64Buf.length} bytes from base64. ` +
    'Generate a valid key: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
  );
}

// ─── Encrypt ──────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext credential string.
 *
 * @param {string} plainText
 * @returns {string|null} "<iv_b64>:<tag_b64>:<ciphertext_b64>", or null if input is empty.
 */
function encryptCredential(plainText) {
  if (plainText == null || plainText === '') return null;

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

// ─── Decrypt ──────────────────────────────────────────────────────────────────

/**
 * Decrypt an encrypted credential payload.
 *
 * @param {string} encryptedPayload  "<iv_b64>:<tag_b64>:<ciphertext_b64>"
 * @returns {string|null} Decrypted plaintext, or null if payload is empty/null.
 * @throws {Error} If format is wrong, key is wrong, or data is tampered.
 */
function decryptCredential(encryptedPayload) {
  if (encryptedPayload == null || encryptedPayload === '') return null;

  if (typeof encryptedPayload !== 'string') {
    throw new Error('[CredentialCrypto] encryptedPayload must be a string');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `[CredentialCrypto] Invalid payload format — expected 3 colon-separated parts, got ${parts.length}`
    );
  }

  const key = getKey();

  let iv, tag, ciphertext;
  try {
    iv = Buffer.from(parts[0], 'base64');
    tag = Buffer.from(parts[1], 'base64');
    ciphertext = Buffer.from(parts[2], 'base64');
  } catch (err) {
    throw new Error('[CredentialCrypto] Failed to decode payload segments: ' + err.message);
  }

  if (iv.length !== IV_LENGTH) {
    throw new Error(`[CredentialCrypto] Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`[CredentialCrypto] Invalid auth tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(
      '[CredentialCrypto] Decryption failed — key mismatch or tampered data. ' + err.message
    );
  }
}

// ─── Self-test ────────────────────────────────────────────────────────────────

/**
 * Verify encrypt/decrypt round-trip works with the current key.
 * Call on server startup to catch key misconfiguration early.
 */
function selfTest() {
  const test = 'credential-crypto-self-test-v1';
  const enc = encryptCredential(test);
  if (!enc) throw new Error('[CredentialCrypto] Self-test FAILED — encryptCredential returned null');
  const dec = decryptCredential(enc);
  if (dec !== test) {
    throw new Error('[CredentialCrypto] Self-test FAILED — round-trip mismatch');
  }
  return true;
}

module.exports = { encryptCredential, decryptCredential, selfTest };
