// قراءة ملفات الفواتير (Excel / CSV) وتحويلها لمستندات موحدة
'use strict';

const { readXlsx } = require('./xlsx');
const { norm, toNumber, toDate, today } = require('./util');

// ترتيب الكلمات مهم: الأدق الأول
const FIELD_RULES = [
  ['reason', ['سبب', 'reason']],
  ['customer', ['اسم العميل', 'العميل', 'عميل', 'الزبون', 'customer', 'client']],
  ['date', ['تاريخ', 'date']],
  ['doc_no', ['رقم الفاتوره', 'رقم المستند', 'رقم الطلب', 'رقم الاذن', 'رقم المرتجع', 'فاتوره', 'مستند', 'طلبيه', 'invoice', 'order no', 'doc no']],
  ['item_code', ['كود الصنف', 'كود الموديل', 'رقم الصنف', 'الكود', 'كود', 'باركود', 'sku', 'code', 'barcode']],
  ['qty', ['الكميه', 'كميه', 'العدد', 'عدد', 'qty', 'quantity', 'الرصيد', 'رصيد', 'المخزون', 'stock']],
  ['price', ['سعر', 'price']],
  ['total', ['الاجمالي', 'اجمالي', 'القيمه', 'قيمه', 'المبلغ', 'مبلغ', 'total', 'amount', 'value']],
  ['color', ['اللون', 'لون', 'color', 'colour']],
  ['size', ['المقاس', 'مقاس', 'size']],
  ['fabric', ['الخامه', 'خامه', 'القماش', 'قماش', 'fabric', 'material']],
  ['pattern', ['النقشه', 'نقشه', 'التصميم', 'الديزاين', 'pattern', 'design']],
  ['category', ['الفئه', 'فئه', 'القسم', 'المجموعه', 'التصنيف', 'نوع الصنف', 'category', 'group']],
  ['item_name', ['اسم الصنف', 'الصنف', 'صنف', 'البيان', 'بيان', 'الوصف', 'الموديل', 'موديل', 'المنتج', 'منتج', 'item', 'product', 'description', 'name']],
];

function fieldOf(header) {
  const h = norm(header);
  if (!h) return null;
  if (h.includes('عميل') && h.includes('كود')) return 'customer_code';
  if (h === 'رقم' || h === 'no' || h === 'م' || h === '#') return null;
  for (const [field, words] of FIELD_RULES) if (words.some(w => h === norm(w))) return field;
  for (const [field, words] of FIELD_RULES) if (words.some(w => h.includes(norm(w)))) return field;
  return null;
}

function mapHeader(row) {
  const map = {};
  (row || []).forEach((cell, i) => {
    const f = fieldOf(cell);
    if (f && f !== 'customer_code' && map[f] == null) map[f] = i;
  });
  return map;
}

// CSV بسيط يدعم علامات التنصيص والفاصلة أو الفاصلة المنقوطة أو التاب
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readTable(buf, fileName) {
  const n = (fileName || '').toLowerCase();
  if (n.endsWith('.xls')) throw new Error('صيغة .xls القديمة مش مدعومة. افتح الملف في Excel واحفظه باسم (Save As) بصيغة xlsx وابعته تاني.');
  if (n.endsWith('.xlsx') || n.endsWith('.xlsm') || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const sheets = readXlsx(buf);
    // اختار أول شيت فيه جدول مفهوم
    let best = null;
    for (const sh of sheets) {
      const t = locateTable(sh.rows);
      if (t && (!best || t.score > best.score)) best = t;
    }
    return best;
  }
  return locateTable(parseCsv(buf.toString('utf8')));
}

// يدور على صف العناوين في أول 20 صف، ويقرأ البيانات اللي فوقه (عميل/تاريخ/رقم فاتورة)
function locateTable(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const map = mapHeader(rows[r]);
    const score = Object.keys(map).length;
    if ((map.item_code != null || map.item_name != null) && score >= 2 && (!best || score > best.score)) best = { r, map, score };
  }
  if (!best) return null;
  return { header: best.map, rows: rows.slice(best.r + 1), meta: headerMeta(rows.slice(0, best.r)), score: best.score };
}

