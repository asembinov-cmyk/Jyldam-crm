
/* ================= SUPABASE ================= */
const SUPABASE_URL='https://tdexhspesodslwgbxojw.supabase.co';
const SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkZXhoc3Blc29kc2x3Z2J4b2p3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMTcxOTMsImV4cCI6MjA5Nzc5MzE5M30.QojVMQAWzINufmqdI5nEL-gX_UsIZV8Nq48-3Fn6YoE';
// сессия входа — localStorage (переживает закрытие/сворачивание вкладки, критично для курьеров
// на телефоне: sessionStorage там часто стирается, когда браузер уходит в фон). Раньше пробовали
// sessionStorage ради независимости вкладок друг от друга, но это ломало вход у курьеров на мобильных —
// стабильность входа важнее. Для одновременной работы под разными аккаунтами в разных вкладках на
// компьютере есть обходной путь — приватное окно браузера.
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON,{
  auth:{storage:window.localStorage,persistSession:true,autoRefreshToken:true},
});
let _partnerQR=''; // текущий QR-код партнёра (кабинет по ?p=)

const $=id=>document.getElementById(id);
const esc=s=>(s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---------- ДОСТУП В КАБИНЕТ ПАРТНЁРА ---------- */
// Код доступа — единственный пароль партнёра: ссылка ?p=КОД пускает в кабинет без логина,
// позволяет читать его заказы (ФИО, телефоны, адреса), вызывать курьера и менять заказы.
// Раньше код вписывал менеджер руками, а подсказка в поле предлагала «например 1001» —
// четыре цифры перебираются за минуты. Теперь код выдаётся криптостойким генератором.
// Алфавит без похожих друг на друга знаков (нет 0/o, 1/l/i) — чтобы код можно было
// продиктовать или переписать с экрана без ошибок.
const PARTNER_CODE_ALPHABET='23456789abcdefghjkmnpqrstuvwxyz';
function genPartnerCode(len){
  len=len||26;                       // 26 знаков по 31 варианту ≈ 128 бит, перебор невозможен
  const a=new Uint32Array(len);
  crypto.getRandomValues(a);         // именно crypto, а не Math.random: тот предсказуем
  let out='';
  for(let i=0;i<len;i++)out+=PARTNER_CODE_ALPHABET[a[i]%PARTNER_CODE_ALPHABET.length];
  return out;
}
function partnerCabinetLink(code){
  return location.origin+location.pathname+'?p='+encodeURIComponent(code||'');
}
// QR рисуем В БРАУЗЕРЕ. Раньше картинку заказывали у api.qrserver.com, передавая ссылку
// с кодом доступа прямо в адресе запроса — секрет партнёра уходил третьей стороне и
// оставался у неё в логах. Библиотека грузится только когда QR реально понадобился.
let _qrLibPromise=null;
function ensureQrLib(){
  if(window.qrcode)return Promise.resolve();
  if(!_qrLibPromise)_qrLibPromise=new Promise((resolve,reject)=>{
    const el=document.createElement('script');
    el.src='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
    el.onload=()=>resolve();
    el.onerror=()=>{_qrLibPromise=null;reject(new Error('Не удалось загрузить библиотеку QR'));};
    document.head.appendChild(el);
  });
  return _qrLibPromise;
}
async function renderQrInto(img,text,size){
  if(!img)return false;
  try{
    await ensureQrLib();
    const qr=window.qrcode(0,'M');   // 0 — версия подбирается по длине данных
    qr.addData(String(text||''));
    qr.make();
    const cell=Math.max(3,Math.round((size||220)/qr.getModuleCount()));
    img.src=qr.createDataURL(cell,8);
    return true;
  }catch(e){console.error('QR',e);toast('Не удалось нарисовать QR-код');return false;}
}
const uidLocal=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);
// ms — для длинных сообщений, которые не успеть прочитать за две секунды
// Двойное нажатие, посчитанное вручную по двум обычным click подряд.
//
// Штатное событие dblclick Safari на айфоне для строк таблицы отдаёт ненадёжно — на этом
// уже обожглись в «Сортировке». Два обычных click приходят всегда, и на телефоне, и мышью.
// Ложных срабатываний нет: при прокрутке click не приходит вовсе.
// Колонки товара, которые нужны списку. Специально БЕЗ photo: фото хранится прямо в строке
// товара картинкой в виде текста (300×300, десятки килобайт), и «звёздочка» тянула их все
// при каждом входе в систему — у всех сотрудников, включая курьеров, которые склад не
// открывают вовсе. Сами фото подгружаются только для видимой страницы списка и для
// открытой карточки (см. ensureProductPhotos).
const PRODUCT_LIST_COLS='id,name,partner_id,barcode,sku,category,stock,storage_cell,ket_sku';
// Подтягивает фото для указанных товаров — по требованию, одной пачкой. Уже загруженные
// не перезапрашиваются: photo остаётся в объекте товара до перезагрузки страницы.
async function ensureProductPhotos(ids){
  const need=[...new Set(ids)].filter(id=>{
    const p=(S.products||[]).find(x=>x.id===id);
    return p&&p.photo===undefined;
  });
  if(!need.length)return;
  try{
    for(let i=0;i<need.length;i+=200){
      const {data,error}=await sb.from('products').select('id,photo').in('id',need.slice(i,i+200));
      if(error){console.error('фото товаров',error);return;}
      (data||[]).forEach(r=>{const p=(S.products||[]).find(x=>x.id===r.id);if(p)p.photo=r.photo||null;});
      // Товары, которых база не вернула (например, строку удалили), оставляем с undefined —
      // это значит «не знаем», и сохранение карточки такое фото не тронет.
    }
  }catch(e){console.error('ensureProductPhotos',e);}
}
const DBLTAP_MS=450;
function bindDoubleTap(el,fn){
  if(!el)return;
  el.style.touchAction='manipulation';   // иначе на телефоне двойное касание масштабирует страницу
  el.onclick=e=>{
    if(e.target.closest('a,button,input,select,textarea'))return;
    const now=Date.now();
    const prev=Number(el.dataset.lastTap||0);
    el.dataset.lastTap=now;
    if(now-prev>DBLTAP_MS)return;        // это было первое касание — ждём второе
    el.dataset.lastTap=0;
    fn(e);
  };
}
function toast(m,ms){const t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),ms||2200);}

