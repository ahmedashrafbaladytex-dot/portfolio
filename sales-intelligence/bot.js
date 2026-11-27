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

const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { loadSettings, saveSetting, config, run } = require('./src/engine');
loadSettings();
// الأجهزة اللي اتسطبت قبل كده كان التقرير الأسبوعي فيها الخميس بالليل: ننقله مرة واحدة للأحد 9 الصبح
if (!process.env.WEEKLY_REPORT_TIME) { saveSetting('WEEKLY_REPORT_DAY', '0'); saveSetting('WEEKLY_REPORT_TIME', '09:00'); }
const cfg = config();
const store = require('./src/db').open(cfg.dataDir);
const { TYPE_AR } = require('./src/db');
const { createBot } = require('./src/telegram');
const { parseFile, groupDocs, detectType } = require('./src/parse');
const { toDate, today, nowParts, addDays, norm, fmt, esc } = require('./src/util');
const R = require('./src/reports');
const ai = require('./src/ai');
const { templates } = require('./src/templates');

let bot;
let me;
const pending = new Map();                                   // ملفات مستنية المستخدم يحدد نوعها
const LINK_CODE = String(crypto.randomInt(1000, 10000));     // كود ربط الجروب (بيظهر على شاشة الجهاز بس)

// ---------- القائمة (زراير ثابتة تحت الشات) ----------
const B = {
  today: '📊 تقرير النهارده', plan: '🏭 خطة الإنتاج', items: '🏆 الأصناف', returns: '↩️ المرتجعات',
  taste: '🎨 ذوق السوق والموديلات', full: '📁 التقرير الكامل', week: '🗓️ ملخص الأسبوع', help: '❓ إزاي أستخدمه',
};
const MENU = { keyboard: [[B.today, B.plan], [B.items, B.returns], [B.taste, B.full], [B.week, B.help]], resize_keyboard: true, is_persistent: true };

const HELP = () => `🤖 <b>إزاي تستخدمني</b>

<b>1) ابعتلي الملفات هنا</b>
Excel أو CSV${ai.enabled() ? ' أو صورة الفاتورة' : ''} — وأنا أفهم لوحدي هو مبيعات ولا مرتجع ولا طلبية. لو مش متأكد هسألك بزرار.
(لو عايز تحدد بنفسك اكتب في الكابشن: مبيعات / مرتجع / طلبية / مخزون)

<b>2) دوس على الزراير اللي تحت</b>
📊 تقرير النهارده — 🏭 خطة الإنتاج — 🏆 الأصناف
↩️ المرتجعات — 🎨 ذوق السوق والموديلات — 📁 التقرير الكامل

<b>3) دوّر على صنف</b>
اكتب: <code>صنف ساتان بيج</code>${ai.enabled() ? `\n\n<b>4) اسأل أي سؤال</b>\nاكتب: <code>سؤال أنتج إيه للعيد؟</code>` : ''}

↩️ بعت ملف غلط؟ اكتب <code>الغي</code>
📎 عايز نموذج ملف جاهز؟ اكتب <code>نماذج</code>

وكل يوم الساعة ${cfg.dailyTime} هبعتلكم تقرير اليوم، وكل ${['أحد', 'اتنين', 'تلات', 'أربع', 'خميس', 'جمعة', 'سبت'][cfg.weeklyDay]} الساعة ${cfg.weeklyTime} ملخص الأسبوع (مبيعات ومخزون) والتقرير الكامل.`;

// يفتح رابط في المتصفح/تليجرام على جهاز المستخدم
function openUrl(url) {
  if (process.env.NO_BROWSER) return;
  const { exec } = require('node:child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ---------- أول تشغيل: معالج بسيط ----------
async function setupWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));
  console.log(`
  ===============================================
     أهلاً! خلينا نجهّز البوت (مرة واحدة بس)
  ===============================================

  فتحتلك @BotFather في تليجرام. اعمل كده:
  1. دوس  Start  وبعدين ابعتله  /newbot
  2. اكتب اسم للبوت (مثلاً: مبيعات المصنع)
  3. اكتب اسم إنجليزي ينتهي بـ bot (مثلاً: myfactory_sales_bot)
  4. هيبعتلك "توكن" شبه كده:  123456789:AAH...  انسخه
`);
  openUrl('https://t.me/BotFather');
  for (;;) {
    const token = await ask('  الصق التوكن هنا (كليك يمين = لصق) واضغط Enter:  ');
    try {
      const b = createBot(token);
      const info = await b.api('getMe');
      saveSetting('TELEGRAM_BOT_TOKEN', token);
      cfg.token = token;
      console.log(`\n  ✅ تمام! البوت بتاعك: @${info.username}\n`);
      break;
    } catch {
      console.log('  ❌ التوكن ده مش شغال أو مفيش إنترنت — جرّب تاني.\n');
    }
  }
  if (!ai.enabled()) {
    console.log('  (اختياري) مفتاح Claude بيخلي البوت يقرا صور الفواتير ويكتب تحليل استراتيجي.');
    const key = await ask('  الصق المفتاح أو اضغط Enter للتخطي:  ');
    if (key) saveSetting('ANTHROPIC_API_KEY', key);
  }
  rl.close();
}

