/* ================= МОДУЛЬ: ОТПРАВКИ МЕЖГОРОД ================= */
// список типов транспорта
const TRANSPORT_TYPES=['Авиа','Индрайвер','Автобус','Другое'];

// склад отправки текущего пользователя (город из профиля)
function myWarehouseCityId(){return (S.me&&S.me.city_id)||'';}

// id города забора, соответствующего складу (по совпадению названия склада и города)
function warehousePickupCityId(whId){
  const wh=(S.warehouses||[]).find(w=>w.id===whId);
  if(!wh)return null;
  const nm=(wh.name||'').trim().toLowerCase();
  const city=(S.cities||[]).find(c=>(c.name||'').trim().toLowerCase()===nm);
  return city?city.id:null;
}

// заказы, доступные для отправки межгородом:
// курьерская доставка, город получения = cityId, дата забора = date, склад (город забора) = whId, ещё не в отправке
// города, у которых отправка идёт не каждый день, а только по пн/ср/пт/вс — заказы, забор которых
// пришёлся на «пропущенный» день, нужно подтягивать к ближайшему следующему дню отправки:
// вторник → среда, четверг → пятница, суббота → воскресенье. Понедельник отдельно не донорит
// никому — перед ним сразу воскресенье, тоже день отправки, разрыва нет.
const INTERCITY_LIMITED_SCHEDULE_CITIES=['тараз','костанай','петропавловск'];
// по дате ОТПРАВКИ возвращает список дат ЗАБОРА, заказы за которые нужно учитывать —
// саму дату всегда, и день-донор перед ней, если он есть
function intercityRollupDates(dateStr){
  const d=new Date(dateStr+'T00:00:00');
  const dow=d.getDay(); // 0=вс,1=пн,2=вт,3=ср,4=чт,5=пт,6=сб
  const hasDonor=(dow===3)||(dow===5)||(dow===0); // ср←вт, пт←чт, вс←сб
  const dates=[dateStr];
  if(hasDonor){
    const donor=new Date(d);donor.setDate(donor.getDate()-1);
    dates.push(donor.toISOString().slice(0,10));
  }
  return dates;
}
// города, куда со склада Алматы заказы едут НЕ напрямую, а через Астану (сначала едут в Астану,
// это занимает день, и уже оттуда дальше по городам вместе с астанинскими заказами). Поэтому:
//  - при отправке СО СКЛАДА АЛМАТЫ в эти города заказов быть не должно вообще (их забирает Астана)
//  - при отправке СО СКЛАДА АСТАНА в эти города — дополнительно подтягиваются заказы, забранные
//    в Алматы НА ДЕНЬ РАНЬШЕ (успели доехать до Астаны только к этому дню)
const INTERCITY_VIA_ASTANA_CITIES=['усть-каменогорск','семей','костанай','павлодар','петропавловск','караганд','кокшетау','сатпаев','жезк','актобе','уральск','актау','атырау'];
// со склада Алматы отправка идёт напрямую ТОЛЬКО в эти города — весь остальной список городов
// не должен даже появляться в выборе при складе Алматы (едут через Астану транзитом, либо это
// внутригородские, либо просто не обслуживаются напрямую с Алматы)
const INTERCITY_ALMATY_ALLOWED_CITIES=['астана','шымкент','тараз','кызылорда','талдыкорган'];
function ordersForIntercity(cityId,date,whId){
  const whCityId=whId?warehousePickupCityId(whId):null;
  const whCityNm=(whCityId?cityName(whCityId):'').toLowerCase();
  const destNm=(courierCityName(cityId)||'').toLowerCase();
  // отправка города самого в себя не имеет смысла (склад Астана → город получения Астана и т.п.)
  if(whCityNm&&destNm&&whCityNm===destNm)return [];
  const isViaAstana=INTERCITY_VIA_ASTANA_CITIES.some(n=>destNm.includes(n));
  const isAlmatyWh=whCityNm.includes('алматы');
  const isAstanaWh=whCityNm.includes('астана');
  // со склада Алматы — только 5 разрешённых городов, все остальные исключаем целиком
  if(isAlmatyWh&&!INTERCITY_ALMATY_ALLOWED_CITIES.some(n=>destNm.includes(n)))return [];
  const isLimited=INTERCITY_LIMITED_SCHEDULE_CITIES.some(n=>destNm.includes(n));
  const allowedDates=(date&&isLimited)?intercityRollupDates(date):null;
  // для Астаны, отправляющей в один из транзитных городов, вычисляем «вчера» (когда эти заказы
  // должны были быть забраны в Алматы, чтобы успеть доехать до Астаны к сегодняшней отправке)
  let almatyCityId=null,transitPrevDate=null;
  if(isAstanaWh&&isViaAstana&&date){
    const almatyCity=(S.cities||[]).find(c=>(c.name||'').trim().toLowerCase().includes('алматы'));
    almatyCityId=almatyCity?almatyCity.id:null;
    const d=new Date(date+'T00:00:00');d.setDate(d.getDate()-1);
    transitPrevDate=d.toISOString().slice(0,10);
  }
  return (S.orders||[]).filter(o=>{
    if(!isCourierDelivery(o.delivery_id))return false;
    if(o.courier_city_id!==cityId)return false;
    if(o.intercity_shipment_id)return false;
    const d=(o.pickup_date||o.created_at||'').slice(0,10);
    const isTransitOrder=almatyCityId&&o.pickup_city_id===almatyCityId&&d===transitPrevDate;
    if(date){
      const matchesOwnDay=allowedDates?allowedDates.includes(d):d===date;
      if(!matchesOwnDay&&!isTransitOrder)return false;
    }
    // фильтр по складу: свой город забора, ИЛИ транзитный заказ из Алматы (для Астаны)
    if(whCityId&&o.pickup_city_id!==whCityId&&!isTransitOrder)return false;
    return true;
  });
}

