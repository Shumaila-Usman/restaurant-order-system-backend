const express = require('express');
const jwt = require('jsonwebtoken');
const RestaurantUser = require('../models/RestaurantUser');
const Restaurant = require('../models/Restaurant');
const { requireOwnerAuth } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * POST /api/auth/login
 * Restaurant owner login.
 *
 * Accepts:
 *   { login: "loginId-or-email", password: "..." }   ← new format
 *   { email: "...", password: "..." }                 ← backward compatible
 *
 * Login search order:
 *   1. loginId (exact match, case-insensitive)
 *   2. email (exact match, case-insensitive)
 */
router.post('/login', async (req, res) => {
  try {
    const { login, email, password } = req.body;

    // Support both { login, password } and legacy { email, password }
    const loginValue = (login || email || '').trim().toLowerCase();

    if (!loginValue || !password) {
      return res.status(400).json({ error: 'Login ID (or email) and password are required' });
    }

    // Try loginId first, then email
    let user = await RestaurantUser.findOne({ loginId: loginValue });
    if (!user) {
      user = await RestaurantUser.findOne({ email: loginValue });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is inactive. Contact your administrator.' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const restaurant = await Restaurant.findById(user.restaurantId).lean();
    if (!restaurant || !restaurant.isActive) {
      return res.status(403).json({ error: 'Restaurant is inactive or not found' });
    }

    const token = jwt.sign(
      {
        type: 'owner',
        userId: user._id.toString(),
        restaurantId: restaurant._id.toString(),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        loginId: user.loginId,
        restaurantId: restaurant._id,
        restaurantName: restaurant.name,
        restaurantKey: restaurant.restaurantKey,
        restaurantTimezone: restaurant.timezone,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated restaurant owner's profile.
 */
router.get('/me', requireOwnerAuth, async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      loginId: req.user.loginId,
      restaurantId: req.restaurant._id,
      restaurantName: req.restaurant.name,
      restaurantKey: req.restaurant.restaurantKey,
      restaurantTimezone: req.restaurant.timezone,
    },
  });
});

module.exports = router;
