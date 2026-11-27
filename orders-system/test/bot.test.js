'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-bot-test-'));
process.env.PORT = '0';
delete process.env.TELEGRAM_BOT_TOKEN;
const { server, core } = require('../server.js');
const { createBot, parseItem, parseDate } = require('../bot.js');

const ME = 111, STRANGER = 999;
const sent = [];
const call = async (method, body) => { sent.push({ method, ...body }); return method === 'getUpdates' ? [] : true; };
const bot = createBot({ token: 'x', allowedIds: String(ME), core, call, log: { log() {}, error: e => { throw new Error(e); } } });
let uid = 1;
const msg = (text, from = ME) => bot.handleUpdate({ update_id: uid++, message: { chat: { id: from }, from: { id: from }, text } });
const tap = (data, from = ME) => bot.handleUpdate({ update_id: uid++, callback_query: { id: 'q', from: { id: from }, data, message: { chat: { id: from }, message_id: 5 } } });
const last = () => sent.filter(s => s.method === 'sendMessage').at(-1);
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

test.after(() => server.close());

test('parsers', () => {
  assert.deepEqual(parseItem('فوطة قطن 50×100 - 200 - 45'), { product: 'فوطة قطن 50×100', quantity: 200, unit: 'قطعة', price: 45 });
  assert.deepEqual(parseItem('قماش ستائر - ٨٠ متر - ٨٥'), { product: 'قماش ستائر', quantity: 80, unit: 'متر', price: 85 });
  assert.deepEqual(parseItem('ملاية | 10'), { product: 'ملاية', quantity: 10, unit: 'قطعة', price: 0 });
  assert.equal(parseItem('كلام من غير أرقام'), null);
  assert.equal(parseDate('25/12/2026', '2026-11-18'), '2026-12-25');
  assert.equal(parseDate('5/1', '2026-11-18'), '2027-01-05');
  assert.equal(parseDate('10', '2026-11-18'), '2026-11-28');
  assert.equal(parseDate('31/2/2026', '2026-11-18'), null);
});

test('stranger is rejected', async () => {
  await msg('/late', STRANGER);
  assert.match(last().text, /خاص/);
  await tap('st:1:delivered', STRANGER);
  assert.equal(sent.at(-1).method, 'answerCallbackQuery');
});

test('linking an account with the one-time link from the settings page', async () => {
  const { tgAccess } = require('../server.js');
  const LINKED = 222;
  const linkBot = createBot({ token: 'x', access: tgAccess, core, call, log: { log() {}, error() {} } });
  core.setSetting('telegram_link_code', 'secret123');
  const m = (text, id) => linkBot.handleUpdate({ update_id: uid++, message: { chat: { id }, from: { id }, text } });
  await m('/start wrong', LINKED);
  assert.match(last().text, /خاص/);
  assert.equal(tgAccess.has(LINKED), false);
  await m('/start secret123', LINKED);
  assert.match(last().text, /تم ربط حسابك/);
  assert.equal(tgAccess.has(LINKED), true);
  assert.notEqual(tgAccess.linkCode(), 'secret123', 'link is single-use');
  await m('/start secret123', 333);
  assert.equal(tgAccess.has(333), false);
});

test('new order wizard, customer report, status change, late report', async () => {
  await msg('/new');
  await msg('مصنع الفجر');                         // عميل مش موجود
  assert.match(last().text, /عميل جديد/);
  await tap('cust:new');
  assert.match(last().text, /الأصناف/);
  await msg('سطر غلط');
  assert.match(last().text, /مش قادر أفهم/);
  await msg('فوطة قطن - 100 - 20\nبشكير - 50 - 40');
  assert.match(last().text, /الإجمالي 4,000/);
  await tap('due:' + day(7));
  assert.match(last().text, /راجع الطلب/);
  await tap('new:urgent');
  assert.match(last().text, /اتسجل الطلب <code>ORD-\d{4}-0001<\/code>/);
  const order = core.getOrderByCode(last().text.match(/ORD-\d{4}-\d{4}/)[0]);
  assert.equal(order.priority, 'urgent');
  assert.equal(order.total, 4000);

  // طلب متأخر لنفس العميل
  const late = core.createOrder({ customer_id: order.customer_id, order_date: day(-10), due_date: day(-2), items: [{ product: 'ملاية', quantity: 5, price: 100 }] });

  await msg('الفجر');                                // بحث باسم العميل
  const rep = last().text;
  assert.match(rep, /عدد الطلبات: <b>2<\/b>/);
  assert.match(rep, /متأخرة: 1/);
  assert.ok(rep.includes(order.code) && rep.includes(late.code));

  await msg('⏰ المتأخر');
  assert.match(last().text, /الطلبات المتأخرة: 1/);
  assert.match(last().text, /متأخر 2 يوم/);

  await msg(late.code.toLowerCase());                // بحث بكود الطلب
  assert.match(last().text, /ملاية/);
  await tap(`st:${late.id}:delivered`);
  const edit = sent.filter(s => s.method === 'editMessageText').at(-1);
  assert.match(edit.text, /تم التسليم/);
  assert.equal(core.getOrder(late.id).status, 'delivered');

  await msg('/late');
  assert.match(last().text, /مفيش ولا طلب متأخر/);

  await msg('/today');
  assert.match(last().text, /ملخص/);

  sent.length = 0;
  assert.equal(await bot.dailyReport(true), true);
  assert.equal(last().chat_id, ME);
  assert.match(last().text, /صباح الخير/);
});
