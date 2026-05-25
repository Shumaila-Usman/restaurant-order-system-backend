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
 *
 * Added fields (Phase B — pickup time timezone fix):
 *  - pickupTimeRaw:       the original raw value from the source order
 *  - pickupTimeDisplay:   pre-formatted string in restaurant local time (e.g. "May 25, 11:59 AM")
 *  - pickupTimeTimezone:  the IANA timezone used for display
 *  - pickupTimeIsLocal:   true if the raw value had no timezone info (treated as restaurant local time)
 */

// ─── Pickup time normalization ────────────────────────────────────────────────

/**
 * Detect whether a raw pickup time string contains explicit timezone information.
 *
 * Returns true if the string ends with Z, or contains a +HH:MM / -HH:MM offset.
 *
 * Examples:
 *   "2026-05-25T11:59:00"          → false  (naive local string)
 *   "2026-05-25T11:59:00Z"         → true   (UTC)
 *   "2026-05-25T11:59:00-04:00"    → true   (explicit offset)
 *   "2026-05-25T11:59:00+05:30"    → true   (explicit offset)
 *   "May 25, 2026 11:59 AM"        → false  (human-readable, no tz)
 */
function hasTimezoneInfo(str) {
  if (typeof str !== 'string') return false;
  // Ends with Z (UTC)
  if (str.endsWith('Z')) return true;
  // Contains +HH:MM or -HH:MM offset (ISO 8601)
  if (/[+-]\d{2}:\d{2}$/.test(str)) return true;
  return false;
}

/**
 * Format a Date object in a given IANA timezone as a human-readable string.
 * Uses Intl.DateTimeFormat — available in Node 18+.
 *
 * Returns e.g. "May 25, 11:59 AM"
 */
function formatDateInTimezone(date, timezone) {
  try {
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return date.toISOString();
  }
}

/**
 * Parse a naive local datetime string (no timezone suffix) as if it were in
 * the given IANA timezone, and return a UTC Date object.
 *
 * Strategy: use Intl.DateTimeFormat to find the UTC offset for that timezone
 * at the approximate wall-clock time, then subtract the offset.
 *
 * This handles DST correctly for the vast majority of cases.
 *
 * @param {string} naiveStr  - e.g. "2026-05-25T11:59:00" or "May 25, 2026 11:59 AM"
 * @param {string} timezone  - IANA timezone, e.g. "America/New_York"
 * @returns {Date|null}
 */
function parseNaiveDateAsTimezone(naiveStr, timezone) {
  // First, parse the string as if it were UTC to get a rough Date object.
  // We append 'Z' to force UTC interpretation in environments where
  // bare ISO strings are parsed as local time (non-standard but common).
  let roughDate;

  // Try ISO-like format first (YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD HH:MM:SS)
  const isoMatch = naiveStr.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (isoMatch) {
    const [, yr, mo, dy, hr, mn, sc = '00'] = isoMatch;
    // Construct as UTC first (we'll adjust below)
    roughDate = new Date(Date.UTC(+yr, +mo - 1, +dy, +hr, +mn, +sc));
  } else {
    // Human-readable format — parse normally and treat as UTC
    roughDate = new Date(naiveStr);
    if (isNaN(roughDate.getTime())) return null;
    // Shift: new Date() parses without tz as local; re-interpret as UTC
    roughDate = new Date(roughDate.getTime() - roughDate.getTimezoneOffset() * 60000);
  }

  if (isNaN(roughDate.getTime())) return null;

  // Now find the UTC offset for the target timezone at this approximate time.
  // We use Intl to format the rough UTC date in the target timezone, then
  // compare to the UTC values to derive the offset.
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });

    const parts = fmt.formatToParts(roughDate);
    const p = {};
    for (const { type, value } of parts) p[type] = value;

    // Reconstruct the wall-clock time in the target timezone as a UTC Date
    const localInTz = new Date(Date.UTC(
      +p.year, +p.month - 1, +p.day,
      p.hour === '24' ? 0 : +p.hour,
      +p.minute, +p.second
    ));

    // offset = what UTC time corresponds to the naive local time
    const offsetMs = roughDate.getTime() - localInTz.getTime();
    return new Date(roughDate.getTime() + offsetMs);
  } catch {
    // Fallback: return the rough date (may be slightly off for DST edge cases)
    return roughDate;
  }
}

