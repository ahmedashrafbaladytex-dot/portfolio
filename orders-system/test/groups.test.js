'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-groups-test-'));
process.env.PORT = '0';
delete process.env.TELEGRAM_BOT_TOKEN;
const { server, core } = require('../server.js');
const { createBot } = require('../bot.js');
const { createIntake, matchCustomer } = require('../intake.js');

const OWNER = 111, STAFF = 555, GROUP = -1001, BOT_ID = 999;
const sent = [];
let aiCalls = 0, nextAI = null;
const call = async (method, body) => {
  sent.push({ method, ...body });
  if (method === 'getMe') return { id: BOT_ID, username: 'test_bot' };
  if (method === 'getChatMember') return { status: 'administrator' };
  return true;
};
const fakeExtract = async args => { aiCalls++; lastArgs = args; return { result: nextAI } };
let lastArgs = null;
const aiResult = o => ({ relevant: true, customer_name: null, customer_phone: null, document_number: null, date: null, due_date: null,
  order_reference: null, invoice_reference: null, items: [], written_total: null, notes: null, uncertain: false, uncertain_reason: null, ...o });

let aiOn = true;
const intake = createIntake({ core, extract: fakeExtract, aiConfig: () => aiOn ? { apiKey: 'k', quality: 'accurate' } : null, log: { error() {} } });
const bot = createBot({ token: 'x', allowedIds: String(OWNER), core, call, intake, download: async () => Buffer.from('fake-jpeg'),
  log: { log() {}, error: e => { throw new Error(e); } } });

let uid = 1, mid = 1;
const gmsg = (extra, from = STAFF) => bot.handleUpdate({ update_id: uid++, message: { message_id: mid++, chat: { id: GROUP, type: 'supergroup', title: 'طلبات المصنع' }, from: { id: from }, ...extra } });
const tap = (data, from = OWNER, chat = GROUP) => bot.handleUpdate({ update_id: uid++, callback_query: { id: 'q', from: { id: from }, data, message: { chat: { id: chat, title: 'جروب' }, message_id: 1 } } });
const lastTo = chat => sent.filter(s => (s.method === 'sendMessage' || s.method === 'editMessageText') && String(s.chat_id) === String(chat)).at(-1);
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test.after(() => server.close());

test('customer name matching tolerates Arabic spelling differences', () => {
  const cs = [{ id: 1, name: 'شركة النور للمفروشات', code: 'C-0001' }, { id: 2, name: 'محلات الأمل', code: 'C-0002' }];
  assert.equal(matchCustomer('النور للمفروشات', cs).id, 1);
  assert.equal(matchCustomer('محلات الامل', cs).id, 2);
  assert.equal(matchCustomer('c-0002', cs).id, 2);
  assert.equal(matchCustomer('فندق النيل', cs), null);
});

test('group setup: only the owner, and unconfigured groups are ignored', async () => {
  await gmsg({ new_chat_members: [{ id: BOT_ID }] });
  assert.match(lastTo(GROUP).text, /أدمن/);
  await gmsg({ text: 'فوطة 100 قطعة' });
  assert.equal(aiCalls, 0, 'not configured yet');
  await gmsg({ text: '/setup@test_bot' });
  assert.match(lastTo(GROUP).text, /لصاحب السيستم بس/);
  await gmsg({ text: '/setup' }, OWNER);
  assert.ok(lastTo(GROUP).reply_markup.inline_keyboard.length >= 3);
  await tap('setup:orders', STAFF);
  assert.equal(core.groups.get(GROUP), null);
  await tap('setup:orders', OWNER);
  assert.equal(core.groups.get(GROUP).kind, 'orders');
  assert.match(lastTo(GROUP).text, /جروب <b>📦 الطلبات/);
});

test('chit-chat without numbers never reaches the AI', async () => {
  await gmsg({ text: 'صباح الخير يا جماعة' });
  assert.equal(aiCalls, 0);
});

test('text order is read and recorded automatically, with undo', async () => {
  core.saveCustomer({ name: 'شركة النور للمفروشات', phone: '0100' });
  nextAI = aiResult({ customer_name: 'النور للمفروشات', due_date: day(5), items: [{ product: 'فوطة قطن 50×100', quantity: 200, unit: 'قطعة', price: 45 }] });
  await gmsg({ text: 'النور عايزين 200 فوطة 50×100 ب45 تسليم الخميس' });
  assert.equal(aiCalls, 1);
  assert.equal(lastArgs.kind, 'order');
  assert.ok(lastArgs.customers.some(c => c.name === 'شركة النور للمفروشات'), 'AI sees existing customers');
  const msg = lastTo(GROUP);
  assert.match(msg.text, /اتسجل طلب <code>ORD-\d{4}-0001/);
  assert.match(msg.text, /9,000/);
  assert.doesNotMatch(msg.text, /محتاج مراجعة/);
  const order = core.getOrderByCode(msg.text.match(/ORD-\d{4}-\d{4}/)[0]);
  assert.equal(order.customer_name, 'شركة النور للمفروشات');
  assert.equal(order.source, 'telegram');
  assert.equal(order.due_date, day(5));

  // someone else can't undo; the sender can
  const undo = msg.reply_markup.inline_keyboard[0][0].callback_data;
  await tap(undo, 777);
  assert.ok(core.getOrder(order.id));
  await tap(undo, STAFF);
  assert.throws(() => core.getOrder(order.id));
  assert.match(lastTo(GROUP).text, /اتلغى التسجيل/);
});

