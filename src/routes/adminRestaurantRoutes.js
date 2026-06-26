const express = require('express');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Restaurant = require('../models/Restaurant');
const OrderOverride = require('../models/OrderOverride');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { fetchPaidOrdersFromSource, getSourceDbConnection } = require('../utils/sourceDb');
const { normalizeSourceOrder } = require('../utils/normalizeOrder');
const { encryptCredential, decryptCredential } = require('../utils/credentialCrypto');

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
      printerEnabled: false, // disabled by default — requires printer model confirmation
      printerNotes: null,
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
    const restaurants = await Restaurant.find().sort({ name: 1 })
      .select('-websiteAdminPasswordEncrypted')
      .lean();
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
    const restaurant = await Restaurant.findById(req.params.id)
      .select('-websiteAdminPasswordEncrypted')
      .lean();
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
      'printerEnabled', 'printerNotes',
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

// ─── Website Admin Panel Credentials ─────────────────────────────────────────

/**
 * GET /api/admin/restaurants/:restaurantId/website-credentials
 * Returns decrypted website admin credentials. Admin-only.
 */
router.get('/:restaurantId/website-credentials', async (req, res) => {
  try {
    const restaurant = await Restaurant.findById(req.params.restaurantId)
      .select('name websiteAdminUrl websiteAdminLoginId websiteAdminEmail websiteAdminPasswordEncrypted websiteAdminPasswordUpdatedAt websiteAdminNotes websiteAdminIntegrationType')
      .lean();

    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // Audit log — do NOT log the actual password
    console.log(
      `[Credentials] Website admin credentials VIEWED — restaurantId="${req.params.restaurantId}" ` +
      `name="${restaurant.name}" by admin="${req.admin?.email || 'unknown'}" at ${new Date().toISOString()}`
    );

    let websiteAdminPassword = null;
    let message = null;

    if (restaurant.websiteAdminPasswordEncrypted) {
      try {
        websiteAdminPassword = decryptCredential(restaurant.websiteAdminPasswordEncrypted);
      } catch (err) {
        console.error('[Credentials] Website password decryption failed:', err.message);
        message = 'Could not decrypt stored password. Please set a new password.';
      }
    } else {
      message = 'No website admin password stored yet.';
    }

    res.json({
      websiteAdminUrl: restaurant.websiteAdminUrl || null,
      websiteAdminLoginId: restaurant.websiteAdminLoginId || null,
      websiteAdminEmail: restaurant.websiteAdminEmail || null,
      websiteAdminPassword,
      websiteAdminPasswordUpdatedAt: restaurant.websiteAdminPasswordUpdatedAt || null,
      websiteAdminNotes: restaurant.websiteAdminNotes || null,
      websiteAdminIntegrationType: restaurant.websiteAdminIntegrationType || 'manual',
      message,
    });
  } catch (err) {
    console.error('[Admin] Get website credentials error:', err.message);
    res.status(500).json({ error: 'Failed to fetch website credentials' });
  }
});

/**
 * PATCH /api/admin/restaurants/:restaurantId/website-credentials
 * Save/update website admin credentials.
 * If websiteAdminPassword is provided:
 *   1. Encrypts and stores it in MCP (credential vault)
 *   2. Bcrypt-hashes it and updates the admin user's passwordHash
 *      in the restaurant's source DB (users collection, role=admin)
 * If omitted, keeps existing password.
 */
