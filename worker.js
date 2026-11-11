/* =====================================================================
   القعقاع — Cloudflare Worker (بديل tg-proxy-worker.js، نفس الرابط القديم يشتغل)
   1) Webhook البوت: يستقبل فيديو/صوت من القنوات فوراً ويحفظه في Turso مرة وحدة فقط
   2) بث الملفات للموقع كمشغّل نظيف: /m/<id>  (فيديو/صوت)  و /t/<id> (صورة مصغّرة)
   3) توافق مع القديم: /?url=https://t.me/قناة/رقم  (&thumb=1 &dl=اسم)
   4) Web Push: إشعارات حتى لو الموقع مسكّر
   5) /dedupe : تنظيف المكرر القديم (يبقي نسخة وحدة)
   ===================================================================== */

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Range',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
};

/* ------------------------------ Turso ------------------------------ */
function targ(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}
let tableReady = false;
async function sql(env, stmts) {
  const base = env.TURSO_URL.replace(/^libsql:\/\//, 'https://');
  const reqs = [];
  if (!tableReady) {
    reqs.push({ type: 'execute', stmt: { sql: 'CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, upd INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (col, id))' } });
    reqs.push({ type: 'execute', stmt: { sql: 'CREATE INDEX IF NOT EXISTS docs_col_upd ON docs(col, upd)' } });
  }
  const off = reqs.length;
  stmts.forEach((s) => reqs.push({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(targ) } }));
  reqs.push({ type: 'close' });
  const r = await fetch(base + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: reqs }),
  });
  if (!r.ok) throw new Error('turso http ' + r.status);
  const j = await r.json();
  tableReady = true;
  return stmts.map((_, i) => {
    const x = j.results[off + i];
    if (!x || x.type === 'error') throw new Error((x && x.error && x.error.message) || 'turso error');
    const res = x.response.result;
    return {
      n: res.affected_row_count || 0,
      rows: (res.rows || []).map((row) => row.map((c) => (!c || c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.value))),
    };
  });
}
const pj = (t) => { try { return JSON.parse(t); } catch (e) { return {}; } };

/* ------------------------- مفتاح منع التكرار ------------------------ */
/* نرجّع كل المفاتيح الممكنة (مش مفتاح واحد): نفس المنشور بيوصلك مرة من الـ Webhook (عنده fuid)
   ومرة من لوحة التحكم (رابط t.me فقط)، وممكن تتضاف مرتين بعنوان ووصف متطابقين برابط مختلف */
