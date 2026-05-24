const express = require('express');
const Restaurant = require('../models/Restaurant');
const OrderOverride = require('../models/OrderOverride');
const { requireOwnerAuth } = require('../middleware/authMiddleware');
const { fetchPaidOrdersFromSource } = require('../utils/sourceDb');
const { normalizeSourceOrder } = require('../utils/normalizeOrder');

const router = express.Router();

// All routes require restaurant owner auth
router.use(requireOwnerAuth);

/**
 * GET /api/orders
 * Fetch paid orders for the authenticated owner's restaurant.
 *
 * IMPORTANT: This endpoint NEVER marks notificationSent=true.
 * Only the cron job (/api/cron/check-paid-orders) may do that.
 *
 * Query params:
 *   status  - currently unused (all paid orders are returned regardless of orderStatus)
 *   limit   - max orders to return (default 100, max 200)
 */
router.get('/', async (req, res) => {
  try {
    const restaurant = req.restaurant;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);

    console.log(`[Orders] restaurant name: ${restaurant.name}`);
    console.log(`[Orders] restaurant key: ${restaurant.restaurantKey}`);
    console.log(`[Orders] restaurant timezone: ${restaurant.timezone || '(not set)'}`);
    console.log(`[Orders] source db: ${restaurant.sourceDbName} / collection: ${restaurant.sourceOrderCollection}`);

    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit });

    // Fetch all overrides for these orders in one query
    const sourceIds = rawOrders.map((o) => o._id.toString());
    const overrides = await OrderOverride.find({
      restaurantId: restaurant._id,
      sourceOrderId: { $in: sourceIds },
    }).lean();

    const overrideMap = {};
    for (const ov of overrides) {
      overrideMap[ov.sourceOrderId] = ov;
    }

    const orders = rawOrders.map((raw) => {
      const override = overrideMap[raw._id.toString()] || null;
      const normalized = normalizeSourceOrder(raw, restaurant, override);

      // Log normalized timezone for first order to confirm it's set correctly
      if (rawOrders.indexOf(raw) === 0) {
        console.log(`[Orders] normalized restaurantTimezone: ${normalized.restaurantTimezone}`);
        console.log(`[Orders] paid orders count: ${rawOrders.length}`);
      }

      // Log pickup detection for the first few orders (useful for debugging)
      if (normalized._detectedPickupFields?.length > 0) {
        console.log(
          `[Orders] order="${normalized.orderNumber}" pickupMode="${normalized.pickupMode}" ` +
          `detectedFields=[${normalized._detectedPickupFields.join(', ')}]`
        );
      }

      // Remove internal debug field from response
      delete normalized._detectedPickupFields;
      return normalized;
    });

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error('[Orders] Fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/orders/:id
 * Get a single order by sourceOrderId.
 */
router.get('/:id', async (req, res) => {
  try {
    const restaurant = req.restaurant;
    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit: 200 });
    const raw = rawOrders.find((o) => o._id.toString() === req.params.id);

    if (!raw) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const override = await OrderOverride.findOne({
      restaurantId: restaurant._id,
      sourceOrderId: req.params.id,
    }).lean();

    const normalized = normalizeSourceOrder(raw, restaurant, override);
    delete normalized._detectedPickupFields;

    res.json({ order: normalized });
  } catch (err) {
    console.error('[Orders] Get order error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * PATCH /api/orders/:id/prep-time
 * Save prep/completion time for an order.
 * Body: { prepTimeMinutes: number, customPrepTimeLabel: string }
 */
router.patch('/:id/prep-time', async (req, res) => {
  try {
    const restaurant = req.restaurant;
    const { prepTimeMinutes, customPrepTimeLabel, useCustomerPickupTime } = req.body;

    // Allow 0 as a valid value (used for "customer pickup time" sentinel)
    if (prepTimeMinutes === undefined && !useCustomerPickupTime) {
      return res.status(400).json({ error: 'prepTimeMinutes is required' });
    }

    const override = await OrderOverride.findOneAndUpdate(
      { restaurantId: restaurant._id, sourceOrderId: req.params.id },
      {
        $set: {
          prepTimeMinutes: Number(prepTimeMinutes ?? 0),
          customPrepTimeLabel: customPrepTimeLabel || null,
        },
        $setOnInsert: {
          restaurantId: restaurant._id,
          sourceOrderId: req.params.id,
        },
      },
      { upsert: true, new: true }
    );

    console.log(
      `[Orders] Prep time saved: restaurant="${restaurant.name}" ` +
      `order="${req.params.id}" prepTime=${prepTimeMinutes}min label="${customPrepTimeLabel || ''}"`
    );

    res.json({ override });
  } catch (err) {
    console.error('[Orders] Save prep time error:', err.message);
    res.status(500).json({ error: 'Failed to save prep time' });
  }
});

/**
 * PATCH /api/orders/:id/acknowledge
 * Mark an order as acknowledged by the restaurant owner.
 */
router.patch('/:id/acknowledge', async (req, res) => {
  try {
    const restaurant = req.restaurant;

    const override = await OrderOverride.findOneAndUpdate(
      { restaurantId: restaurant._id, sourceOrderId: req.params.id },
      {
        $set: { acknowledgedAt: new Date() },
        $setOnInsert: {
          restaurantId: restaurant._id,
          sourceOrderId: req.params.id,
        },
      },
      { upsert: true, new: true }
    );

    console.log(
      `[Orders] Acknowledged: restaurant="${restaurant.name}" order="${req.params.id}"`
    );

    res.json({ override });
  } catch (err) {
    console.error('[Orders] Acknowledge error:', err.message);
    res.status(500).json({ error: 'Failed to acknowledge order' });
  }
});

module.exports = router;
