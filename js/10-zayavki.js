
/* ================= МОДУЛЬ: ЗАЯВКИ НА ЗАБОР ================= */
// локальная сегодняшняя дата YYYY-MM-DD (с учётом часового пояса, без сдвига в UTC)
function localToday(){const d=new Date();const off=d.getTimezoneOffset();return new Date(d.getTime()-off*60000).toISOString().slice(0,10);}
// дата по умолчанию для новой заявки на забор: после 18:00 предлагаем уже завтрашний день
function defaultPickupDate(){
  const d=new Date();
  if(d.getHours()>=18)d.setDate(d.getDate()+1);
  const off=d.getTimezoneOffset();
  return new Date(d.getTime()-off*60000).toISOString().slice(0,10);
}
let pf={q:'',city:'',courier:'',sales:'',processor:'',status:'',dateFrom:localToday(),dateTo:localToday(),qr:false};
let pickupsPage=1; // текущая страница пагинации заявок
let pickupsPerPage=50; // заявок на страницу
// мобильный режим: вместо пагинации — «Показать ещё»
const isMobileView=()=>window.matchMedia('(max-width:760px)').matches;
const MOBILE_STEP=20; // сколько подгружать за раз на мобиле
let pickupsMobileLimit=MOBILE_STEP; // сколько заявок показано на мобиле
let ordersMobileLimit=MOBILE_STEP;  // сколько заказов показано на мобиле

