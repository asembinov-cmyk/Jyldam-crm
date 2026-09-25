// ============================================================
//  БЛАНКИ КАЗПОЧТЫ, ВЫПУЩЕННЫЕ ЗАРАНЕЕ (пул номеров)
//
//  Партнёру отдают готовый бланк со штрих-кодом, а получателя он вписывает от руки.
//  Трек Казпочта выдаёт только на номер отправления, поэтому номера выпускаются
//  заранее и лежат в отдельной таблице `track_pool` (db/17) — НЕ в `orders`:
//  десять тысяч пустышек среди заказов сломали бы делитель фондов в Калькуляции,
//  очередь «Заполнения», «Сортировку», дашборд и ежедневный отчёт.
//
//  Партия — «ИП + сумма + количество». Сумма уходит в наложенный платёж и печатается
//  на бланке, а изменить её потом нечем: повторный запрос с тем же номером новый ШПИ
//  не выдаёт, Казпочта возвращает прежний с кодом 20012.
//
//  Заказ садится на номер позже — при загрузке реестра из Excel, по совпадению трека.
//
//  Живёт вкладкой в «Настройках» («Бланки заранее»), а не отдельным пунктом меню:
//  пользуются им редко и только свои, а меню и без того длинное. Отсюда и права —
//  общие с настройками (canEditDir), они же в правилах базы у db/17.
// ============================================================

let blanksBatchOpen=null;   // id открытой партии
let blanksBusy=false;       // идёт получение треков — второй раз не запускаем

const blanksReady=()=>Array.isArray(S.trackBatches);

async function loadBlanks(){
  try{
    const [b,p]=await Promise.all([
      dbList('track_batches',{order:'created_at',asc:false}),
      dbList('track_pool',{order:'id'}),
    ]);
    S.trackBatches=b||[];S.trackPool=p||[];
    return true;
  }catch(e){
    console.error('track_pool',e);
    S.trackBatches=null;S.trackPool=null;
    return false;
  }
}

// Строки одной партии
const blanksRows=batchId=>(S.trackPool||[]).filter(r=>r.batch_id===batchId);
// Состояние номера одним словом — им же красится строка
function blankState(r){
  if(r.order_id)return 'used';
  if(r.error&&!r.track)return 'error';
  if(!r.track)return 'wait';
  if(r.issued_at)return 'issued';
  return 'ready';
}
const BLANK_STATE_LABEL={wait:'нет трека',error:'ошибка',ready:'готов',issued:'у партнёра',used:'использован'};

// Сводка по партии — по ней же считаются колонки списка
function blanksStat(batchId){
  const rows=blanksRows(batchId);
  const s={all:rows.length,tracked:0,issued:0,used:0,error:0};
  rows.forEach(r=>{
    if(r.track)s.tracked++;
    if(r.issued_at)s.issued++;
    if(r.order_id)s.used++;
    if(r.error&&!r.track)s.error++;
  });
  return s;
}

// НОМЕРА. Совпадение с кодом существующего заказа недопустимо: Казпочта на повторный
// OrderNum возвращает ЧУЖОЙ, уже выданный ШПИ — и у двух посылок окажется один трек.
// Поэтому проверяем сразу по двум источникам и берём коды из базы, а не из памяти
// вкладки: там после входа лежат только сегодняшние заказы.
async function blanksTakenCodes(){
  const taken=new Set();
  try{
    const rows=await dbList('orders',{select:'code'});
    (rows||[]).forEach(r=>{if(r.code)taken.add(String(r.code));});
  }catch(e){console.error('codes orders',e);return null;}
  try{
    const rows=await dbList('track_pool',{select:'code'});
    (rows||[]).forEach(r=>{if(r.code)taken.add(String(r.code));});
  }catch(e){console.error('codes pool',e);return null;}
  return taken;
}
function blanksNewCodes(taken,qty){
  const out=[];
  while(out.length<qty){
    const c=String(Math.floor(1000000+Math.random()*9000000));
    if(taken.has(c))continue;
    taken.add(c);out.push(c);
  }
  return out;
}

