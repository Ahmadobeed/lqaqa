/* القعقاع — Service Worker
   • لا يخزّن الصفحة أبداً قبل الشبكة: دائماً آخر نسخة (network-first)، والكاش فقط عند انقطاع الإنترنت
   • يمسح أي كاش قديم تلقائياً ويستلم التحكم فوراً (لا انتظار لإغلاق التبويبات)
   • Push: يظهر الإشعار حتى لو الموقع مسكّر */
const Q = new URL(self.location.href).searchParams;
const WORKER = (Q.get('w') || '').replace(/\/$/, '');
const ICON = Q.get('i') || '';
const KEEP = ['qaqa-offline', 'qaqa-meta'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const ks = await caches.keys();
  await Promise.all(ks.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || r.mode !== 'navigate') return; /* باقي الطلبات تمر مباشرة بدون تدخل */
  e.respondWith((async () => {
    try {
      const res = await fetch(new Request(r.url, { cache: 'no-store', credentials: 'same-origin' }));
      if (res.redirected) return Response.redirect(res.url, 302);
      if (res.ok) { const c = await caches.open('qaqa-offline'); c.put('/__offline', res.clone()).catch(() => {}); }
      return res;
    } catch (err) {
      const c = await caches.open('qaqa-offline');
      return (await c.match('/__offline')) || new Response('لا يوجد اتصال بالإنترنت', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

async function sha32(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function getSince() {
  try { const c = await caches.open('qaqa-meta'); const r = await c.match('/since'); if (r) return Number(await r.text()) || 0; } catch (e) {}
  return Date.now() - 90000; /* أول مرة: لا نعرض أحداث قديمة */
}
async function setSince(v) { try { const c = await caches.open('qaqa-meta'); await c.put('/since', new Response(String(v))); } catch (e) {} }

self.addEventListener('push', (e) => e.waitUntil((async () => {
  let items = [];
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub && WORKER) {
      const since = await getSince();
      const r = await fetch(WORKER + '/push/feed?ep=' + (await sha32(sub.endpoint)) + '&since=' + since, { cache: 'no-store' });
      const j = await r.json();
      items = j.items || [];
      if (items.length) await setSince(Math.max.apply(null, items.map((x) => x.ts || 0)));
    }
  } catch (err) {}
  if (!items.length) items = [{ title: 'القعقاع | Al-Qaqa', body: 'لديك إشعار جديد', tag: 'qaqa-generic', url: '/' }];
  for (const it of items) {
    await self.registration.showNotification(it.title, {
      body: it.body || '', tag: it.tag || undefined, renotify: true, icon: ICON || undefined, badge: ICON || undefined,
      dir: 'rtl', lang: 'ar', vibrate: [200, 100, 200, 100, 300], silent: false, data: { url: it.url || '/' },
    });
  }
  /* لو في نافذة مفتوحة للموقع: شغّل صوت التنبيه داخلها */
  const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  cl.forEach((c) => c.postMessage({ type: 'ding' }));
})()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.registration.scope).href;
  e.waitUntil((async () => {
    const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cl) { if ('focus' in c) { await c.focus(); if ('navigate' in c && url.indexOf('#') > -1) { try { await c.navigate(url); } catch (x) {} } return; } }
    await self.clients.openWindow(url);
  })());
});