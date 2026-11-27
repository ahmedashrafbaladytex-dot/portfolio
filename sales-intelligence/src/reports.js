// التقارير: رسائل تليجرام، لوحة HTML تفاعلية، وملف Excel كامل
'use strict';

const { fmt, pct, signedPct, esc, sum } = require('./util');
const { writeXlsx } = require('./xlsx');
const { CLASS, ATTRS } = require('./analytics');

const money = n => `${fmt(n)} ج`;
const arrow = g => (g == null ? '' : g > 0.05 ? '🔺' : g < -0.05 ? '🔻' : '➖');
const PRIORITY = { urgent: '🔴 عاجل', soon: '🟠 قريب', ok: '🟢 كافي', over: '🔵 زيادة', nostock: '⚪ بدون رصيد' };
const itemLine = i => `${CLASS[i.cls]?.icon || ''} <b>${esc(i.name)}</b>${i.code !== i.name ? ` <code>${esc(i.code)}</code>` : ''}`;

// ---------- التقرير اليومي ----------
function dailyMessage(p, a) {
  const L = [];
  L.push(`📊 <b>التقرير اليومي — ${p.to}</b>`);
  L.push('');
  if (!p.sale_val && !p.ret_val && !p.ord_val) L.push('📭 مفيش فواتير ولا مرتجعات ولا طلبيات اتسجلت في اليوم ده.');
  else {
  L.push(`💰 المبيعات: <b>${money(p.sale_val)}</b> (${fmt(p.sale_qty)} قطعة، ${p.invoices} فاتورة، ${p.customers} عميل) ${p.sale_val && p.vsAvg != null ? `${arrow(p.vsAvg)} ${signedPct(p.vsAvg)} عن المتوسط` : ''}`);
  L.push(`↩️ المرتجعات: <b>${money(p.ret_val)}</b> (${fmt(p.ret_qty)} قطعة، ${p.returns} إذن) ${p.sale_val ? `= ${pct(p.ret_val / p.sale_val)} من المبيعات` : ''}`);
  L.push(`📝 الطلبيات: <b>${money(p.ord_val)}</b> (${fmt(p.ord_qty)} قطعة، ${p.orders} طلبية) ${p.ord_val && p.ordVsAvg != null ? arrow(p.ordVsAvg) + ' ' + signedPct(p.ordVsAvg) : ''}`);
  L.push(`📈 صافي اليوم: <b>${money(p.sale_val - p.ret_val)}</b>`);
  }
  if (p.topItems.length) {
    L.push('', '🏆 <b>الأكثر مبيعاً النهارده</b>');
    p.topItems.forEach((t, i) => L.push(`${i + 1}. ${esc(t.name)} — ${fmt(t.qty)}`));
  }
  if (p.topReturns.length) {
    L.push('', '↩️ <b>أكتر مرتجعات</b>');
    p.topReturns.slice(0, 3).forEach(t => L.push(`• ${esc(t.name)} — ${fmt(t.qty)}`));
  }
  if (p.topOrders.length) {
    L.push('', '📝 <b>أكتر أصناف مطلوبة</b>');
    p.topOrders.slice(0, 3).forEach(t => L.push(`• ${esc(t.name)} — ${fmt(t.qty)}`));
  }
  if (a) {
    const urgent = a.plan.filter(i => i.priority === 'urgent').slice(0, 5);
    if (urgent.length) {
      L.push('', '🚨 <b>هيخلص قبل ما الإنتاج يلحق</b>');
      urgent.forEach(i => L.push(`• ${esc(i.name)} — رصيد ${fmt(i.stock)}، يكفي ${fmt(i.cover)} يوم → أنتج ${fmt(i.produce)}`));
    }
    const probs = a.classes.problem.slice(0, 3);
    if (probs.length) {
      L.push('', '⚠️ <b>أصناف مرتجعاتها عالية</b>');
      probs.forEach(i => L.push(`• ${esc(i.name)} — ${pct(i.return_rate)} (${topReason(i)})`));
    }
  }
  return L.join('\n');
}
const topReason = i => Object.entries(i.reasons || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'غير محدد';

// ---------- ملخص الأسبوع (بيوصل كل أحد الصبح) ----------
function weeklyMessage(p, a) {
  const L = [`🗓️ <b>ملخص الأسبوع</b> (${p.from} ← ${p.to})`, ''];
  const cmp = g => (g == null ? '' : `${arrow(g)} ${signedPct(g)} عن متوسط الأسابيع اللي فاتت`);
  if (!p.sale_val && !p.ret_val && !p.ord_val) L.push('📭 مفيش فواتير ولا مرتجعات ولا طلبيات اتسجلت الأسبوع ده.');
  else {
    L.push('<b>💰 المبيعات</b>');
    L.push(`المبيعات: <b>${money(p.sale_val)}</b> (${fmt(p.sale_qty)} قطعة، ${p.invoices} فاتورة، ${p.customers} عميل) ${p.sale_val ? cmp(p.vsAvg) : ''}`);
    L.push(`المرتجعات: <b>${money(p.ret_val)}</b>${p.sale_val ? ` = ${pct(p.ret_val / p.sale_val)} من المبيعات` : ''}`);
    L.push(`الصافي: <b>${money(p.sale_val - p.ret_val)}</b>`);
    L.push(`الطلبيات الجديدة: ${money(p.ord_val)} (${p.orders} طلبية)`);
    if (p.topItems.length) {
      L.push('', '🏆 <b>الأكثر مبيعاً الأسبوع ده</b>');
      p.topItems.forEach((t, i) => L.push(`${i + 1}. ${esc(t.name)} — ${fmt(t.qty)} قطعة`));
    }
    if (p.topReturns.length) {
      L.push('', '↩️ <b>أكتر أصناف رجعت</b>');
      p.topReturns.slice(0, 3).forEach(t => L.push(`• ${esc(t.name)} — ${fmt(t.qty)} قطعة`));
    }
  }
  if (a) {
    L.push('', '<b>📦 المخزون</b>');
    const urgent = a.plan.filter(i => i.priority === 'urgent'), soon = a.plan.filter(i => i.priority === 'soon');
    if (!urgent.length && !soon.length) L.push('✅ مفيش صنف هيخلص قريب.');
    if (urgent.length) {
      L.push(`🔴 <b>هيخلص قبل ما الإنتاج يلحق (${urgent.length})</b>`);
      urgent.slice(0, 7).forEach(i => L.push(`• ${esc(i.name)} — ${i.stock > 0 ? `باقي ${fmt(i.stock)}، يكفي ${fmt(i.cover)} يوم` : 'خلص'} ← أنتج ${fmt(i.produce)}`));
      if (urgent.length > 7) L.push(`  و${urgent.length - 7} صنف كمان في خطة الإنتاج`);
    }
    if (soon.length) {
      L.push(`🟠 <b>محتاج يدخل الإنتاج قريب (${soon.length})</b>`);
      soon.slice(0, 5).forEach(i => L.push(`• ${esc(i.name)} — باقي ${fmt(i.stock)} ← أنتج ${fmt(i.produce)}`));
    }
    if (a.overstock.length) {
      const val = sum(a.overstock.map(i => (i.stock || 0) * (i.avg_price || 0)));
      L.push(`🔵 <b>بضاعة واقفة (${a.overstock.length} صنف${val ? `، ≈ ${money(val)}` : ''})</b> — صرّفها بعرض`);
      a.overstock.slice(0, 3).forEach(i => L.push(`• ${esc(i.name)} — ${fmt(i.stock)} قطعة`));
    }
  }
  L.push('', '📁 اللوحة الكاملة وملف Excel تحت 👇');
  return L.join('\n');
}

// ---------- ملخص الفترة ----------
function summaryMessage(a) {
  const s = a.summary;
  const L = [];
  L.push(`📈 <b>ملخص آخر ${s.window} يوم</b> (${s.from} ← ${s.asOf})`, '');
  L.push(`💰 المبيعات: <b>${money(s.sale_val)}</b> — ${s.invoices} فاتورة — متوسط الفاتورة ${money(s.avg_invoice)}`);
  L.push(`↩️ المرتجعات: <b>${money(s.ret_val)}</b> — نسبة ${pct(s.return_rate, 1)} من الكميات`);
  L.push(`📈 الصافي: <b>${money(s.net_val)}</b> ${arrow(s.growth)} ${s.growth != null ? signedPct(s.growth) + ' عن الفترة اللي قبلها' : ''}`);
  L.push(`📝 الطلبيات: ${money(s.ord_val)}${s.conversion != null && s.conversion < 0.95 ? ` — اتنفّذ منها ${pct(s.conversion)} بس` : ''}`);
  L.push(`👥 ${s.customers} عميل — أكبر 5 عملاء = ${pct(s.top5Share)} من المبيعات${s.top5Share > 0.6 ? ' ⚠️ تركيز عالي' : ''}`);
  L.push(`🧵 ${s.items_active} صنف شغال`);
  L.push('', '<b>تصنيف الأصناف</b>');
  for (const [k, c] of Object.entries(CLASS)) if (k !== 'normal' && a.classes[k].length) L.push(`${c.icon} ${c.label}: ${a.classes[k].length} — ${esc(a.classes[k].slice(0, 3).map(i => i.name).join('، '))}`);
  return L.join('\n');
}

function topMessage(a, n = 10) {
  const L = [`🏆 <b>أقوى ${n} أصناف</b> (مؤشر القوة من 100)`, ''];
  a.items.filter(i => i.sale_qty > 0).slice(0, n).forEach((i, k) => {
    L.push(`${k + 1}. ${itemLine(i)}`);
    L.push(`   قوة ${i.score} | صافي ${fmt(i.net_qty)} قطعة (${money(i.net_val)}) | ${arrow(i.growth)} ${signedPct(i.growth)} | مرتجع ${pct(i.return_rate)} | ${i.customers} عميل | ${i.abc}${i.xyz}`);
  });
  const slow = a.classes.slow.slice(0, 5);
  if (slow.length) {
    L.push('', '🐢 <b>الأضعف (مرشحين للتوقف/التصفية)</b>');
    slow.forEach(i => L.push(`• ${esc(i.name)} — ${fmt(i.net_qty)} قطعة${i.daysSinceSale != null ? `، آخر بيع من ${i.daysSinceSale} يوم` : ''}${i.stock ? `، رصيد ${fmt(i.stock)}` : ''}`));
  }
  return L.join('\n');
}

function returnsMessage(a) {
  const s = a.summary;
  const L = [`↩️ <b>تحليل المرتجعات</b> — آخر ${s.window} يوم`, '', `الإجمالي ${money(s.ret_val)} = ${pct(s.return_rate, 1)} من الكميات المباعة`, ''];
  if (a.reasons.length) {
    L.push('<b>الأسباب</b>');
    a.reasons.forEach(r => L.push(`• ${esc(r.reason)}: ${fmt(r.qty)} قطعة (${pct(r.share)})`));
  }
  const worst = a.items.filter(i => i.ret_qty > 0).sort((x, y) => y.ret_qty * y.return_rate - x.ret_qty * x.return_rate).slice(0, 8);
  if (worst.length) {
    L.push('', '<b>الأصناف الأكثر ارتجاعاً</b>');
    worst.forEach(i => L.push(`• ${esc(i.name)} — ${fmt(i.ret_qty)} من ${fmt(i.sale_qty)} (${pct(i.return_rate)}) — ${esc(topReason(i))}${i.topReturnCustomer ? ` — أكتر عميل: ${esc(i.topReturnCustomer[0])}` : ''}`));
  }
  const custs = a.customers.filter(c => c.ret_val > 0 && c.sale_val > 0).sort((x, y) => y.return_rate - x.return_rate).slice(0, 5);
  if (custs.length) {
    L.push('', '<b>عملاء نسبة مرتجعاتهم عالية</b>');
    custs.forEach(c => L.push(`• ${esc(c.name)} — ${pct(c.return_rate)} (${money(c.ret_val)} من ${money(c.sale_val)})`));
  }
  // أثر المرتجعات على الخصائص
  const attrRet = [];
  for (const [k, label] of ATTRS) for (const r of a.taste[k]) if (r.sale_qty >= 10 && r.return_rate >= a.settings.returnAlert) attrRet.push(`${label} «${r.value}»: ${pct(r.return_rate)}`);
  if (attrRet.length) L.push('', '<b>خصائص مرتبطة بمرتجعات عالية</b>', ...attrRet.slice(0, 6).map(x => '• ' + esc(x)));
  return L.join('\n');
}

function tasteMessage(a) {
  const L = ['🎨 <b>ذوق السوق</b> — مؤشر الذوق (100 = متوسط)، والنمو آخر 30 يوم', ''];
  for (const [k, label] of ATTRS) {
    const rows = a.taste[k];
    if (!rows.length) continue;
    L.push(`<b>${label}</b>${a.coverage[k] < 0.5 ? ` <i>(معروفة لـ ${pct(a.coverage[k])} من الأصناف بس)</i>` : ''}`);
    rows.slice(0, 5).forEach((r, i) => L.push(`${i + 1}. ${esc(r.value)} — مؤشر ${r.index} | حصة ${pct(r.share)} | ${arrow(r.growth)} ${signedPct(r.growth)} | مرتجع ${pct(r.return_rate)}`));
    const falling = rows.filter(r => r.growth < -0.2 && r.share > 0.05);
    if (falling.length) L.push(`   📉 بيقل الطلب على: ${esc(falling.map(r => r.value).join('، '))}`);
    L.push('');
  }
  return L.join('\n');
}

function modelsMessage(a) {
  const L = ['🧵 <b>موديلات مقترحة حسب ذوق السوق</b>', ''];
  const news = a.proposals.filter(p => p.type === 'new');
  if (!news.length) L.push('محتاج بيانات خصائص أكتر للأصناف (فئة/خامة/لون/نقشة) — ابعت ملف بيانات الأصناف (اكتب «نماذج» تاخد النموذج)');
  news.forEach((p, i) => {
    L.push(`${i + 1}. <b>${esc([p.category, p.fabric, p.color, p.pattern].filter(Boolean).join(' • '))}</b>`);
    L.push(`   شريحة السعر: ${esc(p.price_band || '—')}${p.price_range ? ` (${fmt(p.price_range[0])}–${fmt(p.price_range[1])} ج)` : ''} | طلب متوقع ≈ ${fmt(p.expected_weekly)} قطعة/أسبوع | تجربة مقترحة: ${fmt(Math.max(20, p.expected_weekly * 3))} قطعة`);
  });
  const scale = a.proposals.filter(p => p.type === 'scale');
  if (scale.length) {
    L.push('', '📈 <b>تركيبات موجودة كسبانة — زوّد ألوان/مقاسات منها</b>');
    scale.forEach(p => L.push(`• ${esc([p.category, p.fabric, p.color, p.pattern].filter(Boolean).join(' • '))}`));
  }
  L.push('', '<i>الاقتراح مبني على أقوى خامة × لون × نقشة داخل كل فئة، ومستبعد التركيبات اللي عندك فعلاً.</i>');
  return L.join('\n');
}

function forecastMessage(a, n = 15) {
  const s = a.settings;
  const L = [`🔮 <b>توقع الطلب وخطة الإنتاج</b>`, `<i>مدة الإنتاج ${s.leadTime} يوم، تغطية ${s.coverDays} يوم بعدها، ومخزون أمان 95%</i>`, ''];
  a.plan.slice(0, n).forEach(i => {
    L.push(`${PRIORITY[i.priority]} <b>${esc(i.name)}</b>`);
    L.push(`   متوقع 4 أسابيع: ${fmt(i.forecast4)} | ${i.stock != null ? `رصيد ${fmt(i.stock)} يكفي ${Number.isFinite(i.cover) ? fmt(i.cover) + ' يوم' : '∞'}` : 'مفيش رصيد مسجل'} | <b>أنتج ${fmt(i.produce)}</b>`);
  });
  if (!a.plan.length) L.push('مفيش أصناف محتاجة إنتاج دلوقتي.');
  if (a.overstock.length) {
    L.push('', '🔵 <b>مخزون زيادة / راكد — صرّفه بعروض</b>');
    a.overstock.slice(0, 5).forEach(i => L.push(`• ${esc(i.name)} — رصيد ${fmt(i.stock)}${Number.isFinite(i.cover) ? ` يكفي ${fmt(i.cover)} يوم` : ' ومفيش طلب'} (≈ ${money((i.stock || 0) * i.avg_price)})`));
  }
  if (a.seasons.length) {
    L.push('', '📅 <b>مواسم جاية</b>');
    a.seasons.forEach(e => L.push(`• ${e.name} بعد ${e.daysLeft} يوم${e.uplift ? ` — السنة اللي فاتت المبيعات قبله كانت ×${e.uplift.toFixed(1)}` : ''}\n   ${esc(e.tip)}`));
  }
  return L.join('\n');
}

function itemMessage(i, a) {
  if (!i) return 'الصنف مش موجود. ابعت الكود أو جزء من الاسم.';
  const L = [`${itemLine(i)}`, `${CLASS[i.cls].icon} ${CLASS[i.cls].label} — ${CLASS[i.cls].hint}`, ''];
  L.push(`مؤشر القوة: <b>${i.score}/100</b> | ABC: ${i.abc} | ثبات الطلب: ${i.xyz}`);
  L.push(`الخصائص: ${esc([i.category, i.fabric, i.color, i.pattern, i.size, i.price_band].filter(Boolean).join(' • ') || 'غير معروفة')}`);
  L.push(`آخر ${a.summary.window} يوم: بيع ${fmt(i.sale_qty)} | مرتجع ${fmt(i.ret_qty)} (${pct(i.return_rate)}) | طلبيات ${fmt(i.ord_qty)}`);
  L.push(`الصافي: ${fmt(i.net_qty)} قطعة = ${money(i.net_val)} | متوسط السعر ${money(i.avg_price)}`);
  L.push(`النمو (آخر 30 يوم): ${arrow(i.growth)} ${signedPct(i.growth)} | ${i.customers} عميل | ${i.velocity.toFixed(1)} قطعة/أسبوع`);
  if (i.unmet) L.push(`⚠️ طلب مش متلبّي: ${fmt(i.unmet)} قطعة (الطلبيات أكتر من المبيعات — ممكن مبيعات ضايعة)`);
  if (i.ret_qty) L.push(`أسباب المرتجع: ${esc(Object.entries(i.reasons).sort((x, y) => y[1] - x[1]).map(([r, q]) => `${r} (${fmt(q)})`).join('، '))}`);
  L.push('', `🔮 التوقع (${i.method}): ${i.forecast.slice(0, 4).map(v => fmt(v)).join(' ، ')} قطعة للأسابيع الجاية`);
  L.push(`المخزون: ${i.stock != null ? `${fmt(i.stock)} (من جرد ${i.stockAsOf})، يكفي ${Number.isFinite(i.cover) ? fmt(i.cover) + ' يوم' : '∞'}` : 'غير مسجل'}`);
  L.push(`نقطة إعادة الطلب: ${fmt(i.rop)} | مخزون أمان: ${fmt(i.safety)} | المقترح إنتاجه: <b>${fmt(i.produce)}</b> ${PRIORITY[i.priority]}`);
  L.push(`آخر 12 أسبوع: ${spark(i.weekly)}`);
  return L.join('\n');
}
function spark(arr) {
  const b = '▁▂▃▄▅▆▇█', max = Math.max(...arr, 0);
  return arr.map(v => (max > 0 ? b[Math.max(0, Math.min(7, Math.round((Math.max(0, v) / max) * 7)))] : b[0])).join('');
}

// ---------- بيانات مختصرة لـ Claude ----------
function compactForAI(a) {
  const it = i => ({
    name: i.name, cls: CLASS[i.cls].label, score: i.score, net_qty: Math.round(i.net_qty), net_val: Math.round(i.net_val),
    growth: +i.growth.toFixed(2), return_rate: +i.return_rate.toFixed(2), customers: i.customers, abc: i.abc,
    attrs: [i.category, i.fabric, i.color, i.pattern, i.size, i.price_band].filter(Boolean).join(' / '),
    stock: i.stock, cover_days: Number.isFinite(i.cover) ? Math.round(i.cover) : null, produce: i.produce,
  });
  const t = rows => rows.slice(0, 8).map(r => ({ value: r.value, index: r.index, share: +r.share.toFixed(2), growth: +r.growth.toFixed(2), return_rate: +r.return_rate.toFixed(2), items: r.items }));
  return {
    period: { from: a.summary.from, to: a.summary.asOf, days: a.summary.window },
    summary: { ...a.summary, sale_val: Math.round(a.summary.sale_val), ret_val: Math.round(a.summary.ret_val), net_val: Math.round(a.summary.net_val), ord_val: Math.round(a.summary.ord_val) },
    top_items: a.items.filter(i => i.sale_qty > 0).slice(0, 15).map(it),
    rising: a.classes.rising.slice(0, 6).map(it), slow: a.classes.slow.slice(0, 8).map(it), return_problems: a.classes.problem.slice(0, 8).map(it),
    taste: Object.fromEntries(ATTRS.map(([k]) => [k, t(a.taste[k])])),
    attribute_coverage: a.coverage,
    return_reasons: a.reasons,
    top_customers: a.customers.slice(0, 10).map(c => ({ name: c.name, net_val: Math.round(c.net_val), return_rate: +c.return_rate.toFixed(2), invoices: c.invoices, last: c.last })),
    model_proposals_by_rules: a.proposals,
    production_plan: a.plan.slice(0, 12).map(i => ({ name: i.name, priority: i.priority, forecast_4w: Math.round(i.forecast4), stock: i.stock, produce: i.produce })),
    overstock: a.overstock.slice(0, 8).map(it),
    upcoming_seasons: a.seasons.map(e => ({ name: e.name, days_left: e.daysLeft, last_year_uplift: e.uplift, tip: e.tip })),
    weekly_totals_last16: a.weeklyTotals.map(w => ({ sale_qty: w.sale, ret_qty: w.ret, ord_qty: w.ord, sale_val: Math.round(w.sale_val) })),
  };
}

// ---------- ملف Excel ----------
function excelReport(a) {
  const r = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : '');
  const sheets = [
    {
      name: 'الأصناف', widths: [14, 34, 14, 12, 12, 14, 10, 10, 10, 10, 12, 10, 10, 8, 8, 8, 10, 10, 10, 12, 12],
      rows: [['الكود', 'الصنف', 'الفئة', 'الخامة', 'اللون', 'النقشة', 'المقاس', 'شريحة السعر', 'مؤشر القوة', 'التصنيف', 'مبيعات (قطعة)', 'مرتجع', 'نسبة المرتجع', 'ABC', 'XYZ', 'عملاء', 'طلبيات', 'صافي القيمة', 'النمو 30 يوم', 'قطعة/أسبوع', 'آخر بيع'],
        ...a.items.map(i => [i.code, i.name, i.category, i.fabric, i.color, i.pattern, i.size, i.price_band, i.score, CLASS[i.cls].label, i.sale_qty, i.ret_qty, r(i.return_rate), i.abc, i.xyz, i.customers, i.ord_qty, r(i.net_val), r(i.growth), r(i.velocity), i.lastSale || ''])],
    },
    {
      name: 'خطة الإنتاج', widths: [14, 34, 14, 12, 12, 12, 12, 12, 12, 14],
      rows: [['الكود', 'الصنف', 'الأولوية', 'متوقع 4 أسابيع', 'الرصيد الحالي', 'يكفي (يوم)', 'مخزون أمان', 'نقطة إعادة الطلب', 'المقترح إنتاجه', 'تاريخ النفاد'],
        ...a.plan.map(i => [i.code, i.name, PRIORITY[i.priority].replace(/^\S+\s/, ''), r(i.forecast4), i.stock ?? '', Number.isFinite(i.cover) ? Math.round(i.cover) : '', Math.round(i.safety), Math.round(i.rop), i.produce, i.stockoutDate || ''])],
    },
    {
      name: 'ذوق السوق', widths: [16, 22, 12, 10, 10, 12, 10, 26],
      rows: [['الخاصية', 'القيمة', 'مؤشر الذوق', 'الحصة', 'النمو', 'نسبة المرتجع', 'عدد الموديلات', 'أقوى موديل'],
        ...ATTRS.flatMap(([k, label]) => a.taste[k].map(t => [label, t.value, t.index, r(t.share), r(t.growth), r(t.return_rate), t.items, t.best?.name || '']))],
    },
    {
      name: 'موديلات مقترحة', widths: [10, 16, 14, 14, 16, 14, 14],
      rows: [['النوع', 'الفئة', 'الخامة', 'اللون', 'النقشة', 'شريحة السعر', 'طلب متوقع/أسبوع'],
        ...a.proposals.map(p => [p.type === 'new' ? 'جديد' : 'توسيع', p.category, p.fabric, p.color, p.pattern, p.price_band, r(p.expected_weekly)])],
    },
    {
      name: 'المرتجعات', widths: [30, 12, 10],
      rows: [['السبب', 'الكمية', 'النسبة'], ...a.reasons.map(x => [x.reason, x.qty, r(x.share)])],
    },
    {
      name: 'العملاء', widths: [26, 14, 14, 14, 12, 10, 10, 12],
      rows: [['العميل', 'المبيعات', 'المرتجعات', 'الصافي', 'نسبة المرتجع', 'فواتير', 'أصناف', 'آخر شراء'],
        ...a.customers.map(c => [c.name, r(c.sale_val), r(c.ret_val), r(c.net_val), r(c.return_rate), c.invoices, c.items, c.last || ''])],
    },
  ];
  return writeXlsx(sheets);
}

