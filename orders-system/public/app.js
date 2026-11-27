'use strict';
/* نظام طلبات العملاء - الواجهة */

const STATUS = { new: 'جديد', in_progress: 'قيد التنفيذ', ready: 'جاهز للتسليم', delivered: 'تم التسليم', cancelled: 'ملغي' };
const STATUS_COLOR = { new: '#1d4ed8', in_progress: '#d97706', ready: '#7c3aed', delivered: '#059669', cancelled: '#94a3b8' };
const UNITS = ['قطعة', 'متر', 'كيلو', 'طقم', 'دستة', 'ثوب', 'رول', 'كرتونة'];
const $app = document.getElementById('app');
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let TODAY = ymd(new Date());

// ---------- أدوات ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); };

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('لازم تسجل دخول'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حصل خطأ');
  return data;
}

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (error ? ' error' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.className = '', 3000);
}

const statusPill = s => `<span class="pill s-${s}">${STATUS[s] || s}</span>`;
function duePill(o) {
  if (o.days_late > 0) return `<span class="pill late-pill">متأخر ${o.days_late} يوم</span>`;
  if (!['delivered', 'cancelled'].includes(o.status)) {
    if (o.due_date === TODAY) return `<span class="pill soon-pill">التسليم النهارده</span>`;
    if (o.due_date <= addDays(TODAY, 3)) return `<span class="pill soon-pill">قرب ميعاده</span>`;
  }
  return '';
}
const urgentPill = o => o.priority === 'urgent' ? ' <span class="pill urgent-pill">عاجل</span>' : '';
const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();

function statusSelect(o) {
  return `<select class="status-select s-${o.status}" data-status-of="${o.id}" onclick="event.stopPropagation()">
    ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
}
function bindStatusSelects(root, after) {
  root.querySelectorAll('[data-status-of]').forEach(sel => sel.addEventListener('change', async () => {
    try {
      await api(`orders/${sel.dataset.statusOf}/status`, { method: 'POST', body: { status: sel.value } });
      toast('تم تحديث الحالة: ' + STATUS[sel.value]);
      after ? after() : route();
    } catch (e) { toast(e.message, true); }
  }));
}

function ordersTable(rows, { showCustomer = true, empty = 'لا توجد طلبات' } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>كود الطلب</th>${showCustomer ? '<th>العميل</th>' : ''}<th>الأصناف</th><th class="num">الكمية</th><th class="num">القيمة</th>
    <th class="num">المتبقي</th><th>تاريخ الطلب</th><th>موعد التسليم</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${rows.map(o => `<tr class="clickable ${o.days_late > 0 ? 'late-row' : ''}" data-href="#/orders/${o.id}">
      <td><span class="code">${esc(o.code)}</span>${urgentPill(o)}</td>
      ${showCustomer ? `<td>${esc(o.customer_name)}<div class="muted code" style="font-size:12px">${esc(o.customer_code)}</div></td>` : ''}
      <td title="${esc(o.products)}">${esc((o.products || '').slice(0, 45))}${(o.products || '').length > 45 ? '…' : ''}</td>
      <td class="num">${qty(o.total_qty)}</td>
      <td class="num">${money(o.total)}</td>
      <td class="num">${o.total - o.paid > 0 ? money(o.total - o.paid) : '<span class="muted">—</span>'}</td>
      <td>${fmtDate(o.order_date)}</td>
      <td>${fmtDate(o.due_date)} ${duePill(o)}</td>
      <td>${statusSelect(o)}</td>
      <td><a class="btn sm no-print" href="#/orders/${o.id}/edit" onclick="event.stopPropagation()">تعديل</a></td>
    </tr>`).join('')}</tbody></table></div>`;
}
function bindRows(root) {
  root.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => location.hash = tr.dataset.href));
}

function codeChips(orders) {
  return `<div class="codes">${orders.map(o => {
    const cls = o.days_late > 0 ? 'late' : o.status === 'delivered' ? 'done' : o.status === 'cancelled' ? 'cancel' : '';
    return `<a class="code ${cls}" href="#/orders/${o.id}" title="${STATUS[o.status]}">${esc(o.code)}</a>`;
  }).join('')}</div>`;
}

