// نظام إدارة طلبات العملاء - خادم بدون أي مكتبات خارجية (Node.js 22.13+)
'use strict';
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

// لازم Node.js 22.13 أو أحدث عشان قاعدة البيانات المدمجة (node:sqlite)
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\n  نسخة Node.js عندك قديمة (${process.version}).`);
    console.error('  Your Node.js is too old. Install the LTS version from https://nodejs.org (22.13 or newer).\n');
    process.exit(1);
  }
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { exec } = require('node:child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
// على Railway من غير Volume البيانات بتتمسح مع كل تحديث
const STORAGE_WARNING = !!process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'orders.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  paid REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  delivered_date TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT DEFAULT 'قطعة',
  price REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_due ON orders(due_date);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

const STATUSES = ['new', 'in_progress', 'ready', 'delivered', 'cancelled'];
const STATUS_AR = { new: 'جديد', in_progress: 'قيد التنفيذ', ready: 'جاهز للتسليم', delivered: 'تم التسليم', cancelled: 'ملغي' };
const PRIORITIES = ['normal', 'urgent'];
const OPEN = `o.status NOT IN ('delivered','cancelled')`;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function nextCode(table, prefix) {
  const row = db.prepare(`SELECT code FROM ${table} WHERE code LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
  let n = 0;
  if (row) n = parseInt(row.code.slice(prefix.length), 10) || 0;
  let code;
  do { n++; code = prefix + String(n).padStart(4, '0'); }
  while (db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code));
  return code;
}

// ---------- قراءة الطلبات ----------
const ORDER_SELECT = `
SELECT o.*, c.name AS customer_name, c.code AS customer_code, c.phone AS customer_phone,
  COALESCE((SELECT SUM(quantity*price) FROM order_items WHERE order_id=o.id),0) AS total,
  COALESCE((SELECT SUM(quantity) FROM order_items WHERE order_id=o.id),0) AS total_qty,
  (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) AS items_count,
  (SELECT GROUP_CONCAT(product, '، ') FROM order_items WHERE order_id=o.id) AS products,
  CASE WHEN ${OPEN} AND o.due_date < :today THEN CAST(julianday(:today) - julianday(o.due_date) AS INTEGER) ELSE 0 END AS days_late
FROM orders o JOIN customers c ON c.id = o.customer_id`;

function listOrders(q) {
  const where = [];
  const p = { today: today() };
  if (q.status && STATUSES.includes(q.status)) { where.push('o.status = :status'); p.status = q.status; }
  if (q.open === '1') where.push(OPEN);
  if (q.late === '1') where.push(`${OPEN} AND o.due_date < :today`);
  if (q.due_soon === '1') { where.push(`${OPEN} AND o.due_date BETWEEN :today AND date(:today, '+3 days')`); }
  if (q.customer_id) { where.push('o.customer_id = :cid'); p.cid = Number(q.customer_id); }
  if (isDate(q.from)) { where.push('o.order_date >= :from'); p.from = q.from; }
  if (isDate(q.to)) { where.push('o.order_date <= :to'); p.to = q.to; }
  if (q.priority && PRIORITIES.includes(q.priority)) { where.push('o.priority = :pr'); p.pr = q.priority; }
  if (q.search) {
    where.push(`(o.code LIKE :s OR c.name LIKE :s OR c.code LIKE :s OR c.phone LIKE :s OR o.notes LIKE :s
      OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.product LIKE :s))`);
    p.s = `%${str(q.search, 100)}%`;
  }
  const order = q.late === '1' ? 'o.due_date ASC' : 'o.id DESC';
  const sql = `${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 2000`;
  return db.prepare(sql).all(p);
}

