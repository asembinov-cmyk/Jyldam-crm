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

const FILL_CLAIM_MIN = 10;   // сколько минут заказ держится за менеджером
const FILL_NORM_SEC  = 60;   // норма времени на один заказ
let fillFrom = '', fillTo = '';  // период статистики, пусто = сегодня
let fillBusy = false;            // защита от двойного нажатия «Взять следующий»

// Колонки могли ещё не появиться в базе (SQL из db/11 не выполнен). Понять это можно
// бесплатно: заказы грузятся через select('*'), и если колонка есть, она есть и в строке.
const fillReady = () => !!(S.orders && S.orders.length && ('filled_at' in S.orders[0]));

// Местная дата отметки времени. Брать slice(0,10) от ISO нельзя: там UTC, и заказ,
// заполненный в половине первого ночи, попадал бы во вчерашний день (Астана +5).
const localDateOf = ts => {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fillMeName = () => (S.me && (S.me.full_name || S.me.email)) || '';
const fillCutoff = () => new Date(Date.now() - FILL_CLAIM_MIN * 60000).toISOString();

// Заказ ждёт заполнения: фото бланка есть, данных клиента нет.
//
// Проверяем именно ПУСТОЕ ФИО, а не orderIsProcessed() из «Сортировки». То правило
// требует ещё и типа доставки, и под него попадал заказ с заполненным ФИО, но без
// типа: системе он «не обработан», а менеджеру выдавался уже забитым. Таких много
// среди старых заказов.
function fillNeedsWork(o){
  if(o.filled_at) return false;
  if(String(o.client || '').trim()) return false;
  const photos = o.photos;
  return Array.isArray(photos) ? photos.length > 0 : !!photos;
}
// Дата заказа: по забору, а если её нет — по созданию.
const fillOrderDate = o => o.pickup_date ? String(o.pickup_date).slice(0, 10)
  : (o.created_at ? localDateOf(o.created_at) : '');
// Выдаём только сегодняшние заказы. Вчерашние и более старые пустые «болванки» —
// это почти всегда то, что партнёр заявил, но не отдал; заполнять там нечего, а
// менеджер потратит время. Их число показываем отдельно, чтобы не пропали из виду.
function fillIsToday(o){ return fillOrderDate(o) === localToday(); }
// Захват живой? Отложенный заказ не протухает: менеджер ждёт данных от партнёра,
// и отдавать заказ соседу через десять минут — значит потерять то, чего он ждал.
const fillHoldReady = () => !!(S.orders && S.orders.length && ('claim_hold' in S.orders[0]));
function fillIsHeld(o){ return !!o.claim_hold; }
function fillClaimAlive(o){ return fillIsHeld(o) || !!(o.claimed_at && o.claimed_at > fillCutoff()); }
function fillIsMine(o){ return fillClaimAlive(o) && o.claimed_by === (S.me && S.me.id); }

function fillQueue(){ return (S.orders || []).filter(o => fillNeedsWork(o) && fillIsToday(o)); }
function fillFree(){ return fillQueue().filter(o => !fillClaimAlive(o)); }
function fillMine(){ return fillQueue().filter(o => fillIsMine(o) && !fillIsHeld(o)); }
function fillHeld(){ return fillQueue().filter(o => fillIsMine(o) && fillIsHeld(o)); }

/* ---------- выдача следующего заказа ---------- */
async function fillTakeNext(){
  if(fillBusy) return;
  fillBusy = true;
  try{
    // Самые старые вперёд: заказ, пролежавший дольше, и уйти должен раньше.
    const free = fillFree().sort((a,b) => String(a.created_at||'').localeCompare(String(b.created_at||'')));
    if(!free.length){ toast('Свободных заказов нет'); return; }
    const now = new Date().toISOString();
    // Идём по списку, пока захват не удастся: пока мы думали, заказ мог забрать сосед.
    for(const o of free.slice(0, 20)){
      const { data, error } = await sb.from('orders')
        .update({ claimed_by: (S.me && S.me.id) || null, claimed_by_name: fillMeName(), claimed_at: now })
        .eq('id', o.id)
        .is('filled_at', null)
        .or(`claimed_at.is.null,claimed_at.lt.${fillCutoff()}`)
        .select();
      if(error){ console.error('fill claim', error); toast('Ошибка: ' + error.message); return; }
      if(data && data.length){
        Object.assign(o, data[0]);
        renderFilling();
        orderModal(o.id);
        return;
      }
    }
    toast('Свободные заказы разобрали — попробуйте ещё раз');
  } finally { fillBusy = false; }
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
  return (sec >= 0 && sec <= FILL_CLAIM_MIN * 60) ? sec : null;
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
  const inWork = {}, onHold = {};
  fillQueue().filter(fillClaimAlive).forEach(o => {
    const nm = o.claimed_by_name || '—';
    const box = fillIsHeld(o) ? onHold : inWork;
    box[nm] = (box[nm] || 0) + 1;
    add(nm, o.claimed_by);
  });
  return Object.values(by).map(r => ({
    ...r,
    avg: r.secs.length ? r.secs.reduce((s,x) => s+x, 0) / r.secs.length : null,
    normPct: r.secs.length ? Math.round(r.inNorm / r.secs.length * 100) : null,
    inWork: inWork[r.name] || 0,
    onHold: onHold[r.name] || 0,
  })).sort((a,b) => b.count - a.count);
}
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
  const b = $('fillReload');
  if(b){ b.disabled = true; b.textContent = 'Обновляем…'; }
  try{
    const today = localToday();
    const { data, error } = await sb.from('orders').select('*')
      .or(`pickup_date.eq.${today},created_at.gte.${today}T00:00:00`);
    if(error) throw error;
    const byId = {}; (S.orders || []).forEach((o, i) => { byId[o.id] = i; });
    (data || []).forEach(row => {
      if(byId[row.id] != null) Object.assign(S.orders[byId[row.id]], row);
      else S.orders.unshift(row);
    });
  }catch(e){ console.error('fillRefresh', e); toast('Не удалось обновить'); }
  renderFilling();
}

