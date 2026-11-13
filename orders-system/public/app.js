'use strict';
/* نظام طلبات العملاء - الواجهة */

const STATUS = { new: 'جديد', in_progress: 'قيد التنفيذ', ready: 'جاهز للتسليم', delivered: 'تم التسليم', cancelled: 'ملغي' };
const STATUS_COLOR = { new: '#1d4ed8', in_progress: '#d97706', ready: '#7c3aed', delivered: '#059669', cancelled: '#94a3b8' };
const UNITS = ['قطعة', 'متر', 'كيلو', 'طقم', 'دستة', 'ثوب', 'رول', 'كرتونة'];
const $app = document.getElementById('app');
let TODAY = new Date().toISOString().slice(0, 10);

// ---------- أدوات ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const qty = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('ar-EG-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
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
      <div class="table-wrap"><table class="items-table"><thead><tr><th style="width:40%">الصنف / الوصف</th><th>الكمية</th><th>الوحدة</th><th>سعر الوحدة</th><th class="num">الإجمالي</th><th></th></tr></thead>
      <tbody id="items"></tbody></table></div>
      <div class="totals"><span>إجمالي الكمية: <b id="tQty">0</b></span><span>الإجمالي: <b id="tSum">0</b> ج</span><span>المتبقي: <b id="tRem">0</b> ج</span></div>
    </div>
    <div class="actions" style="justify-content:flex-end">
      <a class="btn" href="${order ? '#/orders/' + order.id : '#/orders'}">إلغاء</a>
      <button class="btn primary" type="submit">💾 حفظ الطلب</button>
    </div>
  </form>
  <datalist id="units">${UNITS.map(u => `<option value="${u}">`).join('')}</datalist>`;

  const tbody = document.getElementById('items');
  const form = document.getElementById('of');
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
  const items = () => [...tbody.children].map(tr => Object.fromEntries([...tr.querySelectorAll('input')].map(i => [i.dataset.k, i.value])));
  const calc = () => {
    let s = 0, q = 0;
    [...tbody.children].forEach(tr => {
      const v = k => Number(tr.querySelector(`[data-k=${k}]`).value) || 0;
      const line = v('quantity') * v('price'); s += line; q += v('quantity');
      tr.querySelector('[data-line]').textContent = money(line);
    });
    document.getElementById('tQty').textContent = qty(q);
    document.getElementById('tSum').textContent = money(s);
    document.getElementById('tRem').textContent = money(s - (Number(form.paid.value) || 0));
  };
  o.items.forEach(addRow); calc();
  form.addEventListener('input', calc);
  document.getElementById('addItem').onclick = () => { addRow().querySelector('input').focus(); };
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
  <div class="page-head"><div><h1>طلب <span class="code">${esc(o.code)}</span> ${urgentPill(o)}</h1><p>${statusPill(o.status)} ${duePill(o)}</p></div>
    <div class="actions"><button class="btn" onclick="print()">🖨 طباعة</button><a class="btn" href="#/orders/${o.id}/edit">✏️ تعديل</a>
    <button class="btn danger" id="del">🗑 حذف</button></div></div>
  <div class="print-only"><h2>أمر شغل / إيصال طلب</h2></div>
  <div class="card"><div class="detail-grid">
    <div><small>العميل</small><b><a href="#/customers/${o.customer_id}">${esc(o.customer_name)}</a></b> <span class="code muted">${esc(o.customer_code)}</span></div>
    <div><small>التليفون</small><b class="code">${esc(o.customer_phone) || '—'}</b></div>
    <div><small>تاريخ الطلب</small><b>${fmtDate(o.order_date)}</b></div>
    <div><small>موعد التسليم</small><b>${fmtDate(o.due_date)}</b></div>
    <div><small>تاريخ التسليم الفعلي</small><b>${fmtDate(o.delivered_date)}</b></div>
    <div><small>الحالة</small>${statusSelect(o)}</div>
  </div></div>
  <div class="card"><h2>الأصناف</h2><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>الصنف</th><th class="num">الكمية</th><th>الوحدة</th><th class="num">سعر الوحدة</th><th class="num">الإجمالي</th></tr></thead>
    <tbody>${o.items.map((i, n) => `<tr><td>${n + 1}</td><td>${esc(i.product)}</td><td class="num">${qty(i.quantity)}</td><td>${esc(i.unit)}</td>
      <td class="num">${money(i.price)}</td><td class="num">${money(i.quantity * i.price)}</td></tr>`).join('')}</tbody>
  </table></div>
  <div class="totals"><span>الإجمالي: <b>${money(o.total)}</b> ج</span><span>المدفوع: <b>${money(o.paid)}</b> ج</span><span>المتبقي: <b style="color:${o.total - o.paid > 0 ? 'var(--danger)' : 'var(--ok)'}">${money(o.total - o.paid)}</b> ج</span></div></div>
  ${o.notes ? `<div class="card"><h2>ملاحظات</h2><div style="white-space:pre-wrap">${esc(o.notes)}</div></div>` : ''}
  <div class="card no-print"><h2>سجل الطلب</h2><ul class="log">${o.log.map(l => `<li><time>${esc(l.at)}</time><span>${esc(l.action)}</span></li>`).join('')}</ul></div>`;
  bindStatusSelects($app);
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
  <div class="card"><h2>أكواد كل الطلبات (${c.orders.length})</h2>${c.orders.length ? codeChips([...c.orders].reverse()) : '<div class="muted">لا توجد طلبات</div>'}
    <div class="legend" style="margin-top:10px"><span><i style="background:var(--primary-soft)"></i>مفتوح</span><span><i style="background:var(--danger-soft)"></i>متأخر</span>
    <span><i style="background:var(--ok-soft)"></i>اتسلم</span><span><i style="background:var(--gray-soft)"></i>ملغي</span></div></div>
  <div class="card"><h2>تفاصيل الطلبات <span class="muted" style="font-size:13px">المدفوع ${money(active.reduce((s, o) => s + o.paid, 0))} ج</span></h2>
    <div id="t">${ordersTable(c.orders, { showCustomer: false })}</div></div>
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
  const withOrders = customers.filter(c => c.orders_count).sort((a, b) => b.orders_count - a.orders_count);
  $app.innerHTML = `
  <div class="page-head"><div><h1>📊 تقرير العملاء</h1><p>كل عميل: عدد طلباته وأكوادها وحالتها</p></div>
    <div class="actions"><button class="btn" onclick="location.href='/api/export/customers.csv'">⬇ تصدير Excel</button><button class="btn" onclick="print()">🖨 طباعة</button></div></div>
  <div class="card">${withOrders.length ? `<div class="table-wrap"><table>
    <thead><tr><th>العميل</th><th class="num">عدد الطلبات</th><th class="num">مفتوحة</th><th class="num">متأخرة</th><th class="num">اتسلمت</th>
      <th class="num">إجمالي القيمة</th><th class="num">المتبقي</th><th style="min-width:260px">أكواد الطلبات</th></tr></thead>
    <tbody>${withOrders.map(c => `<tr><td><a href="#/customers/${c.id}"><b>${esc(c.name)}</b></a><div class="muted code" style="font-size:12px">${esc(c.code)}</div></td>
      <td class="num"><b>${c.orders_count}</b></td><td class="num">${c.open_count}</td>
      <td class="num">${c.late_count ? `<span class="pill late-pill">${c.late_count}</span>` : '0'}</td><td class="num">${c.delivered_count}</td>
      <td class="num">${money(c.total_value)}</td><td class="num">${money(c.total_value - c.total_paid)}</td>
      <td>${codeChips((byC[c.id] || []).slice().reverse())}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th>الإجمالي</th><th class="num">${withOrders.reduce((s, c) => s + c.orders_count, 0)}</th><th class="num">${withOrders.reduce((s, c) => s + c.open_count, 0)}</th>
      <th class="num">${withOrders.reduce((s, c) => s + c.late_count, 0)}</th><th class="num">${withOrders.reduce((s, c) => s + c.delivered_count, 0)}</th>
      <th class="num">${money(withOrders.reduce((s, c) => s + c.total_value, 0))}</th><th class="num">${money(withOrders.reduce((s, c) => s + c.total_value - c.total_paid, 0))}</th><th></th></tr></tfoot>
  </table></div>` : '<div class="empty">لسه مفيش طلبات</div>'}</div>`;
}

// ---------- الإعدادات / النسخ الاحتياطي ----------
function pageSettings() {
  $app.innerHTML = `
  <div class="page-head"><div><h1>⚙️ النسخ الاحتياطي والتصدير</h1></div></div>
  <div class="card"><h2>نسخة احتياطية</h2>
    <p>السيستم بياخد نسخة احتياطية تلقائي كل ٦ ساعات في فولدر <span class="code">data/backups</span> (بيحتفظ بآخر ٣٠ يوم).
    تقدر كمان تنزّل نسخة دلوقتي وتحفظها على فلاشة أو جوجل درايف.</p>
    <a class="btn primary" href="/api/export/backup.db">⬇ تنزيل نسخة احتياطية الآن</a>
    <p class="muted" style="font-size:13px">للاسترجاع: اقفل السيستم، وحط ملف النسخة مكان <span class="code">data/orders.db</span>، وشغّله تاني.</p></div>
  <div class="card"><h2>تصدير لـ Excel</h2><div class="actions">
    <a class="btn" href="/api/export/orders.csv">كل الطلبات</a><a class="btn" href="/api/export/orders.csv?late=1">الطلبات المتأخرة</a>
    <a class="btn" href="/api/export/orders.csv?open=1">الطلبات المفتوحة</a><a class="btn" href="/api/export/customers.csv">تقرير العملاء</a></div></div>`;
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
    else if (p[0] === 'settings') pageSettings();
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
  } catch { /* ignore */ }
}

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
window.addEventListener('hashchange', route);
api('meta').then(m => { TODAY = m.today; }).catch(() => {}).finally(route);
setInterval(refreshBadge, 60000);