// محرر الأصناف (مشترك بين الطلب والفاتورة)
function itemsEditor(tbody, initial, onChange) {
  const addRow = (it = { product: '', quantity: 1, unit: 'قطعة', price: 0 }) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input data-k="product" value="${esc(it.product)}" placeholder="مثال: فوطة قطن 50×100 أبيض"></td>
      <td><input data-k="quantity" type="number" min="0" step="any" value="${it.quantity}"></td>
      <td><input data-k="unit" list="units" value="${esc(it.unit)}"></td>
      <td><input data-k="price" type="number" min="0" step="any" value="${it.price}"></td>
      <td class="num" data-line>0</td>
      <td><button type="button" class="btn sm danger" title="حذف">✕</button></td>`;
    tr.querySelector('button').onclick = () => { if (tbody.children.length > 1) tr.remove(); else tr.querySelectorAll('input').forEach(i => i.value = i.dataset.k === 'unit' ? 'قطعة' : ''); calc(); };
    tbody.appendChild(tr);
    return tr;
  };
  const calc = () => {
    let sum = 0, q = 0;
    [...tbody.children].forEach(tr => {
      const v = k => Number(tr.querySelector(`[data-k=${k}]`).value) || 0;
      const line = v('quantity') * v('price'); sum += line; q += v('quantity');
      tr.querySelector('[data-line]').textContent = money(line);
    });
    onChange(sum, q);
  };
  initial.forEach(addRow); calc();
  tbody.addEventListener('input', calc);
  return { addRow, calc, items: () => [...tbody.children].map(tr => Object.fromEntries([...tr.querySelectorAll('input')].map(i => [i.dataset.k, i.value]))) };
}
const ITEMS_TABLE = `<div class="table-wrap"><table class="items-table"><thead><tr><th style="width:40%">الصنف / الوصف</th><th>الكمية</th><th>الوحدة</th><th>سعر الوحدة</th><th class="num">الإجمالي</th><th></th></tr></thead>
  <tbody id="items"></tbody></table></div><datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist>`;

function reviewBanner(type, rec) {
  if (!rec.review_note) return '';
  return `<div class="card review-banner no-print"><div><b>⚠️ محتاج مراجعة:</b> ${esc(rec.review_note)}</div>
    <div class="actions"><a class="btn sm" href="#/${type === 'order' ? 'orders' : 'invoices'}/${rec.id}/edit">✏️ تعديل</a>
    <button class="btn sm primary" data-review-done="${type}:${rec.id}">✔ تمت المراجعة</button></div></div>`;
}
function bindReviewDone(root, after) {
  root.querySelectorAll('[data-review-done]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const [type, id] = b.dataset.reviewDone.split(':');
    try { await api(`review/${type}/${id}`, { method: 'POST' }); toast('تمت المراجعة ✔'); after ? after() : route(); } catch (err) { toast(err.message, true); }
  });
}
function attachmentsCard(list) {
  if (!list || !list.length) return '';
  return `<div class="card"><h2>📎 الصورة الأصلية (من تليجرام)</h2><div class="attachments">${list.map(f => f.endsWith('.pdf')
    ? `<a class="btn" href="/uploads/${esc(f)}" target="_blank">📄 فتح ملف PDF</a>`
    : `<a href="/uploads/${esc(f)}" target="_blank"><img src="/uploads/${esc(f)}" alt="صورة المستند" loading="lazy"></a>`).join('')}</div></div>`;
}
const sourcePill = r => r.source === 'telegram' ? ' <span class="pill tg-pill" title="اتسجل تلقائي من تليجرام">✈️ تليجرام</span>' : '';
const reviewPill = r => r.review_note ? ' <span class="pill soon-pill" title="' + esc(r.review_note) + '">⚠️ مراجعة</span>' : '';

// ---------- الفواتير والمرتجعات ----------
const KIND = { sale: { title: 'فواتير المبيعات', one: 'فاتورة', icon: '🧾', path: 'invoices' }, return: { title: 'فواتير المرتجعات', one: 'مرتجع', icon: '↩️', path: 'returns' } };

function invoicesTable(rows, { showCustomer = true, empty = 'لا توجد فواتير' } = {}) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>الكود</th><th>رقم الورقة</th>${showCustomer ? '<th>العميل</th>' : ''}<th>الأصناف</th><th class="num">الكمية</th><th class="num">القيمة</th><th>التاريخ</th><th>مربوطة بـ</th></tr></thead>
    <tbody>${rows.map(v => `<tr class="clickable" data-href="#/invoices/${v.id}">
      <td><span class="code">${esc(v.code)}</span>${sourcePill(v)}${reviewPill(v)}</td>
      <td class="code">${esc(v.ref_number) || '<span class="muted">—</span>'}</td>
      ${showCustomer ? `<td>${esc(v.customer_name)}<div class="muted code" style="font-size:12px">${esc(v.customer_code)}</div></td>` : ''}
      <td title="${esc(v.products)}">${esc((v.products || '').slice(0, 45))}${(v.products || '').length > 45 ? '…' : ''}</td>
      <td class="num">${qty(v.total_qty)}</td><td class="num">${money(v.total)}</td><td>${fmtDate(v.invoice_date)}</td>
      <td class="code">${esc(v.order_code || v.original_code || '') || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}

async function pageInvoices(kind, params) {
  const k = KIND[kind];
  const f = { kind, search: params.get('search') || '', from: params.get('from') || '', to: params.get('to') || '' };
  const rows = await api('invoices?' + qs(f));
  $app.innerHTML = `
  <div class="page-head"><div><h1>${k.icon} ${k.title}</h1><p>${rows.length} ${k.one} · القيمة ${money(rows.reduce((s, v) => s + v.total, 0))} جنيه</p></div>
    <div class="actions"><button class="btn" onclick="location.href='/api/export/invoices.csv?${qs(f)}'">⬇ تصدير Excel</button><button class="btn" onclick="print()">🖨 طباعة</button>
    <a class="btn primary" href="#/${k.path}/new">＋ ${k.one} جديد${kind === 'sale' ? 'ة' : ''}</a></div></div>
  <div class="card">
    <form class="filters" id="f">
      <div class="field" style="flex:1;min-width:220px"><label>بحث</label><input name="search" value="${esc(f.search)}" placeholder="الكود، رقم الورقة، العميل، صنف…"></div>
      <div class="field"><label>من تاريخ</label><input type="date" name="from" value="${f.from}"></div>
      <div class="field"><label>إلى تاريخ</label><input type="date" name="to" value="${f.to}"></div>
      <button class="btn primary">بحث</button><a class="btn ghost" href="#/${k.path}">مسح</a>
    </form>
    ${invoicesTable(rows, { empty: `لسه مفيش ${k.title}` })}
  </div>`;
  bindRows($app);
  const form = document.getElementById('f');
  form.addEventListener('submit', e => { e.preventDefault(); location.hash = `#/${k.path}?` + qs(Object.fromEntries(new FormData(form))); });
}

async function pageInvoice(id) {
  const v = await api('invoices/' + id);
  const k = KIND[v.kind];
  $app.innerHTML = `
  <div class="page-head"><div><h1>${k.icon} ${k.one} <span class="code">${esc(v.code)}</span>${sourcePill(v)}</h1>
    <p>${v.ref_number ? 'رقم الورقة: <span class="code">' + esc(v.ref_number) + '</span>' : ''}</p></div>
    <div class="actions"><button class="btn" onclick="print()">🖨 طباعة</button><a class="btn" href="#/invoices/${v.id}/edit">✏️ تعديل</a>
    <button class="btn danger" id="del">🗑 حذف</button></div></div>
  ${reviewBanner('invoice', v)}
  <div class="card"><div class="detail-grid">
    <div><small>العميل</small><b><a href="#/customers/${v.customer_id}">${esc(v.customer_name)}</a></b> <span class="code muted">${esc(v.customer_code)}</span></div>
    <div><small>التليفون</small><b class="code">${esc(v.customer_phone) || '—'}</b></div>
    <div><small>التاريخ</small><b>${fmtDate(v.invoice_date)}</b></div>
    ${v.kind === 'sale' ? `<div><small>الطلب</small><b>${v.order_id ? `<a class="code" href="#/orders/${v.order_id}">${esc(v.order_code)}</a>` : '—'}</b></div>`
      : `<div><small>الفاتورة الأصلية</small><b>${v.original_invoice_id ? `<a class="code" href="#/invoices/${v.original_invoice_id}">${esc(v.original_code)}</a>` : '—'}</b></div>`}
    ${v.returns.length ? `<div><small>مرتجعات عليها</small><b>${v.returns.map(r => `<a class="code" href="#/invoices/${r.id}">${esc(r.code)}</a>`).join('، ')}</b></div>` : ''}
  </div></div>
  <div class="card"><h2>الأصناف</h2><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>الصنف</th><th class="num">الكمية</th><th>الوحدة</th><th class="num">سعر الوحدة</th><th class="num">الإجمالي</th></tr></thead>
    <tbody>${v.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.product)}</td><td class="num">${qty(i.quantity)}</td><td>${esc(i.unit)}</td>
      <td class="num">${money(i.price)}</td><td class="num">${money(i.quantity * i.price)}</td></tr>`).join('')}</tbody>
  </table></div><div class="totals"><span>الإجمالي: <b>${money(v.total)}</b> ج</span></div></div>
  ${v.notes ? `<div class="card"><h2>ملاحظات</h2><div style="white-space:pre-wrap">${esc(v.notes)}</div></div>` : ''}
  ${attachmentsCard(v.attachments)}`;
  bindReviewDone($app);
  document.getElementById('del').onclick = async () => {
    if (!(await confirmDialog(`متأكد إنك عايز تحذف ${k.one} ${v.code} نهائيًا؟`))) return;
    try { await api('invoices/' + v.id, { method: 'DELETE' }); toast('اتحذف'); location.hash = '#/' + k.path; } catch (e) { toast(e.message, true); }
  };
}

async function pageInvoiceForm(kind, id) {
  const [customers, inv] = await Promise.all([api('customers'), id ? api('invoices/' + id) : null]);
  kind = inv ? inv.kind : kind;
  const k = KIND[kind];
  const v = inv || { customer_id: new URLSearchParams(location.hash.split('?')[1]).get('customer') || '', invoice_date: TODAY, ref_number: '', notes: '',
    order_code: '', original_code: '', items: [{ product: '', quantity: 1, unit: 'قطعة', price: 0 }] };
  $app.innerHTML = `
  <div class="page-head"><div><h1>${inv ? `تعديل ${k.one} <span class="code">${esc(inv.code)}</span>` : `${k.one} ${kind === 'sale' ? 'جديدة' : 'جديد'}`}</h1>
    <p>${inv ? '' : 'الكود هيتعمل تلقائي بعد الحفظ'}</p></div></div>
  <form id="vf">
    <div class="card"><h2>البيانات</h2><div class="form-grid">
      <div class="field"><label class="req">العميل</label>
        <div style="display:flex;gap:6px"><select name="customer_id" id="custSel" required><option value="">— اختر العميل —</option>
          ${customers.map(c => `<option value="${c.id}" ${String(c.id) === String(v.customer_id) ? 'selected' : ''}>${esc(c.name)} (${esc(c.code)})</option>`).join('')}
        </select><button type="button" class="btn" id="newCust" title="عميل جديد">＋</button></div></div>
      <div class="field"><label class="req">التاريخ</label><input type="date" name="invoice_date" value="${v.invoice_date}" required></div>
      <div class="field"><label>رقم الورقة</label><input name="ref_number" value="${esc(v.ref_number)}" style="direction:ltr" placeholder="الرقم المكتوب على الفاتورة"></div>
      ${kind === 'sale' ? `<div class="field"><label>كود الطلب (لو مربوطة بطلب)</label><input name="order_code" value="${esc(v.order_code || '')}" style="direction:ltr" placeholder="ORD-2026-0001"></div>`
        : `<div class="field"><label>الفاتورة الأصلية</label><input name="original_code" value="${esc(v.original_code || '')}" style="direction:ltr" placeholder="INV-2026-0001 أو رقم الورقة"></div>`}
      <div class="field full"><label>ملاحظات</label><textarea name="notes">${esc(v.notes)}</textarea></div>
    </div></div>
    <div class="card"><h2>الأصناف <button type="button" class="btn sm" id="addItem">＋ إضافة صنف</button></h2>
      ${ITEMS_TABLE}<div class="totals"><span>إجمالي الكمية: <b id="tQty">0</b></span><span>الإجمالي: <b id="tSum">0</b> ج</span></div></div>
    <div class="actions" style="justify-content:flex-end"><a class="btn" href="${inv ? '#/invoices/' + inv.id : '#/' + k.path}">إلغاء</a>
      <button class="btn primary" type="submit">💾 حفظ</button></div>
  </form>`;
  const ed = itemsEditor(document.getElementById('items'), v.items, (sum, q) => {
    document.getElementById('tQty').textContent = qty(q); document.getElementById('tSum').textContent = money(sum);
  });
  document.getElementById('addItem').onclick = () => ed.addRow().querySelector('input').focus();
  document.getElementById('newCust').onclick = async () => {
    const c = await customerDialog(); if (c) document.getElementById('custSel').add(new Option(`${c.name} (${c.code})`, c.id, true, true));
  };
  const form = document.getElementById('vf');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(form)), kind, items: ed.items() };
    try {
      const saved = await api(inv ? 'invoices/' + inv.id : 'invoices', { method: inv ? 'PUT' : 'POST', body });
      toast(`اتحفظ ${saved.code} ✔`); location.hash = '#/invoices/' + saved.id;
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- محتاج مراجعة ----------
async function pageReview() {
  const r = await api('review');
  const n = r.orders.length + r.invoices.length;
  $app.innerHTML = `
  <div class="page-head"><div><h1>⚠️ محتاج مراجعة</h1><p>حاجات اتسجلت تلقائي من تليجرام والذكاء الاصطناعي مكانش متأكد منها. راجعها وعدّل لو محتاج، وبعدين دوس "تمت المراجعة".</p></div></div>
  ${n ? '' : '<div class="card empty">👏 مفيش حاجة محتاجة مراجعة</div>'}
  ${r.orders.map(o => `<div class="card review-item"><div class="review-head"><a href="#/orders/${o.id}"><b class="code">${esc(o.code)}</b></a> · 📦 طلب · ${esc(o.customer_name)} · ${fmtDate(o.order_date)}
    <span class="muted">${esc((o.products || '').slice(0, 60))}</span></div>
    <div class="review-note">${esc(o.review_note)}</div>
    <div class="actions"><a class="btn sm" href="#/orders/${o.id}">عرض</a><a class="btn sm" href="#/orders/${o.id}/edit">✏️ تعديل</a>
    <button class="btn sm primary" data-review-done="order:${o.id}">✔ تمت المراجعة</button></div></div>`).join('')}
  ${r.invoices.map(v => `<div class="card review-item"><div class="review-head"><a href="#/invoices/${v.id}"><b class="code">${esc(v.code)}</b></a> · ${KIND[v.kind].icon} ${KIND[v.kind].one} · ${esc(v.customer_name)} · ${fmtDate(v.invoice_date)}
    <span class="muted">${esc((v.products || '').slice(0, 60))}</span></div>
    <div class="review-note">${esc(v.review_note)}</div>
    <div class="actions"><a class="btn sm" href="#/invoices/${v.id}">عرض</a><a class="btn sm" href="#/invoices/${v.id}/edit">✏️ تعديل</a>
    <button class="btn sm primary" data-review-done="invoice:${v.id}">✔ تمت المراجعة</button></div></div>`).join('')}`;
  bindReviewDone($app);
}

// ---------- لوحة التحكم ----------
async function pageDashboard() {
  const d = await api('dashboard');
  const c = d.counts;
  const total = d.byStatus.reduce((s, x) => s + x.n, 0) || 1;
  $app.innerHTML = `
  <div class="page-head"><div><h1>لوحة التحكم</h1><p>${fmtDate(d.today)}</p></div>
    <div class="actions"><a class="btn primary" href="#/orders/new">＋ طلب جديد</a></div></div>
  <div class="stats">
    <a class="stat danger" href="#/late"><div class="n">${c.late || 0}</div><div class="l">طلبات متأخرة</div></a>
    <a class="stat warn" href="#/orders?due_soon=1"><div class="n">${c.due_soon || 0}</div><div class="l">تسليمها خلال ٣ أيام</div></a>
    <a class="stat" href="#/orders?open=1"><div class="n">${c.open || 0}</div><div class="l">طلبات مفتوحة</div></a>
    <a class="stat ok" href="#/orders?status=delivered"><div class="n">${c.delivered_today || 0}</div><div class="l">اتسلمت النهارده</div></a>
    <a class="stat violet" href="#/orders"><div class="n">${c.this_month || 0}</div><div class="l">طلبات الشهر ده · ${money(d.month_value)} ج</div></a>
    <a class="stat" href="#/customers"><div class="n">${d.customers}</div><div class="l">عدد العملاء</div></a>
    ${d.review ? `<a class="stat warn" href="#/review"><div class="n">${d.review}</div><div class="l">⚠️ محتاج مراجعة</div></a>` : ''}
    ${d.month_sales || d.month_returns ? `<a class="stat ok" href="#/invoices"><div class="n">${money(d.month_sales - d.month_returns)}</div><div class="l">صافي مبيعات الشهر (ج) · مرتجعات ${money(d.month_returns)}</div></a>` : ''}
  </div>
  <div class="card"><h2>توزيع الطلبات حسب الحالة <span class="muted" style="font-size:13px">${c.total || 0} طلب</span></h2>
    <div class="bar">${d.byStatus.map(s => `<span style="width:${s.n / total * 100}%;background:${STATUS_COLOR[s.status]}" title="${STATUS[s.status]}: ${s.n}"></span>`).join('')}</div>
    <div class="legend">${Object.keys(STATUS).map(k => `<span><i style="background:${STATUS_COLOR[k]}"></i>${STATUS[k]}: ${(d.byStatus.find(x => x.status === k) || {}).n || 0}</span>`).join('')}</div>
  </div>
  <div class="card"><h2>⏰ أكتر الطلبات تأخيرًا <a class="btn sm" href="#/late">عرض الكل</a></h2>
    <div id="lateT">${ordersTable(d.late, { empty: '👏 مفيش طلبات متأخرة' })}</div></div>
    <div class="card"><h2>📅 تسليمها قريب (٣ أيام)</h2><div id="soonT">${ordersTable(d.soon, { empty: 'مفيش طلبات قرب ميعادها' })}</div></div>
    <div class="card"><h2>👥 عملاء عندهم طلبات متأخرة</h2>
      ${d.topLate.length ? `<table><tbody>${d.topLate.map(x => `<tr class="clickable" data-href="#/customers/${x.id}">
        <td>${esc(x.name)} <span class="muted code">${esc(x.code)}</span></td><td class="num"><span class="pill late-pill">${x.n} متأخر</span></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">لا يوجد</div>'}
    </div>`;
  bindRows($app); bindStatusSelects($app);
}

// ---------- قائمة الطلبات ----------
async function pageOrders(params) {
  const f = { search: params.get('search') || '', status: params.get('status') || '', from: params.get('from') || '', to: params.get('to') || '',
    open: params.get('open') || '', due_soon: params.get('due_soon') || '', priority: params.get('priority') || '' };
  const title = f.due_soon ? 'طلبات تسليمها خلال ٣ أيام' : f.open ? 'الطلبات المفتوحة' : 'كل الطلبات';
  $app.innerHTML = `
  <div class="page-head"><div><h1>${title}</h1><p id="cnt" class="muted"></p></div>
    <div class="actions"><button class="btn" id="csv">⬇ تصدير Excel</button><button class="btn" onclick="print()">🖨 طباعة</button>
    <a class="btn primary" href="#/orders/new">＋ طلب جديد</a></div></div>
  <div class="card">
    <form class="filters" id="f">
      <div class="field" style="flex:1;min-width:220px"><label>بحث</label><input name="search" value="${esc(f.search)}" placeholder="كود الطلب، اسم العميل، تليفون، صنف…"></div>
      <div class="field"><label>الحالة</label><select name="status"><option value="">الكل</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>الأولوية</label><select name="priority"><option value="">الكل</option><option value="urgent" ${f.priority === 'urgent' ? 'selected' : ''}>عاجل</option><option value="normal" ${f.priority === 'normal' ? 'selected' : ''}>عادي</option></select></div>
      <div class="field"><label>من تاريخ</label><input type="date" name="from" value="${f.from}"></div>
      <div class="field"><label>إلى تاريخ</label><input type="date" name="to" value="${f.to}"></div>
      <label style="display:flex;gap:6px;align-items:center;padding-bottom:8px"><input type="checkbox" name="open" value="1" style="width:auto" ${f.open ? 'checked' : ''}> المفتوحة فقط</label>
      <input type="hidden" name="due_soon" value="${f.due_soon}">
      <button class="btn primary">بحث</button><a class="btn ghost" href="#/orders">مسح</a>
    </form>
    <div id="list"><div class="loading">…</div></div>
  </div>`;
  const form = document.getElementById('f');
  form.addEventListener('submit', e => { e.preventDefault(); location.hash = '#/orders?' + qs(Object.fromEntries(new FormData(form))); });
  const query = qs(f);
  document.getElementById('csv').onclick = () => location.href = '/api/export/orders.csv?' + query;
  const rows = await api('orders?' + query);
  document.getElementById('cnt').textContent = `${rows.length} طلب · القيمة ${money(rows.reduce((s, o) => s + (o.status === 'cancelled' ? 0 : o.total), 0))} جنيه`;
  const list = document.getElementById('list');
  list.innerHTML = ordersTable(rows);
  bindRows(list); bindStatusSelects(list);
}

// ---------- المتأخرة ----------
async function pageLate() {
  const rows = await api('orders?late=1');
  const byCustomer = {};
  rows.forEach(o => (byCustomer[o.customer_id] ||= { name: o.customer_name, code: o.customer_code, phone: o.customer_phone, id: o.customer_id, list: [] }).list.push(o));
  $app.innerHTML = `
  <div class="page-head"><div><h1>⏰ الطلبات المتأخرة</h1><p>طلبات عدّى ميعاد تسليمها ولسه ما اتسلمتش · لغاية ${fmtDate(TODAY)}</p></div>
    <div class="actions"><button class="btn" onclick="location.href='/api/export/orders.csv?late=1'">⬇ تصدير Excel</button><button class="btn" onclick="print()">🖨 طباعة</button></div></div>
  <div class="stats">
    <div class="stat danger"><div class="n">${rows.length}</div><div class="l">طلب متأخر</div></div>
    <div class="stat warn"><div class="n">${Object.keys(byCustomer).length}</div><div class="l">عميل متأثر</div></div>
    <div class="stat"><div class="n">${rows.length ? Math.max(...rows.map(o => o.days_late)) : 0}</div><div class="l">أقصى تأخير (يوم)</div></div>
    <div class="stat violet"><div class="n">${money(rows.reduce((s, o) => s + o.total, 0))}</div><div class="l">قيمة الطلبات المتأخرة (ج)</div></div>
  </div>
  <div class="card"><h2>مرتبة حسب الأقدم</h2><div id="t">${ordersTable(rows, { empty: '👏 مفيش ولا طلب متأخر' })}</div></div>
  ${rows.length ? `<div class="card"><h2>حسب العميل</h2><div class="table-wrap"><table>
    <thead><tr><th>العميل</th><th>التليفون</th><th class="num">عدد المتأخر</th><th>أكواد الطلبات المتأخرة</th></tr></thead>
    <tbody>${Object.values(byCustomer).sort((a, b) => b.list.length - a.list.length).map(c => `<tr>
      <td><a href="#/customers/${c.id}">${esc(c.name)}</a> <span class="muted code">${esc(c.code)}</span></td>
      <td class="code">${esc(c.phone) || '—'}</td><td class="num">${c.list.length}</td><td>${codeChips(c.list)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  bindRows($app); bindStatusSelects($app);
}

// ---------- نموذج الطلب ----------
async function pageOrderForm(id) {
  const [customers, order] = await Promise.all([api('customers'), id ? api('orders/' + id) : null]);
  const o = order || { customer_id: new URLSearchParams(location.hash.split('?')[1]).get('customer') || '', order_date: TODAY, due_date: addDays(TODAY, 7),
    status: 'new', priority: 'normal', paid: 0, notes: '', items: [{ product: '', quantity: 1, unit: 'قطعة', price: 0 }] };
  $app.innerHTML = `
  <div class="page-head"><div><h1>${order ? 'تعديل الطلب <span class="code">' + esc(order.code) + '</span>' : 'طلب جديد'}</h1>
    <p>${order ? '' : 'كود الطلب هيتعمل تلقائي بعد الحفظ'}</p></div></div>
  <form id="of">
    <div class="card"><h2>بيانات الطلب</h2>
      <div class="form-grid">
        <div class="field"><label class="req">العميل</label>
          <div style="display:flex;gap:6px"><select name="customer_id" id="custSel" required>
            <option value="">— اختر العميل —</option>
            ${customers.map(c => `<option value="${c.id}" ${String(c.id) === String(o.customer_id) ? 'selected' : ''}>${esc(c.name)} (${esc(c.code)})</option>`).join('')}
          </select><button type="button" class="btn" id="newCust" title="عميل جديد">＋</button></div></div>
        <div class="field"><label class="req">تاريخ الطلب</label><input type="date" name="order_date" value="${o.order_date}" required></div>
        <div class="field"><label class="req">موعد التسليم المطلوب</label><input type="date" name="due_date" value="${o.due_date}" required></div>
        <div class="field"><label>الحالة</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>الأولوية</label><select name="priority"><option value="normal">عادي</option><option value="urgent" ${o.priority === 'urgent' ? 'selected' : ''}>عاجل</option></select></div>
        <div class="field"><label>المدفوع (عربون)</label><input type="number" name="paid" min="0" step="any" value="${o.paid}"></div>
        <div class="field full"><label>ملاحظات</label><textarea name="notes" placeholder="مواصفات، ألوان، مقاسات، طريقة التغليف…">${esc(o.notes)}</textarea></div>
      </div>
    </div>
    <div class="card"><h2>الأصناف <button type="button" class="btn sm" id="addItem">＋ إضافة صنف</button></h2>
      ${ITEMS_TABLE}
      <div class="totals"><span>إجمالي الكمية: <b id="tQty">0</b></span><span>الإجمالي: <b id="tSum">0</b> ج</span><span>المتبقي: <b id="tRem">0</b> ج</span></div>
    </div>
    <div class="actions" style="justify-content:flex-end">
      <a class="btn" href="${order ? '#/orders/' + order.id : '#/orders'}">إلغاء</a>
      <button class="btn primary" type="submit">💾 حفظ الطلب</button>
    </div>
  </form>`;

  const form = document.getElementById('of');
  const ed = itemsEditor(document.getElementById('items'), o.items, (sum, q) => {
    document.getElementById('tQty').textContent = qty(q);
    document.getElementById('tSum').textContent = money(sum);
    document.getElementById('tRem').textContent = money(sum - (Number(form.paid.value) || 0));
  });
  const items = ed.items;
  form.addEventListener('input', ed.calc);
  document.getElementById('addItem').onclick = () => { ed.addRow().querySelector('input').focus(); };
  document.getElementById('newCust').onclick = async () => {
    const c = await customerDialog();
    if (!c) return;
    const sel = document.getElementById('custSel');
    sel.add(new Option(`${c.name} (${c.code})`, c.id, true, true));
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(form)), items: items() };
    try {
      const saved = await api(order ? 'orders/' + order.id : 'orders', { method: order ? 'PUT' : 'POST', body });
      toast(order ? 'تم حفظ التعديلات' : `تم تسجيل الطلب ${saved.code} ✔`);
      location.hash = '#/orders/' + saved.id;
    } catch (err) { toast(err.message, true); }
  });
}