const normTxt = (s) => String(s || '').toLowerCase().replace(/[\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
export function dupKeys(d) {
  if (!d) return [];
  const ks = [];
  if (d.fuid) ks.push('f|' + d.fuid);
  let mkey = '';
  if (d.tgkey) mkey = String(d.tgkey).toLowerCase();
  else {
    const m = String(d.link || '').match(/(?:t\.me|telegram\.me)\/(?:s\/)?(c\/\d+|[A-Za-z0-9_]{4,})\/(\d+)/i);
    if (m) mkey = (m[1] + '/' + m[2]).toLowerCase();
  }
  if (mkey) ks.push('m|' + mkey);
  const t = normTxt(d.title), de = normTxt(d.desc);
  if (t) ks.push('d|' + d.sec + '|' + t + '|' + de);
  return ks;
}

/* ------------------------- تحليل منشور تلجرام ----------------------- */
export function parseTgPost(m, allowedCsv) {
  if (!m || !m.chat) return null;
  const chat = m.chat;
  const user = chat.username ? String(chat.username).toLowerCase() : '';
  const allowed = String(allowedCsv || '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (allowed.length && !allowed.includes(user) && !allowed.includes(String(chat.id))) return null;

  let obj = null, sec = '';
  if (m.video) { obj = m.video; sec = 'releases'; }
  else if (m.video_note) { obj = m.video_note; sec = 'releases'; }
  else if (m.audio) { obj = m.audio; sec = 'anashid'; }
  else if (m.voice) { obj = m.voice; sec = 'anashid'; }
  else if (m.document) {
    const mt = String(m.document.mime_type || '');
    if (mt.startsWith('video/')) { obj = m.document; sec = 'releases'; }
    else if (mt.startsWith('audio/')) { obj = m.document; sec = 'anashid'; }
  }
  if (!obj || !obj.file_id) return null;

  const cap = String(m.caption || m.text || '').trim();
  const lines = cap.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fallback = (sec === 'releases' ? 'إصدار ' : 'أنشودة ') + m.message_id;
  let title = (lines[0] || obj.title || (obj.file_name || '').replace(/\.[A-Za-z0-9]{2,4}$/, '') || fallback).slice(0, 80);
  const desc = lines.slice(1).join('\n').slice(0, 500);
  const absId = String(Math.abs(chat.id));
  const cid = absId.replace(/^100/, '');
  const th = obj.thumbnail || obj.thumb || null;
  return {
    sec, chatId: chat.id, chatUser: user, mid: m.message_id,
    fuid: obj.file_unique_id || '', fid: obj.file_id, tfid: th ? th.file_id : '',
    mime: obj.mime_type || '', dur: obj.duration || 0,
    title, desc, ts: (m.date || Math.floor(Date.now() / 1000)) * 1000,
    docId: 'tg_' + absId + '_' + m.message_id,
    tgkey: user ? user + '/' + m.message_id : 'c/' + cid + '/' + m.message_id,
  };
}

/* ----------------------- استقبال Webhook البوت ---------------------- */
async function handleUpdate(env, ctx, origin, upd) {
  const edited = !!(upd.edited_channel_post || upd.edited_message);
  const m = upd.channel_post || upd.edited_channel_post || upd.message || upd.edited_message;
  const p = parseTgPost(m, env.ALLOWED_CHATS);
  if (!p) return;
  const pub = (env.PUBLIC_URL || origin).replace(/\/$/, '');
  const likeA = '%t.me/' + p.tgkey, likeB = '%t.me/' + p.tgkey + '?%';

  /* هل موجود مسبقاً؟ (نفس الملف، نفس الرسالة، أو نفس رابط الرسالة المضاف من لوحة التحكم) */
  const ex = await sql(env, [{
    sql: "SELECT id, data FROM docs WHERE col='content' AND (id=? OR json_extract(data,'$.fuid')=? OR json_extract(data,'$.tgkey')=? OR json_extract(data,'$.link') LIKE ? OR json_extract(data,'$.link') LIKE ?) ORDER BY upd ASC LIMIT 5",
    args: [p.docId, p.fuid || '-', p.tgkey, likeA, likeB],
  }]);
  if (ex[0].rows.length) {
    if (edited) { /* تعديل الوصف فقط، بدون إشعار وبدون نسخة جديدة */
      const keep = ex[0].rows[0];
      await sql(env, [{
        sql: "UPDATE docs SET data=json_patch(data,?), upd=? WHERE col='content' AND id=?",
        args: [JSON.stringify({ title: p.title, desc: p.desc }), Date.now(), keep[0]],
      }]);
    }
    return; /* موجود = لا إضافة ثانية */
  }
  /* فحص إضافي: نفس القسم + نفس العنوان + نفس الوصف = مكرر حتى لو الرابط/الرسالة مختلفة */
  const sameContent = await sql(env, [{
    sql: "SELECT id FROM docs WHERE col='content' AND json_extract(data,'$.sec')=? AND lower(json_extract(data,'$.title'))=? AND lower(json_extract(data,'$.desc'))=? LIMIT 1",
    args: [p.sec, normTxt(p.title), normTxt(p.desc)],
  }]);
  if (sameContent[0].rows.length) return;
  if (edited && !p.title) return;

  const doc = {
    sec: p.sec, id: p.docId,
    n: p.ts + (p.mid % 1000),
    title: p.title, desc: p.desc,
    link: pub + '/m/' + p.docId,
    thumbLink: p.tfid ? pub + '/t/' + p.docId : '',
    pinned: false, tg: true,
    chat: p.chatId, mid: p.mid, tgkey: p.tgkey, fuid: p.fuid, fid: p.fid, tfid: p.tfid, mime: p.mime, dur: p.dur,
  };
  const r = await sql(env, [{
    sql: "INSERT INTO docs(col,id,data,upd) VALUES('content',?,?,?) ON CONFLICT(col,id) DO NOTHING",
    args: [p.docId, JSON.stringify(doc), Date.now()],
  }]);
  if (r[0].n === 1) { /* هذا الاستقبال هو اللي أضاف فعلاً → إشعار مرة وحدة */
    await queueEvent(env, ctx, {
      to: 'all',
      title: p.sec === 'releases' ? 'إصدار فيديو جديد 🎬' : 'نشيد جديد 🎵',
      body: p.title, tag: 'media-' + p.docId, url: '/',
    });
  }
}

/* ------------------------ حل الرابط → ملف مباشر ---------------------- */
async function tgGetFile(env, fid) {
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/getFile?file_id=' + encodeURIComponent(fid));
  const j = await r.json().catch(() => ({}));
  if (!j.ok || !j.result || !j.result.file_path) return null;
  return 'https://api.telegram.org/file/bot' + env.BOT_TOKEN + '/' + j.result.file_path;
}
const decodeAmp = (s) => String(s || '').replace(/&amp;/g, '&');
async function embedScrape(user, mid) {
  const r = await fetch('https://t.me/' + user + '/' + mid + '?embed=1&mode=tme', { headers: { 'User-Agent': UA } });
  if (!r.ok) return {};
  const h = await r.text();
  const av = h.match(/<(video|audio)[^>]*\ssrc="([^"]+)"/i);
  const poster = h.match(/<video[^>]*\sposter="([^"]+)"/i);
  const bg = (cls) => { const x = h.match(new RegExp(cls + '[^>]*style="[^"]*url\\(\'([^\']+)\'\\)', 'i')); return x ? decodeAmp(x[1]) : ''; };
  const photo = bg('tgme_widget_message_photo_wrap');
  const thumb = bg('tgme_widget_message_video_thumb') || bg('tgme_widget_message_roundvideo_thumb') || (poster ? decodeAmp(poster[1]) : '') || photo;
  return { media: av ? decodeAmp(av[2]) : '', kind: av ? av[1].toLowerCase() : '', photo, thumb };
}
async function cached(key, ttl, fn) {
  const c = caches.default, k = new Request('https://cache.qaqa.internal/' + encodeURIComponent(key));
  const hit = await c.match(k);
  if (hit) return hit.json();
  const v = await fn();
  if (v) await c.put(k, new Response(JSON.stringify(v), { headers: { 'Cache-Control': 'max-age=' + ttl } }));
  return v;
}
async function dropCache(key) { await caches.default.delete(new Request('https://cache.qaqa.internal/' + encodeURIComponent(key))); }

async function resolveDoc(env, id, want) {
  const k = 'doc|' + id + '|' + want;
  return cached(k, 1200, async () => {
    const r = await sql(env, [{ sql: "SELECT data FROM docs WHERE col='content' AND id=?", args: [id] }]);
    if (!r[0].rows.length) return null;
    const d = pj(r[0].rows[0][0]);
    const user = String(d.tgkey || '').split('/')[0];
    const pubUser = user && user !== 'c' ? user : '';
    let url = '';
    if (want === 'thumb') {
      if (d.tfid) url = await tgGetFile(env, d.tfid);
      if (!url && pubUser) url = (await embedScrape(pubUser, d.mid)).thumb;
    } else {
      if (pubUser && env.PREFER_EMBED !== '0') url = (await embedScrape(pubUser, d.mid)).media;
      if (!url && d.fid) url = await tgGetFile(env, d.fid);
    }
    return url ? { url, mime: d.mime || '' } : null;
  });
}
async function resolveLink(env, ch, mid, want) {
  const k = 'lnk|' + ch + '|' + mid + '|' + want;
  return cached(k, 1200, async () => {
    const e = await embedScrape(ch, mid);
    const url = want === 'thumb' ? e.thumb : want === 'photo' ? (e.photo || e.thumb) : e.media;
    return url ? { url, mime: '' } : null;
  });
}

const ALLOWED_HOST = /(^|\.)(t\.me|telegram\.me|telesco\.pe|cdn-telegram\.org|telegram-cdn\.org|telegram\.org)$/i;
async function proxyStream(req, target, opts) {
  const u = new URL(target);
  if (!ALLOWED_HOST.test(u.hostname)) return new Response('forbidden', { status: 403, headers: CORS });
  const h = new Headers({ 'User-Agent': UA });
  const range = req.headers.get('Range');
  if (range) h.set('Range', range);
  const up = await fetch(target, { headers: h, redirect: 'follow' });
  const out = new Headers(CORS);
  ['content-length', 'content-range', 'etag', 'last-modified'].forEach((n) => { const v = up.headers.get(n); if (v) out.set(n, v); });
  let ct = (up.headers.get('content-type') || '').split(';')[0];
  const path = u.pathname.toLowerCase();
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') {
    ct = /\.(mp3)$/.test(path) ? 'audio/mpeg' : /\.(m4a|aac)$/.test(path) ? 'audio/mp4' : /\.(ogg|oga|opus)$/.test(path) ? 'audio/ogg' : /\.(webm)$/.test(path) ? 'video/webm' : /\.(jpg|jpeg)$/.test(path) ? 'image/jpeg' : /\.(png)$/.test(path) ? 'image/png' : /\.(webp)$/.test(path) ? 'image/webp' : (opts && opts.kind === 'audio') ? 'audio/mpeg' : 'video/mp4';
  }
  out.set('Content-Type', ct);
  out.set('Accept-Ranges', 'bytes');
  out.set('Cache-Control', 'public, max-age=3600');
  if (opts && opts.dl) out.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(opts.dl));
  return new Response(up.body, { status: up.status, headers: out });
}

