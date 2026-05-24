/**
 * normalizeSourceOrder
 *
 * Converts a raw order document from a restaurant's source MongoDB database
 * into a clean, consistent shape that the mobile app and admin panel consume.
 *
 * Added fields (Phase A):
 *  - orderNote:      visible order note from customer
 *  - fulfillmentType: "pickup" | "delivery" | "unknown"
 *  - currencyCode / currencySymbol: from restaurant config or source order
 */

// ─── Pickup detection ─────────────────────────────────────────────────────────

function detectPickup(raw) {
  const asapFields = ['isASAP', 'asap'];
  for (const f of asapFields) {
    if (raw[f] === true || raw[f] === 'true' || raw[f] === 1) {
      return { pickupMode: 'asap', pickupTime: null };
    }
  }

  const timeFields = [
    'pickupTime', 'scheduledTime', 'selectedTime', 'requestedTime',
    'fulfillmentTime', 'scheduledFor', 'deliveryTime',
  ];

  let pickupTime = null;
  for (const f of timeFields) {
    if (raw[f]) {
      const d = new Date(raw[f]);
      if (!isNaN(d.getTime())) {
        pickupTime = d;
        break;
      }
    }
  }

  const typeFields = ['pickupType', 'fulfillmentType', 'orderType'];
  for (const f of typeFields) {
    const val = (raw[f] || '').toString().toLowerCase();
    if (val.includes('asap')) return { pickupMode: 'asap', pickupTime: null };
    if (val.includes('scheduled') || val.includes('later') || val.includes('future')) {
      return { pickupMode: 'scheduled', pickupTime };
    }
  }

  if (pickupTime) return { pickupMode: 'scheduled', pickupTime };
  return { pickupMode: 'unknown', pickupTime: null };
}

// ─── Fulfillment type detection ───────────────────────────────────────────────

/**
 * Detect whether this order is pickup or delivery.
 * Returns: "pickup" | "delivery" | "unknown"
 */
function detectFulfillmentType(raw, restaurant) {
  // Check restaurant-configured field first
  const configuredField = restaurant.sourceFulfillmentTypeField;
  const fieldsToCheck = configuredField
    ? [configuredField, 'orderType', 'fulfillmentType', 'fulfillmentMethod', 'deliveryMethod', 'serviceType', 'type', 'shippingMethod']
    : ['orderType', 'fulfillmentType', 'fulfillmentMethod', 'deliveryMethod', 'serviceType', 'type', 'shippingMethod'];

  for (const f of fieldsToCheck) {
    const val = (raw[f] || '').toString().toLowerCase();
    if (!val) continue;
    if (val.includes('pickup') || val.includes('pick-up') || val.includes('pick_up') ||
        val.includes('collection') || val.includes('collect') || val.includes('in_store')) {
      return 'pickup';
    }
    if (val.includes('delivery') || val.includes('deliver') || val.includes('shipping') ||
        val.includes('ship')) {
      return 'delivery';
    }
  }

  return 'unknown';
}

// ─── Order note detection ─────────────────────────────────────────────────────

/**
 * Extract the customer order note from common field names.
 */