// ── СПИСОК ПАРТИЙ ──
function renderBlanks(){
  if(!blanksReady()){
    $('dirContent').innerHTML=`<div class="panel"><div class="loading">Загружаю…</div></div>`;
    loadBlanks().then(okLoad=>{
      if(!okLoad){
        $('dirContent').innerHTML=`<div class="panel"><div class="panel-head"><h2>Бланки заранее</h2></div>
          <p class="hint" style="padding:0 16px 18px">Раздел ещё не включён: нет таблиц <code>track_batches</code>
          и <code>track_pool</code>. Выполните <code>db/17</code> и обновите страницу.</p></div>`;
        return;
      }
      if(S.dir==='blanks')renderBlanks();
    });
    return;
  }
  if(blanksBatchOpen){renderBlanksBatch(blanksBatchOpen);return;}
  const ipName=id=>{const x=(S.post_ips||[]).find(p=>p.id===id);return x?x.name:'—';};
  const partnerName=id=>{const x=(S.partners||[]).find(p=>p.id===id);return x?x.name:'';};
  const rows=(S.trackBatches||[]).map(b=>{
    const st=blanksStat(b.id);
    return `<tr data-batch="${b.id}" style="cursor:pointer">
      <td data-label="Партия">№${b.id}<small class="cell-time">${esc(String(b.created_at||'').slice(0,10))}</small></td>
      <td data-label="ИП">${esc(ipName(b.post_ip_id))}</td>
      <td data-label="Номинал">${Math.round(b.amount||0).toLocaleString('ru-RU')} ₸</td>
      <td data-label="Бланков">${st.all}</td>
      <td data-label="С треком">${st.tracked}${st.error?` <span style="color:var(--rust)">· ${st.error} с ошибкой</span>`:''}</td>
      <td data-label="Отдано">${st.issued?`${st.issued}${b.partner_id?' · '+esc(partnerName(b.partner_id)):''}`:'—'}</td>
      <td data-label="Использовано">${st.used}</td>
    </tr>`;
  }).join('');
  $('dirContent').innerHTML=`
    <div class="panel">
      <div class="panel-head"><h2>Бланки, выпущенные заранее</h2>
        ${canEditDir()?`<button class="btn primary" id="blNew">＋ Новая партия</button>`:''}</div>
      <div style="padding:4px 16px 18px">
        <p class="hint" style="margin-bottom:14px">Номера выпускаются заранее, чтобы раздать партнёрам готовые бланки.
          Заказ садится на номер сам — при загрузке реестра из Excel, по совпадению трека.
          Сумма партии печатается на бланке и уходит наложенным платежом; изменить её потом нельзя.</p>
        ${rows?`<div class="table-scroll"><table class="resp-table"><thead><tr>
          <th>Партия</th><th>ИП</th><th>Номинал</th><th>Бланков</th><th>С треком</th><th>Отдано</th><th>Использовано</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`:'<p class="hint">Партий пока нет.</p>'}
      </div>
    </div>`;
  if($('blNew'))$('blNew').onclick=blanksNewBatchModal;
  document.querySelectorAll('[data-batch]').forEach(tr=>tr.onclick=()=>{blanksBatchOpen=parseInt(tr.dataset.batch,10);renderBlanks();});
}

// ── НОВАЯ ПАРТИЯ ──
function blanksNewBatchModal(){
  showModal('Новая партия бланков',`
    <div class="form-grid">
      <div class="field"><label>ИП для Почты <span style="color:var(--rust)">*</span></label>
        <select id="bl_ip"><option value="">—</option>${(S.post_ips||[]).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
        <span class="hint">Его реквизиты печатаются на бланке.</span></div>
      <div class="field"><label>Сумма заказа (₸) <span style="color:var(--rust)">*</span></label>
        <input type="number" min="0" id="bl_amount" placeholder="1500">
        <span class="hint">Она же наложенный платёж. Печатается на бланке прописью и потом не меняется.</span></div>
      <div class="field"><label>Сколько бланков <span style="color:var(--rust)">*</span></label>
        <input type="number" min="1" max="5000" id="bl_qty" placeholder="100">
        <span class="hint">Не больше 5000 за партию. Треки запрашиваются отдельно, после создания.</span></div>
      <div class="field"><label>Партнёр (кому отдадим)</label>
        <select id="bl_partner"><option value="">— можно позже</option>${(S.partners||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field full"><label>Заметка</label><input id="bl_note" placeholder="например: для реестра, выдано 26.09"></div>
    </div>`,
    async()=>{
      const ip=val('bl_ip'),amount=parseFloat(val('bl_amount')),qty=parseInt(val('bl_qty'),10);
      if(!ip){toast('Выберите ИП');return false;}
      if(!(amount>0)){toast('Укажите сумму — она печатается на бланке');return false;}
      if(!(qty>0&&qty<=5000)){toast('Количество — от 1 до 5000');return false;}
      toast('Готовлю номера…');
      const taken=await blanksTakenCodes();
      if(!taken){toast('Не удалось прочитать занятые номера — попробуйте ещё раз');return false;}
      const batch=await dbInsert('track_batches',{post_ip_id:ip,amount,qty,
        partner_id:val('bl_partner')||null,note:val('bl_note').trim()||null,
        created_by:(S.me&&S.me.full_name)||null});
      if(!batch){toast('Не удалось создать партию');return false;}
      const codes=blanksNewCodes(taken,qty);
      const rows=codes.map(c=>({batch_id:batch.id,code:c,amount,post_ip_id:ip,
        partner_id:val('bl_partner')||null}));
      const CHUNK=200;let made=0;
      for(let i=0;i<rows.length;i+=CHUNK){
        const {data,error}=await sb.from('track_pool').insert(rows.slice(i,i+CHUNK)).select();
        if(error){console.error('insert track_pool',error);toast('Ошибка при создании номеров: '+error.message);break;}
        if(data){made+=data.length;}
      }
      await loadBlanks();
      blanksBatchOpen=batch.id;
      toast(made===qty?`Партия создана: ${made} номеров`:`Создано ${made} из ${qty} номеров`);
      renderBlanks();
      return true;
    });
}

