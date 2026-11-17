// الذكاء الاصطناعي (Claude): قراءة صور/PDF الفواتير، تصنيف الأصناف، والتحليل الاستراتيجي
// اختياري: بيشتغل بس لو ANTHROPIC_API_KEY موجود
'use strict';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let client = null;

function enabled() { return !!process.env.ANTHROPIC_API_KEY; }

function getClient() {
  if (!enabled()) throw new Error('الذكاء الاصطناعي مش مفعّل — حط ANTHROPIC_API_KEY في ملف settings.env');
  if (!client) {
    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); } catch {
      throw new Error('مكتبة Claude مش متسطبة — شغّل: npm install');
    }
    client = new (Anthropic.default || Anthropic)();
  }
  return client;
}

// طلب موحّد: fallback تلقائي لو الطلب اترفض + فحص سبب التوقف
async function call({ system, content, schema, effort = 'medium', maxTokens = 16000 }) {
  const c = getClient();
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    system,
    messages: [{ role: 'user', content }],
  };
  const msg = await c.beta.messages.stream(params).finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude رفض الطلب ده');
  if (msg.stop_reason === 'max_tokens') throw new Error('الرد اتقطع (طويل جداً) — جرب ملف أصغر');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return schema ? JSON.parse(text) : text.trim();
}

const S = { type: ['string', 'null'] };
const N = { type: ['number', 'null'] };
const DOC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'doc_no', 'date', 'customer', 'lines'],
  properties: {
    doc_type: { type: 'string', enum: ['sale', 'return', 'order', 'unknown'] },
    doc_no: S, date: { ...S, description: 'YYYY-MM-DD' }, customer: S,
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['item_code', 'item_name', 'qty', 'price', 'total', 'reason', 'color', 'size'],
        properties: { item_code: S, item_name: S, qty: N, price: N, total: N, reason: S, color: S, size: S },
      },
    },
  },
};

// buffer: صورة أو PDF ، mime: image/jpeg | image/png | application/pdf
async function extractDocument({ buffer, mime, caption, text }) {
  const content = [];
  if (buffer) {
    const data = buffer.toString('base64');
    content.push(mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } });
  }
  content.push({ type: 'text', text: `${text ? `نص المستند:\n${text}\n\n` : ''}ملاحظة المرسل: ${caption || 'لا يوجد'}\nاستخرج بيانات المستند.` });
  return call({
    system: `أنت مدخل بيانات دقيق في مصنع مفروشات ومنسوجات مصري. هتستلم صورة أو PDF أو نص لفاتورة مبيعات أو فاتورة مرتجع أو طلبية عميل (غالباً بالعربي وممكن تكون بخط اليد).
- استخرج كل سطور الأصناف بالترتيب: كود الصنف لو موجود، اسم الصنف كما هو مكتوب، الكمية، سعر الوحدة، الإجمالي.
- doc_type: "sale" لفاتورة بيع، "return" لمرتجع/إذن ارتجاع، "order" لطلبية/أمر شراء من عميل، "unknown" لو مش واضح. ملاحظة المرسل بتحدد النوع لو مكتوب فيها.
- التاريخ بصيغة YYYY-MM-DD (التواريخ المصرية غالباً يوم/شهر/سنة). حوّل الأرقام الهندي (٠-٩) لأرقام عادية.
- في المرتجعات: سبب الارتجاع في reason لو مكتوب.
- متخترعش أي قيمة مش موجودة: اللي مش مقروء أو مش موجود خليه null. متحسبش سطر الإجمالي الكلي كصنف.`,
    content, schema: DOC_SCHEMA, effort: 'medium',
  });
}

const ITEMS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'category', 'fabric', 'color', 'pattern', 'size'],
        properties: { code: { type: 'string' }, category: S, fabric: S, color: S, pattern: S, size: S },
      },
    },
  },
};