// имя склада отправки из справочника
function warehouseName(id){return ((S.warehouses||[]).find(w=>w.id===id)||{}).name||'—';}

let icFilter={dateFrom:'',dateTo:'',wh:'',dest:'',transport:''};
// заказы, которые должны ехать межгородом (город получения ≠ город забора), но ещё не привязаны
// ни к одной отправке (intercity_cost пуст) — «висят в воздухе». Группируем по городу
// забора+получения+дате, чтобы сразу было видно, где и что копится, а не листать по одному.
function findUnassignedIntercityOrders(){
  const groups={};
  const curMonth=localToday().slice(0,7); // YYYY-MM текущего месяца — прошлые месяцы больше не актуальны
  (S.orders||[]).forEach(o=>{
    if(!isCourierDelivery(o.delivery_id))return;
    if(o.intercity_cost!=null&&o.intercity_cost!==0&&o.intercity_cost!=='')return; // уже привязан
    if(!o.courier_city_id)return; // город получения не указан — не про межгород, отдельная проблема
    const pickupNm=cityName(o.pickup_city_id)||'—';
    const destNm=courierCityName(o.courier_city_id)||'—';
    if(pickupNm.trim().toLowerCase()===destNm.trim().toLowerCase())return; // свой город — не межгород
    const dateStr=(o.pickup_date||'').slice(0,10);
    if(dateStr.slice(0,7)!==curMonth)return; // показываем только текущий месяц — прошлые не нужны
    const key=pickupNm+'→'+destNm+'@'+dateStr;
    if(!groups[key])groups[key]={pickup:pickupNm,dest:destNm,date:dateStr,orders:[]};
    groups[key].orders.push(o);
  });
  return Object.values(groups).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
}
function unassignedIntercityOrdersModal(){
  const groups=findUnassignedIntercityOrders();
  const totalOrders=groups.reduce((s,g)=>s+g.orders.length,0);
  const body=groups.length?`
    <p class="hint" style="margin-bottom:10px">Заказов без привязки к отправке за текущий месяц: <b>${totalOrders}</b> (по данным, загруженным сейчас в CRM). Заказы прошлых месяцев не показываются. Если заказ уже реально уехал — создайте под него отправку или привяжите к уже существующей.</p>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Город забора</th><th>Город получения</th><th>Дата забора</th><th>Кол-во заказов</th><th>Коды заказов</th>
    </tr></thead><tbody>
      ${groups.map(g=>`<tr>
        <td data-label="Город забора">${esc(g.pickup)}</td>
        <td data-label="Город получения">${esc(g.dest)}</td>
        <td data-label="Дата забора">${esc(fmtDate(g.date))}</td>
        <td data-label="Кол-во заказов"><b>${g.orders.length}</b></td>
        <td data-label="Коды заказов" style="font-family:monospace;font-size:12px">${g.orders.slice(0,8).map(o=>esc(o.code)).join(', ')}${g.orders.length>8?` … ещё ${g.orders.length-8}`:''}</td>
      </tr>`).join('')}
    </tbody></table></div>`
    :'<div class="empty"><div class="big">Непривязанных заказов нет</div>За текущий месяц все межгородние заказы уже привязаны к отправкам.</div>';
  showModal('🔍 Непривязанные заказы (текущий месяц)',body,null,{readonly:true,wide:true,closeLabel:'Закрыть'});
}
function renderIntercity(){
  if(!canMod('intercity')){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  const all=[...(S.shipments||[])].sort((a,b)=>(b.ship_date||b.created_at||'').localeCompare(a.ship_date||a.created_at||''));
  // применяем фильтры
  const rows=all.filter(s=>{
    const sd=(s.ship_date||'').slice(0,10);
    if(icFilter.dateFrom&&sd<icFilter.dateFrom)return false;
    if(icFilter.dateTo&&sd>icFilter.dateTo)return false;
    if(icFilter.wh&&s.warehouse_id!==icFilter.wh)return false;
    if(icFilter.dest&&s.dest_city_id!==icFilter.dest)return false;
    if(icFilter.transport&&(s.transport||'')!==icFilter.transport)return false;
    return true;
  });
  // верхний блок: если выбран хоть один фильтр — считаем по нему (по тем же строкам, что и таблица
  // снизу); если фильтров нет — по умолчанию за сегодня, как и раньше
  const hasFilter=!!(icFilter.dateFrom||icFilter.dateTo||icFilter.wh||icFilter.dest||icFilter.transport);
  const todayISO=localToday();
  const summaryRows=hasFilter?rows:all.filter(s=>(s.ship_date||'').slice(0,10)===todayISO);
  const todayBoxes=summaryRows.reduce((sum,s)=>sum+(parseInt(s.weight,10)||0),0); // weight в базе теперь хранит кол-во коробок
  const todayCost=summaryRows.reduce((sum,s)=>sum+(parseFloat(s.box_cost)||0),0);
  const todayOrders=summaryRows.reduce((sum,s)=>sum+((s.order_ids||[]).length),0);
  // подпись периода — если задан диапазон дат, показываем его; если фильтр другой (без дат) —
  // «по фильтру»; иначе — сегодня
  const summaryPeriodLabel=(icFilter.dateFrom||icFilter.dateTo)
    ?`${icFilter.dateFrom?fmtDate(icFilter.dateFrom):'…'} — ${icFilter.dateTo?fmtDate(icFilter.dateTo):'…'}`
    :(hasFilter?'по фильтру':fmtDate(todayISO));
  // города и склады для селектов (из имеющихся отправок)
  const usedWh=[...new Set(all.map(s=>s.warehouse_id).filter(Boolean))];
  const usedDest=[...new Set(all.map(s=>s.dest_city_id).filter(Boolean))];
  const usedTr=[...new Set(all.map(s=>s.transport).filter(Boolean))];
  const totalsBar=`<div class="ic-totals">
    <div class="ic-total-item"><span>Коробок</span><b>${todayBoxes}</b></div>
    <div class="ic-total-item"><span>Заказов в них</span><b>${todayOrders}</b></div>
    <div class="ic-total-item ic-total-money"><span>Потрачено на отправку</span><b>${fmtMoney(todayCost)}</b></div>
    <div class="ic-total-item"><span>За период</span><b>${esc(summaryPeriodLabel)}</b></div>
  </div>`;
  // сводка «потрачено по городам за месяц» — считаем по ТЕКУЩЕМУ календарному месяцу, отдельно
  // от применённых фильтров (это просто общая картина за месяц, а не завязано на фильтр)
  const nowMonth=localToday().slice(0,7);
  const monthShipments=all.filter(s=>(s.ship_date||'').slice(0,7)===nowMonth);
  const byCityCost={};
  monthShipments.forEach(s=>{
    const name=courierCityName(s.dest_city_id)||'—';
    byCityCost[name]=(byCityCost[name]||0)+(parseFloat(s.box_cost)||0);
  });
  const cityCostRows=Object.entries(byCityCost).sort((a,b)=>b[1]-a[1]);
  const monthNamesIC=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  const nowMonthLabel=`${monthNamesIC[parseInt(nowMonth.slice(5,7),10)-1]} ${nowMonth.slice(0,4)}`;
  const cityCostBar=cityCostRows.length?`<div class="panel" style="margin-bottom:14px">
    <div class="panel-head"><h2>Потрачено по городам за ${esc(nowMonthLabel)}</h2><span class="count">${fmtMoney(cityCostRows.reduce((s,r)=>s+r[1],0))}</span></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 16px 14px">
      ${cityCostRows.map(([name,sum])=>`<div class="wh-cat" style="font-size:13px;padding:6px 12px">${esc(name)}: <b>${fmtMoney(sum)}</b></div>`).join('')}
    </div>
  </div>`:'';
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Отправки межгород</h1><p>Учёт коробок, отправленных в другие города</p></div>
      <div class="head-actions">
        <button class="btn ghost" id="icUnassigned">🔍 Непривязанные заказы</button>
        ${can('intercity','create')?'<button class="btn primary" id="newShipment">＋ Создать отправку</button>':''}
      </div>
    </div>
    ${totalsBar}
    ${cityCostBar}
    <div class="ic-filters">
      <input type="date" id="icfDateFrom" value="${esc(icFilter.dateFrom)}" title="С даты">
      <input type="date" id="icfDateTo" value="${esc(icFilter.dateTo)}" title="По дату">
      <select id="icfWh"><option value="">Склад: все</option>${usedWh.map(id=>`<option value="${id}" ${icFilter.wh===id?'selected':''}>${esc(warehouseName(id))}</option>`).join('')}</select>
      <select id="icfDest"><option value="">Город получения: все</option>${usedDest.map(id=>`<option value="${id}" ${icFilter.dest===id?'selected':''}>${esc(courierCityName(id))}</option>`).join('')}</select>
      <select id="icfTr"><option value="">Транспорт: все</option>${usedTr.map(t=>`<option value="${esc(t)}" ${icFilter.transport===t?'selected':''}>${esc(t)}</option>`).join('')}</select>
      ${(icFilter.dateFrom||icFilter.dateTo||icFilter.wh||icFilter.dest||icFilter.transport)?'<button class="btn ghost sm" id="icfClear">Сбросить</button>':''}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Отправки</h2><span class="count">${rows.length}</span></div>
      <div class="table-scroll">
      <table class="resp-table ic-table"><thead><tr>
        <th>Дата</th><th>Склад отправки</th><th>Город получения</th><th>Транспорт</th>
        <th>Кол-во коробок</th><th>Общая сумма</th><th>За 1 коробку</th><th>Заказов</th><th>За 1 заказ</th><th>Отправитель</th><th></th>
      </tr></thead><tbody>
      ${rows.length?rows.map(s=>{
        const cnt=(s.order_ids||[]).length;
        const per=cnt?Math.round((s.box_cost||0)/cnt):0;
        const perBox=s.weight?Math.round((s.box_cost||0)/s.weight):0; // весь тут — кол-во коробок (поле в базе исторически называется weight)
        return `<tr>
          <td data-label="Дата">${esc(fmtDate(s.ship_date))}</td>
          <td data-label="Склад отправки">${esc(s.warehouse_id?warehouseName(s.warehouse_id):cityName(s.warehouse_city_id))}</td>
          <td data-label="Город получения">${esc(courierCityName(s.dest_city_id))}</td>
          <td data-label="Транспорт">${esc(s.transport||'—')}</td>
          <td data-label="Кол-во коробок">${s.weight?esc(s.weight):'—'}</td>
          <td data-label="Общая сумма">${fmtMoney(s.box_cost)}</td>
          <td data-label="За 1 коробку">${s.weight?fmtMoney(perBox):'—'}</td>
          <td data-label="Заказов">${cnt}</td>
          <td data-label="За 1 заказ">${fmtMoney(per)}</td>
          <td data-label="Отправитель">${esc(s.sender_name||'—')}</td>
          <td data-label="" class="cell-actions"><div class="row-actions">
            <button class="btn sm ghost" data-icview="${s.id}">Заказы</button>
            ${can('intercity','edit')?`<button class="btn sm ghost" data-icedit="${s.id}">Изменить</button>`:''}
            ${can('intercity','delete')?`<button class="btn sm danger" data-icdel="${s.id}">Удалить</button>`:''}
          </div></td>
        </tr>`;
      }).join(''):`<tr><td colspan="11"><div class="empty"><div class="big">Нет отправок</div>${(icFilter.dateFrom||icFilter.dateTo||icFilter.wh||icFilter.dest||icFilter.transport)?'Измените фильтры.':'Нажмите «Создать отправку».'}</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  if($('newShipment'))$('newShipment').onclick=()=>shipmentModal();
  if($('icUnassigned'))$('icUnassigned').onclick=()=>unassignedIntercityOrdersModal();
  // фильтры
  if($('icfDateFrom'))$('icfDateFrom').onchange=e=>{icFilter.dateFrom=e.target.value;renderIntercity();};
  if($('icfDateTo'))$('icfDateTo').onchange=e=>{icFilter.dateTo=e.target.value;renderIntercity();};
  if($('icfWh'))$('icfWh').onchange=e=>{icFilter.wh=e.target.value;renderIntercity();};
  if($('icfDest'))$('icfDest').onchange=e=>{icFilter.dest=e.target.value;renderIntercity();};
  if($('icfTr'))$('icfTr').onchange=e=>{icFilter.transport=e.target.value;renderIntercity();};
  if($('icfClear'))$('icfClear').onclick=()=>{icFilter={dateFrom:'',dateTo:'',wh:'',dest:'',transport:''};renderIntercity();};
  $('main').querySelectorAll('[data-icview]').forEach(b=>b.onclick=()=>shipmentOrdersModal(b.dataset.icview));
  $('main').querySelectorAll('[data-icedit]').forEach(b=>b.onclick=()=>shipmentEditModal(b.dataset.icedit));
  $('main').querySelectorAll('[data-icdel]').forEach(b=>b.onclick=()=>delShipment(b.dataset.icdel));
}

// города получения (курьерские), куда есть неотправленные курьерские заказы на дату (и склад, если задан)
function destCitiesForDate(date,whId){
  // используем ТУ ЖЕ функцию, что и сам список заказов — чтобы город появлялся в выпадающем меню
  // ровно тогда, когда для него реально найдутся заказы (с учётом транзита через Астану и дней-доноров)
  return (S.courier_cities||[]).filter(c=>ordersForIntercity(c.id,date,whId).length>0);
}
// форма создания отправки
function shipmentModal(){
  let selectedDest='';
  let pickedOrders=[]; // выбранные заказы (по умолчанию все из города)
  const initDate=localToday();
  const body=`
    <div class="form-grid">
      <div class="field"><label>Дата отправки</label><input type="date" id="s_date" value="${initDate}"></div>
      <div class="field"><label>Склад отправки <span style="color:var(--rust)">*</span></label>
        <select id="s_wh"><option value="">— выберите склад —</option>${(S.warehouses||[]).map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
        ${(!S.warehouses||!S.warehouses.length)?'<span class="hint" style="color:var(--rust)">Добавьте склады в Настройки → Склады отправки</span>':''}</div>
      <div class="field"><label>Город получения <span style="color:var(--rust)">*</span></label>
        <select id="s_dest"><option value="">— сначала выберите склад —</option></select>
        <span class="hint">Показаны города с заказами выбранного склада на дату.</span></div>
      <div class="field"><label>Тип транспорта</label>
        <select id="s_transport">${TRANSPORT_TYPES.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label>Кол-во коробок</label><input type="number" min="1" step="1" id="s_weight" placeholder="1"></div>
      <div class="field"><label>Общая сумма отправки (₸) <span style="color:var(--rust)">*</span></label><input type="number" min="0" step="0.01" id="s_cost" placeholder="0"></div>
    </div>
    <div id="s_orders_wrap" style="margin-top:8px">
      <div class="hint" style="padding:10px 0">Выберите город получения — подтянутся заказы для отправки.</div>
    </div>`;
  showModal('Новая отправка межгород',body,async()=>{
    const dest=val('s_dest');
    if(!dest){toast('Выберите город получения');return false;}
    const wh=val('s_wh');
    if(!wh){toast('Выберите склад отправки');return false;}
    const cost=parseFloat(val('s_cost'))||0;
    if(!cost){toast('Укажите стоимость отправки коробки');return false;}
    const ids=pickedOrders.filter(id=>document.querySelector(`[data-icorder="${id}"]`)?.checked);
    if(!ids.length){toast('Нет заказов в коробке');return false;}
    const per=Math.round(cost/ids.length);
    const boxCount=val('s_weight')?parseInt(val('s_weight'),10):null; // поле называется weight в базе (историческая причина), но теперь хранит кол-во коробок, не вес
    const perBox=boxCount?Math.round(cost/boxCount):null;
    const row={
      ship_date:val('s_date')||localToday(),
      warehouse_id:wh,
      dest_city_id:dest,
      transport:val('s_transport')||'',
      weight:boxCount,
      box_cost:cost,
      order_ids:ids,
      per_order:per,
      sender_id:(S.me&&S.me.id)||null,
      sender_name:(S.me&&(S.me.full_name||S.me.email))||'',
    };
    const saved=await dbInsert('shipments',row);
    if(!saved){toast('Не удалось сохранить');return false;}
    if(!S.shipments)S.shipments=[];S.shipments.push(saved);
    // записываем стоимость межгорода в каждый заказ (для калькуляции) + помечаем как отправленный
    for(const oid of ids){
      await dbUpdate('orders',oid,{intercity_cost:per,intercity_shipment_id:saved.id});
      const o=(S.orders||[]).find(x=>x.id===oid);if(o){o.intercity_cost=per;o.intercity_shipment_id=saved.id;}
    }
    toast(`Отправка создана · ${ids.length} заказов${boxCount?` · ${boxCount} кор.`:''} · ${per.toLocaleString('ru-RU')} ₸/заказ${perBox?` · ${perBox.toLocaleString('ru-RU')} ₸/коробку`:''}`);
    renderIntercity();return true;
  },{wide:true});
  // обработчик выбора склада/города/даты — подтягиваем заказы
  setTimeout(()=>{
    const sel=$('s_dest');if(!sel)return;
    const rebuild=()=>{
      selectedDest=sel.value;
      const date=($('s_date')||{}).value||'';
      const wh=($('s_wh')||{}).value||'';
      const wrap=$('s_orders_wrap');
      if(!selectedDest){wrap.innerHTML='<div class="hint" style="padding:10px 0">Выберите город получения.</div>';pickedOrders=[];return;}
      const list=ordersForIntercity(selectedDest,date,wh);
      pickedOrders=list.map(o=>o.id);
      if(!list.length){wrap.innerHTML=`<div class="empty" style="padding:20px"><div class="big">Нет заказов</div>Нет курьерских заказов в этот город на ${esc(fmtDate(date))}, ожидающих отправки.</div>`;return;}
      wrap.innerHTML=`
        <div class="ic-orders-head">
          <b>Заказы для отправки (${list.length})</b>
          <span class="hint">Дата забора: ${esc(fmtDate(date))} · снимите галочку, чтобы исключить заказ</span>
        </div>
        <div class="ic-orders-list">
          ${list.map(o=>{
            const pd=(o.pickup_date||o.created_at||'').slice(0,10);
            const rolled=pd&&pd!==date; // заказ подтянут не с той же даты, что отправка
            const pickupCityNm=o.pickup_city_id?cityName(o.pickup_city_id):'';
            const whSel=($('s_wh')||{}).value||'';
            const whCityNow=whSel?cityName(warehousePickupCityId(whSel)):'';
            const isTransit=rolled&&pickupCityNm&&whCityNow&&pickupCityNm.toLowerCase()!==whCityNow.toLowerCase();
            return `<label class="ic-order-row">
            <input type="checkbox" data-icorder="${o.id}" checked>
            <span class="ic-o-code">${esc(o.code||o.id.slice(0,6))}</span>
            <span class="ic-o-client">${esc(o.client||o.sender||'—')}</span>
            <span class="ic-o-track">${esc(o.track||'')}</span>
            ${isTransit?`<span class="ic-o-rolled" title="Забран в ${esc(pickupCityNm)} ${esc(fmtDate(pd))}, транзитом через этот склад">🚚 транзит из ${esc(pickupCityNm)} ${esc(fmtDate(pd))}</span>`
              :rolled?`<span class="ic-o-rolled" title="Забор был ${esc(fmtDate(pd))}, подтянут к этой отправке">📅 забор ${esc(fmtDate(pd))}</span>`:''}
          </label>`;}).join('')}
        </div>
        <div class="ic-calc-live" id="s_live"></div>`;
      updateShipLive();
      wrap.querySelectorAll('[data-icorder]').forEach(c=>c.onchange=updateShipLive);
    };
    // пересобрать список городов получения по дате и складу
    const rebuildCities=()=>{
      const date=($('s_date')||{}).value||'';
      const wh=($('s_wh')||{}).value||'';
      const cities=destCitiesForDate(date,wh);
      sel.innerHTML=`<option value="">${cities.length?'— выберите город —':'нет заказов'}</option>`+cities.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
      selectedDest='';
      rebuild();
    };
    sel.onchange=rebuild;
    if($('s_wh'))$('s_wh').onchange=rebuildCities; // смена склада — пересобрать города и заказы
    if($('s_date'))$('s_date').onchange=rebuildCities;
    // пересчёт «за 1 заказ» вживую
    const costInp=$('s_cost');if(costInp)costInp.oninput=updateShipLive;
  },50);
}
// живой пересчёт стоимости за заказ в форме
function updateShipLive(){
  const live=$('s_live');if(!live)return;
  const cost=parseFloat(($('s_cost')||{}).value)||0;
  const checked=document.querySelectorAll('[data-icorder]:checked').length;
  const per=checked?Math.round(cost/checked):0;
  live.innerHTML=`В коробке: <b>${checked}</b> заказов · Стоимость за 1 заказ: <b>${per.toLocaleString('ru-RU')} ₸</b>`;
}

// просмотр заказов в отправке
function shipmentOrdersModal(id){
  const s=(S.shipments||[]).find(x=>x.id===id);if(!s)return;
  const ids=s.order_ids||[];
  const per=ids.length?Math.round((s.box_cost||0)/ids.length):0;
  const rows=ids.map(oid=>{
    const o=(S.orders||[]).find(x=>x.id===oid);
    if(!o)return `<tr><td colspan="4" style="color:var(--muted)">Заказ удалён (${esc(oid.slice(0,6))})</td></tr>`;
    return `<tr><td>${esc(o.code||'')}</td><td>${esc(o.client||o.sender||'—')}</td><td>${esc(o.track||'—')}</td><td>${per.toLocaleString('ru-RU')} ₸</td></tr>`;
  }).join('');
  showInfo(`Отправка в ${courierCityName(s.dest_city_id)}`,`
    <div class="ic-view-head">
      <div>Дата: <b>${esc(fmtDate(s.ship_date))}</b></div>
      <div>Транспорт: <b>${esc(s.transport||'—')}</b>${s.weight?` · Кол-во коробок: <b>${esc(s.weight)}</b>`:''}</div>
      <div>Общая сумма: <b>${Math.round(s.box_cost||0).toLocaleString('ru-RU')} ₸</b> · За 1 заказ: <b>${per.toLocaleString('ru-RU')} ₸</b>${s.weight?` · За 1 коробку: <b>${Math.round((s.box_cost||0)/s.weight).toLocaleString('ru-RU')} ₸</b>`:''}</div>
      <div>Отправитель: <b>${esc(s.sender_name||'—')}</b></div>
    </div>
    <table class="ic-view-tbl"><thead><tr><th>Код</th><th>Клиент</th><th>Трек</th><th>Стоимость</th></tr></thead><tbody>${rows}</tbody></table>`);
}

// редактирование отправки: дата, склад, транспорт, кол-во коробок, общая сумма
// при изменении стоимости пересчитывается «за 1 заказ» и обновляется intercity_cost в заказах
function shipmentEditModal(id){
  if(!can('intercity','edit'))return;
  const s=(S.shipments||[]).find(x=>x.id===id);if(!s)return;
  const body=`
    <div class="form-grid">
      <div class="field"><label>Дата отправки</label><input type="date" id="se_date" value="${esc((s.ship_date||'').slice(0,10))}"></div>
      <div class="field"><label>Склад отправки</label>
        <select id="se_wh"><option value="">—</option>${(S.warehouses||[]).map(w=>`<option value="${w.id}" ${s.warehouse_id===w.id?'selected':''}>${esc(w.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Тип транспорта</label>
        <select id="se_transport">${TRANSPORT_TYPES.map(t=>`<option value="${esc(t)}" ${s.transport===t?'selected':''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label>Кол-во коробок</label><input type="number" min="1" step="1" id="se_weight" value="${s.weight!=null?esc(s.weight):''}" placeholder="1"></div>
      <div class="field"><label>Общая сумма отправки (₸)</label><input type="number" min="0" step="0.01" id="se_cost" value="${s.box_cost!=null?esc(s.box_cost):''}" placeholder="0"></div>
    </div>
    <div class="hint" style="margin-top:8px">Заказов в коробке: ${(s.order_ids||[]).length}. При изменении суммы пересчитается «за 1 заказ» и обновится в калькуляции.</div>`;
  showModal('Изменить отправку',body,async()=>{
    const cost=parseFloat(val('se_cost'))||0;
    const ids=s.order_ids||[];
    const per=ids.length?Math.round(cost/ids.length):0;
    const upd={
      ship_date:val('se_date')||s.ship_date,
      warehouse_id:val('se_wh')||null,
      transport:val('se_transport')||'',
      weight:val('se_weight')?parseInt(val('se_weight'),10):null,
      box_cost:cost,
      per_order:per,
    };
    const saved=await dbUpdate('shipments',id,upd);
    if(!saved){toast('Не удалось сохранить');return false;}
    Object.assign(s,saved);
    // обновляем стоимость межгорода в заказах
    for(const oid of ids){
      await dbUpdate('orders',oid,{intercity_cost:per});
      const o=(S.orders||[]).find(x=>x.id===oid);if(o)o.intercity_cost=per;
    }
    toast('Отправка изменена');renderIntercity();return true;
  },{wide:true});
}

// удаление отправки — снимает метки с заказов
async function delShipment(id){
  const s=(S.shipments||[]).find(x=>x.id===id);if(!s)return;
  if(!confirm('Удалить эту отправку? Стоимость межгорода с заказов будет снята.'))return;
  const ok=await dbDelete('shipments',id);
  if(!ok){toast('Не удалось удалить');return;}
  // снимаем стоимость и метку с заказов
  for(const oid of (s.order_ids||[])){
    await dbUpdate('orders',oid,{intercity_cost:null,intercity_shipment_id:null});
    const o=(S.orders||[]).find(x=>x.id===oid);if(o){o.intercity_cost=null;o.intercity_shipment_id=null;}
  }
  S.shipments=(S.shipments||[]).filter(x=>x.id!==id);
  toast('Отправка удалена');renderIntercity();
}