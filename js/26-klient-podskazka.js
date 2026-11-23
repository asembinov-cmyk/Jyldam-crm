/* ================= ПОДСКАЗКА «ТАКОЙ КЛИЕНТ УЖЕ ЕСТЬ» =================
   В карточке заказа: начали вводить ФИО или вписали телефон — под полем появляется, кто из
   прежних получателей подходит, и кнопка «Подставить»: ФИО, телефон, адрес и индекс берутся
   из заказа, который уже заполняли раньше. Просьба владельца 23.11.2026 — для «Заполнения»
   и для Барахолки; карточка у них одна (`orderModal`), поэтому работает везде, где её правят.

   ПОЧЕМУ ЭТО ВАЖНЕЕ, ЧЕМ КАЖЕТСЯ. Замер ИИ в тот же день показал: с рукописного бланка
   телефон читается в половине случаев, ФИО — в одном из восьми. А у трети заказов получатель
   уже был в базе. Постоянного клиента можно не разбирать по почерку, а узнать.

   ИЩЕМ В БАЗЕ, а не в памяти вкладки: там после входа лежит не вся история.

   ВЕТКИ НЕ СМЕШИВАЮТСЯ. В карточке Барахолки ищем среди заказов Барахолки, в остальных —
   среди заказов заборов. Владелец разводил эти ветки по всей системе («никак не должны
   пересекаться»), и менеджер Барахолки не должен видеть через подсказку чужих получателей.

   НИЧЕГО НЕ ПОДСТАВЛЯЕТСЯ САМО. Совпадение по фамилии — ещё не тот человек, и однофамильцы
   в подсказке будут. Решает менеджер, нажав кнопку у нужной строки. */

const OCS_NAME_MIN   = 5;      // с какой длины ФИО начинаем искать: короче — тысячи совпадений
const OCS_WAIT_MS    = 450;    // ждём после последней буквы: на каждое нажатие в базу не ходим
const OCS_FETCH      = 60;     // сколько прежних заказов берём, чтобы собрать из них людей
const OCS_SHOW       = 5;      // сколько человек показываем
const OCS_COLS = 'id,code,client,phone,address,index,courier_city_id,delivery_id,sender,created_at';

let ocsSeq = 0;                // номер запроса: ответ старого не должен затереть свежий
let ocsCtx = null;             // карточка, с которой сейчас работаем
let ocsTimer = null;

const ocsDigits = v => { const d=String(v||'').replace(/\D/g,''); return d.length>=10?d.slice(-10):''; };
// «1 заказ · 3 заказа · 12 заказов»
function ocsOrdersWord(n){
  const a=n%10, b=n%100;
  return n+' '+((a===1&&b!==11)?'заказ':((a>=2&&a<=4&&(b<12||b>14))?'заказа':'заказов'));
}
const ocsNorm = s => String(s||'').toUpperCase().replace(/Ё/g,'Е').replace(/\s+/g,' ').trim();

// Из прежних заказов собираем ЛЮДЕЙ: один человек — одна строка, сколько бы раз он ни заказывал.
// Ключ — телефон и ФИО вместе: на одном номере бывают разные получатели (семья, офис).
function ocsGroup(rows, selfId){
  const map = new Map();
  rows.forEach(r=>{
    if(r.id===selfId) return;
    const name=ocsNorm(r.client), ph=ocsDigits(r.phone);
    if(!name) return;                       // болванка без ФИО подсказать ничего не может
    const key=ph+'|'+name;
    let g=map.get(key);
    if(!g){ g={key,client:String(r.client).trim(),phone:ph,address:'',index:'',courier_city_id:'',sender:'',last:'',count:0}; map.set(key,g); }
    g.count++;
    // строки приходят от свежих к старым, поэтому первое непустое значение — самое свежее
    if(!g.last) g.last=r.created_at||'';
    if(!g.address && String(r.address||'').trim()) g.address=String(r.address).trim();
    if(!g.index && /^\d{6}$/.test(String(r.index||'').trim())) g.index=String(r.index).trim();
    if(!g.courier_city_id && r.courier_city_id) g.courier_city_id=r.courier_city_id;
    if(!g.sender && r.sender) g.sender=r.sender;
  });
  return [...map.values()];
}

