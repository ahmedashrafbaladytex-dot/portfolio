// بوت تليجرام لذكاء المبيعات: يستقبل الفواتير والمرتجعات والطلبيات ويحللها ويبعت التقارير
'use strict';
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\n  نسخة Node.js عندك قديمة (${process.version}). نزّل LTS من https://nodejs.org (22.13 أو أحدث)\n`);
    process.exit(1);
  }
}

const crypto = require('node:crypto');
const { loadSettings, config, run } = require('./src/engine');
loadSettings();
const cfg = config();
const store = require('./src/db').open(cfg.dataDir);
const { TYPE_AR } = require('./src/db');
const { createBot } = require('./src/telegram');
const { parseFile, groupDocs, detectType } = require('./src/parse');
const { toDate, today, nowParts, addDays, norm, fmt, esc } = require('./src/util');
const R = require('./src/reports');
const ai = require('./src/ai');
const { templates } = require('./src/templates');

if (!cfg.token) {
  console.error('\n  مفيش TELEGRAM_BOT_TOKEN. افتح ملف settings.env وحط توكن البوت (من @BotFather).\n');
  process.exit(1);
}
const bot = createBot(cfg.token);
const pending = new Map(); // ملفات مستنية المستخدم يحدد نوعها

const HELP = `🤖 <b>بوت ذكاء المبيعات</b>

<b>ابعت على الجروب:</b>
• ملف Excel أو CSV، أو صورة/PDF لفاتورة (الصور محتاجة تفعيل Claude)
• اكتب في الكابشن نوعه: <code>#مبيعات</code> أو <code>#مرتجع</code> أو <code>#طلبية</code>
• <code>#مخزون</code> لملف الجرد/الأرصدة، و <code>#أصناف</code> لملف بيانات الأصناف (فئة/خامة/لون/نقشة/مقاس)
• لو نسيت الكابشن البوت هيسألك بزراير

<b>الأوامر:</b>
/today — تقرير النهارده
/report — ملخص الفترة وتصنيف الأصناف
/top — أقوى وأضعف الأصناف
/returns — تحليل المرتجعات وأسبابها
/taste — ذوق السوق (خامات، ألوان، نقشات، مقاسات، أسعار)
/models — موديلات جديدة مقترحة
/forecast — توقع الطلب وخطة الإنتاج والمخزون
/item كود أو اسم — كارت صنف كامل
/dashboard — لوحة تفاعلية (افتحها في المتصفح)
/excel — ملف Excel بكل التحليلات
/insights — تقرير استراتيجي بالذكاء الاصطناعي
/ask سؤالك — اسأل عن أي حاجة في البيانات
/enrich — استنتاج خصائص الأصناف الناقصة بالذكاء الاصطناعي
/templates — نماذج ملفات جاهزة
/undo — إلغاء آخر مستند اتبعت
/status — حالة البيانات`;

// ---------- استقبال المستندات ----------
async function ingest(chatId, parsed, type, meta) {
  if (type === 'stock') {
    const asOf = toDate(parsed.meta?.date) || today();
    const n = store.saveStock(parsed.lines, asOf);
    return `📦 اتسجل جرد المخزون: ${n} صنف (بتاريخ ${asOf}). البوت هيخصم المبيعات اللي بعد التاريخ ده تلقائي.`;
  }
  if (type === 'items') {
    const n = store.saveItems(parsed.lines);
    return `🧵 اتحدثت بيانات ${n} صنف. الخصائص دي هتستخدم في تحليل ذوق السوق.`;
  }
  const docs = groupDocs(parsed.lines, parsed.meta);
  const out = [];
  let total = 0, replaced = 0;
  for (const d of docs) {
    const r = store.saveDoc({ ...d, type, source: meta.source, file_name: meta.fileName, chat_id: chatId });
    total += r.total; if (r.replaced) replaced++;
    out.push(r);
  }
  const head = `✅ اتسجل ${docs.length > 1 ? `${docs.length} ` : ''}${TYPE_AR[type]}${docs.length > 1 ? '' : ` رقم <code>${esc(out[0].doc_no)}</code>`}`;
  const L = [head];
  if (docs.length === 1) {
    L.push(`📅 ${docs[0].doc_date}${docs[0].customer ? ` — 👤 ${esc(docs[0].customer)}` : ''}`);
  } else {
    const dates = docs.map(d => d.doc_date).sort();
    L.push(`📅 من ${dates[0]} لـ ${dates[dates.length - 1]}`);
  }
  L.push(`🧾 ${parsed.lines.length} سطر — الإجمالي ${R.money(total)}`);
  if (replaced) L.push(`♻️ ${replaced} مستند كان متسجل قبل كده واتحدّث`);
  if (meta.ai) L.push('🤖 اتقرى بالذكاء الاصطناعي — راجع الأرقام، ولو في غلط ابعت /undo');
  if (parsed.columns && !parsed.columns.includes('qty')) L.push('⚠️ مالقيتش عمود الكمية');
  return L.join('\n');
}

