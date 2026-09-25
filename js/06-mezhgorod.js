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
  // День-донор считаем строкой: через toISOString() в поясе +5 он уезжал на сутки назад.
  if(hasDonor)dates.push(shiftDateStr(dateStr,-1));
  return dates;
}
// города, куда со склада Алматы заказы едут НЕ напрямую, а через Астану (сначала едут в Астану,
// это занимает день, и уже оттуда дальше по городам вместе с астанинскими заказами). Поэтому:
//  - при отправке СО СКЛАДА АЛМАТЫ в эти города заказов быть не должно вообще (их забирает Астана)
//  - при отправке СО СКЛАДА АСТАНА в эти города — дополнительно подтягиваются заказы, забранные
//    в Алматы НА ДЕНЬ РАНЬШЕ (успели доехать до Астаны только к этому дню)
// Города, куда со склада Астана заказы едут, ПОДТЯГИВАЯ по пути забранные в Алматы (транзит).
// Список оставлен как справка, но правилом он больше не является — см. intercityViaAstana().
const INTERCITY_VIA_ASTANA_CITIES=['усть-каменогорск','семей','костанай','павлодар','петропавловск','караганд','кокшетау','сатпаев','жезк','актобе','уральск','актау','атырау'];
// со склада Алматы отправка идёт напрямую ТОЛЬКО в эти города — весь остальной список городов
// не должен даже появляться в выборе при складе Алматы (едут через Астану транзитом, либо это
// внутригородские, либо просто не обслуживаются напрямую с Алматы)
// Каскелен (25 км), Конаев и он же Капчагай (70 км) — пригороды Алматы. Их добавили
// 26.09.2026 по данным самой системы: в непривязанных нашлись заказы «Алматы → Каскелен»
// и «Алматы → Конаев», а правило «всё, кроме пятёрки, едет через Астану» отправило бы их
// крюком в 2400 км. Решение владельца — возить напрямую со склада Алматы.
const INTERCITY_ALMATY_ALLOWED_CITIES=['астана','шымкент','тараз','кызылорда','талдыкорган',
  'каскелен','конаев','капчагай'];
// ТРАНЗИТ ЧЕРЕЗ АСТАНУ — правило, а не список. Со склада Алматы уезжают только пять городов
// выше; всё остальное физически едет Алматы → Астана → город, значит и подтягиваться должно
// из Астаны. Раньше тут стоял перечень из тринадцати городов, и любой город вне его (новый
// в справочнике, редкое направление) попадал в мёртвую зону: с Алматы не отправить, из
// Астаны не подтянуть — заказ висел непривязанным сколько угодно долго.
function intercityViaAstana(destNm){
  const nm=String(destNm||'').trim().toLowerCase();
  if(!nm)return false;
  return !INTERCITY_ALMATY_ALLOWED_CITIES.some(n=>nm.includes(n));
}
// Окно транзита — ровно сутки: забрали в Алматы вчера, сегодня уехало из Астаны. Забор
// сегодня уезжает сегодня, старое не тянем (решение владельца от 26.09.2026). Пробовали
// расширить до месяца — оказалось неверно: накопившееся надо разбирать вручную, а не
// подмешивать в свежие коробки.
// Сдвиг ДАТЫ-СТРОКИ на N дней. Считаем в UTC и читаем UTC-полями: `new Date('2026-09-26')`
// в браузере с поясом +5 при обратном toISOString() даёт 2026-09-25 вместо 2026-09-26, и
// «вчера» превращалось во «позавчера» — ровно поэтому транзитные заказы и выпадали из выдачи
// (та же ловушка, из-за которой в CRM есть localToday(), см. CLAUDE.md раздел 8).
function shiftDateStr(dateStr,days){
  const [y,m,d]=String(dateStr).slice(0,10).split('-').map(Number);
  if(!y||!m||!d)return dateStr;
  const t=new Date(Date.UTC(y,m-1,d));
  t.setUTCDate(t.getUTCDate()+days);
  return t.toISOString().slice(0,10);
}
// ДВА ПЛЕЧА ОДНОГО ЗАКАЗА — главное в этом модуле.
//
// Заказ, забранный в Алматы и адресованный, скажем, в Актобе, едет так:
//   25-го Нурлан отправляет коробку АЛМАТЫ → АСТАНА, в ней и астанинские заказы, и все
//         транзитные — этот в том числе;
//   26-го он уже в Астане, и Ермек собирает коробку АСТАНА → АКТОБЕ: заказы забора Астаны
//         за 26-е ПЛЮС алматинские за 25-е.
// То есть один и тот же заказ выходит в выдачу ДВАЖДЫ и берёт долю ДВУХ коробок.
// Его `intercity_cost` — сумма обеих долей (см. orderFreightTotal).
//
// Отсюда же правило исключения: «уже отправлен» считается ПО ПЛЕЧУ, а не вообще. Уехал из
// Алматы — больше не предлагаем в алматинские отправки, но в астанинской он обязан появиться.
// Раньше стояла проверка `if(o.intercity_shipment_id)return false`, и второе плечо не
// наступало никогда: заказ пропадал из выдачи навсегда после первой же коробки.