async function serveMedia(env, req, id, want) {
  let r = await resolveDoc(env, id, want);
  if (!r) return new Response('not found', { status: 404, headers: CORS });
  let res = await proxyStream(req, r.url, { kind: /^audio/.test(r.mime) ? 'audio' : '' });
  if ([403, 404, 410].includes(res.status)) { /* رابط انتهت صلاحيته → جدّد مرة وحدة */
    await dropCache('doc|' + id + '|' + want);
    r = await resolveDoc(env, id, want);
    if (r) res = await proxyStream(req, r.url, { kind: /^audio/.test(r.mime) ? 'audio' : '' });
  }
  return res;
}
async function serveLegacy(env, req, url) {
  const target = url.searchParams.get('url') || '';
  let t; try { t = new URL(target); } catch (e) { return new Response('bad url', { status: 400, headers: CORS }); }
  if (!ALLOWED_HOST.test(t.hostname)) return new Response('forbidden', { status: 403, headers: CORS });
  const m = t.pathname.match(/^\/(?:s\/)?([A-Za-z0-9_]{4,})\/(\d+)\/?$/);
  const dl = url.searchParams.get('dl') || '';
  if (/^(t\.me|telegram\.me)$/i.test(t.hostname) && m) {
    const want = url.searchParams.get('thumb') ? 'thumb' : 'media';
    const ch = m[1].toLowerCase(), mid = m[2];
    let r = await resolveLink(env, ch, mid, want);
    if (!r && want === 'media') r = await resolveLink(env, ch, mid, 'photo');
    /* fallback: إذا فشل scrape التضمين، دوّر المنشور بقاعدة البيانات واستخدم getFile تبع البوت (حتى 20MB) */
    if (!r) {
      const q = await sql(env, [{ sql: "SELECT id FROM docs WHERE col='content' AND json_extract(data,'$.tgkey')=? LIMIT 1", args: [ch + '/' + mid] }]);
      if (q[0].rows.length) r = await resolveDoc(env, q[0].rows[0][0], want === 'thumb' ? 'thumb' : 'media');
    }
    if (!r) return new Response('not found', { status: 404, headers: CORS });
    return proxyStream(req, r.url, { dl });
  }
  /* صفحات t.me العادية (t.me/s/قناة …) أو ملفات CDN مباشرة */
  const res = await proxyStream(req, target, { dl });
  if (/text\/html/.test(res.headers.get('content-type') || '')) res.headers.set('Cache-Control', 'no-store');
  return res;
}

