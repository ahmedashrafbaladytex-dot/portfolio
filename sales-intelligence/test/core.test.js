'use strict';
process.removeAllListeners('warning');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { parseFile, groupDocs, detectType } = require('../src/parse');
const { readXlsx, writeXlsx } = require('../src/xlsx');
const { inferAttributes, classifyReason } = require('../src/attributes');
const { toDate, toNumber, addDays } = require('../src/util');
const { open } = require('../src/db');
const { analyze } = require('../src/analytics');
const { holtDamped } = require('../src/forecast');
const { syncOrders } = require('../src/orders-sync');
const R = require('../src/reports');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intel-'));

test('أرقام وتواريخ مصرية', () => {
  assert.strictEqual(toNumber('١٬٢٥٠٫٥ ج.م'), 1250.5);
  assert.strictEqual(toNumber('1,200'), 1200);
  assert.strictEqual(toDate('17/11/2026'), '2026-11-17');
  assert.strictEqual(toDate('١٧-١١-٢٠٢٦'), '2026-11-17');
  assert.strictEqual(toDate(46343), '2026-11-17');
  assert.strictEqual(toDate('2026-11-17'), '2026-11-17');
});

test('CSV بعناوين عربي وبيانات فوق الجدول وأكتر من فاتورة', () => {
  const csv = '﻿العميل:,معرض النور\nالتاريخ:,15/11/2026\n\nرقم الفاتورة,كود الصنف,اسم الصنف,الكمية,سعر الوحدة,الإجمالي\n'
    + '101,BS-1,طقم سرير ساتان بيج 2 فرد,10,850,8500\n,TW-2,فوطة قطن أبيض,"1,000",12,\n102,BS-1,طقم سرير ساتان بيج 2 فرد,5,850,4250\nالإجمالي,,,,,24750\n';
  const p = parseFile(Buffer.from(csv), 'x.csv');
  assert.strictEqual(p.lines.length, 3);
  assert.strictEqual(p.lines[1].qty, 1000);
  assert.strictEqual(p.lines[1].total, 12000);
  const docs = groupDocs(p.lines, p.meta);
  assert.strictEqual(docs.length, 2);
  assert.strictEqual(docs[0].doc_no, '101');
  assert.strictEqual(docs[0].lines.length, 2); // ملء رقم الفاتورة من السطر اللي فوقه
  assert.strictEqual(docs[0].customer, 'معرض النور');
  assert.strictEqual(docs[0].doc_date, '2026-11-15');
});

test('Excel: كتابة وقراءة', () => {
  const buf = writeXlsx([{ name: 'مرتجعات', rows: [['رقم المرتجع', 'التاريخ', 'الصنف', 'الكمية', 'السبب'], ['R1', '2026-11-01', 'بطانية <فرو> & كحلي', 3, 'عيب خياطة']] }]);
  const sheets = readXlsx(buf);
  assert.strictEqual(sheets[0].name, 'مرتجعات');
  assert.strictEqual(sheets[0].rows[1][2], 'بطانية <فرو> & كحلي');
  const p = parseFile(buf, 'r.xlsx');
  assert.strictEqual(p.lines[0].reason, 'عيب خياطة');
  assert.strictEqual(p.lines[0].qty, 3);
});

test('تحديد النوع والخصائص والأسباب', () => {
  assert.strictEqual(detectType('#مرتجعات النهارده'), 'return');
  assert.strictEqual(detectType('#مبيعات'), 'sale');
  assert.strictEqual(detectType('طلبيات العملاء.xlsx'), 'order');
  assert.strictEqual(detectType('#مخزون'), 'stock');
  const a = inferAttributes('طقم ملاية قطن مصري مشجر أوف وايت 2 فرد');
  assert.deepStrictEqual(a, { category: 'طقم سرير', fabric: 'قطن مصري', color: 'أوف وايت', pattern: 'مشجر / ورود', size: 'دبل / 2 فرد' });
  assert.strictEqual(inferAttributes('بطانية فلانيل بالأحمر 220x240').size, '220×240');
  assert.strictEqual(inferAttributes('بطانية فلانيل بالأحمر').color, 'أحمر');
  assert.strictEqual(classifyReason('فيه عيب في الخياطة'), 'عيب صناعة / جودة');
  assert.strictEqual(classifyReason('المقاس صغير'), 'المقاس');
});

test('التنبؤ بيمسك الاتجاه', () => {
  const r = holtDamped([10, 12, 14, 16, 18, 20, 22, 24], 4);
  assert.ok(r.forecast[0] > 22 && r.forecast[0] < 30, String(r.forecast[0]));
});