// Город отправления коробки. Склад сопоставляется с городом по названию: сначала точно,
// потом вхождением — склад часто зовут «Склад Астана», и на строгом равенстве город не
// определялся вовсе, а отправка молча выпадала из подбора.
function shipmentCityName(whId){
  const exact=warehousePickupCityId(whId);
  if(exact)return (cityName(exact)||'').trim().toLowerCase();
  const wh=(S.warehouses||[]).find(w=>w.id===whId);
  const nm=(wh&&wh.name||'').trim().toLowerCase();
  if(!nm)return '';
  const city=(S.cities||[]).find(c=>{
    const cn=(c.name||'').trim().toLowerCase();
    return cn&&(nm.includes(cn)||cn.includes(nm));
  });
  return city?(city.name||'').trim().toLowerCase():'';
}
// Из каких городов заказ уже уезжал. Членство храним в самих отправках (order_ids), а не
// в поле заказа: полей два не сделать, а плеч у заказа два.
let _legCache=null,_legCacheKey='';
function orderLegsShipped(){
  const key=(S.shipments||[]).map(s=>s.id+':'+((s.order_ids||[]).length)).join(',');
  if(_legCache&&_legCacheKey===key)return _legCache;
  const map=new Map();
  (S.shipments||[]).forEach(s=>{
    const from=shipmentCityName(s.warehouse_id);
    if(!from)return;
    (s.order_ids||[]).forEach(id=>{
      if(!map.has(id))map.set(id,new Set());
      map.get(id).add(from);
    });
  });
  _legCache=map;_legCacheKey=key;
  return map;
}
const orderShippedFrom=(orderId,cityNm)=>{
  const set=orderLegsShipped().get(orderId);
  return !!(set&&set.has(cityNm));
};
// Сколько плеч нужно заказу: транзитному — два (из города забора и из Астаны), остальным — одно.
function orderLegsNeeded(o){
  const pickupNm=(cityName(o.pickup_city_id)||'').trim().toLowerCase();
  const destNm=(courierCityName(o.courier_city_id)||'').trim().toLowerCase();
  if(!pickupNm||!destNm||pickupNm===destNm)return 0;       // свой город — не межгород
  return (pickupNm.includes('алматы')&&intercityViaAstana(destNm))?2:1;
}