/* ============================== Web Push ============================= */
const b64u = (buf) => {
  const b = typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = ''; b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function sha32(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
export async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + env.VAPID_PUBLIC;
}
async function pushTo(env, sub) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuth(env, sub.endpoint), TTL: '3600', Urgency: 'high', 'Content-Length': '0' },
    });
    if (r.status === 404 || r.status === 410) await sql(env, [{ sql: "DELETE FROM docs WHERE col='push_subs' AND id=?", args: [sub.id] }]);
    return r.status;
  } catch (e) { return 0; }
}
/* يسجّل الحدث ثم يرسل نبضة Push للمشتركين المعنيين (الـ SW يجلب نص الإشعار من /push/feed) */
async function queueEvent(env, ctx, ev) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return;
  const ts = Date.now();
  ev.ts = ts;
  await sql(env, [
    { sql: "INSERT INTO docs(col,id,data,upd) VALUES('push_q',?,?,?)", args: [ts + '_' + Math.random().toString(36).slice(2, 7), JSON.stringify(ev), ts] },
    { sql: "DELETE FROM docs WHERE col='push_q' AND upd<?", args: [ts - 2 * 86400000] },
  ]);
  let q;
  if (ev.to === 'all') q = { sql: "SELECT id,data FROM docs WHERE col='push_subs'", args: [] };
  else if (ev.to === 'admin') q = { sql: "SELECT id,data FROM docs WHERE col='push_subs' AND json_extract(data,'$.role')='admin'", args: [] };
  else q = { sql: "SELECT id,data FROM docs WHERE col='push_subs' AND json_extract(data,'$.username')=?", args: [String(ev.to).replace(/^u:/, '')] };
  const subs = (await sql(env, [q]))[0].rows.map((r) => ({ id: r[0], ...pj(r[1]) })).filter((s) => s.endpoint);
  const job = (async () => { for (let i = 0; i < subs.length; i += 20) await Promise.all(subs.slice(i, i + 20).map((s) => pushTo(env, s))); })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
}
const adminList = (env) => String(env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const lc = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

async function pushRoutes(env, ctx, req, url) {
  const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  const p = url.pathname;
  if (p === '/push/config') return J({ key: env.VAPID_PUBLIC || '' });

  if (p === '/push/subscribe' && req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b || !b.sub || !b.sub.endpoint) return J({ ok: false }, 400);
    const username = lc(b.username);
    const role = b.role === 'admin' && adminList(env).includes(username) ? 'admin' : 'user';
    const id = await sha32(b.sub.endpoint);
    await sql(env, [{
      sql: "INSERT INTO docs(col,id,data,upd) VALUES('push_subs',?,?,?) ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, upd=excluded.upd",
      args: [id, JSON.stringify({ endpoint: b.sub.endpoint, role, username }), Date.now()],
    }]);
    return J({ ok: true, role, id });
  }

  if (p === '/push/feed') {
    const id = url.searchParams.get('ep') || '';
    const since = Number(url.searchParams.get('since') || 0);
    const s = (await sql(env, [{ sql: "SELECT data FROM docs WHERE col='push_subs' AND id=?", args: [id] }]))[0].rows[0];
    if (!s) return J({ items: [] });
    const sub = pj(s[0]);
    const rows = (await sql(env, [{ sql: "SELECT data FROM docs WHERE col='push_q' AND upd>? ORDER BY upd ASC LIMIT 30", args: [since] }]))[0].rows;
    const items = rows.map((r) => pj(r[0])).filter((e) =>
      e.to === 'all' || (e.to === 'admin' && sub.role === 'admin') || e.to === 'u:' + sub.username);
    return J({ items: items.slice(-4) });
  }

  /* الموقع يخبر الـ Worker بحدث؛ الـ Worker يتحقق منه من قاعدة البيانات نفسها قبل ما يرسل أي شي */
  if (p === '/push/event' && req.method === 'POST') {
    const b = await req.json().catch(() => null);
    if (!b) return J({ ok: false }, 400);
    if (b.type === 'msg' || b.type === 'reply') {
      const r = await sql(env, [{ sql: "SELECT data FROM docs WHERE col='support' AND id=?", args: [String(b.sid || '')] }]);
      if (!r[0].rows.length) return J({ ok: false }, 404);
      const d = pj(r[0].rows[0][0]);
      if (Date.now() - Number(d.ts || 0) > 10 * 60000) return J({ ok: false }, 410);
      const mark = await sql(env, [{ sql: "UPDATE docs SET data=json_set(data,'$.pushed',1) WHERE col='support' AND id=? AND json_extract(data,'$.pushed') IS NULL", args: [String(b.sid)] }]);
      if (mark[0].n !== 1) return J({ ok: true, dup: true });
      if (b.type === 'msg' && d.f === 'u') await queueEvent(env, ctx, { to: 'admin', title: 'رسالة جديدة 💬', body: 'من ' + (d.name || d.username || 'مستخدم'), tag: 'msg-' + lc(d.uid), url: '/#admin' });
      else if (b.type === 'reply' && d.f === 'a') await queueEvent(env, ctx, { to: 'u:' + lc(d.uid), title: 'رد من فريق الدعم 💬', body: 'وصلك رد على رسالتك', tag: 'reply-' + lc(d.uid), url: '/' });
      return J({ ok: true });
    }
    if (b.type === 'verify') {
      const u = lc(b.username);
      const r = await sql(env, [{ sql: "SELECT data, upd FROM docs WHERE col='users' AND id=?", args: [encodeURIComponent(u)] }]);
      if (!r[0].rows.length) return J({ ok: false }, 404);
      const d = pj(r[0].rows[0][0]), upd = r[0].rows[0][1];
      if (!d.verified) return J({ ok: false }, 409);
      const tag = 'verify-' + u + '-' + (d.verifiedAt || upd);
      const ex = await sql(env, [{ sql: "SELECT 1 FROM docs WHERE col='push_q' AND json_extract(data,'$.tag')=? LIMIT 1", args: [tag] }]);
      if (ex[0].rows.length) return J({ ok: true, dup: true });
      await queueEvent(env, ctx, { to: 'u:' + u, title: 'تم توثيق حسابك ✅', body: 'مبروك! تم توثيق حسابك من قبل الإدارة', tag, url: '/' });
      return J({ ok: true });
    }
  }
  return J({ ok: false }, 404);
}

