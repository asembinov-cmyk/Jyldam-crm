/* ═══════════════════════════════════════════════════════════════════════════
   СКОЛЬКО ИСТОРИИ ЗАГРУЖАТЬ (24.11.2026)

   До этой правки при каждом входе CRM скачивала в браузер последние 51 000 заказов
   и все заявки — около 120 МБ, у каждого сотрудника, включая курьера на телефоне,
   которому нужны его заказы на сегодня. Отсюда «тормозит» и риск, что телефон
   закроет приложение из-за памяти.

   ТЕПЕРЬ ТРИ ОХВАТА:
     курьер       — только СВОИ заявки (с сегодняшнего дня) и заказы по ним и
                    назначенные на него;
     сотрудник    — последние HIST_DAYS дней;
     всё остальное — ПО ЗАПРОСУ: раздел говорит, что ему нужно (месяц, день,
                    список заказов), и недостающее догружается, пока на экране
                    честное «Загружаем…».

   ГЛАВНОЕ ПРАВИЛО: раздел, который считает ИТОГ за период, обязан спросить
   histGatePage / histGateModal / histPanelLoading ДО расчёта. Иначе он молча
   посчитает по тому, что случайно лежит в памяти, — ровно та ошибка, из-за
   которой Калькуляция за сентябрь стала неполной, когда заказов в базе стало
   больше 51 000.

   Файл подключён ПОСЛЕДНИМ намеренно: внизу он оборачивает функции разделов из
   файлов выше (renderCalc, renderDashboard и другие), а к моменту его выполнения
   все они уже объявлены.
   ═══════════════════════════════════════════════════════════════════════════ */
const HIST_DAYS=14;
/* Разделы, которым нужны ВСЕ заказы, а не только свои. Если курьеру выдан хоть один
   из них, он загружает данные как сотрудник — иначе раздел показывал бы пустоту. */
const HIST_WIDE_MODULES=['baraholka','intercity','sorting','filling','courier','mail','dashboard','calc','notify','whatsapp','telephony'];
const HIST_ERR_TTL=20000;   // через столько ошибку догрузки забываем и пробуем снова
const _hist={from:null,all:false,keys:new Set(),busy:new Map(),err:new Map(),searched:new Set()};

function histNarrow(){
  if(typeof isCourier!=='function'||!isCourier())return false;
  const p=S.myPerms||{};
  return !HIST_WIDE_MODULES.some(k=>p[k]&&p[k].view);
}
/* Местная полночь дня → отметка времени по Гринвичу: created_at в базе по UTC, а «день»
   у нас астанинский. Без этого окно начиналось бы в 05:00 по-местному. */
