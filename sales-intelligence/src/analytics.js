// محرك التحليل: حركة الأصناف، قوتها، المرتجعات، ذوق السوق، التنبؤ، وخطة الإنتاج
'use strict';

const { addDays, daysBetween, sum, mean, std, quantile, today } = require('./util');
const { classifyReason } = require('./attributes');
const { holtDamped, monthlySeasonality } = require('./forecast');
const seasons = require('./seasons');

const ATTRS = [
  ['category', 'الفئة'], ['fabric', 'الخامة'], ['color', 'اللون'],
  ['pattern', 'النقشة / التصميم'], ['size', 'المقاس'], ['price_band', 'شريحة السعر'],
];
const CLASS = {
  star: { label: 'نجم', icon: '⭐', hint: 'قوي وبيكبر — أولوية إنتاج وتسويق' },
  cash: { label: 'حصان رابح', icon: '💪', hint: 'مبيعات ثابتة وعالية — حافظ على توفّره' },
  rising: { label: 'صاعد', icon: '🚀', hint: 'لسه صغير بس بيكبر بسرعة — زوّد تدريجياً' },
  problem: { label: 'مشكلة مرتجعات', icon: '⚠️', hint: 'مرتجعاته عالية — راجع الجودة/المقاس قبل ما تنتج تاني' },
  slow: { label: 'راكد', icon: '🐢', hint: 'حركته ضعيفة — وقف إنتاجه وصرّف الموجود' },
  normal: { label: 'عادي', icon: '▫️', hint: '' },
};

function percentRank(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return v => {
    if (sorted.length <= 1) return 0.5;
    let lo = 0;
    while (lo < sorted.length && sorted[lo] < v) lo++;
    let hi = lo;
    while (hi < sorted.length && sorted[hi] === v) hi++;
    return ((lo + hi - 1) / 2) / (sorted.length - 1);
  };
}

/**
 * opts: { asOf, window (يوم), leadTimeDays, coverDays, serviceZ, returnAlert }
 */