/* ---------- экран ---------- */
// Быстрые периоды. Диапазон дат рядом остаётся — им задают любой отрезок.
const FILL_TABS=[['today','Сегодня'],['yest','Вчера'],['week','Неделя'],['month','Месяц']];
function fillSetTab(k){
  const d=n=>new Date(new Date(localToday()).getTime()-n*86400000).toISOString().slice(0,10);
  if(k==='today'){fillFrom='';fillTo='';}
  else if(k==='yest'){fillFrom=d(1);fillTo=d(1);}
  else if(k==='week'){fillFrom=d(6);fillTo=localToday();}
  else if(k==='month'){fillFrom=localToday().slice(0,8)+'01';fillTo=localToday();}
  renderFilling();
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
      <div class="empty"><div class="big">Раздел ещё не включён</div>
      <p>В таблице заказов нет полей для учёта. Выполните <b>db/11-ЗАБИВКА-распределение-заказов.sql</b> и обновите страницу.</p></div>`;
    return;
  }
  const queue=fillQueue(), free=fillFree(), mine=fillMine(), held=fillHeld();
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
  const reload='<button class="btn sm ghost" id="fillReload" title="Подтянуть свежие заказы — фото могли приложить только что">🔄 Обновить</button>';

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
    <div class="fill-kpi">
      <div class="fk fk-main">
        <div class="fk-k">Ждут заполнения</div>
        <div class="fk-v">${queue.length}</div>
        <div class="fk-s">свободно ${free.length}${mine.length?` · у меня ${mine.length}`:''}${held.length?` · отложено ${held.length}`:''}</div>
      </div>
      ${!admin?`
      <div class="fk">
        <div class="fk-k">Заполнено мной сегодня</div>
        <div class="fk-v">${my.count}</div>
        <div class="fk-s">${delta===null?'не с чем сравнить':
          `<span class="${delta>=0?'up':'down'}">${delta>=0?'▲':'▼'} ${Math.abs(delta)}%</span> ко вчерашнему дню`}</div>
      </div>
      <div class="fk">
        <div class="fk-k">Моё среднее время</div>
        <div class="fk-v">${esc(fillFmtSec(my.avg))}<small> / ${FILL_NORM_SEC} сек</small></div>
        <div class="fk-s">${my.normPct===null?'замеров пока нет':`${my.normPct}% заказов в норме`}</div>
      </div>
      <div class="fk">
        <div class="fk-k">Моё время за день</div>
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
          <td data-label="Сейчас">${r.inWork?`<span class="ft-busy">${r.inWork} в работе</span>`:(r.onHold?'':'свободен')}${r.onHold?`<span class="ft-sub">отложено ${r.onHold}</span>`:''}</td>
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
      <span>${free.length?`свободных заказов: ${free.length}`:'свободных заказов нет'}</span>
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
  const rl=$('fillReload'); if(rl) rl.onclick=()=>fillRefresh();
  $('main').querySelectorAll('[data-fillopen]').forEach(b=>b.onclick=()=>orderModal(b.dataset.fillopen));
  $('main').querySelectorAll('[data-fillrel]').forEach(b=>b.onclick=()=>fillRelease(b.dataset.fillrel));
  $('main').querySelectorAll('[data-fillhold]').forEach(b=>b.onclick=()=>fillHold(b.dataset.fillhold,true));
  $('main').querySelectorAll('[data-fillunhold]').forEach(b=>b.onclick=()=>fillHold(b.dataset.fillunhold,false));
  $('main').querySelectorAll('[data-filltab]').forEach(b=>b.onclick=()=>fillSetTab(b.dataset.filltab));
  const fi=$('fillFromInp'); if(fi) fi.onchange=()=>{
    fillFrom=fi.value||'';
    if(fillTo&&fillFrom&&fillTo<fillFrom)fillTo=fillFrom; // период наизнанку — таблица молча пустела бы
    renderFilling();
  };
  const ti=$('fillToInp'); if(ti) ti.onchange=()=>{
    fillTo=ti.value||'';
    if(fillTo&&fillFrom&&fillTo<fillFrom)fillFrom=fillTo;
    renderFilling();
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
  }catch(e){
    console.error('fillFind',e);
    fillFindRes=[];
    toast('Не удалось выполнить поиск');
  }
  fillFindBusy=false;
  fillFindDraw();
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
    }else if(claim){
      who=esc(claim.name);
      when=claim.hold?'отложен, держит за собой':'взят в работу, ещё не заполнен';
      cls='ff-work';
    }else{
      who='<span class="ff-dim">никто</span>';
      when='ждёт заполнения';
      cls='ff-wait';
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
