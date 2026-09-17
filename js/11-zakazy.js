/* ================= МОДУЛЬ: ЗАКАЗЫ ================= */
let of={q:'',status:'',delivery:'',partner:'',sales:'',processor:'',missing:'',pickFrom:'',pickTo:'',delFrom:'',delTo:'',createFrom:'',createTo:'',pickupCity:'',destCity:'',paidBySender:'',callStatus:''};
let ordersDateInit=false; // по умолчанию ставим фильтр даты создания = сегодня (один раз)
let ordersPage=1; // текущая страница пагинации
let ordersPerPage=50; // заказов на страницу (можно менять снизу)
const ORDERS_PAGE_SIZES=[50,100,200,500,1000,1500,2000,2500];
const ketSelected=new Set(); // id выбранных заказов (живёт между страницами)
let ketSelectAll=false; // отмечены ли «все на всех страницах"

function visibleOrders(){
  if(isCourier()){const ids=myOrderCourierIds();return S.orders.filter(o=>ids.includes(o.order_courier_id));}
  return S.orders;
}
function genOrderCode(){
  const ex=new Set(S.orders.map(o=>o.code));let c;
  do{c=String(Math.floor(1000000+Math.random()*9000000));}while(ex.has(c));
  return c;
}
// сколько заказов уже создано по этой заявке
function ordersCountForPickup(pickupId){return S.orders.filter(o=>o.pickup_id===pickupId).length;}
// Создаёт недостающие заказы-заготовки по заявке, подтягивая данные магазина-партнёра
const _creatingOrders={}; // защита от параллельного создания заказов по одной заявке
// «Физ лицо Астана» / «Физ лицо Алматы» — это не магазины, а конкретные клиенты (у каждого свой,
// всегда один и тот же адрес). Проверка по названию, без учёта регистра и лишних пробелов.
// строго «тариф явно поставлен в 0» — не путать с «тариф вообще не заполнен» (null/пусто).
// Важно: +null===0 в JS истинно, поэтому нельзя было просто сравнивать +v===0 напрямую — это
// ловило заодно и всех партнёров с незаполненным тарифом (а таких большинство), а не только тех,
// у кого реально стоит 0. Именно это раньше приводило к тому, что «Оплачено отправителем»
// проставлялось почти всем заказам подряд.
function isExplicitZero(v){return v!=null&&v!==''&&+v===0;}
// «Физ лицо Астана» / «Физ лицо Алматы» — проверка по самому названию (строкой), не только по
// объекту партнёра — пригодится там, где имя вводится текстом (например, в заявке на забор),
// не обязательно выбрано из справочника партнёров
function isFizlicoName(name){
  const n=(name||'').trim().toLowerCase().replace(/["«»‘’'']/g,'').replace(/\s+/g,' ').trim();
  return n==='физ лицо астана'||n==='физ лицо алматы';
}
function isFizlicoPartner(partner){
  return isFizlicoName(partner&&partner.name);
}
async function createOrdersFromPickup(pickupId,opts){
  opts=opts||{};
  const p=S.pickups.find(x=>x.id===pickupId);if(!p)return;
  // если по этой заявке уже идёт создание — не запускаем второй раз (защита от двойного клика/гонки в этой же вкладке)
  if(_creatingOrders[pickupId]){if(!opts.silent)toast('Заказы уже создаются…');return;}
  const want=Math.max(0,parseInt(p.orders||'0',10)||0);
  if(!want){if(!opts.silent)toast('Укажите количество заказов');return;}
  _creatingOrders[pickupId]=true;
  try{
    // СВЕЖИЙ подсчёт прямо из базы (не из локального кэша) — если по этой же заявке заказы
    // прямо сейчас создаются в другой вкладке/другим сотрудником, здесь мы это увидим и не задвоим.
    // Заодно синхронизируем локальный кэш этими строками, чтобы список в интерфейсе не отставал.
    const freshRows=await dbListWhere('orders','pickup_id',pickupId);
    if(freshRows){
      freshRows.forEach(r=>{const i=S.orders.findIndex(x=>x.id===r.id);if(i>=0)S.orders[i]=r;else S.orders.unshift(r);});
    }
    const have=freshRows?freshRows.length:ordersCountForPickup(pickupId); // если запрос не удался — fallback на локальный кэш
    const need=want-have;
    if(need<=0){if(!opts.silent)toast(have?`Уже создано ${have} заказ(ов) по заявке`:'Нечего создавать');return;}
    // ищем партнёра по имени из заявки, чтобы подтянуть его данные
    const partner=S.partners.find(x=>x.name===p.name)||null;
    // тип доставки по умолчанию — курьерский, если есть такой тип
    const courierDelivery=S.delivery.find(x=>/курьер/i.test(x.name));
    const baseStatus=defaultOrderStatusId();
    // собираем ВСЕ строки заранее и вставляем ОДНИМ запросом — раньше вставляли по одной штуке в
    // цикле (каждая ждала ответ сервера), и на партиях в сотни заказов это могло занимать больше
    // минуты и выглядело как зависание. Пакетная вставка — доли секунды даже на 500+ строк.
    const rows=[];
    // по умолчанию всем автосозданным заказам сразу проставляем размер S (самый частый случай) и
    // сумму по тарифу партнёра — курьеру останется вручную поменять только исключения (M/L), а не
    // выбирать размер для каждого заказа с нуля
    const defaultSizes=packageSizesFor(partner);
    const defaultCost=courierDelivery?defaultSizes.S.courier:defaultSizes.S.mail;
    for(let i=0;i<need;i++){
      rows.push({
        code:genOrderCode(),
        pickup_id:pickupId,
        partner_id:partner?partner.id:null,
        sender:partner?partner.name:(p.name||''),
        pickup_date:p.pickup_date||null,
        phone:'', // телефон клиента-получателя заполняется вручную, не телефон магазина
        // для «Физ лицо Астана» / «Физ лицо Алматы» — это не магазины, а конкретные клиенты.
        // В самой заявке для них два разных адреса: «Адрес» (откуда забрали — идёт в
        // fizlico_pickup_address) и «Адрес доставки» (куда везём — идёт в обычный address).
        // Для обычных партнёров всё как раньше — адрес доставки клиента заполняется вручную.
        address:isFizlicoName(p.name)?(p.delivery_address||''):'',
        fizlico_pickup_address:isFizlicoName(p.name)?(p.address||(partner&&partner.address)||''):null,
        client:'',weight:null,qty:1,
        delivery_id:courierDelivery?courierDelivery.id:null,
        courier_city_id:null,
        pickup_city_id:partner?partner.city_id||null:(p.city_id||null), // город забора из партнёра/заявки
        status_id:baseStatus,
        sales_id:partner?partner.sales_id:(p.sales_id||null),
        processor_id:partner?partner.processor_id:(p.processor_id||null),
        size:'S', // по умолчанию — сотрудник/курьер меняет вручную, только если посылка реально M или L
        cost:defaultCost, order_sum:defaultCost,
        // эти заказы всегда курьерские (курьер забирает у партнёра) — если у партнёра именно
        // курьерский тариф стоит ровно 0, он оплачивает эту доставку сам отдельно, не через сумму
        // заказа — сразу помечаем «Оплачено отправителем». Почтовый тариф тут ни при чём — заказ
        // не почтовый. order_sum_orig подтягиваем из карточки партнёра (условная сумма при прямой
        // оплате) — иначе Калькуляции неоткуда взять «условную выручку» по этим заказам.
        paid_by_sender:!!(partner&&isExplicitZero(partner.tariff_courier)),
        order_sum_orig:(partner&&isExplicitZero(partner.tariff_courier)&&partner.direct_pay_amount!=null)?partner.direct_pay_amount:null,
        index:'',track:'',pay_date:null,post_ip_id:null,order_courier_id:null
      });
    }
    let created=0;
    // Supabase/PostgREST спокойно принимает несколько тысяч строк за раз, но на всякий случай
    // (лимиты размера запроса, таймауты на слабом интернете) режем на пачки по 200 штук —
    // для 500 заказов это всего 3 запроса вместо пятисот
    const CHUNK=200;
    for(let i=0;i<rows.length;i+=CHUNK){
      const chunk=rows.slice(i,i+CHUNK);
      const {data:inserted,error}=await sb.from('orders').insert(chunk).select();
      if(error){console.error('bulk insert orders',error);toast('Ошибка при создании заказов: '+error.message);break;}
      if(inserted){inserted.forEach(u=>S.orders.unshift(u));created+=inserted.length;}
    }
    if(created&&!opts.silent)toast(`Создано заказов: ${created}`);
    return created;
  }finally{
    delete _creatingOrders[pickupId]; // снимаем блокировку в любом случае
  }
}
// Окно: список заказов, созданных по заявке, с возможностью прикрепить фото к каждому
async function pickupOrdersModal(pickupId){
  const p=S.pickups.find(x=>x.id===pickupId);if(!p)return;
  const canEditPhoto=can('orders','edit')||isCourier();
  // АВТОСОЗДАНИЕ: при открытии формируем недостающие заказы по количеству из заявки
  const want=parseInt(p.orders||'0',10)||0;
  const have=ordersCountForPickup(pickupId);
  if(want>have){await createOrdersFromPickup(pickupId,{silent:true});}
  // при большом числе заказов (сотни) рисовать все карточки сразу — тяжело и тормозит прокрутку,
  // особенно на телефоне у курьера. Показываем порциями, следующая подгружается сама при подходе
  // к концу списка — курьер просто листает как обычно, без лишних кнопок «показать ещё».
  const POM_BATCH=40;
  let pomVisible=POM_BATCH;
  let pomOnlyNoPhoto=false; // фильтр «показать только заказы без фото» — помогает найти те, что не попали при пакетной загрузке
  const renderBody=()=>{
    const fullList=S.orders.filter(o=>o.pickup_id===pickupId);
    const noPhotoCount=fullList.filter(o=>!pickupPhotos(o).length).length;
    const list=pomOnlyNoPhoto?fullList.filter(o=>!pickupPhotos(o).length):fullList;
    const wantNow=parseInt(p.orders||'0',10)||0;
    const shown=Math.min(pomVisible,list.length);
    const head=`<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap">
      <div style="color:var(--muted);font-size:14px">Создано <b>${fullList.length}</b>${wantNow?` из ${wantNow}`:''} заказ(ов) по магазину «${esc(p.name)}»${pomOnlyNoPhoto?` · без фото: ${shown}`:(list.length>shown?` · показано ${shown}`:'')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${noPhotoCount?`<button type="button" class="btn sm ${pomOnlyNoPhoto?'':'ghost'}" id="pom_toggle_nophoto">${pomOnlyNoPhoto?'✕ Показать все':`🔍 Без фото (${noPhotoCount})`}</button>`:''}
        ${canEditPhoto?`<label class="btn sm ghost" style="cursor:pointer">📷 Загрузить фото пачкой<input type="file" accept="image/*" multiple id="pom_bulk_photo" style="display:none"></label>`:''}
        <button class="btn sm primary" id="pom_create">＋ Создать ещё заказ</button>
        <button type="button" class="btn sm primary" id="pom_save_top">💾 Сохранить</button>
      </div>
    </div>
    ${list.some(o=>o.track)?`<div class="pom-scan"><input id="pom_scan_input" placeholder="📷 Отсканируйте штрих-код посылки, чтобы найти её заказ…" autocomplete="off"></div>`:''}`;
    if(!list.length)return head+`<div class="empty"><div class="big">Заказов пока нет</div>Нажмите «Создать ещё заказ».</div>`;
    const cards=list.slice(0,shown).map((o,i)=>`<div class="pom-order" data-pomcard="${o.id}" data-pomtrack="${esc((o.track||'').toLowerCase())}" data-pomcode="${esc((o.code||'').toLowerCase())}">
      <div class="pom-head"><b>Заказ #${esc(o.code)}</b><span class="pom-st">${statusBadge(o.status_id)}</span></div>
      ${o.track?`<div class="pom-track">📦 Штрих-код посылки: <b>${esc(o.track)}</b></div>`:''}
      <div class="pom-photos" data-pomphotos="${o.id}">${photoBlockHtml(o,canEditPhoto)}</div>
      ${(isStaff()||isCourier())?`
      <div class="pom-sumrow"><span>Размер пакета</span><select class="pom-sum" data-pomsize="${o.id}" style="width:auto">
        <option value="S" ${(!o.size||o.size==='S')?'selected':''}>S (по умолчанию)</option>
        <option value="M" ${o.size==='M'?'selected':''}>M — средний</option>
        <option value="L" ${o.size==='L'?'selected':''}>L — большой</option>
      </select></div>
      <div class="pom-sumrow"><span>Сумма заказа (₸)</span><input type="number" min="0" class="pom-sum" data-pomsum="${o.id}" value="${o.order_sum!=null?esc(o.order_sum):''}" placeholder="—" ${o.paid_by_sender?'disabled':''}></div>
      `:''}
      ${(isStaff()||isCourier())?`
      <label class="pom-paid pom-paidorder"><input type="checkbox" data-pompaid="${o.id}" ${o.paid_by_sender?'checked':''}> Оплачено отправителем <span class="pom-paidhint">(сумма станет 0)</span></label>
      `:''}
    </div>`).join('');
    // «датчик» внизу — как только докручивают почти до него, сама подгружается следующая порция
    const sentinel=shown<list.length?`<div id="pom_sentinel" style="padding:18px;text-align:center;color:var(--muted);font-size:13px">Загружаем ещё заказы…</div>`:'';
    return head+`<div class="pom-list">${cards}</div>${sentinel}`;
  };
  showInfo(`Заказы заявки · ${p.name||''}`,renderBody(),{closeLabel:'Сохранить',beforeClose:()=>{
    // фото обязательно: проверяем, что у каждого заказа есть хотя бы одно фото
    const list=S.orders.filter(o=>o.pickup_id===pickupId);
    const noPhoto=list.filter(o=>!pickupPhotos(o).length);
    if(noPhoto.length){toast(`Добавьте фото к заказам (${noPhoto.length} без фото)`);return false;}
    // размер пакета тоже обязателен — курьер должен указать его на месте, глядя на посылку
    const noSize=list.filter(o=>!o.size);
    if(noSize.length){toast(`Выберите размер пакета у каждого заказа (не указан у ${noSize.length})`);return false;}
    return true;
  }});
  drawPickups(); // обновляем счётчик в карточке заявки сразу после автосоздания
  // навешиваем обработчики (после вставки в DOM)
  setTimeout(()=>{
    const wrap=document.querySelector('.overlay:last-child');if(!wrap)return;
    // прячем нижнюю кнопку «Сохранить» — теперь она продублирована наверху, рядом с остальными
    // кнопками, чтобы не листать длинную ленту заказов до самого низа
    const bottomFoot=wrap.querySelector('.modal-foot');if(bottomFoot)bottomFoot.style.display='none';
    const bind=()=>{
      // верхняя кнопка «Сохранить» — просто нажимает исходную (скрытую) кнопку внизу, чтобы
      // сработала та же самая проверка (фото + размер пакета у каждого заказа), без дублирования логики
      const saveTop=wrap.querySelector('#pom_save_top');
      if(saveTop)saveTop.onclick=()=>{const dc=wrap.querySelector('[data-close]');if(dc)dc.click();};
      // сканер: ищем карточку по трек-коду (в первую очередь) или по коду заказа, подсвечиваем и прокручиваем к ней
      const scanInp=wrap.querySelector('#pom_scan_input');
      if(scanInp){
        scanInp.oninput=()=>{
          const q=scanInp.value.trim().toLowerCase();
          if(!q)return;
          let card=wrap.querySelector(`[data-pomtrack="${q}"]`)||wrap.querySelector(`[data-pomcode="${q}"]`);
          if(!card){
            // нужного заказа может не быть среди уже отрисованных (список подгружается порциями) —
            // ищем по всем данным и, если нашли, подгружаем достаточно карточек, чтобы её показать
            const full=S.orders.filter(o=>o.pickup_id===pickupId);
            const idx=full.findIndex(o=>(o.track||'').toLowerCase()===q||(o.code||'').toLowerCase()===q);
            if(idx>=0&&idx>=pomVisible){
              pomVisible=idx+1+POM_BATCH;
              const body=wrap.querySelector('.modal-body');
              if(body){body.innerHTML=renderBody();bind();}
              card=wrap.querySelector(`[data-pomtrack="${q}"]`)||wrap.querySelector(`[data-pomcode="${q}"]`);
            }
          }
          if(card){
            wrap.querySelectorAll('.pom-found').forEach(c=>c.classList.remove('pom-found'));
            card.classList.add('pom-found');
            card.scrollIntoView({behavior:'smooth',block:'center'});
            scanInp.value='';
          }
        };
      }
      // подгрузка следующей порции карточек при прокрутке вниз — для больших заявок (сотни заказов)
      const sentinelEl=wrap.querySelector('#pom_sentinel');
      if(sentinelEl){
        const io=new IntersectionObserver(entries=>{
          if(entries.some(e=>e.isIntersecting)){
            io.disconnect();
            pomVisible+=POM_BATCH;
            const body=wrap.querySelector('.modal-body');
            if(body){body.innerHTML=renderBody();bind();}
          }
        },{root:null,rootMargin:'500px'}); // начинаем подгружать чуть заранее, чтобы не было паузы при прокрутке
        io.observe(sentinelEl);
      }
      wrap.querySelectorAll('[data-pomphotos]').forEach(box=>{
        const o=S.orders.find(x=>x.id===box.dataset.pomphotos);if(!o)return;
        const redraw=()=>{box.innerHTML=photoBlockHtml(o,canEditPhoto);bindPhotoBlock(box,o,redraw,'orders');};
        bindPhotoBlock(box,o,redraw,'orders');
      });
      // галочка «Оплачено отправителем»
      // галочка «Оплачено отправителем» — обнуляет сумму (исходная запоминается), снятие — возврат
      wrap.querySelectorAll('[data-pompaid]').forEach(chk=>{
        chk.onchange=async()=>{
          const o=S.orders.find(x=>x.id===chk.dataset.pompaid);if(!o)return;
          const v=chk.checked;const beforeSum=o.order_sum;
          try{
            let patch;
            if(v){
              // запоминаем исходную сумму и обнуляем — если сумма уже 0 (например, тариф партнёра
              // и так 0), пытаемся подтянуть условную сумму из карточки партнёра, чтобы не потерять
              // её для Калькуляции
              let orig=(o.order_sum!=null?o.order_sum:0);
              if(!orig){
                const pt=(S.partners||[]).find(x=>x.id===o.partner_id);
                if(pt&&pt.direct_pay_amount!=null)orig=pt.direct_pay_amount;
              }
              patch={paid_by_sender:true,order_sum_orig:orig,order_sum:0,cost:0};
            }else{
              // возвращаем исходную сумму
              const back=(o.order_sum_orig!=null?o.order_sum_orig:0);
              patch={paid_by_sender:false,order_sum:back,cost:back,order_sum_orig:null};
            }
            const saved=await dbUpdate('orders',o.id,patch);
            if(!saved){chk.checked=!v;toast('Не удалось сохранить — попробуйте ещё раз');return;}
            Object.assign(o,saved);
            await logAction('update','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:[
              {field:'paid_by_sender',label:FIELD_LABEL.paid_by_sender,old:v?'нет':'да',new:v?'да':'нет'},
              {field:'order_sum',label:FIELD_LABEL.order_sum,old:beforeSum!=null?String(beforeSum):'—',new:String(o.order_sum)},
            ]});
            toast(v?'Оплачено отправителем · сумма 0':'Снято · сумма возвращена');
            // обновляем поле суммы и его доступность
            const sumInp=wrap.querySelector(`[data-pomsum="${o.id}"]`);
            if(sumInp){sumInp.value=o.order_sum!=null?o.order_sum:'';sumInp.disabled=!!o.paid_by_sender;}
            renderDashboardIfActive();
          }catch(e){chk.checked=!v;toast('Не удалось сохранить');}
        };
      });
      // выбор размера пакета — сразу сохраняем размер и подставляем/сохраняем сумму по типу доставки заказа
      wrap.querySelectorAll('[data-pomsize]').forEach(sel=>{
        sel.onchange=async()=>{
          const o=S.orders.find(x=>x.id===sel.dataset.pomsize);if(!o)return;
          const size=sel.value||null;
          const patch={size};
          if(size){
            const pt=(o.partner_id&&S.partners.find(x=>x.id===o.partner_id))||(o.sender&&S.partners.find(x=>(x.name||'').trim().toLowerCase()===o.sender.trim().toLowerCase()));
            const sizes=packageSizesFor(pt);
            if(sizes[size]&&!o.paid_by_sender){
              const courier=isCourierDelivery(o.delivery_id);
              const amount=sizes[size][courier?'courier':'mail'];
              patch.order_sum=amount;patch.cost=amount;
            }
          }
          const before=o.order_sum;
          const saved=await dbUpdate('orders',o.id,patch);
          if(!saved){toast('Не удалось сохранить размер');return;}
          Object.assign(o,saved);
          await logAction('update','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:[
            {field:'size',label:'Размер пакета',old:'—',new:size||'—'},
          ]});
          const sumInp=wrap.querySelector(`[data-pomsum="${o.id}"]`);
          if(sumInp&&patch.order_sum!=null)sumInp.value=patch.order_sum;
          toast(before!==o.order_sum?`Сумма обновлена: ${o.order_sum} ₸`:'Размер сохранён');
        };
      });
      // поле суммы заказа (ручное изменение — главнее авто)
      wrap.querySelectorAll('[data-pomsum]').forEach(inp=>{
        const commit=async()=>{
          const o=S.orders.find(x=>x.id===inp.dataset.pomsum);if(!o)return;
          if(o.paid_by_sender)return; // если оплачено отправителем — сумма зафиксирована в 0
          const raw=inp.value.trim();
          const v=raw===''?null:Math.max(0,parseFloat(raw)||0);
          if(o.order_sum===v)return;
          const before=o.order_sum;
          try{
            await dbUpdate('orders',o.id,{order_sum:v,cost:v});o.order_sum=v;o.cost=v;
            await logAction('update','orders',{entity_id:o.id,entity_label:orderLabel(o),
              changes:[{field:'order_sum',label:FIELD_LABEL.order_sum,old:before!=null?String(before):'—',new:v!=null?String(v):'—'}]});
            toast('Сумма сохранена');
            renderDashboardIfActive();
          }catch(e){toast('Не удалось сохранить сумму');}
        };
        inp.onblur=commit;inp.onkeydown=e=>{if(e.key==='Enter')inp.blur();};
      });
      // «Загрузить фото пачкой» — распределяет выбранные файлы по заказам, у которых ещё нет
      // ни одной фотографии (по порядку: первое фото → первый пустой заказ, и т.д.). Если фото
      // больше, чем пустых заказов — лишние просто не распределяются, об этом скажет тост.
      // Грузим НЕБОЛЬШИМИ ПАЧКАМИ ПАРАЛЛЕЛЬНО (не по одному подряд) — иначе на 100+ фото это
      // реально занимает несколько минут и выглядит как зависание без какого-либо прогресса.
      const toggleNoPhoto=wrap.querySelector('#pom_toggle_nophoto');
      if(toggleNoPhoto)toggleNoPhoto.onclick=()=>{
        pomOnlyNoPhoto=!pomOnlyNoPhoto;pomVisible=POM_BATCH;
        const body=wrap.querySelector('.modal-body');if(body){body.innerHTML=renderBody();bind();}
      };
      const bulkInp=wrap.querySelector('#pom_bulk_photo');
      const bulkLabel=bulkInp?bulkInp.closest('label'):null;
      if(bulkInp)bulkInp.onchange=async e=>{
        const files=[...(bulkInp.files||[])];if(!files.length)return;
        const currentList=S.orders.filter(o=>o.pickup_id===pickupId);
        const emptyOrders=currentList.filter(o=>!pickupPhotos(o).length);
        if(!emptyOrders.length){toast('У всех заказов уже есть хотя бы одно фото');bulkInp.value='';return;}
        const n=Math.min(files.length,emptyOrders.length);
        const pairs=[];for(let i=0;i<n;i++)pairs.push({order:emptyOrders[i],file:files[i]});
        let ok=0,done=0;
        const setProgress=()=>{if(bulkLabel)bulkLabel.childNodes[0].textContent=`⏳ Загружено ${done}/${n}…`;};
        if(bulkLabel){bulkLabel.style.pointerEvents='none';bulkLabel.childNodes[0].textContent=`⏳ Загружено 0/${n}…`;}
        const BATCH=5; // 5 фото одновременно — заметно быстрее одиночной загрузки, но не перегружает мобильный интернет
        for(let i=0;i<pairs.length;i+=BATCH){
          const chunk=pairs.slice(i,i+BATCH);
          await Promise.all(chunk.map(async({order,file})=>{
            const r=await uploadPhoto('order/'+order.id,file);
            if(r){
              const arr=pickupPhotos(order).concat([r]);
              const u=await dbUpdate('orders',order.id,{photos:arr});
              if(u){Object.assign(order,u);ok++;}
            }
            done++;setProgress();
          }));
        }
        bulkInp.value='';
        if(bulkLabel){bulkLabel.style.pointerEvents='';bulkLabel.childNodes[0].textContent='📷 Загрузить фото пачкой';}
        const leftover=files.length-n;
        toast(`Загружено фото: ${ok}${leftover?` · ещё ${leftover} не распределено (пустых заказов не хватило) — добавьте вручную`:''}`);
        const body=wrap.querySelector('.modal-body');if(body){body.innerHTML=renderBody();bind();}
      };
      // «Создать ещё заказ» — добавляет ОДИН новый заказ, увеличивает счётчик заявки
      const cb=wrap.querySelector('#pom_create');
      if(cb)cb.onclick=async()=>{
        cb.disabled=true;cb.textContent='Создаём…';
        // увеличиваем плановое количество в заявке на 1, затем досоздаём недостающее
        const newWant=(parseInt(p.orders||'0',10)||0)+1;
        const u=await dbUpdate('pickups',pickupId,{orders:newWant});
        if(u)Object.assign(p,u);
        await createOrdersFromPickup(pickupId,{silent:true});
        const body=wrap.querySelector('.modal-body');if(body){body.innerHTML=renderBody();bind();}
        drawPickups(); // счётчик в карточке заявки обновляется автоматом
      };
    };
    bind();
  },30);
}
let ordersMode=''; // ''=все, 'courier', 'mail', 'today'
function renderOrders(mode){
  ordersMode=mode||'';
  // по умолчанию показываем заказы, созданные СЕГОДНЯ (до первой ручной правки дат)
  if(!ordersDateInit){const t=new Date().toISOString().slice(0,10);of.createFrom=t;of.createTo=t;ordersDateInit=true;}
  const list=ordersDateScopedList();
  const totalCost=list.reduce((s,o)=>s+(+o.cost||0),0);
  const paid=list.filter(o=>o.pay_date).length;
  const titles={'':'Заказы заборов',courier:'Курьерская доставка',mail:'Почтовая доставка',today:'Заказы сегодня'};
  const subs={'':'Отправления: курьерская и почтовая доставка',courier:'Заказы с курьерской доставкой',
    mail:'Заказы с почтовой доставкой',today:'Заказы, созданные сегодня'};
  let dayNote='';
  if(of.createFrom&&of.createFrom===of.createTo){const t=new Date().toISOString().slice(0,10);dayNote=of.createFrom===t?'за сегодня':('за '+fmtDate(of.createFrom));}
  else if(of.createFrom||of.createTo){dayNote='за период';}
  const head=isCourier()?'Мои заказы':(titles[ordersMode]||'Заказы');
  $('main').innerHTML=`
    <div class="page-head"><div><h1>${head}</h1><p>${isCourier()?'Отправления: курьерская и почтовая доставка':((subs[ordersMode]||'')+(dayNote?(' · '+dayNote):''))}</p></div>
      <div class="head-actions">${canMod('orders')?'<button class="btn btn-excel" id="exportXlsx">⬇ Выгрузить Excel</button>':''}${(can('orders','create')&&isStaff())?'<button class="btn ghost" id="kazpostAssignSel">📮 Присвоить трек-номер</button>':''}${(can('orders','create')&&isStaff())?'<button class="btn ghost" id="ketSendSel">↑ Отправить в KET</button>':''}${(isAdmin()&&ketSelected.size)?`<button class="btn danger" id="ordersDelSel">✕ Удалить выбранные (${ketSelected.size})</button>`:''}${(can('orders','create')&&isStaff()&&ordersMode==='mail')?'<button class="btn ghost" id="printMailLabels">🖨 Печать бланков</button>':''}${can('orders','create')?'<button class="btn primary" id="newOrder">＋ Создать заказ</button>':''}</div></div>
    ${(ordersMode==='courier'||ordersMode==='mail')?`
    <div class="stats stats-1">
      <div class="stat"><div class="k">Всего</div><div class="v">${list.length}<small> / ${ordersWithPhone(list)} сохранено</small></div></div>
    </div>`:`
    <div class="stats stats-5">
      <div class="stat"><div class="k">Всего</div><div class="v">${list.length}<small> / ${ordersWithPhone(list)} сохранено</small></div></div>
      <div class="stat"><div class="k">Курьерских</div><div class="v">${list.filter(o=>isCourierDelivery(o.delivery_id)).length}</div></div>
      <div class="stat"><div class="k">Почтовых</div><div class="v">${list.filter(o=>o.delivery_id&&!isCourierDelivery(o.delivery_id)).length}</div></div>
      <div class="stat"><div class="k">Оплачено</div><div class="v">${paid}<small> / ${list.length}</small></div></div>
      <div class="stat"><div class="k">Сумма доставки</div><div class="v">${totalCost.toLocaleString('ru-RU')}<small> ₸</small></div></div>
    </div>`}
    <div class="panel">
      <div class="panel-head"><h2>Список заказов</h2><span class="count" id="ordersCount">${list.length}</span></div>
      <div class="filters">
        <input class="search" id="ofq" placeholder="Поиск: ID, трек, клиент…" value="${esc(of.q)}">
        <button type="button" class="btn ghost sm filters-toggle" id="ofFiltersToggle">Фильтры ▾</button>
        <div class="filters-body" id="ofFiltersBody">
        <select id="ofstatus"><option value="">Все статусы</option>${S.orderStatuses.map(s=>`<option value="${s.id}" ${of.status===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
        ${ordersMode?'':`<select id="ofdelivery"><option value="">Все типы доставки</option>${S.delivery.map(dx=>`<option value="${dx.id}" ${of.delivery===dx.id?'selected':''}>${esc(dx.name)}</option>`).join('')}</select>`}
        ${isStaff()?`<input id="ofpartner" list="ofPartnersList" placeholder="Партнёр: поиск…" value="${esc(of.partner?partnerName(of.partner):'')}" autocomplete="off"><datalist id="ofPartnersList">${S.partners.map(p=>`<option value="${esc(p.name)}">`).join('')}</datalist>`:''}
        <select id="ofpickupcity" title="Город, откуда забрали заказ"><option value="">Город забора: все</option>${S.cities.filter(c=>/алмат|астан|нур-?султан/i.test(c.name||'')).map(c=>`<option value="${c.id}" ${of.pickupCity===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
        <select id="ofdestcity" title="Город, куда уходит заказ"><option value="">Город получения: все</option>${S.courier_cities.map(c=>`<option value="${c.id}" ${of.destCity===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>
        <select id="ofsales" title="Менеджер по продажам"><option value="">Менеджер: все</option>${S.sales.map(s=>`<option value="${s.id}" ${of.sales===s.id?'selected':''}>${esc(s.fio)}</option>`).join('')}</select>
        <select id="ofmissing" title="Показать заказы с незаполненным полем">
          <option value="">Заполненность: все</option>
          <option value="client" ${of.missing==='client'?'selected':''}>Нет ФИО клиента</option>
          <option value="phone" ${of.missing==='phone'?'selected':''}>Нет телефона</option>
          <option value="track" ${of.missing==='track'?'selected':''}>Нет трек-кода</option>
          <option value="index" ${of.missing==='index'?'selected':''}>Нет индекса</option>
        </select>
        <select id="ofpaid" title="Фильтр по оплате отправителем">
          <option value="">Оплата: все</option>
          <option value="yes" ${of.paidBySender==='yes'?'selected':''}>Оплачено отправителем</option>
          <option value="no" ${of.paidBySender==='no'?'selected':''}>Не оплачено отправителем</option>
        </select>
        ${ordersMode==='mail'?`<select id="ofcallstatus" title="Статус обзвона клиента">
          <option value="">Статус обзвона: все</option>
          <option value="none" ${of.callStatus==='none'?'selected':''}>Не установлен</option>
          <option value="Недозвон" ${of.callStatus==='Недозвон'?'selected':''}>Недозвон</option>
          <option value="Прозвонен" ${of.callStatus==='Прозвонен'?'selected':''}>Прозвонен</option>
          <option value="Изменен" ${of.callStatus==='Изменен'?'selected':''}>Изменен</option>
        </select>`:''}
        <div class="filters filters-dates" style="padding:0;margin:0">
          <span class="fdate-lbl">Создан:</span>
          <input type="date" id="ofcreatefrom" value="${esc(of.createFrom)}" title="Дата создания с">
          <input type="date" id="ofcreateto" value="${esc(of.createTo)}" title="Дата создания по">
          <span class="fdate-lbl">Забор:</span>
          <input type="date" id="ofpickfrom" value="${esc(of.pickFrom)}" title="Дата забора с">
          <input type="date" id="ofpickto" value="${esc(of.pickTo)}" title="Дата забора по">
          <span class="fdate-lbl">Доставка:</span>
          <input type="date" id="ofdelfrom" value="${esc(of.delFrom)}" title="Дата доставки с">
          <input type="date" id="ofdelto" value="${esc(of.delTo)}" title="Дата доставки по">
          <button class="btn sm" id="oftoday">Сегодня</button>
          <button class="btn sm" id="ofdateclear">Все даты</button>
        </div>
        </div>
      </div>
      <div id="orderTable"></div>
    </div>`;
  if($('newOrder'))$('newOrder').onclick=()=>orderModal();
  if($('exportXlsx'))$('exportXlsx').onclick=()=>exportOrdersToExcel();
  // массовая печать бланков «5 нысан - форма 5» по выбранным почтовым заказам
  if($('printMailLabels'))$('printMailLabels').onclick=async()=>{
    let list;
    if(ketSelected.size){list=[...ketSelected].map(id=>S.orders.find(o=>o.id===id)).filter(Boolean);}
    else{list=filteredOrders();}
    if(!list.length){toast('Нет заказов для печати');return;}
    const btn=$('printMailLabels');const origLabel=btn.textContent;btn.disabled=true;btn.textContent='Готовим PDF…';
    try{await printMailLabelsPdf(list);}
    catch(e){console.error(e);toast('Не удалось сформировать бланки: '+(e&&e.message||e));}
    finally{btn.disabled=false;btn.textContent=origLabel;}
  };
  // массовая отправка отмеченных заказов в KET
  if($('ordersDelSel'))$('ordersDelSel').onclick=async()=>{
    const ids=[...ketSelected];
    if(!ids.length)return;
    if(!confirm(`Удалить выбранные заказы (${ids.length} шт.)?\n\nЭто действие нельзя отменить.`))return;
    const btn=$('ordersDelSel');btn.disabled=true;btn.textContent='Удаляем…';
    let ok=0,fail=0;
    for(const id of ids){
      const o=S.orders.find(x=>x.id===id);if(!o)continue;
      const done=await dbDelete('orders',id);
      if(done){await logAction('delete','orders',{entity_id:id,entity_label:orderLabel(o)});S.orders=S.orders.filter(x=>x.id!==id);ok++;}
      else fail++;
      ketSelected.delete(id);
    }
    ketSelectAll=false;
    toast(`Удалено заказов: ${ok}${fail?(', с ошибкой: '+fail):''}`);
    renderOrders(ordersMode);
  };
  if($('kazpostAssignSel'))$('kazpostAssignSel').onclick=async()=>{
    let list,source;
    if(ketSelected.size){
      list=[...ketSelected].map(id=>S.orders.find(o=>o.id===id)).filter(Boolean);
      source='отмеченные';
    }else if(of.pickupCity){
      list=filteredOrders();
      source='по фильтру «Город забора: '+cityName(of.pickupCity)+'»';
    }else{
      toast('Отметьте галочками заказы или выберите фильтр «Город забора»');return;
    }
    // только почтовые — курьерские трек-номер у Казпочты не запрашивают
    const skippedCourier=list.filter(o=>isCourierDelivery(o.delivery_id)).length;
    list=list.filter(o=>!isCourierDelivery(o.delivery_id));
    if(!list.length){toast(skippedCourier?'В выборке только курьерские заказы — трек-номер для них не нужен':'Нет заказов для присвоения трек-номера');return;}
    const already=list.filter(o=>o.track).length;
    let msg=`Получить трек-номер у Казпочты для заказов: ${list.length} (${source})?`;
    if(skippedCourier)msg+=`\n(${skippedCourier} курьерских заказов из выборки пропущено — им трек-номер не нужен)`;
    if(already)msg+=`\n(у ${already} уже есть трек-код — будет заменён на новый)`;
    if(!confirm(msg))return;
    const b=$('kazpostAssignSel');b.disabled=true;const origLabel=b.textContent;
    const assignOne=async(o)=>{
      try{
        const r=await callKazpostGetBarcode(o.id);
        if(r&&r.success){o.track=r.barcode;return {ok:true};}
        return {ok:false,reason:`${o.code}: ${r&&r.error||'неизвестная ошибка'}`};
      }catch(e){return {ok:false,reason:`${o.code}: ${String(e&&e.message||e)}`};}
    };
    const BATCH=5; // Казпочта — внешний медленный сервис, шлём по 5 параллельно, не больше
    let ok=0,fail=0;const errs=[];
    for(let i=0;i<list.length;i+=BATCH){
      const chunk=list.slice(i,i+BATCH);
      b.textContent=`Получаем… ${Math.min(i+BATCH,list.length)}/${list.length}`;
      const results=await Promise.all(chunk.map(o=>assignOne(o).then(res=>({o,res}))));
      results.forEach(({res})=>{if(res.ok)ok++;else{fail++;errs.push(res.reason);}});
    }
    b.disabled=false;b.textContent=origLabel;
    toast(`Трек-номер присвоен: ${ok}${fail?(', с ошибкой: '+fail):''}`);
    if(errs.length)alert('Не удалось получить трек-номер:\n\n'+errs.join('\n'));
    ketSelected.clear();ketSelectAll=false;
    renderOrders();
  };
  if($('ketSendSel'))$('ketSendSel').onclick=async()=>{
    let list, source;
    if(ketSelected.size){
      // 1) приоритет — отмеченные галочками заказы
      list=[...ketSelected].map(id=>S.orders.find(o=>o.id===id)).filter(Boolean);
      source='отмеченные';
    }else if(of.pickupCity){
      // 2) ничего не отмечено, но включён фильтр «Город забора» — шлём все заказы по фильтру
      list=filteredOrders();
      source='по фильтру «Город забора: '+cityName(of.pickupCity)+'»';
    }else{
      toast('Отметьте галочками заказы или выберите фильтр «Город забора»');return;
    }
    if(!list.length){toast('Нет заказов для отправки');return;}
    const already=list.filter(o=>o.ket_id).length;
    let msg=`Отправить в KET заказов: ${list.length} (${source})?`;
    if(already)msg+=`\n(из них ${already} уже были отправлены — будут отправлены повторно)`;
    if(!confirm(msg))return;
    const b=$('ketSendSel');b.disabled=true;const origLabel=b.textContent;
    // отправка одного заказа → {ok, reason, retry}
    const sendOne=async(o)=>{
      if(!o.phone||o.phone.length<10)return {ok:false,reason:`${o.code}: нет телефона`};
      try{
        const r=await callKet({action:'send',account:ketAccountForOrder(o),order:orderToKet(o)});
        const result=(r&&r.ket&&r.ket.result)||{};
        if(!r.error&&(result.success||'').toUpperCase()==='TRUE'){
          const u=await dbUpdate('orders',o.id,{ket_id:result.id||null,ket_synced_at:new Date().toISOString()});
          if(u)Object.assign(o,u);
          logAction('ket','orders',{entity_id:o.id,entity_label:orderLabel(o),meta:{ket_id:result.id||null}});
          return {ok:true};
        }
        const reason=r.error||result.message||(r&&r.raw)||(r&&JSON.stringify(r.ket))||'неизвестно';
        return {ok:false,reason:`${o.code}: ${reason}`,retry:true};
      }catch(e){return {ok:false,reason:`${o.code}: ${String(e&&e.message||e)}`,retry:true};}
    };
    const BATCH=10; // отправляем по 10 заказов параллельно
    let ok=0,fail=0;const errs=[];let failedOrders=[];
    const runBatches=async(orders)=>{
      for(let i=0;i<orders.length;i+=BATCH){
        const chunk=orders.slice(i,i+BATCH);
        b.textContent=`Отправка… ${Math.min(i+BATCH,orders.length)}/${orders.length}`;
        const results=await Promise.all(chunk.map(o=>sendOne(o).then(res=>({o,res}))));
        results.forEach(({o,res})=>{
          if(res.ok)ok++;
          else{fail++;errs.push(res.reason);if(res.retry)failedOrders.push(o);}
        });
      }
    };
    await runBatches(list);
    // автоповтор неудачных (одна попытка)
    if(failedOrders.length){
      const retryList=failedOrders.slice();failedOrders=[];
      fail-=retryList.length;errs.length=Math.max(0,errs.length-retryList.length);
      b.textContent=`Повтор ${retryList.length}…`;
      await runBatches(retryList);
    }
    b.disabled=false;b.textContent=origLabel;
    toast(`Отправлено в KET: ${ok}${fail?(', с ошибкой: '+fail):''}`);
    if(errs.length)alert('Не отправлены:\n\n'+errs.join('\n'));
    ketSelected.clear();ketSelectAll=false;
    renderOrders();
  };
  $('ofq').oninput=e=>{of.q=e.target.value;drawOrdersReset();};
  if($('ofFiltersToggle'))$('ofFiltersToggle').onclick=()=>{const b=$('ofFiltersBody');if(b)b.classList.toggle('open');$('ofFiltersToggle').classList.toggle('active');};
  $('ofstatus').onchange=e=>{of.status=e.target.value;drawOrdersReset();};
  if($('ofdelivery'))$('ofdelivery').onchange=e=>{of.delivery=e.target.value;drawOrdersReset();};
  if($('ofpartner'))$('ofpartner').oninput=e=>{
    const name=e.target.value.trim().toLowerCase();
    if(!name){of.partner='';drawOrdersReset();return;}
    const p=S.partners.find(x=>(x.name||'').trim().toLowerCase()===name);
    of.partner=p?p.id:'__none__'; // если ввели текст, но партнёр не найден — показываем пусто
    drawOrdersReset();
  };
  if($('ofmissing'))$('ofmissing').onchange=e=>{of.missing=e.target.value;drawOrdersReset();};
  if($('ofpaid'))$('ofpaid').onchange=e=>{of.paidBySender=e.target.value;drawOrdersReset();};
  if($('ofcallstatus'))$('ofcallstatus').onchange=e=>{of.callStatus=e.target.value;drawOrdersReset();};
  if($('ofpickupcity'))$('ofpickupcity').onchange=e=>{of.pickupCity=e.target.value;drawOrdersReset();};
  if($('ofdestcity'))$('ofdestcity').onchange=e=>{of.destCity=e.target.value;drawOrdersReset();};
  if($('ofsales'))$('ofsales').onchange=e=>{of.sales=e.target.value;drawOrdersReset();};
  if($('ofcreatefrom'))$('ofcreatefrom').onchange=e=>{of.createFrom=e.target.value;renderOrders(ordersMode);};
  if($('ofcreateto'))$('ofcreateto').onchange=e=>{of.createTo=e.target.value;renderOrders(ordersMode);};
  if($('ofpickfrom'))$('ofpickfrom').onchange=e=>{of.pickFrom=e.target.value;drawOrdersReset();};
  if($('ofpickto'))$('ofpickto').onchange=e=>{of.pickTo=e.target.value;drawOrdersReset();};
  if($('ofdelfrom'))$('ofdelfrom').onchange=e=>{of.delFrom=e.target.value;drawOrdersReset();};
  if($('ofdelto'))$('ofdelto').onchange=e=>{of.delTo=e.target.value;drawOrdersReset();};
  if($('oftoday'))$('oftoday').onclick=()=>{const t=new Date().toISOString().slice(0,10);of.createFrom=t;of.createTo=t;renderOrders(ordersMode);};
  if($('ofdateclear'))$('ofdateclear').onclick=()=>{of.pickFrom='';of.pickTo='';of.delFrom='';of.delTo='';of.createFrom='';of.createTo='';renderOrders(ordersMode);};
  drawOrders();
}
// число заказов с заполненным телефоном клиента
function ordersWithPhone(list){return list.filter(o=>(o.phone||'').toString().replace(/\D/g,'').length>=10).length;}
// список заказов с учётом режима вкладки (курьер/почта/сегодня)
function ordersScopedList(){
  let list=visibleOrders();
  if(ordersMode==='courier')list=list.filter(o=>isCourierDelivery(o.delivery_id));
  else if(ordersMode==='mail')list=list.filter(o=>o.delivery_id&&!isCourierDelivery(o.delivery_id));
  else if(ordersMode==='today'){const t=new Date().toISOString().slice(0,10);list=list.filter(o=>(o.created_at||'').slice(0,10)===t||(o.pickup_date||'').slice(0,10)===t);}
  return list;
}
// список с учётом режима вкладки И фильтра по дате создания (для статистики вверху)
function ordersDateScopedList(){
  return ordersScopedList().filter(o=>{
    const cd=(o.created_at||'').slice(0,10);
    if(of.createFrom&&(!cd||cd<of.createFrom))return false;
    if(of.createTo&&(!cd||cd>of.createTo))return false;
    return true;
  });
}
function filteredOrders(){
  const q=of.q.toLowerCase().trim();
  return ordersDateScopedList().filter(o=>{
    if(of.status&&o.status_id!==of.status)return false;
    if(!ordersMode&&of.delivery&&o.delivery_id!==of.delivery)return false;
    if(of.partner==='__none__')return false; // введён партнёр, которого нет
    if(of.partner&&of.partner!=='__none__'&&o.partner_id!==of.partner)return false;
    // диапазон даты забора
    const pd=(o.pickup_date||'').slice(0,10);
    if(of.pickFrom&&(!pd||pd<of.pickFrom))return false;
    if(of.pickTo&&(!pd||pd>of.pickTo))return false;
    // диапазон даты доставки
    const dd=(o.deliver_date||'').slice(0,10);
    if(of.delFrom&&(!dd||dd<of.delFrom))return false;
    if(of.delTo&&(!dd||dd>of.delTo))return false;
    // фильтр незаполненных полей: показать заказы, где выбранное поле пустое
    if(of.missing){
      // «Нет индекса» относится только к почтовым заказам (у курьерских индекса нет)
      if(of.missing==='index'){
        if(isCourierDelivery(o.delivery_id))return false; // курьерские не показываем
        if((o.index||'').toString().trim()!=='')return false;
      }else{
        const val=(o[of.missing]||'').toString().trim();
        if(val!=='')return false;
      }
    }
    // фильтр по городу забора
    if(of.pickupCity&&o.pickup_city_id!==of.pickupCity)return false;
    // фильтр по статусу обзвона (актуален для почтовых заказов)
    if(of.callStatus){
      if(of.callStatus==='none'){if(o.call_status)return false;}
      else if(o.call_status!==of.callStatus)return false;
    }
    if(of.destCity&&o.courier_city_id!==of.destCity)return false;
    if(of.sales&&o.sales_id!==of.sales)return false;
    // фильтр по оплате отправителем
    if(of.paidBySender==='yes'&&!o.paid_by_sender)return false;
    if(of.paidBySender==='no'&&o.paid_by_sender)return false;
    if(q){
      const hay=[o.code,o.track,o.client,phoneDisplay(o.phone),o.phone,o.sender,o.address,o.index,partnerName(o.partner_id)].join(' ').toLowerCase();
      // поиск по телефону — устойчивый к формату ввода (с +7/8 впереди, с пробелами/скобками или просто цифрами)
      const qDigits=q.replace(/\D/g,'');
      const phoneDigits=(o.phone||'').replace(/\D/g,'');
      const qDigitsNorm=(qDigits.length===11&&(qDigits[0]==='7'||qDigits[0]==='8'))?qDigits.slice(1):qDigits;
      const matchByPhone=qDigitsNorm.length>=5&&phoneDigits.includes(qDigitsNorm);
      if(!hay.includes(q)&&!matchByPhone)return false;
    }
    return true;
  }).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
}
let editingOrderId=null; // id заказа в режиме строчного редактирования

// выгрузка отфильтрованных заказов в Excel (колонки как в гриде)
const MAIL_LABEL_TEMPLATE_B64=
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWyA0IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovTGFzdE1vZGlmaWVkIChEXDA3MjIwMjYwNjA4MTcyODIyXDA1MzA1XDA0NzAwXDA0NykKL1Jlc291cmNlcyA8PAovRm9udCA8PAovRjEgNSAwIFIKL0YxLTAgNiAwIFIKL0YyIDcgMCBSCj4+Ci9YT2JqZWN0IDw8Ci9UUEwxIDEzIDAgUgo+PgovUHJvY1NldCBbIC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIC9QREYgL1RleHQgXQo+PgovTWVkaWFCb3ggWyAwLjAgMC4wIDg0MS44OSA1OTUuMjc2IF0KL0Nyb3BCb3ggWyAwLjAgMC4wIDg0MS44OSA1OTUuMjc2IF0KL0JsZWVkQm94IFsgMC4wIDAuMCA4NDEuODkgNTk1LjI3NiBdCi9UcmltQm94IFsgMC4wIDAuMCA4NDEuODkgNTk1LjI3NiBdCi9BcnRCb3ggWyAwLjAgMC4wIDg0MS44OSA1OTUuMjc2IF0KL0NvbnRlbnRzIDQ2IDAgUgovUm90YXRlIDAKL0dyb3VwIDw8Ci9UeXBlIC9Hcm91cAovUyAvVHJhbnNwYXJlbmN5Ci9DUyAvRGV2aWNlUkdCCj4+Ci9QWiAxCi9Bbm5vdHMgWyBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1R5cGUgL0ZvbnQKL1N1YnR5cGUgL1R5cGUxCi9CYXNlRm9udCAvSGVsdmV0aWNhCi9OYW1lIC9GMQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwo+PgplbmRvYmoKNiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYQovRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZwovTmFtZSAvRjEKL1N1YnR5cGUgL1R5cGUxCi9UeXBlIC9Gb250Cj4+CmVuZG9iago3IDAg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noPn4Dl4Dp6D5+A5eA6eg+fgOXgOnoPn4Dl4Dp6D5+D5Ov16P5HP32wnBuqBeqAeqAfqgXqgHqgH6oF6oB6oB+qBeqAeqAfqgXqgHqgH6oF6oB6oJ+qJeqKeqCfqiXqinqgn6ol6op6oJ+qJeqKeqCfqiXqinqgn6ol6op5+upPn5Dl5Tp6T5+Q5eU6ek+fkOXlOnpPn5Dl5Tp6T5+Q5eU6ek+fkOXlOnovn4rl4Lp6L5+K5eC6ei+fiuXgunovn4rl4Lp6L5+K5eC6ei+fiuXgunovn4rl4Lp6L5+K5eC6ei+fiuXgunovn4rl4Lp6L5+K5eC6ei+fiuXgunpvn5rl5bp6b5+a5eW6em+fmuXlunpvn5rl5bp6b5+a5eW6em+fmuXlunpvn5rl5bp6b5+a5eW6em+fmuXlunpvn5rl5bp6b5+a5eW6em+fmuXm+Tr/+y3o5ZH05GP7lOHf8/Pi47p9eT49fj3Bfzmvv7tcvB8wPXx5eVr08/wXsSm37CmVuZHN0cmVhbQplbmRvYmoKOSAwIG9iago8PAovVHlwZSAvRm9udAovU3VidHlwZSAvQ0lERm9udFR5cGUyCi9CYXNlRm9udCAvQUFBQUFDK0RlamFWdVNhbnMKL0NJRFN5c3RlbUluZm8gPDwKL1JlZ2lzdHJ5IChBZG9iZSkKL09yZGVyaW5nIChJZGVudGl0eSkKL1N1cHBsZW1lbnQgMAo+PgovRm9udERlc2NyaXB0b3IgMTAgMCBSCi9EVyA2MDAKL1cgWyAzMiBbIDMxOCA0MDEg"+
  "NDYwIDgzOCA2MzYgOTUwIDc4MCAyNzUgMzkwIDM5MCA1MDAgODM4IDMxOCAzNjEgMzE4IDMzNyBdIDQ4IDU3IDYzNiA1OCA1OSAzMzcgNjAgNjIgODM4IDYzIFsgNTMxIDEwMDAgNjg0IDY4NiA2OTggNzcwIDYzMiA1NzUgNzc1IDc1MiAyOTUgMjk1IDY1NiA1NTcgODYzIDc0OCA3ODcgNjAzIDc4NyA2OTUgNjM1IDYxMSA3MzIgNjg0IDk4OSA2ODUgNjExIDY4NSAzOTAgMzM3IDM5MCA4MzggNTAwIDUwMCA2MTMgNjM1IDU1MCA2MzUgNjE1IDM1MiA2MzUgNjM0IDI3OCAyNzggNTc5IDI3OCA5NzQgNjM0IDYxMiA2MzUgNjM1IDQxMSA1MjEgMzkyIDYzNCA1OTIgODE4IDU5MiA1OTIgNTI1IDYzNiAzMzcgNjM2IDgzOCBdIDE2MCBbIDMxOCA0MDEgXSAxNjIgMTY1IDYzNiAxNjYgWyAzMzcgNTAwIDUwMCAxMDAwIDQ3MSA2MTIgODM4IDM2MSAxMDAwIDUwMCA1MDAgODM4IDQwMSA0MDEgNTAwIDYzNiA2MzYgMzE4IDUwMCA0MDEgNDcxIDYxMiBdIDE4OCAxOTAgOTY5IDE5MSAxOTEgNTMxIDE5MiAxOTcgNjg0IDE5OCBbIDk3NCA2OTggXSAyMDAgMjAzIDYzMiAyMDQgMjA3IDI5NSAyMDggWyA3NzUgNzQ4IF0gMjEwIDIxNCA3ODcgMjE1IFsgODM4IDc4NyBdIDIxNyAyMjAgNzMyIDIyMSBbIDYxMSA2MDUgNjMwIF0gMjI0IDIyOSA2MTMgMjMwIFsgOTgyIDU1MCBdIDIzMiAyMzUgNjE1IDIzNiAyMzkgMjc4IDI0MCBbIDYxMiA2MzQgNjEyIDYxMiA2MTIgNjEyIDYxMiBdIDI0NyBbIDgzOCA2MTIgXSAyNDkgMjUyIDYzNCAyNTMgWyA1OTIgNjM1IF0gMTA0MCAxMDQwIDY4NCAxMDQyIFsgNjg2IDYxMCA3ODEgNjMyIDEwNzcgNjQxIDc0OCBdIDEwNTAgWyA3MTAgNzUyIF0gMTA1MyBbIDc1MiA3ODcgNzUyIDYwMyA2OTggNjExIF0gMTA2MCAxMDYwIDg2MSAxMDYyIDEwNjIgNzc2IDEwNjcgWyA4ODIgNjg2IF0gMTA3MCBbIDEwODAgNjk1IDYxMyBdIDEwNzQgWyA1ODkgNTI1IDY5MSA2MTUgOTAxIDUzMiA2NTAgXSAxMDgyIFsgNjA0IDYzOSA3NTQgNjU0IDYxMiA2NTQgNjM1IDU1MCA1ODMgNTkyIF0gMTA5MyBbIDU5MiA2ODEgXSAxMDk2IDEwOTYgOTE1IDEwOTkgWyA3OTAgNTg5IF0gODIyMCA4MjIxIDUxOCA4NDcwIDg0NzAgMTA0MCBdCi9DSURUb0dJRE1hcCAxMiAwIFIKPj4KZW5kb2JqCjEwIDAgb2JqCjw8Ci9UeXBlIC9Gb250RGVzY3JpcHRvcgovRm9udE5hbWUgL0FBQUFBQytEZWphVnVTYW5zCi9GbGFncyAzMgovRm9udEJCb3ggWyAtMTAyMSAtNDE1IDE2ODEgMTE2NyBdCi9JdGFsaWNBbmdsZSAwCi9Bc2NlbnQgOTI4Ci9EZXNjZW50IC0yMzYKL0xlYWRpbmcgMAovQ2FwSGVpZ2h0IDcyOQovWEhlaWdodCA1NDcKL1N0ZW1WIDM0Ci9TdGVtSCAxNQovQXZnV2lkdGggNTA3Ci9NYXhXaWR0aCAxNzM1Ci9NaXNzaW5nV2lkdGggNjAwCi9Gb250RmlsZTIgMTEgMCBSCj4+CmVuZG9iagoxMSAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoMSA4OTExMgovTGVuZ3RoIDM3ODM3Cj4+CnN0cmVhbQp4nO29B2AWxdY3fmZn29NLeu+N"+
  "lpAQQiCQR0CkE5USkBIghqJ06WIo0gQEhAAiQkREiIgBEQmiiESlWi6gcoFrw3aNyPVig2TzPzO7T/IQ4Or93vb93w8efpnd2dkpZ86cOVPOLBAAMMFsoOAcPuWhaBgVkY0+GwAEKBo/YsyEFlNG4zXew46R9w8thKt3jwOgnfG+1Uj0sO6LbIr3s/E+fuSYh6b9df/WU3i/BWDI+DFDp40P7yJPABjuj8+jx0+8f3wb5R94ObwFgDTywXHDh1pjC/HZSIx/yEMjHpxeNGdnVRzAESfAapVkwj44jr9DUAYbyFa8K8KXJ6BPqbAb5sNk9DlMjpPFQlP02wqX4RSGXAjHaZkIpCtkoC/AWUmAK6Q37ME4sok/yVZkEcSe4h7xHnGf+I14ErLESeJJsUCcRDLoZqmvtBWRTd8W3HAUomAf+RQmwX76Hc2gB8SOoh0+pSdpGXyFqYgY/3FYDltgJubFn4yDYmGmcA/6vCudhPX4G4fPT5KN5BTmbj+ZB2dgHRWFzrCRnMFyHYdfYB7tLRQjzTKEIsz/uxjXSXx/PUwSQTpDzKAJjdFvD6sTGMb/RtCm0hn+uwzFmHJv2CLvk/2VOEyFUWwrOUyq5FVQCqfoQDqBniPzxThxm9gZlusUoAWwHONez96Ri8h0LDv7zeT1PlUsIGXwnVigDMO432YlwjT3CPdgiYrgAGKq7MQytSHz6WLMKXsaASeVrmIqvo8xKLOw1ADjaCaMxquZsBN2Q1O6BpZjTLy8cpb0C765Qfwcy7ycLBN+gZO0I6RAkXgJaQ3IEmsAXlVkSaQCgSbRznIhoUthuefu/Ogj/WOaNqm7feSh9c2b4nMluhzyym3To/fV1ubli2FS/3IpvJwmqOViQtznt3r4edMm3fLyo8tr7uxoxHpnQUf0uzcfL9kdeqP/nR35M5ZouZSA/7sUlEcPHxn9mPOxuNaPOe9vjU2AtSOhnxn/whBHzs8QpbJLeC/3491e99ePqnfaJpr64C17SHgA/KuM0SIAbF/8+tHVu20TDf+6f0HnxZOc70EoQyxBTskkmXQnvC3vgY1SEJQp62GC3BbmCBnwNo2CcsQWZMy2+Pwsht8ofAmF6J7DNgMYfiHic8QaxAZEIYLFsxyxDbEEMQfDXkZsZHF4IebCKsz4Qmk6OKVZcFRaA5PkFHTtcFRcD0flDLwX4agwkKF2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Rm9udCAvQkxOUlNZK1RpbWVzTmV3Um9tYW4sSXRhbGljCi9Gb250RGVzY3JpcHRvciAyMSAwIFIKL1R5cGUgL0ZvbnQKL0NJRFRvR0lETWFwIC9JZGVudGl0eQovRFcgNTAwCi9XIFsgNTc0IFsgNjM2IF0gXQovQ0lEU3lzdGVtSW5mbyAyNCAwIFIKL1N1YnR5cGUgL0NJREZvbnRUeXBlMgo+PgplbmRvYmoKMjEgMCBvYmoKPDwKL1R5cGUgL0ZvbnREZXNjcmlwdG9yCi9Gb250TmFtZSAvQkxOUlNZK1RpbWVzTmV3Um9tYW4sSXRhbGljCi9Gb250QkJveCBbIC00OTcgLTMwNiAxMzMzIDEwMjMgXQovRmxhZ3MgNjU1NjgKL0FzY2VudCAxMDIzCi9DYXBIZWlnaHQgMTAyMwovRGVzY2VudCAtMzA2Ci9JdGFsaWNBbmdsZSAwCi9TdGVtViAxOTkKL0NJRFNldCAyMiAwIFIKL0ZvbnRGaWxlMiAyMyAwIFIKPj4KZW5kb2JqCjIyIDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMjAKPj4Kc3RyZWFtCnicY2CgCmACYgXqGDWUAAAhjAAjCmVuZHN0cmVhbQplbmRvYmoKMjMgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCA1NTkxCj4+CnN0cmVhbQp4nO06CXRUVbJV975e0kknnYROZ3/deekmSWftTkgIIeksHdCILIGxmzVhDYga"+
  "BBxwxMRtgOA2OuAuOuOMDEHz0mHpgEhcZsZl+H7HUcHxKDrI4DgoOurwhfT79V4HFM+c+f/8888///yfV1237q2qe2/dunW3ACAAmKAbONgXXbfGrovZcQVxdgEYti3tXHYVzj5wD4CxCUB3eNnK9UtB+9I6AIRAx5L2xR9++eRjABMEYo7rIEZ8ma4RIH4MlXM7rlqzLqpfdj9AzMqV1yxqj5azhgCSj1zVvq4zoST2J6RfRUx75zWr1yjJvU4qB7TytUs65628MYXK1I7plO5OsuIyEAkz+SpIBVA+IDypYuRS5ZzuSpAiHcqHvJZqbx3B6OeEHXAnxsIGuBn84IEn4BW4EjphOvRBDZzGt2ESCKT1Q8gHHwxDCrZDM1ZS6U6wKa+QZI7yMTsBDB6Am+ALWAtvwSL4DejhQfRCLlTB72CisgySdUdgHPwYtip/BINQDr+AI8q7SgQmw8/gCNZgK+/W1cIVcD3cALejDQuwCm8AF9mwDg7CELPE7IE4mAKXw0wIwDLYLSD1qYNp0Idv8kbqKQBbsAKHlF1gJ6tcUAT1OI65lf2QDQVQDhOgDm6Dn8L98DYW40ReJgyCjcbUDoMYjymYg4eUh0EkmAJzydLbYRvshFfhVRRxJivhbbpfRU5CPFxDFm6ALfAmfI4mvALXsTB/KlKnrFAGlBepdiX10wSXkt0b4D4a3ZOwF4bgOfLJEczCaXgffiqs0XmGb4q8HjmmpCifQwLZOgs64Grogs00N4/C8/AOHIczKKARE/F5Vsre4fHCozqbAspGNQKgBOrJW+tgI2wiGKQav0Y75qEX1+BbLJ4lsJXsRtbL/so3837+J+HPSqOyQ3mBfP4xGEAicMEMmtUNNGt30dztgqdhD4ThJfgLnIYvyZMrcAv24x78OxvDnmJvCud0R3SnlUeUcxBL3nZCIZQSeMmDk+ASsuVqeJBm6mU4DO/CN/ANZuB4vBE3Yg/eiVtxG76PX7Mfs9fYe3wb/xWX+UsCCh5hhW6L7ph+uqE9si3yoNJCo0umtsspbmrJh0soFldTTDxMfgzBPjhEtv0dzpJfkmm0uTgBZ+A6vAFvwrvwMTzKJrMV7BrWyZFncYmP5ZsEUegVXhfe0V2v2xJxRYJKMahxY6JomEB2BwgWwFLq5XqCLeSHPniGZuu3FLUfUzR/BWepN0bzHItWdOBY9BPM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MDA2NDEzOCAwMDAwMCBuIAowMDAwMDY0MjgyIDAwMDAwIG4gCjAwMDAwNjQ1NDggMDAwMDAgbiAKMDAwMDA2NDc2MyAwMDAwMCBuIAowMDAwMDY0OTc5IDAwMDAwIG4gCjAwMDAwNjUwNzUgMDAwMDAgbiAKMDAwMDA3MTg4MiAwMDAwMCBuIAowMDAwMDcxOTU3IDAwMDAwIG4gCjAwMDAwNzIxMTIgMDAwMDAgbiAKMDAwMDA3MjQ1MiAwMDAwMCBuIAowMDAwMDcyOTQzIDAwMDAwIG4gCjAwMDAwNzMxNzMgMDAwMDAgbiAKMDAwMDA3MzI4NSAwMDAwMCBuIAowMDAwMDkyMzI0IDAwMDAwIG4gCjAwMDAwOTIzOTkgMDAwMDAgbiAKMDAwMDA5MjU0OSAwMDAwMCBuIAowMDAwMDkyODkzIDAwMDAwIG4gCjAwMDAwOTM0MTMgMDAwMDAgbiAKMDAwMDA5MzYzOCAwMDAwMCBuIAowMDAwMDkzNzQ3IDAwMDAwIG4gCjAwMDAxMTc4OTcgMDAwMDAgbiAKMDAwMDExNzk3MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDQ3Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCj4+CnN0YXJ0eHJlZgoxMjAzODcKJSVFT0YK";

// печать бланков «5 нысан - форма 5» для почтовых заказов — генерируется прямо в браузере (pdf-lib),
// одним PDF со всеми выбранными заказами подряд. Шаблон встроен как base64 (см. MAIL_LABEL_TEMPLATE_B64 выше).
let _mailLabelAssets=null;
// подгружаем скрипт динамически (один раз) — используется для pdf-lib/fontkit, которые нужны только
// при печати бланков/накладных, поэтому не должны тормозить обычную загрузку сайта каждый раз
function loadScriptOnce(src){
  return new Promise((resolve,reject)=>{
    if(document.querySelector(`script[src="${src}"]`)){resolve();return;}
    const s=document.createElement('script');
    s.src=src;s.onload=()=>resolve();s.onerror=()=>reject(new Error('Не удалось загрузить '+src));
    document.head.appendChild(s);
  });
}
async function ensurePdfLib(){
  if(window.PDFLib&&window.fontkit)return;
  await Promise.all([
    loadScriptOnce('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js'),
    loadScriptOnce('https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'),
  ]);
}
async function loadMailLabelAssets(){
  if(_mailLabelAssets)return _mailLabelAssets;
  await ensurePdfLib();
  const templateBytes=Uint8Array.from(atob(MAIL_LABEL_TEMPLATE_B64),c=>c.charCodeAt(0));
  const [regularBytes,boldBytes]=await Promise.all([
    fetch('https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf/ttf/DejaVuSans.ttf').then(r=>r.arrayBuffer()),
    fetch('https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf').then(r=>r.arrayBuffer()),
  ]);
  _mailLabelAssets={templateBytes,regularBytes,boldBytes};
  return _mailLabelAssets;
}
// вписывает текст в ограниченную ширину — если не влезает целиком, уменьшает размер шрифта (не обрезает текст)
function drawFitText(page,text,x,y,maxWidth,font,size){
  if(!text)return;
  let s=size;
  while(s>6&&font.widthOfTextAtSize(text,s)>maxWidth)s-=0.5;
  page.drawText(text,{x,y,size:s,font});
}
// перенос длинного текста на несколько строк (по словам), друг под другом — вместо сжатия в одну строку.
// yTop — Y самой верхней строки, дальше идём вниз. Если после maxLines текст не влез — последняя строка
// сжимается по ширине (drawFitText), чтобы уж точно не выехать за пределы поля.
function drawWrappedText(page,text,x,yTop,maxWidth,font,size,lineHeight,maxLines){
  if(!text)return;
  const words=String(text).split(/\s+/).filter(Boolean);
  const lines=[];
  let cur='',i=0;
  while(i<words.length&&lines.length<maxLines-1){
    const test=cur?cur+' '+words[i]:words[i];
    if(font.widthOfTextAtSize(test,size)<=maxWidth){cur=test;i++;}
    else if(cur){lines.push(cur);cur='';}
    else{cur=words[i];i++;} // одно слово шире maxWidth — всё равно кладём, drawFitText сожмёт при отрисовке
  }
  if(cur)lines.push(cur);
  // все оставшиеся (не поместившиеся) слова — в последнюю строку целиком, она сожмётся по ширине при отрисовке
  const rest=words.slice(i).join(' ');
  if(rest)lines.push(lines.length?lines.pop()+' '+rest:rest);
  lines.slice(0,maxLines).forEach((line,idx)=>{
    const y=yTop-idx*lineHeight;
    if(idx===lines.length-1)drawFitText(page,line,x,y,maxWidth,font,size);
    else page.drawText(line,{x,y,size,font});
  });
}
// общая генерация PDF со бланками — принимает уже нормализованный список {client,address,phone,amount}
async function generateMailLabelsPdf(items){
  await ensurePdfLib();
  if(!window.PDFLib){toast('Библиотека PDF не загрузилась — проверьте интернет и обновите страницу');return null;}
  const {PDFDocument,rgb}=PDFLib;
  const assets=await loadMailLabelAssets();
  const templateDoc=await PDFDocument.load(assets.templateBytes);
  const outDoc=await PDFDocument.create();
  outDoc.registerFontkit(window.fontkit);
  const font=await outDoc.embedFont(assets.regularBytes,{subset:true});
  const fontBold=await outDoc.embedFont(assets.boldBytes,{subset:true});
  for(const it of items){
    const [page]=await outDoc.copyPages(templateDoc,[0]);
    outDoc.addPage(page);
    const {height:h}=page.getSize();
    const yOf=top=>h-top;
    // 1) закрашиваем строку отправителя (ИП) белым — у разных заказов будут разные ИП, пока оставляем пустой
    page.drawRectangle({x:90,y:h-158,width:260,height:16,color:rgb(1,1,1)});
    // 2) первая строка "0 (ноль тенге...)" — сумма заказа. Реальная линия поля: x 474–665 (не 825!)
    page.drawRectangle({x:465,y:h-146,width:155,height:15,color:rgb(1,1,1)});
    if(it.amount)page.drawText(Math.round(+it.amount).toLocaleString('ru-RU')+' т.',{x:478,y:yOf(144.5),size:10,font:fontBold});
    // 3) Кому — линия поля: x 454–665, ширина ~200пт (не 360!)
    drawFitText(page,it.client||'',458,yOf(388),195,font,10);
    // 4) Куда — та же узкая ширина, обязательно переносим на несколько строк
    drawWrappedText(page,it.address||'',458,yOf(439),195,font,9.5,11,3);
    // 5) телефон (после "+") — та же колонка
    drawFitText(page,(it.phone||'').replace(/^\+/,''),468,yOf(477),175,font,10);
  }
  return await outDoc.save();
}
async function openOrDownloadPdf(bytes,filename){
  const blob=new Blob([bytes],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const win=window.open(url,'_blank');
  if(!win){ // всплывающие окна заблокированы браузером — скачиваем файлом вместо открытия вкладки
    const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  }
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
// бланки для «своих» заказов (Заказы → Почтовая доставка)
async function printMailLabelsPdf(orders){
  const items=orders.map(o=>({
    client:o.client,address:o.address,
    phone:typeof phoneDisplay==='function'?phoneDisplay(o.phone||''):(o.phone||''),
    amount:(o.order_sum!=null&&o.order_sum!=='')?o.order_sum:(o.cost!=null?o.cost:0),
  }));
  const bytes=await generateMailLabelsPdf(items);
  if(!bytes)return;
  await openOrDownloadPdf(bytes,'Бланки_почта.pdf');
  toast(`Готово: бланков ${orders.length}`);
}
// бланки для входящих заказов КЕТ (Заказы → Заказы КЕТ)
async function printInboundMailLabelsPdf(orders){
  const items=orders.map(o=>({
    client:o.client,address:o.address,
    phone:typeof phoneDisplay==='function'?phoneDisplay(o.phone||''):(o.phone||''),
    amount:o.price!=null?o.price:(o.total_price!=null?o.total_price:0),
  }));
  const bytes=await generateMailLabelsPdf(items);
  if(!bytes)return;
  await openOrDownloadPdf(bytes,'Бланки_KET_почта.pdf');
  toast(`Готово: бланков ${orders.length}`);
}

// товарная накладная для курьерских заказов КЕТ — рисуем с нуля (не поверх шаблона), формат A5-подобный,
// одна накладная на страницу. Правки по запросу: после товара — магазин/партнёр (не «КС-3»), без номера
// курьера, шапка — «Jyldam Logistics».
async function generateWaybillsPdf(items){
  await ensurePdfLib();
  if(!window.PDFLib){toast('Библиотека PDF не загрузилась — проверьте интернет и обновите страницу');return null;}
  const {PDFDocument,rgb}=PDFLib;
  const assets=await loadMailLabelAssets(); // тот же кэш шрифтов с кириллицей, шаблон бланка тут не нужен
  const outDoc=await PDFDocument.create();
  outDoc.registerFontkit(window.fontkit);
  const font=await outDoc.embedFont(assets.regularBytes,{subset:true});
  const fontBold=await outDoc.embedFont(assets.boldBytes,{subset:true});
  const W=420,H=595; // примерно A5
  const BC_W=164.4,BC_H=113.4; // 58×40мм в pt (1мм = 2.8346pt) — размер штрихкода сверху, как просили
  for(const it of items){
    const page=outDoc.addPage([W,H]);
    let y=H-24;
    const line=(dy)=>{y-=dy;};
    // штрихкод заказа сверху, 58×40мм, по центру — рисуем полосками по символам штрих-кода заказа (orderNo)
    const bcX=(W-BC_W)/2;
    const code=String(it.orderNo||'');
    const barCount=Math.max(code.length,1);
    const gap=1.2;
    const barW=(BC_W-gap*(barCount-1))/barCount;
    let bx=bcX;
    for(let i=0;i<barCount;i++){
      const ch=code.charCodeAt(i%code.length)||48;
      const w=barW*(0.5+((ch%5)/5)*0.5); // ширина полоски "пляшет" по символу — визуально как штрихкод
      page.drawRectangle({x:bx,y:y-BC_H,width:w,height:BC_H,color:rgb(0,0,0)});
      bx+=barW+gap;
    }
    line(BC_H+18);
    // номер по центру под штрихкодом
    {const tw=fontBold.widthOfTextAtSize(code,11);page.drawText(code,{x:(W-tw)/2,y,size:11,font:fontBold});}
    line(24);
    // шапка
    page.drawText('Jyldam Logistics',{x:32,y,size:18,font:fontBold});
    line(30);
    page.drawLine({start:{x:32,y:y+6},end:{x:W-32,y:y+6},thickness:0.7,color:rgb(.7,.7,.7)});
    line(20);
    page.drawText(`Товарная накладная № ${it.orderNo}`,{x:32,y,size:12,font:fontBold});
    line(24);
    page.drawText('Курьерская служба',{x:32,y,size:9,font,color:rgb(.45,.45,.45)});
    drawFitText(page,'Jyldam Logistics',180,y,W-32-180,fontBold,10);
    line(18);
    page.drawText('Покупатель',{x:32,y,size:9,font,color:rgb(.45,.45,.45)});
    drawFitText(page,it.client||'—',180,y,W-32-180,font,10);
    line(18);
    page.drawText('Телефон',{x:32,y,size:9,font,color:rgb(.45,.45,.45)});
    drawFitText(page,it.phone||'—',180,y,W-32-180,font,10);
    line(18);
    page.drawText('Адрес',{x:32,y,size:9,font,color:rgb(.45,.45,.45)});
    drawWrappedText(page,it.address||'—',180,y,W-32-180,font,9.5,12,3);
    // оцениваем, на сколько строк перенёсся адрес (максимум 3), чтобы правильно сдвинуть таблицу ниже
    const addrLines=Math.min(3,Math.max(1,Math.ceil((it.address||'').length/40)));
    line(10+addrLines*12);
    // таблица товаров
    const tableTop=y;
    page.drawRectangle({x:32,y:tableTop-20,width:W-64,height:20,color:rgb(.94,.94,.94)});
    page.drawText('№ заказа',{x:36,y:tableTop-14,size:8.5,font:fontBold});
    page.drawText(`Товар (${it.shop||'—'})`,{x:110,y:tableTop-14,size:8.5,font:fontBold});
    page.drawText('Сумма',{x:W-90,y:tableTop-14,size:8.5,font:fontBold});
    let ty=tableTop-34;
    page.drawText(it.orderNo,{x:36,y:ty,size:9,font});
    const compLines=(it.composition&&it.composition.length?it.composition:['—']);
    compLines.forEach((cl,idx)=>{
      drawFitText(page,cl,110,ty-idx*13,W-90-110-8,font,8.5);
    });
    page.drawText(it.amountText||'0 тг.',{x:W-90,y:ty,size:9,font});
    const tableBottom=ty-Math.max(1,compLines.length)*13-6;
    page.drawRectangle({x:32,y:tableBottom,width:W-64,height:tableTop-tableBottom,borderColor:rgb(.75,.75,.75),borderWidth:0.7});
    y=tableBottom-30;
    page.drawText('Отпустил _____________________',{x:32,y,size:9,font});
    page.drawText('Получил _____________________',{x:W/2+10,y,size:9,font});
  }
  return await outDoc.save();
}
async function printInboundWaybillsPdf(orders){
  refreshInboundLookups();
  const items=orders.map(o=>{
    const its=inboundItemsFor(o.id);
    const composition=its.map(it=>{
      const p=it.product_id?(S.products||[]).find(x=>x.id===it.product_id):null;
      return `${p?p.name:(it.ket_sku||'?')} — ${it.qty} шт.`;
    });
    const amount=o.price!=null?o.price:(o.total_price!=null?o.total_price:0);
    return{
      orderNo:o.external_id||String(o.id).slice(0,8),
      client:o.client||'',
      phone:typeof phoneDisplay==='function'?phoneDisplay(o.phone||''):(o.phone||''),
      address:[o.address,o.city].filter(Boolean).join(', '),
      shop:inboundOrderShopLabel(o),
      composition,
      amountText:(amount?Math.round(+amount).toLocaleString('ru-RU'):'0')+' тг.',
    };
  });
  const bytes=await generateWaybillsPdf(items);
  if(!bytes)return;
  await openOrDownloadPdf(bytes,'Накладные_KET_курьер.pdf');
  toast(`Готово: накладных ${orders.length}`);
}

function exportOrdersToExcel(){
  if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
  const rows=filteredOrders(); // те же данные и фильтры, что в гриде
  if(!rows.length){toast('Нет заказов для выгрузки');return;}
  const staff=isStaff();
  // заголовки колонок — как в таблице
  const data=rows.map(o=>{
    const city=isCourierDelivery(o.delivery_id)?courierCityName(o.courier_city_id):(o.city_id?cityName(o.city_id):'');
    const row={
      'ID':o.code||'',
      'Дата забора':o.pickup_date?fmtDate(o.pickup_date):'',
      'Дата доставки / Статус обзвона':isCourierDelivery(o.delivery_id)?(o.deliver_date?fmtDate(o.deliver_date):''):(o.call_status||''),
      'Отправитель':o.sender||'',
      'ФИО клиента':o.client||'',
      'Телефон':o.phone?phoneDisplay(o.phone):'',
      'Вес (кг)':o.weight||'',
      'Размер пакета':o.size?((PACKAGE_SIZES[o.size]||{}).label||o.size):'',
      'Тип доставки':o.delivery_id?deliveryName(o.delivery_id):'',
      'Город':city||'',
      'Адрес':o.address||'',
      'Откуда забрали (физ. лицо)':o.fizlico_pickup_address||'',
      'Статус':o.status_id?((orderStatusObj(o.status_id)||{}).name||''):'',
      'Трек-код':o.track||'',
      'Индекс':o.index||'',
      'Партнёр':o.partner_id?partnerName(o.partner_id):'',
      'Оплачено отправителем':o.paid_by_sender?'да':'нет',
    };
    if(staff)row['Стоимость (₸)']=o.cost!=null&&o.cost!==''?(+o.cost):'';
    return row;
  });
  const ws=XLSX.utils.json_to_sheet(data);
  // ширины колонок
  const cols=Object.keys(data[0]||{});
  ws['!cols']=cols.map(c=>({wch:(c==='Адрес'||c==='Откуда забрали (физ. лицо)')?28:(c==='Отправитель'||c==='ФИО клиента'||c==='Партнёр'?20:14)}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Заказы');
  // имя файла с датой и режимом
  const modeName=ordersMode==='courier'?'курьерская':ordersMode==='mail'?'почтовая':ordersMode==='today'?'сегодня':'все';
  const today=new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb,`Заказы_${modeName}_${today}.xlsx`);
  toast(`Выгружено заказов: ${rows.length}`);
}
// выгрузка заказов КЕТ в Excel — принимает уже готовый список (с учётом выбора галочкой/фильтра)
function exportInboundToExcel(rows){
  if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
  if(!rows.length){toast('Нет заказов для выгрузки');return;}
  refreshInboundLookups();
  const data=rows.map(o=>({
    'Штрих-код заказа':o.external_id||'',
    'Источник':o.source||'',
    'Клиент':o.client||'',
    'Телефон':o.phone?phoneDisplay(o.phone):'',
    'Город':o.city||'',
    'Адрес':o.address||'',
    'Тип доставки':inboundDeliveryLabel(o),
    'Магазин':inboundOrderShopLabel(o),
    'Сумма':o.price!=null?o.price:'',
    'Статус отправки':ketSendLabel(o.send_status),
    'Статус посылки':ketKzLabel(o.status_kz),
    'Звонковый статус':o.call_status!=null?ketCallLabel(o.call_status):'',
    'Привязка товара':o.match_status==='matched'?'привязан':'не привязан',
    'Склад списан':o.stock_written?'да':'нет',
    'Поступил':o.created_at?fmtDateTime(o.created_at):'',
  }));
  const ws=XLSX.utils.json_to_sheet(data);
  const cols=Object.keys(data[0]||{});
  ws['!cols']=cols.map(c=>({wch:c==='Адрес'?28:(c==='Клиент'||c==='Магазин'?20:14)}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Заказы КЕТ');
  const today=new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb,`Заказы_KET_${today}.xlsx`);
  toast(`Выгружено заказов: ${rows.length}`);
}
function drawOrders(){
  const el=$('orderTable');const allRows=filteredOrders();
  // счётчик у «Список заказов» = число с учётом ВСЕХ фильтров (вкл. тип доставки, поиск)
  const cntEl=$('ordersCount');if(cntEl)cntEl.textContent=allRows.length;
  removeOrdersPager(); // убрать старую плавающую панель, если была
  if(!allRows.length){el.innerHTML=`<div class="empty"><div class="big">Заказов нет</div>${isStaff()?'Нажмите «Создать заказ».':'Вам пока не назначены заказы.'}</div>`;return;}
  if(isCourier()){drawCourierOrderCards(el,allRows);return;}
  const staff=isStaff();
  const mobile=isMobileView();
  // ── ПАГИНАЦИЯ: десктоп — постранично; мобила — «Показать ещё» ──
  let rows,startIdx,totalPages;
  if(mobile){
    if(ordersMobileLimit>allRows.length)ordersMobileLimit=Math.max(MOBILE_STEP,allRows.length);
    rows=allRows.slice(0,ordersMobileLimit);
    startIdx=0;totalPages=1;
  }else{
    totalPages=Math.max(1,Math.ceil(allRows.length/ordersPerPage));
    if(ordersPage>totalPages)ordersPage=totalPages;
    if(ordersPage<1)ordersPage=1;
    startIdx=(ordersPage-1)*ordersPerPage;
    rows=allRows.slice(startIdx,startIdx+ordersPerPage);
  }
  // если включён режим «выбраны все» — добавляем id текущей страницы в выбор
  if(ketSelectAll)allRows.forEach(o=>ketSelected.add(o.id));
  el.innerHTML=`<div class="table-scroll"><table class="resp-table"><thead><tr>
    ${staff?'<th style="width:34px"><input type="checkbox" id="ketChkAll" title="Выбрать все"></th>':''}<th>Фото</th><th>ID</th><th>Дата забора</th><th>${ordersMode==='mail'?'Статус обзвона':'Дата доставки'}</th><th>Отправитель</th><th>ФИО клиента</th><th>Телефон</th><th>Вес</th>
    <th>Тип доставки</th>${ordersMode!=='mail'?'<th>Город</th>':''}${staff&&ordersMode!=='mail'?'<th>Менеджер</th>':''}<th>Адрес</th><th>Статус</th><th>Трек-код</th>
    ${staff?'<th>Стоимость</th>':''}<th></th></tr></thead>
    <tbody>${rows.map(o=>{
      const ph=pickupPhotos(o);
      const photoCell=ph.length
        ? `<img src="${esc(ph[0].url)}" data-oviewphoto="${esc(ph[0].url)}" loading="lazy" decoding="async" style="width:38px;height:38px;object-fit:cover;border-radius:7px;cursor:pointer;border:1px solid var(--line)" title="Фото: ${ph.length}">${ph.length>1?`<span style="font-size:11px;color:var(--muted);margin-left:3px">×${ph.length}</span>`:''}`
        : '<span style="color:var(--line)">—</span>';
      return `<tr data-orow="${o.id}" style="cursor:pointer" class="${o.via_integration?'order-row-api':''}" title="${o.via_integration?'Пришёл от партнёра напрямую через API-интеграцию':''}">
      ${staff?`<td data-label="" onclick="event.stopPropagation()"><input type="checkbox" class="ketChk" data-ketchk="${o.id}" ${ketSelected.has(o.id)?'checked':''} ${o.ket_id?'title="Уже отправлен в KET"':''}></td>`:''}
      <td data-label="Фото">${photoCell}</td>
      <td data-label="ID"><strong style="font-family:'Fraunces',serif">${esc(o.code)}</strong>${o.ket_id?`<span class="ket-badge" title="Отправлен в KET${o.ket_id?' · ID '+esc(o.ket_id):''}">KET ✓</span>`:''}</td>
      <td data-label="Дата забора">${esc(fmtDate(o.pickup_date))}${o.created_at?`<small class="cell-time">создан ${esc(fmtDateTime(o.created_at))}</small>`:''}</td>
      <td data-label="${isCourierDelivery(o.delivery_id)?'Дата доставки':'Статус обзвона'}" ${isCourierDelivery(o.delivery_id)?'':'onclick="event.stopPropagation()"'}>${isCourierDelivery(o.delivery_id)
        ?(o.deliver_date?esc(fmtDate(o.deliver_date)):'—')
        :`<select class="status-pick" data-ocall="${o.id}" style="border-color:${callStatusColor(o.call_status)}">
        <option value="">— нет —</option>
        <option value="Недозвон" ${o.call_status==='Недозвон'?'selected':''}>Недозвон</option>
        <option value="Прозвонен" ${o.call_status==='Прозвонен'?'selected':''}>Прозвонен</option>
        <option value="Изменен" ${o.call_status==='Изменен'?'selected':''}>Изменен</option>
      </select>`}</td>
      <td data-label="Отправитель">${esc(o.sender)||'—'}</td><td data-label="ФИО клиента">${esc(o.client)||'—'}</td>
      <td data-label="Телефон">${o.phone?phoneLink(o.phone):'—'}</td>
      <td data-label="Вес">${o.weight?esc(o.weight)+' кг':'—'}</td>
      <td data-label="Тип доставки">${o.delivery_id?esc(deliveryName(o.delivery_id)):'—'}</td>
      ${ordersMode!=='mail'?`<td data-label="Город">${isCourierDelivery(o.delivery_id)?esc(courierCityName(o.courier_city_id)):(o.city_id?esc(cityName(o.city_id)):'—')}</td>`:''}
      ${staff&&ordersMode!=='mail'?`<td data-label="Менеджер">${o.sales_id?esc(salesName(o.sales_id)):'<span style="color:var(--muted)">—</span>'}</td>`:''}
      <td data-label="Адрес">${esc(o.address)||'—'}</td>
      <td data-label="Статус"><div class="status-cell" onclick="event.stopPropagation()">
        <span class="status-badge" style="color:${(orderStatusObj(o.status_id)||{}).color||'var(--muted)'};background:${(orderStatusObj(o.status_id)||{}).color?(orderStatusObj(o.status_id).color+'1a'):'transparent'};border-color:${(orderStatusObj(o.status_id)||{}).color||'var(--line)'}">${o.status_id?esc((orderStatusObj(o.status_id)||{}).name||'—'):'— нет —'}</span>
        <select class="status-overlay" data-ostatus="${o.id}"><option value="">— нет —</option>${S.orderStatuses.map(s=>`<option value="${s.id}" ${o.status_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
      </div></td>
      <td data-label="Трек-код">${esc(o.track)||'—'}</td>
      ${staff?`<td data-label="Стоимость">${o.cost?esc((+o.cost).toLocaleString('ru-RU'))+' ₸':'—'}</td>`:''}
      <td data-label="" class="cell-actions"><div class="row-actions">
        ${can('orders','delete')?`<button class="btn sm danger" data-odel="${o.id}">Удалить</button>`:''}
      </div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  el.querySelectorAll('[data-oviewphoto]').forEach(im=>im.onclick=e=>{e.stopPropagation();viewPhoto(im.dataset.oviewphoto);});
  el.querySelectorAll('[data-oedit]').forEach(b=>b.onclick=()=>orderModal(b.dataset.oedit));
  el.querySelectorAll('[data-oview]').forEach(b=>b.onclick=()=>orderModal(b.dataset.oview,true));
  // мобила: тап по строке сворачивает/разворачивает карточку заказа
  el.querySelectorAll('[data-orow]').forEach(tr=>tr.onclick=e=>{
    if(!isMobileView())return;
    if(e.target.closest('button,select,input,a,img,.row-actions,.status-cell'))return;
    tr.classList.toggle('open');
  });
  el.querySelectorAll('[data-odel]').forEach(b=>b.onclick=()=>delOrder(b.dataset.odel));
  el.querySelectorAll('[data-obc]').forEach(b=>b.onclick=()=>showBarcode(b.dataset.obc));
  // двойной клик по строке открывает заказ: на редактирование, если есть право, иначе просмотр
  el.querySelectorAll('[data-orow]').forEach(tr=>tr.ondblclick=e=>{
    if(e.target.closest('button,select,input,a'))return;
    orderModal(tr.dataset.orow,!can('orders','edit'));
  });
  el.querySelectorAll('[data-ostatus]').forEach(sel=>sel.onchange=async()=>{
    const o=S.orders.find(x=>x.id===sel.dataset.ostatus);if(!o)return;
    const oldS=o.status_id;
    const u=await dbUpdate('orders',o.id,{status_id:sel.value||null});
    if(u){o.status_id=u.status_id;
      logAction('status','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:[{field:'status_id',label:'Статус',old:logFieldValue('status_id',oldS),new:logFieldValue('status_id',o.status_id)}]});
      const so=orderStatusObj(o.status_id)||{};
      const badge=sel.parentElement.querySelector('.status-badge');
      if(badge){badge.textContent=o.status_id?(so.name||'—'):'— нет —';badge.style.color=so.color||'var(--muted)';badge.style.background=so.color?(so.color+'1a'):'transparent';badge.style.borderColor=so.color||'var(--line)';}
      toast('Статус обновлён');}});
  // статус обзвона клиента (Недозвон / Прозвонен / Изменен)
  el.querySelectorAll('[data-ocall]').forEach(sel=>sel.onchange=async()=>{
    const o=S.orders.find(x=>x.id===sel.dataset.ocall);if(!o)return;
    const oldV=o.call_status;
    const u=await dbUpdate('orders',o.id,{call_status:sel.value||null});
    if(u){o.call_status=u.call_status;
      sel.style.borderColor=callStatusColor(o.call_status);
      logAction('update','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:[{field:'call_status',label:'Статус обзвона',old:oldV||'—',new:o.call_status||'—'}]});
      toast('Статус обзвона обновлён');}});
  // отдельные чекбоксы строк — обновляют множество выбранных
  el.querySelectorAll('.ketChk').forEach(c=>c.onchange=()=>{
    const id=c.dataset.ketchk;
    if(c.checked)ketSelected.add(id);else{ketSelected.delete(id);ketSelectAll=false;}
    updateKetAllChk(allRows);
  });
  // чекбокс «выбрать все» — отмечает ВСЕ заказы во всех страницах (по текущему фильтру)
  const chkAll=$('ketChkAll');
  if(chkAll)chkAll.onchange=e=>{
    if(e.target.checked){ketSelectAll=true;allRows.forEach(o=>ketSelected.add(o.id));}
    else{ketSelectAll=false;allRows.forEach(o=>ketSelected.delete(o.id));}
    el.querySelectorAll('.ketChk').forEach(c=>c.checked=e.target.checked);
  };
  updateKetAllChk(allRows);
  if(mobile){
    if(rows.length<allRows.length){
      const more=document.createElement('button');
      more.className='btn ghost show-more';
      more.textContent=`Показать ещё (${allRows.length-rows.length})`;
      more.onclick=()=>{ordersMobileLimit+=MOBILE_STEP;drawOrders();};
      el.appendChild(more);
    }
    el.insertAdjacentHTML('beforeend',`<div class="list-count">Показано ${rows.length} из ${allRows.length}</div>`);
  }else{
    renderOrdersPager(allRows.length,totalPages,startIdx,rows.length);
  }
}
// сброс пагинации на первую страницу (при смене фильтров/поиска)
function drawOrdersReset(){ordersPage=1;ordersMobileLimit=MOBILE_STEP;ketSelectAll=false;drawOrders();}
// синхронизирует чекбокс «выбрать все»: отмечен, если выбраны все заказы текущего фильтра
function updateKetAllChk(allRows){
  const chk=$('ketChkAll');if(!chk)return;
  const total=allRows.length;
  const selected=allRows.filter(o=>ketSelected.has(o.id)).length;
  chk.checked=total>0&&selected===total;
  chk.indeterminate=selected>0&&selected<total;
}
// плавающая (закреплённая снизу) панель навигации по страницам заказов
function removeOrdersPager(){const ex=$('ordersPager');if(ex)ex.remove();const m=$('main');if(m&&!$('pickupsPager')&&!$('inboundPager')&&!$('whProdPager'))m.classList.remove('has-pager');}
function renderOrdersPager(total,totalPages,startIdx,shownCount){
  removeOrdersPager();
  if(!total)return;
  const from=startIdx+1, to=startIdx+shownCount;
  const bar=document.createElement('div');
  bar.id='ordersPager';bar.className='orders-pager';
  {const m=$('main');if(m)m.classList.add('has-pager');}
  bar.innerHTML=`
    <button class="op-btn" id="opRefreshBtn" title="Подтянуть свежие данные">🔄</button>
    <div class="op-info">Показаны <b>${from}–${to}</b> из <b>${total}</b></div>
    <div class="op-perpage">
      <span>На странице:</span>
      <div class="op-pp-wrap">
        <button class="op-btn op-pp-btn" id="opPerPageBtn">${ordersPerPage} ▾</button>
        <div class="op-pp-menu" id="opPerPageMenu" style="display:none">
          ${ORDERS_PAGE_SIZES.map(s=>`<button class="op-pp-item ${s===ordersPerPage?'active':''}" data-pp="${s}">${s}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="op-nav">
      <button class="op-btn" data-opage="first" ${ordersPage<=1?'disabled':''} title="В начало">«</button>
      <button class="op-btn" data-opage="prev" ${ordersPage<=1?'disabled':''}>‹ Назад</button>
      <span class="op-page">Стр. ${ordersPage} / ${totalPages}</span>
      <button class="op-btn" data-opage="next" ${ordersPage>=totalPages?'disabled':''}>Вперёд ›</button>
      <button class="op-btn" data-opage="last" ${ordersPage>=totalPages?'disabled':''} title="В конец">»</button>
    </div>`;
  document.body.appendChild(bar);
  const opRefreshBtn=bar.querySelector('#opRefreshBtn');
  if(opRefreshBtn)opRefreshBtn.onclick=async()=>{
    opRefreshBtn.disabled=true;opRefreshBtn.textContent='…';
    try{await refreshForTab(S.tab);drawOrders();toast('Обновлено');}
    finally{if(opRefreshBtn){opRefreshBtn.disabled=false;opRefreshBtn.textContent='🔄';}}
  };
  // выбор количества на странице
  const ppBtn=bar.querySelector('#opPerPageBtn'), ppMenu=bar.querySelector('#opPerPageMenu');
  if(ppBtn)ppBtn.onclick=e=>{e.stopPropagation();ppMenu.style.display=ppMenu.style.display==='none'?'flex':'none';};
  bar.querySelectorAll('[data-pp]').forEach(b=>b.onclick=()=>{
    ordersPerPage=parseInt(b.dataset.pp,10)||50;ordersPage=1;drawOrders();
    const t=$('orderTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
  // закрытие меню при клике вне
  document.addEventListener('click',function closePP(ev){
    if(ppMenu&&!ppMenu.contains(ev.target)&&ev.target!==ppBtn){ppMenu.style.display='none';}
  },{once:true});
  bar.querySelectorAll('[data-opage]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.opage;
    if(a==='first')ordersPage=1;
    else if(a==='prev')ordersPage=Math.max(1,ordersPage-1);
    else if(a==='next')ordersPage=Math.min(totalPages,ordersPage+1);
    else if(a==='last')ordersPage=totalPages;
    drawOrders();
    // прокрутка к началу таблицы при смене страницы
    const t=$('orderTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
}
/* Компактные карточки заказов для курьера: свёрнуто — ID/ФИО/телефон/адрес/сумма/статус, по тапу разворачивается остальное */
function drawCourierOrderCards(el,rows){
  el.innerHTML=`<div class="cour-cards">${rows.map(o=>{
    const ph=phoneStored(o.phone);
    const sum=o.cost?(+o.cost).toLocaleString('ru-RU')+' ₸':'—';
    const city=isCourierDelivery(o.delivery_id)?courierCityName(o.courier_city_id):'';
    return `<div class="cour-card" data-card="${o.id}">
      <div class="cc-head" data-toggle="${o.id}">
        <div class="cc-main">
          <div class="cc-top"><span class="cc-id">${esc(o.code)}</span></div>
          <div class="cc-client">${esc(o.client)||'Без имени'}</div>
          <div class="cc-addr">${city?`<strong>${esc(city)}</strong> · `:''}${esc(o.address)||'адрес не указан'}</div>
          ${ph?`<div class="cc-phone">${phoneLink(o.phone)}</div>`:''}
        </div>
        <div class="cc-right">
          <div class="cc-sum">${esc(sum)}<small>сумма</small></div>
          <span class="cc-chev">▾</span>
        </div>
      </div>
      <div class="cc-statusrow">
        <select class="status-pick" data-ostatus="${o.id}" style="border-color:${(orderStatusObj(o.status_id)||{}).color||'var(--line)'}">
          <option value="">— нет —</option>${S.orderStatuses.map(s=>`<option value="${s.id}" ${o.status_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
      </div>
      <div class="cc-body">
        <div class="cc-row"><span class="lbl">Дата забора</span><span class="vl">${esc(fmtDate(o.pickup_date))}</span></div>
        <div class="cc-row"><span class="lbl">Отправитель</span><span class="vl">${esc(o.sender)||'—'}</span></div>
        <div class="cc-row"><span class="lbl">Тип доставки</span><span class="vl">${o.delivery_id?esc(deliveryName(o.delivery_id)):'—'}</span></div>
        <div class="cc-row"><span class="lbl">Вес</span><span class="vl">${o.weight?esc(o.weight)+' кг':'—'}</span></div>
        <div class="cc-row"><span class="lbl">Кол-во товаров</span><span class="vl">${esc(o.qty||0)}</span></div>
        <div class="cc-row"><span class="lbl">Индекс</span><span class="vl">${esc(o.index)||'—'}</span></div>
        <div class="cc-row"><span class="lbl">Трек-код</span><span class="vl">${esc(o.track)||'—'}</span></div>
        <div class="cc-actions">
          <button class="btn sm ghost" data-oview="${o.id}">Открыть</button>
        </div>
      </div>
    </div>`;}).join('')}</div>`;
  // тап по шапке — разворачивает/сворачивает (но не по ссылке-телефону)
  el.querySelectorAll('[data-toggle]').forEach(h=>h.onclick=e=>{
    if(e.target.closest('a'))return; // не сворачивать при клике на телефон
    h.closest('.cour-card').classList.toggle('open');
  });
  el.querySelectorAll('[data-oview]').forEach(b=>b.onclick=e=>{e.stopPropagation();orderModal(b.dataset.oview,true);});
  el.querySelectorAll('[data-obc]').forEach(b=>b.onclick=e=>{e.stopPropagation();showBarcode(b.dataset.obc);});
  el.querySelectorAll('[data-ostatus]').forEach(sel=>{
    sel.onclick=e=>e.stopPropagation(); // выбор статуса не сворачивает карточку
    sel.onchange=async()=>{const o=S.orders.find(x=>x.id===sel.dataset.ostatus);if(!o)return;
      const oldS=o.status_id;
      const u=await dbUpdate('orders',o.id,{status_id:sel.value||null});
      if(u){o.status_id=u.status_id;sel.style.borderColor=(orderStatusObj(u.status_id)||{}).color||'var(--line)';
        logAction('status','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:[{field:'status_id',label:'Статус',old:logFieldValue('status_id',oldS),new:logFieldValue('status_id',o.status_id)}]});
        toast('Статус обновлён');}};
  });
}
function renderBarcode(svgEl,code){if(!svgEl||!code)return;try{if(window.JsBarcode)JsBarcode(svgEl,code,{format:'CODE128',width:2,height:70,displayValue:true,fontSize:16,margin:6});}catch(e){console.error(e);}}
function showBarcode(id){const o=S.orders.find(x=>x.id===id);if(!o)return;
  showInfo(`Штрих-код · заказ ${esc(o.code)}`,`<div style="text-align:center;padding:10px 0"><svg id="bcView"></svg><div style="margin-top:10px;color:var(--muted);font-size:13px">${esc(o.client||'')} ${o.track?('· трек '+esc(o.track)):''}</div></div>`);
  setTimeout(()=>renderBarcode($('bcView'),o.code),60);}
async function delOrder(id){const o=S.orders.find(x=>x.id===id);if(!confirm(`Удалить заказ ${o?.code||''}?`))return;
  if(await dbDelete('orders',id)){await logAction('delete','orders',{entity_id:id,entity_label:orderLabel(o)});S.orders=S.orders.filter(x=>x.id!==id);toast('Заказ удалён');renderOrders();}}
// расценки по размеру пакета (S/M/L) — раздельно для почтовой и курьерской доставки.
// Больше не единая цена на всех: размер S = собственный тариф ПАРТНЁРА (курьер/почта), а M и L
// считаются от него с надбавкой — курьерская: +2000 на каждый шаг (S→M→L); почтовая: M = S+500,
// L = S+1500. Если у партнёра тариф не указан (пусто) — используются базовые значения по умолчанию.
const PACKAGE_SIZE_LABELS={S:'S — малый',M:'M — средний',L:'L — большой'};
function packageSizesFor(partner){
  const baseCourier=isExplicitNum(partner&&partner.tariff_courier)?+partner.tariff_courier:3000;
  const baseMail=isExplicitNum(partner&&partner.tariff_post)?+partner.tariff_post:1500;
  // «Неприкосновенный» партнёр — своя фиксированная цена по тарифу, наша обычная сетка надбавок
  // (S/M/L) на него не действует: любой размер пакета стоит одинаково, ровно по тарифу партнёра
  if(partner&&partner.is_protected){
    return {
      S:{label:PACKAGE_SIZE_LABELS.S,courier:baseCourier,mail:baseMail},
      M:{label:PACKAGE_SIZE_LABELS.M,courier:baseCourier,mail:baseMail},
      L:{label:PACKAGE_SIZE_LABELS.L,courier:baseCourier,mail:baseMail},
    };
  }
  return {
    S:{label:PACKAGE_SIZE_LABELS.S,courier:baseCourier,mail:baseMail},
    M:{label:PACKAGE_SIZE_LABELS.M,courier:baseCourier+2000,mail:baseMail+500},
    L:{label:PACKAGE_SIZE_LABELS.L,courier:baseCourier+4000,mail:baseMail+1500},
  };
}
function isExplicitNum(v){return v!=null&&v!==''&&!isNaN(+v);}
// вариант без привязки к партнёру — на случай, если партнёр ещё не определён/не выбран (базовые значения)
const PACKAGE_SIZES=packageSizesFor(null);
function orderModal(id,readonly){
  const o=id?S.orders.find(x=>x.id===id):null;
  const today=new Date().toISOString().slice(0,10);
  const code=o?o.code:genOrderCode();
  const d=o||{code,sender:'',partner_id:'',pickup_date:today,weight:'',client:'',phone:'',courier_city_id:'',pickup_city_id:'',address:'',qty:'',status_id:defaultOrderStatusId(),delivery_id:'',index:'',track:'',sales_id:'',processor_id:'',cost:'',pay_date:'',post_ip_id:'',order_courier_id:''};
  // размеры пакетов — сразу по партнёру из поля «Отправитель», если он уже известен (для первичной
  // отрисовки формы; при смене отправителя/типа доставки дальше пересчитывается через findPartner())
  const _initPartner=d.sender?S.partners.find(pp=>(pp.name||'').trim().toLowerCase()===d.sender.trim().toLowerCase()):null;
  const _initSizes=packageSizesFor(_initPartner);
  const ro=readonly||!can("orders","edit");const dis=ro?'disabled':'';
  showModal(id?('Заказ '+code):('Новый заказ '+code),`
    <div class="order-split">
      <div class="ophoto-col">
        ${orderBigPhotoHtml(o,!ro)}
        ${(o&&o.id&&!ro)?`<div class="field full" style="margin-top:14px"><label>KET</label>
          <div style="border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--card)">
            ${o.ket_id?`<div style="margin-bottom:8px"><span class="ket-badge" style="font-size:12px;padding:3px 10px">✓ Отправлен в KET</span><div style="font-size:12px;color:var(--muted);margin-top:6px">ID <strong>${esc(o.ket_id)}</strong>${o.ket_track?(' · трек '+esc(o.ket_track)):''}${o.ket_synced_at?(' · '+esc(fmtDate(o.ket_synced_at))):''}</div></div>`:'<div style="font-size:13px;color:var(--muted);margin-bottom:8px">Ещё не отправлен в KET</div>'}
            <button type="button" class="btn sm ${o.ket_id?'ghost':''}" data-ketsend="${o.id}">${o.ket_id?'Отправить повторно':'Отправить в KET'}</button>
          </div></div>`:''}
        ${(o&&o.id&&o.phone)?`<div class="field full" style="margin-top:14px"><label>💬 Переписка с получателем (WhatsApp) <button type="button" class="btn ghost sm" id="o_chat_sync" style="margin-left:8px">🔄 Загрузить историю</button></label>
          <small style="color:var(--muted);font-size:12px">Новые сообщения приходят сами; старую переписку (до подключения) нужно подтянуть кнопкой выше — один раз</small>
          <div id="o_chat_box" style="border:1px solid var(--line);border-radius:10px;max-height:260px;overflow-y:auto;padding:10px;background:#fafafa;display:flex;flex-direction:column;margin-top:6px">
            <div class="hint">Загрузка…</div>
          </div>
          ${!ro?`<div style="display:flex;gap:8px;margin-top:8px">
            <input id="o_chat_input" placeholder="Написать получателю…" style="flex:1">
            <button type="button" class="btn primary sm" id="o_chat_send">Отправить</button>
          </div>`:''}
        </div>`:''}
      </div>
      <div class="oform-col">
    <div class="grid2">
      <div class="field"><label>ID заказа</label><input value="${esc(code)}" readonly style="font-family:'Fraunces',serif;font-weight:900;letter-spacing:1px"></div>
      <div class="field"><label>Дата забора</label><input type="date" id="o_pickup" value="${esc(d.pickup_date||'')}" ${dis}></div>
      <div class="field"><label>Отправитель</label><input id="o_sender" list="partnersList" autocomplete="off" value="${esc(d.sender)}" ${dis}><datalist id="partnersList">${S.partners.map(p=>`<option value="${esc(p.name)}"></option>`).join('')}</datalist></div>
      <div class="field"><label>Город забора <span style="color:var(--muted);font-weight:400;font-size:11px">(откуда забрали)</span></label><select id="o_pickupcity" ${dis}><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${d.pickup_city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field full" id="fizlicoPickupAddrField" style="${(_initPartner&&isFizlicoPartner(_initPartner))?'':'display:none'}"><label>Адрес откуда забрали (физ. лицо)</label><input id="o_fizlico_pickup_addr" value="${esc(d.fizlico_pickup_address||'')}" placeholder="реальный адрес, где забрали посылку у этого клиента" ${dis}></div>
      <div class="field"><label>ФИО клиента</label><input id="o_client" value="${esc(d.client)}" ${dis}></div>
      <div class="field"><label>Телефон клиента <span style="color:var(--rust)">*</span></label><input id="o_phone" inputmode="numeric" ${dis}></div>
      <div class="field mail-only" style="${isCourierDelivery(d.delivery_id)?'display:none':''}"><label>Индекс</label><input id="o_index" value="${esc(d.index)}" ${dis}></div>
      <div class="field"><label>Сумма заказа (₸)</label><input type="number" min="0" id="o_sum" value="${d.order_sum!=null&&d.order_sum!==''?esc(d.order_sum):''}" ${dis} ${d.paid_by_sender?'disabled':''}><span class="hint">Подставляется из размера пакета или тарифа партнёра по типу доставки. Можно изменить вручную.</span>${isStaff()?`<label class="o-paidorder"><input type="checkbox" id="o_paidorder" ${d.paid_by_sender?'checked':''} ${dis}> Оплачено отправителем <span style="font-weight:400;color:var(--muted);font-size:12px">(сумма станет 0)</span></label>`:''}</div>
      <div class="field"><label>Размер пакета</label><select id="o_size" style="width:100%" ${dis}>${Object.entries(_initSizes).map(([k,v])=>`<option value="${k}" ${d.size===k?'selected':''}>${esc(v.label)}</option>`).join('')}</select><span class="hint" id="o_size_hint">Почта ${_initSizes.S.mail}/${_initSizes.M.mail}/${_initSizes.L.mail} · Курьер ${_initSizes.S.courier}/${_initSizes.M.courier}/${_initSizes.L.courier} ₸ (S/M/L)${_initPartner?(_initPartner.is_protected?' — 🔒 неприкосновенный, фиксированная цена по тарифу '+esc(_initPartner.name):' — по тарифу '+esc(_initPartner.name)):' — базовые значения (партнёр ещё не определён)'}. Сумма подставится автоматически по типу доставки.</span></div>
      <div class="field"><label>Тип доставки <span style="color:var(--rust)">*</span></label><select id="o_delivery" ${dis}><option value="">—</option>${S.delivery.filter(x=>/курьер|почт/i.test(x.name||'')).map(x=>`<option value="${x.id}" ${d.delivery_id===x.id?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field" id="cityField" style="${isCourierDelivery(d.delivery_id)?'':'display:none'}"><label>Город (курьерская)</label><select id="o_city" ${dis}><option value="">—</option>${S.courier_cities.map(c=>`<option value="${c.id}" ${d.courier_city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field mail-only" id="postCityField" style="${isCourierDelivery(d.delivery_id)?'display:none':''}"><label>Город (почтовая)</label><select id="o_postcity" ${dis}><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${d.city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>Адрес получателя</label><input id="o_address" value="${esc(d.address)}" ${dis}></div>
      <div class="field"><label>Курьер по заказам</label><select id="o_ocourier" ${dis}><option value="">—</option>${S.order_couriers.filter(c=>!d.courier_city_id||c.courier_city_id===d.courier_city_id).map(c=>`<option value="${c.id}" ${d.order_courier_id===c.id?'selected':''}>${esc(c.fio)}</option>`).join('')}</select></div>
      <div class="field"><label>Статус отправки</label><select id="o_status" ${dis}><option value="">—</option>${S.orderStatuses.map(s=>`<option value="${s.id}" ${d.status_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Вес (кг)</label><input type="number" min="0" step="0.01" id="o_weight" value="${esc(d.weight)}" ${dis}></div>
      <div class="field mail-only" style="${isCourierDelivery(d.delivery_id)?'display:none':''}"><label>Трек-код</label>
        <div style="display:flex;gap:8px">
          <input id="o_track" value="${esc(d.track)}" ${dis} style="flex:1">
          ${(o&&o.id&&!ro)?`<button type="button" class="btn ghost sm" id="o_kazpost_btn" style="white-space:nowrap">📮 Получить трек</button>`:''}
        </div>
      </div>
      <div class="field"><label>Дата оплаты</label><input type="date" id="o_pay" value="${esc(d.pay_date||'')}" ${dis}></div>
      <div class="field courier-only" style="${isCourierDelivery(d.delivery_id)?'':'display:none'}"><label>Дата доставки</label><input type="date" id="o_deliver" min="${localToday()}" value="${esc(d.deliver_date||'')}" ${dis}></div>
      <div class="field full mail-only" style="${isCourierDelivery(d.delivery_id)?'display:none':''}"><label>ИП для Почты</label><select id="o_ip" ${dis}><option value="">—</option>${S.post_ips.map(s=>`<option value="${s.id}" ${d.post_ip_id===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>Комментарий</label><textarea id="o_comment" rows="7" style="font:inherit;font-size:15px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);width:100%;resize:vertical" ${dis}>${esc(d.comment||'')}</textarea></div>
    </div>
      </div>
    </div>`,
    ro?null:async()=>{
      // телефон клиента обязателен
      const phoneDigits=phoneVal('o_phone');
      if(!phoneDigits||phoneDigits.length<10){toast('Укажите номер телефона клиента');const pf=$('o_phone');if(pf){pf.focus();pf.style.borderColor='var(--rust)';}return false;}
      // тип доставки обязателен — без него заказ не считается обработанным (например, для
      // «Сортировки» на складе) и непонятно, какой набор полей (курьер/почта) заполнять
      if(!val('o_delivery')){toast('Выберите тип доставки');const df=$('o_delivery');if(df){df.focus();df.style.borderColor='var(--rust)';}return false;}
      const row={code,sender:val('o_sender').trim(),pickup_date:val('o_pickup')||null,
        weight:val('o_weight')?parseFloat(val('o_weight')):null,client:val('o_client').trim(),phone:phoneDigits,
        courier_city_id:isCourierDelivery(val('o_delivery'))?(val('o_city')||null):null,address:val('o_address').trim(),
        fizlico_pickup_address:$('o_fizlico_pickup_addr')?val('o_fizlico_pickup_addr').trim()||null:null,
        pickup_city_id:val('o_pickupcity')||null,
        city_id:!isCourierDelivery(val('o_delivery'))?(val('o_postcity')||null):null,
        order_sum:(val('o_sum')!==''?parseFloat(val('o_sum')):null),
        status_id:val('o_status')||null,delivery_id:val('o_delivery')||null,
        index:val('o_index').trim(),track:val('o_track').trim(),sales_id:d.sales_id||null,processor_id:d.processor_id||null,
        cost:(val('o_sum')!==''?parseFloat(val('o_sum')):0),pay_date:val('o_pay')||null,deliver_date:val('o_deliver')||null,post_ip_id:val('o_ip')||null,comment:val('o_comment').trim(),
        size:val('o_size')||null,
        order_courier_id:val('o_ocourier')||null};
      // галочка «Оплачено отправителем»: сумма→0 (исходная запоминается), снятие — возврат
      if($('o_paidorder')){
        const paidNow=$('o_paidorder').checked;
        if(paidNow){
          // берём именно то, что было ДО обнуления (dataset.prevsum) — поле o_sum на момент
          // сохранения уже показывает 0, читать его напрямую сюда нельзя
          const prevSum=$('o_paidorder').dataset.prevsum;
          if(!o||!o.paid_by_sender){row.order_sum_orig=(prevSum!=null&&prevSum!=='')?(parseFloat(prevSum)||0):0;} // запоминаем при первом включении
          else{row.order_sum_orig=(o.order_sum_orig!=null?o.order_sum_orig:0);}
          row.paid_by_sender=true;row.order_sum=0;row.cost=0;
        }else{
          // если сняли галочку, а сумму вручную не меняли — вернём исходную
          if(o&&o.paid_by_sender){const back=(o.order_sum_orig!=null?o.order_sum_orig:0);
            if(val('o_sum')===''||parseFloat(val('o_sum'))===0){row.order_sum=back;row.cost=back;}}
          row.paid_by_sender=false;row.order_sum_orig=null;
        }
      }
      if(id){const before=Object.assign({},o);const u=await dbUpdate('orders',id,row);if(!u)return false;Object.assign(o,u);
        await logAction('update','orders',{entity_id:o.id,entity_label:orderLabel(o),changes:buildChanges(before,o)});}
      else{
        // ── проверка на возможный дубль (только при создании нового заказа) ──
        const dupWarn=await checkOrderDuplicate(row.phone,row.client);
        if(dupWarn){
          const proceed=await confirmDuplicate(dupWarn);
          // пишем факт попытки в историю независимо от решения
          logAction('dup_check','orders',{entity_label:orderLabel(row),meta:{matched:dupWarn.matchedCode,manager:dupWarn.managerName,decision:proceed?'created':'cancelled'}});
          if(!proceed)return false; // менеджер передумал — не создаём
        }
        const u=await dbInsert('orders',row);if(!u)return false;S.orders.unshift(u);
        await logAction('create','orders',{entity_id:u.id,entity_label:orderLabel(u)});}
      toast(id?'Заказ сохранён':'Заказ создан');renderOrders();return true;
    },{readonly:ro,wide:true});
  attachPhone('o_phone',d.phone);
  // кнопка «Отправить в KET»
  if(o&&o.id){const kb=document.querySelector(`[data-ketsend="${o.id}"]`);if(kb)kb.onclick=async()=>{
    kb.disabled=true;
    const ok=await sendOrderToKet(o);
    kb.disabled=false;
    // обновляем пометку прямо в открытой карточке
    if(ok){const box=kb.parentElement;if(box){box.querySelector('div').outerHTML=`<div style="margin-bottom:8px"><span class="ket-badge" style="font-size:12px;padding:3px 10px">✓ Отправлен в KET</span><div style="font-size:12px;color:var(--muted);margin-top:6px">ID <strong>${esc(o.ket_id||'')}</strong>${o.ket_synced_at?(' · '+esc(fmtDate(o.ket_synced_at))):''}</div></div>`;kb.textContent='Отправить повторно';kb.classList.add('ghost');}}
  };}
  // переписка с получателем заказа (WhatsApp через Kelesu) — по телефону ИМЕННО этого заказа,
  // не партнёра — у разных заказов одного партнёра получатели разные
  if(o&&o.id&&o.phone&&$('o_chat_box')){
    loadPhoneChat(o.phone,'o_chat_box');
    const oChatSendBtn=$('o_chat_send'),oChatInput=$('o_chat_input');
    if(oChatSendBtn&&oChatInput){
      const doOrderSend=async()=>{
        const text=oChatInput.value.trim();if(!text)return;
        oChatSendBtn.disabled=true;
        try{
          const res=await callKelesuSend({phone:o.phone,text});
          if(res&&res.success){oChatInput.value='';await loadPhoneChat(o.phone,'o_chat_box');}
          else{toast('Не удалось отправить: '+(res&&res.error||'ошибка'));}
        }catch(e){toast('Не удалось отправить сообщение');}
        finally{oChatSendBtn.disabled=false;}
      };
      oChatSendBtn.onclick=doOrderSend;
      oChatInput.addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();doOrderSend();}});
    }
    const oChatSyncBtn=$('o_chat_sync');
    if(oChatSyncBtn)oChatSyncBtn.onclick=async()=>{
      oChatSyncBtn.disabled=true;oChatSyncBtn.textContent='⏳ Загружаем…';
      try{
        const res=await callKelesuSyncHistory({phone:o.phone});
        if(res&&res.success){
          if(res.chat_found)toast(`Загружено сообщений: ${res.imported}`);
          else toast('В Kelesu не нашлось чата с этим номером');
          await loadPhoneChat(o.phone,'o_chat_box');
        }else{toast('Не удалось загрузить историю: '+(res&&res.error||'ошибка'));}
      }catch(e){toast('Не удалось загрузить историю');}
      finally{oChatSyncBtn.disabled=false;oChatSyncBtn.textContent='🔄 Загрузить историю';}
    };
  }
  if($('o_kazpost_btn'))$('o_kazpost_btn').onclick=async()=>{
    const btn=$('o_kazpost_btn');btn.disabled=true;btn.textContent='⏳ Получаем…';
    try{
      const res=await callKazpostGetBarcode(o.id);
      if(res&&res.success){
        o.track=res.barcode;
        const trackEl=$('o_track');if(trackEl)trackEl.value=res.barcode;
        toast(`Трек-номер получен: ${res.barcode}`);
      }else{toast('Не удалось получить трек-номер: '+(res&&res.error||'ошибка'));}
    }catch(e){toast('Не удалось получить трек-номер');}
    finally{btn.disabled=false;btn.textContent='📮 Получить трек';}
  };
  if(o&&o.id){
    const bindBig=()=>{
      const pc=$('o_photos');if(!pc)return;
      bindPhotoBlock(pc,o,redrawOPhotos,'orders'); // добавление/удаление через стандартные data-атрибуты
      // клик по миниатюре — меняем крупное фото
      pc.querySelectorAll('[data-obigthumb]').forEach(t=>t.onclick=e=>{
        e.stopPropagation();
        const main=pc.querySelector('#obigMain');
        if(main){main.src=t.dataset.obigthumb;main.dataset.oviewphoto=t.dataset.obigthumb;}
        const byEl=pc.querySelector('#obigBy');
        if(byEl)byEl.innerHTML=t.dataset.obigby||'';
        pc.querySelectorAll('[data-obigthumb]').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
      });
      // зум фото прямо в окне: клик циклически увеличивает (1x → 2x → 3.5x → 1x), можно перетаскивать
      const main=pc.querySelector('#obigMain');
      if(main){
        let zoom=1, panX=0, panY=0, rot=0, dragging=false, moved=false, sx=0, sy=0, spx=0, spy=0;
        const apply=()=>{
          main.style.transform=`scale(${zoom}) translate(${panX}px,${panY}px) rotate(${rot}deg)`;
          main.style.cursor=zoom>1?'grab':'zoom-in';
          // пока фото увеличено — забираем жест себе (иначе палец скроллит модалку, а не двигает фото)
          main.style.touchAction=zoom>1?'none':'pan-y';
        };
        const rotBy=d=>{rot=(rot+d)%360;apply();};
        const bL=pc.querySelector('#orotL'), bR=pc.querySelector('#orotR');
        if(bL)bL.onclick=e=>{e.stopPropagation();rotBy(-90);};
        if(bR)bR.onclick=e=>{e.stopPropagation();rotBy(90);};
        main.onclick=e=>{
          e.stopPropagation();
          if(moved){moved=false;return;} // если двигали — не менять зум
          zoom = zoom>=3.5 ? 1 : (zoom>=2 ? 3.5 : 2);
          if(zoom===1){panX=0;panY=0;}
          apply();
        };
        main.onmousedown=e=>{
          if(zoom<=1)return;
          dragging=true;moved=false;sx=e.clientX;sy=e.clientY;spx=panX;spy=panY;
          main.style.cursor='grabbing';e.preventDefault();
        };
        main.onmousemove=e=>{
          if(!dragging)return;
          panX=spx+(e.clientX-sx)/zoom;panY=spy+(e.clientY-sy)/zoom;
          if(Math.abs(e.clientX-sx)>3||Math.abs(e.clientY-sy)>3)moved=true;
          apply();
        };
        main.onmouseup=()=>{if(dragging){dragging=false;main.style.cursor='grab';}};
        main.onmouseleave=()=>{if(dragging){dragging=false;main.style.cursor='grab';}};
        // ── то же самое пальцем (мобильные): без этого свайп по увеличенному фото просто скроллил модалку ──
        main.addEventListener('touchstart',e=>{
          if(zoom<=1)return; // не увеличено — пусть страница/модалка скроллится как обычно
          const t=e.touches[0];if(!t)return;
          dragging=true;moved=false;sx=t.clientX;sy=t.clientY;spx=panX;spy=panY;
        },{passive:true});
        main.addEventListener('touchmove',e=>{
          if(!dragging)return;
          const t=e.touches[0];if(!t)return;
          panX=spx+(t.clientX-sx)/zoom;panY=spy+(t.clientY-sy)/zoom;
          if(Math.abs(t.clientX-sx)>3||Math.abs(t.clientY-sy)>3)moved=true;
          apply();
          e.preventDefault(); // блокируем скролл модалки, пока таскаем увеличенное фото
        },{passive:false});
        main.addEventListener('touchend',()=>{dragging=false;});
        main.addEventListener('touchcancel',()=>{dragging=false;});
      }
      // ИИ-распознавание данных получателя с фото
      const aiBtn=pc.querySelector('#oAiRecognize');
      if(aiBtn)aiBtn.onclick=e=>{e.stopPropagation();aiRecognizeFromPhoto(o);};
    };
    const redrawOPhotos=()=>{const pc=$('o_photos');if(!pc)return;pc.innerHTML=orderBigPhotoInner(o,!ro);bindBig();};
    bindBig();
  }
  if(!ro){
    const fillCouriers=cityId=>{
      const sel=$('o_ocourier');if(!sel)return;
      const cur=sel.value;
      const opts=S.order_couriers.filter(c=>!cityId||c.courier_city_id===cityId);
      sel.innerHTML='<option value="">—</option>'+opts.map(c=>`<option value="${c.id}">${esc(c.fio)}</option>`).join('');
      if(opts.find(c=>c.id===cur))sel.value=cur; // сохранить выбор, если курьер из этого города
    };
    // сумма заказа тянется от тарифа партнёра (пока её не правили вручную)
    // если сумма уже была — считаем её «введённой вручную» только если размер пакета НЕ выбран.
    // Если размер выбран (значит сумму подставил именно он) — при смене типа доставки сумма должна
    // пересчитываться automatически и дальше, а не «замирать» на старом значении.
    let sumTouched=(d.order_sum!=null&&d.order_sum!==''&&!d.size);
    const findPartner=()=>{
      // 1) по partner_id заказа, если есть
      if(d.partner_id){const p=S.partners.find(x=>x.id===d.partner_id);if(p)return p;}
      // 2) по имени отправителя без учёта регистра и лишних пробелов
      const name=($('o_sender').value||'').trim().toLowerCase().replace(/\s+/g,' ');
      return S.partners.find(x=>(x.name||'').trim().toLowerCase().replace(/\s+/g,' ')===name)||null;
    };
    const applyTariff=()=>{
      // если у партнёра тариф ИМЕННО ПО ЭТОМУ ТИПУ ДОСТАВКИ (курьер или почта — какой сейчас выбран
      // у заказа) стоит ровно 0 — эту доставку он оплачивает сам отдельно, не через сумму заказа —
      // сразу ставим «Оплачено отправителем» (если ещё не отмечено вручную). Другой тариф (не
      // относящийся к этому заказу) на это никак не влияет — раньше ошибочно проверялись оба сразу.
      const ptForPaid=findPartner();
      const courierForPaid=isCourierDelivery($('o_delivery').value);
      const relevantTariff=courierForPaid?ptForPaid&&ptForPaid.tariff_courier:ptForPaid&&ptForPaid.tariff_post;
      if(ptForPaid&&paidChk&&!paidChk.checked&&isExplicitZero(relevantTariff)){
        paidChk.checked=true;paidChk.onchange();
      }
      // «Физ лицо Астана» / «Физ лицо Алматы» — это конкретные клиенты. Адрес из карточки партнёра
      // (их обычный, зарегистрированный адрес) подставляем как ЗАГОТОВКУ в «Адрес откуда забрали» —
      // сотрудник может поправить вручную, если реально забрали в другом месте (только если поле
      // ещё пустое — не затираем то, что уже ввели руками)
      const fizlicoAddrEl=$('o_fizlico_pickup_addr');
      if(ptForPaid&&isFizlicoPartner(ptForPaid)&&fizlicoAddrEl&&!fizlicoAddrEl.value.trim()){
        fizlicoAddrEl.value=ptForPaid.address||'';
      }
      // показываем поле «Адрес откуда забрали (физ. лицо)» только для этих двух партнёров —
      // у обычных партнёров реальный адрес забора и так известен из их карточки, а тут он
      // каждый раз разный (реальный клиент), поэтому вводится отдельно, вручную
      const fizlicoField=$('fizlicoPickupAddrField');
      if(fizlicoField)fizlicoField.style.display=(ptForPaid&&isFizlicoPartner(ptForPaid))?'':'none';
      if(sumTouched)return; // не перезаписываем введённую вручную сумму
      // если выбран размер пакета — считаем по нему, это приоритетнее общего тарифа партнёра
      const sizeEl=$('o_size');
      if(sizeEl&&sizeEl.value&&PACKAGE_SIZES[sizeEl.value]){applySize();return;}
      const pt=findPartner();if(!pt)return;
      const courier=isCourierDelivery($('o_delivery').value);
      const t=courier?pt.tariff_courier:pt.tariff_post;
      const sumEl=$('o_sum');
      if(sumEl&&t!=null&&t!==''){sumEl.value=t;}
    };
    // сумма по размеру пакета (S/M/L) — сразу по типу доставки. Выбор размера — явное действие
    // сотрудника, поэтому подставляем сумму даже если до этого что-то уже было в поле вручную,
    // но саму сумму «ручной правкой» не считаем — если сменится тип доставки, пересчитается снова.
    // сумма по размеру пакета (S/M/L) — сразу по типу доставки и ТАРИФУ КОНКРЕТНОГО ПАРТНЁРА
    // (не общая цена на всех: размер S = собственный тариф партнёра, M/L считаются от него).
    // Выбор размера — явное действие сотрудника, поэтому подставляем сумму даже если до этого
    // что-то уже было в поле вручную, но саму сумму «ручной правкой» не считаем — если сменится
    // тип доставки, пересчитается снова.
    const applySize=()=>{
      const sizeEl=$('o_size');if(!sizeEl||!sizeEl.value)return;
      const sizes=packageSizesFor(findPartner());
      const cfg=sizes[sizeEl.value];if(!cfg)return;
      const courier=isCourierDelivery($('o_delivery').value);
      const sumEl=$('o_sum');
      if(sumEl&&!sumEl.disabled){sumEl.value=courier?cfg.courier:cfg.mail;sumTouched=false;}
      // подпись под списком тоже обновляем — числа могли смениться вместе с партнёром
      const hintEl=$('o_size_hint');
      if(hintEl){
        const pt=findPartner();
        hintEl.textContent=`Почта ${sizes.S.mail}/${sizes.M.mail}/${sizes.L.mail} · Курьер ${sizes.S.courier}/${sizes.M.courier}/${sizes.L.courier} ₸ (S/M/L)${pt?(pt.is_protected?' — 🔒 неприкосновенный, фиксированная цена по тарифу '+pt.name:' — по тарифу '+pt.name):' — базовые значения (партнёр ещё не определён)'}. Сумма подставится автоматически по типу доставки.`;
      }
    };
    const sumEl=$('o_sum');if(sumEl)sumEl.oninput=()=>{sumTouched=true;};
    const sizeEl=$('o_size');if(sizeEl)sizeEl.onchange=()=>{applySize();};
    // галочка «Оплачен заказ»: обнуляет поле суммы и блокирует его (исходная вернётся при снятии)
    const paidChk=$('o_paidorder');
    if(paidChk){
      paidChk.dataset.prevsum=(d.order_sum!=null&&d.order_sum!=='')?String(d.order_sum):''; // помним сумму до обнуления
      paidChk.onchange=()=>{
        const se=$('o_sum');if(!se)return;
        if(paidChk.checked){
          // если поле суммы пустое (например, только что автоматически поставили галочку из-за
          // нулевого тарифа) — подставляем условную сумму из карточки партнёра, а не оставляем пусто
          if(!se.value.trim()){
            const pt=findPartner();
            if(pt&&pt.direct_pay_amount!=null)se.value=pt.direct_pay_amount;
          }
          paidChk.dataset.prevsum=se.value;se.value='0';se.disabled=true;sumTouched=true;
        }
        else{se.disabled=false;se.value=paidChk.dataset.prevsum||'';sumTouched=(se.value!=='');}
      };
    }
    // показать/скрыть поля, относящиеся только к почтовой/только к курьерской доставке
    const toggleMailFields=()=>{
      const courier=isCourierDelivery($('o_delivery').value);
      document.querySelectorAll('.mail-only').forEach(el=>el.style.display=courier?'none':'');
      document.querySelectorAll('.courier-only').forEach(el=>el.style.display=courier?'':'none');
    };
    const ds=$('o_delivery');ds.onchange=()=>{
      const f=$('cityField');
      if(isCourierDelivery(ds.value))f.style.display='';else{f.style.display='none';if($('o_city')){$('o_city').value='';fillCouriers('');}}
      toggleMailFields();applyTariff();
    };
    const cityEl=$('o_city');if(cityEl)cityEl.onchange=()=>fillCouriers(cityEl.value);
    // при изменении отправителя — подтянуть данные партнёра
    const ss=$('o_sender');if(ss){
      const pullPartner=()=>{
        const name=ss.value.trim().toLowerCase().replace(/\s+/g,' ');
        const pt=S.partners.find(x=>(x.name||'').trim().toLowerCase().replace(/\s+/g,' ')===name);
        if(pt){if(pt.sales_id&&$('o_sales'))$('o_sales').value=pt.sales_id;if(pt.processor_id&&$('o_proc'))$('o_proc').value=pt.processor_id;
          // город забора подставляем из города партнёра (если поле ещё пустое)
          if(pt.city_id&&$('o_pickupcity')&&!$('o_pickupcity').value)$('o_pickupcity').value=pt.city_id;}
        applyTariff();
      };
      ss.onchange=pullPartner;
      ss.oninput=pullPartner; // выбор из выпадающей подсказки
    }
    // сразу при открытии карточки — не только при изменении полей — чтобы автоподстановка
    // (адрес физ.лица, «Оплачено отправителем» и т.п.) сработала и для УЖЕ существующих заказов,
    // не только при ручном перевыборе отправителя
    applyTariff();
    setTimeout(applyTariff,0); // первичная подстановка суммы из тарифа при открытии
  }
}