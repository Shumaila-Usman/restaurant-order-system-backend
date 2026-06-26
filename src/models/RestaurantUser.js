const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encryptCredential } = require('../utils/credentialCrypto');

/**
 * RestaurantUser — restaurant owner / staff account for the mobile app.
 *
 * loginId: optional unique username (e.g. "onopoke_owner").
 *          Admin sets this in MCP. Owner can login with loginId OR email.
 * email:   optional — owner can login with loginId instead.
 *
 * Password minimum: 3 characters (client requirement — simple PINs like "123").
 *
 * SECURITY:
 *   - passwordHash: bcrypt hash — used for authentication. Cannot be reversed.
 *   - appPasswordEncrypted: AES-256-GCM encrypted copy — used ONLY for MCP admin
 *     credential visibility. Never returned to mobile app or restaurant owner.
 *   - passwordPlain: legacy field from earlier implementation — kept for backward
 *     compat but superseded by appPasswordEncrypted.
 */
const restaurantUserSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Restaurant',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Login ID / username — admin-assigned, owner uses this to login
    loginId: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    // Email — optional, owner can login with loginId instead
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    // bcrypt hash — used for authentication only
    passwordHash: {
      type: String,
      required: true,
    },
    // AES-256-GCM encrypted password — MCP admin visibility only
    appPasswordEncrypted: {
      type: String,
      default: null,
    },
    appPasswordUpdatedAt: {
      type: Date,
      default: null,
    },
    appPasswordUpdatedBy: {
      type: String, // admin user ID or name
      default: null,
    },
    // Legacy plain-text field — kept for backward compat, superseded by appPasswordEncrypted
    passwordPlain: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'restaurantusers',
  }
);

// Sparse unique indexes: null values are excluded from uniqueness check
restaurantUserSchema.index({ loginId: 1 }, { unique: true, sparse: true });
restaurantUserSchema.index({ email: 1 }, { unique: true, sparse: true });

/**
 * Pre-save hook: when passwordHash is modified (set to plain text),
 * encrypt it into appPasswordEncrypted, then bcrypt-hash it.
 */
restaurantUserSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();

  const plain = this.passwordHash; // plain text at this point

  // 1. Encrypt for MCP admin visibility
  try {
    this.appPasswordEncrypted = encryptCredential(plain);
    this.appPasswordUpdatedAt = new Date();
    // appPasswordUpdatedBy is set by the route before calling save()
  } catch (err) {
    console.warn('[RestaurantUser] Could not encrypt app password:', err.message);
    // Non-fatal — authentication still works via bcrypt
  }

  // 2. Keep legacy passwordPlain for backward compat
  this.passwordPlain = plain;

  // 3. bcrypt hash for authentication
  this.passwordHash = await bcrypt.hash(plain, 12);

  next();
});

restaurantUserSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = mongoose.model('RestaurantUser', restaurantUserSchema, 'restaurantusers');