async function ocsQuery(kind, value, bar){
  let q = sb.from('orders').select(OCS_COLS).order('created_at',{ascending:false}).limit(OCS_FETCH);
  if(kind==='phone'){
    // телефон в заказах лежит в разных видах (раздел 5f) — спрашиваем все четыре
    q = q.in('phone',[value,'7'+value,'8'+value,'+7'+value]);
  }else{
    // по началу ФИО: фамилию пишут первой. % и _ в ilike — шаблонные знаки, экранируем.
    q = q.ilike('client', value.replace(/[\\%_]/g,m=>'\\'+m)+'%');
  }
  // Ветку фильтруем, только когда колонка есть: без db/13 запрос с ней отклонился бы целиком.
  if(typeof baraholkaReady==='function' && baraholkaReady()){
    q = bar ? q.eq('calc_group','baraholka') : q.or('calc_group.is.null,calc_group.neq.baraholka');
  }
  const {data,error} = await q;
  if(error) throw error;
  return data||[];
}

function ocsBox(fieldId){
  const el=document.getElementById(fieldId); if(!el) return null;
  const field=el.closest('.field'); if(!field) return null;
  let box=field.querySelector('.ocs-box');
  if(!box){ box=document.createElement('div'); box.className='ocs-box'; field.appendChild(box); }
  return box;
}
function ocsHide(){
  document.querySelectorAll('.overlay .ocs-box').forEach(b=>{ b.innerHTML=''; });
}

function ocsRender(fieldId, groups, total){
  ocsHide();
  const box=ocsBox(fieldId); if(!box||!ocsCtx) return;
  if(!groups.length) return;               // никого не нашли — молчим: пустая плашка только мешает
  ocsCtx.groups=groups;
  const more=total>groups.length?` · показаны ${groups.length} из ${total}, уточните ввод`:'';
  box.innerHTML=`<div class="ocs-head"><b>Такой клиент уже есть в базе</b><span class="hint" style="margin:0">${more}</span>
      <button type="button" class="ocs-x" data-ocsclose="1" aria-label="Скрыть">×</button></div>`
    + groups.map((g,i)=>{
      const where=[g.address, g.index?('индекс '+g.index):''].filter(Boolean).join(' · ');
      const meta=[ocsOrdersWord(g.count), g.last?('последний '+fmtDate(g.last)):'', g.sender].filter(Boolean).join(' · ');
      return `<div class="ocs-row">
        <div class="ocs-main">
          <div><b>${esc(g.client)}</b>${g.phone?` · ${esc(phoneDisplay(g.phone))}`:''}</div>
          ${where?`<div class="ocs-addr">${esc(where)}</div>`:''}
          <div class="hint" style="margin:2px 0 0">${esc(meta)}</div>
        </div>
        <button type="button" class="btn sm ghost" data-ocspick="${i}">Подставить</button>
      </div>`;}).join('');
}