// ---------- تفاصيل الطلب ----------
async function pageOrder(id) {
  const o = await api('orders/' + id);
  $app.innerHTML = `
  <div class="page-head"><div><h1>طلب <span class="code">${esc(o.code)}</span> ${urgentPill(o)}${sourcePill(o)}</h1><p>${statusPill(o.status)} ${duePill(o)}${o.ref_number ? ' · رقم الورقة: <span class="code">' + esc(o.ref_number) + '</span>' : ''}</p></div>
    <div class="actions"><button class="btn" onclick="print()">🖨 طباعة</button><a class="btn" href="#/orders/${o.id}/edit">✏️ تعديل</a>
    <button class="btn danger" id="del">🗑 حذف</button></div></div>
  <div class="print-only"><h2>أمر شغل / إيصال طلب</h2></div>
  ${reviewBanner('order', o)}
  <div class="card"><div class="detail-grid">
    <div><small>العميل</small><b><a href="#/customers/${o.customer_id}">${esc(o.customer_name)}</a></b> <span class="code muted">${esc(o.customer_code)}</span></div>
    <div><small>التليفون</small><b class="code">${esc(o.customer_phone) || '—'}</b></div>
    <div><small>تاريخ الطلب</small><b>${fmtDate(o.order_date)}</b></div>
    <div><small>موعد التسليم</small><b>${fmtDate(o.due_date)}</b></div>
    <div><small>تاريخ التسليم الفعلي</small><b>${fmtDate(o.delivered_date)}</b></div>
    <div><small>الحالة</small>${statusSelect(o)}</div>
    ${o.invoices.length ? `<div><small>الفواتير</small><b>${o.invoices.map(v => `<a class="code" href="#/invoices/${v.id}">${esc(v.code)}</a>`).join('، ')}</b></div>` : ''}
  </div></div>
  <div class="card"><h2>الأصناف</h2><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>الصنف</th><th class="num">الكمية</th><th>الوحدة</th><th class="num">سعر الوحدة</th><th class="num">الإجمالي</th></tr></thead>
    <tbody>${o.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.product)}</td><td class="num">${qty(i.quantity)}</td><td>${esc(i.unit)}</td>
      <td class="num">${money(i.price)}</td><td class="num">${money(i.quantity * i.price)}</td></tr>`).join('')}</tbody>
  </table></div>
  <div class="totals"><span>الإجمالي: <b>${money(o.total)}</b> ج</span><span>المدفوع: <b>${money(o.paid)}</b> ج</span><span>المتبقي: <b style="color:${o.total - o.paid > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(o.total - o.paid)}</b> ج</span></div></div>
  ${o.notes ? `<div class="card"><h2>ملاحظات</h2><div style="white-space:pre-wrap">${esc(o.notes)}</div></div>` : ''}
  ${attachmentsCard(o.attachments)}
  <div class="card no-print"><h2>سجل الطلب</h2><ul class="log">${o.log.map(l => `<li><time>${esc(l.at)}</time><span>${esc(l.action)}</span></li>`).join('')}</ul></div>`;
  bindStatusSelects($app); bindReviewDone($app);
  document.getElementById('del').onclick = async () => {
    if (!(await confirmDialog(`متأكد إنك عايز تحذف الطلب ${o.code} نهائيًا؟`))) return;
    try { await api('orders/' + o.id, { method: 'DELETE' }); toast('تم حذف الطلب'); location.hash = '#/orders'; } catch (e) { toast(e.message, true); }
  };
}

// ---------- العملاء ----------
async function pageCustomers(params) {
  const search = params.get('search') || '';
  const rows = await api('customers?' + qs({ search }));
  $app.innerHTML = `
  <div class="page-head"><div><h1>العملاء</h1><p>${rows.length} عميل</p></div>
    <div class="actions"><button class="btn" onclick="location.href='/api/export/customers.csv'">⬇ تصدير Excel</button><button class="btn primary" id="add">＋ عميل جديد</button></div></div>
  <div class="card">
    <form class="filters" id="f"><div class="field" style="flex:1"><label>بحث</label><input name="search" value="${esc(search)}" placeholder="اسم، كود، تليفون…"></div><button class="btn primary">بحث</button></form>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>الكود</th><th>الاسم</th><th>التليفون</th><th class="num">الطلبات</th><th class="num">مفتوحة</th>
      <th class="num">متأخرة</th><th class="num">إجمالي القيمة</th><th class="num">المتبقي عليه</th><th>آخر طلب</th></tr></thead>
    <tbody>${rows.map(c => `<tr class="clickable" data-href="#/customers/${c.id}"><td class="code">${esc(c.code)}</td><td><b>${esc(c.name)}</b></td>
      <td class="code">${esc(c.phone) || '—'}</td><td class="num">${c.orders_count}</td><td class="num">${c.open_count}</td>
      <td class="num">${c.late_count ? `<span class="pill late-pill">${c.late_count}</span>` : '0'}</td>
      <td class="num">${money(c.total_value)}</td><td class="num">${money(c.total_value - c.total_paid)}</td><td>${fmtDate(c.last_order)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">لا يوجد عملاء. ابدأ بإضافة أول عميل.</div>'}
  </div>`;
  bindRows($app);
  document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); location.hash = '#/customers?' + qs({ search: e.target.search.value }); });
  document.getElementById('add').onclick = async () => { const c = await customerDialog(); if (c) location.hash = '#/customers/' + c.id; };
}

