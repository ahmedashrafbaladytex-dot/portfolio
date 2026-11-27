// قراءة الطلبات والفواتير (كتابة أو صور ورق مكتوب بخط الإيد) بالذكاء الاصطناعي - Claude
'use strict';

const MODELS = {
  accurate: 'claude-opus-5-5', // أدق قراءة للخط اليدوي
  economy: 'claude-haiku-5-5', // أرخص بكتير، مناسب للرسايل المكتوبة الواضحة
};

const KIND_AR = { order: 'طلب عميل', sale: 'فاتورة مبيعات لعميل', return: 'فاتورة مرتجع من عميل' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevant', 'customer_name', 'customer_phone', 'document_number', 'date', 'due_date', 'order_reference',
    'invoice_reference', 'items', 'written_total', 'notes', 'uncertain', 'uncertain_reason'],
  properties: {
    relevant: { type: 'boolean', description: 'true لو الرسالة فعلاً فيها مستند (طلب/فاتورة/مرتجع)، false لو كلام عادي أو تحية' },
    customer_name: { type: ['string', 'null'], description: 'اسم العميل. لو يطابق عميل من القائمة اكتبه بنفس كتابته في القائمة بالظبط' },
    customer_phone: { type: ['string', 'null'] },
    document_number: { type: ['string', 'null'], description: 'رقم الفاتورة/الطلب المكتوب على الورقة نفسها لو موجود' },
    date: { type: ['string', 'null'], description: 'تاريخ المستند بصيغة YYYY-MM-DD' },
    due_date: { type: ['string', 'null'], description: 'ميعاد التسليم المطلوب (للطلبات) بصيغة YYYY-MM-DD' },
    order_reference: { type: ['string', 'null'], description: 'كود طلب مذكور زي ORD-2026-0001' },
    invoice_reference: { type: ['string', 'null'], description: 'في المرتجع: رقم أو كود الفاتورة الأصلية' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'quantity', 'unit', 'price'],
        properties: {
          product: { type: 'string', description: 'اسم الصنف بالمواصفات (المقاس، اللون، الخامة)' },
          quantity: { type: 'number' },
          unit: { type: ['string', 'null'], description: 'قطعة، متر، كيلو، طقم، دستة...' },
          price: { type: ['number', 'null'], description: 'سعر الوحدة لو مكتوب' },
        },
      },
    },
    written_total: { type: ['number', 'null'], description: 'الإجمالي المكتوب على الورقة لو موجود' },
    notes: { type: ['string', 'null'] },
    uncertain: { type: 'boolean', description: 'true لو في أي جزء مش واضح أو مش متأكد منه' },
    uncertain_reason: { type: ['string', 'null'], description: 'إيه اللي مش واضح، بالعامية المصرية وباختصار' },
  },
};

function systemPrompt() {
  return `إنت بتقرا مستندات مصنع مصري (مفروشات ومنسوجات) اتبعتت على جروب تليجرام، وبتطلّع منها بيانات منظمة.
المستند ممكن يكون رسالة شات مكتوبة بالعامية، أو صورة ورقة مكتوبة بخط الإيد أو مطبوعة.

قواعد:
- الأرقام ممكن تكون عربي (٠١٢٣) أو إنجليزي. حوّلها لأرقام عادية.
- المقاسات زي 50×100 أو 50*100 جزء من اسم الصنف، مش كمية.
- "دستة" = وحدة، متسيبهاش تتحول لـ 12 قطعة؛ اكتب الكمية زي ما هي والوحدة "دستة".
- لو اسم العميل قريب من اسم في قائمة العملاء الموجودين (حتى لو مكتوب بشكل مختلف شوية)، استخدم الاسم من القائمة بالظبط.
- التواريخ: لو مكتوب يوم وشهر بس، استخدم السنة الحالية. لو مكتوب "بكرة" أو "الخميس الجاي" احسبها من تاريخ النهارده.
- ما تخترعش أي معلومة مش موجودة. اللي مش موجود خليه null.
- لو حاجة مش مقروءة أو مش متأكد منها: uncertain = true واكتب السبب.
- لو الرسالة مجرد كلام عادي (سلام، سؤال، رد) ومفيهاش مستند: relevant = false.`;
}

function userText({ kind, today, customers, caption, text }) {
  const list = customers.length ? customers.map(c => `- ${c.name} (${c.code})`).join('\n') : '(لسه مفيش عملاء)';
  return `نوع المستند المتوقع (حسب الجروب): ${KIND_AR[kind]}
تاريخ النهارده: ${today}

العملاء الموجودين:
${list}
${caption ? `\nالكلام المكتوب مع الصورة:\n${caption}` : ''}${text ? `\nالرسالة:\n${text}` : ''}`;
}

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {'accurate'|'economy'} [o.quality]
 * @param {'order'|'sale'|'return'} o.kind
 * @param {Array<{data: Buffer, mediaType: string}>} [o.files] صور أو PDF
 */
async function extract({ apiKey, quality = 'accurate', kind, today, customers = [], text = '', caption = '', files = [] }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey, maxRetries: 2, timeout: 120_000 });
  const content = [];
  for (const f of files) {
    const data = f.data.toString('base64');
    content.push(f.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: f.mediaType, data } });
  }
  content.push({ type: 'text', text: userText({ kind, today, customers: customers.slice(0, 400), caption, text }) });

  const model = MODELS[quality] || MODELS.accurate;
  const params = {
    model,
    max_tokens: 16000,
    system: systemPrompt(),
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
  };
  // على Opus: لو اترفض الطلب لأسباب أمان، الـ API يعيده على موديل تاني تلقائي
  const response = model === MODELS.accurate
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);

  if (response.stop_reason === 'refusal') throw new Error('الذكاء الاصطناعي رفض يقرا المستند ده');
  if (response.stop_reason === 'max_tokens') throw new Error('المستند طويل جدًا');
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('مفيش رد من الذكاء الاصطناعي');
  const result = JSON.parse(block.text);
  result.items = (result.items || []).filter(i => i && String(i.product || '').trim() && Number(i.quantity) > 0);
  return { result, usage: response.usage, model: response.model };
}

async function checkKey(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey, maxRetries: 1, timeout: 20_000 });
  try {
    await client.models.retrieve(MODELS.economy);
    return true;
  } catch (e) {
    if (e instanceof (Anthropic.AuthenticationError || Anthropic.default.AuthenticationError)) return false;
    if (e instanceof (Anthropic.PermissionDeniedError || Anthropic.default.PermissionDeniedError)) return false;
    throw e;
  }
}

module.exports = { extract, checkKey, MODELS, SCHEMA };
