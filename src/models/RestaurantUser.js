const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * RestaurantUser — restaurant owner / staff account.
 *
 * loginId: optional unique username (e.g. "onopoke_owner").
 *          Admin sets this in MCP. Owner can login with loginId OR email.
 * email:   now optional (sparse unique index — allows multiple null values).
 *
 * Password minimum: 3 characters (client requirement — simple PINs like "123").
 *
 * SECURITY NOTE: We do NOT store plain-text passwords.
 * passwordHash is always bcrypt-hashed.
 * Admin can RESET password anytime but cannot VIEW the old one.
 * If admin needs to share credentials with owner, they set a known password at creation time.
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
    // Sparse unique: multiple users can have null loginId, but non-null values must be unique
    loginId: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    // Email is now optional — owner can login with loginId instead
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    passwordHash: {
      type: String,
      required: true,
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

// Hash password before saving (passwordHash field is set to plain text first)
restaurantUserSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();
  // Minimum 3 chars enforced at route level; hash whatever comes in
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
  next();
});

restaurantUserSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = mongoose.model('RestaurantUser', restaurantUserSchema, 'restaurantusers');
