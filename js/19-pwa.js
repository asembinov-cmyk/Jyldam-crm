/* ============================================================
   УСТАНОВКА НА ТЕЛЕФОН (PWA) — 12.10.2026

   Тот же сайт, но с иконкой на экране: без адресной строки, вход не слетает,
   камера и фото работают как раньше. Отдельного приложения не появляется —
   код один, и расходиться ему не с чем.

   Здесь три вещи:
     1. регистрация service worker (сам файл — sw.js в корне);
     2. свой манифест для КАБИНЕТА ПАРТНЁРА — иначе иконка партнёра открывала бы
        вход для сотрудников;
     3. полоса «Установить приложение»: на Android по системному запросу,
        на iPhone — подсказкой, там кнопки установки у браузера нет.
   ============================================================ */
(function(){
  const inApp = () => {
    try{ return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
    catch(e){ return false; }
  };
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent||'');
  // Safari на iPhone — единственный браузер, из которого там можно поставить на «Домой».
  const isIOSSafari = () => isIOS() && !/crios|fxios|edgios|opios|yabrowser/i.test(navigator.userAgent||'');
  const partnerCode = () => { try{ return new URLSearchParams(location.search).get('p')||''; }catch(e){ return ''; } };

  /* 1. SERVICE WORKER. Регистрируем ПОСЛЕ загрузки страницы: иначе он конкурирует за
     сеть с первыми запросами к Supabase, а выигрыш в полсекунды тут никому не нужен. */
  function registerSW(){
    if(!('serviceWorker' in navigator)) return;
    if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    // updateViaCache:'none' — сам sw.js всегда проверяется у сервера. Без этого новая
    // версия воркера могла бы не приехать сутками, и вместе с ней застряли бы правила кеша.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .catch(err => console.warn('service worker не зарегистрировался', err));
  }

  /* 2. МАНИФЕСТ ДЛЯ КАБИНЕТА ПАРТНЁРА. Партнёр заходит по ссылке с QR (?p=КОД), и если
     оставить общий манифест, его иконка вела бы на «/» — то есть на вход для сотрудников,
     куда ему нечего вводить. Поэтому на таких страницах подменяем манифест на лету:
     start_url — ровно этот адрес с кодом. Файлом это не сделать: кодов столько же,
     сколько партнёров. */
  function partnerManifest(){
    const code = partnerCode();
    if(!code) return;
    try{
      const m = {
        name: 'Jyldam · Кабинет партнёра',
        short_name: 'Jyldam партнёр',
        lang: 'ru',
        start_url: location.pathname + location.search,
        scope: './',
        display: 'standalone',
        background_color: '#eef2f9',
        theme_color: '#eef2f9',
        icons: [
          { src: 'assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/manifest+json' }));
      let link = document.querySelector('link[rel="manifest"]');
      if(!link){ link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link); }
      link.href = url;
    }catch(e){ console.warn('манифест партнёра', e); }
  }

  /* 3. ПОЛОСА УСТАНОВКИ — САМА НЕ ПОКАЗЫВАЕТСЯ (с 19.10.2026).
     Просьба владельца: «когда заходишь на сайт, выходит уведомление с кнопкой „Позже" —
     убери это вообще, чтобы не выходило ничего». Полоса предлагала поставить CRM на
     телефон; показывалась после входа и не чаще раза в две недели, но и этого оказалось
     много: люди заходят в CRM работать, а не устанавливать её.

     САМ КОД ОСТАВЛЕН, вызывается только руками — `showInstallBar()` в консоли. Удалять
     его незачем: установка на «Домой» никуда не делась (раздел 11), просто теперь никто
     её не предлагает. Вернуть автоматический показ — это одна строка в конце файла. */
  const HIDE_KEY = 'pwaInstallHidden';
  const HIDE_DAYS = 14;
  let deferred = null;

  const hiddenRecently = () => {
    try{
      const t = +localStorage.getItem(HIDE_KEY) || 0;
      return t && (Date.now() - t) < HIDE_DAYS * 86400000;
    }catch(e){ return false; }
  };
  const remember = () => { try{ localStorage.setItem(HIDE_KEY, String(Date.now())); }catch(e){} };

  function bar(html, onInstall){
    if(document.getElementById('pwaBar')) return;
    const el = document.createElement('div');
    el.id = 'pwaBar'; el.className = 'app-install';
    el.innerHTML = html + '<button type="button" class="btn sm" id="pwaNo">Позже</button>';
    document.body.appendChild(el);
    const no = document.getElementById('pwaNo');
    if(no) no.onclick = () => { remember(); el.remove(); };
    const yes = document.getElementById('pwaYes');
    if(yes && onInstall) yes.onclick = () => onInstall(el);
  }

  // force=true — показать полосу принудительно, чтобы посмотреть, как она выглядит,
  // не дожидаясь системного запроса: `showInstallBar()` в консоли браузера. На Android
  // системный запрос приходит сам, на iPhone его не бывает вовсе, и иначе вид полосы
  // можно проверить только на живом телефоне.
  function showInstall(force){
    if(!force && (inApp() || hiddenRecently())) return;
    if(document.getElementById('pwaBar')) return;
    if(deferred){
      bar('<span>Поставьте CRM на телефон — откроется как приложение, без адресной строки.</span>'
        + '<button type="button" class="btn sm primary" id="pwaYes">Установить</button>',
        async el => {
          el.remove();
          try{ deferred.prompt(); await deferred.userChoice; }catch(e){}
          deferred = null;
        });
      return;
    }
    // iPhone: системного запроса нет вовсе, есть только ручной путь через «Поделиться».
    if(isIOSSafari() || force){
      bar('<span>Добавьте CRM на экран «Домой»: кнопка <b>Поделиться</b> внизу → <b>На экран «Домой»</b>.</span>');
    }
  }
  window.showInstallBar = () => showInstall(true);

  // Системное окно Chrome перехватываем и НЕ показываем: владелец просил, чтобы при
  // заходе не выходило ничего, а это окно рисует уже браузер, не мы. Событие всё равно
  // запоминаем — по нему работает ручной вызов `showInstallBar()`. Установка остаётся
  // доступной обычным путём: меню браузера → «Установить приложение».
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', () => {
    remember();
    const el = document.getElementById('pwaBar');
    if(el) el.remove();
  });

  partnerManifest();
  if(document.readyState === 'complete') registerSW();
  else window.addEventListener('load', registerSW);
  // Автоматического показа полосы НЕТ — см. пункт 3. Чтобы вернуть: whenReady(showInstall).
})();
