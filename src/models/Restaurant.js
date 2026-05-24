const mongoose = require('mongoose');

const restaurantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    restaurantKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    timezone: {
      type: String,
      default: 'America/New_York',
    },
    // ─── Currency ──────────────────────────────────────────────────────────
    currencyCode: {
      type: String,
      default: 'USD',
      trim: true,
    },
    currencySymbol: {
      type: String,
      default: '$',
      trim: true,
    },
    // ─── Source DB connection (restaurant's own website database) ──────────
    sourceDbUri: {
      type: String,
      required: true,
    },
    sourceDbName: {
      type: String,
      required: true,
    },
    sourceOrderCollection: {
      type: String,
      required: true,
      default: 'orders',
    },
    sourcePaymentStatusField: {
      type: String,
      required: true,
      default: 'paymentStatus',
    },
    sourcePaidValue: {
      type: String,
      required: true,
      default: 'paid',
    },
    sourceOrderNumberField: {
      type: String,
      default: 'orderNumber',
    },
    sourceOrderTypeField: {
      type: String,
      default: 'orderType',
    },
    sourceItemsField: {
      type: String,
      default: 'items',
    },
    // ─── Order Note field mapping ──────────────────────────────────────────
    // If the source DB uses a non-standard field for order notes, set this.
    // e.g. "customerNote", "specialInstructions", "comment"
    sourceOrderNoteField: {
      type: String,
      default: null,
    },
    // ─── Fulfillment type field mapping ────────────────────────────────────
    // If the source DB uses a non-standard field for pickup/delivery type.
    // e.g. "fulfillmentMethod", "serviceType", "deliveryMethod"
    sourceFulfillmentTypeField: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: 'restaurants',
  }
);

module.exports = mongoose.model('Restaurant', restaurantSchema, 'restaurants');