// ---------- استقبال المستندات ----------
async function ingest(chatId, parsed, type, meta) {
  if (type === 'stock') {
    const asOf = toDate(parsed.meta?.date) || today();
    const n = store.saveStock(parsed.lines, asOf);
    return `📦 اتسجل جرد المخزون: ${n} صنف (بتاريخ ${asOf}).`;
  }
  if (type === 'items') {
    const n = store.saveItems(parsed.lines);
    return `🧵 اتحدثت بيانات ${n} صنف.`;
  }
  const docs = groupDocs(parsed.lines, parsed.meta);
  let total = 0, replaced = 0, first;
  for (const d of docs) {
    const r = store.saveDoc({ ...d, type, source: meta.source, file_name: meta.fileName, chat_id: chatId });
    total += r.total; if (r.replaced) replaced++;
    first = first || r;
  }
  const L = [docs.length > 1
    ? `✅ اتسجل ${docs.length} ${TYPE_AR[type]}`
    : `✅ اتسجل ${TYPE_AR[type]} رقم <code>${esc(first.doc_no)}</code>${docs[0].customer ? ` — ${esc(docs[0].customer)}` : ''}`];
  L.push(`🧾 ${parsed.lines.length} صنف — ${R.money(total)}`);
  if (replaced) L.push(`♻️ ${replaced} كان متسجل قبل كده واتحدّث`);
  if (meta.ai) L.push('🤖 اتقرى من الصورة — لو في غلط اكتب «الغي»');
  if (parsed.columns && !parsed.columns.includes('qty')) L.push('⚠️ مالقيتش عمود الكمية');
  autoEnrich();
  return L.join('\n');
}

// يكمّل خصائص الأصناف الجديدة (فئة/خامة/لون/نقشة) في الخلفية من غير ما حد يطلب
let enriching = false;
function autoEnrich() {
  if (!ai.enabled() || enriching) return;
  const missing = store.needEnrich();
  if (!missing.length) return;
  enriching = true;
  const items = store.items();
  const vocab = {};
  for (const k of ['category', 'fabric', 'color', 'pattern', 'size']) vocab[k] = [...new Set(items.map(i => i[k]).filter(Boolean))].slice(0, 40);
  ai.classifyItems(missing, vocab).then(res => {
    const byCode = new Map(missing.map(i => [i.code, i]));
    for (const r of res) {
      const cur = byCode.get(r.code);
      if (!cur) continue;
      const upd = {};
      for (const k of ['category', 'fabric', 'color', 'pattern', 'size']) if (!cur[k] && r[k]) upd[k] = r[k];
      store.updateItemAttrs(r.code, upd, 'ai');
    }
    store.markTried(missing.map(i => i.code));
  }).catch(e => console.warn('تصنيف الأصناف:', e.message)).finally(() => { enriching = false; });
}

const TYPE_BUTTONS = id => ({ inline_keyboard: [
  [{ text: '💰 مبيعات', callback_data: `t:${id}:sale` }, { text: '↩️ مرتجع', callback_data: `t:${id}:return` }, { text: '📝 طلبية', callback_data: `t:${id}:order` }],
  [{ text: '📦 جرد مخزون', callback_data: `t:${id}:stock` }, { text: '🧵 بيانات أصناف', callback_data: `t:${id}:items` }, { text: '❌ تجاهل', callback_data: `t:${id}:skip` }],
] });

