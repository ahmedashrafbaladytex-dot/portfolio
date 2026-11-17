// واجهة Telegram Bot API (long polling — مش محتاج IP ثابت ولا سيرفر على الإنترنت)
'use strict';

function createBot(token) {
  const host = process.env.TELEGRAM_API || 'https://api.telegram.org';
  const base = `${host}/bot${token}`;

  async function api(method, body = {}) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 30000),
    });
    const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }

  // يقسم الرسائل الطويلة (حد تليجرام 4096 حرف) على حدود السطور
  async function send(chatId, text, extra = {}) {
    const parts = [];
    let cur = '';
    for (const line of String(text).split('\n')) {
      if ((cur + '\n' + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
    }
    if (cur) parts.push(cur);
    let last;
    for (let i = 0; i < parts.length; i++) {
      const payload = { chat_id: chatId, text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, ...(i === parts.length - 1 ? extra : {}) };
      try {
        last = await api('sendMessage', payload);
      } catch (e) {
        // لو في مشكلة في تنسيق HTML ابعت نص عادي
        if (/parse entities/i.test(e.message)) last = await api('sendMessage', { ...payload, parse_mode: undefined, text: parts[i].replace(/<[^>]+>/g, '') });
        else throw e;
      }
    }
    return last;
  }

  async function sendDocument(chatId, buffer, fileName, caption = '', mime = 'application/octet-stream') {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) { fd.append('caption', caption.slice(0, 1000)); fd.append('parse_mode', 'HTML'); }
    fd.append('document', new Blob([buffer], { type: mime }), fileName);
    const res = await fetch(`${base}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await res.json();
    if (!j.ok) throw new Error(`Telegram sendDocument: ${j.description}`);
    return j.result;
  }

  async function download(fileId) {
    const f = await api('getFile', { file_id: fileId });
    const res = await fetch(`${host}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error('تعذر تحميل الملف من تليجرام');
    return Buffer.from(await res.arrayBuffer());
  }

  return { api, send, sendDocument, download };
}

module.exports = { createBot };