/* ============================ تنظيف المكرر =========================== */
async function dedupe(env, apply) {
  const rows = (await sql(env, [{ sql: "SELECT id, data FROM docs WHERE col='content'", args: [] }]))[0].rows;
  const items = [];
  rows.forEach((r) => {
    const d = pj(r[1]);
    if (d.sec === 'channels') return;
    const ks = dupKeys(d);
    if (ks.length) items.push({ id: r[0], d, ks });
  });
  /* union-find: أي عنصرين يشاركان أي مفتاح (fuid أو tgkey/رابط أو عنوان+وصف) بمجموعة وحدة */
  const groups = {};
  items.forEach((it, i) => it.ks.forEach((k) => { (groups[k] = groups[k] || []).push(i); }));
  const parent = items.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  Object.keys(groups).forEach((k) => {
    const idxs = groups[k];
    for (let j = 1; j < idxs.length; j++) {
      const a = find(idxs[0]), b = find(idxs[j]);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const clusters = {};
  items.forEach((it, i) => { const rt = find(i); (clusters[rt] = clusters[rt] || []).push(it); });
  const del = [];
  Object.keys(clusters).forEach((rt) => {
    const g = clusters[rt];
    if (g.length < 2) return;
    g.sort((a, b) => (b.d.pinned ? 1 : 0) - (a.d.pinned ? 1 : 0) || (a.d.fuid ? 0 : 1) - (b.d.fuid ? 0 : 1) || (a.d.n || 0) - (b.d.n || 0));
    g.slice(1).forEach((x) => del.push({ id: x.id, keep: g[0].id, key: x.ks[0] }));
  });
  if (apply) for (let i = 0; i < del.length; i += 50) await sql(env, del.slice(i, i + 50).map((x) => ({ sql: "DELETE FROM docs WHERE col='content' AND id=?", args: [x.id] })));
  return { scanned: rows.length, duplicates: del.length, applied: !!apply, items: del.slice(0, 100) };
}

/* ================================ الدخول ============================== */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (p === '/tg' && req.method === 'POST') {
        if (env.WEBHOOK_SECRET && req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('no', { status: 403 });
        const upd = await req.json().catch(() => null);
        /* نرد فوراً لتلجرام (يمنع إعادة الإرسال = أحد أسباب التكرار) ونكمل الشغل بالخلفية */
        if (upd) ctx.waitUntil(handleUpdate(env, ctx, url.origin, upd).catch((e) => console.log('tg err', e && e.message)));
        return new Response('ok');
      }
      let m;
      if ((m = p.match(/^\/m\/([\w-]+)$/)) && (req.method === 'GET' || req.method === 'HEAD')) return serveMedia(env, req, m[1], 'media');
      if ((m = p.match(/^\/t\/([\w-]+)$/)) && (req.method === 'GET' || req.method === 'HEAD')) return serveMedia(env, req, m[1], 'thumb');
      if (p.startsWith('/push/')) return pushRoutes(env, ctx, req, url);
      if (p === '/dedupe') {
        if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
        return new Response(JSON.stringify(await dedupe(env, url.searchParams.get('apply') === '1'), null, 1), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      if (p === '/' && url.searchParams.get('url')) return serveLegacy(env, req, url);
      if (p === '/' ) return new Response('ok', { headers: CORS });
      return new Response('not found', { status: 404, headers: CORS });
    } catch (e) {
      return new Response('error', { status: 502, headers: CORS });
    }
  },
};