// ── КАРТОЧКА ПАРТИИ ──
function renderBlanksBatch(id){
  const b=(S.trackBatches||[]).find(x=>x.id===id);
  if(!b){blanksBatchOpen=null;renderBlanks();return;}
  const st=blanksStat(id);
  const rows=blanksRows(id);
  const ip=(S.post_ips||[]).find(p=>p.id===b.post_ip_id);
  const partner=(S.partners||[]).find(p=>p.id===b.partner_id);
  const COLOR={wait:'',error:'background:#fdeceb',ready:'background:#eaf6ec',issued:'background:#eef3fb',used:'background:#f3f0fa'};
  const list=rows.slice(0,500).map(r=>{
    const s=blankState(r);
    return `<tr class="open" style="${COLOR[s]||''}">
      <td data-label="Номер">${esc(r.code)}</td>
      <td data-label="Трек">${r.track?esc(r.track):'<span class="muted">—</span>'}</td>
      <td data-label="Состояние">${BLANK_STATE_LABEL[s]}${r.error&&!r.track?`<small class="cell-time">${esc(String(r.error).slice(0,120))}</small>`:''}</td>
      <td data-label="Заказ">${r.order_id?esc(blanksOrderCode(r.order_id)):'—'}</td>
    </tr>`;
  }).join('');
  $('dirContent').innerHTML=`
    <div class="panel">
      <div class="panel-head"><h2>Партия №${b.id}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn ghost" id="blBack">‹ К списку</button>
          ${st.tracked<st.all&&canEditDir()?`<button class="btn primary" id="blGetTracks">📮 Получить треки (${st.all-st.tracked})</button>`:''}
          ${st.tracked?`<button class="btn" id="blPrintLabel">🖨 Печать 100×150</button>`:''}
          ${st.tracked?`<button class="btn ghost" id="blPrintA4">A4</button>`:''}
          ${st.tracked&&!b.partner_id&&canEditDir()?`<button class="btn ghost" id="blIssue">Отдать партнёру</button>`:''}
        </div>
      </div>
      <div style="padding:4px 16px 18px">
      <div class="calc-totals">
        <div class="ct-card"><div class="ct-k">ИП</div><div class="ct-v" style="font-size:16px">${esc(ip?ip.name:'—')}</div></div>
        <div class="ct-card"><div class="ct-k">Номинал</div><div class="ct-v">${Math.round(b.amount||0).toLocaleString('ru-RU')} ₸</div></div>
        <div class="ct-card"><div class="ct-k">Бланков</div><div class="ct-v">${st.all}</div></div>
        <div class="ct-card"><div class="ct-k">С треком</div><div class="ct-v">${st.tracked}</div></div>
        <div class="ct-card"><div class="ct-k">Использовано</div><div class="ct-v">${st.used}</div></div>
      </div>
      ${partner?`<p class="calc-note">Отдано партнёру: <b>${esc(partner.name)}</b>${b.note?' · '+esc(b.note):''}</p>`
        :(b.note?`<p class="calc-note">${esc(b.note)}</p>`:'')}
      ${st.error?`<p class="calc-note" style="color:var(--rust)">${st.error} номеров без трека с ошибкой — нажмите «Получить треки» ещё раз, попытка повторится только для них.</p>`:''}
      <div id="blProgress"></div>
      <div class="table-scroll"><table class="resp-table"><thead><tr>
        <th>Номер</th><th>Трек</th><th>Состояние</th><th>Заказ</th>
      </tr></thead><tbody>${list}</tbody></table></div>
      ${rows.length>500?`<p class="hint">Показаны первые 500 из ${rows.length}.</p>`:''}
      </div>
    </div>`;
  $('blBack').onclick=()=>{blanksBatchOpen=null;renderBlanks();};
  if($('blGetTracks'))$('blGetTracks').onclick=()=>blanksGetTracks(id);
  if($('blPrintA4'))$('blPrintA4').onclick=()=>blanksPrint(id,'a4');
  if($('blPrintLabel'))$('blPrintLabel').onclick=()=>blanksPrint(id,'label');
  if($('blIssue'))$('blIssue').onclick=()=>blanksIssueModal(id);
}
function blanksOrderCode(orderId){
  const o=(S.orders||[]).find(x=>x.id===orderId);
  return o?o.code:'есть';
}

