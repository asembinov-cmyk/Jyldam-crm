/* ============================================================
   PUSH-УВЕДОМЛЕНИЯ НА ТЕЛЕФОН — сторона CRM (12.10.2026)

   Показывает их service worker (sw.js), отправляет функция `push-send` в Supabase,
   а здесь — подписка, кнопка-колокольчик в шапке и вызовы по событиям.

   ОТКРЫТЫЙ КЛЮЧ VAPID ЛЕЖИТ ПРЯМО ЗДЕСЬ, И ЭТО НОРМАЛЬНО: он публичен по устройству
   протокола, им только проверяют подпись. Закрытый — в секрете `VAPID_PRIVATE_KEY`
   в Supabase, и в репозиторий его писать нельзя (раздел 9a). Пара создаётся
   страницей `tools/push-test.html`.
   ============================================================ */
const PUSH_VAPID_PUBLIC = 'BBX0n9CAvMSLM6sIGojpisoSjGCoHghfCDMYPE6omSHzocueLvjgrobW1vJl_RBC-HqXkgbdKvKqjNXsk-p_myM';

const pushSupported = () => !!(window.isSecureContext && 'serviceWorker' in navigator
  && 'PushManager' in window && 'Notification' in window);
// На iPhone уведомления работают ТОЛЬКО у приложения, добавленного на «Домой»:
// в самом Safari подписаться нельзя, и объяснить это надо прямо, иначе кнопка
// выглядит сломанной.
const pushIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '');
const pushStandalone = () => {
  try{ return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  catch(e){ return false; }
};

function pushKeyBytes(b64){
  const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pushCurrent(){
  try{
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  }catch(e){ return null; }
}
// Запись в базу — по endpoint: браузер время от времени выдаёт новый адрес той же
// подписки, и без onConflict в таблице копились бы мёртвые строки одного человека.
async function pushSaveSub(sub){
  if(!sub || !S.me || !S.me.id) return false;
  const j = sub.toJSON() || {};
  const { error } = await sb.from('push_subscriptions').upsert({
    user_id: S.me.id,
    endpoint: sub.endpoint,
    p256dh: j.keys && j.keys.p256dh,
    auth: j.keys && j.keys.auth,
    user_agent: (navigator.userAgent || '').slice(0, 200),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if(error){ console.warn('подписка не сохранилась', error); return false; }
  return true;
}
async function pushEnable(){
  if(!pushSupported()){ toast('Браузер не умеет уведомления'); return; }
  if(pushIOS() && !pushStandalone()){
    toast('На iPhone уведомления работают только у приложения: добавьте CRM на экран «Домой» и откройте оттуда', 8000);
    return;
  }
  let perm = Notification.permission;
  if(perm === 'default') perm = await Notification.requestPermission();
  if(perm !== 'granted'){
    toast(perm === 'denied'
      ? 'Уведомления запрещены в настройках браузера — включите их для этого сайта'
      : 'Уведомления не включены', 7000);
    pushRenderBtn(); return;
  }
  try{
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub) sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: pushKeyBytes(PUSH_VAPID_PUBLIC) });
    const ok = await pushSaveSub(sub);
    if(!ok){ toast('Подписались, но запись в базу не прошла — скажите администратору', 7000); pushRenderBtn(); return; }
    // Сразу шлём проверочное самому себе. Это единственный способ убедиться, что работает
    // ВСЯ цепочка: подписка, ключи, функция отправки и показ на телефоне. Без него
    // человек узнал бы о поломке только тогда, когда пропустил бы настоящее уведомление.
    const r = await callEdge('push-send', { kind: 'test', title: 'Уведомления включены',
      body: 'Вот так они будут приходить', tag: 'test' });
    if(r && r.error) toast('Включено, но проверочное не ушло: ' + r.error, 9000);
    else if(r && r.sent === 0) toast('Включено, но сервер никому не отправил — подписка не доехала до базы', 9000);
    else toast('Уведомления включены — сейчас придёт проверочное', 6000);
  }catch(e){
    console.error('подписка', e);
    toast('Не получилось подписаться: ' + (e.message || e), 7000);
  }
  pushRenderBtn();
}
async function pushDisable(){
  try{
    const sub = await pushCurrent();
    if(sub){
      await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    toast('Уведомления выключены');
  }catch(e){ console.warn(e); }
  pushRenderBtn();
}
// Кнопка живёт в шапке рядом с именем: уведомления — личная настройка, и искать её
// в разделах неоткуда. Рисуем из кода, чтобы вся эта механика лежала в одном файле.
async function pushRenderBtn(){
  const bar = document.querySelector('.topbar-inner');
  if(!bar || !S.me || !S.me.id) return;
  let btn = document.getElementById('pushBtn');
  if(!btn){
    btn = document.createElement('button');
    btn.id = 'pushBtn'; btn.className = 'push-btn'; btn.type = 'button';
    const ub = bar.querySelector('.user-box');
    if(ub) ub.parentNode.insertBefore(btn, ub); else bar.appendChild(btn);
    btn.onclick = async () => {
      const sub = await pushCurrent();
      if(sub) pushDisable(); else pushEnable();
    };
  }
  if(!pushSupported()){ btn.style.display = 'none'; return; }
  const sub = await pushCurrent();
  const on = !!sub && Notification.permission === 'granted';
  const blocked = Notification.permission === 'denied';
  btn.style.display = '';
  btn.classList.toggle('on', on);
  btn.textContent = on ? '🔔' : '🔕';
  btn.title = on ? 'Уведомления включены — нажмите, чтобы выключить'
    : blocked ? 'Уведомления запрещены в настройках браузера'
    : (pushIOS() && !pushStandalone()) ? 'Добавьте CRM на экран «Домой» — тогда уведомления заработают'
    : 'Включить уведомления на этом устройстве';
}
// Отправка. Кидаем и не ждём: уведомление — дело десятое, и падать из-за него
// сохранение заявки не должно.
function pushSend(payload){
  try{
    if(typeof callEdge !== 'function') return;
    callEdge('push-send', payload).catch(e => console.warn('push-send', e));
  }catch(e){ console.warn('push-send', e); }
}

// Переход по нажатию на уведомление: вкладку переключаем внутри уже открытой CRM,
// а не перезагружаем страницу — перезагрузка стоит нескольких секунд и теряет фильтры.
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', e => {
  const d = e.data || {};
  if(d.type !== 'push-open') return;
  try{
    const u = new URL(d.url || './', location.href);
    const tab = u.searchParams.get('tab');
    if(tab && typeof render === 'function' && typeof S !== 'undefined'){ S.tab = tab; render(); return; }
  }catch(err){}
  if(d.url) location.href = d.url;
});

