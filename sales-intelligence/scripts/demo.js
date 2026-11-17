// بيانات تجريبية واقعية (6 شهور مفروشات) + توليد التقارير — للتجربة قبل ربط البوت
// التشغيل: node scripts/demo.js   ← بيطلع الملفات في فولدر demo-output
'use strict';
process.removeAllListeners('warning');

const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../src/db');
const { run, config } = require('../src/engine');
const { addDays, today } = require('../src/util');
const R = require('../src/reports');

const OUT = path.join(__dirname, '..', 'demo-output');
fs.rmSync(OUT, { recursive: true, force: true });
const store = open(path.join(OUT, 'data'));

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const poisson = l => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };

const cats = [
  ['طقم سرير', 'BS', 650, 1400], ['لحاف', 'QL', 900, 1900], ['بطانية', 'BL', 450, 1100],
  ['فوطة', 'TW', 60, 220], ['مفرش سفرة', 'TC', 180, 450], ['كوشن', 'CU', 90, 200],
];
const fabrics = ['ساتان', 'قطن مصري', 'ميكروفايبر', 'بوليستر', 'قطيفة'];
const colors = ['أوف وايت', 'بيج', 'رمادي', 'كحلي', 'روز', 'نبيتي', 'أبيض'];
const patterns = ['سادة', 'مشجر', 'جاكار', 'مقلم', 'مطبوع'];
const sizes = ['2 فرد', '1 فرد', 'كينج'];

// ذوق السوق "الحقيقي" في البيانات التجريبية: الساتان والأوف وايت/البيج صاعدين، البوليستر نازل
const fabW = { 'ساتان': 1.6, 'قطن مصري': 1.3, 'ميكروفايبر': 1, 'بوليستر': 0.6, 'قطيفة': 0.9 };
const colW = { 'أوف وايت': 1.5, 'بيج': 1.4, 'رمادي': 1.2, 'كحلي': 0.9, 'روز': 0.8, 'نبيتي': 0.7, 'أبيض': 1 };
const patW = { 'سادة': 1.3, 'جاكار': 1.3, 'مشجر': 0.9, 'مقلم': 0.7, 'مطبوع': 0.8 };
const trend = { 'ساتان': 0.006, 'قطن مصري': 0.003, 'بوليستر': -0.005, 'أوف وايت': 0.004, 'نبيتي': -0.003 };

const items = [];
let n = 1;
for (const [cat, pre, pmin, pmax] of cats) {
  for (let k = 0; k < 7; k++) {
    const f = fabrics[Math.floor(rnd() * fabrics.length)], c = colors[Math.floor(rnd() * colors.length)], p = patterns[Math.floor(rnd() * patterns.length)];
    const s = ['طقم سرير', 'لحاف', 'بطانية'].includes(cat) ? sizes[Math.floor(rnd() * sizes.length)] : '';
    const price = Math.round((pmin + rnd() * (pmax - pmin)) * (f === 'ساتان' || f === 'قطن مصري' ? 1.2 : 1) / 10) * 10;
    const base = (cat === 'فوطة' ? 3 : cat === 'كوشن' ? 2 : 1) * fabW[f] * colW[c] * patW[p] * (0.6 + rnd());
    items.push({ code: `${pre}-${100 + n++}`, name: `${cat} ${f} ${p} ${c}${s ? ' ' + s : ''}`, cat, f, c, p, s, price, base, ret: 0.03 + rnd() * 0.04 });
  }
}
// صنف فيه مشكلة مقاس، وصنف جديد صاعد، وصنف راكد
items[2].ret = 0.22; items[2].reason = 'المقاس صغير';
items.push({ code: 'BS-900', name: 'طقم سرير ساتان جاكار أوف وايت كينج', cat: 'طقم سرير', f: 'ساتان', c: 'أوف وايت', p: 'جاكار', s: 'كينج', price: 1650, base: 1.2, ret: 0.02, launch: 60 });
items[10].base = 0.05;