function visiblePickups(){
  if(isCourier()){
    const ids=myPickupCourierIds();
    const today=localToday(); // локальная дата (как у остальных фильтров), а не UTC — иначе вечером/ночью могло разъезжаться
    return S.pickups.filter(p=>ids.includes(p.courier_id) && (p.pickup_date||'').slice(0,10)===today);
  }
  return S.pickups;
}
function renderPickups(){
  if((!S.pickups||!S.pickups.length)&&S._heavyLoading&&!S._heavyLoaded){
    $('main').innerHTML='<div class="page-head"><div><h1>Заявки на забор</h1></div></div><div class="loading" style="padding:60px">Загружаем заявки…</div>';
    return;
  }
  pickupsPage=1; // при полной перерисовке начинаем с первой страницы
  const list=filteredPickups();
  const totalOrders=list.reduce((s,p)=>s+(+p.orders||0),0);
  const today=new Date().toISOString().slice(0,10);
  // «Собрано»: статус заявки содержит забран/собран/готов
  const collectedCount=list.filter(p=>isCollectedStatus(p.status_id)).length;
  const head=isCourier()?'Мои заборы':'Заявки на забор';
  $('main').innerHTML=`
    <div class="page-head"><div><h1>${head}</h1><p>Карточки забора посылок из магазинов-партнёров</p></div>
      <div class="head-actions">
        ${(typeof Notification!=='undefined'&&Notification.permission==='default')?'<button class="btn ghost" id="pkNotifyEnable">🔔 Включить уведомления</button>':''}
        
        ${(can('pickups','create')&&!isCourier())?`<button class="btn primary" id="newPickup">＋ Создать карточку забора</button>`:''}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-ic">${ICONS.pickups}</div><div class="stat-body"><div class="k">Собрано заявок</div><div class="v">${collectedCount}<small> / ${list.length}</small></div></div></div>
      <div class="stat"><div class="stat-ic">${ICONS.orders}</div><div class="stat-body"><div class="k">Собрано заказов</div><div class="v">${totalOrders}</div></div></div>
      <div class="stat"><div class="stat-ic">${ICONS.today}</div><div class="stat-body"><div class="k">Сегодня</div><div class="v">${list.filter(p=>p.pickup_date===today).length}</div></div></div>
      ${!isCourier()?`<div class="stat ${pf.qr?'stat-active':''}" id="pkQrStat" style="cursor:pointer" title="Показать только заявки, пришедшие от партнёров"><div class="stat-ic">${ICONS.handshake}</div><div class="stat-body"><div class="k">Заявки по QR</div><div class="v">${list.filter(p=>p.partner_id).length}</div></div></div>`:''}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Карточки забора</h2><span class="count" id="pickupsCount">${list.length}</span></div>
      <div class="filters">
        <input class="search" id="pfq" placeholder="Поиск: наименование, адрес, номер…" value="${esc(pf.q)}">
        ${isStaff()?`<select id="pfcity"><option value="">Все города</option>${S.cities.filter(c=>/алмат|астан|нур-?султан/i.test(c.name||'')).map(c=>`<option value="${c.id}" ${pf.city===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`:''}
        ${isStaff()?`<select id="pfcourier"><option value="">Все курьеры</option>${S.couriers.map(c=>`<option value="${c.id}" ${pf.courier===c.id?'selected':''}>${esc(c.fio)}</option>`).join('')}</select>`:''}
        <select id="pfstatus"><option value="">Все статусы</option>${S.statuses.map(s=>`<option value="${s.id}" ${pf.status===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
        ${isStaff()?`<label class="date-field"><span>Дата с</span><input type="date" id="pfdatefrom" value="${esc(pf.dateFrom)}"></label>
        <label class="date-field"><span>Дата по</span><input type="date" id="pfdateto" value="${esc(pf.dateTo)}"></label>
        <button class="btn sm" id="pftoday" style="align-self:flex-end">Сегодня</button>
        <button class="btn ghost sm" id="pfdateclear" style="align-self:flex-end">Все даты</button>`:''}
      </div>
      <div id="pickupTable"></div>
    </div>`;
  if($('newPickup'))$('newPickup').onclick=()=>pickupModal();
  if($('pkQrStat'))$('pkQrStat').onclick=()=>{pf.qr=!pf.qr;pickupsPage=1;renderPickups();};
  if($('pkRoute'))$('pkRoute').onclick=buildCourierRoute;
  if($('pkNotifyEnable'))$('pkNotifyEnable').onclick=async()=>{
    try{
      const perm=await Notification.requestPermission();
      if(perm==='granted'){toast('Уведомления включены — теперь будут приходить даже когда вкладка свёрнута');renderPickups();}
      else toast('Уведомления не разрешены в браузере');
    }catch(e){toast('Не удалось запросить разрешение');}
  };
  $('pfq').oninput=e=>{pf.q=e.target.value;drawPickupsReset();};
  if($('pfcity'))$('pfcity').onchange=e=>{pf.city=e.target.value;drawPickupsReset();};
  if($('pfcourier'))$('pfcourier').onchange=e=>{pf.courier=e.target.value;drawPickupsReset();};
  $('pfstatus').onchange=e=>{pf.status=e.target.value;drawPickupsReset();};
  if($('pfdatefrom'))$('pfdatefrom').onchange=e=>{pf.dateFrom=e.target.value;renderPickups();};
  if($('pfdateto'))$('pfdateto').onchange=e=>{pf.dateTo=e.target.value;renderPickups();};
  if($('pftoday'))$('pftoday').onclick=()=>{const t=localToday();pf.dateFrom=t;pf.dateTo=t;renderPickups();};
  if($('pfdateclear'))$('pfdateclear').onclick=()=>{pf.dateFrom='';pf.dateTo='';renderPickups();};
  drawPickups();
}
let _courierRouteOrder=null; // порядок id заявок по маршруту (ближайшая первая) или null, если не построен
let _courierRouteDist={}; // id заявки → расстояние в км от курьера (для показа на карточке)
// расстояние между двумя точками по прямой (формула гаверсинусов), в километрах
function haversineKm(lat1,lon1,lat2,lon2){
  const R=6371,toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
// определяем координаты адреса через бесплатный геокодер OpenStreetMap (без ключей/оплаты) —
// используется только когда координат ещё нет и они запрашиваются заранее в базе
async function geocodeAddress(address,cityNm){
  const q=encodeURIComponent(`${address}, ${cityNm||''}, Казахстан`);
  const res=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`);
  const data=await res.json();
  if(data&&data[0])return {lat:parseFloat(data[0].lat),lng:parseFloat(data[0].lon)};
  return null;
}
async function buildCourierRoute(){
  const btn=$('pkRoute');
  if(!navigator.geolocation){toast('Геолокация не поддерживается этим браузером');return;}
  if(btn){btn.disabled=true;btn.textContent='📍 Определяем ваше местоположение…';}
  navigator.geolocation.getCurrentPosition(async pos=>{
    const myLat=pos.coords.latitude,myLng=pos.coords.longitude;
    const list=filteredPickups(); // текущий видимый список (уже без учёта старого маршрута)
    if(btn)btn.textContent='📍 Определяем адреса…';
    // на каждый адрес без координат — геокодируем по одному (уважаем лимит бесплатного сервиса)
    for(const p of list){
      if(p.lat!=null&&p.lng!=null)continue;
      if(!p.address){continue;}
      try{
        const coords=await geocodeAddress(p.address,cityName(p.city_id));
        if(coords){
          p.lat=coords.lat;p.lng=coords.lng;
          dbUpdate('pickups',p.id,{lat:coords.lat,lng:coords.lng}); // сохраняем в фоне, не ждём — в следующий раз геокодировать не придётся
        }
        await new Promise(r=>setTimeout(r,1100)); // не чаще 1 запроса в секунду — таковы правила бесплатного сервиса
      }catch(e){console.error('geocode',p.address,e);}
    }
    const withCoords=list.filter(p=>p.lat!=null&&p.lng!=null);
    const noCoords=list.filter(p=>p.lat==null||p.lng==null);
    withCoords.forEach(p=>{_courierRouteDist[p.id]=haversineKm(myLat,myLng,p.lat,p.lng);});
    withCoords.sort((a,b)=>_courierRouteDist[a.id]-_courierRouteDist[b.id]);
    _courierRouteOrder=[...withCoords.map(p=>p.id),...noCoords.map(p=>p.id)];
    if(btn){btn.disabled=false;btn.textContent='🧭 Построить маршрут';}
    if(noCoords.length)toast(`Маршрут построен · не удалось определить адрес у ${noCoords.length} заявок — они внизу списка`);
    else toast('Маршрут построен — заявки отсортированы по расстоянию от вас');
    renderPickups();
  },err=>{
    if(btn){btn.disabled=false;btn.textContent='🧭 Построить маршрут';}
    toast('Не удалось определить местоположение: '+(err&&err.message||'разрешите доступ к геолокации'));
  },{enableHighAccuracy:true,timeout:15000});
}
function filteredPickups(){
  const q=pf.q.toLowerCase().trim();
  const rows=visiblePickups().filter(p=>{
    if(pf.city&&p.city_id!==pf.city)return false;
    if(pf.courier&&p.courier_id!==pf.courier)return false;
    if(pf.status&&p.status_id!==pf.status)return false;
    if(pf.qr&&!p.partner_id)return false;
    const pd=(p.pickup_date||'').slice(0,10);
    if(pf.dateFrom&&(!pd||pd<pf.dateFrom))return false;
    if(pf.dateTo&&(!pd||pd>pf.dateTo))return false;
    if(q){const hay=[p.name,phoneDisplay(p.phone),cityName(p.city_id),districtName(p.district_id),courierName(p.courier_id),p.address].join(' ').toLowerCase();if(!hay.includes(q))return false;}
    return true;
  });
  // если курьер построил маршрут по близости — сортируем строго по нему (ближайшее сверху)
  if(isCourier()&&_courierRouteOrder){
    return rows.sort((a,b)=>{
      const ia=_courierRouteOrder.indexOf(a.id),ib=_courierRouteOrder.indexOf(b.id);
      if(ia===-1&&ib===-1)return 0;
      if(ia===-1)return 1; // без координат — в конец
      if(ib===-1)return -1;
      return ia-ib;
    });
  }
  return rows.sort((a,b)=>{
    // заявки от партнёра (пришли через кабинет) — всегда первыми, чтобы не пропустить и успеть назначить курьера
    const pa=a.partner_id?1:0,pb=b.partner_id?1:0;
    if(pa!==pb)return pb-pa;
    return (b.created_at||b.pickup_date||'').localeCompare(a.created_at||a.pickup_date||'');
  });
}
function drawPickups(){
  const el=$('pickupTable');const allRows=filteredPickups();
  // обновляем счётчик рядом с «Карточки забора» (отфильтрованное кол-во)
  {const cnt=$('pickupsCount');if(cnt)cnt.textContent=allRows.length;}
  removePickupsPager();
  if(!allRows.length){el.innerHTML=`<div class="empty"><div class="big">Пока нет карточек</div>${isStaff()?'Нажмите «Создать карточку забора».':'Вам пока не назначены заборы.'}</div>`;return;}
  if(isCourier()){drawCourierPickupCards(el,allRows);return;}
  const staff=isStaff();
  const mobile=isMobileView();
  // ── ПАГИНАЦИЯ: десктоп — постранично; мобила — «Показать ещё» ──
  let rows,startIdx,totalPages;
  if(mobile){
    if(pickupsMobileLimit>allRows.length)pickupsMobileLimit=Math.max(MOBILE_STEP,allRows.length);
    rows=allRows.slice(0,pickupsMobileLimit);
    startIdx=0;totalPages=1;
  }else{
    totalPages=Math.max(1,Math.ceil(allRows.length/pickupsPerPage));
    if(pickupsPage>totalPages)pickupsPage=totalPages;
    if(pickupsPage<1)pickupsPage=1;
    startIdx=(pickupsPage-1)*pickupsPerPage;
    rows=allRows.slice(startIdx,startIdx+pickupsPerPage);
  }
  el.innerHTML=`<div class="table-scroll"><table class="resp-table"><thead><tr>
    <th>Дата</th><th>Город</th><th>Наименование</th><th>Адрес</th><th>Номер</th><th>Район</th>
    ${staff?'<th>Курьер</th>':''}<th>Заказов</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows.map(p=>`<tr data-prow="${p.id}" style="cursor:pointer" class="${p.partner_id?'pickup-row-qr':''}" title="${p.partner_id?'Пришла от партнёра через кабинет (QR)':''}">
      <td data-label="Дата">${esc(fmtDate(p.pickup_date))}${p.created_at?`<small class="cell-time">создана ${esc(fmtDateTime(p.created_at))}</small>`:''}</td>
      <td data-label="Город">${cityPill(p.city_id)}</td>
      <td data-label="Наименование"><strong>${esc(p.name)}</strong></td>
      <td data-label="Адрес">${esc(p.address)||'—'}</td>
      <td data-label="Номер">${phoneLink(p.phone)}</td>
      <td data-label="Район">${esc(districtName(p.district_id))}</td>
      ${staff?`<td data-label="Курьер">${p.courier_id?`<span class="pill moss">${esc(courierName(p.courier_id))}</span>`:'<span style="color:var(--muted)">не назначен</span>'}</td>`:''}
      <td data-label="Заказов">${(can('pickups','edit')||isCourierBase())?`<input type="number" min="0" class="qty-edit" data-pqty="${p.id}" value="${p.orders?esc(p.orders):''}" placeholder="—">`:`<span class="qty">${esc(p.orders||0)}</span>`}</td>
      <td data-label="Статус"><select class="status-pick" data-pstatus="${p.id}" style="border-color:${(statusObj(p.status_id)||{}).color||'var(--line)'}">
        <option value="">— нет —</option>${S.statuses.map(s=>`<option value="${s.id}" ${p.status_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
        <div class="status-time">${p.status_at?('изм.: '+fmtDateTime(p.status_at)):''} ${(p.status_history&&p.status_history.length)?`· <button class="link-btn" data-phist="${p.id}">история</button>`:''}</div></td>
      <td data-label="" class="cell-actions"><div class="row-actions">
        ${can('orders','create')?`<button class="btn sm primary" data-pgen="${p.id}">Заказы${ordersCountForPickup(p.id)?` (${ordersCountForPickup(p.id)}/${p.orders||0})`:''}</button>`:''}
        ${can('pickups','edit')?`<button class="btn sm ghost" data-pedit="${p.id}">Изменить</button>`:`<button class="btn sm ghost" data-pview="${p.id}">Открыть</button>`}
        ${can('pickups','delete')?`<button class="btn sm danger" data-pdel="${p.id}">Удалить</button>`:''}
      </div></td></tr>`).join('')}</tbody></table></div>`;
  el.querySelectorAll('[data-pedit]').forEach(b=>b.onclick=()=>pickupModal(b.dataset.pedit));
  el.querySelectorAll('[data-pview]').forEach(b=>b.onclick=()=>pickupModal(b.dataset.pview,true));
  // мобила: тап по строке (не по кнопке/полю) сворачивает/разворачивает карточку
  el.querySelectorAll('[data-prow]').forEach(tr=>tr.onclick=e=>{
    if(!isMobileView())return;
    if(e.target.closest('button,select,input,a,.row-actions'))return;
    tr.classList.toggle('open');
  });
  // двойной клик по строке открывает заявку (как «Изменить», либо просмотр)
  el.querySelectorAll('[data-prow]').forEach(tr=>tr.ondblclick=e=>{
    if(e.target.closest('button,select,input,a'))return;
    pickupModal(tr.dataset.prow,!can('pickups','edit'));
  });
  el.querySelectorAll('[data-pdel]').forEach(b=>b.onclick=()=>delPickup(b.dataset.pdel));
  el.querySelectorAll('[data-pgen]').forEach(b=>b.onclick=()=>{
    const p=S.pickups.find(x=>x.id===b.dataset.pgen);if(!p)return;
    pickupOrdersModal(p.id);
  });
  el.querySelectorAll('[data-phist]').forEach(b=>b.onclick=()=>showPickupHistory(b.dataset.phist));
  el.querySelectorAll('[data-pstatus]').forEach(sel=>sel.onchange=()=>setPickupStatus(sel.dataset.pstatus,sel.value));
  el.querySelectorAll('[data-pqty]').forEach(inp=>{
    const commit=async()=>{const p=S.pickups.find(x=>x.id===inp.dataset.pqty);if(!p)return;
      const v=Math.max(0,parseInt(inp.value||'0',10)||0);if(p.orders===v)return;
      await dbUpdate('pickups',p.id,{orders:v});p.orders=v;toast('Кол-во обновлено');};
    inp.onblur=commit;inp.onkeydown=e=>{if(e.key==='Enter')inp.blur();};
  });
  if(mobile){
    // кнопка «Показать ещё» под списком (не плавающая)
    if(rows.length<allRows.length){
      const more=document.createElement('button');
      more.className='btn ghost show-more';
      more.textContent=`Показать ещё (${allRows.length-rows.length})`;
      more.onclick=()=>{pickupsMobileLimit+=MOBILE_STEP;drawPickups();};
      el.appendChild(more);
    }
    el.insertAdjacentHTML('beforeend',`<div class="list-count">Показано ${rows.length} из ${allRows.length}</div>`);
  }else{
    renderPickupsPager(allRows.length,totalPages,startIdx,rows.length);
  }
}
// сброс пагинации заявок на первую страницу (при смене фильтров)
function drawPickupsReset(){pickupsPage=1;pickupsMobileLimit=MOBILE_STEP;drawPickups();}
// плавающая панель пагинации заявок
function removePickupsPager(){const ex=$('pickupsPager');if(ex)ex.remove();const m=$('main');if(m&&!$('ordersPager')&&!$('inboundPager')&&!$('whProdPager'))m.classList.remove('has-pager');}
function renderPickupsPager(total,totalPages,startIdx,shownCount){
  removePickupsPager();
  if(!total)return;
  const from=startIdx+1, to=startIdx+shownCount;
  const bar=document.createElement('div');
  bar.id='pickupsPager';bar.className='orders-pager';
  {const m=$('main');if(m)m.classList.add('has-pager');}
  bar.innerHTML=`
    <button class="op-btn" id="ppRefreshBtn" title="Подтянуть свежие данные">🔄</button>
    <div class="op-info">Показаны <b>${from}–${to}</b> из <b>${total}</b></div>
    <div class="op-perpage">
      <span>На странице:</span>
      <div class="op-pp-wrap">
        <button class="op-btn op-pp-btn" id="ppPerPageBtn">${pickupsPerPage} ▾</button>
        <div class="op-pp-menu" id="ppPerPageMenu" style="display:none">
          ${ORDERS_PAGE_SIZES.map(s=>`<button class="op-pp-item ${s===pickupsPerPage?'active':''}" data-ppp="${s}">${s}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="op-nav">
      <button class="op-btn" data-ppage="first" ${pickupsPage<=1?'disabled':''} title="В начало">«</button>
      <button class="op-btn" data-ppage="prev" ${pickupsPage<=1?'disabled':''}>‹ Назад</button>
      <span class="op-page">Стр. ${pickupsPage} / ${totalPages}</span>
      <button class="op-btn" data-ppage="next" ${pickupsPage>=totalPages?'disabled':''}>Вперёд ›</button>
      <button class="op-btn" data-ppage="last" ${pickupsPage>=totalPages?'disabled':''} title="В конец">»</button>
    </div>`;
  document.body.appendChild(bar);
  const ppRefreshBtn=bar.querySelector('#ppRefreshBtn');
  if(ppRefreshBtn)ppRefreshBtn.onclick=async()=>{
    ppRefreshBtn.disabled=true;ppRefreshBtn.textContent='…';
    try{await refreshForTab(S.tab);drawPickups();toast('Обновлено');}
    finally{if(ppRefreshBtn){ppRefreshBtn.disabled=false;ppRefreshBtn.textContent='🔄';}}
  };
  const ppBtn=bar.querySelector('#ppPerPageBtn'), ppMenu=bar.querySelector('#ppPerPageMenu');
  if(ppBtn)ppBtn.onclick=e=>{e.stopPropagation();ppMenu.style.display=ppMenu.style.display==='none'?'flex':'none';};
  bar.querySelectorAll('[data-ppp]').forEach(b=>b.onclick=()=>{
    pickupsPerPage=parseInt(b.dataset.ppp,10)||50;pickupsPage=1;drawPickups();
    const t=$('pickupTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('click',function closePPP(ev){
    if(ppMenu&&!ppMenu.contains(ev.target)&&ev.target!==ppBtn){ppMenu.style.display='none';}
  },{once:true});
  bar.querySelectorAll('[data-ppage]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.ppage;
    if(a==='first')pickupsPage=1;
    else if(a==='prev')pickupsPage=Math.max(1,pickupsPage-1);
    else if(a==='next')pickupsPage=Math.min(totalPages,pickupsPage+1);
    else if(a==='last')pickupsPage=totalPages;
    drawPickups();
    const t=$('pickupTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
}
/* Компактные карточки заявок на забор для курьера-заборщика: свёрнуто — наименование/адрес/телефон/статус */
function drawCourierPickupCards(el,rows){
  el.innerHTML=`<div class="cour-cards">${rows.map(p=>{
    const ph=phoneStored(p.phone);
    return `<div class="cour-card" data-card="${p.id}">
      <div class="cc-head" data-toggle="${p.id}">
        <div class="cc-main">
          <div class="cc-client">${esc(p.name)||'Без названия'}${_courierRouteDist[p.id]!=null?` <span class="cc-dist">📍 ${_courierRouteDist[p.id]<1?Math.round(_courierRouteDist[p.id]*1000)+' м':_courierRouteDist[p.id].toFixed(1)+' км'}</span>`:''}</div>
          <div class="cc-addr-row">${address2gis(p.address,cityName(p.city_id),p.name)}</div>
          ${ph?`<div class="cc-phone-row">${phoneLink(p.phone)}</div>`:''}
          ${(p.give_packets||p.give_invoices)?`<div class="cc-give">${p.give_packets?'<span class="cc-give-tag">📦 Пакеты для партнёра</span>':''}${p.give_invoices?'<span class="cc-give-tag">📄 Накладные для партнёра</span>':''}</div>`:''}
        </div>
        <div class="cc-right"><span class="cc-chev">▾</span></div>
      </div>
      <div class="cc-statusrow">
        <select class="status-pick" data-pstatus="${p.id}" style="border-color:${(statusObj(p.status_id)||{}).color||'var(--line)'}">
          <option value="">— нет —</option>${S.statuses.map(s=>`<option value="${s.id}" ${p.status_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
      </div>
      <div class="cc-body">
        ${!isCourier()?`<div class="cc-row"><span class="lbl">Дата</span><span class="vl">${esc(fmtDate(p.pickup_date))}${p.created_at?` · создана ${esc(fmtDateTime(p.created_at))}`:''}</span></div>
        <div class="cc-row"><span class="lbl">Город</span><span class="vl">${esc(cityName(p.city_id))}</span></div>
        <div class="cc-row"><span class="lbl">Район</span><span class="vl">${esc(districtName(p.district_id))}</span></div>`:''}
        <div class="cc-row"><span class="lbl">Собрано заказов</span><span class="vl"><input type="number" min="0" class="qty-edit" data-pqty="${p.id}" value="${p.orders?esc(p.orders):''}" placeholder="—"></span></div>
        ${(!isCourier()&&p.status_history&&p.status_history.length)?`<div class="cc-row"><span class="lbl">Статус изменён</span><span class="vl">${p.status_at?esc(fmtDateTime(p.status_at)):'—'} · <button class="link-btn" data-phist="${p.id}">история</button></span></div>`:''}
        <div class="cc-actions">
          <button class="btn sm primary" data-pgen="${p.id}">Заказы и фото${ordersCountForPickup(p.id)?` (${ordersCountForPickup(p.id)}/${p.orders||0})`:p.orders?` (0/${p.orders})`:''}</button>
          ${!isCourier()?`<button class="btn sm ghost" data-pview="${p.id}">Открыть</button>`:''}
        </div>
      </div>
    </div>`;}).join('')}</div>`;
  el.querySelectorAll('[data-toggle]').forEach(h=>h.onclick=e=>{
    if(e.target.closest('a'))return;
    h.closest('.cour-card').classList.toggle('open');
  });
  el.querySelectorAll('[data-gis]').forEach(a=>a.onclick=e=>{e.preventDefault();e.stopPropagation();open2gis(a.dataset.gis);});
  el.querySelectorAll('[data-pview]').forEach(b=>b.onclick=e=>{e.stopPropagation();pickupModal(b.dataset.pview,true);});
  el.querySelectorAll('[data-pgen]').forEach(b=>b.onclick=e=>{e.stopPropagation();
    const p=S.pickups.find(x=>x.id===b.dataset.pgen);if(!p)return;
    pickupOrdersModal(p.id);});
  el.querySelectorAll('[data-phist]').forEach(b=>b.onclick=e=>{e.stopPropagation();showPickupHistory(b.dataset.phist);});
  el.querySelectorAll('[data-pstatus]').forEach(sel=>{
    sel.onclick=e=>e.stopPropagation();
    sel.onchange=()=>{setPickupStatus(sel.dataset.pstatus,sel.value);};
  });
  el.querySelectorAll('[data-pqty]').forEach(inp=>{
    inp.onclick=e=>e.stopPropagation();
    const commit=async()=>{const p=S.pickups.find(x=>x.id===inp.dataset.pqty);if(!p)return;
      const v=Math.max(0,parseInt(inp.value||'0',10)||0);if(p.orders===v)return;
      await dbUpdate('pickups',p.id,{orders:v});p.orders=v;toast('Кол-во обновлено');};
    inp.onblur=commit;inp.onkeydown=e=>{if(e.key==='Enter')inp.blur();};
  });
}
async function setPickupStatus(id,statusId){
  const p=S.pickups.find(x=>x.id===id);if(!p||p.status_id===statusId)return;
  const at=new Date().toISOString();
  const hist=Array.isArray(p.status_history)?p.status_history.slice():[];
  hist.push({statusId,at});
  const oldS=p.status_id;
  const upd=await dbUpdate('pickups',id,{status_id:statusId,status_at:at,status_history:hist});
  if(upd){Object.assign(p,upd);
    logAction('status','pickups',{entity_id:p.id,entity_label:pickupLabel(p),changes:[{field:'status_id',label:'Статус',old:logFieldValue('status_id',oldS),new:logFieldValue('status_id',statusId)}]});
    toast('Статус обновлён');drawPickups();updateCollectedStat();}
}
// точечно обновляет число в плашке «Собрано заявок» без полной перерисовки
function updateCollectedStat(){
  const list=filteredPickups();
  const collected=list.filter(p=>isCollectedStatus(p.status_id)).length;
  const stats=document.querySelectorAll('.stats .stat');
  if(stats[0]){const v=stats[0].querySelector('.v');if(v)v.innerHTML=`${collected}<small> / ${list.length}</small>`;}
}

/* ---------- ФОТО ЗАЯВКИ: рендер блока и обработчики ---------- */
const pickupPhotos=p=>Array.isArray(p.photos)?p.photos:[];
// просмотр фото на весь экран
function viewPhoto(f){
  // f — путь в хранилище. Сначала пробуем ссылку из кеша: она уже есть, потому что
  // миниатюру только что показали, и тогда вкладка открывается прямо по клику —
  // если открыть её после ожидания, браузер посчитает это всплывающим окном и заблокирует.
  const ready=cachedPhotoUrl(f);
  if(ready){window.open(ready,'_blank','noopener,noreferrer');return;}
  signedPhotoUrl(f).then(u=>{
    if(u)window.open(u,'_blank','noopener,noreferrer');
    else toast('Не удалось открыть фото');
  });
}
// увеличение фото поверх текущего окна (без новой вкладки), закрытие по клику/Esc
function zoomPhoto(f){
  const ready=cachedPhotoUrl(f);
  if(!ready){signedPhotoUrl(f).then(u=>{if(u)_zoomPhotoWith(u);else toast('Не удалось открыть фото');});return;}
  _zoomPhotoWith(ready);
}
function _zoomPhotoWith(url){
  const ov=document.createElement('div');ov.className='photo-zoom-ov';
  ov.innerHTML=`<button class="pz-x" aria-label="Закрыть">×</button><img src="${esc(url)}" alt="">`;
  const close=()=>{ov.remove();document.removeEventListener('keydown',onKey);};
  const onKey=e=>{if(e.key==='Escape'){e.preventDefault();close();}};
  ov.addEventListener('click',e=>{e.stopPropagation();close();});
  document.addEventListener('keydown',onKey);
  document.body.appendChild(ov);
}
// HTML блока фото для заявки; canEdit — можно ли добавлять/удалять
function photoBlockHtml(p,canEdit){
  const ph=pickupPhotos(p);
  const thumbs=ph.map((f,i)=>`<div class="photo-thumb">
    <img data-ph="${esc(photoPath(f))}" data-pview-photo="${esc(photoPath(f))}" loading="lazy" decoding="async">
    ${canEdit?`<button class="del" data-pdelphoto="${p.id}" data-idx="${i}" title="Удалить">×</button>`:''}
  </div>`).join('');
  const adder=canEdit?`<label class="photo-add">📷 Снять фото
    <input type="file" accept="image/*" capture="environment" multiple data-paddphoto="${p.id}" style="display:none">
  </label><label class="photo-add">🖼️ Из галереи
    <input type="file" accept="image/*" multiple data-paddphoto="${p.id}" style="display:none">
  </label>`:'';
  const empty=(!ph.length&&!canEdit)?'<div class="photo-empty">Фотографий нет</div>':'';
  return `<div class="photo-grid">${thumbs}${adder}</div>${empty}`;
}
// блок фото самого заказа (редактируемый, если canEdit)
function orderPhotoFieldHtml(o,canEdit){
  if(!o||!o.id)return ''; // фото только у уже созданного заказа
  return `<div class="field full"><label>Фотографии заказа</label><div id="o_photos">${photoBlockHtml(o,canEdit)}</div></div>`;
}
// крупное превью фото для карточки заказа: большое первое фото + миниатюры + кнопки
function orderBigPhotoInner(o,canEdit){
  const ph=pickupPhotos(o);
  const big=ph.length
    ? `<div class="obig-wrap"><img class="obig-photo" id="obigMain" data-ph="${esc(photoPath(ph[0]))}" data-oviewphoto="${esc(photoPath(ph[0]))}" alt=""></div>`
    : `<div class="obig-empty">Фото заказа нет</div>`;
  // подпись: кто загрузил текущее (первое) фото
  const byLine=ph.length?`<div class="obig-by" id="obigBy">${photoByLabel(ph[0])}</div>`:'';
  const rotBtns=ph.length?`<div class="obig-rotate"><button type="button" class="btn sm" id="orotL">↺ Влево</button><button type="button" class="btn sm" id="orotR">↻ Вправо</button></div>`:'';
  const thumbs=ph.length>1?`<div class="obig-thumbs">${ph.map((f,i)=>`<img data-ph="${esc(photoPath(f))}" data-obigthumb="${esc(photoPath(f))}" data-obigby="${esc(photoByLabel(f))}" class="${i===0?'active':''}">`).join('')}</div>`:'';
  const adder=canEdit?`<div class="photo-grid" style="margin-top:10px">
    <label class="photo-add">📷 Снять фото<input type="file" accept="image/*" capture="environment" multiple data-paddphoto="${o.id}" style="display:none"></label>
    <label class="photo-add">🖼️ Из галереи<input type="file" accept="image/*" multiple data-paddphoto="${o.id}" style="display:none"></label>
  </div>`:'';
  const delBtn=(ph.length&&canEdit)?`<button type="button" class="btn sm danger" data-pdelphoto data-idx="0" style="margin-top:8px">Удалить это фото</button>`:'';
  const aiBtn=(ph.length&&canEdit&&isStaff())?`<button type="button" class="btn ai-btn" id="oAiRecognize" style="margin-top:10px;width:100%">🤖 Распознать данные с фото</button><div class="ai-recog-note" id="oAiNote"></div>`:'';
  return `<label>Фотографии заказа</label>${big}${byLine}${rotBtns}${thumbs}${delBtn}${aiBtn}${adder}`;
}
// подпись «загрузил: имя · дата» для фото (только если есть автор)
function photoByLabel(f){
  if(!f||!f.by)return '<span style="color:var(--muted)">автор не указан</span>';
  const when=f.at?(' · '+fmtDate(f.at)):'';
  return `📷 Загрузил: <b>${esc(f.by)}</b>${esc(when)}`;
}
function orderBigPhotoHtml(o,canEdit){
  if(!o||!o.id)return '';
  return `<div class="field full" id="o_photos">${orderBigPhotoInner(o,canEdit)}</div>`;
}
// универсальный блок фото для записи rec в таблице table (по умолчанию pickups)
function bindPhotoBlock(root,rec,redraw,table){
  table=table||'pickups';
  const prefix=(table==='orders'?'order/':'')+rec.id;
  root.querySelectorAll('[data-pview-photo]').forEach(im=>im.onclick=e=>{e.stopPropagation();viewPhoto(im.dataset.pviewPhoto);});
  root.querySelectorAll('[data-paddphoto]').forEach(inp=>inp.onchange=async e=>{
    e.stopPropagation();const files=[...(inp.files||[])];if(!files.length)return;
    toast(`Загрузка фото (${files.length})…`);
    const arr=pickupPhotos(rec).slice();let ok=0,fail=0;
    for(const f of files){const r=await uploadPhoto(prefix,f);if(r){arr.push(r);ok++;}else{fail++;}}
    inp.value='';
    if(!ok){toast(fail?'Не удалось загрузить фото':'Файлы не выбраны');return;}
    const u=await dbUpdate(table,rec.id,{photos:arr});
    if(u){Object.assign(rec,u);toast(fail?`Загружено ${ok}, ошибок ${fail}`:`Добавлено фото: ${ok}`);if(redraw)redraw();}
  });
  root.querySelectorAll('[data-pdelphoto]').forEach(btn=>btn.onclick=async e=>{
    e.stopPropagation();const idx=+btn.dataset.idx;const arr=pickupPhotos(rec).slice();const item=arr[idx];if(!item)return;
    if(!confirm('Удалить это фото?'))return;
    await deletePhoto(item.path);arr.splice(idx,1);
    const u=await dbUpdate(table,rec.id,{photos:arr});
    if(u){Object.assign(rec,u);toast('Фото удалено');if(redraw)redraw();}
  });
}

function showPickupHistory(id){
  const p=S.pickups.find(x=>x.id===id);if(!p)return;
  const hist=(p.status_history||[]).slice().reverse();
  const body=hist.length?`<ul class="hist">${hist.map(h=>{const s=statusObj(h.statusId);const c=s?s.color:'var(--muted)';const n=s?esc(s.name):'Статус снят';
    return `<li><span class="dot" style="background:${c}"></span><div><div style="font-weight:600">${n}</div><div class="when">${fmtDateTime(h.at)}</div></div></li>`;}).join('')}</ul>`
    :`<div class="empty"><div class="big">История пуста</div></div>`;
  showInfo(`История статусов · ${esc(p.name)}`,body);
}
async function delPickup(id){
  const p=S.pickups.find(x=>x.id===id);
  if(!confirm(`Удалить карточку «${p?.name||''}»?`))return;
  if(await dbDelete('pickups',id)){await logAction('delete','pickups',{entity_id:id,entity_label:pickupLabel(p)});S.pickups=S.pickups.filter(x=>x.id!==id);toast('Удалено');renderPickups();}
}
// ── ЧЕРНОВИКИ карточки заявки (несохранённые данные не теряются при закрытии) ──
const pickupDrafts={}; // ключ: id заявки или 'new'
function pickupDraftKey(id){return id||'new';}
// собрать текущие значения формы заявки
function readPickupForm(){
  return {pickup_date:val('m_date'),city_id:val('m_city'),name:val('m_name'),address:val('m_address'),
    phone:phoneVal('m_phone'),district_id:val('m_district'),courier_id:val('m_courier'),
    give_packets:$('m_packets')?$('m_packets').checked:false,
    give_invoices:$('m_invoices')?$('m_invoices').checked:false,
    sales_id:val('m_sales'),processor_id:val('m_proc')};
}
function pickupModal(id,readonly){
  const p=id?S.pickups.find(x=>x.id===id):null;
  const today=defaultPickupDate();
  const base=p||{pickup_date:today,city_id:'',name:'',address:'',phone:'',district_id:'',courier_id:'',orders:'',sales_id:'',processor_id:'',give_packets:false,give_invoices:false,status_id:(S.statuses[0]?S.statuses[0].id:'')};
  const ro=readonly||!can("pickups","edit");
  // если есть несохранённый черновик для этой заявки — подставляем его (только при редактировании)
  const draft=!ro?pickupDrafts[pickupDraftKey(id)]:null;
  const d=draft?Object.assign({},base,draft):base;
  const hasDraft=!!draft;
  const dOpts=cid=>S.districts.filter(x=>!cid||x.city_id===cid);
  const cOpts=cid=>S.couriers.filter(x=>!cid||x.city_id===cid);
  const dis=ro?'disabled':'';
  showModal(id?(ro?'Карточка забора':'Карточка забора'):'Новая карточка забора',`
    ${hasDraft?'<div style="background:#fdf3d6;border:1px solid #e3cf9c;color:#8a5a12;border-radius:10px;padding:9px 12px;margin-bottom:14px;font-size:13px">📝 Восстановлены несохранённые данные. Нажмите «Сохранить», чтобы записать их, или измените.</div>':''}
    <div class="grid2">
      <div class="field"><label>Дата</label><input type="date" id="m_date" value="${esc(d.pickup_date||'')}" ${dis}></div>
      <div class="field"><label>Город</label><select id="m_city" ${dis}><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${d.city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>Наименование (партнёр)</label><input id="m_name" list="plist" value="${esc(d.name)}" ${dis} autocomplete="off"><datalist id="plist">${S.partners.map(pt=>`<option value="${esc(pt.name)}">`).join('')}</datalist></div>
      <div class="field full"><label>Адрес <span style="color:var(--muted);font-weight:400;font-size:11px">(откуда забираем)</span></label><input id="m_address" value="${esc(d.address)}" ${dis}></div>
      <div class="field full" id="m_delivery_addr_field" style="${isFizlicoName(d.name)?'':'display:none'}"><label>Адрес доставки <span style="color:var(--muted);font-weight:400;font-size:11px">(куда везём — подставится в заказы из этой заявки)</span></label><input id="m_delivery_addr" value="${esc(d.delivery_address||'')}" ${dis}></div>
      <div class="field"><label>Номер телефона</label><input id="m_phone" inputmode="numeric" ${dis}></div>
      <div class="field"><label>Район</label><select id="m_district" ${dis}><option value="">—</option>${dOpts(d.city_id).map(x=>`<option value="${x.id}" ${d.district_id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Курьер <span style="color:var(--rust)">*</span></label><select id="m_courier" ${dis}><option value="">— выберите курьера —</option>${cOpts(d.city_id).map(x=>`<option value="${x.id}" ${d.courier_id===x.id?'selected':''}>${esc(x.fio)}</option>`).join('')}</select></div>
      <div class="field"><label>Менеджер по продажам</label><select id="m_sales" ${dis}><option value="">—</option>${S.sales.map(s=>`<option value="${s.id}" ${d.sales_id===s.id?'selected':''}>${esc(s.fio)}</option>`).join('')}</select></div>
      <div class="field"><label>Обработчик</label><select id="m_proc" ${dis}><option value="">—</option>${S.processors.map(s=>`<option value="${s.id}" ${d.processor_id===s.id?'selected':''}>${esc(s.fio)}</option>`).join('')}</select></div>
      <div class="field">
        <label style="margin-bottom:6px">Для партнёра</label>
        <label class="chk-line"><input type="checkbox" id="m_packets" ${d.give_packets?'checked':''} ${dis}> Пакеты для партнёра</label>
        <label class="chk-line"><input type="checkbox" id="m_invoices" ${d.give_invoices?'checked':''} ${dis}> Накладные для партнёра</label>
      </div>
    </div>`,
    ro?null:async()=>{
      const name=val('m_name').trim();if(!name){toast('Укажите наименование');return false;}
      if(!val('m_courier')){toast('Выберите курьера');const cf=$('m_courier');if(cf){cf.focus();cf.style.borderColor='var(--rust)';}return false;}
      const prevStatus=p?(p.status_id||''):'';
      // статус: у новой заявки — «Новый»; у существующей — сохраняем текущий
      const newStatus=p?(p.status_id||defaultPickupStatusId()):defaultPickupStatusId();
      const row={pickup_date:val('m_date')||null,city_id:val('m_city')||null,name,address:val('m_address').trim(),
        delivery_address:$('m_delivery_addr')?(val('m_delivery_addr').trim()||null):null,
        phone:phoneVal('m_phone'),district_id:val('m_district')||null,courier_id:val('m_courier')||null,
        orders:(p?(parseInt(p.orders||'0',10)||0):0),sales_id:val('m_sales')||null,processor_id:val('m_proc')||null,
        give_packets:$('m_packets')?$('m_packets').checked:false,
        give_invoices:$('m_invoices')?$('m_invoices').checked:false,
        status_id:newStatus||null};
      let hist=p&&Array.isArray(p.status_history)?p.status_history.slice():[];
      if(newStatus&&newStatus!==prevStatus){row.status_at=new Date().toISOString();hist.push({statusId:newStatus,at:row.status_at});}
      row.status_history=hist;
      if(id){const before=Object.assign({},p);const u=await dbUpdate('pickups',id,row);if(!u)return false;Object.assign(p,u);
        await logAction('update','pickups',{entity_id:p.id,entity_label:pickupLabel(p),changes:buildChanges(before,p)});}
      else{const u=await dbInsert('pickups',row);if(!u)return false;S.pickups.unshift(u);
        await logAction('create','pickups',{entity_id:u.id,entity_label:pickupLabel(u)});
        // если заявка создалась на дату вне текущего фильтра (например, после 18:00 дата ушла на
        // завтра, а список сейчас показывает только сегодня) — расширяем фильтр, чтобы её сразу увидеть
        const ud=(u.pickup_date||'').slice(0,10);
        if(ud){
          if(pf.dateFrom&&ud<pf.dateFrom)pf.dateFrom=ud;
          if(pf.dateTo&&ud>pf.dateTo)pf.dateTo=ud;
        }
        if(pf.qr&&!u.partner_id)pf.qr=false; // иначе заявка сотрудника не попадёт под фильтр «только от партнёров»
      }
      delete pickupDrafts[pickupDraftKey(id)]; // сохранили — черновик больше не нужен
      toast(id?'Сохранено':'Карточка создана');renderPickups();return true;
    },{readonly:ro,clearBtn:ro?null:(ov)=>{
      // очистить все поля кроме даты
      ['m_name','m_address'].forEach(fid=>{const el=$(fid);if(el)el.value='';});
      ['m_city','m_district','m_courier','m_sales','m_proc'].forEach(fid=>{const el=$(fid);if(el)el.value='';});
      // телефон
      const ph=$('m_phone');if(ph){ph.value='';ph.dataset.phone='';}
      // сбросить подсветку обязательных полей
      const cf=$('m_courier');if(cf)cf.style.borderColor='';
      // очистить черновик
      delete pickupDrafts[pickupDraftKey(id)];
      const nameEl=$('m_name');if(nameEl)nameEl.focus();
      toast('Поля очищены');
    }});
  attachPhone('m_phone',d.phone);
  // если справочник партнёров ещё не успел прогрузиться на момент открытия формы (например, окно
  // открыли сразу после входа) — список поиска остался бы пустым и сам не обновился без перезагрузки
  // страницы. Подстраховка: подгружаем партнёров в фоне и обновляем список поиска на лету.
  if(!S.partners||!S.partners.length){
    dbList('partners',{order:'name'}).then(fresh=>{
      if(fresh&&fresh.length){
        S.partners=fresh;
        const dl=$('plist');if(dl)dl.innerHTML=S.partners.map(pt=>`<option value="${esc(pt.name)}">`).join('');
      }
    }).catch(()=>{});
  }
  if(!ro){
    // автозапоминание: при любом изменении поля пишем черновик (не теряется при закрытии)
    const saveDraft=()=>{pickupDrafts[pickupDraftKey(id)]=readPickupForm();};
    ['m_date','m_city','m_name','m_address','m_phone','m_district','m_courier','m_sales','m_proc'].forEach(fid=>{
      const el=$(fid);if(el){el.addEventListener('input',saveDraft);el.addEventListener('change',saveDraft);}
    });
    const cs=$('m_city');cs.onchange=()=>{const cid=cs.value;
      $('m_district').innerHTML='<option value="">—</option>'+dOpts(cid).map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
      $('m_courier').innerHTML='<option value="">— выберите курьера —</option>'+cOpts(cid).map(x=>`<option value="${x.id}">${esc(x.fio)}</option>`).join('');saveDraft();};
    $('m_name').onchange=e=>{const pt=S.partners.find(x=>x.name===e.target.value);if(pt){
      if(pt.address)$('m_address').value=pt.address;
      if(pt.phone){const el=$('m_phone');el.dataset.phone=phoneStored(pt.phone);el.value=fmt10(phoneStored(pt.phone));}
      if(pt.city_id){cs.value=pt.city_id;cs.onchange();}
      if(pt.district_id)$('m_district').value=pt.district_id;
      if(pt.sales_id)$('m_sales').value=pt.sales_id;
      if(pt.processor_id)$('m_proc').value=pt.processor_id;}
      const deliveryField=$('m_delivery_addr_field');
      if(deliveryField)deliveryField.style.display=isFizlicoName(e.target.value)?'':'none';
      saveDraft();};
    $('m_name').addEventListener('input',e=>{
      const deliveryField=$('m_delivery_addr_field');
      if(deliveryField)deliveryField.style.display=isFizlicoName(e.target.value)?'':'none';
    });
    // на случай, если поле уже что-то содержит при открытии (существующая заявка) — проверяем сразу
    if($('m_delivery_addr_field'))$('m_delivery_addr_field').style.display=isFizlicoName(val('m_name'))?'':'none';
  }
}