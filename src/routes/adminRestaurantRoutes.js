const express = require('express');
const Restaurant = require('../models/Restaurant');
const OrderOverride = require('../models/OrderOverride');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { fetchPaidOrdersFromSource } = require('../utils/sourceDb');
const { normalizeSourceOrder } = require('../utils/normalizeOrder');

const router = express.Router();

router.use(requireAdminAuth);

/**
 * POST /api/admin/restaurants
 * Create a new restaurant.
 */
router.post('/', async (req, res) => {
  try {
    const {
      name, restaurantKey, timezone,
      currencyCode, currencySymbol,
      sourceDbUri, sourceDbName, sourceOrderCollection,
      sourcePaymentStatusField, sourcePaidValue,
      sourceOrderNumberField, sourceOrderTypeField, sourceItemsField,
      sourceOrderNoteField, sourceFulfillmentTypeField,
      isActive,
    } = req.body;

    if (!name || !restaurantKey || !sourceDbUri || !sourceDbName) {
      return res.status(400).json({
        error: 'name, restaurantKey, sourceDbUri, and sourceDbName are required',
      });
    }

    const existing = await Restaurant.findOne({ restaurantKey: restaurantKey.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'restaurantKey already exists' });

    const restaurant = await Restaurant.create({
      name,
      restaurantKey: restaurantKey.toLowerCase(),
      timezone: timezone || 'America/New_York',
      currencyCode: currencyCode || 'USD',
      currencySymbol: currencySymbol || '$',
      sourceDbUri,
      sourceDbName,
      sourceOrderCollection: sourceOrderCollection || 'orders',
      sourcePaymentStatusField: sourcePaymentStatusField || 'paymentStatus',
      sourcePaidValue: sourcePaidValue || 'paid',
      sourceOrderNumberField: sourceOrderNumberField || 'orderNumber',
      sourceOrderTypeField: sourceOrderTypeField || 'orderType',
      sourceItemsField: sourceItemsField || 'items',
      sourceOrderNoteField: sourceOrderNoteField || null,
      sourceFulfillmentTypeField: sourceFulfillmentTypeField || null,
      isActive: isActive !== undefined ? isActive : true,
    });

    console.log(`[Admin] Created restaurant: name="${restaurant.name}" key="${restaurant.restaurantKey}"`);
    res.status(201).json({ restaurant });
  } catch (err) {
    console.error('[Admin] Create restaurant error:', err.message);
    res.status(500).json({ error: 'Failed to create restaurant' });
  }
});

/**
 * GET /api/admin/restaurants
 * List all restaurants.
 */