// يصنّف الأصناف (فئة/خامة/لون/نقشة/مقاس) من أسمائها — دفعات من 80 صنف
async function classifyItems(items, examples = {}) {
  const out = [];
  for (let i = 0; i < items.length; i += 80) {
    const batch = items.slice(i, i + 80);
    const r = await call({
      system: `أنت خبير منتجات في مصنع مفروشات ومنسوجات منزلية مصري. صنّف كل صنف من اسمه.
- استخدم نفس القيم الموجودة في القوائم دي لو مناسبة عشان التحليل يبقى موحّد: ${JSON.stringify(examples)}
- category: نوع المنتج (طقم سرير، لحاف / كوفرته، بطانيه، فوط وبشاكير، ستائر، مخدات وكوشن، مفارش سفره، ...).
- fabric: الخامة. color: اللون الأساسي بالعربي. pattern: سادة / مشجر / مقلم / كاروهات / مطبوع / مطرز / جاكار / ...
- size: المقاس (سنجل / 1 فرد، دبل / 2 فرد، كينج، أو الأبعاد).
- لو الاسم مفيهوش المعلومة حط null — متخمنش.`,
      content: [{ type: 'text', text: JSON.stringify(batch.map(x => ({ code: x.code, name: x.name }))) }],
      schema: ITEMS_SCHEMA, effort: 'low',
    });
    out.push(...r.items);
  }
  return out;
}

const ANALYST = `أنت مستشار استراتيجي لصاحب مصنع مفروشات ومنسوجات منزلية في مصر، خبير في السوق المصري (تجار الجملة، المعارض، جهاز العرايس، المواسم: رمضان والأعياد والصيف والمدارس والشتا، حساسية الأسعار والتضخم).
اكتب بالعامية المصرية المهنية، بشكل مختصر ومباشر وقابل للتنفيذ، واعتمد فقط على الأرقام اللي في البيانات — لو استنتجت حاجة قول إنها استنتاج.
التنسيق: نص عادي لتليجرام. عناوين قصيرة بإيموجي، ونقاط تبدأ بـ "•". ممنوع Markdown (بدون ** أو #) وممنوع جداول.`;

// تقرير استراتيجي من نتيجة التحليل
async function strategicInsights(compact) {
  return call({
    system: ANALYST,
    content: [{ type: 'text', text: `دي بيانات تحليل المبيعات والمرتجعات والطلبيات للمصنع:\n${JSON.stringify(compact)}\n
اكتب تقرير استراتيجي فيه بالترتيب:
1) 🧭 الصورة في 3 سطور: إيه اللي بيحصل وليه.
2) 🎨 ذوق السوق دلوقتي: الخامات والألوان والنقشات والمقاسات وشرائح السعر اللي السوق رايح لها واللي بيبعد عنها.
3) 🧵 3 إلى 5 موديلات جديدة مقترحة (لكل موديل: الفئة، الخامة، اللون، النقشة، المقاس، شريحة السعر، وليه، وكمية التجربة المقترحة).
4) 🏭 قرارات الإنتاج للأسبوعين الجايين: زوّد / وقّف / عدّل.
5) ↩️ المرتجعات: أهم سبب وإزاي نقفله (جودة، مقاس، عميل معين).
6) 📣 تسويق ومبيعات: عروض لتصريف الراكد، عملاء محتاجين متابعة، والاستعداد للموسم الجاي.
7) ⚠️ مخاطر لازم تاخد بالك منها.
خلّي التقرير أقل من 600 كلمة.` }],
    effort: 'high',
  });
}

// سؤال حر من صاحب المصنع
async function ask(question, compact) {
  return call({
    system: ANALYST,
    content: [{ type: 'text', text: `بيانات المصنع الحالية:\n${JSON.stringify(compact)}\n\nالسؤال: ${question}\nجاوب في أقل من 300 كلمة.` }],
    effort: 'medium',
  });
}

module.exports = { enabled, extractDocument, classifyItems, strategicInsights, ask, MODEL };
