// بوت تليجرام لنظام الطلبات - بدون مكتبات خارجية
'use strict';

const ICON = { new: '🔵', in_progress: '🟡', ready: '🟣', delivered: '🟢', cancelled: '⚪' };
const BTN = { late: '⏰ المتأخر', soon: '📅 قرب ميعاده', summary: '📊 ملخص النهارده', new: '➕ طلب جديد', customers: '👥 العملاء', help: '❓ مساعدة' };
const MAX_LEN = 3900;

const h = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n = v => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const arDigits = s => String(s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const addDays = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const fmtDate = d => { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${+dd}/${+m}/${y}`; };

// "فوطة قطن 50×100 - 200 متر - 45"  →  { product, quantity, unit, price }
function parseItem(line) {
  const parts = arDigits(line).split(/\s*[|\-–—]\s*/).map(p => p.trim()).filter(Boolean);
  const qtyRe = /^(\d+(?:[.,]\d+)?)\s*(\D.*)?$/;
  const numRe = /^\d+(?:[.,]\d+)?$/;
  const toNum = s => Number(s.replace(',', '.'));
  if (parts.length >= 3 && numRe.test(parts.at(-1)) && qtyRe.test(parts.at(-2))) {
    const [, q, unit] = parts.at(-2).match(qtyRe);
    return { product: parts.slice(0, -2).join(' - '), quantity: toNum(q), unit: (unit || '').trim() || 'قطعة', price: toNum(parts.at(-1)) };
  }
  if (parts.length >= 2 && qtyRe.test(parts.at(-1))) {
    const [, q, unit] = parts.at(-1).match(qtyRe);
    return { product: parts.slice(0, -1).join(' - '), quantity: toNum(q), unit: (unit || '').trim() || 'قطعة', price: 0 };
  }
  return null;
}

// "25/11" أو "25/11/2026" أو "2026-11-25" أو "10" (بعد 10 أيام)
function parseDate(text, today) {
  const t = arDigits(text).trim();
  let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = t.match(/^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?$/))) {
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (y < 100) y += 2000;
    let d = iso(y, +m[2], +m[1]);
    if (d && !m[3] && d < today) d = iso(y + 1, +m[2], +m[1]);
    return d;
  }
  if ((m = t.match(/^(\d{1,3})$/))) return addDays(today, +m[1]);
  return null;
}
function iso(y, mo, d) {
  const x = new Date(Date.UTC(y, mo - 1, d));
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== mo - 1 || x.getUTCDate() !== d) return null;
  return x.toISOString().slice(0, 10);
}

function chunk(text) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > MAX_LEN) { out.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

// access: { has(id), list(), add(id), linkCode() } — مين مسموحله يستخدم البوت
function staticAccess(ids) {
  const set = new Set(String(ids || '').split(/[,\s]+/).filter(Boolean));
  return { has: id => set.has(String(id)), list: () => [...set], add: id => set.add(String(id)), linkCode: () => null };
}

function createBot({ token, allowedIds, access, dailyHour, publicUrl = '', core, call, download, intake, log = console }) {
  access ||= staticAccess(allowedIds);
  const controller = new AbortController();
  let timer = null;
  const hour = Number.isFinite(Number(dailyHour)) && String(dailyHour ?? '') !== '' ? Number(dailyHour) : 9;
  const S = core.STATUS_AR;
  const sessions = new Map(); // حالة "طلب جديد" لكل محادثة
  let offset = 0, running = false;

  call ||= async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: controller.signal,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  };

  download ||= async fileId => {
    const f = await call('getFile', { file_id: fileId });
    const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: controller.signal });
    if (!r.ok) throw new Error('download failed');
    return Buffer.from(await r.arrayBuffer());
  };
  let me = null;
  const getMe = async () => (me ||= await call('getMe', {}));

  const keyboard = { keyboard: [[{ text: BTN.late }, { text: BTN.soon }], [{ text: BTN.summary }, { text: BTN.new }], [{ text: BTN.customers }, { text: BTN.help }]], resize_keyboard: true, is_persistent: true };

  async function say(chat, text, extra = {}) {
    const parts = chunk(text);
    for (let i = 0; i < parts.length; i++) {
      await call('sendMessage', { chat_id: chat, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true,
        ...(i === parts.length - 1 ? extra : {}), ...(i === parts.length - 1 && !extra.reply_markup ? { reply_markup: keyboard } : {}) });
    }
  }

  // ---------- تنسيق الرسائل ----------
  const orderLine = o => {
    const tag = o.days_late > 0 ? `🔴 متأخر ${o.days_late} يوم` : `${ICON[o.status]} ${S[o.status]}`;
    return `• <code>${h(o.code)}</code> ${o.priority === 'urgent' ? '🔥' : ''}— ${h(o.customer_name)}\n   ${tag} · تسليم ${fmtDate(o.due_date)} · /o${o.id}`;
  };

  function orderText(o) {
    const late = o.days_late > 0 ? `\n🔴 <b>متأخر ${o.days_late} يوم</b>` : '';
    return [
      `📦 <b>طلب <code>${h(o.code)}</code></b>${o.priority === 'urgent' ? ' 🔥 عاجل' : ''}`,
      `👤 ${h(o.customer_name)} (<code>${h(o.customer_code)}</code>)${o.customer_phone ? ' · ' + h(o.customer_phone) : ''} · /c${o.customer_id}`,
      `الحالة: ${ICON[o.status]} <b>${S[o.status]}</b>${late}`,
      `📅 الطلب: ${fmtDate(o.order_date)} · التسليم: <b>${fmtDate(o.due_date)}</b>${o.delivered_date ? ` · اتسلم: ${fmtDate(o.delivered_date)}` : ''}`,
      '',
      '<b>الأصناف:</b>',
      ...o.items.map((i, k) => `${k + 1}. ${h(i.product)} — ${n(i.quantity)} ${h(i.unit)}${i.price ? ` × ${n(i.price)} = ${n(i.quantity * i.price)}` : ''}`),
      '',
      `💰 الإجمالي: <b>${n(o.total)}</b> · المدفوع: ${n(o.paid)} · المتبقي: <b>${n(o.total - o.paid)}</b> ج`,
      o.notes ? `📝 ${h(o.notes)}` : '',
      publicUrl ? `\n🔗 ${publicUrl}/#/orders/${o.id}` : '',
    ].filter(x => x !== '').join('\n');
  }
  const statusButtons = o => ({
    inline_keyboard: [
      Object.keys(S).filter(k => k !== o.status && k !== 'cancelled').map(k => ({ text: `${ICON[k]} ${S[k]}`, callback_data: `st:${o.id}:${k}` })),
      o.status !== 'cancelled' ? [{ text: '⚪ إلغاء الطلب', callback_data: `st:${o.id}:cancelled` }] : [],
    ].filter(r => r.length),
  });

  function customerText(c) {
    const lines = [
      `👤 <b>${h(c.name)}</b> (<code>${h(c.code)}</code>)${c.phone ? '\n📞 ' + h(c.phone) : ''}`,
      '',
      `📦 عدد الطلبات: <b>${c.orders_count}</b>`,
      `🟡 مفتوحة: ${c.open_count} · 🔴 متأخرة: ${c.late_count} · 🟢 اتسلمت: ${c.delivered_count}`,
      `💰 إجمالي القيمة: ${n(c.total_value)} ج · المتبقي عليه: <b>${n(c.total_value - c.total_paid)}</b> ج`,
    ];
    if (c.orders.length) {
      lines.push('', '<b>أكواد الطلبات:</b>');
      for (const o of [...c.orders].reverse()) {
        const icon = o.days_late > 0 ? '🔴' : ICON[o.status];
        lines.push(`${icon} <code>${h(o.code)}</code> — ${o.days_late > 0 ? `متأخر ${o.days_late} يوم` : S[o.status]} · /o${o.id}`);
      }
    }
    if (c.invoices_count || c.returns_count) {
      lines.push('', `🧾 الفواتير: <b>${c.invoices_count}</b> بقيمة ${n(c.sales_total)} ج · ↩️ المرتجعات: <b>${c.returns_count}</b> بقيمة ${n(c.returns_total)} ج`,
        `📊 صافي المبيعات: <b>${n(c.sales_total - c.returns_total)}</b> ج`);
      for (const v of [...(c.invoices || []), ...(c.returns || [])].sort((a, b) => a.id - b.id))
        lines.push(`${v.kind === 'sale' ? '🧾' : '↩️'} <code>${h(v.code)}</code>${v.ref_number ? ` (ورقة ${h(v.ref_number)})` : ''} — ${n(v.total)} ج · ${fmtDate(v.invoice_date)} · /i${v.id}`);
    }
    if (publicUrl) lines.push('', `🔗 ${publicUrl}/#/customers/${c.id}`);
    return lines.join('\n');
  }

  function invoiceText(v) {
    const label = v.kind === 'sale' ? '🧾 فاتورة' : '↩️ مرتجع';
    return [
      `<b>${label} <code>${h(v.code)}</code></b>${v.ref_number ? ` · رقم الورقة: ${h(v.ref_number)}` : ''}`,
      `👤 ${h(v.customer_name)} (<code>${h(v.customer_code)}</code>) · /c${v.customer_id}`,
      `📅 ${fmtDate(v.invoice_date)}${v.order_code ? ` · الطلب: <code>${h(v.order_code)}</code> /o${v.order_id}` : ''}${v.original_code ? ` · الفاتورة الأصلية: <code>${h(v.original_code)}</code> /i${v.original_invoice_id}` : ''}`,
      '', '<b>الأصناف:</b>',
      ...v.items.map((i, k) => `${k + 1}. ${h(i.product)} — ${n(i.quantity)} ${h(i.unit)}${i.price ? ` × ${n(i.price)} = ${n(i.quantity * i.price)}` : ''}`),
      '', `💰 الإجمالي: <b>${n(v.total)}</b> ج`,
      v.review_note ? `\n⚠️ <b>محتاج مراجعة:</b> ${h(v.review_note)}` : '',
      publicUrl ? `\n🔗 ${publicUrl}/#/invoices/${v.id}` : '',
    ].filter(x => x !== '').join('\n');
  }

  function lateText() {
    const rows = core.listOrders({ late: '1' });
    if (!rows.length) return '👏 مفيش ولا طلب متأخر.';
    return `⏰ <b>الطلبات المتأخرة: ${rows.length}</b>\n\n` + rows.map(orderLine).join('\n');
  }
  function soonText() {
    const rows = core.listOrders({ due_soon: '1' }).sort((a, b) => a.due_date.localeCompare(b.due_date));
    if (!rows.length) return '📅 مفيش طلبات تسليمها خلال ٣ أيام.';
    return `📅 <b>تسليمها خلال ٣ أيام: ${rows.length}</b>\n\n` + rows.map(orderLine).join('\n');
  }
  function summaryText() {
    const d = core.dashboard(), c = d.counts;
    return [
      `📊 <b>ملخص ${fmtDate(d.today)}</b>`, '',
      `🔴 متأخرة: <b>${c.late || 0}</b>`,
      `📅 تسليمها خلال ٣ أيام: <b>${c.due_soon || 0}</b>`,
      `📦 طلبات مفتوحة: <b>${c.open || 0}</b>`,
      `➕ اتسجلت النهارده: ${c.created_today || 0} · 🟢 اتسلمت النهارده: ${c.delivered_today || 0}`,
      `🗓 طلبات الشهر ده: ${c.this_month || 0} · بقيمة ${n(d.month_value)} ج`,
      `👥 العملاء: ${d.customers}`,
      d.month_sales || d.month_returns ? `🧾 مبيعات الشهر: ${n(d.month_sales)} ج · ↩️ مرتجعات: ${n(d.month_returns)} ج` : '',
      d.review ? `⚠️ محتاج مراجعة: <b>${d.review}</b>${publicUrl ? ` · ${publicUrl}/#/review` : ''}` : '',
      d.topLate.length ? '\n<b>عملاء عندهم متأخر:</b>\n' + d.topLate.map(x => `• ${h(x.name)}: ${x.n} متأخر · /c${x.id}`).join('\n') : '',
    ].filter(x => x !== '').join('\n');
  }
  function customersText() {
    const list = core.listCustomers({}).sort((a, b) => b.orders_count - a.orders_count);
    if (!list.length) return 'لسه مفيش عملاء. ابدأ بـ ' + BTN.new;
    return `👥 <b>العملاء (${list.length})</b>\n\n` + list.map(c =>
      `• ${h(c.name)} — ${c.orders_count} طلب${c.late_count ? ` · 🔴 ${c.late_count} متأخر` : ''} · /c${c.id}`).join('\n') +
      '\n\nاكتب اسم أي عميل أو كوده عشان تشوف طلباته.';
  }
  const helpText = () => [
    '👋 <b>بوت نظام الطلبات</b>', '',
    'استخدم الأزرار اللي تحت، أو:',
    '• اكتب <b>اسم عميل</b> أو <b>كوده</b> ← يجيبلك عدد طلباته وأكوادها',
    '• اكتب <b>كود طلب</b> (زي ORD-2026-0001) ← تفاصيله وتغيير حالته',
    '• /late المتأخر · /soon قرب ميعاده · /today الملخص',
    '• /new طلب جديد · /customers العملاء · /cancel إلغاء العملية',
    '', `⏰ كل يوم الساعة ${hour}:00 هبعتلك تقرير بالمتأخر واللي قرب ميعاده.`,
    publicUrl ? `\n🔗 السيستم: ${publicUrl}` : '',
  ].join('\n');

  // ---------- طلب جديد (خطوة بخطوة) ----------
  const cancelBtn = { text: '❌ إلغاء', callback_data: 'new:cancel' };

  async function startNew(chat) {
    sessions.set(chat, { step: 'customer' });
    await say(chat, '➕ <b>طلب جديد</b>\n\n1️⃣ اكتب <b>اسم العميل</b> أو كوده:', { reply_markup: { inline_keyboard: [[cancelBtn]] } });
  }

  async function askItems(chat, s) {
    s.step = 'items';
    await say(chat, `👤 العميل: <b>${h(s.customer.name)}</b>\n\n2️⃣ اكتب <b>الأصناف</b>، كل صنف في سطر:\n<code>الصنف - الكمية - السعر</code>\n\nمثال:\n<code>فوطة قطن 50×100 - 200 - 45\nقماش ستائر - 80 متر - 85</code>\n\n(السعر اختياري)`,
      { reply_markup: { inline_keyboard: [[cancelBtn]] } });
  }

  async function askDue(chat, s) {
    s.step = 'due';
    const t = core.today();
    const total = s.items.reduce((a, i) => a + i.quantity * i.price, 0);
    await say(chat, `✅ ${s.items.length} صنف · الإجمالي ${n(total)} ج\n\n3️⃣ <b>ميعاد التسليم</b>؟ اختار أو اكتب التاريخ (مثلاً 25/11):`, {
      reply_markup: { inline_keyboard: [
        [{ text: 'بعد ٣ أيام', callback_data: 'due:' + addDays(t, 3) }, { text: 'أسبوع', callback_data: 'due:' + addDays(t, 7) }],
        [{ text: 'أسبوعين', callback_data: 'due:' + addDays(t, 14) }, { text: 'شهر', callback_data: 'due:' + addDays(t, 30) }],
        [cancelBtn]] },
    });
  }

  async function askConfirm(chat, s) {
    s.step = 'confirm';
    const total = s.items.reduce((a, i) => a + i.quantity * i.price, 0);
    await say(chat, ['📋 <b>راجع الطلب:</b>', '', `👤 ${h(s.customer.name)}`,
      ...s.items.map((i, k) => `${k + 1}. ${h(i.product)} — ${n(i.quantity)} ${h(i.unit)}${i.price ? ` × ${n(i.price)}` : ''}`),
      `💰 الإجمالي: ${n(total)} ج`, `📅 التسليم: ${fmtDate(s.due)}`].join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '✅ حفظ', callback_data: 'new:save' }, { text: '🔥 حفظ كعاجل', callback_data: 'new:urgent' }], [cancelBtn]] },
    });
  }

  async function wizardText(chat, s, text) {
    if (s.step === 'customer') {
      const q = text.trim();
      const all = core.listCustomers({ search: q });
      const exact = all.find(c => c.code.toLowerCase() === q.toLowerCase() || c.name === q);
      if (exact || all.length === 1) { s.customer = exact || all[0]; return askItems(chat, s); }
      s.pendingName = q.slice(0, 150);
      const rows = all.slice(0, 8).map(c => [{ text: `${c.name} (${c.code})`, callback_data: 'cust:' + c.id }]);
      rows.push([{ text: `➕ عميل جديد: ${q.slice(0, 40)}`, callback_data: 'cust:new' }], [cancelBtn]);
      return say(chat, all.length ? 'لقيت أكتر من عميل، اختار:' : `مفيش عميل بالاسم ده. أضيفه كعميل جديد؟`, { reply_markup: { inline_keyboard: rows } });
    }
    if (s.step === 'items') {
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const items = [], bad = [];
      for (const l of lines) { const it = parseItem(l); it && it.product && it.quantity > 0 ? items.push(it) : bad.push(l); }
      if (bad.length || !items.length) {
        return say(chat, `⚠️ مش قادر أفهم السطر ده:\n<code>${h(bad[0] || text)}</code>\n\nاكتب كل صنف كده:\n<code>الصنف - الكمية - السعر</code>`);
      }
      s.items = items;
      return askDue(chat, s);
    }
    if (s.step === 'due') {
      const d = parseDate(text, core.today());
      if (!d) return say(chat, '⚠️ اكتب التاريخ كده: <code>25/11</code> أو <code>25/11/2026</code>، أو عدد الأيام زي <code>10</code>');
      if (d < core.today()) return say(chat, '⚠️ التاريخ ده فات. اكتب تاريخ جاي.');
      s.due = d;
      return askConfirm(chat, s);
    }
    return say(chat, 'استخدم الأزرار اللي فوق عشان تحفظ أو تلغي.');
  }

  // ---------- استقبال الرسائل ----------
  function authorizedChat(from, chat) {
    if (access.has(String(from.id))) return true;
    const msg = `⛔ البوت ده خاص.\n\nعشان تربطه بحسابك: افتح السيستم ← <b>الإعدادات</b> ← <b>ربط تليجرام</b>، ودوس على زرار الربط.`;
    call('sendMessage', { chat_id: chat, text: msg, parse_mode: 'HTML' }).catch(e => log.error(e.message));
    return false;
  }

  async function onMessage(m) {
    const chat = m.chat.id;
    if (!m.from) return;
    if (m.chat.type === 'group' || m.chat.type === 'supergroup') return onGroupMessage(m);
    if (m.chat.type === 'channel') return;
    const text = (m.text || '').trim();
    if (!text) return;
    const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
    const arg = text.slice(text.split(/\s+/)[0].length).trim();
    const s = sessions.get(chat);

    // ربط الحساب باللينك اللي في صفحة الإعدادات: /start <كود>
    const code = access.linkCode();
    if (cmd === '/start' && arg && code && arg === code) {
      access.add(String(m.from.id));
      return say(chat, '✅ <b>تم ربط حسابك بالسيستم!</b>\n\n' + helpText());
    }
    if (!authorizedChat(m.from, chat)) return;

    if (cmd === '/cancel' || text === 'إلغاء' || text === 'الغاء') { sessions.delete(chat); return say(chat, '❌ اتلغت.'); }
    if (cmd === '/start' || cmd === '/help' || text === BTN.help) { sessions.delete(chat); return say(chat, helpText()); }
    if (cmd === '/late' || text === BTN.late) { sessions.delete(chat); return say(chat, lateText()); }
    if (cmd === '/soon' || text === BTN.soon) { sessions.delete(chat); return say(chat, soonText()); }
    if (cmd === '/today' || text === BTN.summary) { sessions.delete(chat); return say(chat, summaryText()); }
    if (cmd === '/customers' || text === BTN.customers) { sessions.delete(chat); return say(chat, customersText()); }
    if (cmd === '/new' || text === BTN.new) return startNew(chat);

    let mm;
    if ((mm = cmd.match(/^\/o(\d+)$/))) return showOrder(chat, Number(mm[1]));
    if ((mm = cmd.match(/^\/c(\d+)$/))) return showCustomer(chat, Number(mm[1]));
    if ((mm = cmd.match(/^\/i(\d+)$/))) return showInvoice(chat, Number(mm[1]));
    if (cmd === '/order' && arg) return searchText(chat, arg);
    if (cmd === '/customer' && arg) return searchText(chat, arg);
    if (cmd.startsWith('/')) return say(chat, 'أمر مش معروف. ' + BTN.help);

    if (s) return wizardText(chat, s, text);
    return searchText(chat, text);
  }

  async function showOrder(chat, id) {
    let o; try { o = core.getOrder(id); } catch { return say(chat, 'الطلب ده مش موجود.'); }
    return say(chat, orderText(o), { reply_markup: statusButtons(o) });
  }
  async function showCustomer(chat, id) {
    let c; try { c = core.getCustomer(id); } catch { return say(chat, 'العميل ده مش موجود.'); }
    return say(chat, customerText(c));
  }

  async function showInvoice(chat, id) {
    let v; try { v = core.getInvoice(id); } catch { return say(chat, 'الفاتورة دي مش موجودة.'); }
    return say(chat, invoiceText(v));
  }

  async function searchText(chat, q) {
    q = arDigits(q).trim();
    const code = q.toUpperCase().replace(/\s+/g, '');
    if (/^(INV|RET)-/.test(code)) {
      const v = core.findInvoice(code);
      return v ? say(chat, invoiceText(v)) : say(chat, `مفيش فاتورة بالكود ${h(code)}`);
    }
    const o = core.getOrderByCode(code) || (/^\d{1,4}$/.test(code) ? core.getOrderByCode(`ORD-${core.today().slice(0, 4)}-${code.padStart(4, '0')}`) : null);
    if (o) return say(chat, orderText(o), { reply_markup: statusButtons(o) });
    const cs = core.listCustomers({ search: q });
    const exact = cs.find(c => c.code.toLowerCase() === q.toLowerCase() || c.name === q);
    if (exact || cs.length === 1) return showCustomer(chat, (exact || cs[0]).id);
    if (cs.length) return say(chat, `لقيت ${cs.length} عميل:\n\n` + cs.slice(0, 30).map(c => `• ${h(c.name)} (<code>${h(c.code)}</code>) — ${c.orders_count} طلب · /c${c.id}`).join('\n'));
    const orders = core.listOrders({ search: q }).slice(0, 15);
    if (orders.length) return say(chat, `🔎 طلبات فيها "${h(q)}":\n\n` + orders.map(orderLine).join('\n'));
    return say(chat, `مش لاقي حاجة باسم "${h(q)}".\nجرب اسم العميل أو كوده، أو كود الطلب.`);
  }

  // ---------- الجروبات: الطلبات / الفواتير / المرتجعات ----------
  const GROUP_AR = { orders: '📦 الطلبات', invoices: '🧾 الفواتير', returns: '↩️ المرتجعات' };
  const albums = new Map();
  const reply = (m, text, extra = {}) => call('sendMessage', { chat_id: m.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true }, ...extra });

  async function onGroupMessage(m) {
    if (m.from.is_bot) return;
    const chat = m.chat.id;
    const bot = await getMe().catch(() => null);
    if (bot && (m.new_chat_members || []).some(u => u.id === bot.id)) {
      return call('sendMessage', { chat_id: chat, parse_mode: 'HTML', text:
        '👋 أهلاً! عشان أشتغل في الجروب ده:\n\n1️⃣ خليني <b>أدمن</b> في الجروب (عشان أقدر أقرا الرسايل والصور).\n2️⃣ صاحب السيستم يكتب هنا <code>/setup</code> ويختار نوع الجروب.' });
    }
    const text = (m.text || '').trim();
    const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
    if (cmd === '/setup') {
      if (!access.has(String(m.from.id))) return reply(m, '⛔ الأمر ده لصاحب السيستم بس. اربط حسابك الأول من صفحة الإعدادات.');
      let warn = '';
      try {
        const member = await call('getChatMember', { chat_id: chat, user_id: bot.id });
        if (member.status !== 'administrator') warn = '\n\n⚠️ <b>لسه مش أدمن</b>: من إعدادات الجروب خليني أدمن، وإلا مش هشوف الرسايل.';
      } catch { /* ignore */ }
      return reply(m, `الجروب ده هيستقبل إيه؟${warn}`, { reply_markup: { inline_keyboard: [
        [{ text: GROUP_AR.orders, callback_data: 'setup:orders' }],
        [{ text: GROUP_AR.invoices, callback_data: 'setup:invoices' }],
        [{ text: GROUP_AR.returns, callback_data: 'setup:returns' }],
        [{ text: '🚫 مش هيستقبل حاجة', callback_data: 'setup:off' }]] } });
    }
    const group = core.groups.get(chat);
    if (!group || cmd.startsWith('/')) return;
    if (m.media_group_id) {
      const key = `${chat}:${m.media_group_id}`;
      const a = albums.get(key) || { msgs: [] };
      a.msgs.push(m);
      clearTimeout(a.timer);
      a.timer = setTimeout(() => { albums.delete(key); processGroup(group, a.msgs).catch(e => log.error('Group:', e.message)); }, 2500);
      albums.set(key, a);
      return;
    }
    return processGroup(group, [m]);
  }

  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  async function processGroup(group, msgs) {
    const first = msgs[0];
    const text = msgs.map(x => x.text || '').filter(Boolean).join('\n');
    const caption = msgs.map(x => x.caption || '').filter(Boolean).join('\n');
    const files = [], attachments = [];
    for (const x of msgs) {
      let fileId = null, mediaType = null;
      if (x.photo?.length) { fileId = x.photo.at(-1).file_id; mediaType = 'image/jpeg'; }
      else if (x.document) {
        const t = x.document.mime_type || '';
        if (IMAGE_TYPES.includes(t) || t === 'application/pdf') { fileId = x.document.file_id; mediaType = t; }
        else if (t.startsWith('image/')) return reply(first, '⚠️ نوع الصورة ده مش مدعوم. ابعتها كـ <b>صورة</b> عادية مش كملف.');
        if (x.document.file_size > 15e6) return reply(first, '⚠️ الملف كبير جدًا (أكتر من 15 ميجا).');
      }
      if (!fileId) continue;
      const data = await download(fileId);
      files.push({ data, mediaType });
      attachments.push(core.saveUpload(data, { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'png', 'application/pdf': 'pdf' }[mediaType]));
    }
    if (!text && !files.length) return;
    call('sendChatAction', { chat_id: first.chat.id, action: 'typing' }).catch(() => {});
    const r = await intake({ group: group.kind, text, caption, files, attachments });
    if (r.status === 'ignored') return;
    if (r.status === 'failed') return reply(first, '⚠️ ' + h(r.message));
    const kindKey = r.entity === 'order' ? 'o' : 'i';
    await reply(first, recordText(r), { reply_markup: { inline_keyboard: [[
      { text: '↩️ تراجع (اتسجل غلط)', callback_data: `undo:${kindKey}:${r.record.id}:${first.from.id}` }]] } });
    if (r.review.length) {
      const note = `⚠️ <b>محتاج مراجعة</b> (من جروب ${GROUP_AR[group.kind]})\n\n` + recordText(r);
      for (const id of access.list()) await say(id, note).catch(e => log.error('Notify:', e.message));
    }
  }

  function recordText(r) {
    const x = r.record;
    const head = r.entity === 'order' ? `✅ <b>اتسجل طلب <code>${h(x.code)}</code></b>`
      : `✅ <b>اتسجل ${r.kind === 'sale' ? 'فاتورة' : 'مرتجع'} <code>${h(x.code)}</code></b>${x.ref_number ? ` (رقم الورقة ${h(x.ref_number)})` : ''}`;
    const lines = [head, `👤 ${h(x.customer_name)} (<code>${h(x.customer_code)}</code>)${r.newCustomer ? ' 🆕' : ''}`];
    for (const [k, i] of x.items.entries()) lines.push(`${k + 1}. ${h(i.product)} — ${n(i.quantity)} ${h(i.unit)}${i.price ? ` × ${n(i.price)}` : ''}`);
    if (x.total) lines.push(`💰 الإجمالي: <b>${n(x.total)}</b> ج`);
    if (r.entity === 'order') lines.push(`📅 التسليم: ${fmtDate(x.due_date)}`);
    else {
      lines.push(`📅 ${fmtDate(x.invoice_date)}`);
      if (x.order_code) lines.push(`🔗 مربوطة بالطلب <code>${h(x.order_code)}</code> (اتعلّم تم التسليم)`);
      if (x.original_code) lines.push(`🔗 الفاتورة الأصلية <code>${h(x.original_code)}</code>`);
    }
    if (r.review.length) lines.push('', `⚠️ <b>محتاج مراجعة:</b> ${h(r.review.join(' • '))}`);
    if (publicUrl) lines.push(`🔗 ${publicUrl}/#/${r.entity === 'order' ? 'orders' : 'invoices'}/${x.id}`);
    return lines.join('\n');
  }

  async function onCallback(q) {
    const chat = q.message?.chat.id;
    const answer = (text = '') => call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    if (!q.from) return answer();
    const [kind, a, b, c] = String(q.data || '').split(':');
    const edit = text => call('editMessageText', { chat_id: chat, message_id: q.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});

    if (kind === 'setup') {
      if (!access.has(String(q.from.id))) return answer('⛔ لصاحب السيستم بس');
      if (a === 'off') { core.groups.remove(chat); await answer('✔'); return edit('🚫 الجروب ده مش هيستقبل حاجة.'); }
      core.groups.set(chat, a, q.message.chat.title || '');
      await answer('✔');
      return edit(`✅ الجروب ده بقى جروب <b>${GROUP_AR[a]}</b>.\n\nأي رسالة أو صورة ورقة هتتبعت هنا هقراها وأسجلها في السيستم على طول، وأرد بالكود.`);
    }
    if (kind === 'undo') {
      if (!access.has(String(q.from.id)) && String(q.from.id) !== c) return answer('⛔ اللي بعت الرسالة أو صاحب السيستم بس');
      try {
        const rec = a === 'o' ? core.getOrder(Number(b)) : core.getInvoice(Number(b));
        if (rec.source !== 'telegram') return answer('ده اتعدل من السيستم، امسحه من هناك');
        a === 'o' ? core.deleteOrder(rec.id) : core.deleteInvoice(rec.id);
        await answer('✔ اتلغى');
        return edit(`↩️ <s>${h(rec.code)}</s> اتلغى التسجيل. ابعت الرسالة تاني بشكل أوضح أو سجّلها يدوي.`);
      } catch { await answer('اتلغى قبل كده'); return edit('↩️ اتلغى التسجيل.'); }
    }

    if (!access.has(String(q.from.id))) return answer('⛔ غير مصرح');

    if (kind === 'st') {
      try {
        const o = core.setStatus(Number(a), b);
        await answer(`✔ ${S[b]}`);
        return call('editMessageText', { chat_id: chat, message_id: q.message.message_id, text: orderText(o), parse_mode: 'HTML',
          disable_web_page_preview: true, reply_markup: statusButtons(o) }).catch(() => {});
      } catch (e) { return answer('⚠️ ' + e.message); }
    }

    const s = sessions.get(chat);
    if (kind === 'new' && a === 'cancel') { sessions.delete(chat); await answer(); return say(chat, '❌ اتلغى الطلب.'); }
    if (!s) return answer('العملية دي خلصت. ابدأ من جديد.');
    await answer();
    if (kind === 'cust') {
      if (a === 'new') s.customer = core.saveCustomer({ name: s.pendingName });
      else { try { s.customer = core.getCustomer(Number(a)); } catch { return say(chat, 'العميل مش موجود.'); } }
      return askItems(chat, s);
    }
    if (kind === 'due' && s.step === 'due') { s.due = a; return askConfirm(chat, s); }
    if (kind === 'new' && (a === 'save' || a === 'urgent') && s.step === 'confirm') {
      try {
        const t = core.today();
        const o = core.createOrder({ customer_id: s.customer.id, order_date: t, due_date: s.due, items: s.items, priority: a === 'urgent' ? 'urgent' : 'normal' });
        sessions.delete(chat);
        return say(chat, `✅ <b>اتسجل الطلب <code>${h(o.code)}</code></b>\n\n` + orderText(o), { reply_markup: statusButtons(o) });
      } catch (e) { return say(chat, '⚠️ ' + e.message); }
    }
  }

  async function handleUpdate(u) {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) { log.error('Telegram:', e.message); }
  }

  // ---------- التقرير اليومي ----------
  async function dailyReport(force = false) {
    const t = core.today();
    if (!force && (new Date().getHours() < hour || core.getSetting('daily_report_sent') === t)) return false;
    core.setSetting('daily_report_sent', t);
    const d = core.dashboard();
    const text = `☀️ <b>صباح الخير! تقرير ${fmtDate(t)}</b>\n\n` +
      `🔴 متأخر: <b>${d.counts.late || 0}</b> · 📅 قرب ميعاده: <b>${d.counts.due_soon || 0}</b> · 📦 مفتوح: ${d.counts.open || 0}\n` +
      (d.review ? `⚠️ محتاج مراجعة: <b>${d.review}</b>\n` : '') + '\n' +
      lateText() + '\n\n' + soonText();
    for (const id of access.list()) await say(id, text).catch(e => log.error('Daily report:', e.message));
    return true;
  }

  async function poll() {
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) { offset = u.update_id + 1; await handleUpdate(u); }
      } catch (e) {
        if (!running) break;
        log.error('Telegram polling:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  function start() {
    running = true;
    call('deleteWebhook', {}).catch(() => {});
    call('setMyCommands', { commands: [
      { command: 'late', description: 'الطلبات المتأخرة' }, { command: 'soon', description: 'تسليمها خلال ٣ أيام' },
      { command: 'today', description: 'ملخص النهارده' }, { command: 'new', description: 'طلب جديد' },
      { command: 'customers', description: 'العملاء' }, { command: 'help', description: 'مساعدة' },
    ] }).catch(e => log.error('Telegram:', e.message));
    poll();
    timer = setInterval(() => dailyReport().catch(e => log.error(e.message)), 60 * 1000);
    timer.unref?.();
    log.log(`  بوت تليجرام: شغال ✔ (${access.list().length} حساب مربوط)`);
  }
  function stop() { running = false; clearInterval(timer); controller.abort(); }

  return { start, stop, handleUpdate, dailyReport };
}

module.exports = { createBot, parseItem, parseDate };
