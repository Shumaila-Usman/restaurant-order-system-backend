const express = require('express');
const Restaurant = require('../models/Restaurant');
const DeviceToken = require('../models/DeviceToken');
const { getSourceDbConnection } = require('../utils/sourceDb');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { getFirebaseAdmin } = require('../config/firebase');
const mongoose = require('mongoose');

const router = express.Router();

// Debug routes require admin auth
router.use(requireAdminAuth);

/**
 * GET /api/debug/restaurants/:id/config
 * Show the restaurant config (masks sourceDbUri).
 */
router.get('/restaurants/:id/config', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    console.log(`[Debug] restaurant config: name="${restaurant.name}" key="${restaurant.restaurantKey}"`);
    console.log(`[Debug] restaurant config timezone: ${restaurant.timezone || '(not set)'}`);
    console.log(`[Debug] source db: "${restaurant.sourceDbName}" collection: "${restaurant.sourceOrderCollection}"`);

    // Mask the URI but show the host portion for debugging
    let maskedUri = '***';
    try {
      const url = new URL(restaurant.sourceDbUri);
      maskedUri = `${url.protocol}//*****@${url.host}/${url.pathname.slice(1)}`;
    } catch {
      maskedUri = '*** (invalid URI)';
    }

    res.json({
      restaurant: {
        ...restaurant,
        sourceDbUri: maskedUri,
      },
    });
  } catch (err) {
    console.error('[Debug] Config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/debug/restaurants/:id/latest-orders
 * Fetch the 5 most recent orders from the restaurant's source DB.
 * Useful for verifying field names and data shape.
 */
router.get('/restaurants/:id/latest-orders', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    console.log(`[Debug] latest-orders: restaurant="${restaurant.name}" key="${restaurant.restaurantKey}"`);
    console.log(`[Debug] restaurant config timezone: ${restaurant.timezone || '(not set)'}`);
    console.log(`[Debug] source db: "${restaurant.sourceDbName}" collection: "${restaurant.sourceOrderCollection}"`);

    const conn = await getSourceDbConnection(restaurant);

    const modelName = `DebugOrder_${restaurant.restaurantKey}`;
    let OrderModel;
    try {
      OrderModel = conn.model(modelName);
    } catch {
      const schema = new mongoose.Schema({}, { strict: false });
      OrderModel = conn.model(modelName, schema, restaurant.sourceOrderCollection);
    }

    const orders = await OrderModel.find({}).sort({ _id: -1 }).limit(5).lean();

    // Show all field names present in the first order (helps configure field mappings)
    const fieldNames = orders.length > 0 ? Object.keys(orders[0]) : [];

    res.json({
      restaurantName: restaurant.name,
      restaurantKey: restaurant.restaurantKey,
      sourceDbName: restaurant.sourceDbName,
      sourceOrderCollection: restaurant.sourceOrderCollection,
      totalFetched: orders.length,
      fieldNamesInFirstOrder: fieldNames,
      orders,
    });
  } catch (err) {
    console.error('[Debug] Latest orders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/debug/restaurants/:id/collections
 * List all collections in the restaurant's source DB.
 * Useful for discovering where admin users are stored.
 */
router.get('/restaurants/:id/collections', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const conn = await getSourceDbConnection(restaurant);
    const collections = await conn.db.listCollections().toArray();
    const names = collections.map((c) => c.name).sort();

    res.json({
      restaurantName: restaurant.name,
      sourceDbName: restaurant.sourceDbName,
      collections: names,
    });
  } catch (err) {
    console.error('[Debug] List collections error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/debug/restaurants/:id/collection/:collectionName/sample
 * Fetch 3 sample documents from a collection (field names only, values masked).
 * Useful for finding the password field in the admin users collection.
 */
router.get('/restaurants/:id/collection/:collectionName/sample', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const conn = await getSourceDbConnection(restaurant);
    const schema = new mongoose.Schema({}, { strict: false });
    const modelName = `Sample_${restaurant.restaurantKey}_${req.params.collectionName}`;
    let Model;
    try {
      Model = conn.model(modelName);
    } catch {
      Model = conn.model(modelName, schema, req.params.collectionName);
    }

    const docs = await Model.find({}).limit(3).lean();

    // Return field names + masked values (don't expose real passwords/emails)
    const masked = docs.map((doc) => {
      const out = {};
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v === 'string' && v.length > 20) {
          out[k] = v.substring(0, 6) + '***';
        } else {
          out[k] = v;
        }
      }
      return out;
    });

    res.json({
      restaurantName: restaurant.name,
      collection: req.params.collectionName,
      fieldNames: docs.length > 0 ? Object.keys(docs[0]) : [],
      sampleDocs: masked,
    });
  } catch (err) {
    console.error('[Debug] Sample collection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/debug/send-test-notification
 * Send a test FCM notification to all active device tokens for a restaurant.
 * Body: { restaurantId, title, body }
 *
 * Uses the same production-style payload as the cron job.
 * Useful for testing notification delivery without inserting a real order.
 */
router.post('/send-test-notification', async (req, res) => {
  try {
    const { restaurantId, title, body } = req.body;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId is required' });

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const deviceTokens = await DeviceToken.find({
      restaurantId: restaurant._id,
      isActive: true,
      tokenType: 'fcm',
    }).select('token platform').lean();

    if (deviceTokens.length === 0) {
      return res.json({ success: false, message: 'No active device tokens found for this restaurant' });
    }

    const adminSdk = getFirebaseAdmin();
    if (!adminSdk) {
      return res.status(500).json({ error: 'Firebase not initialized on server' });
    }

    const notifTitle = title || `🔔 Test Notification`;
    const notifBody = body || `Test from ${restaurant.name} — ${new Date().toLocaleTimeString()}`;

    const results = [];
    for (const dt of deviceTokens) {
      try {
        const messageId = await adminSdk.messaging().send({
          notification: { title: notifTitle, body: notifBody },
          data: {
            type: 'NEW_ORDER',
            restaurantId: restaurant._id.toString(),
            restaurantKey: restaurant.restaurantKey,
            restaurantName: restaurant.name,
            restaurantTimezone: restaurant.timezone || 'America/New_York',
            sourceOrderId: 'test-' + Date.now(),
            orderNumber: 'TEST-' + Date.now(),
            customerName: 'Test Customer',
            total: '0',
            currency: restaurant.currencyCode || 'USD',
            pickupMode: 'asap',
            pickupTime: '',
            createdAt: new Date().toISOString(),
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'notification',
              channelId: 'new-orders-v2',
              priority: 'max',
              defaultSound: false,
            },
          },
          token: dt.token,
        });
        results.push({ platform: dt.platform, success: true, messageId });
        console.log(`[Debug] Test notification sent: platform="${dt.platform}" messageId="${messageId}"`);
      } catch (err) {
        results.push({ platform: dt.platform, success: false, error: err.message });
        console.error(`[Debug] Test notification failed: ${err.message}`);
      }
    }

    res.json({ success: true, restaurant: restaurant.name, results });
  } catch (err) {
    console.error('[Debug] Send test notification error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