async function handleFile(msg, fileId, fileName, mime) {
  const chatId = msg.chat.id;
  const caption = msg.caption || '';
  let type = detectType(caption) || detectType(fileName);
  const buf = await bot.download(fileId);
  const isImage = /^image\//.test(mime) || /\.(jpe?g|png|webp)$/i.test(fileName);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(fileName);
  let parsed, viaAI = false;
  if (isImage || isPdf) {
    if (!ai.enabled()) return bot.send(chatId, '📷 قراءة الصور والـ PDF محتاجة تفعيل Claude (ANTHROPIC_API_KEY في settings.env). ابعت الفاتورة Excel أو CSV.', { reply_to_message_id: msg.message_id });
    await bot.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const mt = isPdf ? 'application/pdf' : (mime && mime.startsWith('image/') ? mime : 'image/jpeg');
    const x = await ai.extractDocument({ buffer: buf, mime: mt, caption });
    if (!type && x.doc_type !== 'unknown') type = x.doc_type;
    parsed = { lines: x.lines.map(l => ({ ...l, qty: Math.abs(l.qty ?? 0), price: l.price ?? (l.total && l.qty ? l.total / l.qty : 0), total: l.total ?? (l.qty ?? 0) * (l.price ?? 0) })), meta: { doc_no: x.doc_no, date: x.date, customer: x.customer } };
    viaAI = true;
  } else {
    parsed = parseFile(buf, fileName);
  }
  const meta = { source: viaAI ? 'ai' : 'file', fileName, ai: viaAI };
  if (!type) {
    const id = crypto.randomBytes(4).toString('hex');
    pending.set(id, { parsed, meta, chatId, at: Date.now() });
    return bot.send(chatId, `📄 استلمت «${esc(fileName)}» (${parsed.lines.length} سطر). ده إيه؟`, {
      reply_to_message_id: msg.message_id,
      reply_markup: { inline_keyboard: [
        [{ text: '💰 مبيعات', callback_data: `t:${id}:sale` }, { text: '↩️ مرتجع', callback_data: `t:${id}:return` }, { text: '📝 طلبية', callback_data: `t:${id}:order` }],
        [{ text: '📦 جرد مخزون', callback_data: `t:${id}:stock` }, { text: '🧵 بيانات أصناف', callback_data: `t:${id}:items` }, { text: '❌ تجاهل', callback_data: `t:${id}:skip` }],
      ] },
    });
  }
  return bot.send(chatId, await ingest(chatId, parsed, type, meta), { reply_to_message_id: msg.message_id });
}

// ---------- الأوامر ----------
const analysis = () => run(store, cfg);
const sendLong = (chatId, text) => bot.send(chatId, text);

async function dashboard(chatId, withAI = false) {
  const { analysis: a } = analysis();
  let insights = '';
  if (withAI && ai.enabled()) insights = await ai.strategicInsights(R.compactForAI(a)).catch(e => `تعذر التحليل: ${e.message}`);
  await bot.sendDocument(chatId, Buffer.from(R.dashboardHtml(a, insights), 'utf8'), `dashboard-${a.summary.asOf}.html`, '📊 افتح الملف في المتصفح (كروم) — فيه كل التحليلات وبحث في الأصناف', 'text/html');
  return insights;
}