/**
 * Normalize a raw pickup time value from the source order.
 *
 * Business rules:
 *  - If the raw value has explicit timezone info (Z or ±HH:MM), parse it as
 *    a real UTC/offset timestamp and convert to restaurant local time for display.
 *  - If the raw value has NO timezone info, treat it as already being in the
 *    restaurant's local timezone. Do NOT shift it.
 *
 * @param {*}      rawPickupTime      - Raw value from source order field
 * @param {string} restaurantTimezone - IANA timezone, e.g. "America/New_York"
 * @returns {{
 *   pickupTimeRaw: string,
 *   pickupTime: string|null,        ISO 8601 UTC string for storage/sorting
 *   pickupTimeDisplay: string|null, Pre-formatted local display string
 *   pickupTimeTimezone: string,
 *   pickupTimeIsLocal: boolean,
 * }}
 */
function normalizePickupTime(rawPickupTime, restaurantTimezone) {
  const tz = restaurantTimezone || 'America/New_York';
  const rawStr = rawPickupTime != null ? String(rawPickupTime).trim() : '';

  console.log(`[pickup-time] raw value: ${rawStr}`);
  console.log(`[pickup-time] restaurant timezone: ${tz}`);

  if (!rawStr) {
    return {
      pickupTimeRaw: rawStr,
      pickupTime: null,
      pickupTimeDisplay: null,
      pickupTimeTimezone: tz,
      pickupTimeIsLocal: false,
    };
  }

  const tzPresent = hasTimezoneInfo(rawStr);
  console.log(`[pickup-time] has timezone: ${tzPresent}`);

  if (tzPresent) {
    // The raw value has explicit timezone info — parse it as a real UTC timestamp.
    const date = new Date(rawStr);
    if (isNaN(date.getTime())) {
      console.log(`[pickup-time] interpreted as: INVALID (has tz but unparseable)`);
      return {
        pickupTimeRaw: rawStr,
        pickupTime: null,
        pickupTimeDisplay: null,
        pickupTimeTimezone: tz,
        pickupTimeIsLocal: false,
      };
    }

    const display = formatDateInTimezone(date, tz);
    console.log(`[pickup-time] interpreted as: UTC/offset timestamp → convert to ${tz}`);
    console.log(`[pickup-time] display value: ${display}`);

    return {
      pickupTimeRaw: rawStr,
      pickupTime: date.toISOString(),
      pickupTimeDisplay: display,
      pickupTimeTimezone: tz,
      pickupTimeIsLocal: false,
    };
  } else {
    // No timezone info — treat as restaurant local time. Do NOT shift.
    const date = parseNaiveDateAsTimezone(rawStr, tz);
    if (!date || isNaN(date.getTime())) {
      console.log(`[pickup-time] interpreted as: INVALID (no tz, unparseable)`);
      return {
        pickupTimeRaw: rawStr,
        pickupTime: null,
        pickupTimeDisplay: rawStr, // show raw string as fallback
        pickupTimeTimezone: tz,
        pickupTimeIsLocal: true,
      };
    }

    // For display: format the naive string directly without re-converting.
    // We parse the wall-clock components from the raw string and format them.
    const display = formatNaiveStringAsDisplay(rawStr);
    console.log(`[pickup-time] interpreted as: naive local time in ${tz} (no shift)`);
    console.log(`[pickup-time] display value: ${display}`);

    return {
      pickupTimeRaw: rawStr,
      pickupTime: date.toISOString(), // UTC equivalent for sorting/storage
      pickupTimeDisplay: display,
      pickupTimeTimezone: tz,
      pickupTimeIsLocal: true,
    };
  }
}

