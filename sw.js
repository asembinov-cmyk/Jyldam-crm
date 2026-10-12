/* ============================================================
   SERVICE WORKER — чтобы CRM ставилась на телефон приложением.

   ГЛАВНОЕ ПРАВИЛО ЭТОГО ФАЙЛА: index.html ВСЕГДА ИЗ СЕТИ.
   У нас уже трижды уходило по полчаса на разбор «правка не применилась», и каждый
   раз виноват был кеш (раздел 4 в CLAUDE.md). Кеш приложения опаснее браузерного:
   он живёт, пока его не удалить руками. Поэтому:

     • переход по адресу (navigate) — сначала сеть, кеш только когда сети нет;
     • js/css/assets с отпечатком ?v=… — из кеша можно смело: отпечаток меняется
       вместе с содержимым, значит старый файл по новому адресу не отдать;
     • всё, у чего отпечатка нет (запросы к Supabase, шрифты, картинки заказов),
       вообще не трогаем — пусть идёт в сеть, как шло.

   Версия в имени кеша — рубильник: поменяли её, и при следующем запуске все старые
   кеши удаляются целиком.
   ============================================================ */
const CACHE = 'jyldam-v1';
const INDEX = './index.html';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  let url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(url.origin !== self.location.origin) return;   // Supabase, шрифты, CDN — мимо нас

  // Страница: сеть вперёд. Без сети — последняя сохранённая копия, а если и её нет,
  // короткая заглушка: белый экран с ошибкой браузера объясняет меньше.
  if(req.mode === 'navigate'){
    e.respondWith((async () => {
      try{
        // cache:'reload' — мимо обычного кеша браузера, прямо к серверу. Без него
        // страница всё равно приезжает старой: GitHub Pages отдаёт index.html с
        // max-age=600, а сервер без заголовков браузер кеширует «на глазок».
        // Проверено на живом примере: правка заголовка не доезжала, пока не добавили.
        const net = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' });
        const c = await caches.open(CACHE);
        c.put(INDEX, net.clone());
        return net;
      }catch(err){
        const hit = await caches.match(INDEX);
        if(hit) return hit;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Нет сети</title>'
          + '<body style="font:16px/1.5 system-ui;padding:40px;color:#16213a">'
          + '<h2>Нет связи</h2><p>CRM откроется, как только появится интернет.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 });
      }
    })());
    return;
  }

  // Файлы с отпечатком — из кеша. Без отпечатка не кешируем вовсе.
  if(!url.searchParams.has('v')) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if(hit) return hit;
    const net = await fetch(req);
    if(net && net.ok){
      c.put(req, net.clone());
      // Прошлые версии того же файла больше не нужны: иначе кеш растёт с каждой выкладкой.
      for(const k of await c.keys()){
        try{
          const u = new URL(k.url);
          if(u.pathname === url.pathname && u.search !== url.search) c.delete(k);
        }catch(err){}
      }
    }
    return net;
  })());
});


/* ============================================================
   PUSH-УВЕДОМЛЕНИЯ

   Приходят, даже когда CRM закрыта: показывает их этот воркер, а не страница.
   Что внутри сообщения, решает функция `push-send` (Supabase), здесь только показ
   и переход по нажатию.
   ============================================================ */
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = { body: (e.data && e.data.text()) || '' }; }
  const title = d.title || 'Jyldam CRM';
  const opts = {
    body: d.body || '',
    icon: 'assets/icon-192.png',
    badge: 'assets/icon-192.png',
    lang: 'ru',
    // tag — чтобы однотипные уведомления заменяли друг друга, а не копились стопкой:
    // курьеру с утра может прилететь пять заявок, и пять одинаковых строк в шторке
    // он просто смахнёт не читая.
    tag: d.tag || 'jyldam',
    renotify: !!d.tag,
    requireInteraction: !!d.important,
    data: { url: d.url || './', kind: d.kind || '' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Нажали на уведомление: если CRM уже открыта — показываем ту вкладку и уводим её
// на нужный раздел, а не плодим вторую копию приложения.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of all){
      if(c.url.indexOf(self.location.origin) === 0){
        await c.focus();
        try{ c.postMessage({ type: 'push-open', url: target }); }catch(err){}
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