function headerMeta(rows) {
  const meta = {};
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell == null || cell === '') continue;
      const s = String(cell);
      // "العميل: محمد" في نفس الخانة، أو العنوان في خانة والقيمة في اللي بعدها
      const m = s.match(/^([^:：]+)[:：]\s*(.+)$/);
      const label = m ? m[1] : s;
      let value = m ? m[2] : null;
      if (value == null) {
        for (let j = i + 1; j < row.length; j++) if (row[j] != null && row[j] !== '') { value = row[j]; break; }
      }
      const f = fieldOf(label);
      if (value != null && ['customer', 'date', 'doc_no'].includes(f) && meta[f] == null) meta[f] = value;
    }
  }
  return meta;
}

const TOTAL_ROW = /^(الاجمالي|اجمالي|الاجمالى|المجموع|total|subtotal|الصافي|صافي)/;

// يحوّل الجدول لسطور موحدة
function tableToLines(table) {
  const { header: h, rows } = table;
  const cell = (row, f) => (h[f] != null ? row[h[f]] : null);
  const out = [];
  for (const row of rows) {
    if (!row || row.every(c => c == null || c === '')) continue;
    const name = cell(row, 'item_name'), code = cell(row, 'item_code');
    if ((name == null || name === '') && (code == null || code === '')) continue;
    if (TOTAL_ROW.test(norm(name || code))) continue;
    let qty = toNumber(cell(row, 'qty'));
    let price = toNumber(cell(row, 'price'));
    let total = toNumber(cell(row, 'total'));
    if (qty != null) qty = Math.abs(qty);
    if (total != null) total = Math.abs(total);
    if (qty == null && total != null && price) qty = total / price;
    if (total == null && qty != null && price != null) total = qty * price;
    if (price == null && qty && total != null) price = total / qty;
    out.push({
      doc_no: str(cell(row, 'doc_no')), date: cell(row, 'date'), customer: str(cell(row, 'customer')),
      item_code: str(code), item_name: str(name), qty: qty ?? 0, price: price ?? 0, total: total ?? 0,
      reason: str(cell(row, 'reason')), color: str(cell(row, 'color')), size: str(cell(row, 'size')),
      fabric: str(cell(row, 'fabric')), pattern: str(cell(row, 'pattern')), category: str(cell(row, 'category')),
    });
  }
  return out;
}
const str = v => (v == null ? '' : typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v).trim());

// يجمّع السطور في مستندات حسب رقم الفاتورة (مع ملء الخانات الفاضية من السطر اللي فوقها)
function groupDocs(lines, meta = {}, fallbackDate = today()) {
  const docs = new Map();
  const hasCustomerCol = lines.some(l => l.customer);
  let last = { doc_no: str(meta.doc_no), date: meta.date, customer: str(meta.customer) };
  for (const l of lines) {
    const doc_no = l.doc_no || last.doc_no;
    const date = l.date != null && l.date !== '' ? l.date : last.date;
    const customer = hasCustomerCol ? (l.customer || (doc_no === last.doc_no ? last.customer : '')) : str(meta.customer);
    last = { doc_no, date, customer };
    const key = doc_no || '__single__';
    if (!docs.has(key)) docs.set(key, { doc_no, doc_date: toDate(date) || toDate(meta.date) || fallbackDate, customer, lines: [] });
    const d = docs.get(key);
    if (!d.customer && customer) d.customer = customer;
    d.lines.push(l);
  }
  return [...docs.values()];
}

// تحديد نوع الملف من الكابشن أو اسم الملف
function detectType(...texts) {
  const t = norm(texts.filter(Boolean).join(' '));
  if (!t) return null;
  if (/مرتجع|مرتجعات|ارتجاع|return/.test(t)) return 'return';
  if (/طلبي|طلبات|اوردر|order/.test(t)) return 'order';
  if (/مخزون|رصيد|جرد|stock|inventory/.test(t)) return 'stock';
  if (/بيانات الاصناف|اصناف|كتالوج|items|catalog/.test(t)) return 'items';
  if (/مبيعات|بيع|فاتوره|فواتير|sale|invoice/.test(t)) return 'sale';
  return null;
}

function parseFile(buf, fileName) {
  const table = readTable(buf, fileName);
  if (!table) throw new Error('مش لاقي جدول أصناف في الملف. لازم يكون فيه عمود «الصنف» أو «كود الصنف» وعمود «الكمية».');
  const lines = tableToLines(table);
  if (!lines.length) throw new Error('الجدول فاضي — مفيش سطور أصناف.');
  return { lines, meta: table.meta, columns: Object.keys(table.header) };
}

module.exports = { parseFile, parseCsv, groupDocs, detectType, tableToLines, locateTable, fieldOf };
