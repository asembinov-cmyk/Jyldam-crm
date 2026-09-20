

/* ============ ЧАСТЬ 3 — ЗАКАЗЫ ИЗ KET (входящие) ============ */
// сравнение технических названий (ket_sku) без учёта регистра и лишних пробелов
function normKetSku(s){return String(s||'').trim().toLowerCase();}
// у одного товара может быть НЕСКОЛЬКО тех-названий KET (разные листинги одного и того же товара) —
// храним их в одном текстовом поле ket_sku через запятую/точку с запятой/перенос строки
function productKetSkuList(p){
  return String((p&&p.ket_sku)||'').split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean);
}
// добавляет новый код к уже сохранённым у товара кодам, без дублей и без потери старых значений
function mergeKetSku(existing,newCode){
  if(!newCode)return existing||'';
  const list=productKetSkuList({ket_sku:existing});
  const norm=normKetSku(newCode);
  if(list.some(c=>normKetSku(c)===norm))return existing||''; // такой код уже есть
  list.push(newCode.trim());
  return list.join(', ');
}
// автоматическая привязка ещё не привязанных позиций заказов КЕТ к товарам —
// по совпадению технического названия (ket_sku), который прописан в карточке товара.
// Нужна, потому что первичная привязка на сервере срабатывает только в момент прихода заказа;
// если тех-название прописали в товар ПОЗЖЕ — старые заказы сами не обновятся без этого прохода.
// пачками по N параллельно — быстрее, чем строго по одному, но не создаёт сотен запросов одновременно
async function runInBatches(list,batchSize,worker){
  for(let i=0;i<list.length;i+=batchSize){
    await Promise.all(list.slice(i,i+batchSize).map(worker));
  }
}
// ТОЧЕЧНАЯ привязка ЧЕРЕЗ БАЗУ — единственно надёжная.
//
// ЗАЧЕМ ИМЕННО ТАК. Прежняя версия искала позиции в S.inbound_items, то есть только среди
// заказов, загруженных в память ЭТОЙ вкладки. А «Заказы партнёров» грузятся лениво: по
// умолчанию только сегодняшние. Отсюда и жалоба «прописал тех.названия, а заказам не
// присвоилось»: если модуль KET в этой вкладке не открывали — в памяти пусто и привязывать
// не к чему; если открывали — привязывались только свежие заказы, старые не трогались
// никогда. Молча: сообщение показывалось лишь когда привязалось хоть что-то.
//
// Теперь ищем в базе по самим тех-названиям, независимо от того, что загружено на экране.
// Заодно отпала необходимость тянуть ради привязки всю историю (36 тысяч заказов).
//
// Регистр не важен: сравниваем через ilike, значения берём в кавычки — в кодах встречаются
// дефисы и подчёркивания, а запятая и скобки ломали бы синтаксис запроса.
async function matchInboundItemsForCodes(productId,ketSkuCodes){
  if(!productId||!ketSkuCodes||!ketSkuCodes.length)return 0;
  const codes=[...new Set(ketSkuCodes.map(c=>String(c||'').trim()).filter(Boolean))]
    .filter(c=>!/[,()"]/.test(c));   // такие коды в or-запрос не положить — их пропускаем
  if(!codes.length)return 0;
  const orderIds=new Set();
  let matched=0;
  try{
    const CH=40;
    for(let i=0;i<codes.length;i+=CH){
      const or=codes.slice(i,i+CH).map(c=>`ket_sku.ilike."${c}"`).join(',');
      const {data,error}=await sb.from('inbound_order_items').select('id,inbound_order_id')
        .is('product_id',null).or(or);
      if(error){console.error('match: поиск позиций',error);return matched;}
      const ids=(data||[]).map(r=>r.id);
      (data||[]).forEach(r=>orderIds.add(r.inbound_order_id));
      for(let j=0;j<ids.length;j+=200){
        const part=ids.slice(j,j+200);
        const {error:uErr}=await sb.from('inbound_order_items')
          .update({product_id:productId,matched:true}).in('id',part);
        if(uErr){console.error('match: привязка позиций',uErr);return matched;}
        matched+=part.length;
        // подтягиваем и локальные копии, если эти позиции сейчас на экране
        part.forEach(id=>{const it=(S.inbound_items||[]).find(x=>x.id===id);
          if(it){it.product_id=productId;it.matched=true;}});
      }
    }
    if(orderIds.size)await refreshInboundMatchStatus([...orderIds]);
  }catch(e){console.error('matchInboundItemsForCodes',e);}
  return matched;
}
// Проставляем заказам «привязан», если у них не осталось ни одной непривязанной позиции.
// Тоже по базе: заказ мог быть загружен не в этой вкладке.
async function refreshInboundMatchStatus(orderIds){
  for(let i=0;i<orderIds.length;i+=200){
    const part=orderIds.slice(i,i+200);
    const {data,error}=await sb.from('inbound_order_items')
      .select('inbound_order_id,product_id,matched').in('inbound_order_id',part);
    if(error){console.error('match: сверка заказов',error);return;}
    const bad=new Set();   // заказы, где ещё осталось непривязанное
    (data||[]).forEach(r=>{if(!r.matched||!r.product_id)bad.add(r.inbound_order_id);});
    const done=part.filter(id=>!bad.has(id));
    if(!done.length)continue;
    const {error:uErr}=await sb.from('inbound_orders').update({match_status:'matched'}).in('id',done);
    if(uErr){console.error('match: отметка заказов',uErr);return;}
    done.forEach(id=>{const o=(S.inbound_orders||[]).find(x=>x.id===id);if(o)o.match_status='matched';});
  }
}
// СТАРАЯ версия той же привязки — по памяти вкладки. Оставлена только для полного прохода
// autoMatchInboundItems, который вызывается после явной полной загрузки истории.
async function matchInboundItemsInMemory(productId,ketSkuCodes){
  if(!productId||!ketSkuCodes||!ketSkuCodes.length||!S.inbound_items||!S.inbound_items.length)return 0;
  const normSet=new Set(ketSkuCodes.map(normKetSku));
  const toMatch=S.inbound_items.filter(it=>!(it.matched&&it.product_id)&&it.ket_sku&&normSet.has(normKetSku(it.ket_sku)));
  if(!toMatch.length)return 0;
  let matchedCount=0;
  await runInBatches(toMatch,20,async it=>{
    const upd=await dbUpdate('inbound_order_items',it.id,{product_id:productId,matched:true});
    if(upd){Object.assign(it,upd);matchedCount++;}
  });
  // проверяем на «весь заказ теперь привязан» только те заказы, которых реально коснулись —
  // не все заказы в системе, как делала полная версия
  const affectedOrderIds=new Set(toMatch.map(it=>it.inbound_order_id));
  const itemsByOrder=new Map();
  S.inbound_items.forEach(it=>{
    if(!affectedOrderIds.has(it.inbound_order_id))return;
    if(!itemsByOrder.has(it.inbound_order_id))itemsByOrder.set(it.inbound_order_id,[]);
    itemsByOrder.get(it.inbound_order_id).push(it);
  });
  const ordersToFlip=(S.inbound_orders||[]).filter(order=>{
    if(!affectedOrderIds.has(order.id)||order.match_status==='matched')return false;
    const its=itemsByOrder.get(order.id);
    return its&&its.length>0&&!its.some(x=>!x.matched||!x.product_id);
  });
  await runInBatches(ordersToFlip,20,async order=>{
    const upd=await dbUpdate('inbound_orders',order.id,{match_status:'matched'});
    if(upd)Object.assign(order,upd);
  });
  return matchedCount;
}
async function autoMatchInboundItems(){
  if(!S.inbound_items||!S.inbound_items.length)return 0;
  let matchedCount=0;
  if(S.products&&S.products.length){
    const byKetSku=new Map();
    S.products.forEach(p=>{productKetSkuList(p).forEach(code=>byKetSku.set(normKetSku(code),p));});
    if(byKetSku.size){
      const toMatch=S.inbound_items.filter(it=>!(it.matched&&it.product_id)&&it.ket_sku&&byKetSku.has(normKetSku(it.ket_sku)));
      if(toMatch.length>50)toast(`Привязываем ${toMatch.length} позиций к товарам, это может занять немного времени…`);
      await runInBatches(toMatch,20,async it=>{
        const prod=byKetSku.get(normKetSku(it.ket_sku));
        const upd=await dbUpdate('inbound_order_items',it.id,{product_id:prod.id,matched:true});
        if(upd){Object.assign(it,upd);matchedCount++;}
      });
    }
  }
  // сверяем ВСЕ заказы (не только тронутые в этом запуске) — иначе если позиции привязались, а флажок
  // заказа по какой-то причине не обновился раньше, это расхождение никогда само не исправится.
  // Группируем позиции по заказу ОДИН раз (O(items)) вместо повторного полного скана на каждый заказ
  // (O(orders × items) — именно это раньше подвешивало вкладку при большом числе заказов).
  const itemsByOrder=new Map();
  S.inbound_items.forEach(it=>{
    if(!itemsByOrder.has(it.inbound_order_id))itemsByOrder.set(it.inbound_order_id,[]);
    itemsByOrder.get(it.inbound_order_id).push(it);
  });
  const ordersToFlip=(S.inbound_orders||[]).filter(order=>{
    if(order.match_status==='matched')return false;
    const its=itemsByOrder.get(order.id);
    return its&&its.length>0&&!its.some(x=>!x.matched||!x.product_id);
  });
  await runInBatches(ordersToFlip,20,async order=>{
    const upd=await dbUpdate('inbound_orders',order.id,{match_status:'matched'});
    if(upd)Object.assign(order,upd);
  });
  return matchedCount;
}
let _inboundFullHistory=false; // false = грузим только последние N дней (быстро), true = вся история (по запросу)
const INBOUND_DEFAULT_DAYS=60;
function inboundSinceISO(){const d=new Date();d.setDate(d.getDate()-INBOUND_DEFAULT_DAYS);return d.toISOString();}
// по умолчанию модуль показывает только СЕГОДНЯШНИЕ заказы — тянуть сразу всё смысла нет, это и
// была основная нагрузка. «Все даты» (или явный выбор дат в фильтре) переключает на прежнее
// поведение (последние 60 дней / полная история). Обе границы — по местному дню, как и остальная
// система (localToday()).
let _inboundTodayOnly=true;
function inboundTodayStartISO(){return new Date(localToday()+'T00:00:00').toISOString();}
function inboundTomorrowStartISO(){const d=new Date(localToday()+'T00:00:00');d.setDate(d.getDate()+1);return d.toISOString();}
// есть ли активный поиск/фильтр — при них нужен полный набор данных, постраничная подгрузка отключается
function inboundHasActiveFilters(){return !!(inbFilter.q||inbFilter.partner||inbFilter.delivery||inbFilter.status||inbFilter.callStatus||inbFilter.statusKz||inbFilter.dateFrom||inbFilter.dateTo);}
// если активен ТОЛЬКО диапазон дат (без остальных фильтров) — можно обойтись быстрым серверным
// запросом по этому диапазону, не выкачивая всю историю целиком. Остальные фильтры (поиск,
// партнёр, статусы) требуют полной загрузки для локального сопоставления.
function inboundOnlyDateFilterActive(){
  return !!(inbFilter.dateFrom||inbFilter.dateTo)
    &&!(inbFilter.q||inbFilter.partner||inbFilter.delivery||inbFilter.status||inbFilter.callStatus||inbFilter.statusKz);
}
// границы для серверного запроса created_at — явный диапазон дат из фильтра, иначе «сегодня»,
// иначе последние N дней / вся история
/* ---- ФИЛЬТРАЦИЯ НА СТОРОНЕ БАЗЫ ----
   Раньше любой фильтр включал полную загрузку: 36 тысяч заказов и 87 тысяч позиций,
   десятки мегабайт в память, только чтобы отобрать полсотни строк в браузере.
   Теперь то, что выражается запросом, считает база, и качается одна страница.
   Всё, что запросом не выражается (партнёр — он вычисляется через состав заказа,
   склад, звонки, переведённые на русский статусы), по-прежнему требует полной
   загрузки. Лучше честно подождать, чем показать неполный список. */
// фильтр по колонке → поле в базе. Поля, которых тут нет, запросом не выражаются.
const INB_SERVER_COL={
  client:['client'], phone:['phone'], city:['city'], index:['index'],
  logistics_operator:['logistics_operator'], sender_ip:['sender_ip'], kz_code:['kz_code'],
  external_id:['external_id','source'],   // в интерфейсе это одна колонка из двух полей
};
function inboundNeedsFullLoad(){
  if(inbFilter.partner)return true;                    // партнёр — только через состав заказа
  for(const key in inbColFilters){
    if((inbColFilters[key]||'').trim()&&!INB_SERVER_COL[key])return true;
  }
  return false;
}
// экранируем то, что PostgREST разбирает как разделители внутри or(...)
function inbEsc(v){return String(v).replace(/[(),*]/g,' ').trim();}
// накладываем на запрос всё, что можно посчитать в базе
function inboundApplyServerFilters(q){
  const b=inboundQueryDateBounds();
  if(b.gte)q=q.gte('created_at',b.gte);
  if(b.lt)q=q.lt('created_at',b.lt);
  if(inbFilter.status)q=q.eq('send_status',inbFilter.status);
  if(inbFilter.callStatus)q=q.eq('call_status',inbFilter.callStatus);
  if(inbFilter.statusKz)q=q.eq('status_kz',inbFilter.statusKz);
  // тип доставки: курьерская — индекса нет, почтовая — индекс заполнен
  if(inbFilter.delivery==='courier')q=q.is('index',null);
  else if(inbFilter.delivery==='mail')q=q.not('index','is',null);
  // фильтры по колонкам — вхождение подстроки без учёта регистра
  for(const key in inbColFilters){
    const val=inbEsc(inbColFilters[key]||'');
    const cols=INB_SERVER_COL[key];
    if(!val||!cols)continue;
    if(cols.length===1)q=q.ilike(cols[0],'%'+val+'%');
    else q=q.or(cols.map(c=>`${c}.ilike.%${val}%`).join(','));
  }
  // общий поиск: несколько значений через пробел/запятую — подходит совпавший с любым.
  // Телефон в базе хранится цифрами, поэтому для запроса с цифрами ищем ещё и по ним:
  // иначе вставленный '+7 701 234 56 78' не нашёл бы ничего.
  const qs=(inbFilter.q||'').trim();
  if(qs){
    const terms=qs.split(/[\s,;]+/).filter(Boolean).map(inbEsc).filter(Boolean);
    const parts=[];
    for(const t of terms){
      parts.push(`external_id.ilike.%${t}%`,`client.ilike.%${t}%`,`phone.ilike.%${t}%`);
      const digits=t.replace(/\D/g,'');
      if(digits.length>=4)parts.push(`phone.ilike.%${digits}%`);
    }
    // Отдельно — цифры ВСЕЙ строки целиком. Иначе вставленный '+7 701 234 56 78'
    // распадается на куски по пробелам и по телефону не находится. Раньше это
    // спасалось тем, что поиск шёл ещё и по отформатированному телефону.
    const allDigits=qs.replace(/\D/g,'');
    if(allDigits.length>=6){
      const tail=allDigits.slice(-10);      // в базе телефон хранится без кода страны
      parts.push(`phone.ilike.%${tail}%`);
    }
    if(parts.length)q=q.or(parts.join(','));
  }
  return q;
}

// Фильтр изменился. Если его умеет посчитать база — перезапрашиваем первую страницу
// и счётчики (несколько килобайт). Если нет (партнёр, склад, звонки) — грузим всё
// целиком, как раньше: лучше подождать, чем показать неполный список.
async function inboundApplyFilterChange(){
  inbPage=1;
  inbSelectAll=false;
  if(S.inbound_full_loaded)return;          // всё уже в памяти — отберём локально
  if(inboundNeedsFullLoad()){
    toast('Загружаем весь список для фильтра…');
    try{await loadInbound({full:true});}catch(e){}
    return;
  }
  _inboundPageCache.clear();                // страницы считались по прежним условиям
  try{
    await loadInboundCounts();
    const pg=await loadInboundPage(1);
    S.inbound_orders=pg.orders;S.inbound_items=pg.items;
  }catch(e){console.error('inboundApplyFilterChange',e);}
}
function inboundQueryDateBounds(){
  if(inbFilter.dateFrom||inbFilter.dateTo){
    const gte=inbFilter.dateFrom?new Date(inbFilter.dateFrom+'T00:00:00').toISOString():null;
    const lt=inbFilter.dateTo?(()=>{const d=new Date(inbFilter.dateTo+'T00:00:00');d.setDate(d.getDate()+1);return d.toISOString();})():null;
    return {gte,lt};
  }
  if(_inboundTodayOnly)return {gte:inboundTodayStartISO(),lt:inboundTomorrowStartISO()};
  if(!_inboundFullHistory)return {gte:inboundSinceISO(),lt:null};
  return {gte:null,lt:null};
}
let _inboundCounts={total:0,courier:0,mail:0,unmatched:0}; // точные счётчики с сервера (для карточек статистики и пагинации в быстром режиме)
let _inboundPageCache=new Map(); // page → {orders,items}, чтобы не перезапрашивать уже открытую страницу
async function loadInboundCounts(){
  // счётчики считаем по тем же условиям, что и сам список — иначе «Всего» не сойдётся
  const build=()=>inboundApplyServerFilters(sb.from('inbound_orders').select('id',{count:'exact',head:true}));
  try{
    const [tot,cou,mai]=await Promise.all([build(),build().is('index',null),build().not('index','is',null)]);
    _inboundCounts={total:tot.count||0,courier:cou.count||0,mail:mai.count||0};
  }catch(e){console.error('loadInboundCounts',e);}
}
// отдельный лёгкий счётчик «всего в системе за всё время», не завязан на текущий режим/фильтр —
// запускается один раз при открытии модуля, показывается в уголке для общей картины
let _inboundAllTimeTotal=null;
async function loadInboundAllTimeTotal(){
  try{
    const {count}=await sb.from('inbound_orders').select('id',{count:'exact',head:true});
    _inboundAllTimeTotal=count||0;
  }catch(e){console.error('loadInboundAllTimeTotal',e);}
}
// быстрая загрузка ОДНОЙ страницы прямо с сервера (без выкачивания всей таблицы) — то, что открывает
// модуль почти мгновенно, даже когда заказов уже многие тысячи. Теперь используется и когда
// активен ТОЛЬКО фильтр по дате — не нужно из-за него выкачивать всю историю целиком.
async function loadInboundPage(page){
  if(_inboundPageCache.has(page))return _inboundPageCache.get(page);
  const from=(page-1)*inbPerPage,to=from+inbPerPage-1;
  try{
    let q=sb.from('inbound_orders').select('*').order('created_at',{ascending:false}).range(from,to);
    q=inboundApplyServerFilters(q);   // даты, статусы, поиск — считает база, а не браузер
    const {data:orders,error}=await q;
    if(error)throw error;
    const ids=(orders||[]).map(o=>o.id);
    let items=[];
    if(ids.length){
      const {data:itemsData,error:ierr}=await sb.from('inbound_order_items').select('*').in('inbound_order_id',ids);
      if(!ierr)items=itemsData||[];
    }
    const pg={orders:orders||[],items};
    _inboundPageCache.set(page,pg);
    return pg;
  }catch(e){console.error('loadInboundPage',e);return {orders:[],items:[]};}
}
// переход на страницу — если весь список ещё не загружен целиком и фильтров нет, подгружаем ровно
// нужную страницу с сервера; если уже есть полный набор (или включён поиск/фильтр) — просто нарезаем locally
async function gotoInboundPage(page){
  inbPage=Math.max(1,page);
  const dateOnly=inboundOnlyDateFilterActive()&&!inboundColFiltersActive();
  if(!S.inbound_full_loaded&&(!inboundHasActiveFilters()||dateOnly)){
    const pg=await loadInboundPage(inbPage);
    S.inbound_orders=pg.orders;S.inbound_items=pg.items;
    // привязка тут больше не запускается — она либо уже произошла при сохранении товара
    // (см. matchInboundItemsForCodes), либо подхватится фоновой подстраховкой полной загрузки
  }
  drawInboundOrders();
  const t=$('inboundTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
}
async function loadInbound(opts){
  opts=opts||{};
  const full=opts.full!=null?opts.full:_inboundFullHistory;
  _inboundFullHistory=full;
  try{
    const gteOpt=full?{}:{gte:{col:'created_at',val:inboundSinceISO()}};
    const [orders,partners]=await Promise.all([
      dbList('inbound_orders',Object.assign({order:'created_at',asc:false},gteOpt)),
      dbList('inbound_partners',{order:'partner_name'}).catch(()=>[]),
    ]);
    S.inbound_orders=orders||[];S.inbound_partners=partners||[];
    // позиции состава тянем ПО ID уже отфильтрованных заказов, а не по собственной дате — у самих
    // позиций нет поля created_at, и раньше сюда ошибочно применялся тот же date-фильтр, что и для
    // заказов — запрос падал и тихо возвращал пусто (отсюда «Непривязанные коды» показывали пустоту)
    const ids=(orders||[]).map(o=>o.id);
    let items=[];
    if(ids.length){
      const CHUNK=500;      // пачками — чтобы не упереться в лимит размера IN-списка на больших объёмах
      const PARALLEL=6;     // ...но сами пачки шлём по 6 одновременно: браузер держит ~6 соединений
      // Раньше здесь был последовательный цикл с await внутри: на 36 тысячах заказов это
      // 73 запроса строго один за другим, то есть десятки секунд ожидания на ровном месте.
      const chunks=[];
      for(let i=0;i<ids.length;i+=CHUNK)chunks.push(ids.slice(i,i+CHUNK));
      for(let i=0;i<chunks.length;i+=PARALLEL){
        const batch=chunks.slice(i,i+PARALLEL);
        const results=await Promise.all(batch.map(chunkIds=>
          sb.from('inbound_order_items').select('*').in('inbound_order_id',chunkIds)
        ));
        for(const {data,error} of results){
          if(error){console.error('loadInbound items chunk',error);continue;}
          if(data)items=items.concat(data);
        }
      }
    }
    S.inbound_items=items;
    S.inbound_full_loaded=true;
    _inboundPageCache.clear();
    // автопривязка товаров может быть ДОЛГОЙ, если накопилось много позиций (сотни/тысячи —
    // каждая требует отдельного запроса на сохранение). При простом открытии вкладки это не должно
    // блокировать сам заход в модуль — запускаем в фоне, не дожидаясь. Дожидаемся только там, где
    // результат реально нужен сразу (после импорта/привязки товара, в «Непривязанных кодах»).
    if(opts.skipMatch){autoMatchInboundItems().catch(e=>console.error('autoMatch bg',e));}
    else{await autoMatchInboundItems();}
  }catch(e){S.inbound_orders=[];S.inbound_items=[];S.inbound_partners=[];S.inbound_full_loaded=false;}
}
// «звонковый» статус (statuses) — новое измерение, которого раньше не было в вебхуке KET.
// Ожидаем, что придёт под каким-то полем в inbound_orders — уточнить у бэкенда точное имя поля,
// когда его реально начнут присылать (см. пометку внизу файла/чат).
const KET_CALL_STATUS={
  '0':'Новая','1':'Подтверждён','2':'Отменён','3':'Перезвонить','4':'Недозвон','5':'Брак',
  '6':'Уже получил заказ','7':'Чёрный список','8':'Заказано у конкурентов',
  '10':'Недозвон (ночь)','11':'Предварительно подтверждён',
};
const KET_SEND_STATUS={
  '0':'Отправлен','4':'Отказ','5':'Оплачен','6':'На отправку','7':'Отклонено',
  '8':'Архив АБЦ','9':'Оплачена ТС (отказ)','10':'Полная предоплата','11':'Частичная предоплата',
};
const KET_STATUS_KZ={
  '0':'Обработка','1':'Отложенная доставка','2':'На доставку','4':'Упакован на почте','5':'Заберёт',
  '6':'Упакован','7':'Хранение','8':'Упакован принят','9':'Обратная доставка отправлена','10':'Груз вручён',
  '11':'Груз в дороге','13':'Получен','14':'Нет товара','15':'Располовинен','16':'Проверен','17':'Свежий',
  '18':'Автоответчик','19':'Перезвонить','20':'Сделать замену','21':'Возврат денег','22':'На контроль',
  '23':'Упакован добавочный','24':'Частичный возврат','25':'Оплачена транспортировка','26':'Нет товара (свежий)',
  '27':'Возврат на складе','28':'Дожим партнёрами','29':'Вручить подарок','30':'Получит почтой',
  '40':'В работе у робота','41':'Отправить на Тастамат','42':'Передан в Тастамат','43':'Забронирован в Тастамат',
  '44':'Вложена в Тастамат','45':'Выкуп из Тастамата','46':'Невыкуп из Тастамата','47':'Не вложена (Тастамат)',
  '48':'Ожидает счёт',
};
// статус почтового возврата — новое поле, ещё нет в базе. Ожидаем 2 значения от бэкенда/KET
// (см. пометку про SQL/уточнение поля ниже, тот же принцип, что и с call_status/calls_total).
const KET_RETURN_STATUS={'0':'Принятие на почте','1':'Возврат по системе'};
function ketReturnLabel(s){return s==null||s===''?'—':(KET_RETURN_STATUS[String(s)]||String(s));}
function ketCallLabel(s){return s==null||s===''?'—':(KET_CALL_STATUS[String(s)]||('код '+s));}
function ketSendLabel(s){return s==null||s===''?'—':(KET_SEND_STATUS[String(s)]||('код '+s));}
function ketKzLabel(s){return s==null||s===''?'—':(KET_STATUS_KZ[String(s)]||('код '+s));}
async function renderInboundOrders(){
  if(!isAdmin()&&!canMod('ket_orders')){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  // открытие модуля: по умолчанию показываем только СЕГОДНЯШНИЕ заказы — тянуть больше смысла нет
  // (это и было основной нагрузкой). Более широкий набор подгружается только когда реально нужен —
  // при поиске/фильтре (см. redraw() ниже) или по явному нажатию «Все даты».
  if(!S.inbound_orders){
    $('main').innerHTML='<div class="page-head"><div><h1>Заказы партнёров</h1><p>Входящие заказы, полученные от KET и партнёров</p></div></div><div class="panel"><div class="empty"><div class="big">Загрузка…</div></div></div>';
    try{
      if(!S.inbound_partners)S.inbound_partners=await dbList('inbound_partners',{order:'partner_name'}).catch(()=>[]);
      await loadInboundCounts();
      const pg=await loadInboundPage(1);
      S.inbound_orders=pg.orders;S.inbound_items=pg.items;
      // раньше здесь всегда гонялась полная привязка — теперь основная привязка происходит
      // точечно при сохранении товара (см. matchInboundItemsForCodes), а тут уже не нужна на
      // каждый заход
    }catch(e){S.inbound_orders=[];S.inbound_items=[];}
    drawInboundOrders();
    // лёгкий счётчик «всего в системе за всё время» — один быстрый count-запрос, не тянет сами
    // заказы, только для уголка статистики
    loadInboundAllTimeTotal().then(()=>{if(S.tab==='ket_orders')drawInboundOrders();}).catch(()=>{});
    return;
  }
  drawInboundOrders();
}
function inboundItemsFor(orderId){
  // используем общий справочник «позиции по заказу», если он уже построен для текущей отрисовки —
  // иначе (редкие разовые вызовы, например открытие карточки одного заказа) строим на лету
  if(_inboundLookups)return _inboundLookups.itemsByOrder.get(orderId)||[];
  return (S.inbound_items||[]).filter(it=>it.inbound_order_id===orderId);
}
function inboundPartnerName(id){return ((S.inbound_partners||[]).find(p=>p.id===id)||{}).partner_name||'—';}
// быстрые справочники для определения партнёра заказа — строятся ОДИН РАЗ перед показом/фильтрацией
// таблицы, а не заново перебором всех позиций/товаров под КАЖДУЮ строку (раньше именно это и было
// причиной тормозов: на каждую строку — полный перебор тысяч позиций и тысяч товаров)
let _inboundLookups=null;
function refreshInboundLookups(){
  const itemsByOrder=new Map();
  (S.inbound_items||[]).forEach(it=>{
    let arr=itemsByOrder.get(it.inbound_order_id);
    if(!arr){arr=[];itemsByOrder.set(it.inbound_order_id,arr);}
    arr.push(it);
  });
  const productById=new Map();
  (S.products||[]).forEach(p=>productById.set(p.id,p));
  _inboundLookups={itemsByOrder,productById};
}
// магазин (партнёр склада), которому принадлежит заказ КЕТ — определяем через привязанные товары
// (в самом заказе от KET магазин не передаётся, только состав по кодам ket_sku)
function inboundOrderShopIds(o){
  const ids=new Set();
  const productById=_inboundLookups?_inboundLookups.productById:null;
  inboundItemsFor(o.id).forEach(it=>{
    if(!it.matched||!it.product_id)return;
    const p=productById?productById.get(it.product_id):(S.products||[]).find(x=>x.id===it.product_id);
    if(p&&p.partner_id)ids.add(p.partner_id);
  });
  return [...ids];
}
function inboundOrderShopLabel(o){
  const ids=inboundOrderShopIds(o);
  if(!ids.length)return inboundItemsFor(o.id).length?'ещё не привязан':'—';
  return ids.map(whPartnerName).join(', ');
}
// тип доставки входящего заказа KET: явного поля нет, определяем по признаку —
// если указан почтовый индекс, считаем почтовой доставкой, иначе курьерской
function inboundDeliveryType(o){return o.index?'mail':'courier';}
function inboundDeliveryLabel(o){return inboundDeliveryType(o)==='mail'?'Почтовая':'Курьерская';}
let inbFilter={q:'',partner:'',delivery:'',status:'',callStatus:'',statusKz:'',dateFrom:'',dateTo:''};
let inbPage=1;      // текущая страница пагинации заказов КЕТ
let inbPerPage=50;  // заказов КЕТ на страницу
const inbSelected=new Set(); // id выбранных заказов КЕТ (для массовых действий, живёт между страницами)
let inbSelectAll=false;      // отмечены ли «все на всех страницах»
function filteredInbound(){
  refreshInboundLookups();
  const q=inbFilter.q.toLowerCase().trim();
  return (S.inbound_orders||[]).filter(o=>{
    if(inbFilter.partner&&!inboundOrderShopIds(o).includes(inbFilter.partner))return false;
    if(inbFilter.delivery&&inboundDeliveryType(o)!==inbFilter.delivery)return false;
    if(inbFilter.status&&String(o.send_status||'')!==inbFilter.status)return false;
    if(inbFilter.callStatus&&String(o.call_status||'')!==inbFilter.callStatus)return false;
    if(inbFilter.statusKz&&String(o.status_kz||'')!==inbFilter.statusKz)return false;
    const cd=(o.created_at||'').slice(0,10);
    if(inbFilter.dateFrom&&(!cd||cd<inbFilter.dateFrom))return false;
    if(inbFilter.dateTo&&(!cd||cd>inbFilter.dateTo))return false;
    // фильтры по отдельным колонкам (клик на заголовок столбца)
    for(const key in inbColFilters){
      const val=(inbColFilters[key]||'').toLowerCase().trim();
      if(!val)continue;
      const col=INB_COLUMNS.find(c=>c.key===key);if(!col)continue;
      if(!col.text(o).toLowerCase().includes(val))return false;
    }
    if(q){
      const hay=[o.external_id,o.client,o.phone,phoneDisplay(o.phone)].join(' ').toLowerCase();
      // можно вставить сразу много ID — через пробел, запятую, точку с запятой или с новой строки;
      // подходит заказ, совпавший хотя бы с одним из вставленных значений
      const terms=q.split(/[\s,;]+/).filter(Boolean);
      if(!terms.some(t=>hay.includes(t)))return false;
    }
    return true;
  }).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
}
// таблица кодов справочника для документации (переиспользует те же константы, что и сам код —
// значит расхождений между документацией и реальными справочниками быть не может)
function ketDocsStatusTable(dict){
  return `<table class="resp-table" style="margin:8px 0"><thead><tr><th style="width:60px">Код</th><th>Значение</th></tr></thead><tbody>
    ${Object.entries(dict).map(([code,label])=>`<tr><td><code>${esc(code)}</code></td><td>${esc(label)}</td></tr>`).join('')}
  </tbody></table>`;
}
// диагностика: показать, каких именно тех.кодов не хватает среди товаров, и сколько заказов на них висит —
// вместо того чтобы просто показывать общую цифру «N заказов не привязано»
async function inboundUnmatchedModal(){
  if(!S.inbound_full_loaded||!_inboundFullHistory){
    toast('Загружаем весь список, чтобы проверить все заказы…');
    try{await loadInbound({full:true});}catch(e){toast('Не удалось загрузить полный список');return;}
  }
  const items=(S.inbound_items||[]).filter(it=>!it.matched||!it.product_id);
  if(!items.length){showInfo('Непривязанные коды','<div class="empty">Все позиции по всем заказам КЕТ привязаны к товарам. 🎉</div>');return;}
  const byCode=new Map(); // code -> {code, orders:Set, qty}
  items.forEach(it=>{
    const code=(it.ket_sku||'').trim()||'(пусто)';
    if(!byCode.has(code))byCode.set(code,{code,orders:new Set(),qty:0});
    const g=byCode.get(code);
    g.orders.add(it.inbound_order_id);g.qty+=(it.qty||1);
  });
  const rows=[...byCode.values()].sort((a,b)=>b.orders.size-a.orders.size);
  const totalOrders=new Set(items.map(it=>it.inbound_order_id)).size;
  const body=`
    <div class="hint" style="margin-bottom:10px">Заказов, где есть хотя бы одна непривязанная позиция: <b>${totalOrders}</b>. Уникальных кодов, для которых нет товара: <b>${rows.length}</b>.</div>
    <div class="table-scroll" style="max-height:60vh;overflow-y:auto"><table class="resp-table"><thead><tr>
      <th>Код (ket_sku)</th><th>Заказов</th><th>Суммарно шт.</th>
    </tr></thead><tbody>
    ${rows.map(r=>`<tr><td><code>${esc(r.code)}</code></td><td>${r.orders.size}</td><td>${r.qty}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="hint" style="margin-top:10px">Это коды, которых нет ни у одного товара в «Склад → Товары» (поле «Коды KET»). Заведите товар с таким кодом (или добавьте код существующему товару) — привязка произойдёт автоматически при следующей загрузке/обновлении.</div>`;
  showInfo('Непривязанные коды',body,{wide:true});
}
function partnerApiDocsModal(){
  const body=`
  <div style="max-height:70vh;overflow-y:auto;line-height:1.55">
    <p class="hint">Приём заказов напрямую от обычного партнёра «Заказов заборов» (не КЕТ) — через Edge Function <code>receive-order-direct</code>.</p>

    <h3 class="calc-h">1. Общая схема</h3>
    <p>Партнёр присылает POST-запрос с готовыми данными заказа (ФИО получателя, телефон, адрес, город, размер). Сервер сам находит или создаёт <b>сегодняшнюю заявку на забор</b> этого партнёра и создаёт в ней готовый заказ — вручную ничего создавать не нужно.</p>
    <p class="hint" style="color:var(--rust)">⚠️ Код самой Edge Function фронтенд CRM не видит и не редактирует — правки только через деплой файла напрямую в Supabase.</p>

    <h3 class="calc-h">2. Авторизация</h3>
    <p>Отдельный секретный токен на каждого партнёра — выдаётся в карточке партнёра («Партнёры» → нужный партнёр → блок «Приём заказов по API» → кнопка «Выдать токен»). В базе хранится только хеш токена, сам токен показывается один раз в момент выдачи.</p>

    <h3 class="calc-h">3. Формат запроса (JSON, POST)</h3>
    <pre style="background:#f5f5f7;padding:10px;border-radius:8px;font-size:12px;overflow-x:auto">{
  "secret": "токен партнёра",
  "client": "ФИО получателя",
  "phone": "телефон получателя",
  "address": "адрес доставки",
  "city": "город доставки (должен совпадать с курьерским городом в CRM)",
  "size": "S | M | L (необязательно, по умолчанию S)",
  "external_id": "свой ID заказа у партнёра (рекомендуется — защита от задвоения)",
  "comment": "любой комментарий (необязательно)"
}</pre>

    <h3 class="calc-h">4. Что происходит на сервере</h3>
    <p>1) Проверка токена. 2) Проверка обязательных полей. 3) Если пришёл повторно тот же <code>external_id</code> от этого же партнёра — заказ не дублируется, возвращается уже существующий. 4) Поиск сегодняшней заявки этого партнёра (по <code>partner_id</code>+<code>pickup_date</code>) — если нет, создаётся новая. 5) Город доставки ищется в справочнике «Курьерские города» по названию. 6) Сумма заказа считается по тарифу партнёра, той же сеткой S/M/L, что и везде в CRM. 7) Заказ помечается <code>via_integration=true</code> — в «Заказы заборов» такие заказы выделены <b>голубым</b> цветом (заявки по QR — жёлтым).</p>

    <h3 class="calc-h">5. Ответ</h3>
    <p><b>Успех:</b> <code>{"success": true, "order_id": "...", "order_code": "...", "pickup_id": "..."}</code></p>
    <p><b>Ошибка:</b> <code>{"success": false, "error": "текст"}</code></p>

    <h3 class="calc-h">6. Известные ограничения</h3>
    <p>Город доставки должен буква в букву (без учёта регистра) совпадать с названием в справочнике «Курьерские города» — иначе запрос отклоняется с ошибкой. Нет доступа к коду Edge Function — все выводы о её поведении сделаны по тому, что она должна делать по постановке задачи.</p>
  </div>`;
  showInfo('Документация: API «Заказы заборов»',body,{wide:true});
}
function ketDocsModal(){
  const body=`
  <div style="max-height:70vh;overflow-y:auto;line-height:1.55">
    <p class="hint">Актуально на: август 2026. Как CRM принимает, хранит и обрабатывает данные, полученные от KET.</p>

    <h3 class="calc-h">1. Общая схема</h3>
    <p>Заказы попадают в CRM через серверную часть — <b>Edge Function «receive-order»</b> (Supabase), которая принимает вебхук от KET и пишет данные в две таблицы: <code>inbound_orders</code> (сам заказ) и <code>inbound_order_items</code> (состав заказа).</p>
    <p class="hint" style="color:var(--rust)">⚠️ Код самой Edge Function фронтенд CRM не видит и не редактирует. Всё, что касается приёма вебхука на бэкенде, нужно сверять отдельно с тем, кто вёл «receive-order».</p>

    <h3 class="calc-h">2. Таблица inbound_orders</h3>
    <p>Ключевые поля: <code>external_id</code> (номер заказа в KET), <code>client</code>, <code>phone</code>, <code>city</code>, <code>index</code> (по нему определяется тип доставки), <code>send_status</code>, <code>status_kz</code>, <code>call_status</code> (новое, см. п.4), <code>match_status</code>, <code>stock_written</code>, <code>raw</code> (сырой JSON от KET).</p>
    <p><b>Магазин (партнёр)</b>, которому принадлежит заказ, в самом заказе от KET не передаётся — вычисляется через привязанные товары: позиция состава → <code>product_id</code> → у товара есть <code>partner_id</code>. Если ни одна позиция не привязана — «ещё не привязан».</p>

    <h3 class="calc-h">3. Поле raw (сырой payload)</h3>
    <p>Проверено через SQL — в <code>raw</code> есть только: <code>addr, city, name, index, offer, phone, price, secret, country, order_id, total_price</code>. Идентификатора магазина там нет.</p>

    <h3 class="calc-h">4. Справочники статусов</h3>
    <p>У заказа KET <b>три независимых измерения статуса</b> — не связаны друг с другом, обновляются независимо.</p>

    <h4 style="margin:14px 0 4px">4.1 «Звонковый» статус — <code>call_status</code> <span style="color:var(--rust)">(НОВОЕ, с августа 2026)</span></h4>
    <p class="hint" style="color:var(--rust)">⚠️ Требует действий от бэкенда: 1) выполнить <code>alter table inbound_orders add column if not exists call_status integer;</code> 2) Edge Function должна записывать сюда значение, которое KET присылает под именем <code>status</code> (или другим — сверить с реальным телом вебхука).</p>
    ${ketDocsStatusTable(KET_CALL_STATUS)}
    <p class="hint">Код 9 в присланном списке отсутствовал — уточнить у KET, не пропущен ли.</p>

    <h4 style="margin:14px 0 4px">4.2 Статус отправки — <code>send_status</code></h4>
    ${ketDocsStatusTable(KET_SEND_STATUS)}

    <h4 style="margin:14px 0 4px">4.3 Статус посылки — <code>status_kz</code></h4>
    ${ketDocsStatusTable(KET_STATUS_KZ)}

    <h3 class="calc-h">5. Определение типа доставки</h3>
    <p>Явного поля от KET нет. Определяется по наличию почтового индекса: если заполнен <code>index</code> → почтовая, иначе — курьерская.</p>

    <h3 class="calc-h">6. Привязка товаров (ket_sku)</h3>
    <p>У позиции состава есть <code>ket_sku</code> (тех-название KET) и <code>qty</code>. У товара в справочнике «Товары» поле <code>ket_sku</code> может содержать несколько кодов через запятую (один товар = несколько тех-названий/листингов). Автопривязка запускается при каждой загрузке «Заказов КЕТ» и при сохранении товара с новым кодом. Когда у заказа привязаны все позиции — статус заказа автоматически становится «matched».</p>

    <h3 class="calc-h">7. Обновление в реальном времени</h3>
    <p>С августа 2026 таблица <code>inbound_orders</code> подключена к Supabase Realtime — изменения применяются во всех открытых сессиях CRM мгновенно. Плюс фоновая подстраховка — обновление раз в 30 секунд.</p>
    <p class="hint" style="color:var(--rust)">⚠️ Это реально работает как «онлайн», только если запись в базе меняется при смене статуса у KET: либо KET шлёт вебхук на каждое изменение и «receive-order» делает UPDATE существующей строки (не только INSERT), либо нужна отдельная фоновая задача на бэкенде, которая сама периодически опрашивает статус.</p>

    <h3 class="calc-h">8. Известные ограничения</h3>
    <p>Полный жизненный цикл статуса невыкупа для вечерней сверки с курьерами — не реализован, только базовые справочники и отображение. Нет доступа к коду Edge Function «receive-order» — все выводы о её поведении сделаны по тому, какие поля читает и ожидает фронтенд.</p>
  </div>`;
  showInfo('Документация: интеграция с KET',body,{wide:true});
}
// описание колонок грида «Заказы партнёров» — по одному месту для порядка/фильтра/перетаскивания колонок
const INB_COLUMNS=[
  {key:'external_id',label:'Штрих-код заказа',text:o=>(o.external_id||'')+' '+(o.source||''),
    cell:o=>`<td data-label="Штрих-код заказа"><strong>${esc(o.external_id||'—')}</strong><div class="wh-cat">${esc(o.source||'')}</div></td>`},
  {key:'created_at',label:'Дата',text:o=>fmtDate(o.created_at),
    cell:o=>`<td data-label="Дата">${esc(fmtDate(o.created_at))}${o.created_at?`<small class="cell-time">${esc((fmtLogTime(o.created_at)||{}).time||'')}</small>`:''}</td>`},
  {key:'client',label:'Клиент',text:o=>o.client||'',cell:o=>`<td data-label="Клиент">${esc(o.client||'—')}</td>`},
  {key:'phone',label:'Телефон',text:o=>o.phone||'',cell:o=>`<td data-label="Телефон">${o.phone?phoneLink(o.phone):'—'}</td>`},
  {key:'city',label:'Город',text:o=>o.city||'',cell:o=>`<td data-label="Город">${esc(o.city||'—')}</td>`},
  {key:'index',label:'Индекс',text:o=>o.index||'',cell:o=>`<td data-label="Индекс">${esc(o.index||'—')}</td>`},
  {key:'weight',label:'Вес',text:o=>o.weight!=null?String(o.weight):'',cell:o=>`<td data-label="Вес">${o.weight?esc(o.weight)+' кг':'—'}</td>`},
  {key:'amount',label:'Сумма',text:o=>{const a=o.price!=null?o.price:o.total_price;return a!=null?String(a):'';},
    cell:o=>{const a=o.price!=null?o.price:o.total_price;return `<td data-label="Сумма">${a!=null?Math.round(+a).toLocaleString('ru-RU'):'—'}</td>`;}},
  {key:'delivery',label:'Доставка',text:o=>inboundDeliveryLabel(o),
    cell:o=>`<td data-label="Доставка"><span class="pill ${inboundDeliveryType(o)==='mail'?'gold':'moss'}">${esc(inboundDeliveryLabel(o))}</span></td>`},
  {key:'shop',label:'Партнёр',text:o=>inboundOrderShopLabel(o),cell:o=>`<td data-label="Партнёр">${esc(inboundOrderShopLabel(o))}</td>`},
  {key:'ket_status',label:'Статус KET',text:o=>[ketSendLabel(o.send_status),ketKzLabel(o.status_kz),o.call_status!=null?ketCallLabel(o.call_status):''].join(' '),
    cell:o=>`<td data-label="Статус KET"><div style="font-size:12px">${esc(ketSendLabel(o.send_status))}</div><div class="wh-cat">${esc(ketKzLabel(o.status_kz))}</div>${o.call_status!=null?`<div class="wh-cat">☎ ${esc(ketCallLabel(o.call_status))}</div>`:''}</td>`},
  {key:'return_status',label:'Статус почт. возврата',text:o=>o.return_status!=null?ketReturnLabel(o.return_status):'',
    cell:o=>`<td data-label="Статус почт. возврата">${o.return_status!=null?esc(ketReturnLabel(o.return_status)):'—'}</td>`},
  {key:'calls_total',label:'Всего звонков',text:o=>o.calls_total!=null?String(o.calls_total):'',cell:o=>`<td data-label="Всего звонков">${o.calls_total!=null?esc(o.calls_total):'—'}</td>`},
  {key:'calls_today',label:'Звонков сегодня',text:o=>o.calls_today!=null?String(o.calls_today):'',cell:o=>`<td data-label="Звонков сегодня">${o.calls_today!=null?esc(o.calls_today):'—'}</td>`},
  {key:'logistics_operator',label:'Оператор логистики',text:o=>o.logistics_operator||'',cell:o=>`<td data-label="Оператор логистики">${esc(o.logistics_operator||'—')}</td>`},
  {key:'sender_ip',label:'Отправитель ИП',text:o=>o.sender_ip||'',cell:o=>`<td data-label="Отправитель ИП">${esc(o.sender_ip||'—')}</td>`},
  {key:'kz_code',label:'Трек номер',text:o=>o.kz_code||'',cell:o=>`<td data-label="Трек номер">${esc(o.kz_code||'—')}</td>`},
  {key:'stock',label:'Склад',text:o=>o.stock_written?'списан':'',
    cell:o=>`<td data-label="Склад">${o.stock_written?'<span class="ket-badge" style="background:#e6f4ea;color:#1a7f37">списан</span>':'<span class="wh-cat">—</span>'}</td>`},
];
// порядок колонок — можно перетаскивать мышкой, запоминаем в браузере
let inbColOrder=(()=>{try{const saved=JSON.parse(localStorage.getItem('inbColOrder_v2')||'null');
  if(Array.isArray(saved)&&saved.length===INB_COLUMNS.length&&saved.every(k=>INB_COLUMNS.some(c=>c.key===k)))return saved;}catch(e){}
  return INB_COLUMNS.map(c=>c.key);})();
function inbColumnsInOrder(){return inbColOrder.map(k=>INB_COLUMNS.find(c=>c.key===k)).filter(Boolean);}
// ширины столбцов — можно тянуть за правый край мышкой, запоминаем в браузере
const INB_COL_DEFAULT_WIDTHS={external_id:160,created_at:130,client:150,phone:150,city:110,index:90,
  weight:90,amount:110,delivery:130,shop:170,ket_status:170,return_status:170,calls_total:110,
  calls_today:120,logistics_operator:170,sender_ip:150,kz_code:150,stock:110};
let inbColWidths=(()=>{try{return JSON.parse(localStorage.getItem('inbColWidths')||'{}')||{};}catch(e){return {};}})();
function inbColWidth(key){return inbColWidths[key]||INB_COL_DEFAULT_WIDTHS[key]||140;}
// фильтр по клику на конкретную колонку — {key: текст фильтра}
let inbColFilters={};
function inboundColFiltersActive(){return Object.values(inbColFilters).some(v=>v);}
// текущая открытая функция закрытия попапа (если есть) — единый трекер на весь модуль. Раньше при
// открытии второго фильтра (на другом столбце) первый лишь удалялся из DOM через querySelectorAll,
// но его обработчик на document НЕ снимался и продолжал висеть — на любой следующий клик где угодно
// он срабатывал и перерисовывал весь грид заново (отсюда «кидает в начало» и «поиск работает раз»).
let _inbColFilterClose=null;
// всплывающий фильтр по конкретной колонке — открывается по клику на заголовок столбца.
// Крепится прямо к самому заголовку (position:relative на th + position:absolute на попап) —
// не «улетает» в угол экрана, как было раньше с фиксированными координатами.
function openInboundColFilter(th,key){
  if(_inbColFilterClose){_inbColFilterClose();_inbColFilterClose=null;}
  document.querySelectorAll('.inb-col-filter-pop').forEach(p=>p.remove());
  const col=INB_COLUMNS.find(c=>c.key===key);
  const pop=document.createElement('div');
  pop.className='inb-col-filter-pop';
  if(key==='delivery'){
    // «Доставка» — не свободный текст, а выбор из двух вариантов (тот же фильтр, что и в строке фильтров сверху)
    pop.innerHTML=`<div class="inb-col-filter-box">
      <select id="inbColFilterSelect">
        <option value="">Все</option>
        <option value="courier" ${inbFilter.delivery==='courier'?'selected':''}>Курьерская</option>
        <option value="mail" ${inbFilter.delivery==='mail'?'selected':''}>Почтовая</option>
      </select>
    </div>`;
    th.appendChild(pop);
    const sel=pop.querySelector('#inbColFilterSelect');
    sel.focus();
    const applyDelivery=async(val)=>{
      inbFilter.delivery=val;
      await inboundApplyFilterChange();
      drawInboundOrders();
    };
    // единая функция закрытия — вызывается ЛЮБЫМ способом (выбор варианта, клик мимо), всегда
    // снимает и попап, и обработчик на document. Раньше отдельные пути закрытия не всегда снимали
    // обработчик, из-за чего он «зависал» и мешал следующему открытию фильтра.
    let closed=false;
    const close=(apply)=>{
      if(closed)return;closed=true;
      pop.remove();
      document.removeEventListener('click',onDocClick,{capture:true});
      if(_inbColFilterClose===close)_inbColFilterClose=null;
      if(apply)applyDelivery(sel.value);
    };
    function onDocClick(ev){if(!pop.contains(ev.target)&&ev.target!==th)close(true);}
    sel.onchange=()=>close(true);
    document.addEventListener('click',onDocClick,{capture:true});
    _inbColFilterClose=close;
    return;
  }
  pop.innerHTML=`<div class="inb-col-filter-box">
    <input type="text" id="inbColFilterInput" placeholder="Поиск по «${esc(col?col.label:'')}»…" value="${esc(inbColFilters[key]||'')}">
    ${inbColFilters[key]?'<button type="button" class="btn sm ghost" id="inbColFilterClear">✕</button>':''}
  </div>`;
  th.appendChild(pop);
  const inp=pop.querySelector('#inbColFilterInput');
  inp.focus();inp.select();
  const apply=async(val)=>{
    inbColFilters[key]=val;
    if(!val)delete inbColFilters[key];
    await inboundApplyFilterChange();
    drawInboundOrders();
  };
  // единая функция закрытия — Escape/Enter/крестик/клик мимо все идут через неё, обработчик на
  // document всегда корректно снимается, не остаётся «висеть» до следующего клика
  let closed=false;
  const close=(doApply)=>{
    if(closed)return;closed=true;
    pop.remove();
    document.removeEventListener('click',onDocClick,{capture:true});
    if(_inbColFilterClose===close)_inbColFilterClose=null;
    if(doApply)apply(inp.value.trim());
  };
  function onDocClick(ev){if(!pop.contains(ev.target)&&ev.target!==th)close(true);}
  inp.onkeydown=e=>{if(e.key==='Enter')close(true);if(e.key==='Escape')close(false);};
  const clearBtn=pop.querySelector('#inbColFilterClear');
  if(clearBtn)clearBtn.onclick=()=>{inp.value='';close(true);};
  document.addEventListener('click',onDocClick,{capture:true});
  _inbColFilterClose=close;
}
function drawInboundOrders(){
  // если попап фильтра по столбцу ещё «числится» открытым (например, перерисовка вызвана не через
  // штатное закрытие попапа) — сначала аккуратно закрываем его, чтобы не остался висеть обработчик
  // на document, который иначе будет мешать следующему открытию/закрытию
  if(_inbColFilterClose){const c=_inbColFilterClose;_inbColFilterClose=null;try{c(false);}catch(e){}}
  refreshInboundLookups();
  const anyFilter=inboundHasActiveFilters()||inboundColFiltersActive();
  // если единственный активный фильтр — диапазон дат (без остальных полей, без фильтров по
  // столбцу) — можно оставаться в быстром постраничном режиме, сервер сам применит эти границы
  const dateOnlyFilter=inboundOnlyDateFilterActive()&&!inboundColFiltersActive();
  // Быстрый постраничный режим держится теперь не на «фильтров нет» и не только на диапазоне
  // дат: почти всё, что вводит пользователь, умеет посчитать база. Полная загрузка нужна лишь
  // для того, что запросом не выразить (см. inboundNeedsFullLoad).
  const lazy=!S.inbound_full_loaded&&!inboundNeedsFullLoad();
  const list=S.inbound_orders||[]; // в быстром режиме — только текущая страница; иначе — весь (отфильтрованный по дате) набор
  const allRows=lazy?list:filteredInbound();
  const totalCount=lazy?_inboundCounts.total:allRows.length;
  const courierCount=lazy?_inboundCounts.courier:allRows.filter(o=>inboundDeliveryType(o)==='courier').length;
  const mailCount=lazy?_inboundCounts.mail:allRows.filter(o=>inboundDeliveryType(o)==='mail').length;
  // пагинация — как в «Заказах» и «Заявках на забор»
  const totalPages=Math.max(1,Math.ceil(totalCount/inbPerPage));
  if(inbPage>totalPages)inbPage=totalPages;
  if(inbPage<1)inbPage=1;
  const startIdx=(inbPage-1)*inbPerPage;
  const rows=lazy?allRows:allRows.slice(startIdx,startIdx+inbPerPage); // в быстром режиме страница уже готова с сервера
  const admin=isAdmin()||can('ket_orders','delete');
  if(inbSelectAll)allRows.forEach(o=>inbSelected.add(o.id));
  const colCount=19+(admin?1:0);
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Заказы партнёров</h1><p>Входящие заказы, полученные от KET и партнёров</p></div>
      <div class="head-actions" style="margin-left:auto">
        <button class="btn ghost sm" id="inbUnmatched" title="Показать, каких товаров не хватает">🔍 Непривязанные коды</button>
        <button class="btn btn-excel" id="inbExportXlsx">⬇ Выгрузить Excel</button>
        <button class="btn ghost sm" id="inbPrintWaybills">🖨 Накладные (курьер)</button>
        <button class="btn ghost sm" id="inbPrintLabels">🖨 Печать бланков (почта)</button>
      </div></div>
    <div class="stats stats-4">
      <div class="stat"><div class="k">Заказов сегодня</div><div class="v">${totalCount}</div></div>
      <div class="stat"><div class="k">Курьерских заказов</div><div class="v">${courierCount}</div></div>
      <div class="stat"><div class="k">Почтовых заказов</div><div class="v">${mailCount}</div></div>
      <div class="stat"><div class="k">Всего в системе</div><div class="v">${_inboundAllTimeTotal!=null?_inboundAllTimeTotal:'…'}</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Список заказов КЕТ</h2><span class="count">${anyFilter?(allRows.length+' / '+totalCount):totalCount}</span>
        ${admin&&inbSelected.size?`<button class="btn danger sm" id="inbDelSel" style="margin-left:auto">✕ Удалить выбранные (${inbSelected.size})</button>`:''}</div>
        ${lazy?`<div class="hint" style="margin:0 20px 8px;color:var(--muted)">${dateOnlyFilter?'Показаны заказы за выбранный период':(_inboundTodayOnly?'Показаны заказы только за сегодня':'Показаны последние '+INBOUND_DEFAULT_DAYS+' дней')} — страницы подгружаются по одной с сервера</div>`:''}
      <div class="filters">
        <input class="search" id="inbq" placeholder="Поиск: № заказа, ФИО, телефон… (можно вставить сразу несколько через пробел)" value="${esc(inbFilter.q)}">
        <select id="inbpartner"><option value="">Все партнёры</option>${[...(S.warehouse_partners||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>`<option value="${p.id}" ${inbFilter.partner===p.id?'selected':''}>${esc(p.name||'—')}</option>`).join('')}</select>
        <select id="inbdelivery"><option value="">Все типы доставки</option>
          <option value="courier" ${inbFilter.delivery==='courier'?'selected':''}>Курьерская</option>
          <option value="mail" ${inbFilter.delivery==='mail'?'selected':''}>Почтовая</option></select>
        <select id="inbstatus"><option value="">Все статусы</option>${Object.entries(KET_SEND_STATUS).map(([code,label])=>`<option value="${code}" ${inbFilter.status===code?'selected':''}>${esc(label)}</option>`).join('')}</select>
        <select id="inbstatuskz"><option value="">Все статусы посылки</option>${Object.entries(KET_STATUS_KZ).map(([code,label])=>`<option value="${code}" ${inbFilter.statusKz===code?'selected':''}>${esc(label)}</option>`).join('')}</select>
        <select id="inbcallstatus"><option value="">Все звонковые</option>${Object.entries(KET_CALL_STATUS).map(([code,label])=>`<option value="${code}" ${inbFilter.callStatus===code?'selected':''}>${esc(label)}</option>`).join('')}</select>
      </div>
      <div class="filters filters-dates">
        <span class="fdate-lbl">Дата прихода заказа:</span>
        <input type="date" id="inbdatefrom" value="${esc(inbFilter.dateFrom)}" title="С даты">
        <input type="date" id="inbdateto" value="${esc(inbFilter.dateTo)}" title="По дату">
        <button class="btn ghost sm ${_inboundTodayOnly&&!inbFilter.dateFrom&&!inbFilter.dateTo?'active':''}" id="inbToday">Сегодня</button>
        <button class="btn ghost sm ${!_inboundTodayOnly&&S.inbound_full_loaded?'active':''}" id="inbAllDates">Все даты</button>
        ${anyFilter?`<button class="btn ghost sm" id="inbclear" style="align-self:flex-end">Сбросить фильтры</button>`:''}
      </div>
      <div class="table-scroll" id="inboundTable"><table class="resp-table inb-table"><colgroup>${admin?'<col style="width:34px">':''}${inbColumnsInOrder().map(c=>`<col style="width:${inbColWidth(c.key)}px">`).join('')}<col style="width:160px"></colgroup><thead><tr>
        ${admin?'<th style="width:34px"><input type="checkbox" id="inbChkAll" title="Выбрать все"></th>':''}
        ${inbColumnsInOrder().map(c=>{const active=c.key==='delivery'?!!inbFilter.delivery:!!inbColFilters[c.key];
          return `<th draggable="true" class="inb-th ${active?'inb-th-filtered':''}" data-colkey="${c.key}" title="Перетащите, чтобы переставить · нажмите, чтобы найти по столбцу">${esc(c.label)}${active?' 🔎':''}<span class="inb-col-resize" data-inbresize="${c.key}"></span></th>`;}).join('')}
        <th></th>
      </tr></thead><tbody>
      ${rows.length?rows.map(o=>{
        return `<tr data-inbrow="${o.id}" style="cursor:pointer">
          ${admin?`<td onclick="event.stopPropagation()"><input type="checkbox" class="inbChk" data-inbchk="${o.id}" ${inbSelected.has(o.id)?'checked':''}></td>`:''}
          ${inbColumnsInOrder().map(c=>c.cell(o)).join('')}
          <td data-label="" class="cell-actions"><div class="row-actions">
            ${admin?`<button class="btn sm danger" data-inbdel="${o.id}">Удалить</button>`:''}
          </div></td>
        </tr>`;
      }).join(''):`<tr><td colspan="${colCount}"><div class="empty"><div class="big">${list.length?'Ничего не найдено':'Пока нет заказов из KET'}</div>${list.length?'Измените фильтры.':'Заказы появятся здесь, когда KET начнёт их присылать.'}</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  $('main').querySelectorAll('[data-inbdel]').forEach(b=>b.onclick=()=>delInboundOrder(b.dataset.inbdel));
  // двойной клик по строке — открыть карточку заказа (одиночный клик по кнопкам/чекбоксу не мешает)
  $('main').querySelectorAll('[data-inbrow]').forEach(tr=>tr.ondblclick=e=>{
    if(e.target.closest('button,input,select,a'))return;
    inboundOrderModal(tr.dataset.inbrow);
  });
  if(admin){
    $('main').querySelectorAll('.inbChk').forEach(c=>c.onchange=()=>{
      const id=c.dataset.inbchk;
      if(c.checked)inbSelected.add(id);else{inbSelected.delete(id);inbSelectAll=false;}
      updateInbAllChk(allRows);
    });
    const chkAll=$('inbChkAll');
    if(chkAll)chkAll.onchange=e=>{
      if(e.target.checked){inbSelectAll=true;allRows.forEach(o=>inbSelected.add(o.id));}
      else{inbSelectAll=false;allRows.forEach(o=>inbSelected.delete(o.id));}
      drawInboundOrders();
    };
    updateInbAllChk(allRows);
    if($('inbDelSel'))$('inbDelSel').onclick=()=>delInboundOrdersBulk();
  // список, с которым работают массовые действия: приоритет — отмеченные галочкой, иначе — весь текущий фильтр
  const inboundActionList=()=>inbSelected.size?allRows.filter(o=>inbSelected.has(o.id)):filteredInbound();
  if($('inbPrintLabels'))$('inbPrintLabels').onclick=async()=>{
    const mailOnly=inboundActionList().filter(o=>inboundDeliveryType(o)==='mail');
    if(!mailOnly.length){toast(inbSelected.size?'Среди отмеченных нет почтовых заказов':'Нет почтовых заказов по текущим фильтрам');return;}
    const btn=$('inbPrintLabels');const origLabel=btn.textContent;btn.disabled=true;btn.textContent='Готовим PDF…';
    try{await printInboundMailLabelsPdf(mailOnly);}
    catch(e){console.error(e);toast('Не удалось сформировать бланки: '+(e&&e.message||e));}
    finally{btn.disabled=false;btn.textContent=origLabel;}
  };
  if($('inbToday'))$('inbToday').onclick=async()=>{
    const btn=$('inbToday');btn.disabled=true;
    _inboundTodayOnly=true;S.inbound_full_loaded=false;_inboundPageCache.clear();
    inbFilter.dateFrom='';inbFilter.dateTo='';inbPage=1;
    try{await loadInboundCounts();const pg=await loadInboundPage(1);S.inbound_orders=pg.orders;S.inbound_items=pg.items;}
    catch(e){}
    finally{if(btn)btn.disabled=false;drawInboundOrders();}
  };
  if($('inbAllDates'))$('inbAllDates').onclick=async()=>{
    const btn=$('inbAllDates');btn.disabled=true;btn.textContent='Загружаем всю историю…';
    _inboundTodayOnly=false;
    try{await loadInbound({full:true});inbPage=1;drawInboundOrders();toast('Загружена вся история');}
    finally{if(btn){btn.disabled=false;btn.textContent='Все даты';}}
  };
  if($('inbUnmatched'))$('inbUnmatched').onclick=async()=>{
    const btn=$('inbUnmatched');
    const origText=btn.textContent;
    btn.disabled=true;btn.textContent='⏳ Проверяем…';
    try{await inboundUnmatchedModal();}
    finally{if(btn){btn.disabled=false;btn.textContent=origText;}}
  };
  if($('inbExportXlsx'))$('inbExportXlsx').onclick=()=>exportInboundToExcel(inboundActionList());
  if($('inbPrintWaybills'))$('inbPrintWaybills').onclick=async()=>{
    const courierOnly=inboundActionList().filter(o=>inboundDeliveryType(o)==='courier');
    if(!courierOnly.length){toast(inbSelected.size?'Среди отмеченных нет курьерских заказов':'Нет курьерских заказов по текущим фильтрам');return;}
    const btn=$('inbPrintWaybills');const origLabel=btn.textContent;btn.disabled=true;btn.textContent='Готовим PDF…';
    try{await printInboundWaybillsPdf(courierOnly);}
    catch(e){console.error(e);toast('Не удалось сформировать накладные: '+(e&&e.message||e));}
    finally{btn.disabled=false;btn.textContent=origLabel;}
  };
  }
  renderInboundPager(totalCount,totalPages,startIdx,rows.length);
  const redraw=async()=>{
    const active=document.activeElement;const fid=active&&active.id;const pos=active&&active.selectionStart;
    await inboundApplyFilterChange();
    drawInboundOrders();
    if(fid){const el=$(fid);if(el){el.focus();try{el.setSelectionRange(pos,pos);}catch(e){}}}
  };
  if($('inbq'))$('inbq').oninput=e=>{inbFilter.q=e.target.value;redraw();};
  if($('inbpartner'))$('inbpartner').onchange=e=>{inbFilter.partner=e.target.value;redraw();};
  if($('inbdelivery'))$('inbdelivery').onchange=e=>{inbFilter.delivery=e.target.value;redraw();};
  if($('inbstatus'))$('inbstatus').onchange=e=>{inbFilter.status=e.target.value;redraw();};
  if($('inbcallstatus'))$('inbcallstatus').onchange=e=>{inbFilter.callStatus=e.target.value;redraw();};
  if($('inbstatuskz'))$('inbstatuskz').onchange=e=>{inbFilter.statusKz=e.target.value;redraw();};
  if($('inbdatefrom'))$('inbdatefrom').onchange=e=>{inbFilter.dateFrom=e.target.value;_inboundTodayOnly=false;redraw();};
  if($('inbdateto'))$('inbdateto').onchange=e=>{inbFilter.dateTo=e.target.value;_inboundTodayOnly=false;redraw();};
  if($('inbclear'))$('inbclear').onclick=()=>{inbFilter={q:'',partner:'',delivery:'',status:'',callStatus:'',statusKz:'',dateFrom:'',dateTo:''};inbColFilters={};inbPage=1;inbSelectAll=false;drawInboundOrders();};
  // перетаскивание заголовков столбцов мышкой — меняет порядок колонок, запоминается в браузере
  let _inbDragKey=null,_inbDidDrag=false;
  $('main').querySelectorAll('.inb-th').forEach(th=>{
    th.ondragstart=e=>{
      // если тянут именно за ручку изменения ширины — это не перетаскивание столбца
      if(e.target.classList.contains('inb-col-resize')){e.preventDefault();return;}
      _inbDragKey=th.dataset.colkey;_inbDidDrag=false;e.dataTransfer.effectAllowed='move';th.classList.add('inb-th-dragging');
    };
    th.ondragend=()=>{th.classList.remove('inb-th-dragging');$('main').querySelectorAll('.inb-th').forEach(x=>x.classList.remove('inb-th-over'));};
    th.ondragover=e=>{e.preventDefault();if(th.dataset.colkey!==_inbDragKey)th.classList.add('inb-th-over');};
    th.ondragleave=()=>th.classList.remove('inb-th-over');
    th.ondrop=e=>{
      e.preventDefault();th.classList.remove('inb-th-over');
      const toKey=th.dataset.colkey;
      if(!_inbDragKey||_inbDragKey===toKey)return;
      _inbDidDrag=true;
      const from=inbColOrder.indexOf(_inbDragKey),to=inbColOrder.indexOf(toKey);
      if(from<0||to<0)return;
      inbColOrder.splice(from,1);inbColOrder.splice(to,0,_inbDragKey);
      try{localStorage.setItem('inbColOrder_v2',JSON.stringify(inbColOrder));}catch(e2){}
      drawInboundOrders();
    };
    // клик по заголовку (не после перетаскивания) — фильтр по этому столбцу
    th.onclick=()=>{
      if(_inbDidDrag){_inbDidDrag=false;return;}
      openInboundColFilter(th,th.dataset.colkey);
    };
    // ручка изменения ширины — тянем мышкой вправо/влево, как в Excel
    const handle=th.querySelector('.inb-col-resize');
    if(handle)handle.onmousedown=ev=>{
      ev.preventDefault();ev.stopPropagation();
      const key=handle.dataset.inbresize;
      const startX=ev.clientX;const startW=inbColWidth(key);
      handle.classList.add('inb-resizing');
      const onMove=mv=>{
        const w=Math.max(70,startW+(mv.clientX-startX));
        inbColWidths[key]=w;
        const table=document.querySelector('#inboundTable table');
        if(table){
          const idx=inbColumnsInOrder().findIndex(c=>c.key===key);
          const offset=admin?1:0; // если есть чекбокс-колонка — сдвиг на 1
          const col=table.querySelector('colgroup').children[idx+offset];
          if(col)col.style.width=w+'px';
        }
      };
      const onUp=()=>{
        handle.classList.remove('inb-resizing');
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
        try{localStorage.setItem('inbColWidths',JSON.stringify(inbColWidths));}catch(e3){}
      };
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    };
  });
}
// плавающая панель пагинации для «Заказы КЕТ» (тот же вид, что у заказов/заявок)
function removeInboundPager(){const ex=$('inboundPager');if(ex)ex.remove();
  const m=$('main');if(m&&!$('ordersPager')&&!$('pickupsPager')&&!$('whProdPager'))m.classList.remove('has-pager');}