async function pageCustomer(id) {
  const c = await api('customers/' + id);
  const active = c.orders.filter(o => o.status !== 'cancelled');
  $app.innerHTML = `
  <div class="page-head"><div><h1>${esc(c.name)} <span class="code muted" style="font-size:18px">${esc(c.code)}</span></h1>
    <p>${esc(c.phone)} ${c.address ? ' · ' + esc(c.address) : ''}</p></div>
    <div class="actions"><button class="btn" onclick="print()">🖨 كشف حساب</button><button class="btn" id="edit">✏️ تعديل</button>
    <button class="btn danger" id="del">🗑 حذف</button><a class="btn primary" href="#/orders/new?customer=${c.id}">＋ طلب لهذا العميل</a></div></div>
  <div class="stats">
    <div class="stat"><div class="n">${c.orders_count}</div><div class="l">إجمالي الطلبات</div></div>
    <div class="stat warn"><div class="n">${c.open_count}</div><div class="l">طلبات مفتوحة</div></div>
    <div class="stat danger"><div class="n">${c.late_count}</div><div class="l">طلبات متأخرة</div></div>
    <div class="stat ok"><div class="n">${c.delivered_count}</div><div class="l">اتسلمت</div></div>
    <div class="stat violet"><div class="n">${money(c.total_value)}</div><div class="l">إجمالي القيمة (ج)</div></div>
    <div class="stat"><div class="n">${money(c.total_value - c.total_paid)}</div><div class="l">المتبقي عليه (ج)</div></div>
  </div>
  ${c.invoices_count || c.returns_count ? `<div class="stats">
    <div class="stat"><div class="n">${c.invoices_count}</div><div class="l">🧾 فواتير · ${money(c.sales_total)} ج</div></div>
    <div class="stat danger"><div class="n">${c.returns_count}</div><div class="l">↩️ مرتجعات · ${money(c.returns_total)} ج</div></div>
    <div class="stat ok"><div class="n">${money(c.sales_total - c.returns_total)}</div><div class="l">صافي المبيعات (ج)</div></div>
  </div>` : ''}
  <div class="card"><h2>أكواد كل الطلبات (${c.orders.length})</h2>${c.orders.length ? codeChips([...c.orders].reverse()) : '<div class="muted">لا توجد طلبات</div>'}
    <div class="legend" style="margin-top:10px"><span><i style="background:var(--primary-soft)"></i>مفتوح</span><span><i style="background:var(--danger-soft)"></i>متأخر</span>
    <span><i style="background:var(--ok-soft)"></i>اتسلم</span><span><i style="background:var(--gray-soft)"></i>ملغي</span></div></div>
  <div class="card"><h2>تفاصيل الطلبات <span class="muted" style="font-size:13px">المدفوع ${money(active.reduce((s, o) => s + o.paid, 0))} ج</span></h2>
    <div id="t">${ordersTable(c.orders, { showCustomer: false })}</div></div>
  <div class="card"><h2>🧾 الفواتير (${c.invoices.length}) <a class="btn sm no-print" href="#/invoices/new?customer=${c.id}">＋ فاتورة</a></h2>
    ${invoicesTable(c.invoices, { showCustomer: false, empty: 'مفيش فواتير' })}</div>
  <div class="card"><h2>↩️ المرتجعات (${c.returns.length}) <a class="btn sm no-print" href="#/returns/new?customer=${c.id}">＋ مرتجع</a></h2>
    ${invoicesTable(c.returns, { showCustomer: false, empty: 'مفيش مرتجعات' })}</div>
  ${c.notes ? `<div class="card"><h2>ملاحظات</h2><div style="white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}`;
  bindRows($app); bindStatusSelects($app);
  document.getElementById('edit').onclick = async () => { if (await customerDialog(c)) route(); };
  document.getElementById('del').onclick = async () => {
    if (!(await confirmDialog(`حذف العميل ${c.name}؟`))) return;
    try { await api('customers/' + c.id, { method: 'DELETE' }); toast('تم حذف العميل'); location.hash = '#/customers'; } catch (e) { toast(e.message, true); }
  };
}