const ROLE_LABEL={admin:'Администратор',manager:'Менеджер',courier:'Курьер'};

/* состояние сессии и данных */
const S={
  me:null,           // профиль текущего пользователя {id,email,full_name,role,courier_kind}
  tab:'dashboard',
  dir:'cities',
  // справочники-кэш
  cities:[],districts:[],couriers:[],order_couriers:[],sales:[],processors:[],
  partners:[],statuses:[],orderStatuses:[],delivery:[],courier_cities:[],post_ips:[],profiles:[],roles:[],warehouses:[],
  pickups:[],orders:[],activityLog:[],
  myPerms:null, myBaseType:'staff',
};
// ВРЕМЕННАЯ ДИАГНОСТИКА: логируем в консоль браузера каждую смену активной вкладки (S.tab) со стеком
// вызова — нужно, чтобы поймать точную причину случая, когда вкладка сама переключается и возвращается
// обратно. Как только причина найдена и починена — этот блок можно убрать.
(function(){
  let _tab=S.tab;
  Object.defineProperty(S,'tab',{
    get(){return _tab;},
    set(v){
      if(v!==_tab){
        console.warn('[S.tab] '+_tab+' → '+v);
        console.trace();
      }
      _tab=v;
    },
  });
})();

/* ---------- ЗАПОМИНАНИЕ ВКЛАДКИ (чтобы при ОБНОВЛЕНИИ страницы остаться на месте, но при НОВОМ
   входе — например, новая вкладка или после выхода — всегда начинать с дашборда). Поэтому храним
   не в localStorage (общий, живёт вечно), а в sessionStorage (свой для вкладки, живёт до её закрытия
   или явного выхода) — та же логика, что и у самой сессии входа. ---------- */
const NAV_KEY='jyldam_nav';
function saveNav(){
  try{sessionStorage.setItem(NAV_KEY,JSON.stringify({tab:S.tab,dir:S.dir,users:(typeof usersSub!=='undefined'?usersSub:'staff')}));}catch(e){}
}
function loadNav(){
  try{const raw=sessionStorage.getItem(NAV_KEY);if(!raw)return;const n=JSON.parse(raw);
    if(n.tab)S.tab=n.tab;if(n.dir)S.dir=(n.dir==='partners'?'cities':n.dir);if(n.users&&typeof usersSub!=='undefined')usersSub=n.users;
  }catch(e){}
}
function clearNav(){try{sessionStorage.removeItem(NAV_KEY);}catch(e){}}