function getOrder(id) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = :id`).get({ id: Number(id), today: today() });
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  o.log = db.prepare('SELECT * FROM order_log WHERE order_id = ? ORDER BY id DESC').all(o.id);
  return o;
}

function validateOrder(b) {
  const customer_id = Number(b.customer_id);
  if (!customer_id || !db.prepare('SELECT 1 FROM customers WHERE id=?').get(customer_id)) throw new HttpError(400, 'اختر العميل');
  if (!isDate(b.order_date)) throw new HttpError(400, 'تاريخ الطلب غير صحيح');
  if (!isDate(b.due_date)) throw new HttpError(400, 'تاريخ التسليم المطلوب غير صحيح');
  if (b.due_date < b.order_date) throw new HttpError(400, 'تاريخ التسليم لا يمكن أن يكون قبل تاريخ الطلب');
  const items = (Array.isArray(b.items) ? b.items : [])
    .map(i => ({ product: str(i.product, 200), quantity: num(i.quantity), unit: str(i.unit, 30) || 'قطعة', price: num(i.price) }))
    .filter(i => i.product);
  if (!items.length) throw new HttpError(400, 'أضف صنف واحد على الأقل');
  if (items.some(i => i.quantity <= 0)) throw new HttpError(400, 'الكمية لازم تكون أكبر من صفر');
  if (items.some(i => i.price < 0)) throw new HttpError(400, 'السعر لا يمكن أن يكون بالسالب');
  const status = STATUSES.includes(b.status) ? b.status : 'new';
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  return { customer_id, order_date: b.order_date, due_date: b.due_date, status, priority, paid: Math.max(0, num(b.paid)), notes: str(b.notes, 2000), items };
}

const insertItem = db.prepare('INSERT INTO order_items (order_id, product, quantity, unit, price) VALUES (?,?,?,?,?)');
const addLog = (id, action) => db.prepare('INSERT INTO order_log (order_id, action) VALUES (?,?)').run(id, action);

function createOrder(b) {
  const v = validateOrder(b);
  return tx(() => {
    const prefix = `ORD-${v.order_date.slice(0, 4)}-`;
    const code = nextCode('orders', prefix);
    const r = db.prepare(`INSERT INTO orders (code, customer_id, order_date, due_date, status, priority, paid, notes, delivered_date)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(code, v.customer_id, v.order_date, v.due_date, v.status, v.priority, v.paid, v.notes,
      v.status === 'delivered' ? today() : null);
    const id = Number(r.lastInsertRowid);
    for (const i of v.items) insertItem.run(id, i.product, i.quantity, i.unit, i.price);
    addLog(id, `تم إنشاء الطلب (${STATUS_AR[v.status]})`);
    return getOrder(id);
  });
}

function updateOrder(id, b) {
  const old = getOrder(id);
  const v = validateOrder(b);
  return tx(() => {
    let delivered = old.delivered_date;
    if (v.status === 'delivered' && old.status !== 'delivered') delivered = today();
    if (v.status !== 'delivered') delivered = null;
    db.prepare(`UPDATE orders SET customer_id=?, order_date=?, due_date=?, status=?, priority=?, paid=?, notes=?, delivered_date=?,
      updated_at=datetime('now','localtime') WHERE id=?`)
      .run(v.customer_id, v.order_date, v.due_date, v.status, v.priority, v.paid, v.notes, delivered, old.id);
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(old.id);
    for (const i of v.items) insertItem.run(old.id, i.product, i.quantity, i.unit, i.price);
    const changes = [];
    if (old.status !== v.status) changes.push(`الحالة: ${STATUS_AR[old.status]} ← ${STATUS_AR[v.status]}`);
    if (old.due_date !== v.due_date) changes.push(`موعد التسليم: ${old.due_date} ← ${v.due_date}`);
    if (old.paid !== v.paid) changes.push(`المدفوع: ${old.paid} ← ${v.paid}`);
    addLog(old.id, changes.length ? changes.join(' | ') : 'تم تعديل بيانات الطلب');
    return getOrder(old.id);
  });
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new HttpError(400, 'حالة غير صحيحة');
  const old = getOrder(id);
  if (old.status === status) return old;
  const delivered = status === 'delivered' ? today() : null;
  db.prepare(`UPDATE orders SET status=?, delivered_date=?, updated_at=datetime('now','localtime') WHERE id=?`).run(status, delivered, old.id);
  addLog(old.id, `الحالة: ${STATUS_AR[old.status]} ← ${STATUS_AR[status]}`);
  return getOrder(old.id);
}