router.patch('/:restaurantId/website-credentials', async (req, res) => {
  try {
    const {
      websiteAdminUrl,
      websiteAdminLoginId,
      websiteAdminEmail,
      websiteAdminPassword,
      websiteAdminNotes,
      websiteAdminIntegrationType,
      // Source DB sync config (optional overrides)
      sourceAdminCollection,   // default: 'users'
      sourceAdminEmailField,   // default: 'email'
      sourceAdminPasswordField,// default: 'passwordHash'
      sourceAdminRoleField,    // default: 'role'
      sourceAdminRoleValue,    // default: 'admin'
    } = req.body;

    const restaurant = await Restaurant.findById(req.params.restaurantId);
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    // ── 1. Update MCP credential vault ───────────────────────────────────────
    const updates = {};
    if (websiteAdminUrl !== undefined) updates.websiteAdminUrl = websiteAdminUrl || null;
    if (websiteAdminLoginId !== undefined) updates.websiteAdminLoginId = websiteAdminLoginId || null;
    if (websiteAdminEmail !== undefined) updates.websiteAdminEmail = websiteAdminEmail || null;
    if (websiteAdminNotes !== undefined) updates.websiteAdminNotes = websiteAdminNotes || null;
    if (websiteAdminIntegrationType !== undefined) updates.websiteAdminIntegrationType = websiteAdminIntegrationType || 'manual';

    if (websiteAdminPassword) {
      updates.websiteAdminPasswordEncrypted = encryptCredential(websiteAdminPassword);
      updates.websiteAdminPasswordUpdatedAt = new Date();
      updates.websiteAdminPasswordUpdatedBy = req.admin?.id || 'admin';
    }

    await Restaurant.findByIdAndUpdate(req.params.restaurantId, { $set: updates });

    // ── 2. Sync password to source DB (restaurant's own MongoDB) ─────────────
    let syncResult = null;
    if (websiteAdminPassword) {
      try {
        const conn = await getSourceDbConnection(restaurant);

        // Config — use provided overrides or sensible defaults
        const collection   = sourceAdminCollection    || 'users';
        const emailField   = sourceAdminEmailField    || 'email';
        const pwField      = sourceAdminPasswordField || 'passwordHash';
        const roleField    = sourceAdminRoleField     || 'role';
        const roleValue    = sourceAdminRoleValue     || 'admin';

        // Determine which user to update:
        // Priority: websiteAdminEmail (from form) → websiteAdminLoginId → role=admin fallback
        const lookupEmail = websiteAdminEmail || restaurant.websiteAdminEmail;
        const query = lookupEmail
          ? { [emailField]: lookupEmail }
          : { [roleField]: roleValue };

        // Bcrypt hash the new password (same cost factor as $2a$12$)
        const saltRounds = 12;
        const hashed = await bcrypt.hash(websiteAdminPassword, saltRounds);

        // Build model for the users collection
        const modelName = `AdminUser_${restaurant.restaurantKey}_${collection}`;
        let UserModel;
        try {
          UserModel = conn.model(modelName);
        } catch {
          const schema = new mongoose.Schema({}, { strict: false });
          UserModel = conn.model(modelName, schema, collection);
        }

        const result = await UserModel.updateOne(
          query,
          { $set: { [pwField]: hashed, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          syncResult = {
            success: false,
            message: `No user found in source DB with ${JSON.stringify(query)}. Password NOT changed on site.`,
          };
          console.warn(
            `[Credentials] Source DB sync — no matching user found: ` +
            `restaurant="${restaurant.name}" collection="${collection}" query=${JSON.stringify(query)}`
          );
        } else {
          syncResult = {
            success: true,
            message: `Password updated on site (${result.modifiedCount} user updated).`,
            collection,
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
          };
          console.log(
            `[Credentials] Source DB password synced — restaurant="${restaurant.name}" ` +
            `collection="${collection}" matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`
          );
        }
      } catch (syncErr) {
        // Sync failure should not block the MCP save — credentials are already stored
        syncResult = {
          success: false,
          message: `MCP credentials saved but source DB sync failed: ${syncErr.message}`,
        };
        console.error('[Credentials] Source DB sync error:', syncErr.message);
      }
    }

    // Audit log — do NOT log the actual password
    const passwordChanged = !!websiteAdminPassword;
    console.log(
      `[Credentials] Website admin credentials UPDATED — restaurantId="${req.params.restaurantId}" ` +
      `name="${restaurant.name}" passwordChanged=${passwordChanged} ` +
      `by admin="${req.admin?.email || 'unknown'}" at ${new Date().toISOString()}`
    );

    res.json({
      message: 'Website credentials saved successfully',
      ...(syncResult && { sync: syncResult }),
    });
  } catch (err) {
    console.error('[Admin] Save website credentials error:', err.message);
    res.status(500).json({ error: 'Failed to save website credentials' });
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
