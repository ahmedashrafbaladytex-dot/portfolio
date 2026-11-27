// استلام المستندات من جروبات تليجرام: قراءة بالذكاء الاصطناعي ← تسجيل تلقائي في السيستم
'use strict';

const KINDS = { orders: 'order', invoices: 'sale', returns: 'return' };
const KIND_LABEL = { order: 'طلب', sale: 'فاتورة', return: 'مرتجع' };
const UNKNOWN_CUSTOMER = 'عميل غير محدد ⚠️';

// توحيد الكتابة العربية للمقارنة: أ/إ/آ ← ا، ة ← ه، ى ← ي، من غير تشكيل ومسافات
function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/^(شركه|شركة|مصنع|محلات|محل|معرض|مؤسسه|السيد|الاستاذ|ا\/|أ\/)\s*/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function matchCustomer(name, customers) {
  const n = normalize(name);
  if (!n) return null;
  return customers.find(c => normalize(c.name) === n || c.code.toLowerCase() === String(name).trim().toLowerCase())
    || (n.length >= 4 ? customers.find(c => { const m = normalize(c.name); return m.length >= 4 && (m.includes(n) || n.includes(m)); }) : null)
    || null;
}

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

/**
 * @param {object} deps  { core, extract, aiConfig: () => ({apiKey, quality}|null), log }
 * @returns {(input) => Promise<{status:'ignored'|'failed'|'created', ...}>}
 */
function createIntake({ core, extract, aiConfig, log = console }) {
  return async function ingest({ group, text = '', caption = '', files = [], attachments = [] }) {
    const kind = KINDS[group];
    if (!kind) return { status: 'ignored' };
    const body = String(text || '').trim();
    // كلام عادي من غير صور ولا أرقام (سلام، تمام، ...) مش محتاج نصرف عليه
    if (!files.length && !/[0-9٠-٩]/.test(body)) return { status: 'ignored' };

    const cfg = aiConfig();
    if (!cfg) return { status: 'failed', message: 'الذكاء الاصطناعي مش متفعّل. فعّله من صفحة الإعدادات في السيستم.' };
    if (!core.aiQuota()) return { status: 'failed', message: 'وصلنا للحد اليومي لقراءة الرسايل. زوّده من الإعدادات أو سجّل يدوي.' };

    let result;
    try {
      ({ result } = await extract({ apiKey: cfg.apiKey, quality: cfg.quality, kind, today: core.today(),
        customers: core.listCustomers({}).map(c => ({ name: c.name, code: c.code })), text: body, caption, files }));
    } catch (e) {
      log.error('AI:', e.message);
      return { status: 'failed', message: 'مقدرتش أقرا الرسالة دي دلوقتي. سجّلها يدوي أو ابعتها تاني.' };
    }
    if (!result.relevant) return { status: 'ignored' };
    if (!result.items.length) return { status: 'failed', message: `مش لاقي أصناف في ${KIND_LABEL[kind]} ده. اتأكد إن الصورة واضحة أو اكتب الأصناف.` };

    const review = [];
    if (result.uncertain) review.push(result.uncertain_reason || 'في حاجة مش واضحة في المستند');

    // العميل
    const customers = core.listCustomers({});
    let customer = result.customer_name ? matchCustomer(result.customer_name, customers) : null;
    let newCustomer = false;
    if (!customer && result.customer_name) {
      customer = core.saveCustomer({ name: result.customer_name, phone: result.customer_phone || '' });
      newCustomer = true;
      review.push(`عميل جديد اتضاف: ${result.customer_name}`);
    }
    if (!customer) {
      customer = customers.find(c => c.name === UNKNOWN_CUSTOMER) || core.saveCustomer({ name: UNKNOWN_CUSTOMER });
      review.push('اسم العميل مش موجود في المستند');
    }

    const today = core.today();
    const date = isDate(result.date) && result.date <= addDays(today, 1) ? result.date : today;
    const items = result.items.map(i => ({ product: i.product, quantity: i.quantity, unit: i.unit || 'قطعة', price: i.price ?? 0 }));
    const total = items.reduce((s, i) => s + i.quantity * i.price, 0);
    if (kind !== 'order' && items.some(i => !i.price)) review.push('في أصناف من غير سعر');
    if (result.written_total != null && items.every(i => i.price) && Math.abs(result.written_total - total) > 1)
      review.push(`الإجمالي المكتوب (${result.written_total}) مختلف عن حساب الأصناف (${total})`);
    const notes = [result.notes, caption].filter(Boolean).join('\n').slice(0, 2000);
    const common = { customer_id: customer.id, items, notes, source: 'telegram', attachments, ref_number: result.document_number || '' };

    let record;
    if (kind === 'order') {
      let due = isDate(result.due_date) && result.due_date >= date ? result.due_date : null;
      if (!due) { due = addDays(date, 7); review.push('ميعاد التسليم مش مكتوب، اتحط بعد أسبوع'); }
      record = core.createOrder({ ...common, order_date: date, due_date: due, review_note: review.join(' • ') });
    } else {
      let order_code = '', original_code = '';
      if (kind === 'sale' && result.order_reference) {
        const o = core.getOrderByCode(result.order_reference);
        if (o && o.customer_id === customer.id) order_code = o.code;
        else review.push(`كود الطلب ${result.order_reference} مش متطابق`);
      }
      if (kind === 'return' && result.invoice_reference) {
        const inv = core.findInvoice(result.invoice_reference, { kind: 'sale', customerId: customer.id });
        if (inv) original_code = inv.code;
        else review.push(`الفاتورة الأصلية ${result.invoice_reference} مش لاقيها`);
      }
      record = core.createInvoice({ ...common, kind, invoice_date: date, order_code, original_code, review_note: review.join(' • ') });
    }
    return { status: 'created', entity: kind === 'order' ? 'order' : 'invoice', kind, record, review, newCustomer };
  };
}

module.exports = { createIntake, matchCustomer, normalize, KINDS, KIND_LABEL };