function getOrderByCode(code) {
  const row = db.prepare('SELECT id FROM orders WHERE code = ? COLLATE NOCASE').get(str(code, 40));
  return row ? getOrder(row.id) : null;
}

const getSetting = key => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) || {}).value ?? null;
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

// ---------- العملاء ----------
const CUSTOMER_STATS = `
SELECT c.*,
  (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id) AS orders_count,
  (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id AND ${OPEN}) AS open_count,
  (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id AND ${OPEN} AND o.due_date < :today) AS late_count,
  (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id AND o.status='delivered') AS delivered_count,
  COALESCE((SELECT SUM(i.quantity*i.price) FROM orders o JOIN order_items i ON i.order_id=o.id
     WHERE o.customer_id=c.id AND o.status<>'cancelled'),0) AS total_value,
  COALESCE((SELECT SUM(o.paid) FROM orders o WHERE o.customer_id=c.id AND o.status<>'cancelled'),0) AS total_paid,
  (SELECT GROUP_CONCAT(code, '، ') FROM (SELECT code FROM orders o WHERE o.customer_id=c.id ORDER BY o.id)) AS order_codes,
  (SELECT MAX(order_date) FROM orders o WHERE o.customer_id=c.id) AS last_order
FROM customers c`;

function listCustomers(q) {
  const p = { today: today() };
  let where = '';
  if (q.search) { where = 'WHERE c.name LIKE :s OR c.code LIKE :s OR c.phone LIKE :s'; p.s = `%${str(q.search, 100)}%`; }
  return db.prepare(`${CUSTOMER_STATS} ${where} ORDER BY c.name`).all(p);
}

function getCustomer(id) {
  const c = db.prepare(`${CUSTOMER_STATS} WHERE c.id = :id`).get({ id: Number(id), today: today() });
  if (!c) throw new HttpError(404, 'العميل غير موجود');
  c.orders = listOrders({ customer_id: c.id });
  return c;
}

function saveCustomer(b, id) {
  const name = str(b.name, 150);
  if (!name) throw new HttpError(400, 'اسم العميل مطلوب');
  const data = [name, str(b.phone, 50), str(b.address, 300), str(b.notes, 1000)];
  let code = str(b.code, 30).toUpperCase();
  const clash = code && db.prepare('SELECT id FROM customers WHERE code=?').get(code);
  if (clash && clash.id !== Number(id)) throw new HttpError(400, 'كود العميل مستخدم قبل كده');
  if (id) {
    const old = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(id));
    if (!old) throw new HttpError(404, 'العميل غير موجود');
    db.prepare('UPDATE customers SET name=?, phone=?, address=?, notes=?, code=? WHERE id=?').run(...data, code || old.code, old.id);
    return getCustomer(old.id);
  }
  if (!code) code = nextCode('customers', 'C-');
  const r = db.prepare('INSERT INTO customers (name, phone, address, notes, code) VALUES (?,?,?,?,?)').run(...data, code);
  return getCustomer(Number(r.lastInsertRowid));
}

// ---------- لوحة التحكم ----------
function dashboard() {
  const p = { today: today() };
  const one = sql => db.prepare(sql).get(p);
  const counts = one(`SELECT
    COUNT(*) AS total,
    SUM(${OPEN}) AS open,
    SUM(${OPEN} AND o.due_date < :today) AS late,
    SUM(${OPEN} AND o.due_date BETWEEN :today AND date(:today,'+3 days')) AS due_soon,
    SUM(o.status='delivered' AND o.delivered_date = :today) AS delivered_today,
    SUM(o.order_date = :today) AS created_today,
    SUM(o.order_date >= date(:today,'start of month')) AS this_month
    FROM orders o`);
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  const money = one(`SELECT COALESCE(SUM(i.quantity*i.price),0) AS value FROM orders o JOIN order_items i ON i.order_id=o.id
    WHERE o.status<>'cancelled' AND o.order_date >= date(:today,'start of month')`);
  const late = listOrders({ late: '1' }).slice(0, 10);
  const soon = listOrders({ due_soon: '1' }).slice(0, 10);
  const topLate = db.prepare(`SELECT c.id, c.name, c.code, COUNT(*) AS n FROM orders o JOIN customers c ON c.id=o.customer_id
    WHERE ${OPEN} AND o.due_date < :today GROUP BY c.id ORDER BY n DESC LIMIT 5`).all(p);
  return { today: p.today, counts, byStatus, month_value: money.value, late, soon, topLate,
    customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n };
}