// ---------- لوحة HTML ----------
function dashboardHtml(a, insights = '') {
  const s = a.summary;
  const bars = (rows, valueKey, labelKey, fmtFn = v => fmt(v)) => {
    const max = Math.max(...rows.map(r => Math.abs(r[valueKey])), 1);
    return `<div class="bars">${rows.map(r => `<div class="bar-row"><span class="bl">${esc(r[labelKey])}</span><span class="bt"><span class="bf" style="width:${(Math.abs(r[valueKey]) / max * 100).toFixed(1)}%"></span></span><span class="bv">${fmtFn(r[valueKey])}</span></div>`).join('')}</div>`;
  };
  const wk = a.weeklyTotals;
  const maxW = Math.max(...wk.map(w => w.sale), 1);
  const W = 640, H = 180, step = W / Math.max(1, wk.length);
  // الزمن من اليمين للشمال: أقدم أسبوع يمين وأحدث أسبوع شمال
  const chart = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart" role="img" aria-label="المبيعات والمرتجعات الأسبوعية">
    ${wk.map((w, i) => {
      const x = W - (i + 1) * step, hs = (w.sale / maxW) * (H - 4), hr = (w.ret / maxW) * (H - 4);
      return `<rect x="${x + step * 0.38}" y="${H - hs}" width="${step * 0.47}" height="${hs}" rx="2" class="s"><title>مبيعات ${fmt(w.sale)} قطعة</title></rect><rect x="${x + step * 0.12}" y="${H - hr}" width="${step * 0.22}" height="${hr}" rx="2" class="r"><title>مرتجع ${fmt(w.ret)} قطعة</title></rect>`;
    }).join('')}
    <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="ax"/>
  </svg><div class="axis"><span>قبل ${wk.length} أسبوع</span><span>الأسبوع الحالي</span></div>`;
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="kl">${label}</div><div class="kv">${value}</div><div class="ks">${sub}</div></div>`;
  const tr = cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
  const table = (head, rows) => `<div class="tw"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const clsBadge = i => `<span class="badge c-${i.cls}">${CLASS[i.cls].icon} ${CLASS[i.cls].label}</span>`;

  const tasteBlocks = ATTRS.filter(([k]) => a.taste[k].length).map(([k, label]) => `<div class="card"><h3>${label}</h3>${bars(a.taste[k].slice(0, 8), 'index', 'value', v => v)}<p class="note">مؤشر 100 = متوسط. بيجمع الحصة والنمو وقلة المرتجع.</p></div>`).join('');

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة ذكاء المبيعات — ${s.asOf}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2530;--mute:#667085;--line:#e4e7ec;--acc:#1f4e79;--acc2:#d97706;--good:#15803d;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f141a;--card:#18202a;--ink:#e6eaf0;--mute:#98a2b3;--line:#2a3441;--acc:#6aa7e0;--acc2:#f0a64a;--good:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "Segoe UI",Tahoma,"Noto Sans Arabic",sans-serif}
header{background:var(--acc);color:#fff;padding:20px 16px}header h1{margin:0;font-size:22px}header p{margin:4px 0 0;opacity:.85}
main{max-width:1200px;margin:0 auto;padding:16px}h2{font-size:18px;margin:28px 0 10px;border-inline-start:4px solid var(--acc2);padding-inline-start:8px}
h3{margin:0 0 8px;font-size:15px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.grid2{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.kpi,.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.kl{color:var(--mute);font-size:13px}.kv{font-size:22px;font-weight:700}.ks{font-size:12px;color:var(--mute)}
.bars{display:flex;flex-direction:column;gap:6px}.bar-row{display:grid;grid-template-columns:minmax(80px,38%) 1fr 56px;gap:8px;align-items:center;font-size:13px}
.bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{background:var(--line);border-radius:4px;height:12px;overflow:hidden}.bf{display:block;height:100%;background:var(--acc)}.bv{text-align:left;font-variant-numeric:tabular-nums}
.chart{width:100%;height:220px;display:block}.axis{display:flex;justify-content:space-between;font-size:12px;color:var(--mute);margin-top:4px}.chart .s{fill:var(--acc)}.chart .r{fill:var(--acc2)}.chart .ax{stroke:var(--line)}
.legend{font-size:13px;color:var(--mute)}.dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-inline:4px 2px}
.tw{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th{background:var(--bg);position:sticky;top:0}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;background:var(--line)}.c-star{background:#fef3c7;color:#92400e}.c-problem{background:#fee4e2;color:#b42318}.c-slow{background:#e4e7ec;color:#475467}.c-rising{background:#dcfce7;color:#166534}.c-cash{background:#dbeafe;color:#1e40af}
.up{color:var(--good)}.down{color:var(--bad)}.note{font-size:12px;color:var(--mute);margin:8px 0 0}
.insights{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.p-urgent{color:var(--bad);font-weight:700}.p-soon{color:var(--acc2);font-weight:700}
input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);margin-bottom:8px;font:inherit}
</style></head><body>
<header><h1>لوحة ذكاء المبيعات وذوق السوق</h1><p>آخر ${s.window} يوم: ${s.from} ← ${s.asOf}</p></header>
<main>
<div class="grid">
${kpi('المبيعات', money(s.sale_val), `${s.invoices} فاتورة • ${fmt(s.sale_qty)} قطعة`)}
${kpi('المرتجعات', money(s.ret_val), `${pct(s.return_rate, 1)} من الكميات`)}
${kpi('الصافي', money(s.net_val), s.growth != null ? `<span class="${s.growth >= 0 ? 'up' : 'down'}">${signedPct(s.growth)}</span> عن الفترة اللي قبلها` : '')}
${kpi('الطلبيات', money(s.ord_val), `${s.orders} طلبية`)}
${kpi('العملاء', fmt(s.customers), `أكبر 5 = ${pct(s.top5Share)}`)}
${kpi('الأصناف الشغالة', fmt(s.items_active), `${a.classes.star.length} نجم • ${a.classes.slow.length} راكد`)}
</div>

<h2>الحركة الأسبوعية</h2>
<div class="card">${chart}<div class="legend"><span class="dot" style="background:var(--acc)"></span>مبيعات (قطعة) <span class="dot" style="background:var(--acc2)"></span>مرتجعات</div></div>

${insights ? `<h2>🧠 التحليل الاستراتيجي</h2><div class="insights">${esc(insights)}</div>` : ''}

<h2>تصنيف وقوة الأصناف</h2>
<input id="q" placeholder="ابحث باسم أو كود الصنف..." oninput="filt(this.value)">
${table(['الصنف', 'التصنيف', 'القوة', 'صافي قطعة', 'صافي قيمة', 'النمو', 'مرتجع', 'عملاء', 'ABC/XYZ', 'الخصائص'], a.items.map(i => `<tr data-k="${esc((i.name + ' ' + i.code).toLowerCase())}"><td>${esc(i.name)}</td><td>${clsBadge(i)}</td><td>${i.score}</td><td>${fmt(i.net_qty)}</td><td>${fmt(i.net_val)}</td><td class="${i.growth >= 0 ? 'up' : 'down'}">${signedPct(i.growth)}</td><td>${pct(i.return_rate)}</td><td>${i.customers}</td><td>${i.abc}${i.xyz}</td><td>${esc([i.category, i.fabric, i.color, i.pattern, i.size].filter(Boolean).join(' • '))}</td></tr>`))}
<p class="note">القوة = سرعة البيع 35% + النمو 20% + قلة المرتجع 20% + عدد العملاء 15% + الطلب في الطلبيات 10%. ABC: A = الأصناف اللي بتعمل 80% من القيمة. XYZ: X = طلب ثابت، Z = متذبذب.</p>

<h2>🎨 ذوق السوق</h2>
<div class="grid2">${tasteBlocks}</div>

<h2>🧵 موديلات مقترحة</h2>
${table(['النوع', 'الفئة', 'الخامة', 'اللون', 'النقشة', 'شريحة السعر', 'طلب متوقع/أسبوع'], a.proposals.map(p => tr([p.type === 'new' ? '✨ جديد' : '📈 توسيع', esc(p.category), esc(p.fabric), esc(p.color), esc(p.pattern), esc(p.price_band) + (p.price_range ? ` (${fmt(p.price_range[0])}–${fmt(p.price_range[1])})` : ''), fmt(p.expected_weekly)])))}

<h2>🔮 خطة الإنتاج</h2>
${table(['الأولوية', 'الصنف', 'متوقع 4 أسابيع', 'الرصيد', 'يكفي (يوم)', 'نقطة إعادة الطلب', 'أنتج'], a.plan.slice(0, 40).map(i => tr([`<span class="p-${i.priority}">${PRIORITY[i.priority]}</span>`, esc(i.name), fmt(i.forecast4), i.stock ?? '—', Number.isFinite(i.cover) ? fmt(i.cover) : '—', fmt(i.rop), `<b>${fmt(i.produce)}</b>`])))}

<div class="grid2" style="margin-top:12px">
<div class="card"><h3>↩️ أسباب المرتجعات</h3>${a.reasons.length ? bars(a.reasons, 'qty', 'reason') : '<p class="note">مفيش مرتجعات</p>'}</div>
<div class="card"><h3>👥 أكبر العملاء (صافي)</h3>${bars(a.customers.slice(0, 10), 'net_val', 'name')}</div>
</div>

${a.seasons.length ? `<h2>📅 مواسم جاية</h2><div class="grid2">${a.seasons.map(e => `<div class="card"><h3>${esc(e.name)} — بعد ${e.daysLeft} يوم</h3><p>${esc(e.tip)}</p>${e.uplift ? `<p class="note">السنة اللي فاتت: المبيعات قبله ×${e.uplift.toFixed(1)} من العادي</p>` : ''}</div>`).join('')}</div>` : ''}
<p class="note">اتعمل تلقائياً من فواتير المبيعات والمرتجعات والطلبيات المبعوتة على جروب تليجرام.</p>
</main>
<script>function filt(v){v=v.trim().toLowerCase();document.querySelectorAll('tr[data-k]').forEach(r=>r.style.display=!v||r.dataset.k.includes(v)?'':'none')}</script>
</body></html>`;
}

module.exports = { dailyMessage, weeklyMessage, summaryMessage, topMessage, returnsMessage, tasteMessage, modelsMessage, forecastMessage, itemMessage, compactForAI, excelReport, dashboardHtml, money };