/**
 * Format a naive datetime string (no timezone) for display without any
 * timezone conversion. Extracts wall-clock components directly.
 *
 * "2026-05-25T11:59:00"      → "May 25, 11:59 AM"
 * "2026-05-25 11:59:00"      → "May 25, 11:59 AM"
 * "May 25, 2026 11:59 AM"    → "May 25, 11:59 AM"  (already human-readable)
 */
function formatNaiveStringAsDisplay(rawStr) {
  // Try ISO-like format: YYYY-MM-DDTHH:MM or YYYY-MM-DD HH:MM
  const isoMatch = rawStr.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/
  );
  if (isoMatch) {
    const [, , mo, dy, hr, mn] = isoMatch;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthName = monthNames[+mo - 1] || mo;
    const hour12 = +hr % 12 || 12;
    const ampm = +hr < 12 ? 'AM' : 'PM';
    return `${monthName} ${+dy}, ${hour12}:${mn} ${ampm}`;
  }

  // Already human-readable (e.g. "May 25, 2026 11:59 AM") — strip year if present
  const humanMatch = rawStr.match(
    /^([A-Za-z]+ \d{1,2}),?\s+(?:\d{4}\s+)?(\d{1,2}:\d{2}\s*(?:AM|PM))/i
  );
  if (humanMatch) {
    return `${humanMatch[1]}, ${humanMatch[2].trim()}`;
  }

  // Fallback: return as-is
  return rawStr;
}

// ─── Pickup detection ─────────────────────────────────────────────────────────