// ---------- تصدير CSV ----------
function csv(rows, cols) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.map(c => esc(c[1])).join(','), ...rows.map(r => cols.map(c => esc(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(','))].join('\r\n');
}
const ORDER_COLS = [['code', 'كود الطلب'], ['customer_code', 'كود العميل'], ['customer_name', 'العميل'], ['customer_phone', 'التليفون'],
  ['products', 'الأصناف'], ['total_qty', 'إجمالي الكمية'], ['total', 'القيمة'], ['paid', 'المدفوع'], [r => r.total - r.paid, 'المتبقي'],
  ['order_date', 'تاريخ الطلب'], ['due_date', 'موعد التسليم'], [r => STATUS_AR[r.status], 'الحالة'],
  [r => r.priority === 'urgent' ? 'عاجل' : 'عادي', 'الأولوية'], ['days_late', 'أيام التأخير'], ['delivered_date', 'تاريخ التسليم الفعلي'], ['notes', 'ملاحظات']];
const CUSTOMER_COLS = [['code', 'كود العميل'], ['name', 'الاسم'], ['phone', 'التليفون'], ['address', 'العنوان'], ['orders_count', 'عدد الطلبات'],
  ['open_count', 'طلبات مفتوحة'], ['late_count', 'طلبات متأخرة'], ['delivered_count', 'تم تسليمها'], ['total_value', 'إجمالي القيمة'],
  ['total_paid', 'إجمالي المدفوع'], [r => r.total_value - r.total_paid, 'المتبقي'], ['order_codes', 'أكواد الطلبات'], ['last_order', 'آخر طلب']];

// ---------- النسخ الاحتياطي ----------
function backup() {
  const file = path.join(BACKUP_DIR, `orders-${today()}.db`);
  try { fs.rmSync(file, { force: true }); db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); } catch (e) { console.error('Backup failed:', e.message); return null; }
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  return file;
}
backup();
setInterval(backup, 6 * 60 * 60 * 1000).unref();

// ---------- HTTP ----------
const MIME = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(new HttpError(413, 'البيانات كبيرة جدًا')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'بيانات غير صحيحة')); } });
    req.on('error', reject);
  });
}

// ---------- تسجيل الدخول ----------
const SESSION = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('orders-session-v1').digest('hex') : '';
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/healthz', '/login']);
const failures = new Map();

