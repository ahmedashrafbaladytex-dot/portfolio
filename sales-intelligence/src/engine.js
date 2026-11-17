// تحميل الإعدادات وتشغيل التحليل (مشترك بين البوت وسكربتات التجربة)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyze, periodSummary } = require('./analytics');
const { syncOrders } = require('./orders-sync');

const ROOT = path.join(__dirname, '..');

// يقرا settings.env (KEY=VALUE) — المتغيرات اللي متعرّفة في النظام ليها الأولوية
function loadSettings(file = path.join(ROOT, 'settings.env')) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] == null && v !== '') process.env[k] = v;
  }
  return true;
}

// يكتب قيمة في settings.env (بينشئه من النموذج لو مش موجود) — عشان محدش يفتح الملف بإيده
function saveSetting(key, value, file = path.join(ROOT, 'settings.env')) {
  if (!fs.existsSync(file)) {
    const ex = path.join(ROOT, 'settings.example.env');
    fs.writeFileSync(file, fs.existsSync(ex) ? fs.readFileSync(ex) : '');
  }
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const i = lines.findIndex(l => l.trim().startsWith(key + '='));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n'));
  process.env[key] = String(value);
}

function config() {
  const num = (k, d) => (process.env[k] != null && process.env[k] !== '' ? Number(process.env[k]) : d);
  const defaultOrdersDb = path.join(ROOT, '..', 'orders-system', 'data', 'orders.db');
  return {
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedChats: (process.env.ALLOWED_CHATS || '').split(/[,\s]+/).filter(Boolean),
    reportChat: process.env.REPORT_CHAT || (process.env.ALLOWED_CHATS || '').split(/[,\s]+/).filter(Boolean)[0] || '',
    dailyTime: process.env.DAILY_REPORT_TIME || '21:00',
    weeklyDay: num('WEEKLY_REPORT_DAY', 4), // 0 الأحد ... 4 الخميس
    window: num('ANALYSIS_DAYS', 90),
    leadTimeDays: num('LEAD_TIME_DAYS', 14),
    coverDays: num('COVER_DAYS', 30),
    returnAlert: num('RETURN_ALERT', 0.1),
    ordersDb: process.env.ORDERS_DB === 'off' ? '' : (process.env.ORDERS_DB || defaultOrdersDb),
  };
}

function run(store, cfg, asOf) {
  if (cfg.ordersDb) {
    try { syncOrders(store, cfg.ordersDb); } catch (e) { console.warn('تعذر قراءة نظام الطلبات:', e.message); }
  }
  const data = { lines: store.allLines(), items: store.items(), stock: store.stock() };
  return {
    data,
    analysis: analyze(data, { asOf, window: cfg.window, leadTimeDays: cfg.leadTimeDays, coverDays: cfg.coverDays, returnAlert: cfg.returnAlert }),
    period: (from, to) => periodSummary(data.lines, from, to, data.items),
  };
}

module.exports = { loadSettings, saveSetting, config, run, ROOT };
