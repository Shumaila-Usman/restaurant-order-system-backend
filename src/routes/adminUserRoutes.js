const express = require('express');
const RestaurantUser = require('../models/RestaurantUser');
const Restaurant = require('../models/Restaurant');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');

const router = express.Router();

router.use(requireAdminAuth);

/**
 * POST /api/admin/restaurants/:restaurantId/users
 * Create a restaurant owner/staff user.
 *
 * Body:
 *   name        (required)
 *   loginId     (optional) — unique login username, e.g. "onopoke_owner"
 *   email       (optional) — if provided must be unique
 *   password    (required) — minimum 3 characters (client requirement)
 *   isActive    (optional, default true)
 *
 * At least one of loginId or email must be provided.
 */
router.post('/restaurants/:restaurantId/users', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, loginId, email, password, isActive } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!loginId && !email) {
      return res.status(400).json({ error: 'At least one of loginId or email is required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'password is required' });
    }
    if (password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Check uniqueness
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
      passwordHash: password, // pre-save hook hashes this
      isActive: isActive !== undefined ? isActive : true,
    });

    console.log(
      `[Admin] Created user: loginId="${user.loginId}" email="${user.email}" restaurant="${restaurant.name}"`
    );

    res.status(201).json({
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        loginId: user.loginId,
        email: user.email,
        restaurantId: user.restaurantId,
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
    });
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
    const users = await RestaurantUser.find({
      restaurantId: req.params.restaurantId,
    })
      .select('-passwordHash')
      .lean();

    res.json({ users });
  } catch (err) {
    console.error('[Admin] List users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
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
    ).select('-passwordHash');

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user });
  } catch (err) {
    console.error('[Admin] Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * PATCH /api/admin/users/:userId/password
 * Change a restaurant owner's password.
 * Minimum 3 characters (client requirement).
 */
router.patch('/users/:userId/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 3) {
      return res.status(400).json({ error: 'Password must be at least 3 characters' });
    }

    const user = await RestaurantUser.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.passwordHash = password; // pre-save hook hashes it
    await user.save();

    console.log(`[Admin] Password changed for user: loginId="${user.loginId}" email="${user.email}"`);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[Admin] Change password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Delete a restaurant owner user.
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