const COMMANDS = {
  async start(c) { await bot.send(c, HELP); },
  async help(c) { await bot.send(c, HELP); },
  async today(c, arg) {
    const d = toDate(arg) || today();
    const r = analysis();
    await sendLong(c, R.dailyMessage(r.period(d, d), r.analysis));
  },
  async week(c) {
    const r = analysis(), d = today();
    await sendLong(c, R.dailyMessage(r.period(addDays(d, -6), d), r.analysis).replace('التقرير اليومي', 'تقرير آخر 7 أيام'));
  },
  async report(c) { await sendLong(c, R.summaryMessage(analysis().analysis)); },
  async top(c) { await sendLong(c, R.topMessage(analysis().analysis)); },
  async returns(c) { await sendLong(c, R.returnsMessage(analysis().analysis)); },
  async taste(c) { await sendLong(c, R.tasteMessage(analysis().analysis)); },
  async models(c) { await sendLong(c, R.modelsMessage(analysis().analysis)); },
  async forecast(c) { await sendLong(c, R.forecastMessage(analysis().analysis)); },
  async plan(c) { await COMMANDS.forecast(c); },
  async item(c, arg) {
    if (!arg) return bot.send(c, 'اكتب الكود أو جزء من الاسم: <code>/item طقم ساتان</code>');
    const a = analysis().analysis;
    const q = norm(arg);
    const found = a.items.find(i => norm(i.code) === q) || a.items.find(i => norm(i.name) === q)
      || a.items.filter(i => norm(i.name).includes(q) || norm(i.code).includes(q));
    if (Array.isArray(found)) {
      if (found.length === 1) return sendLong(c, R.itemMessage(found[0], a));
      if (!found.length) return bot.send(c, 'مالقيتش صنف بالاسم ده.');
      return bot.send(c, `لقيت ${found.length} صنف، حدد أكتر:\n` + found.slice(0, 15).map(i => `• <code>/item ${esc(i.code)}</code> — ${esc(i.name)}`).join('\n'));
    }
    return sendLong(c, R.itemMessage(found, a));
  },
  async dashboard(c) { await dashboard(c, false); },
  async excel(c) {
    const a = analysis().analysis;
    await bot.sendDocument(c, R.excelReport(a), `sales-intelligence-${a.summary.asOf}.xlsx`, '📗 كل التحليلات في Excel: الأصناف، خطة الإنتاج، ذوق السوق، الموديلات المقترحة، المرتجعات، العملاء', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  },
  async insights(c) {
    if (!ai.enabled()) return bot.send(c, 'التقرير الاستراتيجي محتاج ANTHROPIC_API_KEY في settings.env');
    await bot.send(c, '🧠 بحلل البيانات... (ممكن ياخد دقيقة)');
    const insights = await dashboard(c, true);
    if (insights) await sendLong(c, '🧠 <b>التحليل الاستراتيجي</b>\n\n' + esc(insights));
  },
  async ask(c, arg) {
    if (!arg) return bot.send(c, 'اكتب سؤالك بعد الأمر: <code>/ask إيه أكتر لون بيرجع؟</code>');
    if (!ai.enabled()) return bot.send(c, 'الأسئلة الحرة محتاجة ANTHROPIC_API_KEY في settings.env');
    await bot.api('sendChatAction', { chat_id: c, action: 'typing' }).catch(() => {});
    await sendLong(c, esc(await ai.ask(arg, R.compactForAI(analysis().analysis))));
  },
  async enrich(c) {
    if (!ai.enabled()) return bot.send(c, 'محتاج ANTHROPIC_API_KEY في settings.env');
    const items = store.items();
    const missing = items.filter(i => i.attr_source !== 'file' && (!i.category || !i.fabric || !i.color || !i.pattern));
    if (!missing.length) return bot.send(c, '✅ كل الأصناف خصائصها كاملة.');
    await bot.send(c, `🧵 بصنّف ${missing.length} صنف...`);
    const vocab = {};
    for (const k of ['category', 'fabric', 'color', 'pattern', 'size']) vocab[k] = [...new Set(items.map(i => i[k]).filter(Boolean))].slice(0, 40);
    const res = await ai.classifyItems(missing, vocab);
    const byCode = new Map(missing.map(i => [i.code, i]));
    let n = 0;
    for (const r of res) {
      const cur = byCode.get(r.code);
      if (!cur) continue;
      // متكتبش فوق قيمة موجودة
      const upd = {};
      for (const k of ['category', 'fabric', 'color', 'pattern', 'size']) if (!cur[k] && r[k]) upd[k] = r[k];
      if (Object.keys(upd).length) { store.updateItemAttrs(r.code, upd, 'ai'); n++; }
    }
    await bot.send(c, `✅ اتحدثت خصائص ${n} صنف. جرّب /taste و /models`);
  },
  async templates(c) {
    for (const t of templates()) await bot.sendDocument(c, t.buffer, t.name, t.caption, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  },
  async undo(c) {
    const d = store.lastDoc(c);
    if (!d) return bot.send(c, 'مفيش مستندات اتبعتت من الجروب ده.');
    store.deleteDoc(d.id);
    await bot.send(c, `🗑️ اتلغى ${TYPE_AR[d.type]} رقم <code>${esc(d.doc_no)}</code> (${d.doc_date})`);
  },
  async status(c) {
    const counts = store.counts();
    const L = ['📦 <b>حالة البيانات</b>'];
    for (const t of ['sale', 'return', 'order']) {
      const x = counts.find(r => r.type === t);
      L.push(`• ${TYPE_AR[t]}: ${x ? `${fmt(x.n)} (${x.first} ← ${x.last})` : 'لا يوجد'}`);
    }
    const items = store.items(), stock = store.stock();
    L.push(`• الأصناف: ${items.length} (خصائص كاملة: ${items.filter(i => i.category && i.color && i.fabric).length})`);
    L.push(`• أرصدة مخزون: ${stock.length}`);
    L.push(`• نظام الطلبات: ${cfg.ordersDb && require('node:fs').existsSync(cfg.ordersDb) ? 'مربوط ✅' : 'مش مربوط'}`);
    L.push(`• الذكاء الاصطناعي (Claude): ${ai.enabled() ? 'مفعّل ✅' : 'مش مفعّل'}`);
    L.push(`• التقرير اليومي الساعة ${cfg.dailyTime} — والأسبوعي يوم ${['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'][cfg.weeklyDay]}`);
    await bot.send(c, L.join('\n'));
  },
  async chatid(c) { await bot.send(c, `Chat ID: <code>${c}</code>`); },
};

async function onMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text || '';
  if (!cfg.allowedChats.includes(chatId)) {
    if (text.startsWith('/') || msg.document) {
      await bot.send(chatId, `🔒 البوت لسه مش مربوط بالجروب ده.\nChat ID: <code>${chatId}</code>\nحطه في ملف settings.env في السطر ALLOWED_CHATS وشغّل البوت تاني.`);
    }
    console.log(`رسالة من شات غير مسموح: ${chatId} (${msg.chat.title || msg.chat.username || ''})`);
    return;
  }
  try {
    if (msg.document) return await handleFile(msg, msg.document.file_id, msg.document.file_name || 'file', msg.document.mime_type || '');
    if (msg.photo) {
      const p = msg.photo[msg.photo.length - 1];
      return await handleFile(msg, p.file_id, 'photo.jpg', 'image/jpeg');
    }
    const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
    if (m) {
      const fn = COMMANDS[m[1].toLowerCase()];
      if (fn) await fn(chatId, m[2].trim());
      return;
    }
    // فاتورة مكتوبة كنص مع هاشتاج: #مبيعات ...
    const type = text.startsWith('#') ? detectType(text.split('\n')[0]) : null;
    if (type && ['sale', 'return', 'order'].includes(type) && text.split('\n').length > 1) {
      if (!ai.enabled()) return bot.send(chatId, 'قراءة الفواتير المكتوبة كنص محتاجة تفعيل Claude. ابعتها Excel.');
      const x = await ai.extractDocument({ text, caption: text.split('\n')[0] });
      const parsed = { lines: x.lines.map(l => ({ ...l, qty: Math.abs(l.qty ?? 0), price: l.price ?? 0, total: l.total ?? (l.qty ?? 0) * (l.price ?? 0) })), meta: { doc_no: x.doc_no, date: x.date, customer: x.customer } };
      await bot.send(chatId, await ingest(chatId, parsed, type, { source: 'ai-text', fileName: '', ai: true }), { reply_to_message_id: msg.message_id });
    }
  } catch (e) {
    console.error(e);
    await bot.send(chatId, `❌ ${esc(e.message)}`, { reply_to_message_id: msg.message_id }).catch(() => {});
  }
}

async function onCallback(q) {
  const [, id, type] = (q.data || '').split(':');
  const p = pending.get(id);
  await bot.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  if (!p || String(q.message.chat.id) !== String(p.chatId)) return;
  pending.delete(id);
  await bot.api('editMessageReplyMarkup', { chat_id: p.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (type === 'skip') return bot.send(p.chatId, 'تمام، اتجاهل.');
  try { await bot.send(p.chatId, await ingest(p.chatId, p.parsed, type, p.meta)); } catch (e) { await bot.send(p.chatId, `❌ ${esc(e.message)}`); }
}

// ---------- الجدولة ----------
async function scheduler() {
  if (!cfg.reportChat) return;
  const d = today(), { hour, minute, weekday } = nowParts();
  const [h, m] = cfg.dailyTime.split(':').map(Number);
  if (hour * 60 + minute < h * 60 + (m || 0)) return;
  if (store.getMeta('daily_sent') !== d) {
    store.setMeta('daily_sent', d);
    const r = analysis();
    await bot.send(cfg.reportChat, R.dailyMessage(r.period(d, d), r.analysis));
  }
  if (weekday === cfg.weeklyDay && store.getMeta('weekly_sent') !== d) {
    store.setMeta('weekly_sent', d);
    const a = analysis().analysis;
    await bot.send(cfg.reportChat, '🗓️ <b>التقرير الأسبوعي</b>\n\n' + R.summaryMessage(a));
    await bot.send(cfg.reportChat, R.tasteMessage(a));
    await bot.send(cfg.reportChat, R.modelsMessage(a));
    await bot.send(cfg.reportChat, R.forecastMessage(a));
    const insights = await dashboard(cfg.reportChat, ai.enabled());
    if (insights) await bot.send(cfg.reportChat, '🧠 <b>التحليل الاستراتيجي</b>\n\n' + esc(insights));
    await COMMANDS.excel(cfg.reportChat);
  }
}

// ---------- التشغيل ----------
async function main() {
  const me = await bot.api('getMe');
  await bot.api('setMyCommands', { commands: [
    ['today', 'تقرير النهارده'], ['report', 'ملخص وتصنيف الأصناف'], ['top', 'أقوى وأضعف الأصناف'], ['returns', 'تحليل المرتجعات'],
    ['taste', 'ذوق السوق'], ['models', 'موديلات مقترحة'], ['forecast', 'توقع الطلب وخطة الإنتاج'], ['item', 'كارت صنف'],
    ['dashboard', 'لوحة تفاعلية'], ['excel', 'ملف Excel'], ['insights', 'تحليل استراتيجي (AI)'], ['ask', 'اسأل عن البيانات (AI)'],
    ['templates', 'نماذج ملفات'], ['undo', 'إلغاء آخر مستند'], ['status', 'حالة البيانات'], ['help', 'المساعدة'],
  ].map(([command, description]) => ({ command, description })) }).catch(() => {});
  console.log(`\n  ✅ البوت شغال: @${me.username}`);
  console.log(`  الجروبات المسموحة: ${cfg.allowedChats.join(', ') || 'لسه مفيش — ابعت /chatid في الجروب'}`);
  console.log(`  الذكاء الاصطناعي: ${ai.enabled() ? 'مفعّل (' + ai.MODEL + ')' : 'مش مفعّل'}`);
  console.log('  سيب الشباك ده مفتوح طول ما البوت شغال.\n');

  setInterval(() => scheduler().catch(e => console.error('scheduler:', e.message)), 60000);
  setInterval(() => { for (const [k, v] of pending) if (Date.now() - v.at > 86400000) pending.delete(k); }, 3600000);

  let offset = Number(store.getMeta('tg_offset') || 0);
  for (;;) {
    try {
      const updates = await bot.api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        store.setMeta('tg_offset', offset);
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      }
    } catch (e) {
      console.error('اتصال:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(e => { console.error('\n  ❌', e.message, '\n  اتأكد من التوكن ومن الإنترنت.\n'); process.exit(1); });
