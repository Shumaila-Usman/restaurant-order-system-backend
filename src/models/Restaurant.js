const mongoose = require('mongoose');
// credentialCrypto is used in routes, not the model itself

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
    // ─── Printer (future feature — pending client confirmation) ────────────
    // Set to true only after printer model is confirmed and integration is built.
    printerEnabled: {
      type: Boolean,
      default: false,
    },
    printerNotes: {
      type: String,
      default: null,
    },
    // ─── Website Admin Panel Credentials (MCP credential vault) ───────────
    // Stores the restaurant's own website admin panel credentials.
    // MCP stores and manages these credentials.
    // integrationType = "manual": MCP stores only; admin must use credentials manually.
    // integrationType = "api" / "shared_db": future — requires per-website integration.
    websiteAdminUrl: {
      type: String,
      default: null,
      trim: true,
    },
    websiteAdminLoginId: {
      type: String,
      default: null,
      trim: true,
    },
    websiteAdminEmail: {
      type: String,
      default: null,
      trim: true,
    },
    // AES-256-GCM encrypted — never returned as-is; decrypted only in admin endpoints
    websiteAdminPasswordEncrypted: {
      type: String,
      default: null,
    },
    websiteAdminPasswordUpdatedAt: {
      type: Date,
      default: null,
    },
    websiteAdminPasswordUpdatedBy: {
      type: String,
      default: null,
    },
    websiteAdminNotes: {
      type: String,
      default: null,
    },
    websiteAdminIntegrationType: {
      type: String,
      enum: ['manual', 'api', 'shared_db'],
      default: 'manual',
    },
  },
  {
    timestamps: true,
    collection: 'restaurants',
  }
);

module.exports = mongoose.model('Restaurant', restaurantSchema, 'restaurants');