const histDayTs=day=>new Date(day+'T00:00:00').toISOString();
const histDayShift=(day,n)=>{const d=new Date(day+'T12:00:00');d.setDate(d.getDate()+n);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
const histFmt=day=>day?day.slice(8,10)+'.'+day.slice(5,7)+'.'+day.slice(0,4):'';
const histNextMonth=ym=>{let y=+ym.slice(0,4),m=+ym.slice(5,7)+1;if(m>12){m=1;y++;}return y+'-'+String(m).padStart(2,'0');};
const histMonthName=ym=>['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'][+ym.slice(5,7)-1]+' '+ym.slice(0,4);
const histIn=ids=>'('+ids.map(x=>'"'+String(x).replace(/"/g,'')+'"').join(',')+')';

/* ---------- что запрашивать ---------- */
function histCourierFilter(table){
  const today=localToday();
  if(table==='pickups'){
    const ids=myPickupCourierIds();
    if(!ids.length)return false;
    return q=>q.in('courier_id',ids).gte('pickup_date',today);
  }
  const parts=[];
  const oc=myOrderCourierIds();
  if(oc.length)parts.push(`and(order_courier_id.in.${histIn(oc)},created_at.gte."${histDayTs(histDayShift(today,-HIST_DAYS))}")`);
  // заказы заборщика берутся ПО ЕГО ЗАЯВКАМ: в самом заказе заборщика нет (раздел 6)
  const pk=(S.pickups||[]).map(p=>p.id).slice(0,150);
  if(pk.length)parts.push(`pickup_id.in.${histIn(pk)}`);
  if(!parts.length)return false;
  return q=>q.or(parts.join(','));
}
/* Условие запроса под текущий охват. Отдаёт функцию, null («без ограничений») или
   false («строк заведомо нет, запрос не нужен»).
   mode 'load' — первичная загрузка и полная перезагрузка: охват И окно;
   mode 'sync' — догон изменений: только охват. Окно тут не нужно и вредно — правка
   старого заказа, догруженного ради Калькуляции, должна доехать. */
function histFilter(table,mode){
  if(table!=='orders'&&table!=='pickups')return null;
  if(histNarrow())return histCourierFilter(table);
  if(mode!=='load'||_hist.all)return null;
  const day=_hist.from||histDayShift(localToday(),-HIST_DAYS);
  if(table==='pickups')return q=>q.or(`pickup_date.gte.${day},created_at.gte."${histDayTs(day)}"`);
  return q=>q.gte('created_at',histDayTs(day));
}
async function histFetch(table,mode){
  const f=histFilter(table,mode);
  if(f===false)return [];
  return dbList(table,{order:'created_at',asc:false,filter:f||undefined});
}
async function histLoadInitial(){
  if(!_hist.all&&!_hist.from)_hist.from=histDayShift(localToday(),-HIST_DAYS);
  if(histNarrow()){
    const pickups=await histFetch('pickups','load');
    S.pickups=pickups;                       // условие для заказов строится по этим заявкам
    return [pickups,await histFetch('orders','load')];
  }
  return Promise.all([histFetch('pickups','load'),histFetch('orders','load')]);
}
/* Полная перезагрузка таблицы (rtReload) выбрасывает всё догруженное по запросу —
   забываем, что оно было, и разделы спросят заново. */
function histAfterReload(){_hist.keys.clear();_hist.searched.clear();_hist.all=false;}

/* ---------- Realtime: чужое курьеру в память не кладём ---------- */
function histAccepts(key,row){
  if(!histNarrow())return true;
  if(key==='pickups'){
    const ok=myPickupCourierIds().includes(row.courier_id);
    // заявку только что назначили — её заказы уже созданы, событий по ним не будет
    if(ok&&!(S.pickups||[]).some(p=>p.id===row.id))setTimeout(()=>histPullPickupOrders(row.id),400);
    return ok;
  }
  if(key==='orders')return myOrderCourierIds().includes(row.order_courier_id)||(S.pickups||[]).some(p=>p.id===row.pickup_id);
  return true;
}
async function histPullPickupOrders(pid){
  try{
    const {data,error}=await sb.from('orders').select('*').eq('pickup_id',pid).limit(1000);
    if(error||!data||!data.length)return;
    histMerge('orders',data);
    if(typeof rtRedraw==='function')rtRedraw();
  }catch(e){console.warn('histPullPickupOrders',e&&e.message);}
}

/* ---------- догрузка по запросу ---------- */
/* Свой постраничный запрос, а не dbList: тот при сбое молча отдаёт то, что успел, и
   «месяц загружен» было бы неправдой. Здесь любая ошибка — исключение. Второй ключ
   сортировки (id) обязателен: заказы из одной заявки создаются с ОДНИМ created_at, и
   без него на границе страниц строки и теряются, и задваиваются. */
async function histPull(table,build){
  const PAGE=1000,PAR=6,MAXP=80;
  const page=(i,withCount)=>{
    let q=sb.from(table).select('*',withCount?{count:'exact'}:undefined);
    q=build(q);
    return q.order('created_at',{ascending:false}).order('id',{ascending:true}).range(i*PAGE,i*PAGE+PAGE-1);
  };
  const first=await page(0,true);
  if(first.error)throw first.error;
  let out=first.data||[];
  const pages=Math.min(Math.ceil((first.count||0)/PAGE),MAXP);
  for(let i=1;i<pages;i+=PAR){
    const res=await Promise.all(Array.from({length:Math.min(PAR,pages-i)},(_,j)=>page(i+j)));
    for(const r of res){if(r.error)throw r.error;out=out.concat(r.data||[]);}
  }
  return out;
}
/* mergeRows ставит новые строки В НАЧАЛО, а догружаем мы старые — порядок «новые сверху»
   сломался бы. Сортируем на месте: объекты те же, открытая карточка не отвалится. */
function histMerge(table,rows){
  if(!Array.isArray(S[table]))S[table]=[];
  const r=mergeRows(S[table],rows||[]);
  if(r.added)S[table].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
  return r;
}
function histKey(kind,arg){
  if(kind==='all')return 'all';
  if(kind==='ids'){const a=arg||[];return 'i:'+a.length+':'+(a[0]||'')+':'+(a[a.length-1]||'');}
  return kind.charAt(0)+':'+arg;
}
/* 'ok' — данные есть; 'loading' — идёт загрузка; 'need' — нужно догрузить; 'error' — не вышло */
function histState(kind,arg){
  if(typeof histNarrow!=='function'||histNarrow()||_hist.all)return 'ok';
  if(!S._heavyLoaded)return 'loading';
  const key=histKey(kind,arg);
  if(_hist.keys.has(key))return 'ok';
  if(kind==='since'&&arg&&_hist.from&&arg>=_hist.from)return 'ok';
  if(kind==='ids'){const have=new Set((S.orders||[]).map(o=>o.id));if((arg||[]).every(id=>have.has(id)))return 'ok';}
  if(_hist.busy.has(key))return 'loading';
  const e=_hist.err.get(key);
  if(e){if(Date.now()-e.at<HIST_ERR_TTL)return 'error';_hist.err.delete(key);}
  return 'need';
}
async function histDo(kind,arg){
  const from=_hist.from, fromTs=from?histDayTs(from):null;
  const older=q=>fromTs?q.lt('created_at',fromTs):q;     // то, что новее окна, уже в памяти
  if(kind==='since'){
    const [o,p]=await Promise.all([
      histPull('orders',q=>older(q.gte('created_at',histDayTs(arg)))),
      histPull('pickups',q=>{q=q.gte('pickup_date',arg);return from?q.lt('pickup_date',from):q;}),
    ]);
    histMerge('orders',o);histMerge('pickups',p);
    if(!_hist.from||arg<_hist.from)_hist.from=arg;
  }else if(kind==='month'){
    /* МЕСЯЦ БЕРЁМ С ЗАПАСОМ: и по дате забора, и по дате создания. Калькуляция относит
       заказ к месяцу по дате забора, а при её отсутствии по дате создания
       (`(o.pickup_date||o.created_at).slice(0,7)`, месяц создания — по Гринвичу);
       «Статистика» таблицу по дням строит по дате СОЗДАНИЯ. Объединение покрывает оба
       правила, а каждый раздел потом отбирает своё уже в памяти. Запрос по одной дате
       создания был бы неточным: реестр, загруженный в октябре с сентябрьскими датами,
       лежит в сентябре. */
    const m1=arg+'-01', m2=histNextMonth(arg)+'-01';
    const [o,p]=await Promise.all([
      histPull('orders',q=>older(q.or(`and(pickup_date.gte.${m1},pickup_date.lt.${m2}),and(created_at.gte."${m1}T00:00:00Z",created_at.lt."${m2}T00:00:00Z")`))),
      histPull('pickups',q=>{q=q.gte('pickup_date',m1).lt('pickup_date',m2);return from?q.lt('pickup_date',from):q;}),
    ]);
    histMerge('orders',o);histMerge('pickups',p);
  }else if(kind==='sorted'){
    const m1=arg+'-01', m2=histNextMonth(arg)+'-01';
    histMerge('orders',await histPull('orders',q=>older(q.gte('sorted_at',histDayTs(m1)).lt('sorted_at',histDayTs(m2)))));
  }else if(kind==='ids'){
    const have=new Set((S.orders||[]).map(o=>o.id));
    const need=(arg||[]).filter(id=>id&&!have.has(id));
    for(let i=0;i<need.length;i+=100){
      const part=need.slice(i,i+100);
      histMerge('orders',await histPull('orders',q=>q.in('id',part)));
    }
  }else if(kind==='all'){
    // Как было до правки: всё, что помещается (предохранитель dbList — 51 000 строк).
    const [p,o]=await Promise.all([dbList('pickups',{order:'created_at',asc:false}),dbList('orders',{order:'created_at',asc:false})]);
    if(!o.length&&(S.orders||[]).length)throw new Error('пустой ответ');
    histMerge('pickups',p);histMerge('orders',o);
    _hist.all=true;
  }
}
function histEnsure(kind,arg){
  if(histState(kind,arg)==='ok')return Promise.resolve(true);
  const key=histKey(kind,arg);
  if(_hist.busy.has(key))return _hist.busy.get(key);
  _hist.err.delete(key);
  const p=(async()=>{
    try{
      if(S._heavyLoading&&!S._heavyLoaded)await S._heavyLoading;
      await histDo(kind,arg);
      _hist.keys.add(key);
      return true;
    }catch(e){
      console.error('история',key,e);
      _hist.err.set(key,{msg:String(e&&e.message||e),at:Date.now()});
      return false;
    }finally{_hist.busy.delete(key);}
  })();
  _hist.busy.set(key,p);
  return p;
}
function histWhat(kind,arg){
  if(kind==='month')return 'заказы за '+histMonthName(arg);
  if(kind==='sorted')return 'приёмку склада за '+histMonthName(arg);
  if(kind==='since')return 'заказы с '+histFmt(arg);
  if(kind==='ids')return 'заказы этой отправки';
  return 'всю историю заказов';
}

/* ---------- как разделы спрашивают ---------- */
/* Для раздела ЦЕЛИКОМ: true — данные есть, рисуйте; false — заглушка уже на экране. */
function histGatePage(kind,arg,title){
  const st=histState(kind,arg);
  if(st==='ok')return true;
  const main=$('main');if(!main)return true;
  const tab=S.tab, key=histKey(kind,arg);
  const again=()=>{if(S.tab===tab&&typeof render==='function')render();};
  const head=`<div class="page-head"><div><h1>${esc(title)}</h1></div></div>`;
  if(st==='error'){
    main.innerHTML=head+`<div class="empty"><div class="big">Не удалось загрузить ${esc(histWhat(kind,arg))}</div>Проверьте связь и повторите. Раздел не показываем, чтобы не считать по неполным данным.<div style="margin-top:14px"><button class="btn primary" id="histRetry">Повторить</button></div></div>`;
    const b=$('histRetry');if(b)b.onclick=()=>{_hist.err.delete(key);again();};
    return false;
  }
  main.innerHTML=head+`<div class="loading" style="padding:60px">Загружаем ${esc(histWhat(kind,arg))}…</div>`;
  if(st==='need')histEnsure(kind,arg).then(again);
  return false;
}
/* Для окна: true — открывайте; false — догружаем и сами позовём again(). */
function histGateModal(kind,arg,again){
  const st=histState(kind,arg);
  if(st==='ok')return true;
  const key=histKey(kind,arg);
  if(st==='error'){toast('Не удалось загрузить '+histWhat(kind,arg)+' — проверьте связь и нажмите ещё раз');_hist.err.delete(key);return false;}
  if(_hist.busy.has(key)||st==='loading'){toast('Ещё загружаем '+histWhat(kind,arg)+'…');return false;}
  toast('Загружаем '+histWhat(kind,arg)+'…');
  histEnsure(kind,arg).then(ok=>{if(ok)again();else toast('Не удалось загрузить '+histWhat(kind,arg)+' — проверьте связь');});
  return false;
}
/* Для панели внутри раздела: true — показывайте текст histPanelText вместо таблицы. */
function histPanelLoading(kind,arg){
  const st=histState(kind,arg);
  if(st==='ok')return false;
  const tab=S.tab;
  if(st==='need')histEnsure(kind,arg).then(()=>{if(S.tab===tab&&typeof render==='function')render();});
  return true;
}
function histPanelText(kind,arg){
  return histState(kind,arg)==='error'
    ?'Не удалось загрузить '+histWhat(kind,arg)+' — нажмите «Обновить» через несколько секунд'
    :'Загружаем '+histWhat(kind,arg)+'…';
}

/* ---------- гриды заказов и заявок ---------- */
/* Грид рисует из памяти. Если фильтр дат уходит раньше окна — догружаем сами; если дат
   нет вовсе («Все даты») — говорим, с какого дня данные, и ищем старое запросом к базе:
   заказ месячной давности ищут по номеру, треку, ФИО или телефону. */
function histGridNote(kind){
  try{
    if(typeof isStaff!=='function'||!isStaff()||histNarrow()||_hist.all||!S._heavyLoaded||!_hist.from)return;
    const el=$(kind==='orders'?'orderTable':'pickupTable');if(!el)return;
    if(kind==='orders'&&typeof ordersDupIds!=='undefined'&&ordersDupIds)return;
    const word=kind==='orders'?'заказы':'заявки';
    let need='';
    if(kind==='orders'){
      // заказ создают раньше, чем забирают и доставляют, — отсюда запас в днях
      need=of.createFrom||[of.pickFrom&&histDayShift(of.pickFrom,-10),of.delFrom&&histDayShift(of.delFrom,-30)].filter(Boolean).sort()[0]||'';
    }else need=pf.dateFrom||'';
    let note='';
    if(need){
      const st=histState('since',need);
      if(st==='ok')return;
      if(st==='need')histEnsure('since',need).then(()=>histGridRedraw(kind));
      note=st==='error'?`Не удалось загрузить ${word} с ${histFmt(need)} — проверьте связь.`:`Загружаем ${word} с ${histFmt(need)}…`;
    }else{
      note=`В списке ${word} с ${histFmt(_hist.from)}. Более старые найдутся поиском — наберите ${kind==='orders'?'номер, трек, ФИО или телефон':'название, адрес или телефон'}. `
        +`<button class="btn sm ghost" data-histall type="button">Загрузить всю историю</button>`;
      histGridSearch(kind);
    }
    el.insertAdjacentHTML('afterbegin',`<div class="hint hist-note">${note}</div>`);
    const b=el.querySelector('[data-histall]');
    if(b)b.onclick=()=>{b.disabled=true;b.textContent='Загружаем…';
      histEnsure('all').then(ok=>{if(!ok)toast('Не удалось загрузить историю — проверьте связь');histGridRedraw(kind);});};
  }catch(e){console.warn('histGridNote',e);}
}
function histGridRedraw(kind){
  try{
    if(kind==='orders'){if($('orderTable')&&typeof drawOrders==='function')drawOrders();}
    else if($('pickupTable')&&typeof drawPickups==='function')drawPickups();
  }catch(e){console.warn('histGridRedraw',e);}
}
let _histSearchT=null;
function histGridSearch(kind){
  const raw=String((kind==='orders'?of.q:pf.q)||'').trim();
  if(raw.length<4)return;
  const key=kind+':'+raw.toLowerCase();
  if(_hist.searched.has(key))return;
  clearTimeout(_histSearchT);
  _histSearchT=setTimeout(async()=>{
    if(_hist.searched.has(key))return;
    _hist.searched.add(key);
    try{
      // запятые, скобки и кавычки ломают выражение or(...) у PostgREST
      const safe=raw.replace(/[,()"\\%*]/g,' ').replace(/\s+/g,' ').trim();
      const digits=raw.replace(/\D/g,'');
      if(!safe)return;
      const like=col=>`${col}.ilike."*${safe}*"`;
      const parts=kind==='orders'?[like('code'),like('track'),like('client')]:[like('name'),like('address')];
      if(digits.length>=6)parts.push(`phone.ilike."*${digits.slice(-10)}*"`);
      let q=sb.from(kind).select('*').or(parts.join(','));
      if(_hist.from)q=kind==='orders'?q.lt('created_at',histDayTs(_hist.from)):q.lt('pickup_date',_hist.from);
      const {data,error}=await q.order('created_at',{ascending:false}).limit(80);
      if(error)throw error;
      if(data&&data.length&&histMerge(kind,data).added)histGridRedraw(kind);
    }catch(e){_hist.searched.delete(key);console.warn('histGridSearch',e&&e.message);}
  },450);
}

/* ---------- подключение к разделам ---------- */
/* Оборачиваем, а не правим каждый раздел: правило «спроси историю до расчёта» живёт в
   одном месте, и новый раздел добавляется одной строкой. Объявление функции на верхнем
   уровне — свойство window, поэтому все вызовы по имени попадают в обёртку. */
function histWrap(name,gate){
  const base=window[name];
  if(typeof base!=='function'){console.warn('histWrap: нет функции',name);return;}
  window[name]=function(){
    let ok=true;
    try{ok=gate.apply(this,arguments);}catch(e){console.error('histWrap',name,e);ok=true;}
    if(ok===false)return;
    return base.apply(this,arguments);
  };
}
const histMonthStart=()=>localToday().slice(0,8)+'01';

histWrap('renderCalc',()=>canMod('calc')?histGatePage('month',calcPeriodStr(),'Калькуляция'):true);
histWrap('renderDashboard',()=>histGatePage('month',dashPeriod.year+'-'+String(dashPeriod.month+1).padStart(2,'0'),'Статистика'));
histWrap('renderSorting',()=>{
  const d=sortingDate||localToday();
  // день в «Сортировке» берётся по Гринвичу, отсюда запас в сутки
  return d>=localToday()?true:histGatePage('since',histDayShift(d,-1),'Сортировка');
});
// Межгород: непривязанные считаются за текущий месяц, разбор накопившегося — с выбранной даты
histWrap('unassignedIntercityOrdersModal',function(){return histGateModal('since',histMonthStart(),()=>unassignedIntercityOrdersModal.apply(null,arguments));});
histWrap('intercityAssignModal',function(){
  const d=typeof icAssignFromDate==='function'?icAssignFromDate():histMonthStart();
  return histGateModal('since',d,()=>intercityAssignModal.apply(null,arguments));
});
// Старую отправку открывают редко, но её заказы могут быть старше окна
['shipmentOrdersModal','shipmentEditModal'].forEach(name=>histWrap(name,function(id){
  const s=(S.shipments||[]).find(x=>x.id===id);
  const ids=(s&&s.order_ids)||[];
  return ids.length?histGateModal('ids',ids,()=>window[name](id)):true;
}));
// Гриды: после отрисовки дописываем строку про охват и догружаем недостающее
['drawOrders','drawPickups'].forEach(name=>{
  const base=window[name];if(typeof base!=='function')return;
  window[name]=function(){const r=base.apply(this,arguments);histGridNote(name==='drawOrders'?'orders':'pickups');return r;};
});
/* Центр контроля: списки месяцев собирались ИЗ ЗАГРУЖЕННЫХ заказов, и после сужения окна
   прошлые месяцы из них пропали бы. Добавляем последние полгода всегда. */
['nfVolMonths','nfWhMonths'].forEach(name=>{
  const base=window[name];if(typeof base!=='function')return;
  window[name]=function(){
    const set=new Set(base.apply(this,arguments));
    let ym=localToday().slice(0,7);
    for(let i=0;i<6;i++){set.add(ym);let y=+ym.slice(0,4),m=+ym.slice(5,7)-1;if(m<1){m=12;y--;}ym=y+'-'+String(m).padStart(2,'0');}
    return [...set].sort((a,b)=>b.localeCompare(a));
  };
});
/* Помощнику по данным нужны последние месяцы целиком — он строит по ним разбивку. */
async function histEnsureRecentMonths(n){
  let ym=localToday().slice(0,7);
  for(let i=0;i<n;i++){
    await histEnsure('month',ym);
    let y=+ym.slice(0,4),m=+ym.slice(5,7)-1;if(m<1){m=12;y--;}ym=y+'-'+String(m).padStart(2,'0');
  }
}
/* СРАВНЕНИЕ С ПРОШЛЫМ МЕСЯЦЕМ В «СТАТИСТИКЕ» — два числа, и качать ради них целый месяц
   заказов (25 тысяч строк) незачем: спрашиваем у базы счётчики, без единой строки данных.
   Отдаёт null, когда прошлый месяц и так в памяти (тогда раздел считает сам), иначе
   {orders,pickups}; пока ответа нет — нули, и стрелка тренда просто не рисуется. */
const _histPrev={};
function histDashPrev(ym,bar){
  if(histNarrow()||_hist.all||_hist.keys.has('m:'+ym))return null;
  const key=ym+(bar?'|bar':'|main'), c=_histPrev[key];
  if(c&&c.done)return c;
  if(!c){
    const rec=_histPrev[key]={orders:0,pickups:0,done:false};
    const m1=ym+'-01', m2=histNextMonth(ym)+'-01';
    const cnt=async(table,build)=>{
      const {count,error}=await build(sb.from(table).select('id',{count:'exact',head:true}).gte('pickup_date',m1).lt('pickup_date',m2));
      if(error)throw error;return count||0;
    };
    const collected=(S.statuses||[]).filter(st=>isCollectedStatus(st.id)).map(st=>st.id);
    Promise.all([
      cnt('orders',q=>bar?q.eq('calc_group','baraholka'):(baraholkaReady()?q.or('calc_group.is.null,calc_group.neq.baraholka'):q)),
      bar||!collected.length?0:cnt('pickups',q=>q.in('status_id',collected)),
    ]).then(([o,p])=>{rec.orders=o;rec.pickups=p;rec.done=true;if(S.tab==='dashboard'&&typeof render==='function')render();})
      .catch(e=>{console.warn('histDashPrev',e&&e.message);delete _histPrev[key];});
  }
  return {orders:0,pickups:0};
}
/* КАРТОЧКА ЗАКАЗА, КОТОРОГО НЕТ В ПАМЯТИ. orderModal ищет заказ в S.orders и, не найдя,
   открывает пустую карточку НОВОГО заказа — а старый заказ открывают из «Истории
   изменений», поиска, телефонии. Раньше это случалось с заказами за пределами 51 000,
   теперь случалось бы со всем, что старше окна. Достаём заказ из базы и открываем заново. */
const _histOpening=new Set();
histWrap('orderModal',function(id){
  if(!id||typeof id!=='string'||(S.orders||[]).some(o=>o.id===id))return true;
  if(_histOpening.has(id))return false;
  _histOpening.add(id);
  const args=arguments;
  (async()=>{
    try{
      const {data,error}=await sb.from('orders').select('*').eq('id',id).limit(1);
      if(error)throw error;
      if(!data||!data.length){toast('Заказ не найден — возможно, его удалили');return;}
      histMerge('orders',data);
      window.orderModal.apply(null,args);
    }catch(e){toast('Не удалось открыть заказ: '+String(e&&e.message||e));}
    finally{_histOpening.delete(id);}
  })();
  return false;
});