/* ---------- DATA LAYER ---------- */
async function dbList(table,opts={}){
  // Supabase отдаёт максимум 1000 строк за запрос. При большой таблице нужно много страниц —
  // но запускать их ВСЕ параллельно нельзя: браузер держит открытыми только ~6 соединений к
  // одному хосту одновременно, остальные встают в очередь и не успевают уложиться в таймаут,
  // даже если сама база отвечает быстро. Поэтому грузим пачками по 6 одновременно.
  const PAGE=1000,CONCURRENCY=6,PAGE_TIMEOUT=30000;
  const fetchPage=(from,to,withCount)=>{
    // withCount — просим общее число строк ТЕМ ЖЕ запросом, что и данные: PostgREST
    // возвращает его заголовком Content-Range, отдельный запрос за счётчиком не нужен
    // opts.select — список нужных колонок. Нужен там, где в таблице есть тяжёлое поле,
    // которое в списке не требуется: у товаров фото хранится прямо в строке (картинка
    // текстом, десятки килобайт), и «звёздочка» тянула их все при каждом входе в систему.
    let q=sb.from(table).select(opts.select||'*',withCount?{count:'exact'}:undefined);
    if(opts.gte)q=q.gte(opts.gte.col,opts.gte.val); // напр. только записи не раньше даты X — сильно сокращает объём для быстро растущих таблиц
    if(opts.order) q=q.order(opts.order,{ascending:opts.asc!==false});
    q=q.range(from,to);
    return Promise.race([q,new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),PAGE_TIMEOUT))]);
  };
  const fetchInBatches=async(firstPage,pageCount)=>{
    let all=[];
    for(let i=firstPage;i<pageCount;i+=CONCURRENCY){
      const batchIdx=Array.from({length:Math.min(CONCURRENCY,pageCount-i)},(_,j)=>i+j);
      const batchResults=await Promise.all(batchIdx.map(idx=>fetchPage(idx*PAGE,idx*PAGE+PAGE-1)));
      for(const res of batchResults){
        const {data,error}=res;
        if(error){console.error(table,error);continue;}
        all=all.concat(data||[]);
      }
    }
    return all;
  };
  try{
    // Первую страницу и общее количество берём ОДНИМ запросом. Раньше сначала шёл
    // отдельный запрос только за счётчиком, и лишний круг к серверу платился за каждую
    // таблицу — даже за пустую. На десятке справочников это лишние круги на ровном месте.
    const firstRes=await fetchPage(0,PAGE-1,true);
    if(firstRes.error)throw firstRes.error;
    const total=firstRes.count||0;
    let all=firstRes.data||[];
    if(!total||all.length>=total)return all;
    const pageCount=Math.min(Math.ceil(total/PAGE),51); // предохранитель — максимум ~51000 строк
    if(pageCount<=1)return all;
    const rest=await fetchInBatches(1,pageCount);
    return all.concat(rest);
  }catch(e){
    // если count почему-то не сработал (например, для представлений без прав на count) — старый
    // надёжный способ постранично, но хотя бы не молча теряем данные
    console.error('dbList (fallback to sequential)',table,e&&e.message);
    try{
      let all=[],from=0;
      while(true){
        const res=await fetchPage(from,from+PAGE-1);
        const {data,error}=res;
        if(error){console.error(table,error);return all;}
        const chunk=data||[];
        all=all.concat(chunk);
        if(chunk.length<PAGE)break;
        from+=PAGE;
        if(from>50000)break;
      }
      return all;
    }catch(e2){console.error('dbList',table,e2&&e2.message);return [];}
  }
}
// точечная загрузка строк таблицы по значению одного поля, мимо общего кэша S — используется там,
// где важна свежесть данных именно сейчас (например, подсчёт заказов по заявке перед массовым созданием)
async function dbListWhere(table,col,val){
  try{
    const {data,error}=await sb.from(table).select('*').eq(col,val);
    if(error){console.error('listWhere',table,error);return null;}
    return data||[];
  }catch(e){console.error('dbListWhere',table,e&&e.message);return null;}
}
// таблицы, логируемые автоматически в обёртках (orders/pickups логируются отдельно с подробностями)
const AUTO_LOG_TABLES=new Set(['partners','cities','districts','couriers','order_couriers','sales_managers','processors','statuses','order_statuses','delivery_types','courier_cities','post_ips','profiles','roles','warehouses']);
// карта таблица→ключ кэша в S (для поиска "до" и подписи)
const TABLE_ARRKEY={partners:'partners',cities:'cities',districts:'districts',couriers:'couriers',order_couriers:'order_couriers',sales_managers:'sales',processors:'processors',statuses:'statuses',order_statuses:'orderStatuses',delivery_types:'delivery',courier_cities:'courier_cities',post_ips:'post_ips',profiles:'profiles',roles:'roles',warehouses:'warehouses'};
function recLabel(rec){
  if(!rec)return '';
  // проводка Финансов — своих полей name/fio нет, собираем подпись из даты+суммы+типа
  if(rec.entry_date!=null&&rec.amount!=null&&(rec.type==='income'||rec.type==='expense')){
    return `Проводка ${fmtDate(rec.entry_date)} · ${Math.round(rec.amount).toLocaleString('ru-RU')} ₸ (${rec.type==='income'?'приход':'расход'})`;
  }
  return rec.name||rec.fio||rec.full_name||rec.code||rec.email||('#'+rec.id);
}
function findCached(table,id){const k=TABLE_ARRKEY[table];const arr=k&&S[k];return Array.isArray(arr)?arr.find(x=>x&&x.id===id):null;}
async function dbInsert(table,row){
  const {data,error}=await sb.from(table).insert(row).select().single();
  if(error){console.error('insert',table,error);toast('Ошибка: '+error.message);return null;}
  if(AUTO_LOG_TABLES.has(table))logAction('create',table,{entity_id:data.id,entity_label:recLabel(data)});
  return data;
}
async function dbUpdate(table,id,row){
  const before=AUTO_LOG_TABLES.has(table)?findCached(table,id):null;
  const beforeCopy=before?Object.assign({},before):null;
  const {data,error}=await sb.from(table).update(row).eq('id',id).select().single();
  if(error){console.error('update',table,error);toast('Ошибка: '+error.message);return null;}
  if(AUTO_LOG_TABLES.has(table)){const ch=buildChanges(beforeCopy,data);if(ch.length)logAction('update',table,{entity_id:id,entity_label:recLabel(data),changes:ch});}
  return data;
}
// свежая загрузка одной записи мимо кэша S — используется перед записью складских операций/резервов,
// чтобы уменьшить (не исключить полностью — это клиент без серверных транзакций) окно гонки при параллельной работе
async function dbGetOne(table,id){
  try{
    const {data,error}=await sb.from(table).select('*').eq('id',id).single();
    if(error){console.error('get',table,error);return null;}
    return data;
  }catch(e){console.error('dbGetOne',table,e&&e.message);return null;}
}
async function dbDelete(table,id){
  const before=AUTO_LOG_TABLES.has(table)?findCached(table,id):null;
  const lbl=before?recLabel(before):String(id);
  // сохраняем полный снимок строки в корзину, ПРЕЖДЕ чем реально удалить — на случай, если
  // понадобится восстановить (Центр контроля → Корзина, хранится 30 дней, потом чистится сама)
  try{
    let snapshot=before;
    if(!snapshot){
      const {data}=await sb.from(table).select('*').eq('id',id).limit(1);
      snapshot=data&&data[0];
    }
    if(snapshot){
      await sb.from('deleted_items').insert({
        table_name:table,record_id:String(id),record_data:snapshot,
        entity_label:lbl||recLabel(snapshot)||String(id),
        deleted_by:(S.me&&(S.me.full_name||S.me.email))||null,
      });
    }
  }catch(e){console.error('trash snapshot',e);} // не блокируем само удаление, даже если бэкап не удался
  // .select() обязателен: без него PostgREST на запрещённое правилами удаление отвечает
  // «успех, удалено 0 строк» — ошибки нет, и код рапортует «Удалено», хотя запись на месте.
  // Именно так однажды несколько часов молча не работало удаление заказов.
  const {data,error}=await sb.from(table).delete().eq('id',id).select('id');
  if(error){console.error('delete',table,error);toast('Ошибка: '+error.message);return false;}
  if(!data||!data.length){
    console.error('delete',table,'0 строк — запрещено правилами доступа или записи уже нет');
    toast('Не удалось удалить: нет прав или запись уже удалена');
    return false;
  }
  if(AUTO_LOG_TABLES.has(table))logAction('delete',table,{entity_id:id,entity_label:lbl});
  return true;
}
// восстановить запись из корзины обратно в исходную таблицу
async function restoreDeletedItem(trashId){
  const item=(S.deletedItems||[]).find(x=>x.id===trashId);
  if(!item)return;
  const row=Object.assign({},item.record_data);
  const {data,error}=await sb.from(item.table_name).insert(row).select();
  if(error){toast('Не удалось восстановить: '+error.message);return;}
  await sb.from('deleted_items').delete().eq('id',trashId);
  S.deletedItems=(S.deletedItems||[]).filter(x=>x.id!==trashId);
  const arrKey=RT_TABLE_ARR[item.table_name]||item.table_name;
  if(Array.isArray(S[arrKey])&&data&&data[0])S[arrKey].unshift(data[0]);
  toast('Восстановлено: '+(item.entity_label||''));
  renderNotify();
}

