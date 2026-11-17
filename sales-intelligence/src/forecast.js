// التنبؤ بالطلب: Holt الخطي مع تخميد الاتجاه + معاملات موسمية شهرية لو التاريخ كفاية
'use strict';

const { mean, std } = require('./util');

// series: كميات أسبوعية مرتبة من الأقدم للأحدث
function holtDamped(series, h = 8) {
  const y = series.map(v => Math.max(0, v));
  const n = y.length;
  if (n === 0) return { forecast: Array(h).fill(0), sigma: 0, method: 'لا يوجد' };
  if (n < 4) {
    const m = mean(y);
    return { forecast: Array(h).fill(m), sigma: Math.max(std(y), Math.sqrt(m)), method: 'متوسط' };
  }
  let best = null;
  const phi = 0.9;
  for (const a of [0.15, 0.3, 0.5, 0.7]) {
    for (const b of [0.05, 0.15, 0.3]) {
      let level = y[0], trend = (y[Math.min(3, n - 1)] - y[0]) / Math.min(3, n - 1);
      let sse = 0, cnt = 0;
      for (let t = 1; t < n; t++) {
        const f = level + phi * trend;
        if (t >= 2) { sse += (y[t] - f) ** 2; cnt++; }
        const nl = a * y[t] + (1 - a) * (level + phi * trend);
        trend = b * (nl - level) + (1 - b) * phi * trend;
        level = nl;
      }
      const rmse = Math.sqrt(sse / Math.max(1, cnt));
      if (!best || rmse < best.rmse) best = { a, b, level, trend, rmse };
    }
  }
  const forecast = [];
  let damp = 0;
  for (let k = 1; k <= h; k++) {
    damp += phi ** k;
    forecast.push(Math.max(0, best.level + damp * best.trend));
  }
  const m = mean(y);
  return { forecast, sigma: Math.max(best.rmse, Math.sqrt(m) * 0.5), method: 'Holt', alpha: best.a, beta: best.b };
}

// معاملات موسمية شهرية من إجمالي المبيعات (محتاج سنة على الأقل)
// monthly: { 'YYYY-MM': qty }
function monthlySeasonality(monthly) {
  const keys = Object.keys(monthly).sort();
  if (keys.length < 13) return null;
  const byMonth = Array.from({ length: 12 }, () => []);
  // نسبة كل شهر لمتوسط الـ 12 شهر حواليه (متوسط متحرك مركزي)
  for (let i = 6; i < keys.length - 5; i++) {
    const win = keys.slice(i - 6, i + 6).map(k => monthly[k]);
    const ma = mean(win);
    if (ma > 0) byMonth[+keys[i].slice(5, 7) - 1].push(monthly[keys[i]] / ma);
  }
  // لو التاريخ أقصر من كده: نسبة لمتوسط كل الفترة
  const overall = mean(keys.map(k => monthly[k])) || 1;
  const idx = byMonth.map((arr, m) => {
    if (arr.length) return mean(arr);
    const same = keys.filter(k => +k.slice(5, 7) - 1 === m).map(k => monthly[k] / overall);
    return same.length ? mean(same) : 1;
  });
  const norm = mean(idx) || 1;
  return idx.map(v => Math.min(2.5, Math.max(0.4, v / norm)));
}

module.exports = { holtDamped, monthlySeasonality };
