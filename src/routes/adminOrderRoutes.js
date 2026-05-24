const express = require('express');
const Restaurant = require('../models/Restaurant');
const OrderOverride = require('../models/OrderOverride');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { fetchPaidOrdersFromSource } = require('../utils/sourceDb');
const { normalizeSourceOrder } = require('../utils/normalizeOrder');

const router = express.Router();

router.use(requireAdminAuth);

/**
 * GET /api/admin/orders
 * Fetch paid orders from ALL active restaurants.
 * Query params:
 *   limit        (default 50 per restaurant)
 *   restaurantId (filter to one restaurant)
 *   search       (filter by order number or customer name)
 *   fromDate     (ISO date string)
 *   toDate       (ISO date string)
 *   page         (default 1)
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const { restaurantId: filterRestaurantId, search, fromDate, toDate } = req.query;

    const restaurantQuery = filterRestaurantId
      ? { isActive: true, _id: filterRestaurantId }
      : { isActive: true };

    const restaurants = await Restaurant.find(restaurantQuery).lean();

    const allOrders = [];

    for (const restaurant of restaurants) {
      try {
        const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit });
        const sourceIds = rawOrders.map((o) => o._id.toString());

        const overrides = await OrderOverride.find({
          restaurantId: restaurant._id,
          sourceOrderId: { $in: sourceIds },
        }).lean();

        const overrideMap = {};
        for (const ov of overrides) overrideMap[ov.sourceOrderId] = ov;

        for (const raw of rawOrders) {
          const override = overrideMap[raw._id.toString()] || null;
          const normalized = normalizeSourceOrder(raw, restaurant, override);
          delete normalized._detectedPickupFields;
          allOrders.push(normalized);
        }
      } catch (err) {
        console.error(`[AdminOrders] Failed for restaurant="${restaurant.name}": ${err.message}`);
      }
    }

    // Sort by createdAt descending
    allOrders.sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const db = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return db - da;
    });

    // Apply filters
    let filtered = allOrders;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.orderNumber || '').toLowerCase().includes(q) ||
        (o.customerName || '').toLowerCase().includes(q) ||
        (o.customerEmail || '').toLowerCase().includes(q)
      );
    }
    if (fromDate) {
      const from = new Date(fromDate);
      filtered = filtered.filter((o) => o.createdAt && new Date(o.createdAt) >= from);
    }
    if (toDate) {
      const to = new Date(toDate);
      filtered = filtered.filter((o) => o.createdAt && new Date(o.createdAt) <= to);
    }

    res.json({ orders: filtered, total: filtered.length });
  } catch (err) {
    console.error('[AdminOrders] Fetch all orders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/admin/orders/:id
 * Get a single order by sourceOrderId.
 * Query param: restaurantId (required)
 */
router.get('/:id', async (req, res) => {
  try {
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId query param is required' });
    }

    const restaurant = await Restaurant.findById(restaurantId).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit: 200 });
    const raw = rawOrders.find((o) => o._id.toString() === req.params.id);
    if (!raw) return res.status(404).json({ error: 'Order not found' });

    const override = await OrderOverride.findOne({
      restaurantId: restaurant._id,
      sourceOrderId: req.params.id,
    }).lean();

    res.json({ order: normalizeSourceOrder(raw, restaurant, override) });
  } catch (err) {
    console.error('[AdminOrders] Get order error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;