// ---------- تقرير العملاء ----------
async function pageReports() {
  const [customers, orders] = await Promise.all([api('customers'), api('orders')]);
  const byC = {};
  orders.forEach(o => (byC[o.customer_id] ||= []).push(o));
  const invs = await api('invoices');
  const invByC = {};
  invs.forEach(v => (invByC[v.customer_id] ||= []).push(v));
  const invChips = list => `<div class="codes">${list.map(v => `<a class="code ${v.kind === 'return' ? 'late' : 'done'}" href="#/invoices/${v.id}">${esc(v.code)}</a>`).join('')}</div>`;
  const withOrders = customers.filter(c => c.orders_count || c.invoices_count || c.returns_count).sort((a, b) => b.orders_count - a.orders_count);
  $app.innerHTML = `
  <div class="page-head"><div><h1>📊 تقرير العملاء</h1><p>كل عميل: عدد طلباته وفواتيره ومرتجعاته وأكوادها</p></div>
    <div class="actions"><button class="btn" onclick="location.href='/api/export/customers.csv'">⬇ تصدير Excel</button><button class="btn" onclick="print()">🖨 طباعة</button></div></div>
  <div class="card">${withOrders.length ? `<div class="table-wrap"><table>
    <thead><tr><th>العميل</th><th class="num">عدد الطلبات</th><th class="num">مفتوحة</th><th class="num">متأخرة</th><th class="num">اتسلمت</th>
      <th class="num">إجمالي القيمة</th><th class="num">المتبقي</th><th style="min-width:220px">أكواد الطلبات</th>
      <th class="num">فواتير</th><th class="num">مرتجعات</th><th class="num">صافي المبيعات</th><th style="min-width:200px">أكواد الفواتير والمرتجعات</th></tr></thead>
    <tbody>${withOrders.map(c => `<tr><td><a href="#/customers/${c.id}"><b>${esc(c.name)}</b></a><div class="muted code" style="font-size:12px">${esc(c.code)}</div></td>
      <td class="num"><b>${c.orders_count}</b></td><td class="num">${c.open_count}</td>
      <td class="num">${c.late_count ? `<span class="pill late-pill">${c.late_count}</span>` : '0'}</td><td class="num">${c.delivered_count}</td>
      <td class="num">${money(c.total_value)}</td><td class="num">${money(c.total_value - c.total_paid)}</td>
      <td>${codeChips((byC[c.id] || []).slice().reverse())}</td>
      <td class="num">${c.invoices_count}</td><td class="num">${c.returns_count}</td><td class="num">${money(c.sales_total - c.returns_total)}</td>
      <td>${invChips((invByC[c.id] || []).slice().reverse())}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>الإجمالي</th><th class="num">${withOrders.reduce((s, c) => s + c.orders_count, 0)}</th><th class="num">${withOrders.reduce((s, c) => s + c.open_count, 0)}</th>
      <th class="num">${withOrders.reduce((s, c) => s + c.late_count, 0)}</th><th class="num">${withOrders.reduce((s, c) => s + c.delivered_count, 0)}</th>
      <th class="num">${money(withOrders.reduce((s, c) => s + c.total_value, 0))}</th><th class="num">${money(withOrders.reduce((s, c) => s + c.total_value - c.total_paid, 0))}</th><th></th>
      <th class="num">${withOrders.reduce((s, c) => s + c.invoices_count, 0)}</th><th class="num">${withOrders.reduce((s, c) => s + c.returns_count, 0)}</th>
      <th class="num">${money(withOrders.reduce((s, c) => s + c.sales_total - c.returns_total, 0))}</th><th></th></tr></tfoot>
  </table></div>` : '<div class="empty">لسه مفيش طلبات</div>'}</div>`;
}

// ---------- الإعدادات / النسخ الاحتياطي ----------
async function pageSettings() {
  const [t, ai] = await Promise.all([api('telegram'), api('ai')]);
  $app.innerHTML = `
  <div class="page-head"><div><h1>⚙️ الإعدادات</h1></div></div>
  <div class="card"><h2>🤖 ربط تليجرام</h2><div id="tg">${telegramCard(t)}</div></div>
  <div class="card"><h2>🧠 قراءة الرسايل والصور (الذكاء الاصطناعي)</h2><div id="ai">${aiCard(ai)}</div></div>
  <div class="card"><h2>🔒 كلمة المرور</h2>
    <form id="pw" class="form-grid" style="max-width:640px">
      <div class="field"><label>كلمة المرور الحالية</label><input type="password" name="current" autocomplete="current-password"></div>
      <div class="field"><label class="req">كلمة المرور الجديدة</label><input type="password" name="password" required minlength="6" autocomplete="new-password"></div>
      <div class="field"><label class="req">اكتبها تاني</label><input type="password" name="confirm" required minlength="6" autocomplete="new-password"></div>
      <div class="field" style="justify-content:end"><button class="btn primary">تغيير كلمة المرور</button></div>
    </form></div>
  <div class="card"><h2>💾 نسخة احتياطية</h2>
    <p>السيستم بياخد نسخة احتياطية تلقائي كل ٦ ساعات (بيحتفظ بآخر ٣٠ يوم).
    يُفضَّل كمان تنزّل نسخة كل أسبوع وتحفظها على جوجل درايف أو فلاشة.</p>
    <a class="btn primary" href="/api/export/backup.db">⬇ تنزيل نسخة احتياطية الآن</a></div>
  <div class="card"><h2>📤 تصدير لـ Excel</h2><div class="actions">
    <a class="btn" href="/api/export/orders.csv">كل الطلبات</a><a class="btn" href="/api/export/orders.csv?late=1">الطلبات المتأخرة</a>
    <a class="btn" href="/api/export/orders.csv?open=1">الطلبات المفتوحة</a><a class="btn" href="/api/export/customers.csv">تقرير العملاء</a></div></div>`;
  bindTelegram(); bindAI();
  const pw = document.getElementById('pw');
  pw.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(pw));
    if (f.password !== f.confirm) return toast('كلمتين المرور مش زي بعض', true);
    try { await api('password', { method: 'POST', body: f }); pw.reset(); toast('اتغيرت كلمة المرور ✔'); document.getElementById('logout').hidden = false; }
    catch (err) { toast(err.message, true); }
  });
}

function telegramCard(t) {
  if (!t.enabled) return `
    <p>اربط السيستم ببوت تليجرام عشان يبعتلك المتأخر كل يوم الصبح، وتسأله عن أي عميل أو طلب، وتسجّل طلبات من الموبايل.</p>
    <ol class="steps">
      <li>افتح تليجرام وابحث عن <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a> (عليه علامة زرقا ✔) وابعتله <span class="code">/newbot</span></li>
      <li>اكتب اسم للبوت (مثلاً: طلبات المصنع)، وبعدين يوزر لازم يخلص بـ <span class="code">bot</span></li>
      <li>هيبعتلك <b>توكن</b> شكله كده <span class="code">123456789:ABC…</span>. انسخه وحطه هنا:</li>
    </ol>
    <form id="tgForm" style="display:flex;gap:8px;flex-wrap:wrap;max-width:640px">
      <input name="token" required placeholder="الصق التوكن هنا" style="flex:1;min-width:220px;direction:ltr" autocomplete="off">
      <button class="btn primary">ربط البوت</button>
    </form>`;
  return `
    ${t.error ? `<p class="pill late-pill">${esc(t.error)}</p>` : ''}
    <p>البوت ${t.username ? `<a href="https://t.me/${esc(t.username)}" target="_blank" rel="noopener"><b>@${esc(t.username)}</b></a>` : ''} شغال ✔ ·
      حسابات مربوطة: <b>${t.linked}</b></p>
    ${t.link ? `<p>${t.linked ? 'عشان تربط حساب تاني (موبايل تاني أو شريك)' : '<b>آخر خطوة:</b> دوس على الزرار ده من الجهاز اللي عليه تليجرام، وبعدين دوس <b>Start</b>'}:</p>
    <div class="actions"><a class="btn primary" href="${esc(t.link)}" target="_blank" rel="noopener">📲 افتح البوت واربط حسابي</a>
      <button class="btn" id="tgRefresh">🔄 تحديث</button></div>` : ''}
    <h3 style="margin:22px 0 8px;font-size:16px">👥 جروبات المصنع</h3>
    ${t.groups.length ? `<table><tbody>${t.groups.map(g => `<tr><td><b>${esc(g.title) || 'جروب'}</b></td>
      <td>${{ orders: '📦 الطلبات', invoices: '🧾 الفواتير', returns: '↩️ المرتجعات' }[g.kind]}</td>
      <td><button class="btn sm danger" data-group-off="${esc(g.chat_id)}">إيقاف</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">لسه مفيش جروبات متوصلة.</p>'}
    <details style="margin-top:10px"><summary><b>إزاي أوصّل جروب؟</b></summary><ol class="steps">
      <li>في تليجرام اعمل جروب (مثلاً: طلبات المصنع) وضيف فيه الموظفين.</li>
      <li>ضيف البوت ${t.username ? `<b>@${esc(t.username)}</b>` : ''} للجروب، وبعدين من إعدادات الجروب خليه <b>Admin</b>.</li>
      <li>اكتب في الجروب <span class="code">/setup</span> واختار نوعه: طلبات أو فواتير أو مرتجعات.</li>
      <li>كرر نفس الخطوات لجروب الفواتير وجروب المرتجعات.</li>
    </ol></details>
    ${t.from_env ? '' : '<p style="margin-top:16px"><button class="btn danger sm" id="tgOff">فصل البوت</button></p>'}`;
}

function aiCard(a) {
  const quality = `<div class="field" style="max-width:420px;margin-top:12px"><label>دقة القراءة</label><select id="aiQuality">
      <option value="accurate" ${a.quality === 'accurate' ? 'selected' : ''}>دقة عالية — الأفضل للخط اليدوي (حوالي ٢–٤ سنت للرسالة)</option>
      <option value="economy" ${a.quality === 'economy' ? 'selected' : ''}>اقتصادي — أقل من سنت للرسالة، للرسايل المكتوبة الواضحة</option></select></div>`;
  if (!a.enabled) return `
    <p>عشان البوت يقرا الرسايل وصور الورق اللي بتتبعت في الجروبات ويسجلها لوحده، محتاج مفتاح من Anthropic (الشركة اللي عاملة Claude).</p>
    <ol class="steps">
      <li>ادخل <a href="https://console.anthropic.com" target="_blank" rel="noopener"><b>console.anthropic.com</b></a> واعمل حساب.</li>
      <li>من <b>Billing</b> اشحن رصيد (مثلاً ١٠ دولار للبداية).</li>
      <li>من <b>API Keys</b> دوس <b>Create Key</b>، وانسخ المفتاح (بيبدأ بـ <span class="code">sk-ant-</span>) وحطه هنا:</li>
    </ol>
    <form id="aiForm" style="display:flex;gap:8px;flex-wrap:wrap;max-width:640px">
      <input name="key" required placeholder="sk-ant-..." style="flex:1;min-width:220px;direction:ltr" autocomplete="off">
      <button class="btn primary">تفعيل</button>
    </form>${quality}`;
  return `<p>شغال ✔ · اتقرا النهارده: <b>${a.used_today}</b> من <b>${a.daily_limit}</b> رسالة (الحد اليومي بيحميك من أي صرف زيادة).</p>
    ${quality}
    <div class="field" style="max-width:200px;margin-top:12px"><label>الحد اليومي للرسايل</label><input type="number" id="aiLimit" min="1" value="${a.daily_limit}"></div>
    <p style="margin-top:16px"><button class="btn danger sm" id="aiOff">إيقاف القراءة التلقائية</button></p>`;
}

function bindAI() {
  const box = document.getElementById('ai');
  const render = a => { box.innerHTML = aiCard(a); bindAI(); };
  const save = async body => { try { render(await api('ai', { method: 'POST', body })); toast('اتحفظ ✔'); } catch (e) { toast(e.message, true); } };
  const form = document.getElementById('aiForm');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'جاري التفعيل…';
    await save({ key: form.key.value, quality: document.getElementById('aiQuality').value });
    btn.disabled = false; btn.textContent = 'تفعيل';
  });
  const q = document.getElementById('aiQuality');
  if (q && !form) q.onchange = () => save({ quality: q.value });
  const lim = document.getElementById('aiLimit');
  if (lim) lim.onchange = () => save({ daily_limit: lim.value });
  const off = document.getElementById('aiOff');
  if (off) off.onclick = async () => {
    if (!(await confirmDialog('إيقاف القراءة التلقائية؟ البوت هيبطل يسجّل من الجروبات لحد ما تحط المفتاح تاني.'))) return;
    render(await api('ai', { method: 'DELETE' }));
  };
}

function bindTelegram() {
  const box = document.getElementById('tg');
  const render = t => { box.innerHTML = telegramCard(t); bindTelegram(); };
  const form = document.getElementById('tgForm');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'جاري الربط…';
    try { render(await api('telegram', { method: 'POST', body: { token: form.token.value } })); toast('البوت اتربط ✔'); }
    catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'ربط البوت'; }
  });
  const r = document.getElementById('tgRefresh');
  if (r) r.onclick = async () => render(await api('telegram'));
  box.querySelectorAll('[data-group-off]').forEach(b => b.onclick = async () => {
    if (!(await confirmDialog('إيقاف الجروب ده؟ البوت هيبطل يسجّل منه.'))) return;
    render(await api('telegram/groups/' + encodeURIComponent(b.dataset.groupOff), { method: 'DELETE' }));
  });
  const off = document.getElementById('tgOff');
  if (off) off.onclick = async () => {
    if (!(await confirmDialog('فصل البوت؟ هيبطل يبعت رسايل، وتقدر تربطه تاني في أي وقت.'))) return;
    render(await api('telegram', { method: 'DELETE' })); toast('البوت اتفصل');
  };
}

// ---------- نوافذ ----------
const modal = document.getElementById('modal');
const modalForm = document.getElementById('modalForm');

function customerDialog(c = null) {
  return new Promise(resolve => {
    modalForm.innerHTML = `<h3>${c ? 'تعديل بيانات العميل' : 'عميل جديد'}</h3>
      <div class="form-grid">
        <div class="field full"><label class="req">اسم العميل / الشركة</label><input name="name" required value="${esc(c?.name)}"></div>
        <div class="field"><label>كود العميل</label><input name="code" value="${esc(c?.code)}" placeholder="تلقائي لو سبته فاضي" style="direction:ltr"></div>
        <div class="field"><label>التليفون</label><input name="phone" value="${esc(c?.phone)}" style="direction:ltr"></div>
        <div class="field full"><label>العنوان</label><input name="address" value="${esc(c?.address)}"></div>
        <div class="field full"><label>ملاحظات</label><textarea name="notes">${esc(c?.notes)}</textarea></div>
      </div>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>إلغاء</button><button class="btn primary" value="save">حفظ</button></div>`;
    modalForm.onsubmit = async e => {
      if (e.submitter?.value !== 'save') return resolve(null);
      e.preventDefault();
      try {
        const saved = await api(c ? 'customers/' + c.id : 'customers', { method: c ? 'PUT' : 'POST', body: Object.fromEntries(new FormData(modalForm)) });
        modal.close(); toast('تم حفظ العميل ✔'); resolve(saved);
      } catch (err) { toast(err.message, true); }
    };
    modal.onclose = () => resolve(null);
    modal.showModal();
    modalForm.querySelector("[name=name]").focus();
  });
}

function confirmDialog(msg) {
  return new Promise(resolve => {
    modalForm.innerHTML = `<h3>تأكيد</h3><p>${esc(msg)}</p><div class="actions"><button class="btn" value="no">لا</button><button class="btn danger" value="yes">نعم، احذف</button></div>`;
    modalForm.onsubmit = e => resolve(e.submitter?.value === 'yes');
    modal.onclose = () => resolve(false);
    modal.showModal();
  });
}

// ---------- التوجيه ----------
async function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const p = path.split('/').filter(Boolean);
  const nav = p[0] === 'orders' && p[1] === 'new' ? 'new' : p[0] || 'dashboard';
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
  window.scrollTo(0, 0);
  try {
    if (!p.length) await pageDashboard();
    else if (p[0] === 'orders' && p[1] === 'new') await pageOrderForm();
    else if (p[0] === 'orders' && p[1] && p[2] === 'edit') await pageOrderForm(p[1]);
    else if (p[0] === 'orders' && p[1]) await pageOrder(p[1]);
    else if (p[0] === 'orders') await pageOrders(params);
    else if (p[0] === 'late') await pageLate();
    else if (p[0] === 'customers' && p[1]) await pageCustomer(p[1]);
    else if (p[0] === 'customers') await pageCustomers(params);
    else if (p[0] === 'reports') await pageReports();
    else if (p[0] === 'invoices' && p[1] === 'new') await pageInvoiceForm('sale');
    else if (p[0] === 'returns' && p[1] === 'new') await pageInvoiceForm('return');
    else if (p[0] === 'invoices' && p[1] && p[2] === 'edit') await pageInvoiceForm(null, p[1]);
    else if (p[0] === 'invoices' && p[1]) await pageInvoice(p[1]);
    else if (p[0] === 'invoices') await pageInvoices('sale', params);
    else if (p[0] === 'returns') await pageInvoices('return', params);
    else if (p[0] === 'review') await pageReview();
    else if (p[0] === 'settings') await pageSettings();
    else $app.innerHTML = '<div class="empty">الصفحة غير موجودة</div>';
  } catch (e) {
    $app.innerHTML = `<div class="card empty">⚠️ ${esc(e.message)}<br><br><a class="btn" href="#/">رجوع للرئيسية</a></div>`;
  }
  refreshBadge();
}

async function refreshBadge() {
  try {
    const d = await api('dashboard');
    TODAY = d.today;
    const b = document.getElementById('lateBadge');
    b.hidden = !d.counts.late; b.textContent = d.counts.late || '';
    const r = document.getElementById('reviewBadge');
    r.hidden = !d.review; r.textContent = d.review || '';
    document.getElementById('reviewNav').hidden = !d.review;
  } catch { /* ignore */ }
}

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
window.addEventListener('hashchange', route);
api('meta').then(m => {
  TODAY = m.today;
  if (m.auth) document.getElementById('logout').hidden = false;
  if (m.storage_warning) document.body.insertAdjacentHTML('afterbegin',
    '<div class="storage-warning">⚠️ مفيش Volume متوصل على Railway، أي بيانات هتدخلها هتتمسح مع أول تحديث. شوف ملف README.</div>');
}).catch(() => {}).finally(route);
setInterval(refreshBadge, 60000);
