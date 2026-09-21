
/* ================= ИНТЕГРАЦИЯ С KET ================= */
// низкоуровневый вызов прокси ket-proxy
async function callKet(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/ket-proxy`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}
// вызов ИИ через безопасный прокси ai-proxy
async function callAI(payload){
  const {data:sess}=await sb.auth.getSession();
  const token=sess&&sess.session?sess.session.access_token:'';
  try{
    const res=await fetch(`${SUPABASE_URL}/functions/v1/ai-proxy`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'apikey':SUPABASE_ANON},
      body:JSON.stringify(payload),
    });
    const out=await res.json().catch(()=>({}));
    if(!res.ok){return {error:out.error||('Ошибка '+res.status)};}
    return out;
  }catch(e){return {error:String(e&&e.message||e)};}
}
// собрать данные заказа в формат KET
function orderToKet(o){
  const courier=isCourierDelivery(o.delivery_id);
  // город НАЗНАЧЕНИЯ: для курьерской — курьерский справочник, для почтовой — обычный
  const cityNm=courier?courierCityName(o.courier_city_id):(o.city_id?cityName(o.city_id):'');
  // «отправная точка» для KET — КОД по ГОРОДУ ЗАБОРА (откуда забрали): Астана→ASTANA-KURER, Алматы→ALMATA
  const pickupCityNm=o.pickup_city_id?cityName(o.pickup_city_id):'';
  const originCode=ketOriginCode(pickupCityNm);
  // сумма: сначала order_sum, иначе cost (дубль). Идёт и в price, и в total_price
  const sumVal=(o.order_sum!=null&&o.order_sum!=='')?o.order_sum:(o.cost!=null?o.cost:0);
  const sumStr=String(sumVal||0);
  const data={
    phone:'7'+(o.phone||''),                 // телефон в формате 7XXXXXXXXXX (* обязательное)
    country:'kz',                            // код страны (* обязательное)
    offer:'tovar',                           // тех. название товара (* обязательное)
    order_id:o.code||o.id,                   // наш ID для синхронизации
    name:o.client||'',                       // ФИО клиента
    addr:o.address||'',                      // адрес
    price:sumStr,                            // стоимость
    total_price:sumStr,                      // итоговая стоимость (KET требует оба)
    saller_butique:o.sender||'',             // продавец/бутик
  };
  if(o.index)data.index=o.index;             // индекс (для почты)
  // ТРЕК-НОМЕР (штрихкод). Отправляем ДВА поля сразу — kz_code и barcode. Не убирайте
  // ни одно из них без проверки на живом заказе: у KET нет метода обновления, и цена
  // ошибки — заказ, уехавший к ним без трека навсегда.
  //
  // Что показал опыт (20–21.09.2026), в порядке проверок:
  //   только kz_code        → колонка Barcode у KET пустая
  //   kz_code + barcode     → колонка Barcode заполнена
  //   только barcode        → колонка Barcode снова пустая (проверено дважды)
  // То есть работает именно пара. Почему — неизвестно; в документации KET среди полей
  // ОТПРАВКИ нет ни того, ни другого (kz_code описан только как поле ОТВЕТА get_orders).
  //
  // Здесь я уже ошибся один раз: после удачного теста с двумя полями убрал kz_code,
  // решив, что сработал barcode. Тест этого не показывал — уходили оба поля, и какое
  // сработало, из него не следовало. Трек перестал доходить, и заметили это не сразу.
  //
  // Отправляем при любом типе доставки, если трек заполнен.
  const trackVal=(o.track==null?'':String(o.track)).trim();
  if(trackVal){
    data.kz_code=trackVal;
    data.barcode=trackVal;
  }
  // ВЕС заказа — поле actual_weight, имя дал KET (21.09.2026, по их приёмке 75747498).
  // Отправляем килограммы, ровно то число, что стоит в карточке заказа.
  //
  // Отправляем ТОЛЬКО если вес заполнен. Придумывать его нельзя: у KET нет метода
  // обновления, и выдуманный вес останется у них навсегда. Заодно это закрывает просьбу
  // «по Астане можно не делать» — там заказы не взвешивают, поле у них пустое, и ничего
  // не уйдёт само собой. Если понадобится слать вес и по Астане — достаточно начать его
  // проставлять в заказах, в коде менять нечего.
  const weightVal=(o.weight==null||o.weight==='')?null:parseFloat(o.weight);
  if(weightVal!=null&&!isNaN(weightVal)&&weightVal>0)data.actual_weight=String(weightVal);
  if(o.deliver_date)data.date_delivery=o.deliver_date; // дата доставки (YYYY-MM-DD), имя поля по требованию KET
  // дата принятия/подтверждения заказа = дата создания заказа в нашей системе (YYYY-MM-DD)
  // для курьерки это «принятие», для обзвона — «подтверждение»; в KET это одно поле fill_date
  const fillDate=(o.created_at||'').slice(0,10);
  if(fillDate)data.fill_date=fillDate;
  if(courier){
    // КУРЬЕРСКАЯ доставка: KET ждёт kz_delivery = числовой код города назначения
    const code=ketDeliveryCode(cityNm);
    if(code!=null)data.kz_delivery=String(code);
    // дублируем название города (не мешает, помогает KET сопоставить)
    if(cityNm&&cityNm!=='—')data.city=cityNm;
  }else{
    // ПОЧТОВАЯ доставка
    if(cityNm&&cityNm!=='—')data.city=cityNm;
    else data.kz_delivery='32';              // почта, если город не задан
  }
  // «отправная точка» — КОД города отправления (KET-параметр city_from)
  if(originCode)data.city_from=originCode;
  return data;
}
// сопоставление города заказа с кодом отправной точки KET
function ketOriginCode(cityName){
  const nm=(cityName||'').toLowerCase();
  if(/алмат/.test(nm))return 'ALMATA';
  if(/астан|нур-?султан|нур\s*султан/.test(nm))return 'ASTANA-KURER';
  return '';
}
// КОД типа доставки KET по городу НАЗНАЧЕНИЯ (поле kz_delivery) для курьерской доставки.
// Коды заданы по официальному списку. Порядок важен: более специфичные — раньше.
const KET_DELIVERY_CODES=[
  [/аксай|aksai|aksay/i,1],
  [/актобе|aktobe/i,3],           // актобе раньше актау (оба на «акт»)
  [/актау|aktau/i,2],
  [/алмат|almat/i,4],
  [/астан|нур-?султан|astana/i,5],
  [/атырау|atyrau/i,6],
  [/балхаш|balkhash|balhash/i,91],
  [/жанаозен|zhanaozen|janaozen/i,29],
  [/жезказган|жезкаган|zhezkazgan|jezkazgan|zhezkagan/i,31],
  [/конаев|konaev|konaey|қонаев|капшагай|kapshagai|kapshagay/i,56],
  [/караганд|karagand/i,10],
  [/каскелен|kaskelen/i,88],
  [/кокшетау|kokshetau/i,11],
  [/кызылорд|kyzylord|kzylord/i,14],
  [/костанай|kostanai|kostanay/i,12],
  [/кульсары|kulsary|kulsary/i,13],
  [/павлодар|pavlodar/i,15],
  [/петропавл|petropavl/i,16],
  [/сатпаев|сатбаев|сәтбаев|сәтпаев|satpaev|satbaev/i,20],
  [/семей|semei|semey/i,21],
  [/талдыкорган|taldykorgan/i,23],
  [/тараз|taraz/i,24],
  [/темиртау|temirtau/i,25],
  [/туркестан|turkestan/i,26],
  [/уральск|uralsk/i,27],
  [/усть-?каменогорск|ust-?kamenogorsk/i,28],
  [/шымкент|шимкент|shimkent|chimkent|shymkent/i,22],
  [/экибастуз|ekibastuz/i,9],
];
function ketDeliveryCode(cityName){
  const nm=(cityName||'').trim();
  if(!nm)return null;
  for(const [re,code] of KET_DELIVERY_CODES){if(re.test(nm))return code;}
  return null; // город не в списке курьерских — код не найден
}
// выбор аккаунта KET по ГОРОДУ ЗАБОРА заказа: Алматы → отдельный аккаунт, иначе (Астана и пр.) → основной
function ketAccountForOrder(o){
  const nm=(o&&o.pickup_city_id?cityName(o.pickup_city_id):'').toLowerCase();
  if(/алмат/.test(nm))return 'almaty';
  return 'astana'; // основной (старый) аккаунт по умолчанию
}
// Почтовые заказы без трек-номера: у KET нет метода обновления, поэтому трек можно
// передать только сейчас. Возвращает текст предупреждения или пустую строку.
function ketSendWarnNoTrack(list){
  const bad=list.filter(o=>!(o.track&&String(o.track).trim()));
  if(!bad.length)return '';
  const names=bad.slice(0,5).map(o=>o.code||o.id).join(', ');
  return `\n\nВНИМАНИЕ: заказов без трек-номера — ${bad.length} (${names}${bad.length>5?'…':''}).`
    +`\nВ KET трек передаётся только при отправке, дослать его потом нечем.`
    +`\nЗаказы уйдут в любом случае — но трек лучше получать до отправки.`;
}
// отправить один заказ в KET
async function sendOrderToKet(o){
  if(!o.phone||o.phone.length<10){toast('У заказа нет телефона клиента');return false;}
  toast('Отправка в KET…');
  const payload=orderToKet(o);
  // Что именно ушло в KET и что он ответил — сохраняем и показываем по кнопке в карточке
  // заказа. Разбирать «трек не дошёл» без этих двух вещей невозможно, а лазить в консоль
  // браузера на телефоне нереально. Метода обновления у KET нет — второй попытки на том
  // же заказе не будет, поэтому запись о каждой отправке дороже обычного.
  console.log('KET → отправляем',payload);
  const r=await callKet({action:'send',account:ketAccountForOrder(o),order:payload});
  console.log('KET ← ответ',r);
  rememberKetExchange(o,payload,r);
  if(r.error){toast('Ошибка KET: '+r.error);return false;}
  const result=(r.ket&&r.ket.result)||{};
  if((result.success||'').toUpperCase()==='TRUE'){
    const ketId=result.id||null;
    const u=await dbUpdate('orders',o.id,{ket_id:ketId,ket_synced_at:new Date().toISOString()});
    if(u)Object.assign(o,u);
    logAction('ket','orders',{entity_id:o.id,entity_label:orderLabel(o),meta:{ket_id:ketId}});
    // Прямо говорим, ушёл ли трек. Иначе «в KET колонка Barcode пустая» невозможно
    // отличить от «мы его и не передавали».
    toast('Заказ отправлен в KET (ID '+(ketId||'?')+')'+(payload.barcode?' · трек '+payload.barcode+' передан':''),5000);
    // Отправку не блокируем никогда. Но если это почтовый заказ без трека — говорим об этом
    // вслух: у KET нет метода обновления, дослать трек в этот заказ будет нечем.
    if(ketSendWarnNoTrack([o]))toast('Трек-номера не было — в KET он не ушёл, дослать нечем');
    renderOrders();return true;
  }else{
    toast('KET отклонил: '+(result.message||'неизвестно'));return false;
  }
}
// Последние отправки в KET: что ушло и что ответили. Держим в памяти вкладки (последние 20),
// показываем по кнопке в карточке заказа — см. ketExchangeInfo.
let _ketExchanges=[];
function rememberKetExchange(o,payload,resp){
  _ketExchanges.unshift({order_id:o.id,code:o.code||o.id,at:new Date().toISOString(),payload,resp});
  if(_ketExchanges.length>20)_ketExchanges.length=20;
}
function lastKetExchange(orderId){return _ketExchanges.find(x=>x.order_id===orderId)||null;}
// показать, что именно ушло в KET по этому заказу и что он ответил
function ketExchangeInfo(orderId){
  const ex=lastKetExchange(orderId);
  if(!ex){toast('В этой вкладке заказ ещё не отправляли — отправьте и нажмите снова');return;}
  const track=ex.payload&&ex.payload.barcode?esc(ex.payload.barcode):'';
  showInfo('Отправка в KET · '+esc(ex.code),`
    <div style="font-size:13px;color:var(--muted);margin-bottom:10px">${esc(fmtDate(ex.at))}</div>
    <div style="margin-bottom:10px;font-size:15px">
      ${track?`Трек <strong>${track}</strong> передан в полях <code>kz_code</code> и <code>barcode</code>.`
             :'<span style="color:var(--rust)">Трек не передавался — в заказе он был пустой.</span>'}
    </div>
    <label style="font-size:12px;color:var(--muted)">Отправлено в KET</label>
    <pre style="white-space:pre-wrap;word-break:break-word;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;max-height:240px;overflow:auto">${esc(JSON.stringify(ex.payload,null,2))}</pre>
    <label style="font-size:12px;color:var(--muted);margin-top:10px;display:block">Ответ KET</label>
    <pre style="white-space:pre-wrap;word-break:break-word;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;max-height:240px;overflow:auto">${esc(JSON.stringify(ex.resp,null,2))}</pre>`,
    {wide:true});
}
// дефолтные права на случай отсутствия роли — выводим из base_type
function defaultPerms(base){
  const full={view:true,create:true,edit:true,delete:true};
  const ro={view:true,create:false,edit:false,delete:false};
  const no={view:false,create:false,edit:false,delete:false};
  if(base==='admin') return {pickups:full,orders:full,directories:full,users:full};
  if(base==='courier') return {pickups:{view:true,create:false,edit:true,delete:false},orders:{view:true,create:false,edit:true,delete:false},directories:no,users:no};
  return {pickups:full,orders:full,directories:ro,users:no}; // staff/manager
}
function computeMyPerms(){
  // 1) пробуем по role_id из справочника
  let roleRow=null;
  if(S.me.role_id) roleRow=S.roles.find(r=>r.id===S.me.role_id);
  if(roleRow){
    S.myBaseType=roleRow.base_type||'staff';
    const base=defaultPerms(S.myBaseType);
    S.myPerms=Object.assign({},base,roleRow.perms||{});
    // гарантируем все модули
    ['pickups','orders','directories','users'].forEach(m=>{if(!S.myPerms[m])S.myPerms[m]=base[m];});
    return;
  }
  // 2) fallback на старое текстовое поле role
  const base=(S.me.role==='admin')?'admin':(S.me.role==='courier')?'courier':'staff';
  S.myBaseType=base;
  S.myPerms=defaultPerms(base);
}

async function loadMe(session){
  const {data}=await sb.from('profiles').select('*').eq('id',session.user.id).single();
  S.me=data||{id:session.user.id,email:session.user.email,role:'manager',full_name:session.user.email};
  // справочник ролей нужен для вычисления прав
  S.roles=await dbList('roles',{order:'created_at',asc:true});
  computeMyPerms();
}

async function doLogin(){
  let login=$('email').value.trim();const password=$('password').value,errEl=$('loginErr');
  errEl.textContent='';
  if(!login||!password){errEl.textContent='Введите логин и пароль.';return;}
  // если введён телефон (не email) — превращаем в технический email
  let email=login;
  if(!login.includes('@')){
    const digits=login.replace(/\D/g,'').replace(/^[78](?=\d{10}$)/,'').slice(-10);
    if(digits.length===10) email=digits+'@jyldam.local';
  }
  const btn=$('loginBtn');btn.disabled=true;btn.textContent='Входим…';
  const {data,error}=await sb.auth.signInWithPassword({email,password});
  btn.disabled=false;btn.textContent='Войти';
  if(error){
    if(/invalid login/i.test(error.message))errEl.textContent='Неверный логин или пароль.';
    else if(/not confirmed/i.test(error.message))errEl.textContent='Аккаунт не подтверждён в Supabase.';
    else if(/disabled/i.test(error.message))errEl.textContent='Вход по email отключён в Supabase.';
    else errEl.textContent='Ошибка: '+error.message;
    return;
  }
  await loadMe(data.session);
  await logAction('login','auth',{entity_label:S.me.full_name||S.me.email});
  await enterApp();
}
async function doLogout(){await logAction('logout','auth',{entity_label:(S.me&&(S.me.full_name||S.me.email))||''});if(_autoRefreshTimer){clearInterval(_autoRefreshTimer);_autoRefreshTimer=null;}await sb.auth.signOut();S.me=null;clearNav();$('email').value='';_emailPrevRaw='';$('password').value='';showLogin();}
function showLogin(){$('appShell').style.display='none';$('loginScreen').style.display='grid';hideSplash();
  // по умолчанию подставляем +7 (можно стереть и ввести email)
  const el=$('email');if(el&&!el.value){el.value='+7 ';}
}
function hideSplash(){const s=$('splash');if(!s)return;s.classList.add('hide');setTimeout(()=>{if(s.parentNode)s.remove();},600);}

$('loginBtn').onclick=doLogin;
$('password').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
$('email').addEventListener('keydown',e=>{if(e.key==='Enter')$('password').focus();});
// форматирование телефона в поле логина: +7 (777) 777-77-77. Email не трогаем.
let _emailPrevRaw='';
$('email').addEventListener('input',function(){
  const el=this;const raw=el.value;
  // если есть буквы или @ — это email, форматирование не применяем
  if(/[a-zA-Zа-яА-Я@]/.test(raw)){_emailPrevRaw=raw;return;}
  // сначала отрезаем сам служебный префикс «+7» (если он уже есть в поле) — иначе его «7»
  // ошибочно считается первой цифрой номера при подсчёте, и всё дублируется/съезжает
  let rest=raw;
  if(rest.startsWith('+7'))rest=rest.slice(2);
  let d=rest.replace(/\D/g,'');
  // «умный» backspace: скобки/пробел/тире рисует сама маска, а не человек. Если стёрли именно
  // такой символ (значение стало короче, а цифр осталось столько же) — маска тут же дорисует его
  // обратно, и удаление визуально «зависает» на месте. В этом случае убираем ещё и саму цифру.
  const prevRest=_emailPrevRaw.startsWith('+7')?_emailPrevRaw.slice(2):_emailPrevRaw;
  const prevDigits=prevRest.replace(/\D/g,'');
  if(raw.length<_emailPrevRaw.length&&d.length===prevDigits.length&&d.length>0)d=d.slice(0,-1);
  if(!d){el.value='';_emailPrevRaw='';return;} // поле можно полностью очистить (например, для ввода email)
  // если вставили номер целиком со своим кодом страны внутри (частый случай при копировании
  // с 8 впереди) — срезаем его, но только когда цифр реально больше 10
  if(d.length>10&&(d[0]==='7'||d[0]==='8'))d=d.slice(1);
  d=d.slice(0,10);
  el.value='+7 '+fmt10(d);
  _emailPrevRaw=el.value;
  // курсор в конец (телефон вводят последовательно)
  const n=el.value.length;requestAnimationFrame(()=>{try{el.setSelectionRange(n,n);}catch(e){}});
});
// при фокусе на поле логина ставим курсор в конец (после +7)
$('email').addEventListener('focus',function(){const el=this;if(el.value){const n=el.value.length;requestAnimationFrame(()=>{try{el.setSelectionRange(n,n);}catch(e){}});}});
$('logoutBtn').onclick=doLogout;
// сворачивание бокового меню (состояние запоминается)
function applyNavCollapsed(){
  const on=localStorage.getItem('navCollapsed')==='1';
  document.body.classList.toggle('nav-collapsed',on);
  const b=$('navCollapse');
  if(b){b.textContent=on?'›':'‹';b.title=on?'Развернуть меню':'Свернуть меню';}
}
if($('navCollapse'))$('navCollapse').onclick=()=>{
  const on=localStorage.getItem('navCollapsed')==='1';
  localStorage.setItem('navCollapsed',on?'0':'1');
  applyNavCollapsed();
};
applyNavCollapsed();

// ── МОБИЛЬНОЕ ВЫДВИЖНОЕ МЕНЮ ──
function openSidebar(){const s=$('sidebar'),b=$('sidebarBackdrop');if(s)s.classList.add('open');if(b)b.classList.add('show');}
function closeSidebar(){const s=$('sidebar'),b=$('sidebarBackdrop');if(s)s.classList.remove('open');if(b)b.classList.remove('show');}
if($('menuToggle'))$('menuToggle').onclick=()=>{const s=$('sidebar');if(s&&s.classList.contains('open'))closeSidebar();else openSidebar();};
if($('sidebarBackdrop'))$('sidebarBackdrop').onclick=closeSidebar;

/* ---------- ENTER APP: load all reference data ---------- */
async function loadAll(){
  // ЛЁГКОЕ ЯДРО: справочники (мелкие таблицы) — грузятся быстро, интерфейс сразу готов
  const [cities,districts,couriers,order_couriers,sales,processors,partners,statuses,orderStatuses,delivery,courier_cities,post_ips]=await Promise.all([
    dbList('cities',{order:'name'}),dbList('districts',{order:'name'}),dbList('couriers',{order:'fio'}),
    dbList('order_couriers',{order:'fio'}),dbList('sales_managers',{order:'fio'}),dbList('processors',{order:'fio'}),
    dbList('partners',{order:'name'}),dbList('statuses',{order:'created_at',asc:true}),dbList('order_statuses',{order:'created_at',asc:true}),dbList('delivery_types',{order:'created_at',asc:true}),
    dbList('courier_cities',{order:'name'}),dbList('post_ips',{order:'name'}),
  ]);
  Object.assign(S,{cities,districts,couriers,order_couriers,sales,processors,partners,statuses,orderStatuses,delivery,courier_cities,post_ips});
  // нормативы и склады — тоже лёгкие, параллельно
  const tail=await Promise.all([
    can('users','view')?dbList('profiles',{order:'created_at',asc:true}):Promise.resolve(null),
    dbList('calc_settings',{}).catch(()=>[]),
    dbList('calc_city_norms',{}).catch(()=>[]),
    dbList('calc_courier_norms',{}).catch(()=>[]),
    dbList('calc_sales_norms',{}).catch(()=>[]),
    dbList('shipments',{}).catch(()=>[]),
    dbList('warehouses',{order:'name'}).catch(()=>[]),
    dbList('products',{order:'name',select:PRODUCT_LIST_COLS}).catch(()=>[]),
    dbList('warehouse_partners',{order:'name'}).catch(()=>[]),
    dbList('wh_moves',{order:'created_at',asc:false}).catch(()=>[]),
    dbList('wh_order_items',{}).catch(()=>[]),
    dbList('wh_reservations',{order:'created_at',asc:false}).catch(()=>[]),
    dbList('finance_kassa',{order:'name'}).catch(()=>[]),
    dbList('finance_categories',{order:'name'}).catch(()=>[]),
    dbList('finance_income_categories',{order:'name'}).catch(()=>[]),
    dbList('finance_partners',{order:'name'}).catch(()=>[]),
    dbList('finance_entries',{order:'entry_date',asc:false}).catch(()=>[]),
  ]);
  if(tail[0])S.profiles=tail[0];
  S.calcSettingsAll=tail[1]||[];S.calcCityNorms=tail[2]||[];
  S.calcCourierNorms=tail[3]||[];S.calcSalesNorms=tail[4]||[];
  S.shipments=tail[5]||[];S.warehouses=tail[6]||[];S.products=tail[7]||[];S.warehouse_partners=tail[8]||[];S.wh_moves=tail[9]||[];S.wh_order_items=tail[10]||[];S.wh_reservations=tail[11]||[];
  S.finance_kassa=tail[12]||[];S.finance_categories=tail[13]||[];S.finance_income_categories=tail[14]||[];S.finance_partners=tail[15]||[];S.finance_entries=tail[16]||[];
  // ТЯЖЁЛОЕ (заказы + заявки, тысячи строк за всё время) грузим ПАРАЛЛЕЛЬНО с ядром,
  // но вход их НЕ ждёт — стартуем загрузку и продолжаем.
  // Сначала — быстрый узкий запрос ТОЛЬКО за сегодня (большинство экранов по умолчанию и
  // показывают только сегодня), чтобы не сидеть с пустым/загружающимся экраном, пока грузится
  // вся история. Полная история докачивается следом и подменяет данные, когда будет готова.
  S.pickups=S.pickups||[];S.orders=S.orders||[];
  const _todayISO=localToday();
  Promise.all([
    // заявки — фильтруем по ДАТЕ ЗАБОРА (pickup_date), а не по дате создания записи: заявка могла
    // быть создана вчера вечером, но назначена на сегодня — по created_at она бы потерялась
    dbList('pickups',{order:'created_at',asc:false,gte:{col:'pickup_date',val:_todayISO}}),
    dbList('orders',{order:'created_at',asc:false,gte:{col:'created_at',val:_todayISO}}),
  ]).then(([pickupsToday,ordersToday])=>{
    if(S._heavyLoaded)return; // полная история уже подъехала — быстрые «сегодняшние» данные больше не нужны
    S.pickups=pickupsToday;S.orders=ordersToday;
    try{if(typeof render==='function')render();if(typeof buildNav==='function')buildNav({skipTabFix:true});}catch(e){}
  }).catch(e=>console.error('quick today load',e));
  S._heavyLoading=Promise.all([
    dbList('pickups',{order:'created_at',asc:false}),
    dbList('orders',{order:'created_at',asc:false}),
  ]).then(([pickups,orders])=>{
    S.pickups=pickups;S.orders=orders;S._heavyLoaded=true;
    // перерисуем текущий экран, когда тяжёлые данные пришли
    try{if(typeof render==='function')render();if(typeof buildNav==='function')buildNav({skipTabFix:true});}catch(e){}
  }).catch(e=>{console.error('heavy load',e);});
}

// Подтягивает свежие данные с сервера для выбранной вкладки (без перезагрузки страницы)
async function refreshForTab(tab){
  try{
    if(tab==='pickups'){
      const [pickups,orders]=await Promise.all([
        dbList('pickups',{order:'created_at',asc:false}),
        dbList('orders',{order:'created_at',asc:false}),
      ]);
      // защита: если раньше заявки уже были, а сейчас вдруг пришёл пустой список — почти наверняка
      // сбой сети (частое дело на мобильном у курьеров в дороге), а не то, что все заявки правда
      // исчезли. Не затираем то, что уже показано, — подождём следующего успешного обновления.
      if(pickups.length||!S.pickups.length)S.pickups=pickups;
      if(orders.length||!S.orders.length)S.orders=orders;
    }else if(tab==='orders'||tab==='courier'||tab==='mail'||tab==='today'||tab==='dashboard'||tab==='sorting'){
      const [orders,pickups]=await Promise.all([
        dbList('orders',{order:'created_at',asc:false}),
        dbList('pickups',{order:'created_at',asc:false}),
      ]);
      if(orders.length||!S.orders.length)S.orders=orders;
      if(pickups.length||!S.pickups.length)S.pickups=pickups;
    }else if(tab==='ket_orders'){
      // Фоновое обновление НЕ должно перетягивать всю историю заказов партнёров.
      // Раньше здесь вызывался loadInbound() без параметров, а он наследует режим от
      // прошлого вызова: стоило один раз применить фильтр (он грузит всё), и каждый
      // тик раз в 3 минуты заново качал 36 тысяч заказов со всеми позициями — десятки
      // мегабайт на ровном месте. Сами строки и так обновляются мгновенно через
      // Realtime, поэтому в фоне обновляем только счётчики: это три лёгких запроса.
      if(typeof loadInboundCounts==='function'){try{await loadInboundCounts();}catch(e){}}
    }else if(tab==='partners'){
      const [partners,cities,districts,sales,processors,whp]=await Promise.all([
        dbList('partners',{order:'name'}),dbList('cities',{order:'name'}),dbList('districts',{order:'name'}),
        dbList('sales_managers',{order:'fio'}),dbList('processors',{order:'fio'}),dbList('warehouse_partners',{order:'name'}).catch(()=>[]),
      ]);
      Object.assign(S,{partners,cities,districts,sales,processors});S.warehouse_partners=whp||[];
    }else if(tab==='settings'){
      // справочники: тянем всё, что показывается
      const [cities,districts,couriers,order_couriers,sales,processors,partners,statuses,orderStatuses,delivery,courier_cities,post_ips]=await Promise.all([
        dbList('cities',{order:'name'}),dbList('districts',{order:'name'}),dbList('couriers',{order:'fio'}),
        dbList('order_couriers',{order:'fio'}),dbList('sales_managers',{order:'fio'}),dbList('processors',{order:'fio'}),
        dbList('partners',{order:'name'}),dbList('statuses',{order:'created_at',asc:true}),dbList('order_statuses',{order:'created_at',asc:true}),dbList('delivery_types',{order:'created_at',asc:true}),
        dbList('courier_cities',{order:'name'}),dbList('post_ips',{order:'name'}),
      ]);
      Object.assign(S,{cities,districts,couriers,order_couriers,sales,processors,partners,statuses,orderStatuses,delivery,courier_cities,post_ips});
    }else if(tab==='users'){
      if(can('users','view'))S.profiles=await dbList('profiles',{order:'created_at',asc:true});
      S.roles=await dbList('roles',{order:'created_at',asc:true});
    }else if(tab==='cash'){
      try{const [pr,wp,wm,oi,rv]=await Promise.all([dbList('products',{order:'name',select:PRODUCT_LIST_COLS}),dbList('warehouse_partners',{order:'name'}),dbList('wh_moves',{order:'created_at',asc:false}),dbList('wh_order_items',{}),dbList('wh_reservations',{order:'created_at',asc:false})]);S.products=pr;S.warehouse_partners=wp;S.wh_moves=wm;S.wh_order_items=oi;S.wh_reservations=rv;}catch(e){}
    }else if(tab==='history'||tab==='notify'){
      await loadActivityLog();
      if(tab==='notify'){
        try{
          // чистим корзину от всего старше 30 дней — сначала сама чистка, потом загружаем оставшееся
          const cutoff=new Date();cutoff.setDate(cutoff.getDate()-30);
          await sb.from('deleted_items').delete().lt('deleted_at',cutoff.toISOString());
        }catch(e){console.error('trash cleanup',e);}
        try{S.deletedItems=await dbList('deleted_items',{order:'deleted_at',asc:false});}catch(e){S.deletedItems=[];}
      }
    }else if(tab==='intercity'){
      try{S.shipments=await dbList('shipments',{});}catch(e){}
      try{S.orders=await dbList('orders',{order:'created_at',asc:false});}catch(e){}
    }else if(tab==='calc'){
      // нормативы грузим параллельно (быстрее, чем по очереди)
      try{
        const [cs,cc,cn,sn]=await Promise.all([
          dbList('calc_settings',{}),dbList('calc_city_norms',{}),
          dbList('calc_courier_norms',{}),dbList('calc_sales_norms',{})
        ]);
        S.calcSettingsAll=cs;S.calcCityNorms=cc;S.calcCourierNorms=cn;S.calcSalesNorms=sn;
      }catch(e){}
      // заказы уже загружены при входе — перезагружаем только если их нет
      if(!S.orders||!S.orders.length){try{S.orders=await dbList('orders',{order:'created_at',asc:false});}catch(e){}}
    }
  }catch(e){console.error('refresh',e);}
}

async function enterApp(){
  $('loginScreen').style.display='none';
  $('appShell').style.display='block';
  $('uName').textContent=S.me.full_name||S.me.email;
  const roleRow=S.me.role_id?S.roles.find(r=>r.id===S.me.role_id):null;
  const roleTxt=roleRow?roleRow.name:(ROLE_LABEL[S.me.role]||S.me.role||'');
  // не дублируем: если имя совпадает с ролью — роль не показываем
  const nameTxt=(S.me.full_name||S.me.email||'').trim().toLowerCase();
  $('uRole').textContent=(roleTxt&&roleTxt.trim().toLowerCase()===nameTxt)?'':roleTxt;
  $('main').innerHTML='<div class="loading">Загружаем данные…</div>';
  try{ await loadAll(); }catch(e){ console.error('loadAll',e); }
  try{ loadNav(); }catch(e){ console.error('loadNav',e); }
  try{ buildNav(); }catch(e){ console.error('buildNav',e); }
  try{ render(); }catch(e){
    console.error('render',e);
    // если сохранённая вкладка битая — сбрасываем и пробуем заново
    S.tab='dashboard';
    try{ buildNav(); render(); }catch(err){ $('main').innerHTML='<div class="empty"><div class="big">Не удалось открыть раздел</div><div style="font-size:12px;color:var(--rust);margin-top:10px;word-break:break-word">'+esc(String(err&&err.message||err))+'</div>Обновите страницу.</div>'; }
  }
  hideSplash();
  startAutoRefresh(); // фоновое обновление данных каждые 30 сек (без сброса работы)
  // фото теперь показываются по временным ссылкам: следим за появлением <img data-ph>
  // и подставляем ссылки сами, чтобы не переделывать каждое место отрисовки
  startPhotoHydration();
}

// ── ФОНОВОЕ АВТООБНОВЛЕНИЕ ДАННЫХ (каждые 30 сек, безопасно) ──
let _autoRefreshTimer=null;
function startAutoRefresh(){
  if(_autoRefreshTimer)clearInterval(_autoRefreshTimer);
  _autoRefreshTimer=setInterval(autoRefreshTick,180000); // 3 минуты — просто подстраховка, если Realtime отвалится (сам Realtime обновляет мгновенно)
  startRealtime(); // мгновенные обновления
}

/* ── REALTIME: мгновенное обновление статусов и данных ── */
let _rtChannel=null,_rtPending=false,_rtTimer=null;
function startRealtime(){
  try{
    if(_rtChannel){sb.removeChannel(_rtChannel);_rtChannel=null;}
    _rtChannel=sb.channel('jyldam-live')
      // изменения заявок на забор
      .on('postgres_changes',{event:'*',schema:'public',table:'pickups'},payload=>applyRealtime('pickups',payload))
      // изменения заказов
      .on('postgres_changes',{event:'*',schema:'public',table:'orders'},payload=>applyRealtime('orders',payload))
      // изменения статусов заказов КЕТ (send_status/status_kz/call_status) — приходят от вебхука KET
      .on('postgres_changes',{event:'*',schema:'public',table:'inbound_orders'},payload=>applyRealtime('inbound_orders',payload))
      .subscribe();
  }catch(e){console.warn('realtime',e);}
}
// применяем изменение из базы к данным в памяти
const RT_TABLE_ARR={pickups:'pickups',orders:'orders',inbound_orders:'inbound_orders'};
function applyRealtime(table,payload){
  try{
    const key=RT_TABLE_ARR[table]||table;
    // Заказы партнёров (KET) грузятся лениво — только при открытии модуля. Если массива
    // ещё нет, НЕЛЬЗЯ создавать его здесь: модуль проверяет именно `if(!S.inbound_orders)`,
    // чтобы понять, нужна ли первая загрузка. Один прилетевший заказ делал массив непустым,
    // первая загрузка не срабатывала, и модуль показывал вместо списка пару случайных строк.
    if(key==='inbound_orders'&&!S[key])return;
    if(!S[key])S[key]=[];
    const arr=S[key];
    const row=payload.new||payload.old;
    if(!row||!row.id)return;
    if(payload.eventType==='INSERT'){
      if(!arr.find(x=>x.id===row.id)){
        arr.unshift(row);
        if(table==='pickups')notifyNewPickup(row); // новая заявка — звук + уведомление
      }
    }else if(payload.eventType==='UPDATE'){
      const i=arr.findIndex(x=>x.id===row.id);
      if(i>=0)Object.assign(arr[i],row); else arr.unshift(row);
    }else if(payload.eventType==='DELETE'){
      const i=arr.findIndex(x=>x.id===row.id);
      if(i>=0)arr.splice(i,1);
    }
    scheduleRtRender(table);
  }catch(e){console.warn('applyRealtime',e);}
}
// звук + всплывающее уведомление при новой заявке на забор (в т.ч. от партнёра из личного кабинета) —
// коротко пикает через Web Audio (без внешних файлов) и, если разрешение на уведомления браузера уже
// выдано, показывает системный тост поверх остальных окон/вкладок
// один общий аудио-контекст на всё приложение (создаём один раз, не на каждый сигнал) +
// «разблокируем» его первым же кликом/тапом пользователя — иначе браузер молча блокирует звук,
// пока не было явного взаимодействия со страницей
let _audioCtx=null;
function getAudioCtx(){
  if(!_audioCtx){try{_audioCtx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){}}
  return _audioCtx;
}
['click','touchstart','keydown'].forEach(ev=>document.addEventListener(ev,()=>{
  const ctx=getAudioCtx();if(ctx&&ctx.state==='suspended')ctx.resume().catch(()=>{});
},{passive:true}));
function notifyNewPickup(p){
  if(!S.me||!can('pickups','view'))return; // не мешаем тем, у кого нет доступа к заявкам
  try{
    const ctx=getAudioCtx();
    if(ctx){
      const play=()=>{
        const beep=(freq,start,dur)=>{
          const o=ctx.createOscillator(),g=ctx.createGain();
          o.type='sine';o.frequency.value=freq;o.connect(g);g.connect(ctx.destination);
          g.gain.setValueAtTime(0.0001,ctx.currentTime+start);
          g.gain.exponentialRampToValueAtTime(0.25,ctx.currentTime+start+0.02);
          g.gain.exponentialRampToValueAtTime(0.0001,ctx.currentTime+start+dur);
          o.start(ctx.currentTime+start);o.stop(ctx.currentTime+start+dur+0.02);
        };
        beep(880,0,0.14);beep(1180,0.16,0.18);
      };
      if(ctx.state==='suspended')ctx.resume().then(play).catch(()=>{}); // без хотя бы одного клика по странице раньше браузер это всё равно не пропустит
      else play();
    }
  }catch(e){}
  const title=`📝 Новая заявка: ${p.name||'без названия'}`;
  toast(title);
  if(typeof Notification!=='undefined'&&Notification.permission==='granted'){
    try{new Notification(title,{body:p.address||'',icon:'',tag:'pickup-'+p.id});}catch(e){}
  }
}
// перерисовка с небольшой задержкой (чтобы не дёргать экран при пачке изменений)
let _rtInboundTimer=null,_rtInboundLastRun=0;
function scheduleRtRender(table){
  // заказы КЕТ прилетают ОЧЕНЬ часто (могут идти почти каждую секунду непрерывно) — если тут
  // использовать обычный сброс таймера (debounce), а поток заказов не прерывается, обновление
  // экрана может не сработать вообще никогда (таймер бы постоянно сбрасывался). Поэтому для этой
  // таблицы — throttle: гарантированно не чаще раза в 4 секунды, но и не реже.
  if(table==='inbound_orders'){
    // Данные KET видны ТОЛЬКО в своём модуле — ни счётчика в меню, ни на дашборде у них нет.
    // Раньше поток заказов от KET (он может идти почти непрерывно) перерисовывал текущий
    // экран каждые 4 секунды, какой бы модуль ни был открыт: список дёргался, прокрутка
    // сбрасывалась. В памяти данные уже обновлены выше — этого достаточно.
    if(S.tab!=='ket_orders')return;
    if(_rtInboundTimer)return; // уже запланировано — просто ждём
    const wait=Math.max(0,4000-(Date.now()-_rtInboundLastRun));
    _rtInboundTimer=setTimeout(()=>{
      _rtInboundTimer=null;_rtInboundLastRun=Date.now();
      if(!canAutoRefresh())return;
      try{render();buildNav({skipTabFix:true});}catch(e){}
    },wait);
    return;
  }
  if(_rtTimer)clearTimeout(_rtTimer);
  _rtTimer=setTimeout(()=>{
    _rtTimer=null;
    if(!canAutoRefresh())return; // пользователь занят — не мешаем, обновим позже
    try{render();buildNav({skipTabFix:true});}catch(e){}
  },400);
}
// можно ли сейчас обновлять — НЕ обновляем, если пользователь работает
let _lastScrollAt=0;
window.addEventListener('scroll',()=>{_lastScrollAt=Date.now();},{passive:true});
function canAutoRefresh(){
  // открыта любая модалка/карточка — не трогаем (чтобы не сбросить ввод)
  if(document.querySelector('.overlay'))return false;
  // открыт попап фильтра по столбцу (Заказы партнёров) — не трогаем, даже если фокус вдруг
  // не на поле ввода (иначе фоновое обновление тихо ломает попап посреди работы с ним)
  if(document.querySelector('.inb-col-filter-pop'))return false;
  // пользователь печатает/выбирает в каком-то поле — не трогаем
  const a=document.activeElement;
  if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return false;
  // пользователь активно листает (скроллил менее 3 сек назад) — не дёргаем
  if(Date.now()-_lastScrollAt<3000)return false;
  // вкладка браузера не активна — нет смысла (обновим, когда вернётся)
  if(document.hidden)return false;
  // на экране входа — не обновляем
  if($('loginScreen')&&$('loginScreen').style.display!=='none')return false;
  return true;
}
async function autoRefreshTick(){
  if(!canAutoRefresh())return; // занят — пропускаем этот цикл, попробуем через 30 сек
  try{
    // запоминаем позицию прокрутки, чтобы не «дёргать» экран при перерисовке
    const sx=window.scrollX, sy=window.scrollY;
    await refreshForTab(S.tab);   // тихо тянем свежие данные для текущего раздела
    if(canAutoRefresh()){
      render(); // перерисовываем, только если за время загрузки никто не начал работать
      requestAnimationFrame(()=>{try{window.scrollTo(sx,sy);}catch(e){}});
    }
  }catch(e){console.error('autoRefresh',e);}
}

/* ---------- ХЕЛПЕРЫ ИМЁН ---------- */
const cityName=id=>(S.cities.find(c=>c.id===id)||{}).name||'—';
const districtName=id=>(S.districts.find(d=>d.id===id)||{}).name||'—';
const courierName=id=>(S.couriers.find(c=>c.id===id)||{}).fio||'—';
const orderCourierName=id=>(S.order_couriers.find(c=>c.id===id)||{}).fio||'—';
const salesName=id=>(S.sales.find(s=>s.id===id)||{}).fio||'—';
const processorName=id=>(S.processors.find(s=>s.id===id)||{}).fio||'—';
const deliveryName=id=>(S.delivery.find(d=>d.id===id)||{}).name||'—';
const postIpName=id=>(S.post_ips.find(d=>d.id===id)||{}).name||'—';
const courierCityName=id=>(S.courier_cities.find(c=>c.id===id)||{}).name||'—';
const partnerName=id=>(S.partners.find(p=>p.id===id)||{}).name||'—';
// плашка города с нейтральным цветом для Алматы/Астаны
function cityPill(cityId){
  const nm=cityName(cityId);
  let cls='gold';
  if(/алмат/i.test(nm))cls='city-almaty';
  else if(/астан|нур-?султан|нур\s*султан/i.test(nm))cls='city-astana';
  return `<span class="pill ${cls}">${esc(nm)}</span>`;
}
const statusObj=id=>S.statuses.find(s=>s.id===id)||null;
// статус означает «собрано/забрано»: по слову в названии
function isCollectedStatus(id){const s=statusObj(id);if(!s)return false;return /забра|забро|собра|готов/i.test(s.name||'');}
const isCourierDelivery=id=>{const d=S.delivery.find(x=>x.id===id);return d?/курьер/i.test(d.name):false;};
function statusBadge(id){const s=statusObj(id);if(!s)return '<span style="color:var(--muted)">—</span>';
  return `<span class="pill" style="color:${s.color};background:${s.color}1a;border-color:${s.color}55">${esc(s.name)}</span>`;}
// статусы ЗАКАЗА (отдельный справочник)
const orderStatusObj=id=>S.orderStatuses.find(s=>s.id===id)||null;
function orderStatusBadge(id){const s=orderStatusObj(id);if(!s)return '<span style="color:var(--muted)">—</span>';
  return `<span class="pill" style="color:${s.color};background:${s.color}1a;border-color:${s.color}55">${esc(s.name)}</span>`;}
// статус обзвона клиента (Недозвон / Прозвонен / Изменен) — цвет для плашки в гриде заказов
function callStatusColor(v){
  if(v==='Недозвон')return '#c0392b';
  if(v==='Прозвонен')return '#2e7d32';
  if(v==='Изменен')return '#c08a2d';
  return 'var(--line)';
}
// статус заказа по умолчанию — «Получено от отправителя» (первый в списке)
function defaultOrderStatusId(){
  const byName=S.orderStatuses.find(s=>/получено от отправител/i.test(s.name||''));
  return byName?byName.id:(S.orderStatuses[0]?S.orderStatuses[0].id:null);
}
// статус заявки по умолчанию — «Новый» (или первый в справочнике)
function defaultPickupStatusId(){
  const byName=S.statuses.find(s=>/нов/i.test(s.name||''));
  return byName?byName.id:(S.statuses[0]?S.statuses[0].id:null);
}
function fmtDate(d){if(!d)return '—';const p=String(d).slice(0,10).split('-');if(p.length<3)return d;return `${p[2]}.${p[1]}.${p[0]}`;}
function fmtDateTime(ts){if(!ts)return '';const d=new Date(ts);const p=n=>String(n).padStart(2,'0');
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;}

/* ---------- ПРАВА ДОСТУПА ---------- */
// can(module, action): module ∈ pickups|orders|directories|users; action ∈ view|create|edit|delete
function can(mod,act){
  if(isAdminBase())return true; // админу всегда доступно всё — даже если под новый модуль ещё не
  // сохранены явные права в «Роли и права» (иначе кнопки создания/редактирования в свежедобавленных
  // модулях могли не показываться даже у самого администратора)
  if(!S.myPerms)return false;
  const m=S.myPerms[mod];
  return !!(m&&m[act]);
}
// проверка доступа к модулю меню. Если для модуля заданы явные права — используем их,
// иначе фолбэк на базовое право (обратная совместимость со старыми ролями).
function canMod(key){
  if(!S.myPerms)return false;
  // если админ — всё доступно
  if(isAdminBase())return true;
  // явное право на модуль (новые модули). settings хранится как directories
  const permKey=key==='settings'?'directories':key;
  if(S.myPerms[permKey]&&typeof S.myPerms[permKey].view!=='undefined')return !!S.myPerms[permKey].view;
  // фолбэк: старая привязка модулей к базовым правам
  const fb={dashboard:'orders',pickups:'pickups',orders:'orders',courier:'orders',mail:'orders',
    intercity:null,cash:null,sorting:null,finance:null,calc:null,partners:'directories',history:null,notify:'orders',
    users:'users',settings:'directories'};
  const base=fb[key];
  if(base===null)return isAdminBase(); // модули, что были только для админа
  if(base)return can(base,'view');
  return false;
}
// базовый тип роли — для серверной логики и правила "вижу только своё"
const isAdminBase=()=>S.myBaseType==='admin';
const isCourierBase=()=>S.myBaseType==='courier';
// совместимость со старым кодом:
const isAdmin=()=>isAdminBase();
const isCourier=()=>isCourierBase();
const isStaff=()=>!isCourierBase();   // admin или staff — «персонал»
const isManager=()=>S.myBaseType==='staff';
// id записей курьера, привязанных к текущему пользователю
const myPickupCourierIds=()=>S.couriers.filter(c=>c.account_id===S.me.id).map(c=>c.id);
const myOrderCourierIds=()=>S.order_couriers.filter(c=>c.account_id===S.me.id).map(c=>c.id);

/* ---------- PHONE ---------- */
function phoneStored(v){let d=(v||'').replace(/\D/g,'');if(d.length===11&&(d[0]==='7'||d[0]==='8'))d=d.slice(1);return d.slice(0,10);}
function fmt10(d){d=(d||'').slice(0,10);let o='';if(d.length>0)o+='('+d.slice(0,3);if(d.length>=3)o+=')';
  if(d.length>3)o+=' '+d.slice(3,6);if(d.length>6)o+='-'+d.slice(6,8);if(d.length>8)o+='-'+d.slice(8,10);return o;}
function phoneDisplay(v){const d=phoneStored(v);return d?'+7 '+fmt10(d):'';}
// кликабельный телефон для звонка с мобильного
function phoneLink(v){const d=phoneStored(v);if(!d)return '—';return `<a href="tel:+7${d}" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--muted)">${esc('+7 '+fmt10(d))}</a>`;}
// ссылка на адрес в 2ГИС (открывает поиск адреса в приложении/сайте)
function address2gis(addr,cityNm,orgName){
  const a=(addr||'').trim();
  if(!a)return '<span style="color:var(--muted)">адрес не указан</span>';
  // запрос для 2ГИС: «Название организации, Город, адрес» — чтобы 2ГИС нашёл сам магазин, а не только точку на карте
  const org=(orgName||'').trim();
  const q=(org?org+', ':'')+(cityNm&&cityNm!=='—'?cityNm+', ':'')+a;
  // без href/target — открытие делает только open2gis() по клику, чтобы сайт не открывался параллельно
  return `<a class="addr-link" role="button" tabindex="0" data-gis="${esc(q)}">📍 ${esc(a)}</a>`;
}
// открыть адрес в приложении 2ГИС (deep link). Сайт НЕ открываем
function open2gis(query){
  const q=encodeURIComponent(query);
  const isMobile=/android|iphone|ipad|ipod/i.test(navigator.userAgent||'');
  if(!isMobile){
    // на компьютере приложения нет — открываем сайт в новой вкладке
    window.open('https://2gis.kz/search/'+q,'_blank','noopener');
    return;
  }
  // на телефоне — только схема приложения; сайт не вызываем, кабинет остаётся открытым
  window.location.href='dgis://2gis.ru/search/'+q;
}
function attachPhone(id,initial){
  const el=$(id);if(!el)return;
  if(!el.parentElement.classList.contains('phone-wrap')){
    const w=document.createElement('div');w.className='phone-wrap';el.parentElement.insertBefore(w,el);
    const pre=document.createElement('span');pre.className='phone-pre';pre.textContent='+7';w.appendChild(pre);w.appendChild(el);
  }
  el.dataset.phone=phoneStored(initial);el.value=el.dataset.phone?fmt10(el.dataset.phone):'';el.setAttribute('placeholder','(___) ___-__-__');
  el.addEventListener('input',()=>{
    // сколько цифр было слева от курсора ДО переформатирования
    const selStart=el.selectionStart||0;
    const digitsBeforeCaret=(el.value.slice(0,selStart).match(/\d/g)||[]).length;
    const d=el.value.replace(/\D/g,'').slice(0,10);
    el.dataset.phone=d;el.value=fmt10(d);
    // ставим курсор после того же количества цифр (учитывая скобки/дефисы формата)
    let pos=0,seen=0;
    while(pos<el.value.length&&seen<digitsBeforeCaret){if(/\d/.test(el.value[pos]))seen++;pos++;}
    requestAnimationFrame(()=>{try{el.setSelectionRange(pos,pos);}catch(e){}});
  });
}
function phoneVal(id){const el=$(id);return el?(el.dataset.phone||''):'';}
function val(id){const el=$(id);return el?el.value:'';}