function detectOrderNote(raw, restaurant) {
  // Check restaurant-configured field first
  if (restaurant.sourceOrderNoteField && raw[restaurant.sourceOrderNoteField]) {
    return raw[restaurant.sourceOrderNoteField].toString().trim() || null;
  }

  const noteFields = [
    'notes', 'note', 'orderNote', 'customerNote',
    'specialInstructions', 'instructions',
    'comment', 'comments', 'deliveryInstructions',
  ];

  for (const f of noteFields) {
    if (raw[f] && typeof raw[f] === 'string' && raw[f].trim()) {
      return raw[f].trim();
    }
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeGet(obj, path, fallback = null) {
  if (!obj || !path) return fallback;
  return (
    path.split('.').reduce((acc, key) => (acc != null ? acc[key] : null), obj) ?? fallback
  );
}

// ─── Main normalization ───────────────────────────────────────────────────────

function normalizeSourceOrder(sourceOrder, restaurant, override = null) {
  const raw = sourceOrder;

  const sourceOrderId = (raw._id || raw.id || '').toString();

  const orderNumberField = restaurant.sourceOrderNumberField || 'orderNumber';
  const orderNumber =
    safeGet(raw, orderNumberField) || raw.orderNumber || raw.order_number || raw.number || sourceOrderId;

  const createdAt = raw.createdAt || raw.created_at || raw.orderDate || raw.placedAt || raw.date || null;

  const paymentStatusField = restaurant.sourcePaymentStatusField || 'paymentStatus';
  const paymentStatus = safeGet(raw, paymentStatusField) || raw.paymentStatus || raw.payment_status || null;

  const orderStatus = raw.orderStatus || raw.order_status || raw.status || null;

  const customerName =
    raw.customerName || raw.customer_name ||
    safeGet(raw, 'customer.name') || safeGet(raw, 'billing.name') || safeGet(raw, 'billingAddress.name') || null;

  const customerPhone =
    raw.customerPhone || raw.customer_phone ||
    safeGet(raw, 'customer.phone') || safeGet(raw, 'billing.phone') || null;

  const customerEmail =
    raw.customerEmail || raw.customer_email ||
    safeGet(raw, 'customer.email') || safeGet(raw, 'billing.email') || null;

  const itemsField = restaurant.sourceItemsField || 'items';
  const items = safeGet(raw, itemsField) || raw.items || raw.lineItems || [];

  const subtotal = raw.subtotal ?? raw.sub_total ?? raw.subTotal ?? null;
  const tax = raw.tax ?? raw.taxAmount ?? raw.tax_amount ?? null;
  const deliveryFee = raw.deliveryFee ?? raw.delivery_fee ?? raw.shippingFee ?? null;
  const tip = raw.tip ?? raw.tipAmount ?? raw.tip_amount ?? null;
  const total = raw.total ?? raw.totalAmount ?? raw.total_amount ?? raw.grandTotal ?? null;

  // ── Currency: prefer source order value, fall back to restaurant config ──
  const rawCurrency = raw.currency ?? raw.currencyCode ?? raw.orderCurrency ?? null;
  const currencyCode = rawCurrency || restaurant.currencyCode || 'USD';
  const currencySymbol = restaurant.currencySymbol || '$';

  const { pickupMode, pickupTime } = detectPickup(raw);
  const fulfillmentType = detectFulfillmentType(raw, restaurant);
  const orderNote = detectOrderNote(raw, restaurant);

  const restaurantTimezone = restaurant.timezone || 'America/New_York';
  if (!restaurant.timezone) {
    console.warn(`[Normalize] WARNING: restaurant "${restaurant.name}" has no timezone set. Defaulting to America/New_York`);
  }

  // Debug: log detected pickup fields
  const detectedPickupFields = [];
  const pickupCheckFields = [
    'isASAP', 'asap', 'pickupType', 'fulfillmentType', 'orderType',
    'pickupTime', 'scheduledTime', 'selectedTime', 'requestedTime',
    'fulfillmentTime', 'scheduledFor', 'deliveryTime',
  ];
  for (const f of pickupCheckFields) {
    if (raw[f] !== undefined) detectedPickupFields.push(`${f}=${JSON.stringify(raw[f])}`);
  }

  return {
    id: sourceOrderId,
    sourceOrderId,
    restaurantId: restaurant._id.toString(),
    restaurantKey: restaurant.restaurantKey,
    restaurantName: restaurant.name,
    restaurantTimezone,

    orderNumber: orderNumber?.toString() || sourceOrderId,
    createdAt: createdAt ? new Date(createdAt).toISOString() : null,

    orderStatus: orderStatus?.toString() || null,
    paymentStatus: paymentStatus?.toString() || null,

    pickupMode,
    pickupTime: pickupTime ? pickupTime.toISOString() : null,

    // Phase A: fulfillment type (pickup vs delivery)
    fulfillmentType,

    customerName: customerName?.toString() || null,
    customerPhone: customerPhone?.toString() || null,
    customerEmail: customerEmail?.toString() || null,

    items: Array.isArray(items) ? items : [],

    subtotal: subtotal != null ? Number(subtotal) : null,
    tax: tax != null ? Number(tax) : null,
    deliveryFee: deliveryFee != null ? Number(deliveryFee) : null,
    tip: tip != null ? Number(tip) : null,
    total: total != null ? Number(total) : null,

    // Phase A: currency from source or restaurant config
    currency: currencyCode,
    currencyCode,
    currencySymbol,

    // Phase A: order note — shown prominently in mobile app
    orderNote,
    // Keep legacy 'notes' field for backward compat
    notes: orderNote,

    // From OrderOverride (central DB)
    prepTimeMinutes: override?.prepTimeMinutes ?? null,
    customPrepTimeLabel: override?.customPrepTimeLabel ?? null,
    acknowledgedAt: override?.acknowledgedAt ? new Date(override.acknowledgedAt).toISOString() : null,

    _detectedPickupFields: detectedPickupFields,
  };
}

module.exports = { normalizeSourceOrder, detectPickup, detectFulfillmentType, detectOrderNote };
