// قاعدة البيانات: الفواتير والمرتجعات والطلبيات والأصناف والمخزون
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { norm } = require('./util');
const { inferAttributes } = require('./attributes');

const DOC_TYPES = ['sale', 'return', 'order'];
const TYPE_AR = { sale: 'فاتورة مبيعات', return: 'فاتورة مرتجع', order: 'طلبية عميل' };

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'intel.db'));
  db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('sale','return','order')),
  doc_no TEXT NOT NULL,
  doc_date TEXT NOT NULL,
  customer TEXT DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  source TEXT DEFAULT '',
  file_name TEXT DEFAULT '',
  chat_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(type, doc_no)
);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  item_code TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  reason TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS items (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  category TEXT DEFAULT '',
  fabric TEXT DEFAULT '',
  color TEXT DEFAULT '',
  pattern TEXT DEFAULT '',
  size TEXT DEFAULT '',
  attr_source TEXT DEFAULT 'rules',
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS stock (
  item_code TEXT PRIMARY KEY,
  qty REAL NOT NULL,
  as_of TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_docs_date ON docs(doc_date);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON lines(doc_id);
CREATE INDEX IF NOT EXISTS idx_lines_item ON lines(item_code);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name_key);
`);
  return wrap(db);
}

function wrap(db) {
  const tx = fn => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const getMeta = k => db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? null;
  const setMeta = (k, v) => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

  // يلاقي كود الصنف من الكود أو الاسم، ولو جديد يسجّله ويستنتج خصائصه
  function resolveItem(line) {
    const code = String(line.item_code || '').trim();
    const name = String(line.item_name || '').trim();
    let row = null;
    if (code) row = db.prepare('SELECT * FROM items WHERE code=?').get(code);
    if (!row && name) row = db.prepare('SELECT * FROM items WHERE name_key=?').get(norm(name));
    const explicit = pick(line, ['category', 'fabric', 'color', 'pattern', 'size']);
    if (row) {
      // أكمل الخصائص اللي جاية صريحة في الملف (أدق من الاستنتاج)
      const upd = Object.entries(explicit).filter(([, v]) => v);
      if (upd.length) {
        db.prepare(`UPDATE items SET ${upd.map(([k]) => `${k}=?`).join(',')}, attr_source='file', updated_at=datetime('now','localtime') WHERE code=?`)
          .run(...upd.map(([, v]) => v), row.code);
      }
      return row.code;
    }
    const newCode = code || name;
    if (!newCode) return null;
    const attrs = { ...inferAttributes(name || code), ...Object.fromEntries(Object.entries(explicit).filter(([, v]) => v)) };
    db.prepare(`INSERT INTO items(code,name,name_key,category,fabric,color,pattern,size,attr_source) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(newCode, name || code, norm(name || code), attrs.category || '', attrs.fabric || '', attrs.color || '',
        attrs.pattern || '', attrs.size || '', Object.values(explicit).some(Boolean) ? 'file' : 'rules');
    return newCode;
  }

  // يحفظ مستند (فاتورة/مرتجع/طلبية). لو نفس الرقم اتبعت قبل كده بيتستبدل
  function saveDoc(doc) {
    if (!DOC_TYPES.includes(doc.type)) throw new Error('نوع مستند غير معروف');
    const lines = (doc.lines || []).filter(l => (l.item_code || l.item_name) && Number(l.qty) > 0);
    if (!lines.length) throw new Error('مفيش أصناف بكميات في المستند');
    const docNo = String(doc.doc_no || '').trim() || 'AUTO-' + crypto.createHash('sha1')
      .update(JSON.stringify([doc.doc_date, doc.customer, lines.map(l => [l.item_code, l.item_name, l.qty, l.price])])).digest('hex').slice(0, 10);
    return tx(() => {
      const existing = db.prepare('SELECT id FROM docs WHERE type=? AND doc_no=?').get(doc.type, docNo);
      if (existing) db.prepare('DELETE FROM docs WHERE id=?').run(existing.id);
      const total = lines.reduce((a, l) => a + (Number(l.total) || 0), 0);
      const { lastInsertRowid } = db.prepare(`INSERT INTO docs(type,doc_no,doc_date,customer,total,source,file_name,chat_id) VALUES(?,?,?,?,?,?,?,?)`)
        .run(doc.type, docNo, doc.doc_date, doc.customer || '', total, doc.source || '', doc.file_name || '', String(doc.chat_id || ''));
      const ins = db.prepare('INSERT INTO lines(doc_id,item_code,qty,price,total,reason) VALUES(?,?,?,?,?,?)');
      for (const l of lines) {
        const code = resolveItem(l);
        ins.run(lastInsertRowid, code, Number(l.qty), Number(l.price) || 0, Number(l.total) || 0, l.reason || '');
      }
      return { id: Number(lastInsertRowid), doc_no: docNo, replaced: !!existing, lines: lines.length, total };
    });
  }

  function saveStock(rows, asOf) {
    return tx(() => {
      let n = 0;
      for (const r of rows) {
        const code = resolveItem(r);
        if (!code || r.qty == null) continue;
        db.prepare('INSERT INTO stock(item_code,qty,as_of) VALUES(?,?,?) ON CONFLICT(item_code) DO UPDATE SET qty=excluded.qty, as_of=excluded.as_of')
          .run(code, Number(r.qty), asOf);
        n++;
      }
      return n;
    });
  }

  // ملف بيانات الأصناف (كود، اسم، فئة، خامة، لون، ...)
  function saveItems(rows) {
    return tx(() => {
      let n = 0;
      for (const r of rows) if (resolveItem(r)) n++;
      return n;
    });
  }

  function updateItemAttrs(code, attrs, source = 'ai') {
    const keys = ['category', 'fabric', 'color', 'pattern', 'size'].filter(k => attrs[k]);
    if (!keys.length) return;
    db.prepare(`UPDATE items SET ${keys.map(k => `${k}=?`).join(',')}, attr_source=?, updated_at=datetime('now','localtime') WHERE code=?`)
      .run(...keys.map(k => attrs[k]), source, code);
  }

  function deleteDoc(id) { return db.prepare('DELETE FROM docs WHERE id=?').run(id).changes; }
  function lastDoc(chatId) {
    return db.prepare('SELECT * FROM docs WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(String(chatId));
  }

  // كل السطور مع تاريخها ونوعها والعميل (للتحليل)
  function allLines(from = '0000-00-00', to = '9999-12-31') {
    return db.prepare(`SELECT d.type, d.doc_date AS date, d.customer, d.doc_no, l.item_code AS code, l.qty, l.price, l.total, l.reason
      FROM lines l JOIN docs d ON d.id=l.doc_id WHERE d.doc_date BETWEEN ? AND ? ORDER BY d.doc_date`).all(from, to);
  }
  const items = () => db.prepare('SELECT * FROM items').all();
  const stock = () => db.prepare('SELECT * FROM stock').all();
  const counts = () => db.prepare(`SELECT type, COUNT(*) n, MIN(doc_date) first, MAX(doc_date) last FROM docs GROUP BY type`).all();

  return { db, tx, getMeta, setMeta, saveDoc, saveStock, saveItems, updateItemAttrs, deleteDoc, lastDoc, allLines, items, stock, counts, resolveItem };
}

function pick(o, keys) {
  return Object.fromEntries(keys.map(k => [k, o[k] ? String(o[k]).trim() : '']));
}

module.exports = { open, DOC_TYPES, TYPE_AR };