/* ---------- NAV по правам ---------- */
// SVG-иконки для меню
const ICONS={
  dashboard:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="3" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.7"/><rect x="3" y="16" width="7" height="5" rx="1.5" stroke="currentColor" stroke-width="1.7"/></svg>',
  pickups:'<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h11l-2 5h2M5 12h8M6 16h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 8l4 4-4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  orders:'<svg viewBox="0 0 24 24" fill="none"><path d="M6 2l1.5 2h9L18 2M4 6h16l-1.5 14a1 1 0 01-1 .9H6.5a1 1 0 01-1-.9L4 6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 10v6M15 10v6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  handshake:'<svg viewBox="0 0 24 24" fill="none"><path d="M2 12l5-4 4 3 3-2 5 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 8l3.5 3.5a1.8 1.8 0 002.5 0v0a1.8 1.8 0 000-2.5L9 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12v5a1 1 0 001 1h2M22 12v5a1 1 0 01-1 1h-2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><rect x="16" y="7" width="4" height="9" rx="1" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="7" width="4" height="9" rx="1" stroke="currentColor" stroke-width="1.7"/></svg>',
  today:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="15" r="2" fill="currentColor"/></svg>',
  mail:'<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M4 7l8 6 8-6" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  courier:'<svg viewBox="0 0 24 24" fill="none"><path d="M1 7h11v8H1zM12 9h5l4 3v3h-9" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="6" cy="17" r="1.8" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="17" r="1.8" stroke="currentColor" stroke-width="1.7"/></svg>',
  partners:'<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.7"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M16 5a3 3 0 010 6M18 20c0-2-1-3.8-2.5-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  clients:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  history:'<svg viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 4v3.5h3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 21a2 2 0 004 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="1.7"/><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  tariffs:'<svg viewBox="0 0 24 24" fill="none"><path d="M3 7l9-4 9 4-9 4-9-4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 12l9 4 9-4M3 17l9 4 9-4" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  money:'<svg viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M5 9v6M19 9v6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  warehouse:'<svg viewBox="0 0 24 24" fill="none"><path d="M3 21V8l9-5 9 5v13" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 21h18M7 21v-6h10v6M7 13h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cash:'<svg viewBox="0 0 24 24" fill="none"><path d="M3 9l2-4h14l2 4M3 9h18v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 13h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  calc:'<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M8 6h8M8 11h2M12 11h.01M15 11h1M8 15h2M12 15h.01M15 15v3M8 18h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  finance:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M12 7v10M9.5 9.3c0-1 1-1.8 2.5-1.8s2.5.8 2.5 1.8c0 2.4-5 1.2-5 3.6 0 1 1 1.8 2.5 1.8s2.5-.8 2.5-1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  intercity:'<svg viewBox="0 0 24 24" fill="none"><path d="M3 8l9-4 9 4-9 4-9-4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 8v8l9 4 9-4V8" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 12v8" stroke="currentColor" stroke-width="1.7"/></svg>',
  scan:'<svg viewBox="0 0 24 24" fill="none"><path d="M4 8V6a2 2 0 012-2h2M18 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M6 20H4a2 2 0 01-2-2v-2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><rect x="7" y="8" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.7"/></svg>',
};