test('photo invoice: new customer + missing due info flagged for review, owner notified privately', async () => {
  core.groups.set(GROUP, 'invoices', 'الفواتير');
  const o = core.createOrder({ customer_id: core.listCustomers({ search: 'النور' })[0].id, order_date: day(-3), due_date: day(2), items: [{ product: 'ملاية', quantity: 10, price: 300 }] });
  nextAI = aiResult({ customer_name: 'النور للمفروشات', document_number: '1547', order_reference: o.code, written_total: 3000,
    items: [{ product: 'ملاية سرير', quantity: 10, unit: 'طقم', price: 300 }] });
  sent.length = 0;
  await gmsg({ photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'فاتورة النور' });
  assert.equal(lastArgs.kind, 'sale');
  assert.equal(lastArgs.files.length, 1);
  const msg = lastTo(GROUP);
  assert.match(msg.text, /اتسجل فاتورة <code>INV-\d{4}-0001<\/code><\/b> \(رقم الورقة 1547\)/);
  assert.match(msg.text, /اتعلّم تم التسليم/);
  assert.equal(core.getOrder(o.id).status, 'delivered');
  const inv = core.findInvoice('1547');
  assert.equal(inv.attachments.length, 1);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', inv.attachments[0])));

  // undo the invoice → order goes back to its previous status
  await tap(msg.reply_markup.inline_keyboard[0][0].callback_data, OWNER);
  assert.equal(core.getOrder(o.id).status, 'new');

  // unknown customer → created + review + private notification to owner
  nextAI = aiResult({ customer_name: 'معرض الزهراء', items: [{ product: 'بشكير', quantity: 20, unit: 'قطعة', price: null }] });
  sent.length = 0;
  await gmsg({ text: 'فاتورة الزهراء 20 بشكير' });
  assert.match(lastTo(GROUP).text, /محتاج مراجعة.*عميل جديد.*من غير سعر/s);
  assert.match(lastTo(OWNER).text, /محتاج مراجعة/);
  assert.equal(core.reviewCount(), 1);
});

test('return invoice links to the original invoice and reduces the customer net', async () => {
  core.groups.set(GROUP, 'returns', 'المرتجعات');
  const c = core.listCustomers({ search: 'النور' })[0];
  const sale = core.createInvoice({ kind: 'sale', customer_id: c.id, invoice_date: day(-1), ref_number: '2001', items: [{ product: 'فوطة', quantity: 100, price: 40 }] });
  nextAI = aiResult({ customer_name: 'شركة النور للمفروشات', invoice_reference: '2001', items: [{ product: 'فوطة', quantity: 10, unit: 'قطعة', price: 40 }] });
  await gmsg({ text: 'مرتجع النور 10 فوط من فاتورة 2001' });
  assert.match(lastTo(GROUP).text, /اتسجل مرتجع <code>RET-\d{4}-0001/);
  assert.match(lastTo(GROUP).text, new RegExp(`الفاتورة الأصلية <code>${sale.code}`));
  const cust = core.getCustomer(c.id);
  assert.equal(cust.sales_total, 4000);
  assert.equal(cust.returns_total, 400);
  assert.equal(cust.returns_count, 1);
  assert.ok(cust.return_codes.startsWith('RET-'));
});

test('AI not configured / not relevant / no items', async () => {
  aiOn = false;
  await gmsg({ text: 'طلب 50 فوطة' });
  assert.match(lastTo(GROUP).text, /مش متفعّل/);
  aiOn = true;
  nextAI = aiResult({ relevant: false });
  const before = sent.length;
  await gmsg({ text: 'هنسلم 3 طلبات بكرة' });
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, sent.slice(0, before).filter(s => s.method === 'sendMessage').length, 'no reply');
  nextAI = aiResult({ items: [] });
  await gmsg({ text: 'مرتجع 5' });
  assert.match(lastTo(GROUP).text, /مش لاقي أصناف/);
});

test('private bot finds invoices by code', async () => {
  const v = core.listInvoices({ kind: 'return' })[0];
  await bot.handleUpdate({ update_id: uid++, message: { message_id: mid++, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, text: v.code } });
  assert.match(lastTo(OWNER).text, /↩️ مرتجع/);
});
