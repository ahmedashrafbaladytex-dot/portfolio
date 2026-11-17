// أدوات مشتركة: تطبيع النص العربي، الأرقام، التواريخ، والتنسيق
'use strict';

const TZ = process.env.TZ_NAME || 'Africa/Cairo';

// ٠١٢٣٤٥٦٧٨٩ و ۰۱۲۳۴۵۶۷۸۹ → 0123456789
function toLatinDigits(s) {
  return String(s ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

// تطبيع للمقارنة: بدون تشكيل، أ/إ/آ → ا، ة → ه، ى → ي، مسافات موحدة، حروف صغيرة
function norm(s) {
  return toLatinDigits(s)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[_\-:.\/\\()\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// "1,250.50 ج.م" أو "١٬٢٥٠٫٥" → 1250.5
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = toLatinDigits(v).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// تاريخ Excel التسلسلي → YYYY-MM-DD
function excelSerialToDate(n) {
  return ymd(new Date(Math.round((n - 25569) * 86400000)));
}

// يقبل: 2026-11-17 ، 17/11/2026 ، 17-11-26 ، 17.11.2026 ، رقم Excel ، Date
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : ymd(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelSerialToDate(v) : null;
  const s = toLatinDigits(v).trim();
  let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    // الافتراضي في مصر: يوم/شهر/سنة. لو الرقم التاني أكبر من 12 يبقى شهر/يوم
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return valid(y, mo, d);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return toDate(Number(s));
  return null;
}
function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// تاريخ النهارده بتوقيت القاهرة
function today(tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function nowParts(tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { hour: +p.hour, minute: +p.minute, weekday: wd };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

const fmt = (n, digits = 0) => (n == null || !Number.isFinite(n)) ? '—'
  : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (n, digits = 0) => (n == null || !Number.isFinite(n)) ? '—' : `${(n * 100).toFixed(digits)}%`;
const signedPct = n => (n == null || !Number.isFinite(n)) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sum = arr => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const mean = arr => arr.length ? sum(arr) / arr.length : 0;
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map(x => (x - m) ** 2)) / (arr.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

module.exports = {
  TZ, toLatinDigits, norm, toNumber, toDate, today, nowParts, addDays, daysBetween,
  fmt, pct, signedPct, esc, sum, mean, std, quantile, ymd,
};
