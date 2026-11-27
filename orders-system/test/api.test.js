'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-test-'));
process.env.PORT = '0';
const { server } = require('../server.js');

let base;
const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + '/api/' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test.before(() => new Promise(r => server.on('listening', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

test('full flow: customers, orders, late, report', async () => {
  const c1 = (await call('customers', 'POST', { name: 'شركة النور', phone: '0100' })).data;
  const c2 = (await call('customers', 'POST', { name: 'محلات الأمل' })).data;
  assert.equal(c1.code, 'C-0001');
  assert.equal(c2.code, 'C-0002');
  assert.equal((await call('customers', 'POST', { name: 'x', code: 'c-0001' })).status, 400, 'duplicate code rejected');

  const late = await call('orders', 'POST', { customer_id: c1.id, order_date: day(-20), due_date: day(-5), paid: 100,
    items: [{ product: 'فوطة', quantity: 10, price: 50 }, { product: 'ملاية', quantity: 2, price: 200 }] });
  assert.equal(late.status, 201);
  assert.match(late.data.code, /^ORD-\d{4}-0001$/);
  assert.equal(late.data.total, 900);
  assert.equal(late.data.days_late, 5);

  const ok = (await call('orders', 'POST', { customer_id: c1.id, order_date: day(-10), due_date: day(-2), items: [{ product: 'بشكير', quantity: 5, price: 10 }] })).data;
  await call(`orders/${ok.id}/status`, 'POST', { status: 'delivered' });
  const soon = (await call('orders', 'POST', { customer_id: c2.id, order_date: day(0), due_date: day(2), items: [{ product: 'ستارة', quantity: 1, price: 0 }] })).data;

  const lateList = (await call('orders?late=1')).data;
  assert.deepEqual(lateList.map(o => o.id), [late.data.id], 'delivered orders are not late');
  assert.deepEqual((await call('orders?due_soon=1')).data.map(o => o.id), [soon.id]);

  const rep = (await call('customers/' + c1.id)).data;
  assert.equal(rep.orders_count, 2);
  assert.equal(rep.late_count, 1);
  assert.equal(rep.delivered_count, 1);
  assert.equal(rep.total_value, 950);
  assert.equal(rep.total_paid, 100);
  assert.equal(rep.order_codes, `${late.data.code}، ${ok.code}`);

  const d = (await call('dashboard')).data;
  assert.equal(d.counts.late, 1);
  assert.equal(d.counts.open, 2);

  // validation
  assert.equal((await call('orders', 'POST', { customer_id: c1.id, order_date: day(0), due_date: day(-1), items: [{ product: 'a', quantity: 1 }] })).status, 400);
  assert.equal((await call('orders', 'POST', { customer_id: c1.id, order_date: day(0), due_date: day(1), items: [] })).status, 400);
  // can't delete customer with orders
  assert.equal((await call('customers/' + c1.id, 'DELETE')).status, 400);

  // edit + log
  const ed = (await call('orders/' + late.data.id, 'PUT', { ...late.data, due_date: day(3), status: 'in_progress' })).data;
  assert.equal(ed.days_late, 0);
  assert.ok(ed.log[0].action.includes('قيد التنفيذ'));

  const csv = await fetch(base + '/api/export/orders.csv');
  assert.match(await csv.text(), /كود الطلب/);
  const s = await call('search-nothing');
  assert.equal(s.status, 404);
});

test('password set from settings page protects the app', async () => {
  assert.equal((await call('meta')).data.auth, false);
  assert.equal((await call('password', 'POST', { password: '123' })).status, 400, 'too short');
  const set = await fetch(base + '/api/password', { method: 'POST', body: JSON.stringify({ password: 'new-pass-1' }) });
  assert.equal(set.status, 200);
  const cookie = set.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('dashboard')).status, 401, 'locked without cookie');
  assert.equal((await fetch(base + '/api/dashboard', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })).status, 401);
  const ok = await fetch(base + '/login', { method: 'POST', body: JSON.stringify({ password: 'new-pass-1' }) });
  assert.equal(ok.status, 200);
  const changed = await fetch(base + '/api/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ current: 'bad', password: 'xxxxxxx' }) });
  assert.equal(changed.status, 400, 'current password required');
  const bad = await fetch(base + '/api/telegram', { method: 'POST', headers: { cookie }, body: JSON.stringify({ token: 'not-a-token' }) });
  assert.equal(bad.status, 400);
});