async function handleFile(msg, fileId, fileName, mime) {
  const chatId = msg.chat.id;
  const caption = msg.caption || '';
  let type = detectType(caption) || detectType(fileName);
  const isImage = /^image\//.test(mime) || /\.(jpe?g|png|webp)$/i.test(fileName);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(fileName);
  if ((isImage || isPdf) && !ai.enabled()) {
    return bot.send(chatId, '📷 مش بقدر أقرا الصور غير لو مفتاح Claude متفعّل. ابعت الفاتورة Excel.', { reply_to_message_id: msg.message_id });
  }
  const buf = await bot.download(fileId);
  let parsed, viaAI = false;
  if (isImage || isPdf) {
    await bot.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const x = await ai.extractDocument({ buffer: buf, mime: isPdf ? 'application/pdf' : (mime.startsWith('image/') ? mime : 'image/jpeg'), caption });
    if (!type && x.doc_type !== 'unknown') type = x.doc_type;
    parsed = aiToParsed(x);
    viaAI = true;
  } else {
    parsed = parseFile(buf, fileName);
    type = type || parsed.guess;
  }
  const meta = { source: viaAI ? 'ai' : 'file', fileName, ai: viaAI };
  if (!type) {
    const id = crypto.randomBytes(4).toString('hex');
    pending.set(id, { parsed, meta, chatId, at: Date.now() });
    return bot.send(chatId, `📄 استلمت الملف (${parsed.lines.length} صنف). ده إيه؟`, { reply_to_message_id: msg.message_id, reply_markup: TYPE_BUTTONS(id) });
  }
  return bot.send(chatId, await ingest(chatId, parsed, type, meta), { reply_to_message_id: msg.message_id });
}
const aiToParsed = x => ({
  lines: x.lines.map(l => ({ ...l, qty: Math.abs(l.qty ?? 0), price: l.price ?? (l.total && l.qty ? l.total / l.qty : 0), total: l.total ?? (l.qty ?? 0) * (l.price ?? 0) })),
  meta: { doc_no: x.doc_no, date: x.date, customer: x.customer },
});

// ---------- التقارير ----------
const analysis = () => run(store, cfg);
const send = (c, t, extra) => bot.send(c, t, extra);

