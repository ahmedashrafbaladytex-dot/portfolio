// ربط مع «نظام طلبات العملاء» (orders-system): يقرا الطلبات من قاعدة بياناته مباشرة
'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function syncOrders(store, ordersDbPath) {
  if (!ordersDbPath || !fs.existsSync(ordersDbPath)) return { synced: 0, skipped: true };
  const src = new DatabaseSync(ordersDbPath, { readOnly: true });
  try {
    const orders = src.prepare(`SELECT o.id, o.code, o.order_date, c.name AS customer
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.status <> 'cancelled'`).all();
    const itemsStmt = src.prepare('SELECT product, quantity, price FROM order_items WHERE order_id=?');
    const seen = new Set();
    let synced = 0;
    for (const o of orders) {
      const lines = itemsStmt.all(o.id).map(r => ({ item_name: r.product, qty: r.quantity, price: r.price, total: r.quantity * r.price }));
      if (!lines.length) continue;
      seen.add(o.code);
      store.saveDoc({ type: 'order', doc_no: o.code, doc_date: o.order_date.slice(0, 10), customer: o.customer, lines, source: 'orders-system' });
      synced++;
    }
    // الطلبات اللي اتلغت أو اتمسحت في نظام الطلبات
    const local = store.db.prepare(`SELECT id, doc_no FROM docs WHERE type='order' AND source='orders-system'`).all();
    for (const d of local) if (!seen.has(d.doc_no)) store.deleteDoc(d.id);
    return { synced };
  } finally {
    src.close();
  }
}

module.exports = { syncOrders };