const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2));
}
function authorized(req) {
  return !PASSWORD || safeEqual(cookies(req).sid || '', SESSION);
}
async function login(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new HttpError(429, 'محاولات كتير غلط. استنى ربع ساعة وجرب تاني.');
  const { password } = await readBody(req);
  if (!PASSWORD || !safeEqual(password || '', PASSWORD)) {
    f.n++; if (f.n >= 10) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
    failures.set(ip, f);
    throw new HttpError(401, 'كلمة المرور غلط');
  }
  failures.delete(ip);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `sid=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // بعد /api
  const q = Object.fromEntries(url.searchParams);
  const m = req.method;
  const [res1, id, sub] = parts;

  if (res1 === 'dashboard' && m === 'GET') return send(res, 200, dashboard());
  if (res1 === 'meta' && m === 'GET') return send(res, 200, { statuses: STATUS_AR, today: today(), storage_warning: STORAGE_WARNING, auth: !!PASSWORD });

  if (res1 === 'customers') {
    if (!id && m === 'GET') return send(res, 200, listCustomers(q));
    if (!id && m === 'POST') return send(res, 201, saveCustomer(await readBody(req)));
    if (id && m === 'GET') return send(res, 200, getCustomer(id));
    if (id && m === 'PUT') return send(res, 200, saveCustomer(await readBody(req), id));
    if (id && m === 'DELETE') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id=?').get(Number(id)).n;
      if (n) throw new HttpError(400, `لا يمكن حذف عميل عليه ${n} طلب. احذف طلباته أولاً.`);
      db.prepare('DELETE FROM customers WHERE id=?').run(Number(id));
      return send(res, 200, { ok: true });
    }
  }

  if (res1 === 'orders') {
    if (!id && m === 'GET') return send(res, 200, listOrders(q));
    if (!id && m === 'POST') return send(res, 201, createOrder(await readBody(req)));
    if (id && sub === 'status' && m === 'POST') return send(res, 200, setStatus(id, (await readBody(req)).status));
    if (id && !sub && m === 'GET') return send(res, 200, getOrder(id));
    if (id && !sub && m === 'PUT') return send(res, 200, updateOrder(id, await readBody(req)));
    if (id && !sub && m === 'DELETE') { getOrder(id); db.prepare('DELETE FROM orders WHERE id=?').run(Number(id)); return send(res, 200, { ok: true }); }
  }

  if (res1 === 'export' && m === 'GET') {
    const stamp = today();
    if (id === 'orders.csv') return send(res, 200, csv(listOrders(q), ORDER_COLS), 'text/csv; charset=utf-8',
      { 'Content-Disposition': `attachment; filename="orders-${stamp}.csv"` });
    if (id === 'customers.csv') return send(res, 200, csv(listCustomers(q), CUSTOMER_COLS), 'text/csv; charset=utf-8',
      { 'Content-Disposition': `attachment; filename="customers-${stamp}.csv"` });
    if (id === 'backup.db') {
      const file = backup();
      if (!file) throw new HttpError(500, 'فشل عمل النسخة الاحتياطية');
      return send(res, 200, fs.readFileSync(file), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="orders-backup-${stamp}.db"` });
    }
  }
  throw new HttpError(404, 'غير موجود');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/login' && req.method === 'POST') return await login(req, res);
    if (url.pathname === '/logout') return send(res, 302, '', 'text/plain', { 'Set-Cookie': 'sid=; Path=/; Max-Age=0', Location: '/login.html' });
    if (!authorized(req) && !PUBLIC_PATHS.has(url.pathname)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'لازم تسجل دخول' });
      return send(res, 302, '', 'text/plain', { Location: '/login.html' });
    }
    if (url.pathname === '/login.html' && (!PASSWORD || authorized(req))) return send(res, 302, '', 'text/plain', { Location: '/' });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'حصل خطأ في السيرفر' });
  }
});

// يفتح المتصفح تلقائي لما السيرفر يجهز (بيتفعّل من start-windows.bat)
function openBrowser() {
  if (process.env.OPEN_BROWSER !== '1') return;
  const url = `http://localhost:${PORT}`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  السيستم شغال بالفعل (أو برنامج تاني ماسك البورت ${PORT}).`);
    console.error(`  Port ${PORT} is already in use - the system is probably already running. Opening it in the browser.\n`);
    openBrowser();
  } else console.error(e);
  process.exitCode = 1;
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  نظام طلبات العملاء شغال ✔');
  console.log(`  على الجهاز ده:        http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  من أي جهاز على الشبكة: http://${ip}:${PORT}`);
  console.log(`  قاعدة البيانات: ${DB_FILE}`);
  console.log(PASSWORD ? '  الحماية بكلمة مرور: مفعّلة' : '  تنبيه: مفيش كلمة مرور (APP_PASSWORD)');
  if (STORAGE_WARNING) console.log('  ⚠️ تحذير: مفيش Volume على Railway، البيانات هتتمسح مع أي تحديث!');
  else if (!process.env.RAILWAY_ENVIRONMENT) console.log('  متقفلش الشباك ده طول ما السيستم شغال. Keep this window open while using the system.');
  console.log('');
  openBrowser();
});

const core = { listOrders, getOrder, getOrderByCode, createOrder, setStatus, listCustomers, getCustomer, saveCustomer, dashboard,
  today, getSetting, setSetting, STATUS_AR };

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = require('./bot').createBot({
    token: process.env.TELEGRAM_BOT_TOKEN,
    allowedIds: process.env.TELEGRAM_ALLOWED_IDS,
    dailyHour: process.env.DAILY_REPORT_HOUR,
    publicUrl: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''),
    core,
  });
  bot.start();
}

module.exports = { server, db, core };