/* ---------- ЖУРНАЛ ДЕЙСТВИЙ (История изменений) ---------- */
// человекочитаемые названия сущностей
const ENTITY_LABEL={
  orders:'Заказ',pickups:'Заявка на забор',partners:'Партнёр',cities:'Город',districts:'Район',
  couriers:'Курьер (заборщик)',order_couriers:'Курьер по заказам',sales_managers:'Менеджер по продажам',
  processors:'Обработчик',statuses:'Статус забора',order_statuses:'Статус заказа',delivery_types:'Тип доставки',
  courier_cities:'Курьерский город',post_ips:'ИП для Почты',profiles:'Сотрудник',roles:'Роль',warehouses:'Склад отправки',auth:'Система',
  finance_entries:'Проводка',finance_kassa:'Касса',finance_categories:'Категория расхода',
  finance_income_categories:'Категория прихода',finance_partners:'Партнёр (финансы)',
  warehouse_partners:'Партнёр склада',products:'Товар',inbound_orders:'Заказ КЕТ',shipments:'Отправка межгород',
};
// человекочитаемые подписи полей (для детальных правок)
const FIELD_LABEL={
  code:'Код',client:'ФИО клиента',phone:'Телефон',address:'Адрес',sender:'Отправитель',
  delivery_id:'Тип доставки',courier_city_id:'Город (курьер.)',city_id:'Город',pickup_city_id:'Город забора',status_id:'Статус',
  order_status_id:'Статус',weight:'Вес',qty:'Кол-во',index:'Индекс',track:'Трек-код',order_sum:'Сумма заказа',
  cost:'Стоимость доставки',pay_date:'Дата оплаты',deliver_date:'Дата доставки',pickup_date:'Дата забора',call_status:'Статус обзвона',
  post_ip_id:'ИП для Почты',order_courier_id:'Курьер по заказам',courier_id:'Курьер',sales_id:'Менеджер продаж',
  processor_id:'Обработчик',district_id:'Район',name:'Наименование',fio:'ФИО',orders:'Кол-во заказов',
  full_name:'ФИО',position:'Должность',role_id:'Роль',color:'Цвет',tariff_post:'Тариф почта',
  tariff_courier:'Тариф курьер',qr_code:'QR-код',id_doc:'Уд. личности',paid_by_sender:'Оплачено отправителем',
  give_packets:'Пакеты для партнёра',give_invoices:'Накладные для партнёра',
  region:'Область',city_text:'Нас. пункт',comment:'Комментарий',base_type:'Базовый тип',perms:'Права',
  order_paid:'Оплачен заказ'
};
// поля, которые не показываем в истории (служебные)
const LOG_SKIP_FIELDS=new Set(['id','created_at','status_at','status_history','photos','ket_id','ket_track','ket_synced_at','perms']);
// форматирование значения поля для отображения старое→новое
function logFieldValue(field,v){
  if(v==null||v==='')return '—';
  try{
    if(field==='status_id'||field==='order_status_id'){const s=orderStatusObj(v)||statusObj(v);return s?s.name:String(v);}
    if(field==='delivery_id')return deliveryName(v);
    if(field==='city_id')return cityName(v);
    if(field==='pickup_city_id')return cityName(v);
    if(field==='courier_city_id')return courierCityName(v);
    if(field==='district_id')return districtName(v);
    if(field==='courier_id')return courierName(v);
    if(field==='order_courier_id')return orderCourierName(v);
    if(field==='sales_id')return salesName(v);
    if(field==='processor_id')return processorName(v);
    if(field==='post_ip_id')return postIpName(v);
    if(field==='partner_id')return partnerName(v);
    if(field==='role_id')return roleName(v);
    if(field==='phone')return phoneDisplay(v)||String(v);
    if(field==='paid_by_sender')return v?'да':'нет';
    if(field==='order_paid')return v?'да':'нет';
  }catch(e){}
  return String(v);
}
// собрать дифф полей между старой и новой записью
function buildChanges(before,after){
  const out=[];const keys=new Set([...Object.keys(before||{}),...Object.keys(after||{})]);
  keys.forEach(k=>{
    if(LOG_SKIP_FIELDS.has(k))return;
    const a=before?before[k]:undefined, b=after?after[k]:undefined;
    const na=(a==null?'':String(a)), nb=(b==null?'':String(b));
    if(na===nb)return;
    out.push({field:k,label:FIELD_LABEL[k]||k,old:logFieldValue(k,a),new:logFieldValue(k,b)});
  });
  return out;
}
// записать действие в журнал (не блокирует основную операцию при ошибке)
async function logAction(action,entity,opts={}){
  try{
    const row={
      user_id:(S.me&&S.me.id)||null,
      user_name:(S.me&&(S.me.full_name||S.me.email))||'—',
      action,entity,
      entity_id:opts.entity_id!=null?String(opts.entity_id):null,
      entity_label:opts.entity_label||null,
      changes:opts.changes&&opts.changes.length?opts.changes:null,
      meta:opts.meta||null,
    };
    await sb.from('activity_log').insert(row);
  }catch(e){console.error('logAction',e);}
}
// удобные подписи объектов
function orderLabel(o){return o?('#'+(o.code||o.id)):'';}
function pickupLabel(p){return p?(p.name||('заявка '+p.id)):'';}