function ordersForIntercity(cityId,date,whId){
  const whCityId=whId?warehousePickupCityId(whId):null;
  const whCityNm=whId?shipmentCityName(whId):'';
  const destNm=(courierCityName(cityId)||'').toLowerCase();
  // отправка города самого в себя не имеет смысла (склад Астана → город получения Астана и т.п.)
  if(whCityNm&&destNm&&whCityNm===destNm)return [];
  const isViaAstana=intercityViaAstana(destNm);
  const isAlmatyWh=whCityNm.includes('алматы');
  const isAstanaWh=whCityNm.includes('астана');
  // со склада Алматы — только разрешённые города, остальные едут транзитом через Астану
  if(isAlmatyWh&&!INTERCITY_ALMATY_ALLOWED_CITIES.some(n=>destNm.includes(n)))return [];
  // Города с редким расписанием: отправка не каждый день, поэтому подтягиваем ещё и заказы
  // «дня-донора» — вторник к среде, четверг к пятнице, суббота к воскресенью.
  const isLimited=INTERCITY_LIMITED_SCHEDULE_CITIES.some(n=>destNm.includes(n));
  const allowedDates=(date&&isLimited)?intercityRollupDates(date):null;
  // ПЕРВОЕ ПЛЕЧО. Коробка Алматы → Астана везёт не только заказы с назначением «Астана», но и
  // все транзитные: физически они едут в ней же. Без этого Нурлан возил бы их даром, а вся
  // стоимость первого плеча ложилась бы на одни астанинские заказы.
  const isFirstLeg=isAlmatyWh&&destNm.includes('астана');
  // ВТОРОЕ ПЛЕЧО. Заказ, забранный в Алматы накануне, к сегодняшней отправке из Астаны уже
  // доехал. Ровно накануне: забор сегодня — уезжает сегодня, старое не тянем.
  let almatyCityId=null,transitPrevDate=null;
  if(isAstanaWh&&isViaAstana&&date){
    const almatyCity=(S.cities||[]).find(c=>(c.name||'').trim().toLowerCase().includes('алматы'));
    almatyCityId=almatyCity?almatyCity.id:null;
    transitPrevDate=shiftDateStr(date,-1);
  }
  return (S.orders||[]).filter(o=>{
    if(!isCourierDelivery(o.delivery_id))return false;
    const oDestNm=(courierCityName(o.courier_city_id)||'').toLowerCase();
    // на первом плече берём и «свои» астанинские, и транзитные — по городу их не отличить
    const destOk=isFirstLeg
      ? (o.courier_city_id===cityId||(oDestNm&&intercityViaAstana(oDestNm)))
      : (o.courier_city_id===cityId);
    if(!destOk)return false;
    // «уже уехал» — по этому плечу, а не вообще
    if(whCityNm&&orderShippedFrom(o.id,whCityNm))return false;
    if(!whCityNm&&o.intercity_shipment_id)return false; // склад не определён — старое правило
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

// Сколько межгорода приходится на заказ ВСЕГО: доли всех коробок, в которых он едет.
// У транзитного их две — Алматы → Астана и Астана → город. Калькуляция и ежедневный отчёт
// читают одно поле `orders.intercity_cost`, поэтому кладём в него именно сумму.
function orderFreightTotal(orderId,shipments){
  const list=shipments||S.shipments||[];
  let sum=0;
  list.forEach(s=>{
    if(!(s.order_ids||[]).includes(orderId))return;
    const cnt=(s.order_ids||[]).length;
    const per=(s.per_order!=null&&s.per_order!=='')?parseFloat(s.per_order)||0
      :(cnt?Math.round((parseFloat(s.box_cost)||0)/cnt):0);
    sum+=per;
  });
  return sum;
}
// Переписать intercity_cost у списка заказов по текущему составу отправок.
async function syncOrderFreight(orderIds){
  for(const oid of [...new Set(orderIds)]){
    const total=orderFreightTotal(oid);
    await dbUpdate('orders',oid,{intercity_cost:total});
    const o=(S.orders||[]).find(x=>x.id===oid);if(o)o.intercity_cost=total;
  }
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
    if(!o.courier_city_id)return; // город получения не указан — не про межгород, отдельная проблема
    // «Непривязан» считаем по ПЛЕЧАМ, а не по стоимости: у транзитного заказа их два, и
    // после первого он ещё не доехал. Пока не отработаны все, он висит здесь.
    const need=orderLegsNeeded(o);
    if(!need)return;
    const pickupCityNm=(cityName(o.pickup_city_id)||'').trim().toLowerCase();
    const doneFirst=orderShippedFrom(o.id,pickupCityNm);
    const doneSecond=need<2||orderShippedFrom(o.id,'астана');
    if(doneFirst&&doneSecond)return;
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
  showModal('🔍 Непривязанные заказы (текущий месяц)',
    body+(groups.length&&can('intercity','edit')?`<div style="margin-top:14px">
      <button class="btn primary sm" id="icAssign">→ Разложить по уже созданным отправкам</button>
      <span class="hint" style="margin-left:10px">Покажет, куда встанет каждый, до того как что-то менять.</span></div>`:''),
    null,{readonly:true,wide:true,closeLabel:'Закрыть'});
  if($('icAssign'))$('icAssign').onclick=()=>{
    document.querySelectorAll('.overlay').forEach(e=>e.remove());
    document.body.classList.remove('modal-open');
    intercityAssignModal();
  };
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
    // Стоимость межгорода у заказа — СУММА долей всех коробок, в которых он едет: у транзитного
    // их две (Алматы → Астана и Астана → город). Просто записать долю этой коробки нельзя —
    // второе плечо затёрло бы первое, и половина перевозки исчезла бы из расчёта.
    await syncOrderFreight(ids);
    // intercity_shipment_id оставляем как отметку последней коробки: по ней открывается
    // отправка из карточки заказа. Признаком «уже уехал» он больше не служит — плечо
    // определяется по составу самих отправок (orderShippedFrom).
    for(const oid of ids){
      await dbUpdate('orders',oid,{intercity_shipment_id:saved.id});
      const o=(S.orders||[]).find(x=>x.id===oid);if(o)o.intercity_shipment_id=saved.id;
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
    // пересчитываем сумму по всем коробкам заказа, а не только по этой
    await syncOrderFreight(ids);
    toast('Отправка изменена');renderIntercity();return true;
  },{wide:true});
}

// удаление отправки — снимает метки с заказов
async function delShipment(id){
  const s=(S.shipments||[]).find(x=>x.id===id);if(!s)return;
  if(!confirm('Удалить эту отправку? Стоимость межгорода с заказов будет снята.'))return;
  const ok=await dbDelete('shipments',id);
  if(!ok){toast('Не удалось удалить');return;}
  const ids=[...(s.order_ids||[])];
  S.shipments=(S.shipments||[]).filter(x=>x.id!==id);   // сначала убираем коробку из памяти…
  // …и только потом считаем: у транзитного заказа остаётся доля ВТОРОЙ коробки, и обнулять
  // её нельзя. Поэтому не ставим null, а пересчитываем сумму по тому, что осталось.
  await syncOrderFreight(ids);
  for(const oid of ids){
    const stillIn=(S.shipments||[]).find(x=>(x.order_ids||[]).includes(oid));
    await dbUpdate('orders',oid,{intercity_shipment_id:stillIn?stillIn.id:null});
    const o=(S.orders||[]).find(x=>x.id===oid);if(o)o.intercity_shipment_id=stillIn?stillIn.id:null;
  }
  toast('Отправка удалена');renderIntercity();
}
// ============ РАСКЛАДКА НАКОПИВШИХСЯ ЗАКАЗОВ ПО УЖЕ СОЗДАННЫМ ОТПРАВКАМ ============
//
// Пока окно транзита было ровно сутки, всё, что пролежало в Астане дольше, в выдачу не
// попадало и копилось непривязанным. Эти заказы физически уехали — просто ни к одной
// коробке их не приписали. Здесь они раскладываются по отправкам, которые уже есть.
//
// ЭТО МЕНЯЕТ ДЕНЬГИ ЗАДНИМ ЧИСЛОМ, и по-другому быть не может: стоимость коробки делится
// на число заказов в ней, добавили заказ — доля каждого уменьшилась. Поэтому:
//   1) сначала показываем, что именно изменится, и только по кнопке применяем;
//   2) пересчитываем intercity_cost У ВСЕХ заказов затронутой отправки, а не только у новых,
//      иначе старые остались бы со старой долей и сумма по коробке перестала бы сходиться.
//
// Отправку выбираем САМУЮ РАННЮЮ из подходящих: заказ уехал первым же рейсом, который мог
// его увезти, а не последним.
// Город склада: сначала точным совпадением имени (как в warehousePickupCityId), а если не
// вышло — вхождением. Склад часто называют «Склад Астана» или «Астана (основной)», и при
// строгом равенстве город не определяется вовсе: отправка выпадает из подбора, а почему —
// по экрану не понять. Здесь ошибиться безопасно: подбор всё равно показывается заранее.
function shipmentCityName(whId){
  const exact=warehousePickupCityId(whId);
  if(exact)return (cityName(exact)||'').trim().toLowerCase();
  const wh=(S.warehouses||[]).find(w=>w.id===whId);
  const nm=(wh&&wh.name||'').trim().toLowerCase();
  if(!nm)return '';
  const city=(S.cities||[]).find(c=>{
    const cn=(c.name||'').trim().toLowerCase();
    return cn&&(nm.includes(cn)||cn.includes(nm));
  });
  return city?(city.name||'').trim().toLowerCase():'';
}
// Насколько далеко от дня забора ищем уже созданную отправку при разборе накопившегося.
// К ежедневной работе отношения не имеет: там окно ровно сутки. Предел нужен, чтобы заказ
// не лёг в коробку, ушедшую спустя месяцы, — но он шире окна, потому что разбирают как раз
// то, что залежалось.
const INTERCITY_BACKLOG_MAX_DAYS=45;
// С какой даты забора разбирать. По умолчанию — начало текущего месяца: именно за месяц
// накопившееся и разбирают, а прошлые месяцы уже закрыты по деньгам.
//
// Значение по умолчанию считаем ЛЕНИВО, а не при загрузке файла: localToday() объявлена
// в js/10-zayavki.js, то есть позже этого файла, и вызов на верхнем уровне роняет весь
// скрипт (см. CLAUDE.md, раздел 9, пункт 2 — «Cannot access before initialization»).
let icAssignFrom='';
const icAssignFromDate=()=>icAssignFrom||(localToday().slice(0,8)+'01');
function intercityPlanAssign(){
  const shipments=(S.shipments||[]).filter(s=>s.dest_city_id&&s.ship_date);
  const why={candidates:0,shipments:shipments.length,noCity:0,dateNoFit:0,whUnknown:0,badRoute:0,tooOld:0};
  const plan={};   // shipment_id → {ship, add:[]}
  const skipped=[];
  const nameOf=id=>(courierCityName(id)||'').trim().toLowerCase();
  // Подбираем САМУЮ РАННЮЮ подходящую отправку: заказ уехал первым же рейсом, который мог его
  // увезти, а не последним.
  const pick=(test)=>shipments.filter(test).sort((x,y)=>(x.ship_date||'').localeCompare(y.ship_date||''))[0]||null;
  (S.orders||[]).forEach(o=>{
    if(!isCourierDelivery(o.delivery_id))return;
    if(!o.courier_city_id)return;
    const need=orderLegsNeeded(o);
    if(!need)return;                                   // свой город — не межгород
    const pickupNm=(cityName(o.pickup_city_id)||'').trim().toLowerCase();
    const destNm=nameOf(o.courier_city_id);
    const d=(o.pickup_date||o.created_at||'').slice(0,10);
    if(!d)return;
    if(d<icAssignFromDate()){why.tooOld++;return;}
    why.candidates++;
    const notOlder=shiftDateStr(d,INTERCITY_BACKLOG_MAX_DAYS);
    let missing=0,placed=0,sawCity=false,sawDate=false;
    const add=(ship)=>{(plan[ship.id]=plan[ship.id]||{ship,add:[]}).add.push(o);placed++;};
    // ПЛЕЧО 1 — из города забора. У транзитного заказа эта коробка идёт в Астану, у прямого —
    // сразу в город назначения.
    if(!orderShippedFrom(o.id,pickupNm)){
      missing++;
      const legOne=shipments.filter(s=>{
        const from=shipmentCityName(s.warehouse_id);
        if(!from||from!==pickupNm)return false;
        return need===2?nameOf(s.dest_city_id).includes('астана'):s.dest_city_id===o.courier_city_id;
      });
      if(legOne.length){
        sawCity=true;
        const fit=pick(s=>legOne.includes(s)&&(s.ship_date||'').slice(0,10)>=d&&(s.ship_date||'').slice(0,10)<=notOlder);
        if(fit)add(fit);else sawDate=true;
      }
    }
    // ПЛЕЧО 2 — из Астаны, только у транзитных. Минимум через сутки после забора: раньше
    // заказ физически не доехал бы.
    if(need===2&&!orderShippedFrom(o.id,'астана')){
      missing++;
      const legTwo=shipments.filter(s=>{
        const from=shipmentCityName(s.warehouse_id);
        return from&&from.includes('астана')&&s.dest_city_id===o.courier_city_id;
      });
      if(legTwo.length){
        sawCity=true;
        const fit=pick(s=>legTwo.includes(s)&&(s.ship_date||'').slice(0,10)>d&&(s.ship_date||'').slice(0,10)<=notOlder);
        if(fit)add(fit);else sawDate=true;
      }
    }
    if(!missing)return;                                // оба плеча уже отработаны
    if(placed)return;
    skipped.push(o);
    if(!shipments.some(s=>shipmentCityName(s.warehouse_id)))why.whUnknown++;
    else if(!sawCity)why.noCity++;
    else if(sawDate)why.dateNoFit++;
    else why.badRoute++;
  });
  return {rows:Object.values(plan).sort((a,b)=>(a.ship.ship_date||'').localeCompare(b.ship.ship_date||'')),skipped,why};
}
// Разбор «почему не разложилось» — по пунктам, с подсказкой, что делать.
function intercityWhyHtml(why,skipped){
  const line=(n,txt)=>n?`<li><b>${n}</b> — ${txt}</li>`:'';
  return `<ul class="hint" style="margin:10px 0 0;padding-left:18px;line-height:1.7">
    <li>непривязанных межгородних заказов: <b>${why.candidates}</b></li>
    <li>отправок в системе: <b>${why.shipments}</b></li>
    ${line(why.noCity,'нет ни одной отправки в этот город — её нужно создать')}
    ${line(why.whUnknown,'склад отправки не сопоставился ни с одним городом. Назовите склад так же, как город («Астана», «Алматы»), либо добавьте город в справочник')}
    ${line(why.dateNoFit,'все отправки в этот город ушли РАНЬШЕ, чем заказ забрали — ему нужна новая')}
    ${line(why.badRoute,'маршрут не совпал: со склада Алматы эти города не возят, а отправки из Астаны нет')}
    ${line(why.tooOld,'забраны раньше выбранной даты — сдвиньте её, если их тоже надо разобрать')}
  </ul>`;
}
function intercityAssignModal(){
  // Плана два состояния — «что нашлось» и «почему нет», — и оба зависят от выбранной даты.
  // Поэтому тело окна строим функцией и перерисовываем при смене даты, не закрывая окно.
  const money=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  let plan=intercityPlanAssign();
  const dateBar=()=>`<div class="filters" style="margin:0 0 12px">
      <label class="date-field"><span>Заказы забором с</span>
        <input type="date" id="icAssignFrom" value="${esc(icAssignFromDate())}" max="${esc(localToday())}"></label>
      <span class="hint" style="align-self:center">Отправку под заказ ищем в пределах
        ${INTERCITY_BACKLOG_MAX_DAYS} дней после забора, самую раннюю подходящую.</span>
    </div>`;
  const render=()=>{
    const box=document.querySelector('.modal-body');
    if(box){box.innerHTML=bodyHtml();bind();}
    const ttl=document.querySelector('.modal-head h3');
    if(ttl)ttl.textContent=`Разложить по отправкам · ${totalAdd()} заказов`;
    const sv=document.querySelector('[data-save]');
    if(sv)sv.disabled=!totalAdd();
  };
  const bind=()=>{
    const f=$('icAssignFrom');
    if(f)f.onchange=e=>{icAssignFrom=e.target.value||'';plan=intercityPlanAssign();render();};
  };
  const totalAdd=()=>plan.rows.reduce((a,r)=>a+r.add.length,0);
  const bodyHtml=()=>{
    const {rows,skipped,why}=plan;
    if(!totalAdd())return dateBar()+
      `<div class="big" style="margin-bottom:6px">Ни один заказ не лёг в существующие отправки</div>
       <p class="hint" style="margin:0">Вот по каким причинам:</p>
       ${intercityWhyHtml(why,skipped)}`;
    return dateBar()+`
    <p class="hint" style="margin-bottom:12px">Заказы уехали, но к коробкам их не приписали.
      Ниже — куда каждый из них встанет. <b>Стоимость коробки делится на число заказов</b>,
      поэтому доля каждого заказа в этих отправках уменьшится — включая те, что уже в них.
      Калькуляция за эти месяцы изменится.</p>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Отправка</th><th>Город</th><th>Сумма коробки</th><th>Было заказов</th><th>Станет</th><th>За заказ: было → станет</th>
    </tr></thead><tbody>
      ${rows.map(r=>{
        const was=(r.ship.order_ids||[]).length, will=was+r.add.length;
        const cost=parseFloat(r.ship.box_cost)||0;
        const perWas=was?Math.round(cost/was):0, perWill=will?Math.round(cost/will):0;
        return `<tr>
          <td data-label="Отправка">${esc(fmtDate(r.ship.ship_date))}<small class="cell-time">${esc(warehouseName(r.ship.warehouse_id))}</small></td>
          <td data-label="Город">${esc(courierCityName(r.ship.dest_city_id))}</td>
          <td data-label="Сумма коробки">${money(cost)}</td>
          <td data-label="Было заказов">${was}</td>
          <td data-label="Станет"><b>${will}</b> <span style="color:var(--moss)">+${r.add.length}</span></td>
          <td data-label="За заказ">${money(perWas)} → <b>${money(perWill)}</b></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>
    ${skipped.length?`<p class="hint" style="margin-top:12px">Останутся без отправки: <b>${skipped.length}</b> заказов.
      Почему:</p>${intercityWhyHtml(why,skipped)}`:''}`;
  };
  showModal(`Разложить по отправкам · ${totalAdd()} заказов`,bodyHtml(),async()=>{
    const rows=plan.rows, n=totalAdd();
    if(!n){toast('Раскладывать нечего');return false;}
    if(!confirm(`Приписать ${n} заказов к ${rows.length} отправкам?\n\nДоля за заказ в них пересчитается, и прибыль за эти месяцы изменится.`))return false;
    let okCnt=0,errCnt=0;
    for(const r of rows){
      const ids=[...new Set([...(r.ship.order_ids||[]),...r.add.map(o=>o.id)])];
      const cost=parseFloat(r.ship.box_cost)||0;
      const per=ids.length?Math.round(cost/ids.length):0;
      const saved=await dbUpdate('shipments',r.ship.id,{order_ids:ids,per_order:per});
      if(!saved){errCnt+=r.add.length;continue;}
      Object.assign(r.ship,saved);
      // Пересчитываем ВСЕ заказы коробки, а не только добавленные: у старых доля тоже стала
      // другой. Сумма — по всем коробкам заказа, у транзитного их две.
      await syncOrderFreight(ids);
      for(const oid of ids){
        await dbUpdate('orders',oid,{intercity_shipment_id:r.ship.id});
        const o=(S.orders||[]).find(x=>x.id===oid);if(o)o.intercity_shipment_id=r.ship.id;
      }
      okCnt+=r.add.length;
    }
    await logAction('update','shipments',{entity_label:'раскладка непривязанных',
      meta:{orders:okCnt,shipments:rows.length,errors:errCnt}});
    toast(errCnt?`Разложено ${okCnt}, с ошибками ${errCnt}`:`Разложено заказов: ${okCnt}`,6000);
    renderIntercity();return true;
  },{wide:true,saveLabel:'Разложить'});
  bind();  // поле даты живёт внутри окна — привязываем после того, как оно нарисовано
}