function renderInboundPager(total,totalPages,startIdx,shownCount){
  removeInboundPager();
  if(!total)return;
  const from=startIdx+1, to=startIdx+shownCount;
  const bar=document.createElement('div');
  bar.id='inboundPager';bar.className='orders-pager';
  {const m=$('main');if(m)m.classList.add('has-pager');}
  bar.innerHTML=`
    <button class="op-btn" id="inbFloatRefreshBtn" title="Подтянуть свежие данные">🔄</button>
    <div class="op-info">Показаны <b>${from}–${to}</b> из <b>${total}</b></div>
    <div class="op-perpage">
      <span>На странице:</span>
      <div class="op-pp-wrap">
        <button class="op-btn op-pp-btn" id="inbPerPageBtn">${inbPerPage} ▾</button>
        <div class="op-pp-menu" id="inbPerPageMenu" style="display:none">
          ${ORDERS_PAGE_SIZES.map(s=>`<button class="op-pp-item ${s===inbPerPage?'active':''}" data-inbpp="${s}">${s}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="op-nav">
      <button class="op-btn" data-inbpage="first" ${inbPage<=1?'disabled':''} title="В начало">«</button>
      <button class="op-btn" data-inbpage="prev" ${inbPage<=1?'disabled':''}>‹ Назад</button>
      <span class="op-page">Стр. ${inbPage} / ${totalPages}</span>
      <button class="op-btn" data-inbpage="next" ${inbPage>=totalPages?'disabled':''}>Вперёд ›</button>
      <button class="op-btn" data-inbpage="last" ${inbPage>=totalPages?'disabled':''} title="В конец">»</button>
    </div>`;
  document.body.appendChild(bar);
  const inbFloatRefreshBtn=bar.querySelector('#inbFloatRefreshBtn');
  if(inbFloatRefreshBtn)inbFloatRefreshBtn.onclick=async()=>{
    inbFloatRefreshBtn.disabled=true;inbFloatRefreshBtn.textContent='…';
    try{await loadInbound();drawInboundOrders();toast('Обновлено');}
    finally{if(inbFloatRefreshBtn){inbFloatRefreshBtn.disabled=false;inbFloatRefreshBtn.textContent='🔄';}}
  };
  const ppBtn=bar.querySelector('#inbPerPageBtn'), ppMenu=bar.querySelector('#inbPerPageMenu');
  if(ppBtn)ppBtn.onclick=e=>{e.stopPropagation();ppMenu.style.display=ppMenu.style.display==='none'?'flex':'none';};
  bar.querySelectorAll('[data-inbpp]').forEach(b=>b.onclick=async()=>{
    inbPerPage=parseInt(b.dataset.inbpp,10)||50;
    _inboundPageCache.clear(); // размер страницы поменялся — старый кэш страниц больше не годится
    await gotoInboundPage(1);
  });
  document.addEventListener('click',function closeInbPP(ev){
    if(ppMenu&&!ppMenu.contains(ev.target)&&ev.target!==ppBtn){ppMenu.style.display='none';}
  },{once:true});
  bar.querySelectorAll('[data-inbpage]').forEach(b=>b.onclick=async()=>{
    const a=b.dataset.inbpage;
    let target=inbPage;
    if(a==='first')target=1;
    else if(a==='prev')target=Math.max(1,inbPage-1);
    else if(a==='next')target=Math.min(totalPages,inbPage+1);
    else if(a==='last')target=totalPages;
    await gotoInboundPage(target);
  });
}
// удаление заказа КЕТ — доступно только администратору
// синхронизирует чекбокс «выбрать все» в шапке таблицы с фактическим выбором на текущей странице/фильтре
function updateInbAllChk(allRows){
  const chk=$('inbChkAll');if(!chk)return;
  const total=allRows.length;
  const selected=allRows.filter(o=>inbSelected.has(o.id)).length;
  chk.checked=total>0&&selected===total;
  chk.indeterminate=selected>0&&selected<total;
}
async function delInboundOrder(id){
  if(!isAdmin()&&!can('ket_orders','delete')){toast('Нет прав на удаление заказов партнёров');return;}
  const o=(S.inbound_orders||[]).find(x=>x.id===id);if(!o)return;
  if(!confirm(`Удалить заказ КЕТ «${o.external_id||''}»?\n\nЭто действие нельзя отменить. Остатки на складе (если уже списаны) затронуты не будут.`))return;
  const items=inboundItemsFor(id);
  for(const it of items){await dbDelete('inbound_order_items',it.id).catch(()=>{});}
  const ok=await dbDelete('inbound_orders',id);
  if(!ok){toast('Не удалось удалить заказ');return;}
  S.inbound_items=(S.inbound_items||[]).filter(it=>it.inbound_order_id!==id);
  S.inbound_orders=(S.inbound_orders||[]).filter(x=>x.id!==id);
  inbSelected.delete(id);
  logAction('delete','inbound_orders',{entity_id:id,entity_label:o.external_id||id});
  toast('Заказ КЕТ удалён');
  drawInboundOrders();
}
// массовое удаление отмеченных галочками заказов КЕТ — нужно право на удаление в модуле «Заказы партнёров»
async function delInboundOrdersBulk(){
  if(!isAdmin()&&!can('ket_orders','delete'))return;
  const ids=[...inbSelected];
  if(!ids.length)return;
  if(!confirm(`Удалить выбранные заказы КЕТ (${ids.length} шт.)?\n\nЭто действие нельзя отменить.`))return;
  let ok=0,fail=0;
  for(const id of ids){
    const o=(S.inbound_orders||[]).find(x=>x.id===id);if(!o)continue;
    const items=inboundItemsFor(id);
    for(const it of items){await dbDelete('inbound_order_items',it.id).catch(()=>{});}
    const done=await dbDelete('inbound_orders',id);
    if(done){
      S.inbound_items=(S.inbound_items||[]).filter(it=>it.inbound_order_id!==id);
      S.inbound_orders=(S.inbound_orders||[]).filter(x=>x.id!==id);
      logAction('delete','inbound_orders',{entity_id:id,entity_label:o.external_id||id});
      ok++;
    }else fail++;
  }
  inbSelected.clear();inbSelectAll=false;
  toast(`Удалено заказов: ${ok}${fail?(', с ошибкой: '+fail):''}`);
  drawInboundOrders();
}
function inboundOrderModal(id){
  const o=(S.inbound_orders||[]).find(x=>x.id===id);if(!o)return;
  const items=inboundItemsFor(id);
  const matchLine=o.match_status==='matched'
    ?'<span style="color:#1a7f37">✓ привязан</span>'
    :`<span style="color:var(--rust)">⚠ требует привязки</span> <button type="button" class="btn sm" id="inbModalMatch">Привязать</button>`;
  const body=`<div style="display:grid;gap:8px;font-size:14px">
    <div><b>Штрих-код заказа:</b> ${esc(o.external_id||'—')} <span class="wh-cat">(${esc(o.source||'')})</span></div>
    <div><b>Поступил:</b> ${o.created_at?esc(fmtDateTime(o.created_at)):'—'}</div>
    <div><b>Партнёр:</b> ${esc(inboundOrderShopLabel(o))}</div>
    <div><b>Тип доставки:</b> ${esc(inboundDeliveryLabel(o))}</div>
    <div><b>Клиент:</b> ${esc(o.client||'—')} · ${esc(o.phone||'—')}</div>
    <div><b>Адрес:</b> ${esc(o.address||'—')}</div>
    <div><b>Город / индекс:</b> ${esc(o.city||'—')} ${o.index?('· '+esc(o.index)):''}</div>
    <div><b>Вес:</b> ${o.weight?esc(o.weight)+' кг':'—'}</div>
    <div><b>Сумма:</b> ${o.price!=null?esc(o.price):'—'} ${o.total_price!=null&&o.total_price!==o.price?('(итого '+esc(o.total_price)+')'):''}</div>
    <div><b>Статус доставки:</b> ${esc(ketSendLabel(o.send_status))} · <b>Посылка:</b> ${esc(ketKzLabel(o.status_kz))}${o.call_status!=null?` · <b>Звонок:</b> ${esc(ketCallLabel(o.call_status))}`:''}</div>
    <div><b>Статус почтового возврата:</b> ${o.return_status!=null?esc(ketReturnLabel(o.return_status)):'—'}</div>
    <div><b>Звонков клиенту:</b> всего ${o.calls_total!=null?esc(o.calls_total):'—'} · сегодня ${o.calls_today!=null?esc(o.calls_today):'—'}</div>
    <div><b>Оператор логистики:</b> ${esc(o.logistics_operator||'—')}</div>
    <div><b>Отправитель ИП:</b> ${esc(o.sender_ip||'—')}</div>
    <div><b>Трек номер:</b> ${esc(o.kz_code||'—')}</div>
    <div><b>Привязка товаров:</b> ${matchLine}</div>
    <div style="margin-top:6px"><b>Состав:</b></div>
    <div style="display:grid;gap:4px">
      ${items.length?items.map(it=>`<div style="padding:6px 10px;border:1px solid var(--line);border-radius:8px">${esc(it.ket_sku||'?')} × ${it.qty} ${it.matched?'<span style="color:#1a7f37">— привязан</span>':'<span style="color:var(--rust)">— товар не найден на складе</span>'}</div>`).join(''):'<div class="wh-cat">Состав не разобран</div>'}
    </div>
    <div style="margin-top:6px"><b>Склад:</b> ${o.stock_written?('списан '+esc(fmtDate(o.stock_written_at))):'не списан'}</div>
  </div>`;
  const ov=showInfo('Заказ КЕТ '+esc(o.external_id||''),body,{wide:true});
  const mb=ov.querySelector('#inbModalMatch');
  if(mb)mb.onclick=()=>{ov.remove();inboundMatchModal(id);};
}
function inboundMatchModal(id){
  const o=(S.inbound_orders||[]).find(x=>x.id===id);if(!o)return;
  const items=inboundItemsFor(id).filter(it=>!it.matched);
  const products=[...(S.products||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const rows=items.map((it)=>`<div class="oi-row" data-mrow="${it.id}">
    <div style="flex:0 0 auto;min-width:120px"><b>${esc(it.ket_sku||'?')}</b> ×${it.qty}</div>
    <select class="oi-product" data-mprod="${it.id}"><option value="">— выберите товар склада —</option>
      ${products.map(p=>`<option value="${p.id}">${esc(p.name)}${p.ket_sku?(' ['+esc(p.ket_sku)+']'):''}</option>`).join('')}</select>
  </div>`).join('');
  const body=`<div class="hint" style="margin-bottom:10px">Сопоставьте коды KET с товарами склада. Код <b>ket_sku</b> добавится к товару (старые тех-названия не потеряются) — следующие заказы с любым из сохранённых кодов привяжутся автоматически.</div>${rows||'<div class="wh-cat">Все позиции уже привязаны.</div>'}`;
  showModal('Привязка товаров — '+esc(o.external_id||''),body,async()=>{
    let done=0;
    for(const it of items){
      const sel=document.querySelector(`[data-mprod="${it.id}"]`);
      const productId=sel?sel.value:'';
      if(!productId)continue;
      await dbUpdate('inbound_order_items',it.id,{product_id:productId,matched:true});
      const prod=(S.products||[]).find(p=>p.id===productId);
      if(prod&&it.ket_sku){
        const merged=mergeKetSku(prod.ket_sku,it.ket_sku);
        if(merged!==(prod.ket_sku||'')){await dbUpdate('products',productId,{ket_sku:merged});prod.ket_sku=merged;}
      }
      done++;
    }
    if(!done){toast('Ничего не выбрано');return false;}
    await loadInbound({full:true});
    const stillUnmatched=inboundItemsFor(id).some(it=>!it.matched);
    await dbUpdate('inbound_orders',id,{match_status:stillUnmatched?'unmatched':'matched'});
    await loadInbound({full:true});
    toast(`Привязано позиций: ${done}`);
    drawInboundOrders();
    return true;
  },{wide:true});
}