// ── ПОЛУЧЕНИЕ ТРЕКОВ ──
// Идём пачками, каждая пачка сохраняется сразу. Прервались или закрыли вкладку —
// повтор продолжит с того места: берём только строки без трека.
async function blanksGetTracks(batchId){
  if(blanksBusy){toast('Уже идёт получение треков');return;}
  const todo=blanksRows(batchId).filter(r=>!r.track);
  if(!todo.length){toast('Треки уже есть у всех');return;}
  if(!confirm(`Запросить у Казпочты ${todo.length} номеров?\n\nКаждый номер тратится из диапазона договора и вернуть его нельзя.`))return;
  blanksBusy=true;
  const box=$('blProgress');
  const CHUNK=25;
  let done=0,failed=0;
  for(let i=0;i<todo.length;i+=CHUNK){
    const part=todo.slice(i,i+CHUNK);
    if(box)box.innerHTML=`<p class="calc-note">Запрашиваю треки: ${done} из ${todo.length}${failed?` · ошибок ${failed}`:''}…</p>`;
    let res;
    try{res=await callKazpostGetBarcodeBatch(part.map(r=>r.id),'pool');}
    catch(e){res={success:false,error:String(e&&e.message||e)};}
    if(!res||!res.success){
      if(box)box.innerHTML=`<p class="calc-note" style="color:var(--rust)">Остановились: ${esc(String((res&&res.error)||'нет ответа'))}</p>`;
      break;
    }
    (res.results||[]).forEach(x=>{if(x.success)done++;else failed++;});
  }
  blanksBusy=false;
  await loadBlanks();
  toast(failed?`Получено ${done}, не вышло ${failed}`:`Получено треков: ${done}`);
  renderBlanks();
}

// ── ВЫДАЧА ПАРТНЁРУ ──
function blanksIssueModal(batchId){
  showModal('Отдать партию партнёру',`
    <div class="form-grid">
      <div class="field full"><label>Партнёр <span style="color:var(--rust)">*</span></label>
        <select id="bl_ip2"><option value="">—</option>${(S.partners||[]).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <span class="hint">Отметка нужна, чтобы потом было видно, чьи это бланки. На расчёт она не влияет.</span></div>
    </div>`,
    async()=>{
      const pid=val('bl_ip2');
      if(!pid){toast('Выберите партнёра');return false;}
      const now=new Date().toISOString();
      const {error}=await sb.from('track_pool').update({partner_id:pid,issued_at:now})
        .eq('batch_id',batchId).is('order_id',null);
      if(error){toast('Не удалось отметить выдачу: '+error.message);return false;}
      await dbUpdate('track_batches',batchId,{partner_id:pid});
      await loadBlanks();
      toast('Отмечено');renderBlanks();
      return true;
    });
}

// ── ПЕЧАТЬ ──
// Печатаем тем же бланком, что и обычные заказы: подсовываем «заказ», которого ещё нет —
// с кодом, треком, ИП и суммой партии. Получатель пуст, его впишет партнёр.
async function blanksPrint(batchId,fmt){
  const rows=blanksRows(batchId).filter(r=>r.track);
  if(!rows.length){toast('Сначала получите треки');return;}
  const b=(S.trackBatches||[]).find(x=>x.id===batchId)||{};
  const fake=rows.map(r=>({
    id:'pool-'+r.id,code:r.code,track:r.track,post_ip_id:r.post_ip_id||b.post_ip_id,
    order_sum:r.amount!=null?r.amount:b.amount,cost:r.amount!=null?r.amount:b.amount,
    client:'',address:'',phone:'',index:'',city_id:null,delivery_id:null,weight:null,
  }));
  toast(`Готовлю ${fake.length} бланков…`);
  await printMailLabelsPdf(fake,fmt);
  const now=new Date().toISOString();
  await sb.from('track_pool').update({printed_at:now}).in('id',rows.map(r=>r.id));
  await loadBlanks();
}