/* ---------- ФОТО (Supabase Storage) ---------- */
const PHOTO_BUCKET='pickup-photos';

/* ---------- ФОТО: приватное хранилище и временные ссылки ---------- */
// На фото накладных — ФИО, адреса и телефоны получателей. Раньше хранилище было
// открыто всему интернету: ссылка работала у любого, без входа и навсегда. А сами
// ссылки лежали в поле photos таблицы заказов, которая до 18.09.2026 читалась кем
// угодно — то есть готовый список рабочих ссылок мог утечь целиком.
// Теперь бакет закрыт, а под каждый показ выдаётся временная ссылка: живёт час и
// создаётся только потому, что сотрудник вошёл в систему. Делает это браузер сам,
// никакой выдачи доступов вручную.
const PHOTO_URL_TTL=3600;                 // секунд
const _photoUrlCache=new Map();           // путь → {url, exp}
function _photoPathFromUrl(u){
  if(!u)return '';
  if(!/^https?:\/\//.test(u))return u;    // это уже путь, а не ссылка
  const m=String(u).match(new RegExp('/'+PHOTO_BUCKET+'/(.+)$'));
  return m?decodeURIComponent(m[1].split('?')[0]):'';
}
// путь в хранилище: у записей он лежит рядом со ссылкой, но у самых старых мог
// не сохраниться — тогда достаём его из самой ссылки
function photoPath(f){
  if(!f)return '';
  if(typeof f==='string')return _photoPathFromUrl(f);
  return f.path||_photoPathFromUrl(f.url||'');
}
function cachedPhotoUrl(f){
  const c=_photoUrlCache.get(photoPath(f));
  return c&&c.exp>Date.now()+60000?c.url:'';
}
// подписываем пачкой — один запрос на весь экран, а не по одному на каждое фото
async function signPhotoPaths(paths){
  const now=Date.now(),need=[],out=new Map();
  for(const pt of paths){
    if(!pt)continue;
    const c=_photoUrlCache.get(pt);
    if(c&&c.exp>now+60000)out.set(pt,c.url); else need.push(pt);
  }
  if(need.length){
    try{
      const {data,error}=await sb.storage.from(PHOTO_BUCKET).createSignedUrls(need,PHOTO_URL_TTL);
      if(error)console.error('signPhotoPaths',error);
      (data||[]).forEach(r=>{
        if(r&&r.signedUrl&&!r.error){
          _photoUrlCache.set(r.path,{url:r.signedUrl,exp:now+PHOTO_URL_TTL*1000});
          out.set(r.path,r.signedUrl);
        }
      });
    }catch(e){console.error('signPhotoPaths',e);}
  }
  return out;
}
async function signedPhotoUrl(f){
  const pt=photoPath(f);
  if(!pt)return '';
  return (await signPhotoPaths([pt])).get(pt)||'';
}
// подставляет ссылки во все <img data-ph="путь">, которым их ещё не подставили
async function hydratePhotos(root){
  const scope=(root&&root.querySelectorAll)?root:document;
  const imgs=[...scope.querySelectorAll('img[data-ph]:not([data-ph-done])')];
  if(!imgs.length)return;
  imgs.forEach(i=>i.setAttribute('data-ph-done','1'));
  const map=await signPhotoPaths([...new Set(imgs.map(i=>i.getAttribute('data-ph')).filter(Boolean))]);
  imgs.forEach(i=>{const u=map.get(i.getAttribute('data-ph'));if(u)i.src=u;});
}
// фото рисуются в десятке мест — вместо правки каждого следим за появлением в DOM
let _photoObserver=null;
function startPhotoHydration(){
  if(_photoObserver||!document.body)return;
  _photoObserver=new MutationObserver(()=>{
    if(document.querySelector('img[data-ph]:not([data-ph-done])'))hydratePhotos(document);
  });
  _photoObserver.observe(document.body,{childList:true,subtree:true});
  hydratePhotos(document);
}
// сжимает изображение в браузере перед загрузкой: уменьшает до maxSide px и пережимает в JPEG.
// Возвращает Blob (или исходный файл, если сжать не удалось).
// Сжатие фото перед загрузкой.
//
// ВАЖНО, ПОЧЕМУ ЧЕРЕЗ createObjectURL, А НЕ FileReader. Раньше файл читался в
// base64-строку (readAsDataURL). Для фото с телефона это очень дорого: снимок на
// 8 МБ превращается в строку почти на 11 МБ, и она живёт в памяти вместе с самим
// файлом и раскодированным изображением. При загрузке пачкой (заборщик снимает
// десятки накладных подряд) телефон послабее просто убивает вкладку — со стороны
// это выглядит как «фото не грузятся», без всякой ошибки.
// createObjectURL не копирует файл вообще — браузер читает его с диска сам.
//
// Таймаут на раскодирование: если браузер не осилил формат (бывает с HEIC на
// Android), события onload/onerror могут не прийти вовсе, и загрузка зависала бы
// навсегда. Через 20 секунд грузим оригинал как есть — лучше большой файл, чем
// вечное ожидание.
const IMG_DECODE_TIMEOUT_MS=20000;
async function compressImage(file,maxSide=1280,quality=0.72){
  let objUrl=null;
  try{
    if(!file||!/^image\//.test(file.type||''))return file; // не картинка — как есть
    objUrl=URL.createObjectURL(file);
    const img=await new Promise((res,rej)=>{
      const i=new Image();
      const t=setTimeout(()=>rej(new Error('изображение не раскодировалось за 20 секунд')),IMG_DECODE_TIMEOUT_MS);
      i.onload=()=>{clearTimeout(t);res(i);};
      i.onerror=()=>{clearTimeout(t);rej(new Error('браузер не смог прочитать изображение'));};
      i.src=objUrl;
    });
    let {width:w,height:h}=img;
    if(w<=maxSide&&h<=maxSide&&file.size<600*1024)return file; // уже маленькое — не трогаем
    if(w>h){if(w>maxSide){h=Math.round(h*maxSide/w);w=maxSide;}}
    else{if(h>maxSide){w=Math.round(w*maxSide/h);h=maxSide;}}
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);
    const blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',quality));
    canvas.width=canvas.height=0;   // освобождаем память сразу, не ждём сборщик мусора
    if(!blob||blob.size>=file.size)return file; // если не стало меньше — оставляем оригинал
    return blob;
  }catch(e){console.error('compress',e);return file;}
  finally{if(objUrl)URL.revokeObjectURL(objUrl);}
}
// загружает файл в подпапку prefix (например 'order/ID'), возвращает {path,url} или null
// Фото, выбранные в системном окне телефона: отдаём только пригодные, про остальные
// честно говорим вслух.
//
// ЗАЧЕМ. На айфоне снимки часто лежат в iCloud, а не на самом телефоне (настройка
// «Оптимизация хранилища»). Когда оригинал не скачался — мало места, слабая сеть,
// iCloud на паузе — Safari отдаёт странице пустой файл либо не отдаёт ничего.
// Раньше код в обоих случаях молча выходил, и человек видел ровно то, на что
// пожаловался заборщик: «вообще ничего». Теперь видно, что именно не сложилось.
function pickedPhotoFiles(inp){
  const all=[...((inp&&inp.files)||[])];
  if(!all.length){
    toast('Фото не выбраны. Если выбирали — проверьте место на телефоне и доступ Safari к «Фото»',5000);
    return [];
  }
  const good=all.filter(f=>f&&f.size>0);
  const bad=all.length-good.length;
  if(bad)toast(bad===1
    ? '1 фото не открылось — похоже, лежит в iCloud и не скачалось. Откройте его в приложении «Фото» и повторите'
    : `${bad} фото не открылись — похоже, лежат в iCloud и не скачались. Откройте их в приложении «Фото» и повторите`,6000);
  return good;
}
async function uploadPhoto(prefix,file){
  try{
    // сжимаем фото перед загрузкой — ускоряет и загрузку, и показ
    const blob=await compressImage(file);
    const path=`${prefix}/${Date.now()}_${Math.random().toString(36).slice(2,7)}.jpg`;
    const {error}=await sb.storage.from(PHOTO_BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false});
    if(error){
      console.error('upload',error);
      // Самая частая причина отказа — протухший вход: читать экран человек ещё может
      // (данные уже в памяти), а записывать уже нет. Английское «JWT expired» на
      // телефоне ничего не объясняет, поэтому переводим на понятное действие.
      const m=String(error.message||error.error||'');
      if(/jwt|token|unauthorized|not authenticated|401|403/i.test(m))toast('Вход устарел — выйдите и войдите снова');
      else toast('Ошибка загрузки: '+m);
      return null;
    }
    // публичную ссылку больше не сохраняем: бакет закрыт, она всё равно не работала бы.
    // Для показа достаточно пути — под него выдаётся временная ссылка (signedPhotoUrl).
    // сохраняем, кто и когда загрузил фото (для новых фото)
    return {path,by:(S.me&&(S.me.full_name||S.me.email))||'',at:new Date().toISOString()};
  }catch(e){console.error(e);toast('Ошибка загрузки фото');return null;}
}
// совместимость со старым кодом заявок
async function uploadPickupPhoto(pickupId,file){return uploadPhoto(pickupId,file);}
async function deletePhoto(path){
  try{const {error}=await sb.storage.from(PHOTO_BUCKET).remove([path]);
    if(error){console.error('remove',error);toast('Не удалось удалить: '+error.message);return false;}return true;
  }catch(e){console.error(e);return false;}
}
async function deletePickupPhoto(path){return deletePhoto(path);}
// Вызов Edge Function для создания пользователя (с проверкой админа на сервере)
async function callCreateUser(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/create-user`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}
// удаление сотрудника ПОЛНОСТЬЮ — и карточка (profiles), и сама учётная запись входа (auth.users) —
// через Edge Function, поскольку удалить учётную запись входа из браузера напрямую нельзя (это
// защищено на уровне Supabase — нужен серверный service-role ключ, которого у браузера нет и не
// должно быть). Без этого шага номер телефона/логин навсегда «занят», даже если карточку удалили.
async function callDeleteUser(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/delete-user`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}
// отправка сообщения в WhatsApp через Kelesu (Edge Function kelesu-send) — только для
// залогиненного сотрудника, вызывается из блока «Переписка» в карточке партнёра
async function callKelesuSend(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/kelesu-send`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok&&!out.error){return {success:false,error:'Ошибка '+res.status};}
    return out;
  }catch(e){return {success:false,error:String(e&&e.message||e)};}
}
// загружает и отрисовывает переписку WhatsApp с этим телефоном (карточка партнёра) —
// сопоставление идёт по последним 10 цифрам номера (normPhone), независимо от формата
async function loadPhoneChat(phone,boxId){
  const box=$(boxId);if(!box)return;
  const norm=normPhone(phone);
  if(!norm){box.innerHTML='<div class="hint">Нет телефона для поиска переписки</div>';return;}
  try{
    const {data,error}=await sb.from('kelesu_messages').select('*').eq('phone_norm',norm).order('created_at',{ascending:true}).limit(200);
    if(error)throw error;
    const box2=$(boxId);if(!box2)return; // модалка могла уже закрыться, пока грузили
    if(!data||!data.length){box2.innerHTML='<div class="hint">Переписки пока нет</div>';return;}
    box2.innerHTML=data.map(m=>{
      const out=m.direction==='outbound';
      const time=(fmtLogTime(m.created_at)||{}).time||'';
      return `<div style="display:flex;justify-content:${out?'flex-end':'flex-start'};margin-bottom:6px">
        <div style="max-width:75%;padding:8px 12px;border-radius:12px;background:${out?'#dcf8c6':'#fff'};border:1px solid var(--line);font-size:13px;white-space:pre-wrap;word-break:break-word">
          ${esc(m.body_text||(m.message_type&&m.message_type!=='text'?'['+esc(m.message_type)+']':'—'))}
          <div style="font-size:10px;color:var(--muted);margin-top:2px;text-align:right">${esc(time)}${out&&m.status?' · '+esc(m.status):''}</div>
        </div>
      </div>`;
    }).join('');
    box2.scrollTop=box2.scrollHeight;
  }catch(e){
    const box3=$(boxId);if(box3)box3.innerHTML='<div class="hint" style="color:var(--rust)">Не удалось загрузить переписку — возможно, таблица kelesu_messages ещё не создана</div>';
  }
}
// подтягивает историю переписки из Kelesu (Edge Function kelesu-sync-history) — нужно для
// сообщений, которые были ДО подключения вебхука и поэтому отсутствуют в нашей базе
async function callKelesuSyncHistory(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/kelesu-sync-history`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok&&!out.error){return {success:false,error:'Ошибка '+res.status};}
    return out;
  }catch(e){return {success:false,error:String(e&&e.message||e)};}
}
// получение реального трек-номера у Казпочты (Edge Function kazpost-get-barcode) — по одному
// заказу; функция сама сохраняет полученный трек-код прямо в заказ, тут только вызов
async function callKazpostGetBarcode(orderId){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/kazpost-get-barcode`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify({order_id:orderId}),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok&&!out.error){return {success:false,error:'Ошибка '+res.status};}
    return out;
  }catch(e){return {success:false,error:String(e&&e.message||e)};}
}
// то же самое ПАЧКОЙ: один вызов функции на список заказов. Внутри функции вход
// проверяется один раз на всю пачку, а не на каждый заказ отдельно, и сама функция
// запускается один раз вместо N — Казпочта быстрее не стала, но накладные расходы ушли.
// Ответ: {success:true, results:[{order_id,success,barcode?,warning?,error?}]}
async function callKazpostGetBarcodeBatch(orderIds){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/kazpost-get-barcode`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify({order_ids:orderIds}),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok&&!out.error){return {success:false,error:'Ошибка '+res.status};}
    return out;
  }catch(e){return {success:false,error:String(e&&e.message||e)};}
}
// смена пароля сотрудника через Edge Function set-password (только для админа)
async function callSetPassword(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/set-password`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}

// смена телефона/email (логина) сотрудника через Edge Function update-user (только для админа)
async function callUpdateUser(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/update-user`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}