function analyze({ lines, items, stock }, opts = {}) {
  const window = opts.window || 90;
  const leadTime = opts.leadTimeDays ?? 14;
  const coverDays = opts.coverDays ?? 30;
  const z = opts.serviceZ ?? 1.65;
  const returnAlert = opts.returnAlert ?? 0.1;
  const lastDate = lines.length ? lines[lines.length - 1].date : today();
  const asOf = opts.asOf || (lastDate < today() ? lastDate : today());
  const from = addDays(asOf, -window + 1);
  const prevFrom = addDays(from, -window);
  const d30 = addDays(asOf, -29), d60 = addDays(asOf, -59);
  const itemMap = new Map(items.map(i => [i.code, i]));
  const stockMap = new Map(stock.map(s => [s.item_code, s]));
  const WEEKS = 52;

  // ---------- تجميع لكل صنف ----------
  const per = new Map();
  const get = code => {
    if (!per.has(code)) {
      per.set(code, {
        code, sale_qty: 0, sale_val: 0, ret_qty: 0, ret_val: 0, ord_qty: 0, ord_val: 0,
        prev_net_val: 0, last30: 0, prev30: 0, customers: new Set(), invoices: new Set(),
        weekly: Array(WEEKS).fill(0), first: null, lastSale: null, reasons: {}, retCustomers: {},
        afterStockSales: 0,
      });
    }
    return per.get(code);
  };
  const daily = {}; // صافي الكمية اليومي (للمواسم)
  const monthly = {};
  const totals = { sale_val: 0, sale_qty: 0, ret_val: 0, ret_qty: 0, ord_val: 0, ord_qty: 0, invoices: new Set(), retDocs: new Set(), orderDocs: new Set(), customers: new Set() };
  const prevTotals = { sale_val: 0, ret_val: 0, ord_val: 0 };
  const cust = new Map();
  const reasonTotals = {};
  const weeklyTotals = Array(WEEKS).fill(null).map(() => ({ sale: 0, ret: 0, ord: 0, sale_val: 0 }));

  for (const l of lines) {
    const p = get(l.code);
    const sign = l.type === 'sale' ? 1 : l.type === 'return' ? -1 : 0;
    const val = l.total || l.qty * l.price;
    if (l.type !== 'order') {
      daily[l.date] = (daily[l.date] || 0) + sign * l.qty;
      const mk = l.date.slice(0, 7);
      monthly[mk] = (monthly[mk] || 0) + sign * l.qty;
      if (!p.first || l.date < p.first) p.first = l.date;
    }
    const wk = Math.floor(daysBetween(l.date, asOf) / 7);
    if (wk >= 0 && wk < WEEKS) {
      const wi = WEEKS - 1 - wk;
      if (sign) p.weekly[wi] += sign * l.qty;
      const wt = weeklyTotals[wi];
      if (l.type === 'sale') { wt.sale += l.qty; wt.sale_val += val; } else if (l.type === 'return') wt.ret += l.qty; else wt.ord += l.qty;
    }
    const st = stockMap.get(l.code);
    if (st && l.date > st.as_of && l.date <= asOf) p.afterStockSales += sign * l.qty;
    if (l.type === 'sale' && (!p.lastSale || l.date > p.lastSale)) p.lastSale = l.date;

    if (l.date >= d30 && l.date <= asOf) p.last30 += sign * l.qty;
    else if (l.date >= d60 && l.date < d30) p.prev30 += sign * l.qty;

    if (l.date >= prevFrom && l.date < from) {
      p.prev_net_val += sign * val;
      if (l.type === 'sale') prevTotals.sale_val += val; else if (l.type === 'return') prevTotals.ret_val += val; else prevTotals.ord_val += val;
    }
    if (l.date < from || l.date > asOf) continue;

    // داخل فترة التحليل
    const c = l.customer || 'بدون اسم';
    if (!cust.has(c)) cust.set(c, { name: c, sale_val: 0, ret_val: 0, ord_val: 0, sale_qty: 0, ret_qty: 0, invoices: new Set(), items: new Set(), last: null });
    const cu = cust.get(c);
    if (l.type === 'sale') {
      p.sale_qty += l.qty; p.sale_val += val; p.customers.add(c); p.invoices.add(l.doc_no);
      totals.sale_val += val; totals.sale_qty += l.qty; totals.invoices.add(l.doc_no); totals.customers.add(c);
      cu.sale_val += val; cu.sale_qty += l.qty; cu.invoices.add(l.doc_no); cu.items.add(l.code);
      if (!cu.last || l.date > cu.last) cu.last = l.date;
    } else if (l.type === 'return') {
      p.ret_qty += l.qty; p.ret_val += val;
      const r = classifyReason(l.reason);
      p.reasons[r] = (p.reasons[r] || 0) + l.qty;
      p.retCustomers[c] = (p.retCustomers[c] || 0) + l.qty;
      reasonTotals[r] = (reasonTotals[r] || 0) + l.qty;
      totals.ret_val += val; totals.ret_qty += l.qty; totals.retDocs.add(l.doc_no);
      cu.ret_val += val; cu.ret_qty += l.qty;
    } else {
      p.ord_qty += l.qty; p.ord_val += val;
      totals.ord_val += val; totals.ord_qty += l.qty; totals.orderDocs.add(l.doc_no);
      cu.ord_val += val;
    }
  }

  // ---------- الموسمية ----------
  const season = monthlySeasonality(monthly);
  const weekMonth = wi => +addDays(asOf, -(WEEKS - 1 - wi) * 7).slice(5, 7) - 1;
  const futureMonth = k => +addDays(asOf, k * 7).slice(5, 7) - 1;

  // ---------- مقاييس الصنف ----------
  const weeksInWindow = window / 7;
  const list = [...per.values()].filter(p => p.sale_qty + p.ret_qty + p.ord_qty > 0 || stockMap.has(p.code)).map(p => {
    const it = itemMap.get(p.code) || { name: p.code };
    const net_qty = p.sale_qty - p.ret_qty;
    const net_val = p.sale_val - p.ret_val;
    const return_rate = p.sale_qty ? p.ret_qty / p.sale_qty : (p.ret_qty ? 1 : 0);
    const growth = p.prev30 > 0 ? (p.last30 - p.prev30) / p.prev30 : (p.last30 > 0 ? 1 : 0);
    const isNew = p.first && daysBetween(p.first, asOf) < 45;
    const recent = p.weekly.slice(-12);
    const m = mean(recent);
    const cv = m > 0 ? std(recent) / m : null;

    // تاريخ الصنف من أول ظهور فقط
    const firstIdx = p.first ? Math.max(0, WEEKS - 1 - Math.floor(daysBetween(p.first, asOf) / 7)) : WEEKS - 1;
    let hist = p.weekly.slice(firstIdx);
    let fc;
    if (season && hist.length >= 4) {
      const ds = hist.map((v, i) => v / season[weekMonth(firstIdx + i)]);
      const r = holtDamped(ds, 8);
      fc = { ...r, forecast: r.forecast.map((v, k) => v * season[futureMonth(k + 1)]), method: 'Holt + موسمية' };
    } else fc = holtDamped(hist, 8);

    const weekly4 = sum(fc.forecast.slice(0, 4));
    const perDay = fc.forecast[0] / 7;
    const ltDemand = (sum(fc.forecast) / 56) * leadTime;
    const safety = z * fc.sigma * Math.sqrt(leadTime / 7);
    const st = stockMap.get(p.code);
    const current = st ? Math.max(0, st.qty - p.afterStockSales) : null;
    const horizonDemand = (sum(fc.forecast) / 56) * (leadTime + coverDays);
    let produce, priority, cover = null, stockoutDate = null;
    if (current != null) {
      cover = perDay > 0 ? current / perDay : Infinity;
      stockoutDate = Number.isFinite(cover) ? addDays(asOf, Math.floor(cover)) : null;
      produce = Math.max(0, Math.ceil(horizonDemand + safety - current));
      priority = current <= ltDemand ? 'urgent' : current <= ltDemand + safety ? 'soon' : cover > 120 ? 'over' : 'ok';
    } else {
      produce = Math.ceil(horizonDemand + safety);
      priority = 'nostock';
    }

    return {
      code: p.code, name: it.name || p.code,
      category: it.category || '', fabric: it.fabric || '', color: it.color || '', pattern: it.pattern || '', size: it.size || '',
      sale_qty: p.sale_qty, sale_val: p.sale_val, ret_qty: p.ret_qty, ret_val: p.ret_val, ord_qty: p.ord_qty,
      net_qty, net_val, prev_net_val: p.prev_net_val, return_rate, growth, isNew, last30: p.last30, prev30: p.prev30,
      avg_price: p.sale_qty ? p.sale_val / p.sale_qty : 0,
      velocity: net_qty / weeksInWindow, customers: p.customers.size, invoices: p.invoices.size,
      conversion: p.ord_qty ? Math.min(1, p.sale_qty / p.ord_qty) : null,
      unmet: Math.max(0, p.ord_qty - p.sale_qty),
      cv, lastSale: p.lastSale, daysSinceSale: p.lastSale ? daysBetween(p.lastSale, asOf) : null,
      weekly: p.weekly.slice(-12),
      reasons: p.reasons, topReturnCustomer: Object.entries(p.retCustomers).sort((a, b) => b[1] - a[1])[0] || null,
      forecast: fc.forecast, forecast4: weekly4, sigma: fc.sigma, method: fc.method,
      stock: current, stockAsOf: st?.as_of || null, cover, stockoutDate, safety, rop: ltDemand + safety, produce, priority,
    };
  });

  // ---------- ABC / XYZ ----------
  const byVal = [...list].sort((a, b) => b.net_val - a.net_val);
  const totalNet = sum(byVal.map(i => Math.max(0, i.net_val))) || 1;
  let cum = 0;
  for (const i of byVal) {
    cum += Math.max(0, i.net_val);
    const share = cum / totalNet;
    i.abc = i.net_val <= 0 ? 'C' : share <= 0.8 || i === byVal[0] ? 'A' : share <= 0.95 ? 'B' : 'C';
    i.share = Math.max(0, i.net_val) / totalNet;
    i.xyz = i.cv == null ? 'Z' : i.cv < 0.5 ? 'X' : i.cv < 1 ? 'Y' : 'Z';
  }

  // ---------- مؤشر القوة (0-100) ----------
  const active = list.filter(i => i.sale_qty > 0);
  const prV = percentRank(active.map(i => i.velocity));
  const prG = percentRank(active.map(i => i.growth));
  const prR = percentRank(active.map(i => -i.return_rate));
  const prC = percentRank(active.map(i => i.customers));
  const prO = percentRank(active.map(i => i.ord_qty));
  const velMedian = quantile(active.map(i => i.velocity).sort((a, b) => a - b), 0.5);
  const velLow = quantile(active.map(i => i.velocity).sort((a, b) => a - b), 0.2);
  for (const i of list) {
    if (i.sale_qty <= 0) { i.score = 0; i.cls = i.ord_qty > 0 ? 'rising' : 'slow'; continue; }
    i.score = Math.round(100 * (0.35 * prV(i.velocity) + 0.2 * prG(i.growth) + 0.2 * prR(-i.return_rate) + 0.15 * prC(i.customers) + 0.1 * prO(i.ord_qty)));
    if (i.return_rate >= returnAlert && i.ret_qty >= 3) i.cls = 'problem';
    else if (i.score >= 70 && i.growth >= 0) i.cls = 'star';
    else if (i.score >= 55) i.cls = 'cash';
    else if (i.growth >= 0.25 && i.velocity <= velMedian && i.last30 !== 0) i.cls = 'rising';
    else if ((i.daysSinceSale != null && i.daysSinceSale > 45) || (i.velocity <= velLow && i.growth <= 0)) i.cls = 'slow';
    else i.cls = 'normal';
  }

  // ---------- شرائح السعر ----------
  const prices = active.map(i => i.avg_price).filter(v => v > 0).sort((a, b) => a - b);
  const q1 = quantile(prices, 0.25), q2 = quantile(prices, 0.5), q3 = quantile(prices, 0.75);
  const band = p => !p ? '' : p <= q1 ? 'اقتصادي' : p <= q2 ? 'متوسط' : p <= q3 ? 'فوق المتوسط' : 'بريميوم';
  for (const i of list) i.price_band = band(i.avg_price);
  const bandRanges = { 'اقتصادي': [prices[0], q1], 'متوسط': [q1, q2], 'فوق المتوسط': [q2, q3], 'بريميوم': [q3, prices[prices.length - 1]] };

  // ---------- ذوق السوق حسب كل خاصية ----------
  const tasteOf = (subset, attr) => {
    const g = new Map();
    for (const i of subset) {
      const v = i[attr];
      if (!v) continue;
      if (!g.has(v)) g.set(v, { value: v, net_val: 0, net_qty: 0, sale_qty: 0, ret_qty: 0, last30: 0, prev30: 0, items: 0, best: null });
      const x = g.get(v);
      x.net_val += i.net_val; x.net_qty += i.net_qty; x.sale_qty += i.sale_qty; x.ret_qty += i.ret_qty; x.items++;
      const p = per.get(i.code);
      x.last30 += p.last30; x.prev30 += p.prev30;
      if (!x.best || i.net_val > x.best.net_val) x.best = i;
    }
    const rows = [...g.values()];
    const tot = sum(rows.map(r => Math.max(0, r.net_val))) || 1;
    const avgShare = 1 / Math.max(1, rows.length);
    for (const r of rows) {
      r.share = Math.max(0, r.net_val) / tot;
      r.growth = r.prev30 > 0 ? (r.last30 - r.prev30) / r.prev30 : (r.last30 > 0 ? 1 : 0);
      r.return_rate = r.sale_qty ? r.ret_qty / r.sale_qty : 0;
      r.per_item = r.net_qty / r.items; // إنتاجية الموديل الواحد
      r.index = Math.round(100 * (r.share / avgShare) ** 0.6 * (1 + Math.max(-0.5, Math.min(1, r.growth)) * 0.5) * (1 - Math.min(0.6, r.return_rate)));
      r.best = r.best && { code: r.best.code, name: r.best.name };
    }
    return rows.sort((a, b) => b.index - a.index);
  };
  const taste = {};
  for (const [a] of ATTRS) taste[a] = tasteOf(list, a);
  const coverage = {};
  for (const [a] of ATTRS) coverage[a] = list.length ? list.filter(i => i[a]).length / list.length : 0;

  // ---------- اقتراح موديلات جديدة ----------
  const proposals = [];
  const topCats = taste.category.slice(0, 3);
  for (const cat of topCats) {
    const sub = list.filter(i => i.category === cat.value);
    const t = { fabric: tasteOf(sub, 'fabric'), color: tasteOf(sub, 'color'), pattern: tasteOf(sub, 'pattern'), price_band: tasteOf(sub, 'price_band') };
    const pickTop = (a, n) => (t[a].length ? t[a] : taste[a]).slice(0, n);
    const fabrics = pickTop('fabric', 3), colors = pickTop('color', 4), patterns = pickTop('pattern', 3);
    const bandBest = pickTop('price_band', 1)[0];
    const catVelocity = sub.length ? mean(sub.filter(i => i.sale_qty > 0).map(i => i.velocity)) : 0;
    const combos = [];
    for (const f of fabrics.length ? fabrics : [null]) for (const c of colors.length ? colors : [null]) for (const p of patterns.length ? patterns : [null]) {
      const score = (f ? f.index : 100) * (c ? c.index : 100) * (p ? p.index : 100) / 1e4;
      const exists = sub.some(i => (!f || i.fabric === f.value) && (!c || i.color === c.value) && (!p || i.pattern === p.value));
      const rr = mean([f, c, p].filter(Boolean).map(x => x.return_rate));
      combos.push({ category: cat.value, fabric: f?.value || '', color: c?.value || '', pattern: p?.value || '', score, exists, return_rate: rr });
    }
    combos.sort((a, b) => b.score - a.score);
    const fresh = combos.filter(c => !c.exists).slice(0, 2);
    for (const c of fresh) {
      const factor = Math.max(0.6, Math.min(1.8, c.score / 100));
      proposals.push({ ...c, price_band: bandBest?.value || '', price_range: bandBest ? bandRanges[bandBest.value] : null, expected_weekly: catVelocity * factor, type: 'new' });
    }
    const scale = combos.filter(c => c.exists).slice(0, 1);
    for (const c of scale) proposals.push({ ...c, price_band: bandBest?.value || '', price_range: bandBest ? bandRanges[bandBest.value] : null, expected_weekly: catVelocity * Math.max(0.6, Math.min(1.8, c.score / 100)), type: 'scale' });
  }
  proposals.sort((a, b) => (a.type === b.type ? b.score - a.score : a.type === 'new' ? -1 : 1));

  // ---------- العملاء ----------
  const customers = [...cust.values()].map(c => ({
    name: c.name, sale_val: c.sale_val, ret_val: c.ret_val, net_val: c.sale_val - c.ret_val, ord_val: c.ord_val,
    return_rate: c.sale_val ? c.ret_val / c.sale_val : 0, invoices: c.invoices.size, items: c.items.size, last: c.last,
  })).sort((a, b) => b.net_val - a.net_val);
  const custTotal = sum(customers.map(c => Math.max(0, c.net_val))) || 1;
  const top5Share = sum(customers.slice(0, 5).map(c => Math.max(0, c.net_val))) / custTotal;

  // ---------- ملخص ----------
  const net_val = totals.sale_val - totals.ret_val;
  const prevNet = prevTotals.sale_val - prevTotals.ret_val;
  const summary = {
    asOf, from, window,
    sale_val: totals.sale_val, sale_qty: totals.sale_qty, ret_val: totals.ret_val, ret_qty: totals.ret_qty,
    ord_val: totals.ord_val, ord_qty: totals.ord_qty, net_val,
    invoices: totals.invoices.size, returns: totals.retDocs.size, orders: totals.orderDocs.size, customers: totals.customers.size,
    return_rate: totals.sale_qty ? totals.ret_qty / totals.sale_qty : 0,
    growth: prevNet > 0 ? (net_val - prevNet) / prevNet : null,
    avg_invoice: totals.invoices.size ? totals.sale_val / totals.invoices.size : 0,
    items_active: active.length, top5Share,
    conversion: totals.ord_qty ? Math.min(1, totals.sale_qty / totals.ord_qty) : null,
    seasonality: !!season,
  };

  const reasons = Object.entries(reasonTotals).map(([reason, qty]) => ({ reason, qty, share: qty / (totals.ret_qty || 1) })).sort((a, b) => b.qty - a.qty);
  const classes = Object.fromEntries(Object.keys(CLASS).map(k => [k, list.filter(i => i.cls === k).sort((a, b) => b.score - a.score)]));
  const plan = list.filter(i => i.sale_qty > 0 && i.cls !== 'slow' && i.cls !== 'problem' && i.produce > 0)
    .sort((a, b) => ({ urgent: 0, soon: 1, nostock: 2, ok: 3, over: 4 }[a.priority] - { urgent: 0, soon: 1, nostock: 2, ok: 3, over: 4 }[b.priority]) || b.score - a.score);
  const overstock = list.filter(i => i.priority === 'over' || (i.cls === 'slow' && i.stock > 0)).sort((a, b) => (b.stock || 0) * b.avg_price - (a.stock || 0) * a.avg_price);

  const up = seasons.upcoming(asOf, 75).map(e => ({ ...e, uplift: seasons.lastYearUplift(e, daily) }));

  return {
    summary, items: list.sort((a, b) => b.score - a.score), classes, abc: byVal, taste, coverage, proposals,
    customers, reasons, plan, overstock, seasons: up, weeklyTotals: weeklyTotals.slice(-16), bandRanges, CLASS, ATTRS,
    settings: { leadTime, coverDays, z, returnAlert },
  };
}