// цвета групп бокового меню (акцент у заголовка и активного пункта)
const NAV_COLORS={
  'Основное':'#2546c9',            // синий
  'Доставка':'#e07b2a',            // оранжевый
  'Деньги':'#2e7d32',              // зелёный
  'Партнёры':'#8e44ad',            // фиолетовый
  'История':'#0e7490',             // бирюзовый
  'Команда и настройки':'#6b7280', // серый
};
// счётчик заявок на СЕГОДНЯ в работе (Новая / В пути) — для бейджа в меню
function pickupsTodayActive(){
  const today=(()=>{const d=new Date();const off=d.getTimezoneOffset();return new Date(d.getTime()-off*60000).toISOString().slice(0,10);})();
  return (S.pickups||[]).filter(p=>{
    if((p.pickup_date||'').slice(0,10)!==today)return false;
    const st=statusObj(p.status_id);
    const nm=(st&&st.name||'').toLowerCase();
    if(!nm)return true; // без статуса — считаем как новую
    // считаем только «новая» и «в пути»; забрал/отменён/завершён — нет
    return /нов|пути|выехал|принял/i.test(nm);
  }).length;
}
function buildNav(opts){
  opts=opts||{};
  // восстановить свёрнутые группы меню из localStorage (один раз)
  if(!window._navCollapsed){try{window._navCollapsed=JSON.parse(localStorage.getItem('navCollapsed')||'{}');}catch(e){window._navCollapsed={};}}
  const courier=isCourierBase();
  // структура: группы и пункты. active:false — нарисован, но неактивен
  const groups=[];
  if(!courier){
    // Дашборд (только staff/admin)
    const main=[];
    if(canMod('dashboard'))main.push({k:'dashboard',label:'Дашборд',icon:'dashboard'});
    if(canMod('pickups'))main.push({k:'pickups',label:'Заявки на забор',icon:'pickups'});
    if(canMod('orders'))main.push({k:'orders',label:'Заказы заборов',icon:'orders'});
    if(main.length)groups.push({title:'Основное',items:main});

    const delivery=[];
    if(canMod('courier'))delivery.push({k:'courier',label:'Курьерская доставка',icon:'courier'});
    if(canMod('mail'))delivery.push({k:'mail',label:'Почтовая доставка',icon:'mail'});
    if(canMod('intercity'))delivery.push({k:'intercity',label:'Отправки межгород',icon:'intercity'});
    if(isAdmin()||canMod('ket_orders'))delivery.push({k:'ket_orders',label:'Заказы партнёров',icon:'handshake'});
    if(delivery.length)groups.push({title:'Доставка',items:delivery});

    // раздел «Деньги»
    const money=[];
    if(canMod('cash'))money.push({k:'cash',label:'Склад',icon:'warehouse'});
    if(canMod('sorting'))money.push({k:'sorting',label:'Сортировка',icon:'scan'});
    if(canMod('finance'))money.push({k:'finance',label:'Финансы',icon:'finance'});
    if(canMod('calc'))money.push({k:'calc',label:'Калькуляция',icon:'calc'});
    if(money.length)groups.push({title:'Деньги/Склад',items:money});

    const partnerItems=[];
    if(canMod('partners'))partnerItems.push({k:'partners',label:'Партнёры',icon:'partners'});
    if(partnerItems.length)groups.push({title:'Партнёры',items:partnerItems});
    const histItems=[];
    if(canMod('history'))histItems.push({k:'history',label:'История изменений',icon:'history'});
    if(canMod('notify'))histItems.push({k:'notify',label:'Центр контроля',icon:'bell'});
    if(histItems.length)groups.push({title:'История',items:histItems});

    const team=[];
    if(canMod('users'))team.push({k:'users',label:'Сотрудники',icon:'users'});
    if(canMod('settings'))team.push({k:'settings',label:'Настройки',icon:'settings'});
    // (пункт «Документация API» перенесён в Настройки)
    if(team.length)groups.push({title:'Команда и настройки',items:team});
  }else{
    // курьер: только свои разделы, без групп
    const items=[];
    if(can('pickups','view'))items.push({k:'pickups',label:'Мои заборы',icon:'pickups'});
    if(can('orders','view'))items.push({k:'orders',label:'Мои заказы',icon:'orders'});
    groups.push({title:'',items});
  }
  // собрать список активных ключей для проверки текущей вкладки
  const activeKeys=[];groups.forEach(g=>g.items.forEach(it=>{if(!it.disabled&&!it.href)activeKeys.push(it.k);}));
  if(!activeKeys.length)activeKeys.push('none');
  // подмену текущей вкладки на первую доступную делаем ТОЛЬКО не в фоновом вызове — иначе фоновое
  // обновление (например, от Realtime по заказам КЕТ) может незаметно перекинуть человека с открытой
  // страницы (например, «Склад») на другую вкладку прямо во время работы
  if(!opts.skipTabFix&&!activeKeys.includes(S.tab))S.tab=activeKeys[0];

  let html='';
  groups.forEach(g=>{
    const col=NAV_COLORS[g.title]||'#6b7280';
    const collapsed=!!(window._navCollapsed&&window._navCollapsed[g.title]);
    if(g.title)html+=`<div class="nav-group nav-group-toggle" data-navgroup="${esc(g.title)}" style="cursor:pointer" title="Свернуть/развернуть"><span class="ng-dot" style="background:${col}"></span>${esc(g.title)}<span style="margin-left:auto;font-size:11px;opacity:.6">${collapsed?'▸':'▾'}</span></div>`;
    if(collapsed)return; // группа свёрнута — пункты не рисуем
    g.items.forEach(it=>{
      const cls=[it.disabled?'disabled':'',S.tab===it.k?'active':''].filter(Boolean).join(' ');
      // бейджи: заявки на сегодня (в работе) и срочные задачи в центре контроля
      let badge='';
      if(it.k==='pickups'&&!courier){
        try{const c=pickupsTodayActive();if(c)badge=`<span class="nav-badge" title="Заявок на сегодня в работе">${c}</span>`;}catch(e){}
      }
      if(it.k==='notify'){
        try{const c=notifyIssues().filter(i=>i.lvl==='crit').length;if(c)badge=`<span class="nav-badge nb-crit">${c}</span>`;}catch(e){}
      }
      if(it.href){
        html+=`<a href="${esc(it.href)}" target="_blank" rel="noopener" class="${cls}" style="--nav-col:${col}" title="${esc(it.label)}">${ICONS[it.icon]||''}<span>${esc(it.label)}</span></a>`;
      }else{
        html+=`<button data-tab="${it.k}" class="${cls}" ${it.disabled?'data-disabled="1"':''} style="--nav-col:${col}" title="${esc(it.label)}">${ICONS[it.icon]||''}<span>${esc(it.label)}</span>${badge}</button>`;
      }
    });
  });
  $('navTabs').innerHTML=html;
  // профиль внизу меню (аватар с инициалами + роль + индикатор онлайн)
  const su=$('sideUser');
  if(su){
    const nm=(S.me&&(S.me.full_name||S.me.email))||'—';
    const init=nm.trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()||'?';
    su.innerHTML=`<div class="su-ava" title="${esc(nm)}">${esc(init)}</div>
      <div class="su-info"><div class="su-name">${esc(nm)}</div><div class="su-role"><span class="su-dot"></span>Онлайн</div></div>`;
  }
  $('navTabs').querySelectorAll('button[data-tab]').forEach(b=>b.onclick=async()=>{
    if(b.dataset.disabled){toast('Раздел в разработке');return;}
    S.tab=b.dataset.tab;saveNav();buildNav();closeSidebar();
    render(); // мгновенно рисуем из уже загруженных данных
    const myTab=S.tab;
    refreshForTab(myTab).then(()=>{if(S.tab===myTab)render();}).catch(()=>{}); // свежие данные в фоне
  });
  // сворачивание/разворачивание групп меню по клику на заголовок
  $('navTabs').querySelectorAll('[data-navgroup]').forEach(h=>h.onclick=()=>{
    window._navCollapsed=window._navCollapsed||{};
    const t=h.dataset.navgroup;
    window._navCollapsed[t]=!window._navCollapsed[t];
    try{localStorage.setItem('navCollapsed',JSON.stringify(window._navCollapsed));}catch(e){}
    buildNav();
  });
  buildBottomNav();
}

