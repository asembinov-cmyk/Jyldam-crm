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
    // трек уходит в KET только при отправке: метода обновления у них нет
    msg+=ketSendWarnNoTrack(list);
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
/* ---- НАСТРОЙКИ БЛАНКА КАЗПОЧТЫ ----
   Раньше данные отправителя были ВПЕЧАТАНЫ в PDF-шаблон: сменить ИП, адрес или номер
   договора можно было только заменой файла. Теперь шаблон чистый (assets/mail-label-blank.pdf,
   получен из исходного удалением этих надписей), а значения рисуются отсюда.
   Значения по умолчанию — ровно те, что стояли в старом бланке: если таблицы ещё нет или
   она недоступна, бланк напечатается как раньше, а не пустым. */
const MAIL_LABEL_DEFAULTS={
  sender:'ТОО QP Service (ИП Ахитова Гульшарат)',
  from_addr:'г.Астана, Филиал “ИЛЦ ЮГ”, улица А185, здание 13',
  support:'Номер тех. поддержки:+7 (705) 927-57-07',
  index_code:'010009',
  contract:'Договор № 10004943-2024-191272 25.01.2024 г',
  payment_code:'5652',
};
let _mailLabelSettings=null;
async function loadMailLabelSettings(force){
  if(_mailLabelSettings&&!force)return _mailLabelSettings;
  try{
    const {data}=await sb.from('mail_label_settings').select('*').eq('id','default').maybeSingle();
    _mailLabelSettings=Object.assign({},MAIL_LABEL_DEFAULTS,data||{});
  }catch(e){
    console.error('loadMailLabelSettings',e);
    _mailLabelSettings=Object.assign({},MAIL_LABEL_DEFAULTS);
  }
  return _mailLabelSettings;
}
async function saveMailLabelSettings(row){
  const {error}=await sb.from('mail_label_settings').upsert(Object.assign({id:'default'},row));
  if(error){console.error('saveMailLabelSettings',error);toast('Ошибка: '+error.message);return false;}
  _mailLabelSettings=null;   // перечитаем при следующей печати
  return true;
}

async function loadMailLabelAssets(){
  if(_mailLabelAssets)return _mailLabelAssets;
  await ensurePdfLib();
  // бланк лежит отдельным файлом и качается только при печати — раньше он был вшит сюда
  // строкой base64 на 158 КБ и грузился у всех при каждом открытии сайта
  // Чистый бланк: без впечатанных данных отправителя — их рисуем из настроек.
  // Исходный assets/mail-label-template.pdf оставлен рядом как образец «как было».
  const templateBytes=new Uint8Array(await fetch('assets/mail-label-blank.pdf').then(r=>r.arrayBuffer()));
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
  const cfg=await loadMailLabelSettings();   // данные отправителя из настроек
  const font=await outDoc.embedFont(assets.regularBytes,{subset:true});
  const fontBold=await outDoc.embedFont(assets.boldBytes,{subset:true});
  for(const it of items){
    const [page]=await outDoc.copyPages(templateDoc,[0]);
    outDoc.addPage(page);
    const {height:h}=page.getSize();
    const yOf=top=>h-top;
    // 1) данные отправителя — из настроек (Настройки → «Бланк Казпочты»).
    // Закрашивать больше нечего: в чистом шаблоне этих строк нет.
    drawFitText(page,cfg.sender||'',96,yOf(156),350,font,12);
    drawFitText(page,cfg.from_addr||'',96,yOf(190),340,font,12);
    drawFitText(page,cfg.support||'',96,yOf(204),340,font,12);
    drawFitText(page,cfg.index_code||'',196,yOf(220),120,font,11);
    drawFitText(page,cfg.contract||'',65,yOf(351),330,font,11);
    // «КОД ПЛАТЕЖА» и сам код — в исходном бланке это была одна строка
    page.drawText('КОД ПЛАТЕЖА',{x:264,y:yOf(126),size:16,font:fontBold});
    drawFitText(page,cfg.payment_code||'',480,yOf(126),90,fontBold,16);
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
  el.innerHTML=`<div class="table-scroll"><table class="resp-table resp-collapse"><thead><tr>
    ${staff?'<th style="width:34px"><input type="checkbox" id="ketChkAll" title="Выбрать все"></th>':''}<th>Фото</th><th>ID</th><th>Дата забора</th><th>${ordersMode==='mail'?'Статус обзвона':'Дата доставки'}</th><th>Отправитель</th><th>ФИО клиента</th><th>Телефон</th><th>Вес</th>
    <th>Тип доставки</th>${ordersMode!=='mail'?'<th>Город</th>':''}${staff&&ordersMode!=='mail'?'<th>Менеджер</th>':''}<th>Адрес</th><th>Статус</th><th>Трек-код</th>
    ${staff?'<th>Стоимость</th>':''}<th></th></tr></thead>
    <tbody>${rows.map(o=>{
      const ph=pickupPhotos(o);
      const photoCell=ph.length
        ? `<img data-ph="${esc(photoPath(ph[0]))}" data-oviewphoto="${esc(photoPath(ph[0]))}" loading="lazy" decoding="async" style="width:38px;height:38px;object-fit:cover;border-radius:7px;cursor:pointer;border:1px solid var(--line)" title="Фото: ${ph.length}">${ph.length>1?`<span style="font-size:11px;color:var(--muted);margin-left:3px">×${ph.length}</span>`:''}`
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
        if(main){
          // в data-атрибутах теперь путь в хранилище, а не постоянная ссылка:
          // снимаем отметку «уже подставлено» и просим подставить свежую временную
          main.setAttribute('data-ph',t.dataset.obigthumb);
          main.removeAttribute('data-ph-done');
          main.removeAttribute('src');
          main.dataset.oviewphoto=t.dataset.obigthumb;
          hydratePhotos(pc);
        }
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