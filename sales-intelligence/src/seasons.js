// مواسم السوق المصري (التواريخ الهجرية تقريبية ±يوم)
'use strict';

const { addDays, daysBetween } = require('./util');

const HIJRI = {
  2026: { ramadan: '2026-02-18', fitr: '2026-03-20', adha: '2026-05-27' },
  2027: { ramadan: '2027-02-08', fitr: '2027-03-10', adha: '2027-05-16' },
  2028: { ramadan: '2028-01-28', fitr: '2028-02-26', adha: '2028-05-05' },
  2029: { ramadan: '2029-01-16', fitr: '2029-02-14', adha: '2029-04-24' },
  2030: { ramadan: '2030-01-06', fitr: '2030-02-04', adha: '2030-04-13' },
};

function eventsFor(year) {
  const h = HIJRI[year] || {};
  const ev = [
    h.ramadan && { key: 'ramadan', name: 'رمضان', date: h.ramadan, tip: 'مفارش سفرة، أطقم سرير لاستقبال الضيوف، ألوان دافية ونقوش إسلامية/فوانيس' },
    h.fitr && { key: 'fitr', name: 'عيد الفطر', date: h.fitr, tip: 'تجديد البيت قبل العيد: أطقم سرير وفوط وكوشن، الطلب بيبدأ من نص رمضان' },
    h.adha && { key: 'adha', name: 'عيد الأضحى', date: h.adha, tip: 'ذروة تجهيز العرايس وموسم الصيف — أطقم كاملة وألوان فاتحة' },
    { key: 'summer', name: 'موسم الأفراح والصيف', date: `${year}-06-15`, tip: 'جهاز العرايس: أطقم فاخرة (ساتان/قطن مصري)، ألوان أوف وايت وبيج ورمادي، خامات خفيفة' },
    { key: 'school', name: 'دخول المدارس', date: `${year}-09-20`, tip: 'أطقم سرير أطفال وسنجل برسومات، أسعار اقتصادية' },
    { key: 'winter', name: 'بداية الشتا', date: `${year}-11-01`, tip: 'بطاطين، لحاف، فلانيل وقطيفة، ألوان غامقة (نبيتي/كحلي/بني)' },
    { key: 'blackfriday', name: 'الجمعة البيضاء / عروض نهاية السنة', date: `${year}-11-27`, tip: 'تصريف الراكد بخصومات قبل ما يتقادم' },
  ];
  return ev.filter(Boolean);
}

// المواسم اللي جاية خلال N يوم
function upcoming(asOf, withinDays = 70) {
  const y = +asOf.slice(0, 4);
  return [...eventsFor(y), ...eventsFor(y + 1)]
    .map(e => ({ ...e, daysLeft: daysBetween(asOf, e.date) }))
    .filter(e => e.daysLeft >= 0 && e.daysLeft <= withinDays)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// نفس الموسم السنة اللي فاتت: نسبة المبيعات في الـ 21 يوم قبل الموسم لمتوسط الفترة العادية
function lastYearUplift(event, dailyNet) {
  const y = +event.date.slice(0, 4) - 1;
  const prev = eventsFor(y).find(e => e.key === event.key);
  if (!prev) return null;
  const before = [], base = [];
  for (let i = -21; i < 0; i++) before.push(dailyNet[addDays(prev.date, i)] || 0);
  for (let i = -90; i < -30; i++) base.push(dailyNet[addDays(prev.date, i)] || 0);
  const b = base.reduce((a, c) => a + c, 0) / base.length;
  const s = before.reduce((a, c) => a + c, 0) / before.length;
  if (!b || base.every(v => !v)) return null;
  return s / b;
}

module.exports = { upcoming, lastYearUplift, eventsFor };
