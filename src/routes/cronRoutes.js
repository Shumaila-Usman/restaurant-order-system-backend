const express = require('express');
const Restaurant = require('../models/Restaurant');
const OrderOverride = require('../models/OrderOverride');
const DeviceToken = require('../models/DeviceToken');
const { fetchPaidOrdersFromSource } = require('../utils/sourceDb');
const { normalizeSourceOrder } = require('../utils/normalizeOrder');
const { getFirebaseAdmin } = require('../config/firebase');

const router = express.Router();

/**
 * GET /api/cron/check-paid-orders?token=CRON_SECRET
 *
 * This is the heart of the notification system.
 *
 * Flow:
 *  1. Verify cron secret token
 *  2. Loop through all active restaurants
 *  3. Fetch paid orders from each restaurant's source DB
 *  4. Find orders that do NOT yet have notificationSent=true in OrderOverride
 *  5. Send FCM data notification to all active device tokens for that restaurant
 *  6. Mark notificationSent=true ONLY after the send attempt
 *
 * IMPORTANT:
 *  - GET /api/orders NEVER marks notificationSent=true
 *  - Only this cron endpoint marks notificationSent=true
 *  - Mobile polling does NOT affect notification tracking
 */
router.get('/check-paid-orders', async (req, res) => {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const { token } = req.query;
  if (!token || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  const adminSdk = getFirebaseAdmin();

  try {
    const restaurants = await Restaurant.find({ isActive: true }).lean();
    console.log(`[Cron] Starting check for ${restaurants.length} active restaurants`);

    for (const restaurant of restaurants) {
      const restaurantResult = {
        restaurantName: restaurant.name,
        restaurantKey: restaurant.restaurantKey,
        timezone: restaurant.timezone,
        newOrdersNotified: 0,
        errors: [],
      };

      try {
        // ── Fetch paid orders from source DB ────────────────────────────────
        const rawOrders = await fetchPaidOrdersFromSource(restaurant, { limit: 100 });
        console.log(`[Cron] restaurant="${restaurant.name}" paid orders found=${rawOrders.length}`);

        if (rawOrders.length === 0) {
          results.push(restaurantResult);
          continue;
        }

        const sourceIds = rawOrders.map((o) => o._id.toString());

        // ── Find which orders already have notificationSent=true ─────────────
        const existingOverrides = await OrderOverride.find({
          restaurantId: restaurant._id,
          sourceOrderId: { $in: sourceIds },
          notificationSent: true,
        })
          .select('sourceOrderId')
          .lean();

        const alreadySentIds = new Set(existingOverrides.map((o) => o.sourceOrderId));

        // ── Filter to only new (unsent) orders ───────────────────────────────
        const newOrders = rawOrders.filter(
          (o) => !alreadySentIds.has(o._id.toString())
        );

        console.log(
          `[Cron] restaurant="${restaurant.name}" already notified=${alreadySentIds.size} ` +
          `orders needing notification=${newOrders.length}`
        );

        if (newOrders.length === 0) {
          console.log(
            `[Cron] restaurant="${restaurant.name}" – no new orders to notify`
          );
          results.push(restaurantResult);
          continue;
        }

        console.log(
          `[Cron] restaurant="${restaurant.name}" key="${restaurant.restaurantKey}" ` +
          `timezone="${restaurant.timezone}" new orders to notify=${newOrders.length}`
        );

        // ── Get active FCM tokens for this restaurant ────────────────────────
        const deviceTokens = await DeviceToken.find({
          restaurantId: restaurant._id,
          isActive: true,
          tokenType: 'fcm',
        })
          .select('token platform')
          .lean();

        console.log(
          `[Cron] restaurant="${restaurant.name}" active device tokens=${deviceTokens.length}`
        );

        if (deviceTokens.length === 0) {
          // No devices to notify – still mark as sent so we don't retry forever
          for (const raw of newOrders) {
            await OrderOverride.findOneAndUpdate(
              { restaurantId: restaurant._id, sourceOrderId: raw._id.toString() },
              {
                $set: {
                  notificationSent: true,
                  notificationSentAt: new Date(),
                },
                $setOnInsert: {
                  restaurantId: restaurant._id,
                  sourceOrderId: raw._id.toString(),
                },
              },
              { upsert: true }
            );
          }
          console.log(
            `[Cron] restaurant="${restaurant.name}" – no device tokens, marked ${newOrders.length} orders as sent`
          );
          results.push(restaurantResult);
          continue;
        }

        // ── Send FCM notification for each new order ─────────────────────────
        for (const raw of newOrders) {
          const normalized = normalizeSourceOrder(raw, restaurant, null);
          const sourceOrderId = raw._id.toString();

          // Build FCM payload with both notification (for OS display when app is closed)
          // and data (for Notifee when app is background/open)
          const fcmPayload = {
            // notification field: Android OS displays this when app is completely closed
            notification: {
              title: `🔔 New Order #${normalized.orderNumber?.toString() || sourceOrderId}`,
              body: `${restaurant.name} — ${normalized.customerName || 'Customer'} — $${normalized.total || '0'}`,
            },
            // data field: available to app when open or background
            data: {
              type: 'NEW_ORDER',
              restaurantId: restaurant._id.toString(),
              restaurantKey: restaurant.restaurantKey,
              restaurantName: restaurant.name,
              restaurantTimezone: restaurant.timezone,
              sourceOrderId,
              orderNumber: normalized.orderNumber?.toString() || sourceOrderId,
              customerName: normalized.customerName || '',
              total: normalized.total?.toString() || '0',
              currency: normalized.currency || 'USD',
              pickupMode: normalized.pickupMode || 'unknown',
              pickupTime: normalized.pickupTime || '',
              createdAt: normalized.createdAt || '',
            },
            // Android specific config
            android: {
              priority: 'high',
              notification: {
                sound: 'notification',
                channelId: 'new-orders-v2',
                priority: 'max',
                defaultSound: false,
              },
            },
          };

          let fcmSuccess = false;

          if (adminSdk) {
            try {
              // Send to each token individually so we can handle invalid tokens
              for (const dt of deviceTokens) {
                try {
                  const messageId = await adminSdk.messaging().send({
                    ...fcmPayload,
                    token: dt.token,
                  });
                  console.log(
                    `[Cron] FCM sent: restaurant="${restaurant.name}" ` +
                    `order="${normalized.orderNumber}" platform="${dt.platform}" ` +
                    `messageId="${messageId}"`
                  );
                  fcmSuccess = true;
                } catch (fcmErr) {
                  const code = fcmErr.code || '';
                  console.error(
                    `[Cron] FCM send failed: restaurant="${restaurant.name}" ` +
                    `order="${normalized.orderNumber}" platform="${dt.platform}" ` +
                    `error="${fcmErr.message}"`
                  );

                  // Deactivate invalid/unregistered tokens
                  if (
                    code === 'messaging/invalid-registration-token' ||
                    code === 'messaging/registration-token-not-registered'
                  ) {
                    await DeviceToken.findOneAndUpdate(
                      { token: dt.token },
                      { $set: { isActive: false } }
                    );
                    console.log(
                      `[Cron] Deactivated invalid token for restaurant="${restaurant.name}"`
                    );
                  }
                }
              }
            } catch (err) {
              console.error(`[Cron] FCM batch error: ${err.message}`);
              restaurantResult.errors.push(err.message);
            }
          } else {
            console.warn(
              `[Cron] Firebase not initialized – skipping FCM for restaurant="${restaurant.name}"`
            );
          }

          // ── Mark notificationSent=true AFTER send attempt ─────────────────
          const updateResult = await OrderOverride.findOneAndUpdate(
            { restaurantId: restaurant._id, sourceOrderId },
            {
              $set: {
                notificationSent: true,
                notificationSentAt: new Date(),
              },
              $setOnInsert: {
                restaurantId: restaurant._id,
                sourceOrderId,
              },
            },
            { upsert: true, new: true }
          );

          console.log(
            `[Cron] notificationSent marked: restaurant="${restaurant.name}" ` +
            `order="${normalized.orderNumber}" _id="${updateResult._id}"`
          );

          restaurantResult.newOrdersNotified++;
        }
      } catch (err) {
        console.error(
          `[Cron] Error processing restaurant="${restaurant.name}": ${err.message}`
        );
        restaurantResult.errors.push(err.message);
      }

      results.push(restaurantResult);
    }

    console.log('[Cron] Check complete');
    res.json({ success: true, results });
  } catch (err) {
    console.error('[Cron] Fatal error:', err.message);
    res.status(500).json({ error: 'Cron job failed', details: err.message });
  }
});

module.exports = router;