router.get('/', async (req, res) => {
  try {
    const restaurants = await Restaurant.find().sort({ name: 1 }).lean();
    const masked = restaurants.map((r) => ({ ...r, sourceDbUri: r.sourceDbUri ? '***' : null }));
    res.json({ restaurants: masked });
  } catch (err) {
    console.error('[Admin] List restaurants error:', err.message);
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

/**
 * GET /api/admin/restaurants/:id
 * Get a single restaurant (includes full sourceDbUri for editing).
 */
router.get('/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ restaurant });
  } catch (err) {
    console.error('[Admin] Get restaurant error:', err.message);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

/**
 * PATCH /api/admin/restaurants/:id
 * Update a restaurant.
 */
router.patch('/:id', async (req, res) => {
  try {
    const allowedFields = [
      'name', 'restaurantKey', 'timezone',
      'currencyCode', 'currencySymbol',
      'sourceDbUri', 'sourceDbName', 'sourceOrderCollection',
      'sourcePaymentStatusField', 'sourcePaidValue',
      'sourceOrderNumberField', 'sourceOrderTypeField', 'sourceItemsField',
      'sourceOrderNoteField', 'sourceFulfillmentTypeField',
      'isActive',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (updates.restaurantKey) updates.restaurantKey = updates.restaurantKey.toLowerCase();

    const restaurant = await Restaurant.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    console.log(`[Admin] Updated restaurant: name="${restaurant.name}" key="${restaurant.restaurantKey}"`);
    res.json({ restaurant });
  } catch (err) {
    console.error('[Admin] Update restaurant error:', err.message);
    res.status(500).json({ error: 'Failed to update restaurant' });
  }
});

/**
 * DELETE /api/admin/restaurants/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const restaurant = await Restaurant.findByIdAndDelete(req.params.id).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    console.log(`[Admin] Deleted restaurant: name="${restaurant.name}"`);
    res.json({ message: 'Restaurant deleted' });
  } catch (err) {
    console.error('[Admin] Delete restaurant error:', err.message);
    res.status(500).json({ error: 'Failed to delete restaurant' });
  }
});

// ─── Restaurant orders ────────────────────────────────────────────────────────

/**
 * GET /api/admin/restaurants/:restaurantId/orders
 * Fetch paid orders for a specific restaurant.
 */
router.get('/:restaurantId/orders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const restaurant = await Restaurant.findById(req.params.restaurantId).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit });
    const sourceIds = rawOrders.map((o) => o._id.toString());

    const overrides = await OrderOverride.find({
      restaurantId: restaurant._id,
      sourceOrderId: { $in: sourceIds },
    }).lean();

    const overrideMap = {};
    for (const ov of overrides) overrideMap[ov.sourceOrderId] = ov;

    const orders = rawOrders.map((raw) => {
      const override = overrideMap[raw._id.toString()] || null;
      const normalized = normalizeSourceOrder(raw, restaurant, override);
      delete normalized._detectedPickupFields;
      return normalized;
    });

    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error('[Admin] Fetch restaurant orders error:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─── Customer export ──────────────────────────────────────────────────────────

/**
 * GET /api/admin/restaurants/:restaurantId/customers
 * Extract unique customers from paid orders for this restaurant.
 * Deduplicates by email first, then phone.
 */
router.get('/:restaurantId/customers', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit: 500 });
    const customers = extractCustomers(rawOrders, restaurant);

    res.json({ customers, total: customers.length, restaurantName: restaurant.name });
  } catch (err) {
    console.error('[Admin] Customers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

/**
 * GET /api/admin/restaurants/:restaurantId/customers/export.csv
 * Export customers as CSV.
 */
router.get('/:restaurantId/customers/export.csv', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId).lean();
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit: 500 });
    const customers = extractCustomers(rawOrders, restaurant);

    const header = 'Restaurant Name,Customer Name,Phone,Email,Last Order Date,Total Orders,Total Spent\n';
    const rows = customers.map((c) => [
      csvEscape(restaurant.name),
      csvEscape(c.customerName || ''),
      csvEscape(c.customerPhone || ''),
      csvEscape(c.customerEmail || ''),
      csvEscape(c.lastOrderDate || ''),
      c.totalOrders,
      c.totalSpent.toFixed(2),
    ].join(',')).join('\n');

    const csv = header + rows;
    const filename = `${restaurant.restaurantKey}-customers.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Admin] CSV export error:', err.message);
    res.status(500).json({ error: 'Failed to export customers' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCustomers(rawOrders, restaurant) {
  const byEmail = new Map();
  const byPhone = new Map();
  const customers = [];

  for (const raw of rawOrders) {
    const normalized = normalizeSourceOrder(raw, restaurant, null);
    const email = normalized.customerEmail?.toLowerCase() || null;
    const phone = normalized.customerPhone || null;
    const name = normalized.customerName || null;
    const date = normalized.createdAt || null;
    const total = normalized.total || 0;

    // Dedup key: email first, then phone
    const key = email || phone;
    if (!key) continue;

    const existing = byEmail.get(email) || byPhone.get(phone);
    if (existing) {
      existing.totalOrders++;
      existing.totalSpent += total;
      if (date && (!existing.lastOrderDate || date > existing.lastOrderDate)) {
        existing.lastOrderDate = date;
      }
    } else {
      const entry = { customerName: name, customerEmail: email, customerPhone: phone, lastOrderDate: date, totalOrders: 1, totalSpent: total };
      customers.push(entry);
      if (email) byEmail.set(email, entry);
      if (phone) byPhone.set(phone, entry);
    }
  }

  // Sort by last order date descending
  customers.sort((a, b) => {
    if (!a.lastOrderDate) return 1;
    if (!b.lastOrderDate) return -1;
    return b.lastOrderDate.localeCompare(a.lastOrderDate);
  });

  return customers;
}

function csvEscape(val) {
  const str = String(val || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = router;