// Подставляем данные выбранного человека в поля карточки.
function ocsApply(g){
  const set=(id,v)=>{ const el=document.getElementById(id); if(el&&!el.disabled&&v){ el.value=v; return el; } return null; };
  set('o_client', g.client);
  const ph=document.getElementById('o_phone');
  if(ph&&!ph.disabled&&g.phone){ ph.dataset.phone=g.phone; ph.value=fmt10(g.phone); }
  // Адрес ставим РАНЬШЕ индекса: подсказка по индексу сама вписывает адрес отделения в ПУСТОЕ
  // поле (раздел 6f), и при обратном порядке она успела бы занять место настоящего адреса.
  const hadAddr=!!set('o_address', g.address);
  const idx=document.getElementById('o_index');
  const idxVisible=idx&&!idx.disabled&&idx.closest('.field')&&idx.closest('.field').style.display!=='none';
  if(idxVisible&&g.index){
    idx.value=g.index; idx.style.borderColor='';
    if(typeof kpIndexHint==='function') kpIndexHint(g.index);
  }
  // Город — только у курьерской доставки и только в пустое поле: тип доставки мы не трогаем,
  // а выбранный руками город не перебиваем.
  const city=document.getElementById('o_city');
  const dl=document.getElementById('o_delivery');
  if(city&&!city.disabled&&!city.value&&g.courier_city_id&&dl&&isCourierDelivery(dl.value)
     &&[...city.options].some(o=>o.value===g.courier_city_id)){
    city.value=g.courier_city_id;
    city.dispatchEvent(new Event('change',{bubbles:true}));   // подтянет список курьеров города
  }
  // Запоминаем, что подставили: иначе своя же подстановка телефона тут же вызвала бы
  // подсказку заново — про того самого человека.
  if(ocsCtx){ ocsCtx.appliedPhone=g.phone||''; ocsCtx.appliedName=ocsNorm(g.client); }
  ocsHide();
  // захват заказа в «Заполнении» продлевается по событию из карточки
  const cl=document.getElementById('o_client');
  if(cl) cl.dispatchEvent(new Event('change',{bubbles:true}));
  toast('Подставлено: '+['ФИО',g.phone?'телефон':'',hadAddr?'адрес':'',(idxVisible&&g.index)?'индекс':''].filter(Boolean).join(', ')+'. Проверьте по бланку.',3500);
}

async function ocsLookup(kind){
  const ctx=ocsCtx; if(!ctx) return;
  const fieldId=kind==='phone'?'o_phone':'o_client';
  const el=document.getElementById(fieldId); if(!el) return;
  let value;
  if(kind==='phone'){
    value=ocsDigits(el.dataset.phone||el.value);
    if(!value){ ocsHide(); return; }                     // номер ещё не дописан
    if(value===ctx.appliedPhone) return;                 // это мы сами его и подставили
  }else{
    value=String(el.value||'').replace(/\s+/g,' ').trim();
    if(value.replace(/\s/g,'').length<OCS_NAME_MIN){ ocsHide(); return; }
    if(ocsNorm(value)===ctx.appliedName) return;
  }
  const seq=++ocsSeq;
  let rows;
  try{ rows=await ocsQuery(kind,value,ctx.bar); }
  catch(e){ return; }                                    // подсказка необязательна — не шумим
  // Пока шёл запрос, человек печатал дальше или закрыл карточку: такой ответ уже не нужен.
  if(seq!==ocsSeq||ocsCtx!==ctx||!document.body.contains(el)) return;
  const groups=ocsGroup(rows,ctx.selfId);
  ocsRender(fieldId,groups.slice(0,OCS_SHOW),groups.length);
}

// Запуск «прямо сейчас» — для распознавания с фото: оно вписывает телефон кодом, без нажатий.
function ocsTrigger(kind){ clearTimeout(ocsTimer); ocsLookup(kind||'phone'); }

// Подключение к открытой карточке. Зовётся из orderModal; у карточки на просмотр не нужна.
function ocsAttach(o, bar, ro){
  ocsCtx=null; clearTimeout(ocsTimer); ocsSeq++;
  if(ro) return;
  const cl=document.getElementById('o_client'), ph=document.getElementById('o_phone');
  if(!cl&&!ph) return;
  const ctx={selfId:o&&o.id||null,bar:!!bar,appliedPhone:'',appliedName:'',groups:[]};
  ocsCtx=ctx;
  const later=kind=>{ clearTimeout(ocsTimer); ocsTimer=setTimeout(()=>{ if(ocsCtx===ctx) ocsLookup(kind); },OCS_WAIT_MS); };
  if(cl) cl.addEventListener('input',()=>later('name'));
  if(ph) ph.addEventListener('input',()=>later('phone'));
  // Один слушатель на окно карточки: строки подсказки перерисовываются, а окно живёт.
  const modal=(cl||ph).closest('.modal');
  if(modal) modal.addEventListener('click',e=>{
    const pick=e.target.closest('[data-ocspick]');
    if(pick&&ocsCtx===ctx){ const g=ctx.groups[parseInt(pick.dataset.ocspick,10)]; if(g) ocsApply(g); return; }
    if(e.target.closest('[data-ocsclose]')) ocsHide();
  });
}