async function fullReport(c) {
  const { analysis: a } = analysis();
  await send(c, R.summaryMessage(a));
  let insights = '';
  if (ai.enabled()) {
    await send(c, '🧠 بكتب التحليل الاستراتيجي... (دقيقة تقريباً)');
    insights = await ai.strategicInsights(R.compactForAI(a)).catch(e => { console.warn(e.message); return ''; });
  }
  await bot.sendDocument(c, Buffer.from(R.dashboardHtml(a, insights), 'utf8'), `تقرير-${a.summary.asOf}.html`, '📊 <b>اللوحة الكاملة</b> — افتحها على الموبايل أو الكمبيوتر', 'text/html');
  await bot.sendDocument(c, R.excelReport(a), `تحليل-${a.summary.asOf}.xlsx`, '📗 كل التحليلات في Excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (insights) await send(c, '🧠 <b>التحليل الاستراتيجي</b>\n\n' + esc(insights));
}

async function findItem(c, q) {
  const a = analysis().analysis;
  const n = norm(q);
  const exact = a.items.find(i => norm(i.code) === n || norm(i.name) === n);
  if (exact) return send(c, R.itemMessage(exact, a));
  const words = n.split(' ');
  const hits = a.items.filter(i => { const t = norm(i.name + ' ' + i.code); return words.every(w => t.includes(w)); });
  if (hits.length === 1) return send(c, R.itemMessage(hits[0], a));
  if (!hits.length) return send(c, 'مالقيتش صنف بالاسم ده.');
  return send(c, `لقيت ${hits.length} صنف — اكتب اسم أدق:\n` + hits.slice(0, 15).map(i => `• ${esc(i.name)} <code>${esc(i.code)}</code>`).join('\n'));
}

async function undo(c) {
  const d = store.lastDoc(c);
  if (!d) return send(c, 'مفيش حاجة اتبعتت من هنا عشان ألغيها.');
  store.deleteDoc(d.id);
  return send(c, `🗑️ اتلغى ${TYPE_AR[d.type]} رقم <code>${esc(d.doc_no)}</code> (${d.doc_date})`);
}

async function status(c) {
  const counts = store.counts();
  const L = ['📦 <b>اللي عندي لحد دلوقتي</b>'];
  for (const t of ['sale', 'return', 'order']) {
    const x = counts.find(r => r.type === t);
    L.push(`• ${TYPE_AR[t]}: ${x ? `${fmt(x.n)} (${x.first} ← ${x.last})` : 'لسه مفيش'}`);
  }
  L.push(`• الأصناف: ${store.items().length} — أرصدة مخزون: ${store.stock().length}`);
  L.push(`• نظام طلبات العملاء: ${cfg.ordersDb && fs.existsSync(cfg.ordersDb) ? 'مربوط ✅' : 'مش مربوط'}`);
  L.push(`• الذكاء الاصطناعي: ${ai.enabled() ? 'شغال ✅' : 'مش متفعّل'}`);
  return send(c, L.join('\n'));
}

// زراير القائمة + كلمات بسيطة + الأوامر القديمة (للي متعود عليها)
const ACTIONS = {
  [B.today]: c => { const r = analysis(), d = today(); return send(c, R.dailyMessage(r.period(d, d), r.analysis)); },
  [B.plan]: c => send(c, R.forecastMessage(analysis().analysis)),
  [B.items]: c => send(c, R.topMessage(analysis().analysis)),
  [B.returns]: c => send(c, R.returnsMessage(analysis().analysis)),
  [B.taste]: async c => { const a = analysis().analysis; await send(c, R.tasteMessage(a)); await send(c, R.modelsMessage(a)); },
  [B.full]: fullReport,
  [B.week]: c => weeklyReport(c),
  [B.help]: c => send(c, HELP(), { reply_markup: MENU }),
};
const SLASH = {
  start: B.help, help: B.help, menu: B.help, today: B.today, forecast: B.plan, plan: B.plan, top: B.items, report: B.items,
  returns: B.returns, taste: B.taste, models: B.taste, full: B.full, week: B.week, weekly: B.week, dashboard: B.full, excel: B.full, insights: B.full,
};

async function onText(chatId, text) {
  const t = text.trim();
  if (ACTIONS[t]) return ACTIONS[t](chatId);
  const m = t.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (m) {
    const cmd = m[1].toLowerCase(), arg = m[2].trim();
    if (SLASH[cmd]) return ACTIONS[SLASH[cmd]](chatId);
    if (cmd === 'item') return arg ? findItem(chatId, arg) : send(chatId, 'اكتب: <code>صنف ساتان بيج</code>');
    if (cmd === 'ask') return arg ? askAI(chatId, arg) : send(chatId, 'اكتب: <code>سؤال أنتج إيه للعيد؟</code>');
    if (cmd === 'undo') return undo(chatId);
    if (cmd === 'status') return status(chatId);
    if (cmd === 'templates') return sendTemplates(chatId);
    if (cmd === 'chatid') return send(chatId, `<code>${chatId}</code>`);
    return;
  }
  const w = norm(t);
  let x;
  if ((x = w.match(/^صنف\s+(.+)/))) return findItem(chatId, x[1]);
  if ((x = t.match(/^سؤال\s+([\s\S]+)/))) return askAI(chatId, x[1]);
  if (/^(الغي|الغاء|الغي اخر ملف|undo)$/.test(w)) return undo(chatId);
  if (/^(نماذج|نموذج|templates)$/.test(w)) return sendTemplates(chatId);
  if (/^(حاله|الحاله|status)$/.test(w)) return status(chatId);
  if (/^(قائمه|القائمه|menu|مساعده)$/.test(w)) return ACTIONS[B.help](chatId);
  // فاتورة مكتوبة كرسالة: أول سطر فيه النوع
  const type = detectType(t.split('\n')[0]);
  if (ai.enabled() && ['sale', 'return', 'order'].includes(type) && t.split('\n').length > 2) {
    const x2 = await ai.extractDocument({ text: t, caption: t.split('\n')[0] });
    return send(chatId, await ingest(chatId, aiToParsed(x2), type, { source: 'ai-text', fileName: '', ai: true }));
  }
}

async function askAI(c, q) {
  if (!ai.enabled()) return send(c, 'الأسئلة محتاجة مفتاح Claude.');
  await bot.api('sendChatAction', { chat_id: c, action: 'typing' }).catch(() => {});
  return send(c, esc(await ai.ask(q, R.compactForAI(analysis().analysis))));
}
async function sendTemplates(c) {
  for (const t of templates()) await bot.sendDocument(c, t.buffer, t.name, t.caption, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// ---------- ربط الجروب ----------
async function isAdmin(chatId) {
  try {
    const m = await bot.api('getChatMember', { chat_id: chatId, user_id: me.id });
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

async function linkChat(chatId, title) {
  cfg.allowedChats.push(chatId);
  saveSetting('ALLOWED_CHATS', cfg.allowedChats.join(','));
  if (!cfg.reportChat) { cfg.reportChat = chatId; saveSetting('REPORT_CHAT', chatId); }
  console.log(`\n  ✅ اتربط: ${title || chatId}\n`);
  await send(chatId, `✅ <b>تمام! أنا جاهز</b>\n\n${HELP()}`, { reply_markup: MENU });
  const isGroup = Number(chatId) < 0;
  if (isGroup && !me.can_read_all_group_messages && !(await isAdmin(chatId))) {
    await send(chatId, '⚠️ خطوة أخيرة: خليني <b>أدمن</b> في الجروب (إعدادات الجروب ← Administrators ← Add Admin) عشان أشوف الملفات اللي بتتبعت.');
  }
}

async function onMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text || msg.caption || '';
  if (!cfg.allowedChats.includes(chatId)) {
    // البوت اتضاف لجروب جديد
    if (msg.new_chat_members?.some(u => u.id === me.id)) {
      return send(chatId, '👋 أهلاً! عشان أشتغل هنا:\n1. خليني <b>أدمن</b> في الجروب\n2. ابعت <b>كود الربط</b> اللي ظاهر على شاشة الجهاز اللي شغّال عليه البوت');
    }
    if (text.replace(/^\/start(@\S+)?\s*/, '').trim() === LINK_CODE) return linkChat(chatId, msg.chat.title);
    if (msg.text?.startsWith('/') || msg.document || msg.photo) {
      await send(chatId, '🔒 ابعت كود الربط اللي ظاهر على شاشة الجهاز اللي شغّال عليه البوت.');
    }
    return;
  }
  try {
    if (msg.new_chat_members?.some(u => u.id === me.id)) return ACTIONS[B.help](chatId);
    if (msg.document) return await handleFile(msg, msg.document.file_id, msg.document.file_name || 'file', msg.document.mime_type || '');
    if (msg.photo) return await handleFile(msg, msg.photo[msg.photo.length - 1].file_id, 'photo.jpg', 'image/jpeg');
    if (msg.text) return await onText(chatId, msg.text);
  } catch (e) {
    console.error(e);
    await send(chatId, `❌ ${esc(e.message)}`, { reply_to_message_id: msg.message_id }).catch(() => {});
  }
}

async function onCallback(q) {
  const [, id, type] = (q.data || '').split(':');
  const p = pending.get(id);
  await bot.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  if (!p || String(q.message.chat.id) !== String(p.chatId)) return;
  pending.delete(id);
  await bot.api('editMessageReplyMarkup', { chat_id: p.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (type === 'skip') return send(p.chatId, 'تمام، اتجاهل.');
  try { await send(p.chatId, await ingest(p.chatId, p.parsed, type, p.meta)); } catch (e) { await send(p.chatId, `❌ ${esc(e.message)}`); }
}

// ---------- التقارير التلقائية ----------
async function scheduler() {
  if (!cfg.reportChat) return;
  const d = today(), { hour, minute, weekday } = nowParts();
  const passed = t => { const [h, m] = t.split(':').map(Number); return hour * 60 + minute >= h * 60 + (m || 0); };
  if (weekday === cfg.weeklyDay && passed(cfg.weeklyTime) && store.getMeta('weekly_sent') !== d) {
    store.setMeta('weekly_sent', d);
    await weeklyReport(cfg.reportChat);
  }
  if (passed(cfg.dailyTime) && store.getMeta('daily_sent') !== d) {
    store.setMeta('daily_sent', d);
    await ACTIONS[B.today](cfg.reportChat);
  }
}

// ملخص الأسبوع اللي فات (من الأحد للسبت) + اللوحة وملف Excel
async function weeklyReport(c) {
  const r = analysis(), d = today();
  await send(c, R.weeklyMessage(r.period(addDays(d, -7), addDays(d, -1)), r.analysis));
  await fullReport(c);
}

// ---------- التشغيل ----------
async function main() {
  if (!cfg.token) await setupWizard();
  bot = createBot(cfg.token);
  me = await bot.api('getMe');
  await bot.api('setMyCommands', { commands: [{ command: 'menu', description: 'القائمة' }] }).catch(() => {});

  console.log(`\n  ✅ البوت شغال: @${me.username}   —   سيب الشباك ده مفتوح`);
  console.log(`  الذكاء الاصطناعي: ${ai.enabled() ? 'شغال' : 'مش متفعّل'}`);
  const linkUrl = `https://t.me/${me.username}?startgroup=${LINK_CODE}&admin=pin_messages`;
  console.log(`
  ┌──────────────────────────────────────────────────────┐
     عشان تربط جروب الفواتير:
     دوس على الرابط ده (أو هيتفتح لوحده) واختار الجروب
     ${linkUrl}

     أو: ضيف @${me.username} للجروب واعمله أدمن، وابعت الكود:  ${LINK_CODE}
  └──────────────────────────────────────────────────────┘
  ${cfg.allowedChats.length ? `(مربوط حالياً بـ ${cfg.allowedChats.length} جروب)` : ''}
`);
  if (!cfg.allowedChats.length) openUrl(linkUrl);

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

main().catch(e => { console.error('\n  ❌', e.message, '\n  اتأكد من الإنترنت.\n'); process.exit(1); });