(function pushBoot(){
  let left = 40;
  const tick = async () => {
    if(typeof S !== 'undefined' && S && S.me && S.me.id){
      pushRenderBtn();
      // Подписка живёт в браузере и может потеряться в базе (сменили телефон,
      // почистили данные, браузер выдал новый адрес) — при каждом входе дописываем.
      if(pushSupported() && Notification.permission === 'granted'){
        const sub = await pushCurrent();
        if(sub) pushSaveSub(sub);
      }
      return;
    }
    if(--left > 0) setTimeout(tick, 3000);
  };
  setTimeout(tick, 2500);
})();

/* ---------- СОБЫТИЯ ----------
   Зовутся из тех мест, где событие реально происходит, а не по таймеру: так
   уведомление приходит сразу и ровно по делу. */

// Курьеру — заявку назначили на него. Шлём только при НАЗНАЧЕНИИ (новая заявка или
// сменили курьера): при любом другом сохранении карточки человек получал бы повтор.
function pushPickupAssigned(p){
  if(!p || !p.courier_id) return;
  const city = (typeof cityName === 'function' && p.city_id) ? cityName(p.city_id) : '';
  const parts = [p.name || 'Партнёр', city, p.orders ? (p.orders + ' заказов') : ''].filter(Boolean);
  pushSend({ kind: 'pickup', courier_id: p.courier_id,
    title: 'Новая заявка на забор', body: parts.join(' · '),
    url: './?tab=pickups', tag: 'pickup-' + p.id, important: true });
}
// Менеджерам — появились заказы с фото, то есть работа в «Заполнении».
// minGapMin держит паузу между такими уведомлениями на стороне сервера: фото грузят
// пачками по двадцать, и без паузы телефон звенел бы без остановки.
function pushFillQueue(n){
  pushSend({ kind: 'fill', minGapMin: 30,
    title: 'Заказы ждут заполнения',
    body: n > 1 ? ('Загрузили ' + n + ' фото — заказы в очереди') : 'Появился заказ с фото',
    url: './?tab=filling', tag: 'fill' });
}