const customers = ['معرض النور', 'محلات الأمل', 'بيت المفروشات', 'الحرمين للمفروشات', 'معرض العروسة', 'مفروشات الدلتا', 'هوم ستايل', 'السلام للجملة', 'معرض الشروق', 'مفروشات طنطا', 'دار الفرح', 'المنصورة هوم', 'الإسكندرية للمنسوجات', 'بيتي', 'لمسة'];
const end = today(), DAYS = 180;
const reasons = ['عيب خياطة', 'اللون باهت', 'غلط في الطلب', 'مش بيتباع عند العميل', 'الخامة خفيفة'];
let inv = 5000, ret = 1, ord = 1;

for (let d = DAYS; d >= 0; d--) {
  const date = addDays(end, -d);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (dow === 5) continue; // الجمعة إجازة
  const t = DAYS - d;
  const season = 1 + 0.35 * Math.sin((t / DAYS) * Math.PI * 2);
  const nInv = 3 + poisson(3);
  for (let v = 0; v < nInv; v++) {
    const cust = customers[Math.floor(Math.pow(rnd(), 1.6) * customers.length)];
    const lines = [], rlines = [];
    for (const it of items) {
      if (it.launch && t < DAYS - it.launch) continue;
      const tr = 1 + (trend[it.f] || 0) * t + (trend[it.c] || 0) * t + (it.launch ? 0.02 * (t - (DAYS - it.launch)) : 0);
      const q = poisson(Math.max(0, it.base * season * tr * 0.18));
      if (!q) continue;
      lines.push({ item_code: it.code, item_name: it.name, qty: q * 3, price: it.price, total: q * 3 * it.price });
      if (rnd() < it.ret * 3) rlines.push({ item_code: it.code, item_name: it.name, qty: Math.max(1, Math.round(q * 3 * 0.4)), price: it.price, total: 0, reason: it.reason || reasons[Math.floor(rnd() * reasons.length)] });
    }
    if (lines.length) store.saveDoc({ type: 'sale', doc_no: String(inv++), doc_date: date, customer: cust, lines, source: 'demo' });
    const rdate = addDays(date, 3 + Math.floor(rnd() * 10));
    if (rlines.length && rdate <= end) store.saveDoc({ type: 'return', doc_no: `R-${ret++}`, doc_date: rdate, customer: cust, lines: rlines.map(l => ({ ...l, total: l.qty * l.price })), source: 'demo' });
    if (rnd() < 0.35) {
      const ol = lines.slice(0, 4).map(l => ({ ...l, qty: Math.round(l.qty * (1.1 + rnd() * 0.6)) }));
      store.saveDoc({ type: 'order', doc_no: `ORD-${ord++}`, doc_date: addDays(date, -2), customer: cust, lines: ol, source: 'demo' });
    }
  }
}
// جرد مخزون من 20 يوم + بيانات الأصناف
store.saveItems(items.map(i => ({ item_code: i.code, item_name: i.name, category: i.cat, fabric: i.f, color: i.c, pattern: i.p, size: i.s })));
store.saveStock(items.map(i => ({ item_code: i.code, qty: Math.round(i.base * 0.18 * 3 * 33 * (1 + rnd() * 14)) })), addDays(end, -20));

const cfg = { ...config(), ordersDb: '' };
const r = run(store, cfg);
const a = r.analysis;
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const msgs = [
  ['التقرير اليومي', R.dailyMessage(r.period(end, end), a)], ['الملخص', R.summaryMessage(a)], ['أقوى الأصناف', R.topMessage(a)],
  ['المرتجعات', R.returnsMessage(a)], ['ذوق السوق', R.tasteMessage(a)], ['الموديلات', R.modelsMessage(a)], ['التوقع والإنتاج', R.forecastMessage(a)],
  ['كارت صنف', R.itemMessage(a.items[0], a)],
];
fs.writeFileSync(path.join(OUT, 'telegram-messages.txt'), msgs.map(([t, m]) => `===== ${t} =====\n${strip(m)}\n`).join('\n'));
fs.writeFileSync(path.join(OUT, 'dashboard.html'), R.dashboardHtml(a));
fs.writeFileSync(path.join(OUT, 'sales-intelligence.xlsx'), R.excelReport(a));
console.log(strip(R.summaryMessage(a)));
console.log(`\nاتعملت الملفات في: ${OUT}\n  dashboard.html — افتحه في المتصفح\n  sales-intelligence.xlsx\n  telegram-messages.txt — شكل رسايل البوت`);