function seed(store, asOf) {
  for (let d = 120; d >= 0; d--) {
    const date = addDays(asOf, -d);
    const t = 120 - d;
    store.saveDoc({ type: 'sale', doc_no: `S${d}`, doc_date: date, customer: d % 3 ? 'أ' : 'ب', lines: [
      { item_code: 'STAR', item_name: 'لحاف ساتان سادة بيج', qty: 5 + Math.floor(t / 10), price: 1000, total: (5 + Math.floor(t / 10)) * 1000 },
      { item_code: 'BAD', item_name: 'طقم سرير بوليستر مقلم أحمر', qty: 4, price: 500, total: 2000 },
      ...(d > 70 ? [{ item_code: 'SLOW', item_name: 'مفرش سفرة قطيفة مطبوع نبيتي', qty: 1, price: 300, total: 300 }] : []),
    ] });
    if (d % 2 === 0) store.saveDoc({ type: 'return', doc_no: `R${d}`, doc_date: date, customer: 'أ', lines: [{ item_code: 'BAD', qty: 2, price: 500, total: 1000, reason: 'المقاس صغير' }] });
  }
}

test('حفظ المستند واستبداله لو اتبعت تاني', () => {
  const store = open(tmp());
  const doc = { type: 'sale', doc_no: '5', doc_date: '2026-11-01', lines: [{ item_code: 'A', item_name: 'فوطة قطن', qty: 2, price: 10, total: 20 }] };
  assert.strictEqual(store.saveDoc(doc).replaced, false);
  assert.strictEqual(store.saveDoc({ ...doc, lines: [{ ...doc.lines[0], qty: 3, total: 30 }] }).replaced, true);
  assert.strictEqual(store.allLines().length, 1);
  assert.strictEqual(store.allLines()[0].qty, 3);
  // نفس الصنف بالاسم بس من غير كود
  store.saveDoc({ type: 'order', doc_no: 'O1', doc_date: '2026-11-02', lines: [{ item_name: 'فوطة  قطن', qty: 1 }] });
  assert.ok(store.allLines().every(l => l.code === 'A'));
});

test('التحليل: نجم، مشكلة مرتجعات، راكد، خطة إنتاج، تقارير', () => {
  const store = open(tmp());
  const asOf = '2026-11-15';
  seed(store, asOf);
  store.saveStock([{ item_code: 'STAR', qty: 30 }, { item_code: 'SLOW', qty: 200 }], addDays(asOf, -5));
  const a = analyze({ lines: store.allLines(), items: store.items(), stock: store.stock() }, { asOf, window: 90 });
  const by = Object.fromEntries(a.items.map(i => [i.code, i]));
  assert.strictEqual(by.BAD.cls, 'problem');
  assert.ok(Math.abs(by.BAD.return_rate - 0.25) < 0.02);
  assert.strictEqual(by.SLOW.cls, 'slow');
  assert.ok(by.STAR.score > by.SLOW.score);
  assert.strictEqual(by.STAR.priority, 'urgent');
  assert.ok(by.STAR.produce > 0);
  assert.ok(a.overstock.some(i => i.code === 'SLOW'));
  assert.strictEqual(a.reasons[0].reason, 'المقاس');
  assert.strictEqual(a.taste.fabric[0].value, 'ساتان');
  assert.strictEqual(by.STAR.abc, 'A');
  for (const fn of ['summaryMessage', 'topMessage', 'returnsMessage', 'tasteMessage', 'modelsMessage', 'forecastMessage']) assert.ok(R[fn](a).length > 50, fn);
  assert.ok(R.dashboardHtml(a).includes('<html'));
  assert.ok(readXlsx(R.excelReport(a)).length === 6);
  JSON.stringify(R.compactForAI(a));
});

test('ربط نظام طلبات العملاء', () => {
  const dir = tmp();
  const src = new DatabaseSync(path.join(dir, 'orders.db'));
  src.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, code TEXT, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, code TEXT, customer_id INTEGER, order_date TEXT, due_date TEXT, status TEXT);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product TEXT, quantity REAL, unit TEXT, price REAL);
    INSERT INTO customers VALUES (1,'C-1','معرض النور');
    INSERT INTO orders VALUES (1,'ORD-1',1,'2026-11-10','2026-11-20','new'),(2,'ORD-2',1,'2026-11-11','2026-11-20','cancelled');
    INSERT INTO order_items VALUES (1,1,'بطانية فلانيل كحلي',20,'قطعة',300),(2,2,'x',1,'قطعة',1);`);
  src.close();
  const store = open(tmp());
  assert.strictEqual(syncOrders(store, path.join(dir, 'orders.db')).synced, 1);
  const l = store.allLines();
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].type, 'order');
  assert.strictEqual(l[0].customer, 'معرض النور');
});