// ملخص فترة قصيرة (تقرير يومي) مع مقارنة بمتوسط الأيام اللي قبلها
function periodSummary(lines, from, to, items) {
  const name = new Map(items.map(i => [i.code, i.name]));
  const len = daysBetween(from, to) + 1;
  const base = { from: addDays(from, -28), to: addDays(from, -1) };
  const agg = (a, b) => {
    const r = { sale_val: 0, sale_qty: 0, ret_val: 0, ret_qty: 0, ord_val: 0, ord_qty: 0, invoices: new Set(), retDocs: new Set(), orders: new Set(), customers: new Set(), items: {}, retItems: {}, ordItems: {} };
    for (const l of lines) {
      if (l.date < a || l.date > b) continue;
      const v = l.total || l.qty * l.price;
      if (l.type === 'sale') { r.sale_val += v; r.sale_qty += l.qty; r.invoices.add(l.doc_no); r.customers.add(l.customer); r.items[l.code] = (r.items[l.code] || 0) + l.qty; }
      else if (l.type === 'return') { r.ret_val += v; r.ret_qty += l.qty; r.retDocs.add(l.doc_no); r.retItems[l.code] = (r.retItems[l.code] || 0) + l.qty; }
      else { r.ord_val += v; r.ord_qty += l.qty; r.orders.add(l.doc_no); r.ordItems[l.code] = (r.ordItems[l.code] || 0) + l.qty; }
    }
    return r;
  };
  const cur = agg(from, to), prev = agg(base.from, base.to);
  const scale = len / 28;
  const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([code, qty]) => ({ code, name: name.get(code) || code, qty }));
  return {
    from, to,
    sale_val: cur.sale_val, sale_qty: cur.sale_qty, ret_val: cur.ret_val, ret_qty: cur.ret_qty, ord_val: cur.ord_val, ord_qty: cur.ord_qty,
    invoices: cur.invoices.size, returns: cur.retDocs.size, orders: cur.orders.size, customers: cur.customers.size,
    vsAvg: prev.sale_val ? cur.sale_val / (prev.sale_val * scale) - 1 : null,
    retVsAvg: prev.ret_val ? cur.ret_val / (prev.ret_val * scale) - 1 : null,
    ordVsAvg: prev.ord_val ? cur.ord_val / (prev.ord_val * scale) - 1 : null,
    topItems: top(cur.items), topReturns: top(cur.retItems), topOrders: top(cur.ordItems),
  };
}

module.exports = { analyze, periodSummary, CLASS, ATTRS };