function detectPickup(raw, restaurant) {
  const tz = (restaurant && restaurant.timezone) || 'America/New_York';

  const asapFields = ['isASAP', 'asap'];
  for (const f of asapFields) {
    if (raw[f] === true || raw[f] === 'true' || raw[f] === 1) {
      return {
        pickupMode: 'asap',
        pickupTime: null,
        pickupTimeRaw: null,
        pickupTimeDisplay: null,
        pickupTimeTimezone: tz,
        pickupTimeIsLocal: false,
      };
    }
  }

  const timeFields = [
    'pickupTime', 'scheduledTime', 'selectedTime', 'requestedTime',
    'fulfillmentTime', 'scheduledFor', 'deliveryTime',
  ];

  let rawPickupValue = null;
  for (const f of timeFields) {
    if (raw[f] != null && raw[f] !== '') {
      rawPickupValue = raw[f];
      break;
    }
  }

  const typeFields = ['pickupType', 'fulfillmentType', 'orderType'];
  for (const f of typeFields) {
    const val = (raw[f] || '').toString().toLowerCase();
    if (val.includes('asap')) {
      return {
        pickupMode: 'asap',
        pickupTime: null,
        pickupTimeRaw: null,
        pickupTimeDisplay: null,
        pickupTimeTimezone: tz,
        pickupTimeIsLocal: false,
      };
    }
    if (val.includes('scheduled') || val.includes('later') || val.includes('future')) {
      if (rawPickupValue != null) {
        const normalized = normalizePickupTime(rawPickupValue, tz);
        return {
          pickupMode: 'scheduled',
          ...normalized,
        };
      }
      return {
        pickupMode: 'scheduled',
        pickupTime: null,
        pickupTimeRaw: null,
        pickupTimeDisplay: null,
        pickupTimeTimezone: tz,
        pickupTimeIsLocal: false,
      };
    }
  }

  if (rawPickupValue != null) {
    const normalized = normalizePickupTime(rawPickupValue, tz);
    // Only treat as scheduled if we got a valid time
    if (normalized.pickupTime || normalized.pickupTimeDisplay) {
      return {
        pickupMode: 'scheduled',
        ...normalized,
      };
    }
  }

  return {
    pickupMode: 'unknown',
    pickupTime: null,
    pickupTimeRaw: null,
    pickupTimeDisplay: null,
    pickupTimeTimezone: tz,
    pickupTimeIsLocal: false,
  };
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

  const restaurantTimezone = restaurant.timezone || 'America/New_York';
  if (!restaurant.timezone) {
    console.warn(`[Normalize] WARNING: restaurant "${restaurant.name}" has no timezone set. Defaulting to America/New_York`);
  }

  // ── Pickup time — timezone-aware normalization ──
  const {
    pickupMode,
    pickupTime,
    pickupTimeRaw,
    pickupTimeDisplay,
    pickupTimeTimezone,
    pickupTimeIsLocal,
  } = detectPickup(raw, restaurant);

  const fulfillmentType = detectFulfillmentType(raw, restaurant);
  const orderNote = detectOrderNote(raw, restaurant);

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
    pickupTime,

    // Phase B: pickup time display fields
    pickupTimeRaw: pickupTimeRaw ?? null,
    pickupTimeDisplay: pickupTimeDisplay ?? null,
    pickupTimeTimezone,
    pickupTimeIsLocal,

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

// ─── Test cases ───────────────────────────────────────────────────────────────

/**
 * Run self-test to verify pickup time normalization.
 * Call with: node -e "require('./normalizeOrder').runPickupTimeTests()"
 */
function runPickupTimeTests() {
  const tz = 'America/New_York';
  console.log('\n=== Pickup Time Normalization Tests ===\n');

  const cases = [
    {
      label: 'Case A: naive ISO string (no tz) — must NOT shift',
      raw: '2026-05-25T11:59:00',
      expectedDisplay: 'May 25, 11:59 AM',
    },
    {
      label: 'Case B: UTC string (ends with Z) — must convert to Eastern',
      raw: '2026-05-25T11:59:00Z',
      expectedDisplay: 'May 25, 7:59 AM', // 11:59 UTC = 7:59 AM EDT (UTC-4)
    },
    {
      label: 'Case C: human-readable string (no tz)',
      raw: 'May 25, 2026 11:59 AM',
      expectedDisplay: 'May 25, 11:59 AM',
    },
    {
      label: 'Case D: naive ISO — website 11:59 AM must never show as 2:59 PM',
      raw: '2026-05-25T11:59:00',
      expectedDisplay: 'May 25, 11:59 AM',
      mustNotContain: '2:59',
    },
    {
      label: 'Case E: explicit offset -04:00 (EDT)',
      raw: '2026-05-25T11:59:00-04:00',
      expectedDisplay: 'May 25, 11:59 AM', // already Eastern, no shift
    },
    {
      label: 'Case F: explicit offset +00:00 (UTC)',
      raw: '2026-05-25T11:59:00+00:00',
      expectedDisplay: 'May 25, 7:59 AM', // 11:59 UTC = 7:59 AM EDT
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of cases) {
    const result = normalizePickupTime(tc.raw, tz);
    const display = result.pickupTimeDisplay || '';
    const ok = display === tc.expectedDisplay &&
      (!tc.mustNotContain || !display.includes(tc.mustNotContain));

    const status = ok ? '✓ PASS' : '✗ FAIL';
    if (ok) passed++; else failed++;

    console.log(`${status} ${tc.label}`);
    console.log(`       raw="${tc.raw}"`);
    console.log(`       display="${display}" (expected "${tc.expectedDisplay}")`);
    console.log(`       isLocal=${result.pickupTimeIsLocal}`);
    if (!ok && tc.mustNotContain) {
      console.log(`       ERROR: display must not contain "${tc.mustNotContain}"`);
    }
    console.log('');
  }

  console.log(`Results: ${passed} passed, ${failed} failed\n`);
}

module.exports = {
  normalizeSourceOrder,
  normalizePickupTime,
  detectPickup,
  detectFulfillmentType,
  detectOrderNote,
  runPickupTimeTests,
};
