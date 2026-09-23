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
// захват ещё живой?
function fillClaimAlive(o){ return !!(o.claimed_at && o.claimed_at > fillCutoff()); }
function fillIsMine(o){ return fillClaimAlive(o) && o.claimed_by === (S.me && S.me.id); }

function fillQueue(){ return (S.orders || []).filter(o => fillNeedsWork(o) && fillIsToday(o)); }
function fillOther(){ return (S.orders || []).filter(o => fillNeedsWork(o) && !fillIsToday(o)); }
function fillFree(){ return fillQueue().filter(o => !fillClaimAlive(o)); }
function fillMine(){ return fillQueue().filter(fillIsMine); }

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

// вернуть заказ в общую очередь, не заполняя
async function fillRelease(id){
  const o = (S.orders || []).find(x => x.id === id);
  if(!o) return;
  const u = await dbUpdate('orders', id, { claimed_by: null, claimed_by_name: null, claimed_at: null });
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
  const inWork = {};
  fillQueue().filter(fillClaimAlive).forEach(o => {
    const nm = o.claimed_by_name || '—';
    inWork[nm] = (inWork[nm] || 0) + 1;
    add(nm, o.claimed_by);
  });
  return Object.values(by).map(r => ({
    ...r,
    avg: r.secs.length ? r.secs.reduce((s,x) => s+x, 0) / r.secs.length : null,
    normPct: r.secs.length ? Math.round(r.inNorm / r.secs.length * 100) : null,
    inWork: inWork[r.name] || 0,
  })).sort((a,b) => b.count - a.count);
}
// Тот же период, сдвинутый назад на свою длину, — для «▲ 12% к прошлому периоду».
function fillPrevCount(){
  const { from, to } = fillPeriod();
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const shift = d => new Date(new Date(d).getTime() - days * 86400000).toISOString().slice(0, 10);
  return fillDoneIn(shift(from), shift(to)).length;
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
  const queue=fillQueue(), free=fillFree(), mine=fillMine(), other=fillOther();
  const admin=isAdmin();
  const rows=admin?fillStatsRows():[];
  const team=rows.reduce((a,r)=>({
    count:a.count+r.count, secs:a.secs+r.totalSec, inNorm:a.inNorm+r.inNorm,
    measured:a.measured+r.secs.length, inWork:a.inWork+r.inWork,
  }),{count:0,secs:0,inNorm:0,measured:0,inWork:0});
  const teamAvg=team.measured?team.secs/team.measured:null;
  const teamNorm=team.measured?Math.round(team.inNorm/team.measured*100):null;
  const prev=admin?fillPrevCount():0;
  const delta=prev?Math.round((team.count-prev)/prev*100):null;
  const maxCount=rows.reduce((m,r)=>Math.max(m,r.count),0)||1;
  const {from,to}=fillPeriod();
  const tab=fillActiveTab();
  const reload='<button class="btn sm ghost" id="fillReload" title="Подтянуть свежие заказы — фото могли приложить только что">🔄 Обновить</button>';

  $('main').innerHTML=`
    <div class="fill-head">
      <div><h1>Заполнение</h1><p>Заказы выдаются по одному — двое не сядут за один и тот же</p></div>
      <div class="fill-head-act">
        <div class="fh-queue"><span>В очереди</span><b>${free.length}</b></div>
        <button class="btn primary" id="fillNext" ${free.length||mine.length?'':'disabled'}>
          Взять следующий <kbd>Space</kbd></button>
      </div>
    </div>
    ${other.length?`<div class="fill-note">
      <span>⚠ ${other.length} ${other.length===1?'заказ':'заказов'} с прошлых дней остались незаполненными — в выдачу они не идут</span>
    </div>`:''}
    <div class="fill-kpi${admin?'':' one'}">
      <div class="fk fk-main">
        <div class="fk-k">Ждут заполнения</div>
        <div class="fk-v">${queue.length}</div>
        <div class="fk-s">свободно ${free.length}${mine.length?` · у меня ${mine.length}`:''}</div>
      </div>
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
            <button class="btn sm ghost" data-fillrel="${o.id}">Вернуть</button></td>
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
          <td data-label="Сейчас">${r.inWork?`<span class="ft-busy">${r.inWork} в работе</span>`:'свободен'}</td>
        </tr>`).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">За этот период никто ничего не заполнил</td></tr>'}
      </tbody>
      ${rows.length?`<tfoot><tr class="ft-total">
        <td></td><td>Итого по команде</td><td><b>${team.count}</b></td>
        <td>${esc(fillFmtSec(teamAvg))}</td><td>${teamNorm===null?'—':teamNorm+'%'}</td>
        <td><b>${esc(fillFmtDur(team.secs))}</b></td><td>${team.inWork} в работе</td>
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
  const rl=$('fillReload'); if(rl) rl.onclick=()=>fillRefresh();
  $('main').querySelectorAll('[data-fillopen]').forEach(b=>b.onclick=()=>orderModal(b.dataset.fillopen));
  $('main').querySelectorAll('[data-fillrel]').forEach(b=>b.onclick=()=>fillRelease(b.dataset.fillrel));
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
