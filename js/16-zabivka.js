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
const fillOrderDate = o => String(o.pickup_date || o.created_at || '').slice(0, 10);
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
function fillStatsRows(){
  // Границы периода. Пусто — сегодняшний день: чаще всего смотрят именно его.
  const from = fillFrom || localToday();
  const to   = fillTo   || from;
  const done = (S.orders || []).filter(o => {
    if(!o.filled_at) return false;
    const d = String(o.filled_at).slice(0, 10);
    return d >= from && d <= to;
  });
  const by = {};
  done.forEach(o => {
    const nm = o.filled_by_name || '— без имени —';
    if(!by[nm]) by[nm] = { name: nm, count: 0, secs: [], slow: 0 };
    by[nm].count++;
    if(o.claimed_at){
      const sec = (new Date(o.filled_at) - new Date(o.claimed_at)) / 1000;
      // Дольше окна захвата — человек отошёл, а не работал: в среднее такое не берём,
      // иначе один обед превращает статистику в бессмыслицу.
      if(sec >= 0 && sec <= FILL_CLAIM_MIN * 60){
        by[nm].secs.push(sec);
        if(sec > FILL_NORM_SEC) by[nm].slow++;
      }
    }
  });
  const inWork = {};
  fillQueue().filter(fillClaimAlive).forEach(o => {
    const nm = o.claimed_by_name || '—';
    inWork[nm] = (inWork[nm] || 0) + 1;
  });
  Object.keys(inWork).forEach(nm => { if(!by[nm]) by[nm] = { name: nm, count: 0, secs: [], slow: 0 }; });
  return Object.values(by).map(r => {
    const avg = r.secs.length ? r.secs.reduce((s,x) => s+x, 0) / r.secs.length : null;
    return { ...r, avg, inWork: inWork[r.name] || 0 };
  }).sort((a,b) => b.count - a.count);
}
const fillFmtSec = s => {
  if(s == null) return '—';
  const m = Math.floor(s / 60), ss = Math.round(s % 60);
  return m ? `${m}:${String(ss).padStart(2,'0')}` : `${ss} сек`;
};
const fillAgo = iso => {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if(m < 1) return 'только что';
  return `${m} мин назад`;
};

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
function renderFilling(){
  if(!canMod('filling')){ $('main').innerHTML = '<div class="empty"><div class="big">Нет доступа</div></div>'; return; }
  if(!fillReady()){
    $('main').innerHTML = `
      <div class="page-head"><div><h1>Заполнение</h1></div></div>
      <div class="empty"><div class="big">Раздел ещё не включён</div>
      <p>В таблице заказов нет полей для учёта забивки. Выполните <b>db/11-ЗАБИВКА-распределение-заказов.sql</b> и обновите страницу.</p></div>`;
    return;
  }
  const queue = fillQueue(), free = fillFree(), mine = fillMine(), other = fillOther();
  // Кто сколько заполнил — только администратору. Менеджеру эта таблица не нужна
  // в работе, а сравнивать себя с соседями по ходу смены — лишнее.
  const rows = isAdmin() ? fillStatsRows() : [];
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Заполнение</h1><p>Заказы выдаются по одному — двое не сядут за один и тот же</p></div>
    </div>
    <div class="dash-cards">
      <div class="dash-card"><div class="dc-ic">📝</div><div><div class="dc-v">${queue.length}</div><div class="dc-k">Ждут заполнения сегодня</div><div class="dc-extra">свободно ${free.length}${other.length?` · за прошлые дни: ${other.length}`:''}</div></div></div>
      <div class="dash-card"><div class="dc-ic">✋</div><div><div class="dc-v">${mine.length}</div><div class="dc-k">У меня в работе</div></div></div>
      <div class="dash-card"><div class="dc-ic">⏱</div><div><div class="dc-v">${FILL_NORM_SEC} сек</div><div class="dc-k">Норма на заказ</div><div class="dc-extra">захват снимается через ${FILL_CLAIM_MIN} мин</div></div></div>
    </div>
    ${mine.length ? `<div class="panel">
      <div class="panel-head"><h2>У меня в работе</h2><span class="count">${mine.length}</span></div>
      <div class="table-scroll"><table class="resp-table"><thead><tr><th>Заказ</th><th>Партнёр</th><th>Взят</th><th></th></tr></thead><tbody>
        ${mine.map(o => `<tr>
          <td data-label="Заказ"><strong style="font-family:'Fraunces',serif">${esc(o.code||'')}</strong></td>
          <td data-label="Партнёр">${esc(o.sender || partnerName(o.partner_id) || '—')}</td>
          <td data-label="Взят">${esc(fillAgo(o.claimed_at))}</td>
          <td data-label=""><button class="btn sm" data-fillopen="${o.id}">Заполнить</button>
            <button class="btn sm ghost" data-fillrel="${o.id}">Вернуть</button></td>
        </tr>`).join('')}
      </tbody></table></div></div>` : ''}
    ${isAdmin() ? `<div class="panel">
      <div class="panel-head"><h2>Менеджеры заказов</h2>
        <div class="filters-row" style="margin:0;gap:8px;display:flex;align-items:center;flex-wrap:wrap">
          <button class="btn sm ghost" id="fillReload" title="Подтянуть свежие заказы — фото могли приложить только что">🔄 Обновить</button>
          <button class="btn ghost sm" id="fillToday">Сегодня</button>
          <input type="date" id="fillFromInp" value="${esc(fillFrom || localToday())}" max="${esc(localToday())}" title="С какого дня">
          <input type="date" id="fillToInp" value="${esc(fillTo || fillFrom || localToday())}" max="${esc(localToday())}" title="По какой день">
        </div>
      </div>
      <div class="table-scroll"><table class="resp-table"><thead><tr>
        <th>Менеджер</th><th class="num">Заполнил</th><th class="num">Среднее время</th><th class="num">Сверх нормы</th><th class="num">Сейчас в работе</th>
      </tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr>
          <td data-label="Менеджер"><strong>${esc(r.name)}</strong></td>
          <td data-label="Заполнил" class="num"><b>${r.count}</b></td>
          <td data-label="Среднее время" class="num">${esc(fillFmtSec(r.avg))}</td>
          <td data-label="Сверх нормы" class="num">${r.slow ? `<span style="color:var(--rust)">${r.slow}</span>` : '—'}</td>
          <td data-label="Сейчас в работе" class="num">${r.inWork || '—'}</td>
        </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">Пока никто ничего не заполнил</td></tr>'}
      </tbody></table></div>
    </div>` : ''}
    <div class="fill-take">
      <button class="btn" id="fillNext" ${free.length||mine.length?'':'disabled'}>Взять следующий</button>
      <span>${free.length ? `свободных заказов: ${free.length}` : 'свободных заказов нет'}</span>
      ${isAdmin() ? '' : `<button class="btn sm ghost" id="fillReload" title="Подтянуть свежие заказы — фото могли приложить только что">🔄 Обновить</button>`}
    </div>`;
  const nx = $('fillNext'); if(nx) nx.onclick = () => fillTakeNext();
  const rl = $('fillReload'); if(rl) rl.onclick = () => fillRefresh();
  $('main').querySelectorAll('[data-fillopen]').forEach(b => b.onclick = () => orderModal(b.dataset.fillopen));
  $('main').querySelectorAll('[data-fillrel]').forEach(b => b.onclick = () => fillRelease(b.dataset.fillrel));
  const ft = $('fillToday'); if(ft) ft.onclick = () => { fillFrom = ''; fillTo = ''; renderFilling(); };
  const fi = $('fillFromInp'); if(fi) fi.onchange = () => {
    fillFrom = fi.value || '';
    // «по» не может быть раньше «с» — иначе период пустой и таблица молча пустеет
    if(fillTo && fillFrom && fillTo < fillFrom) fillTo = fillFrom;
    renderFilling();
  };
  const ti = $('fillToInp'); if(ti) ti.onchange = () => {
    fillTo = ti.value || '';
    if(fillTo && fillFrom && fillTo < fillFrom) fillFrom = fillTo;
    renderFilling();
  };
}
