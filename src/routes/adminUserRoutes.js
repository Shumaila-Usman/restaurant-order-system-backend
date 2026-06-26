const express = require('express');
const RestaurantUser = require('../models/RestaurantUser');
const Restaurant = require('../models/Restaurant');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { decryptCredential } = require('../utils/credentialCrypto');

const router = express.Router();

router.use(requireAdminAuth);

// ─── Helper: safe user shape (never returns passwordHash or encrypted fields) ─

function safeUser(user) {
  return {
    _id: user._id,
    id: user._id,
    name: user.name,
    loginId: user.loginId,
    email: user.email,
    restaurantId: user.restaurantId,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    appPasswordUpdatedAt: user.appPasswordUpdatedAt || null,
  };
}

/**
 * POST /api/admin/restaurants/:restaurantId/users
 * Create a restaurant owner/staff user.
 */
router.post('/restaurants/:restaurantId/users', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, loginId, email, password, isActive } = req.body;

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!loginId && !email) return res.status(400).json({ error: 'At least one of loginId or email is required' });
    if (!password) return res.status(400).json({ error: 'password is required' });
    if (password.length < 3) return res.status(400).json({ error: 'Password must be at least 3 characters' });

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    if (loginId) {
      const existingLoginId = await RestaurantUser.findOne({ loginId: loginId.toLowerCase().trim() });
      if (existingLoginId) return res.status(409).json({ error: 'Login ID already in use' });
    }
    if (email) {
      const existingEmail = await RestaurantUser.findOne({ email: email.toLowerCase().trim() });
      if (existingEmail) return res.status(409).json({ error: 'Email already in use' });
    }

    const user = await RestaurantUser.create({
      restaurantId,
      name,
      loginId: loginId ? loginId.toLowerCase().trim() : null,
      email: email ? email.toLowerCase().trim() : null,
      passwordHash: password, // pre-save hook encrypts + hashes
      appPasswordUpdatedBy: req.admin?.id || 'admin',
      isActive: isActive !== undefined ? isActive : true,
    });

    console.log(
      `[Admin] Created app user: loginId="${user.loginId}" email="${user.email}" ` +
      `restaurant="${restaurant.name}" by admin="${req.admin?.email || 'unknown'}"`
    );

    res.status(201).json({ user: safeUser(user) });
  } catch (err) {
    console.error('[Admin] Create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * GET /api/admin/restaurants/:restaurantId/users
 * List all users for a restaurant.
 */
router.get('/restaurants/:restaurantId/users', async (req, res) => {
  try {
    const users = await RestaurantUser.find({ restaurantId: req.params.restaurantId })
      .select('-passwordHash -appPasswordEncrypted -passwordPlain')
      .lean();
    res.json({ users });
  } catch (err) {
    console.error('[Admin] List users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /api/admin/users/:userId/credentials
 * Get decrypted app login credentials for a user.
 * Admin-only — never exposed to mobile app or restaurant owner.
 *
 * Always returns HTTP 200. currentAppPassword is null if unavailable.
 * Response: { loginId, email, currentAppPassword, appPasswordUpdatedAt, message }
 */
router.get('/users/:userId/credentials', async (req, res) => {
  const { userId } = req.params;
  try {
    console.log(`[Credentials] GET credentials — userId="${userId}" by admin="${req.admin?.email || 'unknown'}"`);

    const user = await RestaurantUser.findById(userId)
      .select('loginId email appPasswordEncrypted appPasswordUpdatedAt appPasswordUpdatedBy passwordPlain')
      .lean();

    if (!user) {
      console.log(`[Credentials] User not found — userId="${userId}"`);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[Credentials] User found — loginId="${user.loginId}" appPasswordEncrypted=${!!user.appPasswordEncrypted} passwordPlain=${!!user.passwordPlain}`);

    // Audit log — do NOT log the actual password value
    console.log(
      `[Credentials] App password VIEWED — userId="${userId}" ` +
      `loginId="${user.loginId}" email="${user.email}" ` +
      `by admin="${req.admin?.email || 'unknown'}" at ${new Date().toISOString()}`
    );

    let currentAppPassword = null;
    let message = null;

    if (user.appPasswordEncrypted) {
      console.log(`[Credentials] Attempting decrypt — userId="${userId}"`);
      try {
        currentAppPassword = decryptCredential(user.appPasswordEncrypted);
        console.log(`[Credentials] Decrypt SUCCESS — userId="${userId}"`);
      } catch (err) {
        // Decryption failed — do NOT return 500, return null password with message
        console.error(`[Credentials] Decrypt FAILED — userId="${userId}" error="${err.message}"`);
        message = 'Could not decrypt stored password. The encryption key may have changed. Please set a new password.';
      }
    } else if (user.passwordPlain) {
      // Legacy fallback for users created before encryption was added
      console.log(`[Credentials] Using legacy passwordPlain fallback — userId="${userId}"`);
      currentAppPassword = user.passwordPlain;
      message = 'Using legacy stored password. Will be encrypted on next password reset.';
    } else {
      console.log(`[Credentials] No password stored — userId="${userId}"`);
      message = 'Current password not available for older records. Please set a new password below.';
    }

    // Always return 200 — frontend handles null currentAppPassword gracefully
    res.json({
      loginId: user.loginId,
      email: user.email,
      currentAppPassword,
      appPasswordUpdatedAt: user.appPasswordUpdatedAt || null,
      message,
    });
  } catch (err) {
    console.error(`[Credentials] Unexpected error — userId="${userId}" error="${err.message}"`);
    // Return 200 with null password rather than crashing the modal
    res.json({
      loginId: null,
      email: null,
      currentAppPassword: null,
      appPasswordUpdatedAt: null,
      message: 'Failed to load credentials. Please try again.',
    });
  }
});

/**
 * PATCH /api/admin/users/:userId/password
 * Reset app login password.
 * Updates passwordHash (bcrypt) + appPasswordEncrypted (AES-256-GCM).
 * IMPORTANT: registered BEFORE PATCH /users/:userId to avoid route conflict.
 */
router.patch('/users/:userId/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const user = await RestaurantUser.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Set updatedBy before save so pre-save hook can read it
    user.appPasswordUpdatedBy = req.admin?.id || 'admin';
    user.passwordHash = password; // pre-save hook encrypts + hashes

    await user.save();

    // Audit log — do NOT log the actual password
    console.log(
      `[Credentials] App password CHANGED — userId="${user._id}" ` +
      `loginId="${user.loginId}" email="${user.email}" ` +
      `by admin="${req.admin?.email || 'unknown'}" at ${new Date().toISOString()}`
    );

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[Admin] Change password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * PATCH /api/admin/users/:userId
 * Update user name, loginId, email, or isActive.
 */
router.patch('/users/:userId', async (req, res) => {
  try {
    const { name, loginId, email, isActive } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (loginId !== undefined) updates.loginId = loginId ? loginId.toLowerCase().trim() : null;
    if (email !== undefined) updates.email = email ? email.toLowerCase().trim() : null;
    if (isActive !== undefined) updates.isActive = isActive;

    const user = await RestaurantUser.findByIdAndUpdate(
      req.params.userId,
      { $set: updates },
      { new: true }
    ).select('-passwordHash -appPasswordEncrypted -passwordPlain');

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user });
  } catch (err) {
    console.error('[Admin] Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/admin/users/:userId
 */
router.delete('/users/:userId', async (req, res) => {
  try {
    const user = await RestaurantUser.findByIdAndDelete(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`[Admin] Deleted user: loginId="${user.loginId}" email="${user.email}"`);
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[Admin] Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
