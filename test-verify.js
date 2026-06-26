/**
 * test-verify.js
 * End-to-end verification script — runs all checks and prints PASS/FAIL.
 * Usage: node test-verify.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const BASE = 'http://localhost:5000';

async function req(method, path, body, token) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function pass(label, detail = '') { console.log(`  ✅ PASS  ${label}${detail ? ' — ' + detail : ''}`); }
function fail(label, detail = '') { console.log(`  ❌ FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
function section(title) { console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`); }

async function run() {
  section('1. Health Check');
  const health = await req('GET', '/api/health');
  health.status === 200 && health.data.success
    ? pass('GET /api/health', health.data.message)
    : fail('GET /api/health', JSON.stringify(health.data));

  section('2. Admin Login');
  const adminR = await req('POST', '/api/admin/login', { email: 'admin@restaurant.com', password: 'Admin1234!' });
  if (adminR.status !== 200 || !adminR.data.token) {
    fail('Admin login', JSON.stringify(adminR.data));
    return;
  }
  pass('Admin login', `role=${adminR.data.admin.role}`);
  const AT = adminR.data.token;

  section('3. Create/Find Demo Restaurant');
  let restaurantId;
  const listR = await req('GET', '/api/admin/restaurants', null, AT);
  const existing = listR.data.restaurants?.find(r => r.restaurantKey === 'demo_burger_kitchen');
  if (existing) {
    restaurantId = existing._id;
    pass('Restaurant exists', `id=${restaurantId}`);
    // Update it to ensure new fields are set
    await req('PATCH', `/api/admin/restaurants/${restaurantId}`, {
      currencyCode: 'USD', currencySymbol: 'US$',
      sourceFulfillmentTypeField: 'orderType', sourceOrderNoteField: 'notes',
      timezone: 'America/New_York',
    }, AT);
    pass('Restaurant updated with new fields');
  } else {
    const MONGO_URI = process.env.MONGO_URI;
    const createR = await req('POST', '/api/admin/restaurants', {
      name: 'Demo Burger Kitchen',
      restaurantKey: 'demo_burger_kitchen',
      timezone: 'America/New_York',
      currencyCode: 'USD',
      currencySymbol: 'US$',
      sourceDbUri: MONGO_URI,
      sourceDbName: 'test_restaurant_source',
      sourceOrderCollection: 'orders',
      sourcePaymentStatusField: 'paymentStatus',
      sourcePaidValue: 'paid',
      sourceOrderNumberField: 'orderNumber',
      sourceItemsField: 'items',
      sourceFulfillmentTypeField: 'orderType',
      sourceOrderNoteField: 'notes',
      isActive: true,
    }, AT);
    if (createR.status === 201) {
      restaurantId = createR.data.restaurant._id;
      pass('Restaurant created', `id=${restaurantId}`);
    } else {
      fail('Restaurant create', JSON.stringify(createR.data));
      return;
    }
  }

  // Verify new fields saved
  const getR = await req('GET', `/api/admin/restaurants/${restaurantId}`, null, AT);
  const r = getR.data.restaurant;
  r.currencyCode === 'USD'           ? pass('currencyCode saved', r.currencyCode)           : fail('currencyCode', r.currencyCode);
  r.currencySymbol === 'US$'         ? pass('currencySymbol saved', r.currencySymbol)        : fail('currencySymbol', r.currencySymbol);
  r.sourceFulfillmentTypeField === 'orderType' ? pass('sourceFulfillmentTypeField saved')    : fail('sourceFulfillmentTypeField', r.sourceFulfillmentTypeField);
  r.sourceOrderNoteField === 'notes' ? pass('sourceOrderNoteField saved')                    : fail('sourceOrderNoteField', r.sourceOrderNoteField);
  r.timezone === 'America/New_York'  ? pass('timezone saved', r.timezone)                   : fail('timezone', r.timezone);

  section('4. Create Owner with loginId + short password');
  const createU = await req('POST', `/api/admin/restaurants/${restaurantId}/users`, {
    name: 'Demo Owner', loginId: 'demoowner', email: 'demoowner@example.com', password: '123',
  }, AT);
  if (createU.status === 201) {
    pass('User created', `loginId=${createU.data.user.loginId}`);
  } else if (createU.status === 409) {
    pass('User already exists (409 expected on re-run)');
  } else {
    fail('User create', JSON.stringify(createU.data));
  }

  section('5. Owner Login Tests');
  // Login with loginId
  const l1 = await req('POST', '/api/auth/login', { login: 'demoowner', password: '123' });
  l1.status === 200 && l1.data.token
    ? pass('Login with loginId "demoowner"', `loginId=${l1.data.user.loginId}`)
    : fail('Login with loginId', JSON.stringify(l1.data));

  // Login with email
  const l2 = await req('POST', '/api/auth/login', { email: 'demoowner@example.com', password: '123' });
  l2.status === 200 && l2.data.token
    ? pass('Login with email (backward compat)', `email=${l2.data.user.email}`)
    : fail('Login with email', JSON.stringify(l2.data));

  // Login with { login: email }
  const l3 = await req('POST', '/api/auth/login', { login: 'demoowner@example.com', password: '123' });
  l3.status === 200 && l3.data.token
    ? pass('Login with { login: email }')
    : fail('Login with { login: email }', JSON.stringify(l3.data));

  // Wrong password rejected
  const l4 = await req('POST', '/api/auth/login', { login: 'demoowner', password: 'wrong' });
  l4.status === 401
    ? pass('Wrong password rejected (401)')
    : fail('Wrong password not rejected', `status=${l4.status}`);

  const OT = l1.data.token;

  section('6. Seed Test Orders into Source DB');
  // Connect directly to source DB and insert test orders
  const conn = await mongoose.createConnection(process.env.MONGO_URI, {
    dbName: 'test_restaurant_source',
  }).asPromise();
  const schema = new mongoose.Schema({}, { strict: false });
  let OrderModel;
  try { OrderModel = conn.model('Order'); } catch { OrderModel = conn.model('Order', schema, 'orders'); }

  const testOrders = [
    {
      orderNumber: 'DEMO-001', paymentStatus: 'paid', orderStatus: 'new',
      orderType: 'pickup', pickupType: 'ASAP', isASAP: true,
      customerName: 'Alice Smith', customerPhone: '416-555-0001', customerEmail: 'alice@test.com',
      items: [{ name: 'Burger', quantity: 1, price: 12.99 }, { name: 'Fries', quantity: 1, price: 4.99 }],
      subtotal: 17.98, tax: 1.44, tip: 2, deliveryFee: 0, total: 21.42,
      currency: 'USD', notes: 'No onions please, extra ketchup',
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      orderNumber: 'DEMO-002', paymentStatus: 'paid', orderStatus: 'new',
      orderType: 'delivery',
      customerName: 'Bob Jones', customerPhone: '416-555-0002', customerEmail: 'bob@test.com',
      items: [{ name: 'Chicken Sandwich', quantity: 2, price: 11.99 }],
      subtotal: 23.98, tax: 1.92, tip: 3, deliveryFee: 5, total: 33.90,
      currency: 'USD', notes: 'Ring doorbell twice',
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      orderNumber: 'DEMO-003', paymentStatus: 'paid', orderStatus: 'new',
      orderType: 'pickup', pickupType: 'scheduled',
      pickupTime: new Date(Date.now() + 45 * 60 * 1000), // 45 min from now
      customerName: 'Carol Lee', customerPhone: '416-555-0003', customerEmail: 'carol@test.com',
      items: [{ name: 'Veggie Wrap', quantity: 1, price: 9.99 }],
      subtotal: 9.99, tax: 0.80, tip: 1, deliveryFee: 0, total: 11.79,
      currency: 'USD', notes: '',
      createdAt: new Date(), updatedAt: new Date(),
    },
    {
      orderNumber: 'DEMO-004', paymentStatus: 'unpaid', orderStatus: 'new',
      orderType: 'pickup', isASAP: true,
      customerName: 'Dave Unpaid', customerPhone: '416-555-0004',
      items: [{ name: 'Hot Dog', quantity: 1, price: 5.99 }],
      subtotal: 5.99, tax: 0.48, tip: 0, deliveryFee: 0, total: 6.47,
      currency: 'USD',
      createdAt: new Date(), updatedAt: new Date(),
    },
  ];

  let inserted = 0, skipped = 0;
  for (const o of testOrders) {
    const ex = await OrderModel.findOne({ orderNumber: o.orderNumber });
    if (ex) { skipped++; } else { await OrderModel.create(o); inserted++; }
  }
  pass(`Test orders seeded`, `inserted=${inserted} skipped=${skipped}`);
  await conn.close();

  section('7. GET /api/orders — Owner fetches orders');
  const ordersR = await req('GET', '/api/orders?limit=100', null, OT);
  if (ordersR.status !== 200) {
    fail('GET /api/orders', JSON.stringify(ordersR.data));
  } else {
    const orders = ordersR.data.orders;
    pass('GET /api/orders returned', `count=${orders.length}`);

    // Unpaid order must NOT appear
    const unpaid = orders.find(o => o.orderNumber === 'DEMO-004');
    !unpaid ? pass('Unpaid order hidden (DEMO-004 not in results)') : fail('Unpaid order visible — should be hidden');

    // Paid orders must appear
    const demo1 = orders.find(o => o.orderNumber === 'DEMO-001');
    const demo2 = orders.find(o => o.orderNumber === 'DEMO-002');
    const demo3 = orders.find(o => o.orderNumber === 'DEMO-003');

    demo1 ? pass('DEMO-001 (paid pickup ASAP) visible') : fail('DEMO-001 missing');
    demo2 ? pass('DEMO-002 (paid delivery) visible') : fail('DEMO-002 missing');
    demo3 ? pass('DEMO-003 (paid scheduled pickup) visible') : fail('DEMO-003 missing');

    if (demo1) {
      demo1.fulfillmentType === 'pickup'  ? pass('DEMO-001 fulfillmentType=pickup')   : fail('DEMO-001 fulfillmentType', demo1.fulfillmentType);
      demo1.orderNote === 'No onions please, extra ketchup' ? pass('DEMO-001 orderNote correct') : fail('DEMO-001 orderNote', demo1.orderNote);
      demo1.currencySymbol === 'US$'      ? pass('DEMO-001 currencySymbol=US$')        : fail('DEMO-001 currencySymbol', demo1.currencySymbol);
      demo1.currencyCode === 'USD'        ? pass('DEMO-001 currencyCode=USD')          : fail('DEMO-001 currencyCode', demo1.currencyCode);
      demo1.restaurantTimezone === 'America/New_York' ? pass('DEMO-001 timezone correct') : fail('DEMO-001 timezone', demo1.restaurantTimezone);
      demo1.pickupMode === 'asap'         ? pass('DEMO-001 pickupMode=asap')           : fail('DEMO-001 pickupMode', demo1.pickupMode);
      Array.isArray(demo1.items) && demo1.items.length === 2 ? pass('DEMO-001 items correct (2 items)') : fail('DEMO-001 items', JSON.stringify(demo1.items));
    }
    if (demo2) {
      demo2.fulfillmentType === 'delivery' ? pass('DEMO-002 fulfillmentType=delivery') : fail('DEMO-002 fulfillmentType', demo2.fulfillmentType);
      demo2.orderNote === 'Ring doorbell twice' ? pass('DEMO-002 orderNote correct')   : fail('DEMO-002 orderNote', demo2.orderNote);
    }
    if (demo3) {
      demo3.pickupMode === 'scheduled'    ? pass('DEMO-003 pickupMode=scheduled')      : fail('DEMO-003 pickupMode', demo3.pickupMode);
      demo3.pickupTime                    ? pass('DEMO-003 pickupTime present', demo3.pickupTime) : fail('DEMO-003 pickupTime missing');
    }
  }

  section('8. Prep Time — save with customPrepTimeLabel');
  const ordersR2 = await req('GET', '/api/orders?limit=100', null, OT);
  const demo3id = ordersR2.data.orders?.find(o => o.orderNumber === 'DEMO-003')?.id;
  if (demo3id) {
    const prepR = await req('PATCH', `/api/orders/${demo3id}/prep-time`, {
      prepTimeMinutes: 0,
      customPrepTimeLabel: 'Customer pickup time: 5:30 PM',
    }, OT);
    prepR.status === 200
      ? pass('Save customPrepTimeLabel', 'Customer pickup time: 5:30 PM')
      : fail('Save customPrepTimeLabel', JSON.stringify(prepR.data));

    // Verify it comes back
    const getO = await req('GET', `/api/orders/${demo3id}`, null, OT);
    getO.data.order?.customPrepTimeLabel === 'Customer pickup time: 5:30 PM'
      ? pass('customPrepTimeLabel persisted on GET /api/orders/:id')
      : fail('customPrepTimeLabel not persisted', getO.data.order?.customPrepTimeLabel);
  } else {
    fail('DEMO-003 not found for prep time test');
  }

  section('9. Admin Live Orders — GET /api/admin/orders');
  const adminOrders = await req('GET', '/api/admin/orders?limit=50', null, AT);
  adminOrders.status === 200
    ? pass('GET /api/admin/orders', `count=${adminOrders.data.orders?.length}`)
    : fail('GET /api/admin/orders', JSON.stringify(adminOrders.data));

  // Filter by restaurantId
  const filtered = await req('GET', `/api/admin/orders?restaurantId=${restaurantId}&limit=50`, null, AT);
  filtered.status === 200
    ? pass('GET /api/admin/orders?restaurantId filter', `count=${filtered.data.orders?.length}`)
    : fail('GET /api/admin/orders filter', JSON.stringify(filtered.data));

  // Search filter
  const searched = await req('GET', `/api/admin/orders?search=Alice&limit=50`, null, AT);
  searched.status === 200
    ? pass('GET /api/admin/orders?search=Alice', `count=${searched.data.orders?.length}`)
    : fail('GET /api/admin/orders search', JSON.stringify(searched.data));

  section('10. Customers endpoint');
  const custR = await req('GET', `/api/admin/restaurants/${restaurantId}/customers`, null, AT);
  if (custR.status === 200) {
    pass('GET /api/admin/restaurants/:id/customers', `count=${custR.data.customers?.length}`);
    const alice = custR.data.customers?.find(c => c.customerEmail === 'alice@test.com');
    alice ? pass('Alice in customers list') : fail('Alice not in customers list');
  } else {
    fail('Customers endpoint', JSON.stringify(custR.data));
  }

  section('11. Test Notification endpoint');
  const notifR = await req('POST', '/api/debug/send-test-notification', {
    restaurantId, title: 'Test Order', body: 'Verification test',
  }, AT);
  notifR.status === 200
    ? pass('POST /api/debug/send-test-notification', JSON.stringify(notifR.data.results || notifR.data.message))
    : fail('Test notification', JSON.stringify(notifR.data));

  section('12. App Login Credentials — GET /api/admin/users/:userId/credentials');
  // Find the demo user
  const usersR = await req('GET', `/api/admin/restaurants/${restaurantId}/users`, null, AT);
  const demoUser = usersR.data.users?.find(u => u.loginId === 'demoowner');
  if (!demoUser) {
    fail('Demo user not found for credentials test');
  } else {
    // Step 1: reset to known password "123"
    const reset1 = await req('PATCH', `/api/admin/users/${demoUser._id}/password`, { password: '123' }, AT);
    reset1.status === 200 ? pass('Reset password to 123') : fail('Reset to 123', JSON.stringify(reset1.data));

    // Step 2: GET credentials — must return "123"
    const cred1 = await req('GET', `/api/admin/users/${demoUser._id}/credentials`, null, AT);
    cred1.status === 200 ? pass('GET credentials returns 200') : fail('GET credentials status', cred1.status);
    cred1.data.currentAppPassword === '123'
      ? pass('currentAppPassword = "123" after reset')
      : fail('currentAppPassword wrong after reset', cred1.data.currentAppPassword);
    cred1.data.loginId === 'demoowner'
      ? pass('credentials.loginId correct')
      : fail('credentials.loginId', cred1.data.loginId);

    // Step 3: login with 123 works
    const login1 = await req('POST', '/api/auth/login', { login: 'demoowner', password: '123' });
    login1.status === 200 && login1.data.token
      ? pass('Login with 123 works')
      : fail('Login with 123 failed', JSON.stringify(login1.data));

    // Step 4: reset to "456"
    const reset2 = await req('PATCH', `/api/admin/users/${demoUser._id}/password`, { password: '456' }, AT);
    reset2.status === 200 ? pass('Reset password to 456') : fail('Reset to 456', JSON.stringify(reset2.data));

    // Step 5: login with 456 works
    const login2 = await req('POST', '/api/auth/login', { login: 'demoowner', password: '456' });
    login2.status === 200 && login2.data.token
      ? pass('Login with 456 works')
      : fail('Login with 456 failed', JSON.stringify(login2.data));

    // Step 6: login with old password 123 fails
    const login3 = await req('POST', '/api/auth/login', { login: 'demoowner', password: '123' });
    login3.status === 401
      ? pass('Old password 123 correctly rejected')
      : fail('Old password 123 not rejected', `status=${login3.status}`);

    // Step 7: GET credentials returns "456"
    const cred2 = await req('GET', `/api/admin/users/${demoUser._id}/credentials`, null, AT);
    cred2.data.currentAppPassword === '456'
      ? pass('GET credentials returns "456" after reset')
      : fail('GET credentials wrong after reset to 456', cred2.data.currentAppPassword);

    // Step 8: simulate close/reopen — call GET credentials again (twice)
    const cred3 = await req('GET', `/api/admin/users/${demoUser._id}/credentials`, null, AT);
    cred3.status === 200 && cred3.data.currentAppPassword === '456'
      ? pass('GET credentials 2nd call (modal reopen simulation) still returns "456"')
      : fail('GET credentials 2nd call failed', JSON.stringify(cred3.data));

    const cred4 = await req('GET', `/api/admin/users/${demoUser._id}/credentials`, null, AT);
    cred4.status === 200 && cred4.data.currentAppPassword === '456'
      ? pass('GET credentials 3rd call returns "456" — decrypt is stable')
      : fail('GET credentials 3rd call failed', JSON.stringify(cred4.data));
  }

  section('13. Website Admin Credentials');
  const wSave = await req('PATCH', `/api/admin/restaurants/${restaurantId}/website-credentials`, {
    websiteAdminUrl: 'https://demo-restaurant.com/admin',
    websiteAdminLoginId: 'demoadmin',
    websiteAdminEmail: 'admin@demo-restaurant.com',
    websiteAdminPassword: 'WebPass123',
    websiteAdminNotes: 'Test website credentials',
    websiteAdminIntegrationType: 'manual',
  }, AT);
  wSave.status === 200
    ? pass('PATCH website-credentials saved')
    : fail('PATCH website-credentials', JSON.stringify(wSave.data));

  const wGet = await req('GET', `/api/admin/restaurants/${restaurantId}/website-credentials`, null, AT);
  if (wGet.status !== 200) {
    fail('GET website-credentials', JSON.stringify(wGet.data));
  } else {
    pass('GET website-credentials', `status=${wGet.status}`);
    wGet.data.websiteAdminUrl === 'https://demo-restaurant.com/admin'
      ? pass('websiteAdminUrl correct')
      : fail('websiteAdminUrl', wGet.data.websiteAdminUrl);
    wGet.data.websiteAdminLoginId === 'demoadmin'
      ? pass('websiteAdminLoginId correct')
      : fail('websiteAdminLoginId', wGet.data.websiteAdminLoginId);
    wGet.data.websiteAdminPassword === 'WebPass123'
      ? pass('websiteAdminPassword decrypted correctly')
      : fail('websiteAdminPassword wrong', wGet.data.websiteAdminPassword);
    wGet.data.websiteAdminIntegrationType === 'manual'
      ? pass('websiteAdminIntegrationType = manual')
      : fail('websiteAdminIntegrationType', wGet.data.websiteAdminIntegrationType);

    // Update password and verify
    await req('PATCH', `/api/admin/restaurants/${restaurantId}/website-credentials`, {
      websiteAdminPassword: 'NewWebPass456',
    }, AT);
    const wGet2 = await req('GET', `/api/admin/restaurants/${restaurantId}/website-credentials`, null, AT);
    wGet2.data.websiteAdminPassword === 'NewWebPass456'
      ? pass('Updated website password decrypts correctly')
      : fail('Updated website password wrong', wGet2.data.websiteAdminPassword);
  }

  section('14. Security — encrypted fields not exposed in normal endpoints');
  const listR2 = await req('GET', '/api/admin/restaurants', null, AT);
  const r2 = listR2.data.restaurants?.[0];
  !r2?.websiteAdminPasswordEncrypted
    ? pass('websiteAdminPasswordEncrypted not in restaurant list')
    : fail('websiteAdminPasswordEncrypted EXPOSED in restaurant list — security issue');

  const usersR2 = await req('GET', `/api/admin/restaurants/${restaurantId}/users`, null, AT);
  const u2 = usersR2.data.users?.[0];
  !u2?.passwordHash && !u2?.appPasswordEncrypted && !u2?.passwordPlain
    ? pass('passwordHash/appPasswordEncrypted/passwordPlain not in users list')
    : fail('Sensitive password fields EXPOSED in users list — security issue');

  section('15. Admin Panel TypeScript Check');
  console.log('  (run manually: cd admin-panel && npx tsc --noEmit)');

  section('16. Mobile TypeScript Check');
  console.log('  (run manually: cd mobile-app && npx tsc --noEmit)');

  console.log('\n' + '═'.repeat(55));
  console.log('  Verification complete. Fix any ❌ items above.');
  console.log('═'.repeat(55) + '\n');
}

run().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
