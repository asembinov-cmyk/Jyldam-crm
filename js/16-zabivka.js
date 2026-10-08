/* ============================================================
   ЗАБИВКА ЗАКАЗОВ — распределение работы между менеджерами.

   Задача: четверо менеджеров вносят данные с фото бланков. Раньше они брали
   заказы как придётся — двое могли сесть за один и тот же, а нагрузка ложилась
   неровно. Здесь заказы выдаются по одному: нажал «Взять следующий» — получил
   заказ и он закреплён за тобой.

   ПОЧЕМУ ВЫДАЁМ ПО ОДНОМУ, А НЕ ДЕЛИМ ПАЧКИ ЗАРАНЕЕ. Раздача, ровная утром,
   к обеду перестаёт быть ровной: скорость у людей разная. А если менеджер
   заболел, его пачка просто стоит, и остальные не могут её взять. Выдача по
   одному выравнивает нагрузку сама.

   ЗАХВАТ НЕ ВЕЧНЫЙ. Взял и ушёл — через FILL_CLAIM_MIN минут заказ возвращается
   в общую очередь. Иначе один человек за день «заморозит» десяток заказов.

   ГОНКА ИСКЛЮЧЕНА НА УРОВНЕ БАЗЫ. Захват — условное обновление «займи, только
   если ещё свободно» (тот же приём, что в очереди печати бланков в «Сортировке»).
   Два одновременных нажатия физически не могут получить один заказ: второе
   обновление вернёт ноль строк.
   ============================================================ */

const FILL_CLAIM_MIN = 30;   // сколько минут заказ держится за менеджером
// Предел для ИЗМЕРЕНИЯ времени оставлен прежним, 10 минут, и это не описка. Раньше он был
// одним числом с захватом, и подъём захвата до 30 минут молча испортил бы «среднее время»:
// заказ, который человек делал 25 минут (отошёл, звонил партнёру), попал бы в среднее и
// утянул бы его в разы — при норме 60 секунд. Дольше десяти минут — это не работа, а пауза.
const FILL_MEASURE_MAX_MIN = 10;
const FILL_NORM_SEC  = 60;   // норма времени на один заказ
let fillFrom = '', fillTo = '';  // период статистики, пусто = сегодня
// ГОРОД ЗАБОРА — фильтр ОЧЕРЕДИ (просьба владельца 08.10.2026): выбрал город — заказы
// падают только этого города. Не вид списка, а именно выдача: «Взять следующий» и пробел
// берут из того же отфильтрованного набора.
//
// Хранится в localStorage, а не в памяти вкладки: по городу работают всю смену, и
// выставлять его заново после каждой перезагрузки человек просто забудет. Это СВОЙ выбор
// каждого устройства — у двух менеджеров на одном складе он разный.
// '' — все города, '-' — заказы, у которых город не определён вовсе.
let fillCity = (() => { try{ return localStorage.getItem('fillCity') || ''; }catch(e){ return ''; } })();
let fillBusy = false;            // защита от двойного нажатия «Взять следующий»

// Колонки могли ещё не появиться в базе (SQL из db/11 не выполнен). Понять это можно
// бесплатно: заказы грузятся через select('*'), и если колонка есть, она есть и в строке.
const fillReady = () => !!(S.orders && S.orders.length && ('filled_at' in S.orders[0]));
// ...но пока заказы ещё грузятся, строк нет ВООБЩЕ, и отличить «колонок нет» от «данные
// не приехали» по ним нельзя. Раньше в эти первые секунды раздел пугал надписью «Раздел
// ещё не включён» с требованием выполнить SQL — при том что всё давно включено.
// После входа сначала приходит быстрый запрос за сегодня, следом вся история
// (S._heavyLoaded, js/02-ket.js); до этого честно говорим «загружаем».
const fillLoading = () => !(S.orders && S.orders.length) && !S._heavyLoaded;

// Местная дата отметки времени. Брать slice(0,10) от ISO нельзя: там UTC, и заказ,
// заполненный в половине первого ночи, попадал бы во вчерашний день (Астана +5).
const localDateOf = ts => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fillMeName = () => (S.me && (S.me.full_name || S.me.email)) || '';
// ЧАСЫ БЕРЁМ СЕРВЕРНЫЕ (nowMs), а не ноутбука. Иначе всё разъезжается: менеджер с часами,
// убежавшими вперёд, считает ЧУЖИЕ свежие захваты просроченными и отбирает заказы, над
// которыми уже работают, — ровно то, на что жаловались 27.09 («падают одни и те же»).
// А его собственный claimed_at, записанный вперёд, для остальных не истекает никогда.
const fillCutoff = () => new Date(nowMs() - FILL_CLAIM_MIN * 60000).toISOString();

// Заказ ждёт заполнения: фото бланка есть, данных клиента нет.
//
// Проверяем именно ПУСТОЕ ФИО, а не orderIsProcessed() из «Сортировки». То правило
// требует ещё и типа доставки, и под него попадал заказ с заполненным ФИО, но без
// типа: системе он «не обработан», а менеджеру выдавался уже забитым. Таких много
// среди старых заказов.
function fillNeedsWork(o){
  // Барахолка в очередь не попадает и не должна: заказы приходят готовым реестром, ФИО
  // и адрес в них уже есть. Проверка явная, хотя импорт и так ставит filled_at: от этого
  // условия зависит чужая ветка бизнеса, и держаться на побочном эффекте ей нельзя.
  if(isBaraholkaOrder(o)) return false;
  if(o.filled_at) return false;
  if(String(o.client || '').trim()) return false;
  const photos = o.photos;
  return Array.isArray(photos) ? photos.length > 0 : !!photos;
}
// Дата заказа: по забору, а если её нет — по созданию.
const fillOrderDate = o => o.pickup_date ? String(o.pickup_date).slice(0, 10)
  : (o.created_at ? localDateOf(o.created_at) : '');