// нижняя панель быстрых вкладок (мобильная). Показывает 4 частых раздела + «Ещё» (открывает полное меню)
function buildBottomNav(){
  const el=$('bottomNav');if(!el)return;
  let items=[];
  if(isCourierBase()){
    if(can('pickups','view'))items.push({k:'pickups',label:'Заборы',icon:'pickups'});
    if(can('orders','view'))items.push({k:'orders',label:'Заказы',icon:'orders'});
  }else{
    items.push({k:'dashboard',label:'Дашборд',icon:'dashboard'});
    if(can('pickups','view'))items.push({k:'pickups',label:'Заборы',icon:'pickups'});
    if(can('orders','view'))items.push({k:'orders',label:'Заказы',icon:'orders'});
    if(can('directories','view'))items.push({k:'partners',label:'Партнёры',icon:'partners'});
  }
  items=items.slice(0,4); // максимум 4 быстрых
  let html=items.map(it=>`<button data-bn="${it.k}" class="${S.tab===it.k?'active':''}">${ICONS[it.icon]||''}<span>${esc(it.label)}</span></button>`).join('');
  // кнопка «Ещё» — открывает полное боковое меню
  html+=`<button data-bnmore="1"><span class="bn-more">☰</span><span>Ещё</span></button>`;
  el.innerHTML=html;
  el.querySelectorAll('[data-bn]').forEach(b=>b.onclick=async()=>{
    S.tab=b.dataset.bn;saveNav();buildNav();closeSidebar();
    render(); // мгновенно из кэша
    const myTab=S.tab;
    refreshForTab(myTab).then(()=>{if(S.tab===myTab)render();}).catch(()=>{}); // свежее в фоне
  });
  const more=el.querySelector('[data-bnmore]');
  if(more)more.onclick=()=>openSidebar();
}
// по умолчанию история показывает СЕГОДНЯШНИЙ день (через фильтр можно любой период)
const _todayStr=(()=>{const d=new Date();const off=d.getTimezoneOffset();return new Date(d.getTime()-off*60000).toISOString().slice(0,10);})();
let hf={q:'',action:'',entity:'',user:'',from:_todayStr,to:_todayStr};
let histPage=1;const HIST_PER_PAGE=50;
const ACTION_LABEL={create:'Создание',update:'Изменение',delete:'Удаление',status:'Смена статуса',ket:'Отправка в KET',login:'Вход',logout:'Выход'};

async function loadActivityLog(){
  try{
    const {data,error}=await sb.from('activity_log').select('*').order('created_at',{ascending:false}).limit(1000);
    if(error){console.error('activity_log',error);S.activityLog=[];return;}
    S.activityLog=data||[];
  }catch(e){console.error(e);S.activityLog=[];}
}
function logActorName(r){return r.user_name||'—';}
function fmtLogTime(ts){if(!ts)return '';const d=new Date(ts);const p=n=>String(n).padStart(2,'0');
  return {date:`${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()}`,time:`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`};}