// С КАКОГО ДНЯ ВЫДАЁМ ЗАКАЗЫ.
//
// Раньше выдавались строго сегодняшние, и в полночь незаполненные заказы вчерашнего дня
// молча уходили из очереди: «Взять следующий» отвечал «свободных заказов нет», хотя работа
// осталась. Фильтр периода на очередь не влиял вовсе — по нему считалась только статистика,
// поэтому нажатие «Вчера» выглядело как «ничего не происходит».
//
// Теперь период задаёт и очередь: «Вчера» — это вчера И сегодня. Верхняя граница всегда
// сегодняшний день, даже когда в фильтре стоит «по вчера»: иначе выбранный вечером «Вчера»
// прятал бы новые заказы, и человек весь день не видел бы свежей работы.
function fillQueueFrom(){
  const f = fillPeriod().from, t = localToday();
  return (f && f < t) ? f : t;
}
function fillInQueue(o){
  const d = fillOrderDate(o);
  return !!d && d >= fillQueueFrom() && d <= localToday();
}
const fillPrevDay = d => new Date(new Date(d).getTime() - 86400000).toISOString().slice(0, 10);
// Город заказа — ОДНОЙ функцией с Калькуляцией (orderCalcCity, js/07): своё поле
// `pickup_city_id`, а если пусто — город партнёра. Вторую такую писать нельзя: правило
// «из какого города заказ» в системе должно быть одно, иначе фильтр и деньги разойдутся.
const fillCityOf = o => orderCalcCity(o) || '';
function fillInCity(o){
  if(!fillCity) return true;
  const c = fillCityOf(o);
  return fillCity === '-' ? !c : c === fillCity;
}
const fillCityLabel = () => !fillCity ? '' : (fillCity === '-' ? 'без города' : (cityName(fillCity) || '—'));
// Варианты собираем ИЗ САМОЙ ОЧЕРЕДИ, а не из справочника городов: в заборах участвует
// десяток городов из сорока, и выбирать нужный среди пустых — значит искать его глазами.
// В скобках — сколько там СВОБОДНЫХ заказов прямо сейчас: цифра отвечает на вопрос
// «есть ли там для меня работа», а не «сколько всего».
//
// Выбранный город остаётся в списке даже с нулём: пропади он — select показал бы чужое
// значение, и человек решил бы, что фильтр снят, хотя заказы ему не падают.
function fillCityOptions(){
  const base = fillQueueAll().filter(o => !fillClaimAlive(o));
  const by = {};
  base.forEach(o => { const c = fillCityOf(o) || '-'; by[c] = (by[c] || 0) + 1; });
  if(fillCity && by[fillCity] == null) by[fillCity] = 0;
  const named = Object.keys(by).filter(k => k !== '-')
    .map(id => ({ id, name: cityName(id) || '—', n: by[id] }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  return { named, none: by['-'] || 0, total: base.length };
}
// Свободные заказы В ДРУГИХ городах — чтобы не сидеть без работы при полном складе:
// менеджер выбрал Алматы, алматинские кончились, а в Астане висит сорок штук.
function fillFreeElsewhere(){
  if(!fillCity) return 0;
  return fillQueueAll().filter(o => !fillClaimAlive(o) && !fillInCity(o)).length;
}
// ПОЧЕМУ БРАТЬ НЕЧЕГО. «Взять следующий» неактивен по пяти разным причинам, и со стороны
// они выглядят одинаково — «кнопка не работает». Причин, по сути, две группы: заказы есть,
// но заняты (вами же, отложены, у коллег), или их правда нет за выбранные дни.
function fillWhyEmpty(queue, free, mine, held){
  if(free.length) return '';
  // ГОРОД ВЫБРАН, а свободных в нём нет — эту причину со стороны не видно вовсе: очередь
  // выглядит пустой, хотя на складе работы полно. Поэтому называем её ПЕРВОЙ и сразу
  // говорим, сколько свободно в других городах — иначе человек сидит и ждёт заказов,
  // которых ему и не дадут.
  if(fillCity){
    const others = queue.filter(o => fillClaimAlive(o) && !fillIsMine(o)).length;
    const other = fillFreeElsewhere();
    return `по городу «${fillCityLabel()}» свободных нет`
      + (others ? ` · ${others} сейчас у коллег` : '')
      + (other ? ` · в других городах свободно ${other}, снимите фильтр города` : '')
      + (mine.length ? ` · у вас в работе ${mine.length}` : '')
      + (held.length ? ` · отложено ${held.length}` : '');
  }
  if(mine.length) return 'заказ уже у вас в работе';
  const others = queue.filter(o => fillClaimAlive(o) && !fillIsMine(o)).length;
  if(held.length && !others) return `у вас отложено ${held.length}, верните в работу выше`;
  if(others) return `все ${others} сейчас у коллег`;
  const from = fillQueueFrom();
  return from < localToday()
    ? `с ${fmtDate(from)} заказов с фото, ждущих заполнения, нет`
    : 'за сегодня заказов с фото, ждущих заполнения, пока нет';
}
// Сколько незаполненного осталось за день ПЕРЕД окном очереди — тот самый «хвост»,
// ради которого и приходится двигать фильтр. Считаем один день, а не всё прошлое:
// «добрать 400 заказов за месяц» — это не про работу, а про старые брошенные болванки.
function fillTailCount(){
  const d = fillPrevDay(fillQueueFrom());
  // Фильтр города учитываем и здесь: кнопка обещает N заказов, и обещать она должна то,
  // что человеку реально упадёт, а не вместе с чужими городами.
  return (S.orders || []).filter(o => fillNeedsWork(o) && fillOrderDate(o) === d && fillInCity(o)).length;
}
// Захват живой? Отложенный заказ не протухает: менеджер ждёт данных от партнёра,
// и отдавать заказ соседу через десять минут — значит потерять то, чего он ждал.
const fillHoldReady = () => !!(S.orders && S.orders.length && ('claim_hold' in S.orders[0]));
function fillIsHeld(o){ return !!o.claim_hold; }
function fillClaimAlive(o){ return fillIsHeld(o) || !!(o.claimed_at && o.claimed_at > fillCutoff()); }
function fillIsMine(o){ return fillClaimAlive(o) && o.claimed_by === (S.me && S.me.id); }

// Очередь по датам, БЕЗ фильтра города: на ней считаются варианты фильтра и чужие
// захваты в таблице «Менеджеры заказов» — кто у кого в работе, от МОЕГО выбора города
// зависеть не должно.
function fillQueueAll(){ return (S.orders || []).filter(o => fillNeedsWork(o) && fillInQueue(o)); }
function fillQueue(){ return fillQueueAll().filter(fillInCity); }
function fillFree(){ return fillQueue().filter(o => !fillClaimAlive(o)); }
// А ВОТ СВОИ взятые и отложенные заказы фильтр города НЕ прячет. Человек их уже держит;
// исчезни они с экрана при смене города — он бы о них забыл, захват висел бы до конца
// срока, а заказ стоял. Поэтому здесь fillQueueAll, а не fillQueue.
function fillMine(){ return fillQueueAll().filter(o => fillIsMine(o) && !fillIsHeld(o)); }
function fillHeld(){ return fillQueueAll().filter(o => fillIsMine(o) && fillIsHeld(o)); }

/* ---------- выдача следующего заказа ---------- */
// Попытка захватить один из переданных заказов. Возвращает захваченный или null.
// Условия стоят В САМОМ ЗАПРОСЕ, и это главное: два менеджера жмут кнопку одновременно,
// и решает база, а не наши списки. Отложенный заказ не отбираем и на стороне базы —
// локальный список его и так не предлагает, но он мог устареть.
async function fillTryClaim(list){
  const now = new Date(nowMs()).toISOString();
  for(const o of list){
    let q = sb.from('orders')
      .update({ claimed_by: (S.me && S.me.id) || null, claimed_by_name: fillMeName(), claimed_at: now })
      .eq('id', o.id)
      .is('filled_at', null)
      .or(`claimed_at.is.null,claimed_at.lt.${fillCutoff()}`);
    if(fillHoldReady()) q = q.not('claim_hold', 'is', true);
    const { data, error } = await q.select();
    if(error){ console.error('fill claim', error); toast('Ошибка: ' + error.message); return null; }
    if(data && data.length){
      const row = data[0];
      const mine = (S.orders || []).find(x => x.id === row.id);
      if(mine) Object.assign(mine, row); else S.orders.unshift(row);
      return mine || row;
    }
  }
  return null;
}
// СВЕЖИЕ КАНДИДАТЫ ИЗ БАЗЫ, а не из памяти вкладки.
//
// Память устаревает: заказы разбирают и заполняют пятеро одновременно, а Realtime может
// не донести часть изменений (вкладка в фоне, сеть мигнула). Тогда в списке висят заказы,
// давно заполненные или взятые, все попытки захвата возвращают ноль строк — и человек
// видел «свободных заказов: 97» и тост «разобрали». Именно на это жаловались 28.09.
//
// Условия здесь ТЕ ЖЕ, что в очереди, только выраженные запросом: не заполнен, без ФИО,
// в окне дат. «Есть фото» запросом не выразить (поле — массив), поэтому досеиваем
// на месте через fillNeedsWork.
async function fillFreshCandidates(){
  let q = sb.from('orders')
    .select('*')
    .is('filled_at', null)
    .gte('pickup_date', fillQueueFrom())
    .lte('pickup_date', localToday())
    .or(`claimed_at.is.null,claimed_at.lt.${fillCutoff()}`);
  // Город — сразу в запрос: двести свежайших строк могут оказаться все чужого города,
  // и выборка вернулась бы пустой при полном складе. Условие тут СТРОГОЕ, по полю заказа:
  // заказ с пустым городом, но партнёром из этого города, сюда не попадёт — он и так
  // лежит в памяти вкладки, то есть достаётся первой попыткой в fillTakeNext.
  if(fillCity === '-') q = q.is('pickup_city_id', null);
  else if(fillCity) q = q.eq('pickup_city_id', fillCity);
  const { data, error } = await q.order('created_at', { ascending: true }).limit(200);
  if(error){ console.error('fill fresh', error); return []; }
  const rows = (data || []).filter(o => fillNeedsWork(o) && !fillIsHeld(o) && fillInCity(o));
  // Заодно освежаем память вкладки: счётчики на экране перестанут врать.
  const byId = {}; (S.orders || []).forEach((o, i) => { byId[o.id] = i; });
  (data || []).forEach(row => {
    if(byId[row.id] != null) Object.assign(S.orders[byId[row.id]], row);
    else S.orders.push(row);
  });
  return rows;
}
// Порядок кандидатов: самые старые вперёд — заказ, пролежавший дольше, и уйти должен
// раньше. Но брать строго первый нельзя: все менеджеры жмут кнопку и дерутся за ОДИН И
// ТОТ ЖЕ заказ, а остальные девяносто ждут. Поэтому перемешиваем внутри старейших сорока:
// очередь соблюдается, а лобовых столкновений почти нет.
function fillCandidateOrder(list){
  const sorted = [...list].sort((a,b) => String(a.created_at||'').localeCompare(String(b.created_at||'')));
  const head = sorted.slice(0, 40);
  for(let i = head.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [head[i], head[j]] = [head[j], head[i]];
  }
  return head.concat(sorted.slice(40));
}
async function fillTakeNext(){
  if(fillBusy) return;
  fillBusy = true;
  const btn = $('fillNextBottom');
  const label = btn ? btn.textContent : '';
  try{
    // Сначала то, что уже в памяти — это без лишнего запроса и срабатывает почти всегда.
    let got = await fillTryClaim(fillCandidateOrder(fillFree()).slice(0, 20));
    if(!got){
      // Не вышло — значит память вкладки устарела. Спрашиваем базу заново, а не отправляем
      // человека «попробовать ещё раз»: пробовать должна система, у неё это быстрее.
      if(btn){ btn.disabled = true; btn.textContent = 'Ищем свободный…'; }
      const fresh = await fillFreshCandidates();
      got = await fillTryClaim(fillCandidateOrder(fresh).slice(0, 20));
      if(!got){
        renderFilling();
        toast(fresh.length
          ? 'Свободные заказы разобрали прямо сейчас — нажмите ещё раз'
          : 'Свободных заказов нет — всё заполнено или взято коллегами', 6000);
        return;
      }
    }
    renderFilling();
    orderModal(got.id);
  } finally {
    fillBusy = false;
    const b = $('fillNextBottom');
    if(b){ b.disabled = false; if(label) b.textContent = label; }
  }
}

// ПРОДЛЕНИЕ ЗАХВАТА, ПОКА ЧЕЛОВЕК РАБОТАЕТ.
//
// Захват живёт FILL_CLAIM_MIN минут от момента «Взять следующий» и раньше никак не
// обновлялся. Норма — минута, но на деле заказ занимает больше: разобрать почерк на фото,
// уточнить адрес, позвонить партнёру. Через десять минут заказ тихо возвращался в общую
// очередь, и тот же самый доставался соседу — ровно на это и жаловались заполняльщики.
//
// Теперь любое изменение в карточке продлевает захват, но не чаще раза в FILL_TOUCH_MIN
// минут: лишние запросы на каждую букву не нужны. Ушёл и не трогает — захват истекает
// как раньше, и заказ честно возвращается в очередь.
const FILL_TOUCH_MIN = 3;
const _fillTouched = {};   // id заказа → когда в последний раз продлевали
async function fillTouchClaim(id){
  const o = (S.orders || []).find(x => x.id === id);
  if(!o || o.filled_at) return;
  if(o.claimed_by !== (S.me && S.me.id)) return;      // не мой — продлевать нечего
  const last = _fillTouched[id] || 0;
  if(nowMs() - last < FILL_TOUCH_MIN * 60000) return;
  _fillTouched[id] = nowMs();
  const now = new Date(nowMs()).toISOString();
  try{
    // Без dbUpdate: это служебная отметка, и в журнале изменений ей делать нечего —
    // иначе история заказа утонет в записях «продлили захват».
    const { error } = await sb.from('orders').update({ claimed_at: now })
      .eq('id', id).eq('claimed_by', (S.me && S.me.id) || null).is('filled_at', null);
    if(!error) o.claimed_at = now;
  }catch(e){ console.warn('fillTouchClaim', e); }
}

// Отложить за собой: заказ не уходит в общую очередь и ждёт своего часа.
async function fillHold(id, on){
  const o = (S.orders || []).find(x => x.id === id);
  if(!o) return;
  const row = { claim_hold: !!on };
  // Возвращаем в работу — заново отсчитываем десять минут, иначе заказ,
  // пролежавший до вечера, тут же считался бы брошенным.
  if(!on) row.claimed_at = new Date().toISOString();
  const u = await dbUpdate('orders', id, row);
  if(u){ Object.assign(o, u); toast(on ? 'Отложен — останется за вами' : 'Вернули в работу'); renderFilling(); }
}

// вернуть заказ в общую очередь, не заполняя
async function fillRelease(id){
  const o = (S.orders || []).find(x => x.id === id);
  if(!o) return;
  const u = await dbUpdate('orders', id, { claimed_by: null, claimed_by_name: null, claimed_at: null,
    ...(fillHoldReady() ? { claim_hold: false } : {}) });
  if(u){ Object.assign(o, u); toast('Заказ возвращён в очередь'); renderFilling(); }
}

/* ---------- статистика ---------- */
// Период считаем по дате ЗАПОЛНЕНИЯ: вопрос «сколько сделал сегодня» — про работу
// сегодня, а не про то, когда заказ создали.
const fillPeriod = () => {
  const from = fillFrom || localToday();
  return { from, to: fillTo || from };
};
// Сколько заказ реально делали. null — измерить нельзя.
function fillOrderSecs(o){
  // Время засчитываем, только если заказ заполнил тот же, кто его брал: админ,
  // правящий чужой заказ из общего списка, иначе получил бы чужое время.
  if(!o.filled_at || !o.claimed_at || !o.claimed_by || o.claimed_by !== o.filled_by) return null;
  const sec = (new Date(o.filled_at) - new Date(o.claimed_at)) / 1000;
  // Дольше окна захвата — человек отошёл, а не работал. Такое не берём ни в
  // среднее, ни в общее время за день: один обед превратил бы цифры в бессмыслицу.
  return (sec >= 0 && sec <= FILL_MEASURE_MAX_MIN * 60) ? sec : null;
}
function fillDoneIn(from, to){
  return (S.orders || []).filter(o => {
    if(!o.filled_at) return false;
    const d = localDateOf(o.filled_at);
    return d >= from && d <= to;
  });
}
function fillStatsRows(){
  const { from, to } = fillPeriod();
  const by = {};
  // id нужен, чтобы понять, в системе ли человек сейчас (см. presence в js/02-ket.js).
  const add = (nm, id) => {
    const r = by[nm] = by[nm] || { name: nm, id: null, count: 0, secs: [], totalSec: 0, inNorm: 0, last: null };
    if(!r.id && id) r.id = id;
    return r;
  };
  fillDoneIn(from, to).forEach(o => {
    const r = add(o.filled_by_name || '— без имени —', o.filled_by);
    r.count++;
    if(!r.last || o.filled_at > r.last) r.last = o.filled_at;
    const sec = fillOrderSecs(o);
    if(sec != null){
      r.secs.push(sec);
      r.totalSec += sec;
      if(sec <= FILL_NORM_SEC) r.inNorm++;
    }
  });
  const inWork = {}, onHold = {}, holdSince = {};
  fillQueueAll().filter(fillClaimAlive).forEach(o => {
    const nm = o.claimed_by_name || '—';
    const box = fillIsHeld(o) ? onHold : inWork;
    box[nm] = (box[nm] || 0) + 1;
    // Самый давний отложенный заказ человека. Отложенный не протухает — в этом и смысл,
    // менеджер ждёт данных от партнёра. Но ждать он может и третьи сутки, а со стороны это
    // выглядит как «у сотрудника ноль заказов», и никто не понимает почему.
    if(fillIsHeld(o) && o.claimed_at && (!holdSince[nm] || o.claimed_at < holdSince[nm])){
      holdSince[nm] = o.claimed_at;
    }
    add(nm, o.claimed_by);
  });
  return Object.values(by).map(r => ({
    ...r,
    avg: r.secs.length ? r.secs.reduce((s,x) => s+x, 0) / r.secs.length : null,
    normPct: r.secs.length ? Math.round(r.inNorm / r.secs.length * 100) : null,
    inWork: inWork[r.name] || 0,
    onHold: onHold[r.name] || 0,
    holdSince: holdSince[r.name] || null,
  })).sort((a,b) => b.count - a.count);
}
// Отложен слишком давно? Полсуток — уже не «жду ответа партнёра», а «забыли».
const FILL_HOLD_STALE_H = 12;
const fillHoldStale = iso => !!iso && (Date.now() - new Date(iso)) > FILL_HOLD_STALE_H * 3600000;
// Тот же период, сдвинутый назад на свою длину, — для «▲ 12% к прошлому периоду».
function fillPrevCount(byId){
  const { from, to } = fillPeriod();
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const shift = d => new Date(new Date(d).getTime() - days * 86400000).toISOString().slice(0, 10);
  const rows = fillDoneIn(shift(from), shift(to));
  return byId ? rows.filter(o => o.filled_by === byId).length : rows.length;
}
const fillFmtSec = s => {
  if(s == null) return '—';
  const m = Math.floor(s / 60), ss = Math.round(s % 60);
  return m ? `${m}:${String(ss).padStart(2,'0')}` : `${ss} сек`;
};
// Общее время за период — часы и минуты, секунды тут не нужны.
const fillFmtDur = s => {
  if(!s) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if(h) return `${h} ч ${String(m).padStart(2,'0')} мин`;
  return m ? `${m} мин` : `${Math.round(s)} сек`;
};
const fillAgo = iso => {
  if(!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if(m < 1) return 'только что';
  if(m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} ч назад` : `${Math.floor(h / 24)} дн назад`;
};
// Инициалы для кружка с именем: «Шамшиев Мирас» → «ШМ».
const fillInitials = nm => nm.trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
// Цвет кружка — по имени, чтобы у человека он не менялся от раза к разу.
const FILL_AVA = ['#2546c9', '#5b57c9', '#2f7d54', '#b06a28', '#4a5d3a', '#7a4a86'];
const fillAvaColor = nm => FILL_AVA[[...nm].reduce((a,c) => a + c.charCodeAt(0), 0) % FILL_AVA.length];

/* ---------- обновление данных ---------- */
// Realtime приносит чужие правки сам, но фото к заказу могли приложить прямо сейчас,
// а вкладка висит открытой с утра. Тянем только то, что относится к сегодняшнему дню:
// вся таблица заказов — это десятки тысяч строк, ради очереди их качать незачем.
async function fillRefresh(){
  const btns = [...document.querySelectorAll('.fill-reload')];
  btns.forEach(b => { b.disabled = true; b.textContent = 'Обновляем…'; });
  try{
    const from = fillQueueFrom();
    // Страницами: Supabase отдаёт максимум 1000 строк за запрос. За один день столько не
    // набирается, а вот за месяц — запросто, и список оборвался бы молча, без ошибки.
    const PAGE = 1000;
    let off = 0, data = [];
    for(;;){
      const r = await sb.from('orders').select('*')
        .or(`pickup_date.gte.${from},created_at.gte.${from}T00:00:00`)
        .order('created_at', { ascending: false }).range(off, off + PAGE - 1);
      if(r.error) throw r.error;
      data = data.concat(r.data || []);
      if(!r.data || r.data.length < PAGE) break;
      off += PAGE;
    }
    fillLoadedFrom = from;
    const byId = {}; (S.orders || []).forEach((o, i) => { byId[o.id] = i; });
    (data || []).forEach(row => {
      if(byId[row.id] != null) Object.assign(S.orders[byId[row.id]], row);
      else S.orders.unshift(row);
    });
  }catch(e){ console.error('fillRefresh', e); toast('Не удалось обновить'); }
  renderFilling();
}

// Заказы за прошлые дни могут ещё не лежать в памяти: сразу после входа там только
// сегодняшние, вся история подъезжает следом (S._heavyLoading в js/02-ket.js). Поэтому
// при расширении окна очереди дотягиваем недостающее — иначе человек сдвинул фильтр,
// а очередь осталась пустой и снова «ничего не происходит».
let fillLoadedFrom = '';
function fillEnsureLoaded(){
  const from = fillQueueFrom();
  if(from >= localToday()) return false;                 // сегодняшние есть всегда
  if(S._heavyLoaded) return false;                       // вся история уже в памяти
  if(fillLoadedFrom && fillLoadedFrom <= from) return false;
  fillRefresh();                                         // она сама перерисует экран
  return true;
}

/* ---------- экран ---------- */
// Быстрые периоды. Диапазон дат рядом остаётся — им задают любой отрезок.
const FILL_TABS=[['today','Сегодня'],['yest','Вчера'],['week','Неделя'],['month','Месяц']];
// Подпись карточки под выбранный период: «Заполнено мной сегодня» при выборе «Вчера»
// было бы прямым враньём — цифра-то уже за вчера.
const FILL_PERIOD_WORD={today:'сегодня',yest:'вчера',week:'за неделю',month:'за месяц'};
const fillPeriodWord=tab=>FILL_PERIOD_WORD[tab]||'за период';
function fillSetTab(k){
  const d=n=>new Date(new Date(localToday()).getTime()-n*86400000).toISOString().slice(0,10);
  if(k==='today'){fillFrom='';fillTo='';}
  else if(k==='yest'){fillFrom=d(1);fillTo=d(1);}
  else if(k==='week'){fillFrom=d(6);fillTo=localToday();}
  else if(k==='month'){fillFrom=localToday().slice(0,8)+'01';fillTo=localToday();}
  renderFilling();fillEnsureLoaded();
}
// Выбор города: запоминаем на устройстве и перерисовываем экран. Данные дотягивать не
// нужно — город есть у всех заказов, которые уже в памяти, в отличие от смены периода.
function fillSetCity(v){
  fillCity=v||'';
  try{localStorage.setItem('fillCity',fillCity);}catch(e){}
  renderFilling();
}
// Полоса выбора города. Рисуется и администратору: заказы он тоже берёт, а на складе
// с двумя городами это тот же вопрос.
//
// Пока очередь пуста и город не выбран, полосы нет вовсе: выбирать не из чего, а пустой
// список выглядел бы поломкой. Но ЕСЛИ город выбран, полоса остаётся всегда — иначе
// фильтр стало бы невозможно снять, и человек сидел бы без заказов, не понимая почему.
function fillCityBarHtml(){
  const {named,none,total}=fillCityOptions();
  if(!named.length&&!none&&!fillCity)return '';
  const opt=(v,label,n,sel)=>`<option value="${esc(v)}" ${sel?'selected':''}>${esc(label)}${n==null?'':` (${n})`}</option>`;
  return `<div class="fill-city">
    <span class="fc-l">Город забора</span>
    <select id="fillCitySel" title="Заказы будут падать только из выбранного города">
      ${opt('','Все города',total,!fillCity)}
      ${named.map(c=>opt(c.id,c.name,c.n,fillCity===c.id)).join('')}
      ${(none||fillCity==='-')?opt('-','Город не указан',none,fillCity==='-'):''}
    </select>
    ${fillCity
      ? `<span class="fc-on">падают только заказы «${esc(fillCityLabel())}»</span>
         <button class="btn sm ghost" id="fillCityAll">Все города</button>`
      : '<span class="fc-note">В скобках — сколько там свободных заказов прямо сейчас</span>'}
  </div>`;
}
// «Добрать вчерашние»: сдвигает окно очереди на день назад. Ставим и «по», чтобы кнопка
// «Вчера» подсветилась — человек нажал именно её смысл, пусть видит это в фильтре.
function fillExtendQueue(){
  fillFrom = fillTo = fillPrevDay(fillQueueFrom());
  renderFilling();fillEnsureLoaded();
}
function fillActiveTab(){
  const {from,to}=fillPeriod(), t=localToday();
  const d=n=>new Date(new Date(t).getTime()-n*86400000).toISOString().slice(0,10);
  if(from===t&&to===t)return 'today';
  if(from===d(1)&&to===d(1))return 'yest';
  if(from===d(6)&&to===t)return 'week';
  if(from===t.slice(0,8)+'01'&&to===t)return 'month';
  return '';
}
// Кольцо «в норме»: обычный круг с обводкой, нарисованной по длине дуги.
function fillRing(pct){
  const r=22, c=2*Math.PI*r, on=c*(pct||0)/100;
  return `<svg class="fk-ring" viewBox="0 0 56 56" width="56" height="56">
    <circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
    <circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--moss)" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${on} ${c}" transform="rotate(-90 28 28)"/></svg>`;
}

function renderFilling(){
  if(!canMod('filling')){ $('main').innerHTML = '<div class="empty"><div class="big">Нет доступа</div></div>'; return; }
  if(!fillReady()){
    $('main').innerHTML = `
      <div class="page-head"><div><h1>Заполнение</h1></div></div>
      ${fillLoading()
        ? `<div class="empty"><div class="big">Загружаем заказы…</div>
           <p>Секунду — список появится сам, обновлять страницу не нужно.</p></div>`
        : `<div class="empty"><div class="big">Раздел ещё не включён</div>
           <p>В таблице заказов нет полей для учёта. Выполните <b>db/11-ЗАБИВКА-распределение-заказов.sql</b> и обновите страницу.</p></div>`}`;
    return;
  }
  const queue=fillQueue(), free=fillFree(), mine=fillMine(), held=fillHeld();
  // Окно очереди и «хвост» предыдущего дня — чтобы было видно, за какие дни выдаются
  // заказы и сколько осталось за день до этого.
  const qFrom=fillQueueFrom(), qWide=qFrom<localToday();
  const tail=fillTailCount(), tailDay=fillPrevDay(qFrom);
  const canHold=fillHoldReady();
  const admin=isAdmin();
  // Статистику считаем всегда: администратору — по всем, менеджеру — только его строку.
  // Сравнивать себя с коллегами по ходу смены незачем, а свой темп видеть полезно.
  const rows=fillStatsRows();
  const me=(S.me&&S.me.id)||null;
  const mine0={count:0,totalSec:0,secs:[],inNorm:0,avg:null,normPct:null};
  const my=admin?null:(rows.find(r=>r.id===me)||mine0);
  const team=rows.reduce((a,r)=>({
    count:a.count+r.count, secs:a.secs+r.totalSec, inNorm:a.inNorm+r.inNorm,
    measured:a.measured+r.secs.length, inWork:a.inWork+r.inWork, hold:a.hold+r.onHold,
  }),{count:0,secs:0,inNorm:0,measured:0,inWork:0,hold:0});
  const teamAvg=team.measured?team.secs/team.measured:null;
  const teamNorm=team.measured?Math.round(team.inNorm/team.measured*100):null;
  const prev=fillPrevCount(admin?null:me);
  const cur=admin?team.count:my.count;
  const delta=prev?Math.round((cur-prev)/prev*100):null;
  const maxCount=rows.reduce((m,r)=>Math.max(m,r.count),0)||1;
  const {from,to}=fillPeriod();
  const tab=fillActiveTab();
  // Кнопка «Обновить» у менеджера рисуется ДВАЖДЫ — в строке периода и рядом со «Взять
  // следующий». С одним id браузер отдаёт только первую, и вторая была мёртвой: менеджеры
  // так и говорили — «обновить не работает». У админа она одна, поэтому у него работало.
  // Поэтому ищем по КЛАССУ и вешаем обработчик на все.
  const reload='<button class="btn sm ghost fill-reload" title="Подтянуть свежие заказы — фото могли приложить только что">🔄 Обновить</button>';

  $('main').innerHTML=`
    <div class="fill-head">
      <div><h1>Заполнение</h1><p>Заказы выдаются по одному — двое не сядут за один и тот же</p></div>
      <div class="fill-head-act">
        <div class="fh-queue"><span>В очереди</span><b>${free.length}</b></div>
        <div class="fh-find">
          <input id="fillFind" class="search" placeholder="Номер заказа, ФИО или телефон — кто заполнял"
            value="${esc(fillFindQ)}" autocomplete="off">
          <button class="btn sm ghost" id="fillFindBtn">Найти</button>
        </div>
      </div>
    </div>
    <div id="fillFindBox"></div>
    ${fillCityBarHtml()}
    ${!admin?`<div class="ft-period fill-period-own">
      ${FILL_TABS.map(([k,l])=>`<button data-filltab="${k}" class="${tab===k?'active':''}">${l}</button>`).join('')}
      <input type="date" id="fillFromInp" value="${esc(from)}" max="${esc(localToday())}" title="С какого дня">
      <input type="date" id="fillToInp" value="${esc(to)}" max="${esc(localToday())}" title="По какой день">
      ${reload}
    </div>`:''}
    <div class="fill-kpi">
      <div class="fk fk-main">
        <div class="fk-k">Ждут заполнения</div>
        <div class="fk-v">${queue.length}</div>
        <div class="fk-s">свободно ${free.length}${mine.length?` · у меня ${mine.length}`:''}${held.length?` · отложено ${held.length}`:''}${
          qWide?` · с ${esc(fmtDate(qFrom))}`:''}${fillCity?` · город ${esc(fillCityLabel())}`:''}</div>
      </div>
      ${!admin?`
      <div class="fk">
        <div class="fk-k">Заполнено мной ${esc(fillPeriodWord(tab))}</div>
        <div class="fk-v">${my.count}</div>
        <div class="fk-s">${delta===null?'не с чем сравнить':
          `<span class="${delta>=0?'up':'down'}">${delta>=0?'▲':'▼'} ${Math.abs(delta)}%</span> ${
            tab==='today'?'ко вчерашнему дню':'к прошлому такому же периоду'}`}</div>
      </div>
      <div class="fk">
        <div class="fk-k">Моё среднее время</div>
        <div class="fk-v">${esc(fillFmtSec(my.avg))}<small> / ${FILL_NORM_SEC} сек</small></div>
        <div class="fk-s">${my.normPct===null?'замеров пока нет':`${my.normPct}% заказов в норме`}</div>
      </div>
      <div class="fk">
        <div class="fk-k">Моё время ${esc(fillPeriodWord(tab))}</div>
        <div class="fk-v">${esc(fillFmtDur(my.totalSec))}</div>
        <div class="fk-s">простои не считаются</div>
      </div>`:''}
      ${admin?`
      <div class="fk">
        <div class="fk-k">Заполнено${tab==='today'?' сегодня':''}</div>
        <div class="fk-v">${team.count}</div>
        <div class="fk-s">${delta===null?'не с чем сравнить':
          `<span class="${delta>=0?'up':'down'}">${delta>=0?'▲':'▼'} ${Math.abs(delta)}%</span> к прошлому периоду`}</div>
      </div>
      <div class="fk">
        <div class="fk-k">Среднее время</div>
        <div class="fk-v">${esc(fillFmtSec(teamAvg))}<small> / ${FILL_NORM_SEC} сек</small></div>
        <div class="fk-s">захват снимается через ${FILL_CLAIM_MIN} мин</div>
      </div>
      <div class="fk fk-ringrow">
        <div>
          <div class="fk-k">В норме</div>
          <div class="fk-v">${teamNorm===null?'—':teamNorm+'%'}</div>
          <div class="fk-s">${team.inNorm} из ${team.measured} замеров</div>
        </div>
        ${fillRing(teamNorm)}
      </div>`:''}
    </div>
    ${mine.length?`<div class="panel">
      <div class="panel-head"><h2>У меня в работе</h2><span class="count">${mine.length}</span></div>
      <div class="table-scroll"><table class="resp-table"><thead><tr><th>Заказ</th><th>Партнёр</th><th>Взят</th><th></th></tr></thead><tbody>
        ${mine.map(o=>`<tr>
          <td data-label="Заказ"><strong style="font-family:'Fraunces',serif">${esc(o.code||'')}</strong></td>
          <td data-label="Партнёр">${esc(o.sender||partnerName(o.partner_id)||'—')}</td>
          <td data-label="Взят">${esc(fillAgo(o.claimed_at))}</td>
          <td data-label=""><button class="btn sm" data-fillopen="${o.id}">Заполнить</button>
            ${canHold?`<button class="btn sm ghost" data-fillhold="${o.id}" title="Заказ останется за вами, пока не заполните или не вернёте">Отложить</button>`:''}
            <button class="btn sm ghost" data-fillrel="${o.id}">Вернуть</button></td>
        </tr>`).join('')}
      </tbody></table></div></div>`:''}
    ${held.length?`<div class="panel">
      <div class="panel-head"><h2>Отложенные</h2><span class="count">${held.length}</span></div>
      <p class="staff-hint">Ждут данных от партнёра. В общую очередь не уходят и остаются за вами.</p>
      <div class="table-scroll"><table class="resp-table"><thead><tr><th>Заказ</th><th>Партнёр</th><th>Отложен</th><th></th></tr></thead><tbody>
        ${held.map(o=>`<tr>
          <td data-label="Заказ"><strong style="font-family:'Fraunces',serif">${esc(o.code||'')}</strong></td>
          <td data-label="Партнёр">${esc(o.sender||partnerName(o.partner_id)||'—')}</td>
          <td data-label="Отложен">${esc(fillAgo(o.claimed_at))}</td>
          <td data-label=""><button class="btn sm" data-fillopen="${o.id}">Заполнить</button>
            <button class="btn sm ghost" data-fillunhold="${o.id}">Вернуть в работу</button>
            <button class="btn sm ghost" data-fillrel="${o.id}">В общую очередь</button></td>
        </tr>`).join('')}
      </tbody></table></div></div>`:''}
    ${admin?`<div class="panel fill-team">
      <div class="panel-head">
        <h2>Менеджеры заказов</h2>
        <div class="ft-period">
          ${FILL_TABS.map(([k,l])=>`<button data-filltab="${k}" class="${tab===k?'active':''}">${l}</button>`).join('')}
          <input type="date" id="fillFromInp" value="${esc(from)}" max="${esc(localToday())}" title="С какого дня">
          <input type="date" id="fillToInp" value="${esc(to)}" max="${esc(localToday())}" title="По какой день">
          ${reload}
        </div>
      </div>
      <div class="table-scroll"><table class="resp-table ft-tbl"><thead><tr>
        <th>#</th><th>Менеджер</th><th>Заполнил</th><th>Среднее</th><th>В норме</th><th>За день</th><th>Сейчас</th>
      </tr></thead><tbody>
        ${rows.length?rows.map((r,i)=>`<tr>
          <td data-label="#"><span class="ft-rank ${i===0?'top':''}">${i+1}</span></td>
          <td data-label="Менеджер"><div class="ft-who">
            <span class="ft-ava" style="background:${fillAvaColor(r.name)}">${esc(fillInitials(r.name))}</span>
            <div><b>${esc(r.name)}</b><span class="ft-sub">${
              isOnline(r.id)?'<i class="ft-dot"></i>в системе':''
            }${r.inWork?(isOnline(r.id)?' · ':'')+'сейчас в работе':(r.last?(isOnline(r.id)?' · ':'')+esc(fillAgo(r.last)):(isOnline(r.id)?'':'—'))}</span></div>
          </div></td>
          <td data-label="Заполнил"><b class="ft-num">${r.count}</b>
            <span class="ft-bar"><i style="width:${Math.round(r.count/maxCount*100)}%"></i></span></td>
          <td data-label="Среднее"><span class="ft-chip ${r.avg==null?'':(r.avg<=FILL_NORM_SEC?'ok':(r.avg<=FILL_NORM_SEC+10?'warn':'bad'))}">${esc(fillFmtSec(r.avg))}</span></td>
          <td data-label="В норме">${r.normPct===null?'—':`${r.normPct}%
            <span class="ft-bar"><i class="${r.normPct>=80?'ok':(r.normPct>=60?'warn':'bad')}" style="width:${r.normPct}%"></i></span>`}</td>
          <td data-label="За день"><b>${esc(fillFmtDur(r.totalSec))}</b></td>
          <td data-label="Сейчас">${r.inWork?`<span class="ft-busy">${r.inWork} в работе</span>`:(r.onHold?'':'свободен')}${
            r.onHold?`<span class="ft-sub${fillHoldStale(r.holdSince)?' ft-stale':''}">отложено ${r.onHold}${
              r.holdSince?' · '+esc(fillAgo(r.holdSince)):''}</span>`:''}</td>
        </tr>`).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">За этот период никто ничего не заполнил</td></tr>'}
      </tbody>
      ${rows.length?`<tfoot><tr class="ft-total">
        <td></td><td>Итого по команде</td><td><b>${team.count}</b></td>
        <td>${esc(fillFmtSec(teamAvg))}</td><td>${teamNorm===null?'—':teamNorm+'%'}</td>
        <td><b>${esc(fillFmtDur(team.secs))}</b></td><td>${team.inWork} в работе${team.hold?` · ${team.hold} отложено`:''}</td>
      </tr></tfoot>`:''}
      </table></div>
      <div class="ft-legend">
        <span>Среднее время:</span>
        <i class="ok">до ${FILL_NORM_SEC} сек</i>
        <i class="warn">до ${FILL_NORM_SEC+10} сек</i>
        <i class="bad">дольше</i>
        <span class="ft-legend-note">«За день» — сколько времени реально ушло на заказы, простои не считаются</span>
      </div>
    </div>`:''}
    <div class="fill-take">
      <button class="btn" id="fillNextBottom" ${free.length||mine.length?'':'disabled'}>Взять следующий</button>
      <span>${free.length
        ? `свободных заказов: ${free.length}${qWide?` · с ${esc(fmtDate(qFrom))}`:''}${fillCity?` · город ${esc(fillCityLabel())}`:''}`
        : `свободных заказов нет — ${esc(fillWhyEmpty(queue,free,mine,held))}`}</span>
      ${tail?`<button class="btn sm ghost" id="fillTail">Добрать за ${esc(fmtDate(tailDay))} (${tail})</button>`:''}
      ${admin?'':reload}
    </div>`;

  ['fillNext','fillNextBottom'].forEach(id=>{const b=$(id);if(b)b.onclick=()=>fillTakeNext();});
  if($('fillFindBtn'))$('fillFindBtn').onclick=()=>fillFind();
  if($('fillFind')){
    const inp=$('fillFind');
    inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();fillFind();}};
    // Пробел в поле поиска — это пробел, а не «взять следующий»: иначе имя не набрать.
    inp.onkeyup=e=>e.stopPropagation();
    inp.onkeypress=e=>e.stopPropagation();
  }
  if(fillFindRes!==null)fillFindDraw();
  $('main').querySelectorAll('.fill-reload').forEach(b=>b.onclick=()=>fillRefresh());
  if($('fillTail'))$('fillTail').onclick=()=>fillExtendQueue();
  const cs=$('fillCitySel'); if(cs) cs.onchange=()=>fillSetCity(cs.value);
  if($('fillCityAll'))$('fillCityAll').onclick=()=>fillSetCity('');
  $('main').querySelectorAll('[data-fillopen]').forEach(b=>b.onclick=()=>orderModal(b.dataset.fillopen));
  $('main').querySelectorAll('[data-fillrel]').forEach(b=>b.onclick=()=>fillRelease(b.dataset.fillrel));
  $('main').querySelectorAll('[data-fillhold]').forEach(b=>b.onclick=()=>fillHold(b.dataset.fillhold,true));
  $('main').querySelectorAll('[data-fillunhold]').forEach(b=>b.onclick=()=>fillHold(b.dataset.fillunhold,false));
  $('main').querySelectorAll('[data-filltab]').forEach(b=>b.onclick=()=>fillSetTab(b.dataset.filltab));
  const fi=$('fillFromInp'); if(fi) fi.onchange=()=>{
    fillFrom=fi.value||'';
    if(fillTo&&fillFrom&&fillTo<fillFrom)fillTo=fillFrom; // период наизнанку — таблица молча пустела бы
    renderFilling();fillEnsureLoaded();
  };
  const ti=$('fillToInp'); if(ti) ti.onchange=()=>{
    fillTo=ti.value||'';
    if(fillTo&&fillFrom&&fillTo<fillFrom)fillFrom=fillTo;
    renderFilling();fillEnsureLoaded();
  };
}

// Пробел берёт следующий заказ: руки менеджера на клавиатуре, и тянуться мышью
// к кнопке после каждого заказа — лишнее движение сотню раз за смену.
document.addEventListener('keydown',e=>{
  if(S.tab!=='filling'||e.code!=='Space'||e.repeat)return;
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const t=e.target;
  if(t&&(t.matches('input,textarea,select,button')||t.isContentEditable))return;
  if(document.querySelector('.overlay'))return; // открыта карточка — пробел печатает
  e.preventDefault();
  fillTakeNext();
});

// ==================== «КТО ЗАПОЛНЯЛ ЭТОТ ЗАКАЗ» ====================
// Раньше на этом месте стояла вторая кнопка «Взять следующий» — та же, что внизу
// страницы. Дубль убран, вместо него поиск: по номеру заказа, ФИО или телефону
// видно, кто заказ заполнил и когда.
//
// Ищем ЗАПРОСОМ К БАЗЕ, а не по S.orders: в памяти вкладки после входа лежат только
// сегодняшние заказы, а спрашивают обычно про вчерашний или позавчерашний.
let fillFindQ='', fillFindRes=null, fillFindBusy=false;

async function fillFind(){
  const inp=$('fillFind');
  fillFindQ=inp?inp.value.trim():'';
  if(!fillFindQ){fillFindRes=null;fillFindDraw();return;}
  if(fillFindBusy)return;
  fillFindBusy=true;fillFindDraw('Ищу…');
  const q=fillFindQ;
  const digits=q.replace(/\D/g,'');
  const like=v=>v.replace(/[%,]/g,' ');
  // Телефон в базе лежит цифрами, поэтому по нему ищем отдельным условием и только
  // если цифры в запросе реально есть: пустая строка — подстрока чего угодно, и
  // поиск по имени показывал бы вообще всё (те же грабли были в «Сортировке»).
  const isTrack=/^[A-Za-z]{2}\d+[A-Za-z]{2}$/.test(q.replace(/\s/g,''));
  const conds=[`code.ilike.%${like(q)}%`,`client.ilike.%${like(q)}%`];
  if(isTrack)conds.push(`track.ilike.%${like(q.replace(/\s/g,''))}%`);
  // Цифры трека телефоном быть не могут — лишнее условие по 26 тысячам строк ни к чему.
  else if(digits.length>=4)conds.push(`phone.ilike.%${digits}%`);
  try{
    const {data,error}=await sb.from('orders')
      .select('id,code,client,phone,track,pickup_date,created_at,filled_at,filled_by,filled_by_name,claimed_at,claimed_by,claim_hold,delivery_id,sender')
      .or(conds.join(','))
      .order('created_at',{ascending:false})
      .limit(20);
    if(error)throw error;
    fillFindRes=data||[];
    await fillFindFromLog(fillFindRes);
  }catch(e){
    console.error('fillFind',e);
    fillFindRes=[];
    toast('Не удалось выполнить поиск');
  }
  fillFindBusy=false;
  fillFindDraw();
}

// ОТМЕТКИ «КТО ЗАПОЛНИЛ» У СТАРЫХ ЗАКАЗОВ НЕТ — и это не ошибка.
//
// `filled_at` проставляется в момент, когда заказ ВПЕРВЫЕ становится обработанным, и
// только с тех пор, как в базе появились эти колонки (db/11). Всё, что заполнили
// раньше, отметки не получило и уже не получит: задним числом её взять неоткуда.
//
// Зато есть журнал изменений: `dbUpdate` пишет туда запись при каждой правке вместе
// со списком изменённых полей. Ищем самую раннюю, где ФИО получателя появилось из
// пустого, — это и есть заполнение. Если такой нет, берём первую правку вообще.
//
// Показываем это ОТДЕЛЬНОЙ подписью «по журналу правок», а не подменяем ею настоящую
// отметку: журнал говорит, кто менял заказ, а не кто сидел и забивал его с бланка.
async function fillFindFromLog(list){
  const need=(list||[]).filter(o=>!o.filled_at&&o.id);
  if(!need.length)return;
  try{
    const {data,error}=await sb.from('activity_log')
      .select('entity_id,user_name,created_at,action,changes')
      .eq('entity','orders').in('entity_id',need.map(o=>String(o.id)))
      .order('created_at',{ascending:true}).limit(500);
    if(error)throw error;
    const byOrder={};
    (data||[]).forEach(r=>{(byOrder[String(r.entity_id)]=byOrder[String(r.entity_id)]||[]).push(r);});
    need.forEach(o=>{
      const rows=byOrder[String(o.id)]||[];
      if(!rows.length)return;
      const filledIt=rows.find(r=>Array.isArray(r.changes)&&r.changes.some(c=>
        c&&c.field==='client'&&!String(c.old||'').trim()&&String(c.new||'').trim()));
      const first=filledIt||rows.find(r=>r.action==='update')||rows[0];
      if(first){o._logName=first.user_name||'';o._logAt=first.created_at;o._logExact=!!filledIt;}
    });
  }catch(e){console.error('fillFindFromLog',e);} // журнал мог быть закрыт правами — не беда
}

// Кто держит заказ сейчас — по тем же правилам, что и очередь: захват живой
// FILL_CLAIM_MIN минут, потом заказ возвращается в общий пул.
function fillClaimNow(o){
  if(!o.claimed_by||!o.claimed_at)return null;
  const alive=(Date.now()-new Date(o.claimed_at))/60000 < FILL_CLAIM_MIN;
  if(!alive)return null;
  const p=(S.profiles||[]).find(x=>x.id===o.claimed_by);
  return {name:p?(p.full_name||p.email||'сотрудник'):'сотрудник',hold:!!o.claim_hold};
}

function fillFindDraw(note){
  const box=$('fillFindBox');if(!box)return;
  if(note){box.innerHTML=`<div class="fill-find-box"><p class="ff-note">${esc(note)}</p></div>`;return;}
  if(fillFindRes===null){box.innerHTML='';return;}
  if(!fillFindRes.length){
    box.innerHTML=`<div class="fill-find-box">
      <p class="ff-note">По запросу «${esc(fillFindQ)}» ничего не нашлось.
        Ищем по номеру заказа, ФИО получателя, телефону и треку.</p>
      <button class="btn sm ghost" id="ffClose">Закрыть</button></div>`;
    if($('ffClose'))$('ffClose').onclick=()=>{fillFindRes=null;fillFindQ='';fillFindDraw();};
    return;
  }
  const rows=fillFindRes.map(o=>{
    const claim=fillClaimNow(o);
    const secs=fillOrderSecs(o);
    let who,when,cls;
    if(o.filled_at){
      who=esc(o.filled_by_name||'—');
      when=esc(fmtDateTime(o.filled_at))+(secs!=null?` · за ${Math.round(secs)} сек`:'');
      cls='ff-done';
    }else if(o._logName){
      // Заказ заполнен, но до появления отметок — восстановили по журналу правок.
      who=esc(o._logName)+'<small class="cell-time">по журналу правок</small>';
      when=esc(fmtDateTime(o._logAt))+(o._logExact?'<small class="cell-time">тогда появилось ФИО получателя</small>':'<small class="cell-time">первая правка заказа</small>');
      cls='ff-done';
    }else if(claim){
      who=esc(claim.name);
      when=claim.hold?'отложен, держит за собой':'взят в работу, ещё не заполнен';
      cls='ff-work';
    }else{
      // Отличаем «ещё не заполнен» от «заполнен, но кем — не записано»: у старого
      // заказа с данными писать «ждёт заполнения» было бы прямым враньём.
      const done=!!(o.client&&String(o.client).trim());
      who='<span class="ff-dim">'+(done?'не записано':'никто')+'</span>';
      when=done?'<span class="ff-dim">заполнен до того, как появился учёт</span>':'ждёт заполнения';
      cls=done?'ff-wait':'ff-wait';
    }
    return `<tr class="${cls}">
      <td data-label="Заказ"><b>${esc(o.code||'—')}</b>${o.sender?`<small class="cell-time">${esc(o.sender)}</small>`:''}</td>
      <td data-label="Получатель">${esc(o.client||'—')}${o.phone?`<small class="cell-time">${esc(phoneDisplay(o.phone))}</small>`:''}</td>
      <td data-label="Забор">${esc(String(o.pickup_date||o.created_at||'').slice(0,10))}</td>
      <td data-label="Кто заполнил">${who}</td>
      <td data-label="Когда">${when}</td>
    </tr>`;
  }).join('');
  box.innerHTML=`<div class="fill-find-box">
    <div class="ff-head"><b>Найдено: ${fillFindRes.length}</b>
      <span class="ff-dim">по запросу «${esc(fillFindQ)}»</span>
      <button class="btn sm ghost" id="ffClose" style="margin-left:auto">✕ Закрыть</button></div>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Заказ</th><th>Получатель</th><th>Забор</th><th>Кто заполнил</th><th>Когда</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    ${fillFindRes.length>=20?'<p class="ff-note">Показаны первые 20 — уточните запрос.</p>':''}
  </div>`;
  if($('ffClose'))$('ffClose').onclick=()=>{fillFindRes=null;fillFindQ='';fillFindDraw();};
}
