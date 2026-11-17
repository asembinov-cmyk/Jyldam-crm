/* ================= МОДУЛЬ: ТЕЛЕФОНИЯ =================
   Экран к таблицам db/64: журнал звонков, «перезвонить», операторы и чёрный список.

   ЗВОНКИ ЗДЕСЬ ТОЛЬКО ЧИТАЮТСЯ. Пишет их мост на сервере АТС сервисным ключом, правил на
   запись у tel_calls нет намеренно (раздел 15 в CLAUDE.md). Поэтому, пока сервер не
   подключён, журнал пуст — и экран обязан сказать это прямо, а не выглядеть сломанным.

   ПАРОЛЕЙ ВНУТРЕННИХ НОМЕРОВ ТУТ НЕТ И БЫТЬ НЕ ДОЛЖНО: в базе лежит только номер (101),
   пароль к нему живёт на сервере. Фронтенд публичный.

   ФИЛЬТРАЦИЯ И СТРАНИЦЫ — В БАЗЕ, а не в браузере: звонков будет много, и тянуть журнал
   целиком ради полусотни строк на экране — та же ошибка, что была с заказами KET. */

const TEL_PER_PAGE = 50;
const TEL_CALL_COLS = 'id,direction,from_number,to_number,phone10,did,queue,operator_name,order_code,'
  + 'caller_kind,caller_name,status,started_at,answered_at,ended_at,wait_sec,talk_sec,recording_path,result_code,comment';

const TEL_DIR_RU    = {in:'входящий', out:'исходящий', robot:'робот'};
const TEL_STATUS_RU = {ringing:['звонит','#2563eb'], answered:['отвечен','#16a34a'], missed:['пропущен','#dc2626'],
  abandoned:['не дождался','#dc2626'], busy:['занято','#b45309'], failed:['не прошёл','#6b7280'],
  voicemail:['голосовая почта','#b45309']};
const TEL_KIND_RU   = {client:'клиент', partner:'партнёр', courier:'курьер', staff:'сотрудник',
  unknown:'неизвестный', blacklist:'чёрный список'};
const TEL_OP_RU     = {online:['на линии','#16a34a'], talking:['разговаривает','#2563eb'], wrapup:['оформляет','#b45309'],
  break:['перерыв','#b45309'], outbound:['звонит сам','#2563eb'], offline:['не в сети','#6b7280']};
// «Пропущенный» для человека — это и «не ответили», и «не дождался в очереди».
const TEL_MISSED = ['missed','abandoned'];

let telSub='calls';        // calls | callbacks | operators | black
let telCalls=null;         // строки текущей страницы (null — ещё не грузили)
let telCallsErr='';
let telTotal=0;
let telPage=1;
let telF=null;             // фильтры журнала; создаются ЛЕНИВО, см. telFilters()
let telStats=null;         // счётчики за сегодня
let telCbs=null, telCbsErr='';
let telOps=null, telOpsErr='';
let telBlack=null, telBlackErr='';
let telBusy=false;
/* Идущие загрузки. Экран перерисовывается по готовности КАЖДОЙ из них, и без этой отметки
   перерисовка, пришедшая от первой, заново запускала бы остальные, ещё не успевшие
   ответить, — по три одинаковых запроса на заход в раздел. */
const telLoading={};
function telOnce(key,fn){
  if(telLoading[key])return telLoading[key];
  telLoading[key]=Promise.resolve().then(fn).catch(()=>{}).then(()=>{delete telLoading[key];});
  return telLoading[key];
}

/* Даты по умолчанию считаем при первом обращении, а не при загрузке файла: localToday()
   объявлена в js/10, и вызов на верхнем уровне этого файла сработал бы только потому, что
   он подключён позже. Не полагаемся на порядок — на этом уже обжигались (раздел 9, п. 2). */
function telFilters(){
  if(!telF){const t=localToday();telF={from:t,to:t,dir:'',status:'',q:''};}
  return telF;
}

// Границы местного дня в виде отметок по Гринвичу: started_at в базе лежит по UTC, а
// человек выбирает день по Астане (раздел 8яо).
function telDayStart(d){return new Date(d+'T00:00:00').toISOString();}
function telDayEnd(d){return new Date(d+'T23:59:59.999').toISOString();}

function telErr(e,what){
  const s=String(e&&(e.message||e.code)||e);
  if(/42P01|does not exist|schema cache/i.test(s)&&/tel_/i.test(s))
    return 'Таблиц телефонии в базе нет — выполните db/64';
  if(/42501|row-level security|permission denied/i.test(s))
    return 'Нет прав на это действие — право выдаётся в «Сотрудники» → «Роли и права», столбец «Телефония»';
  if(/23505|duplicate key/i.test(s))
    return what==='op' ? 'Такой внутренний номер уже занят или сотрудник уже оператор'
                       : 'Этот номер уже есть в списке';
  return 'Не удалось '+(what==='save'||what==='op'?'сохранить':'прочитать')+': '+s;
}

function telSec(n){
  n=parseInt(n,10);
  if(!(n>=0))return '—';
  return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
}
function telPhone(p10,raw){
  const d=String(p10||'').replace(/\D/g,'');
  if(d.length===10)return phoneDisplay('7'+d);
  return raw?String(raw):'—';
}
function telMe(){return (S.me&&(S.me.full_name||S.me.email))||'—';}
function telCanEdit(){return isAdmin()||can('telephony','edit');}

/* ---------- Загрузка ---------- */

async function telCallsLoad(){
  const f=telFilters();
  telCallsErr='';
  try{
    let q=sb.from('tel_calls').select(TEL_CALL_COLS,{count:'exact'}).order('started_at',{ascending:false});
    if(f.from)q=q.gte('started_at',telDayStart(f.from));
    if(f.to)q=q.lte('started_at',telDayEnd(f.to));
    if(f.dir)q=q.eq('direction',f.dir);
    if(f.status==='missed')q=q.in('status',TEL_MISSED);
    else if(f.status)q=q.eq('status',f.status);
    const raw=String(f.q||'').trim();
    if(raw){
      /* Поиск по телефону добавляем, ТОЛЬКО если в запросе есть цифры: пустая строка после
         удаления нецифровых символов — подстрока чего угодно, и поиск по имени показывал бы
         всё подряд (те же грабли, что в «Сортировке», раздел 6). */
      const digits=raw.replace(/\D/g,'');
      // запятые и скобки ломают выражение or(...) у PostgREST — убираем их из текста
      const txt=raw.replace(/[,()%*\\]/g,' ').trim();
      const parts=[];
      if(digits.length>=3)parts.push('phone10.ilike.*'+digits.slice(-10)+'*');
      if(digits.length>=3)parts.push('order_code.ilike.*'+digits+'*');
      if(txt&&/[^\d\s+\-]/.test(txt)){
        parts.push('caller_name.ilike.*'+txt+'*');
        parts.push('operator_name.ilike.*'+txt+'*');
      }
      if(parts.length)q=q.or(parts.join(','));
    }
    const from=(telPage-1)*TEL_PER_PAGE;
    const {data,error,count}=await q.range(from,from+TEL_PER_PAGE-1);
    if(error)throw error;
    telCalls=data||[];
    telTotal=count||0;
  }catch(e){
    telCalls=[];telTotal=0;telCallsErr=telErr(e);
  }
}

// Счётчики за СЕГОДНЯ — запросами head:true, ни одной строки данных.
async function telStatsLoad(){
  const t=localToday(), a=telDayStart(t), b=telDayEnd(t);
  const cnt=async mod=>{
    let q=sb.from('tel_calls').select('id',{count:'exact',head:true}).gte('started_at',a).lte('started_at',b);
    q=mod(q);
    const {count,error}=await q;
    if(error)throw error;
    return count||0;
  };
  try{
    const [all,missed,inc,out,robot]=await Promise.all([
      cnt(q=>q),
      cnt(q=>q.in('status',TEL_MISSED)),
      cnt(q=>q.eq('direction','in')),
      cnt(q=>q.eq('direction','out')),
      cnt(q=>q.eq('direction','robot')),
    ]);
    telStats={all,missed,inc,out,robot};
  }catch(e){telStats=null;}
}

async function telCbsLoad(){
  telCbsErr='';
  try{
    const {data,error}=await sb.from('tel_callbacks')
      .select('id,phone10,caller_name,due_at,status,created_at').eq('status','open')
      .order('due_at',{ascending:true}).limit(200);
    if(error)throw error;
    telCbs=data||[];
  }catch(e){telCbs=[];telCbsErr=telErr(e);}
}

async function telOpsLoad(){
  telOpsErr='';
  try{
    const {data,error}=await sb.from('tel_operators')
      .select('user_id,extension,queues,status,status_changed_at,webrtc_enabled').order('extension',{ascending:true});
    if(error)throw error;
    telOps=data||[];
  }catch(e){telOps=[];telOpsErr=telErr(e);}
}

async function telBlackLoad(){
  telBlackErr='';
  try{
    const {data,error}=await sb.from('tel_blacklist')
      .select('phone10,reason,created_by_name,created_at').order('created_at',{ascending:false}).limit(500);
    if(error)throw error;
    telBlack=data||[];
  }catch(e){telBlack=[];telBlackErr=telErr(e);}
}

/* ---------- Журнал звонков ---------- */

function telCallsHtml(){
  const f=telFilters();
  const today=localToday();
  const isToday=f.from===today&&f.to===today;
  const isYest=f.from===localDaysAgo(1)&&f.to===localDaysAgo(1);
  const filters=`<div class="filters" style="margin:0 20px 12px">
      <input type="search" id="telQ" placeholder="Телефон, имя, № заказа, оператор" value="${esc(f.q)}" style="min-width:230px">
      <input type="date" id="telFrom" value="${esc(f.from)}" max="${esc(today)}">
      <input type="date" id="telTo" value="${esc(f.to)}" max="${esc(today)}">
      <button class="btn ghost${isToday?' active':''}" id="telToday" type="button">Сегодня</button>
      <button class="btn ghost${isYest?' active':''}" id="telYest" type="button">Вчера</button>
      <select id="telDir">
        <option value="">Все направления</option>
        ${Object.keys(TEL_DIR_RU).map(k=>`<option value="${k}"${f.dir===k?' selected':''}>${esc(TEL_DIR_RU[k])}</option>`).join('')}
      </select>
      <select id="telStatus">
        <option value="">Все исходы</option>
        <option value="missed"${f.status==='missed'?' selected':''}>пропущенные</option>
        <option value="answered"${f.status==='answered'?' selected':''}>отвеченные</option>
        <option value="busy"${f.status==='busy'?' selected':''}>занято</option>
        <option value="failed"${f.status==='failed'?' selected':''}>не прошёл</option>
      </select>
      <button class="btn ghost" id="telReset" type="button">Сбросить</button>
    </div>`;
  return filters+`<div id="telCallsBox">${telCallsTableHtml()}</div>`;
}

function telCallsTableHtml(){
  if(telCalls===null)return '<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  if(telCallsErr)return `<div class="hint" style="margin:0 20px 14px;color:var(--rust)">${esc(telCallsErr)}</div>`;
  const f=telFilters();
  if(!telCalls.length){
    const filtered=!!(f.dir||f.status||String(f.q||'').trim());
    /* Пусто бывает по трём причинам, и со стороны они неотличимы: всё скрыто фильтрами, за
       эти дни звонков не было, или АТС ещё не подключена и звонков не было НИКОГДА. Третье
       узнаём по счётчику «за сегодня» и по тому, что фильтров нет. */
    return `<div class="empty" style="margin:0 20px 18px">
      <div class="big">${filtered?'По этим фильтрам звонков нет':'Звонков за эти дни нет'}</div>
      ${filtered?'Снимите фильтры кнопкой «Сбросить» или расширьте даты.'
        :'Звонки сюда записывает сервер телефонии. Пока он не подключён, журнал остаётся пустым — это не поломка.'}
    </div>`;
  }
  const pages=Math.max(1,Math.ceil(telTotal/TEL_PER_PAGE));
  const rows=telCalls.map(c=>{
    const st=TEL_STATUS_RU[c.status]||[c.status||'—','#6b7280'];
    const t=fmtLogTime(c.started_at)||{};
    const kind=TEL_KIND_RU[c.caller_kind]||'';
    const who=c.caller_name?esc(c.caller_name):(kind?`<span class="hint" style="margin:0">${esc(kind)}</span>`:'—');
    const p10=String(c.phone10||'').replace(/\D/g,'');
    const tel=p10.length===10
      ? `<a href="tel:+7${esc(p10)}">${esc(telPhone(p10))}</a>${copyBtn('+7'+p10,'Скопировать номер')}`
      : esc(telPhone('',c.direction==='in'?c.from_number:c.to_number));
    return `<tr>
      <td data-label="Когда">${esc((t.date||'')+' '+(t.time||''))}</td>
      <td data-label="Направление">${esc(TEL_DIR_RU[c.direction]||c.direction||'—')}</td>
      <td data-label="Номер">${tel}</td>
      <td data-label="Кто">${who}${c.caller_name&&kind?`<div class="hint" style="margin:2px 0 0">${esc(kind)}</div>`:''}</td>
      <td data-label="Заказ">${c.order_code?esc(c.order_code)+copyBtn(c.order_code):'—'}</td>
      <td data-label="Оператор">${esc(c.operator_name||(c.queue?'очередь '+c.queue:'—'))}</td>
      <td data-label="Исход"><span style="color:${st[1]}">${esc(st[0])}</span>${c.result_code?`<div class="hint" style="margin:2px 0 0">${esc(c.result_code)}</div>`:''}</td>
      <td data-label="Ждал">${esc(telSec(c.wait_sec))}</td>
      <td data-label="Разговор">${esc(telSec(c.talk_sec))}</td>
      <td data-label="Запись">${c.recording_path?'есть':'—'}</td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Когда</th><th>Направление</th><th>Номер</th><th>Кто</th><th>Заказ</th><th>Оператор</th>
      <th>Исход</th><th>Ждал</th><th>Разговор</th><th>Запись</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="hist-pager">
      <span class="hint" style="margin:0">Звонков: ${telTotal}</span>
      <span>
        <button class="btn sm ghost" id="telPrev" ${telPage<=1?'disabled':''}>‹ Назад</button>
        <span class="hp-page">Стр. ${telPage} / ${pages}</span>
        <button class="btn sm ghost" id="telNext" ${telPage>=pages?'disabled':''}>Вперёд ›</button>
      </span>
    </div>`;
}

// Перерисовываем ТОЛЬКО таблицу: полная перерисовка уводила бы фокус из поиска на каждой букве.
async function telCallsRedraw(){
  const box=$('telCallsBox');
  if(box)box.innerHTML='<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  await telCallsLoad();
  const box2=$('telCallsBox');
  if(box2&&S.tab==='telephony'&&telSub==='calls'){box2.innerHTML=telCallsTableHtml();telCallsBindPager();}
}
function telCallsBindPager(){
  const pages=Math.max(1,Math.ceil(telTotal/TEL_PER_PAGE));
  if($('telPrev'))$('telPrev').onclick=()=>{if(telPage>1){telPage--;telCallsRedraw();}};
  if($('telNext'))$('telNext').onclick=()=>{if(telPage<pages){telPage++;telCallsRedraw();}};
}
let telQTimer=null;
function telCallsBind(){
  const f=telFilters();
  // Любая правка фильтра возвращает на первую страницу: иначе после сужения выборки человек
  // остаётся на пятой, а строк там уже нет.
  const go=()=>{telPage=1;telCallsRedraw();};
  const full=()=>{telPage=1;telCalls=null;renderTelephony();};
  if($('telQ'))$('telQ').oninput=e=>{f.q=e.target.value;clearTimeout(telQTimer);telQTimer=setTimeout(go,350);};
  if($('telFrom'))$('telFrom').onchange=e=>{f.from=e.target.value;full();};
  if($('telTo'))$('telTo').onchange=e=>{f.to=e.target.value;full();};
  if($('telToday'))$('telToday').onclick=()=>{f.from=f.to=localToday();full();};
  if($('telYest'))$('telYest').onclick=()=>{f.from=f.to=localDaysAgo(1);full();};
  if($('telDir'))$('telDir').onchange=e=>{f.dir=e.target.value;go();};
  if($('telStatus'))$('telStatus').onchange=e=>{f.status=e.target.value;go();};
  if($('telReset'))$('telReset').onclick=()=>{telF=null;full();};
  telCallsBindPager();
}

/* ---------- Перезвонить ---------- */

function telCbsHtml(){
  if(telCbs===null)return '<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  if(telCbsErr)return `<div class="hint" style="margin:0 20px 14px;color:var(--rust)">${esc(telCbsErr)}</div>`;
  if(!telCbs.length)return `<div class="empty" style="margin:0 20px 18px"><div class="big">Перезванивать некому</div>
    Сюда попадают пропущенные звонки и просьбы «перезвоните мне» — их кладёт сервер телефонии.</div>`;
  const now=nowMs();
  const edit=telCanEdit();
  return `<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Перезвонить до</th><th>Номер</th><th>Кто</th><th>Появилось</th><th></th>
    </tr></thead><tbody>${telCbs.map(c=>{
      const late=new Date(c.due_at).getTime()<now;
      const p10=String(c.phone10||'').replace(/\D/g,'');
      return `<tr>
        <td data-label="Перезвонить до"><span style="${late?'color:#dc2626;font-weight:600':''}">${esc(fmtDateTime(c.due_at))}</span>${late?'<div class="hint" style="margin:2px 0 0;color:#dc2626">просрочено</div>':''}</td>
        <td data-label="Номер"><a href="tel:+7${esc(p10)}">${esc(telPhone(p10))}</a>${copyBtn('+7'+p10,'Скопировать номер')}</td>
        <td data-label="Кто">${esc(c.caller_name||'—')}</td>
        <td data-label="Появилось">${esc(fmtDateTime(c.created_at))}</td>
        <td data-label="">${edit?`<button class="btn sm ghost" data-telcb="${esc(String(c.id))}">✓ Перезвонили</button>`:''}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}
function telCbsBind(){
  $('main').querySelectorAll('[data-telcb]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    const {error}=await sb.from('tel_callbacks')
      .update({status:'done',done_at:new Date(nowMs()).toISOString(),done_by_name:telMe()}).eq('id',b.dataset.telcb);
    if(error){b.disabled=false;toast(telErr(error,'save'),5000);return;}
    telCbs=(telCbs||[]).filter(x=>String(x.id)!==b.dataset.telcb);
    renderTelephony();
  });
}

/* ---------- Операторы ---------- */

function telOpsHtml(){
  if(telOps===null)return '<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  if(telOpsErr)return `<div class="hint" style="margin:0 20px 14px;color:var(--rust)">${esc(telOpsErr)}</div>`;
  const admin=isAdmin();
  const head=`<div class="filters" style="margin:0 20px 12px">
      ${admin?'<button class="btn primary" id="telOpAdd" type="button">＋ Добавить оператора</button>':''}
      <span class="hint" style="margin:0">Внутренний номер — это то, чем сотрудник принимает звонки. Пароль к нему в CRM не хранится.</span>
    </div>`;
  if(!telOps.length)return head+`<div class="empty" style="margin:0 20px 18px"><div class="big">Операторов пока нет</div>
    Добавьте сотрудников, которые будут отвечать на звонки, и дайте каждому внутренний номер — по этому списку настраивается сервер.</div>`;
  return head+`<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Внутр. номер</th><th>Сотрудник</th><th>Очереди</th><th>Звонки в браузере</th><th>Сейчас</th><th></th>
    </tr></thead><tbody>${telOps.map(o=>{
      const st=TEL_OP_RU[o.status]||[o.status||'—','#6b7280'];
      return `<tr>
        <td data-label="Внутр. номер"><b>${esc(o.extension)}</b></td>
        <td data-label="Сотрудник">${esc(userNameById(o.user_id))}</td>
        <td data-label="Очереди">${esc((o.queues||[]).join(', ')||'—')}</td>
        <td data-label="Звонки в браузере">${o.webrtc_enabled?'да':'нет'}</td>
        <td data-label="Сейчас"><span style="color:${st[1]}">${esc(st[0])}</span></td>
        <td data-label="">${admin?`<button class="btn sm ghost" data-telop="${esc(o.user_id)}">Изменить</button>`:''}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

// Следующий свободный внутренний номер, начиная со 101: подставляем, чтобы не считать глазами.
function telNextExt(){
  const used=new Set((telOps||[]).map(o=>String(o.extension)));
  for(let n=101;n<200;n++)if(!used.has(String(n)))return String(n);
  return '';
}

function telOpModal(userId){
  const cur=userId?(telOps||[]).find(o=>o.user_id===userId):null;
  const taken=new Set((telOps||[]).map(o=>o.user_id));
  const staff=[...(S.profiles||[])].filter(p=>cur?p.id===cur.user_id:!taken.has(p.id))
    .sort((a,b)=>(a.full_name||a.email||'').localeCompare(b.full_name||b.email||'','ru'));
  if(!cur&&!staff.length){
    toast((S.profiles||[]).length?'Все сотрудники уже добавлены в операторы':'Список сотрудников не загружен — откройте раздел «Сотрудники» и вернитесь',5000);
    return;
  }
  const body=`
    <div class="field"><label>Сотрудник *</label>
      <select id="telOpUser" ${cur?'disabled':''}>
        ${cur?'':'<option value="">— выберите —</option>'}
        ${staff.map(p=>`<option value="${esc(p.id)}"${cur&&cur.user_id===p.id?' selected':''}>${esc(p.full_name||p.email||'—')}</option>`).join('')}
      </select></div>
    <div class="field"><label>Внутренний номер *</label>
      <input id="telOpExt" inputmode="numeric" maxlength="3" value="${esc(cur?cur.extension:telNextExt())}">
      <div class="hint">От 100 до 199, например 101. У каждого сотрудника свой.</div></div>
    <div class="field"><label>Очереди</label>
      <input id="telOpQueues" value="${esc(cur?(cur.queues||[]).join(', '):'')}" placeholder="например: logist, manager">
      <div class="hint">Через запятую. Названия очередей появятся, когда настроим сервер, — пока можно оставить пустым.</div></div>
    <label class="pom-paid" style="margin-top:4px"><input type="checkbox" id="telOpWeb" ${!cur||cur.webrtc_enabled?'checked':''}> Принимает звонки прямо в CRM <span class="pom-paidhint">(в браузере, без отдельного телефона)</span></label>
    ${cur?'<div class="field"><button class="btn ghost" id="telOpDel" type="button" style="color:#dc2626">Убрать из операторов</button></div>':''}`;
  const ov=showModal(cur?'Оператор':'Новый оператор',body,async()=>{
    const uid=cur?cur.user_id:$('telOpUser').value;
    const ext=String($('telOpExt').value||'').trim();
    if(!uid){toast('Выберите сотрудника');return false;}
    // АТС принимает только 100–199: так написан её план набора (_1XX) и проверка в jyldam-ext.
    if(!/^1\d\d$/.test(ext)){toast('Внутренний номер — от 100 до 199');return false;}
    // Проверяем занятость здесь же: отказ базы по уникальности объяснил бы хуже.
    const clash=(telOps||[]).find(o=>String(o.extension)===ext&&o.user_id!==uid);
    if(clash){toast('Номер '+ext+' уже у сотрудника: '+userNameById(clash.user_id),5000);return false;}
    const queues=String($('telOpQueues').value||'').split(',').map(s=>s.trim()).filter(Boolean);
    const row={extension:ext,queues,webrtc_enabled:$('telOpWeb').checked};
    const res=cur
      ? await sb.from('tel_operators').update(row).eq('user_id',uid)
      : await sb.from('tel_operators').insert(Object.assign({user_id:uid},row));
    if(res.error){toast(telErr(res.error,'op'),5000);return false;}
    await telOpsLoad();
    renderTelephony();
    // Добавили в операторы себя — кнопка телефона должна появиться сразу, без перезагрузки.
    if(uid===(S.me&&S.me.id)&&typeof sfBoot==='function')sfBoot();
  });
  const del=ov.querySelector('#telOpDel');
  if(del)del.onclick=async()=>{
    if(!confirm('Убрать '+userNameById(cur.user_id)+' из операторов? Внутренний номер '+cur.extension+' освободится. История его звонков останется.'))return;
    const {error}=await sb.from('tel_operators').delete().eq('user_id',cur.user_id);
    if(error){toast(telErr(error,'op'),5000);return;}
    ov.remove();
    if(typeof syncModalOpenClass==='function')syncModalOpenClass();
    await telOpsLoad();
    renderTelephony();
  };
}
function telOpsBind(){
  if($('telOpAdd'))$('telOpAdd').onclick=()=>telOpModal(null);
  $('main').querySelectorAll('[data-telop]').forEach(b=>b.onclick=()=>telOpModal(b.dataset.telop));
}

/* ---------- Чёрный список ---------- */

function telBlackHtml(){
  if(telBlack===null)return '<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  if(telBlackErr)return `<div class="hint" style="margin:0 20px 14px;color:var(--rust)">${esc(telBlackErr)}</div>`;
  const edit=telCanEdit();
  const head=`<div class="filters" style="margin:0 20px 12px">
      ${edit?'<button class="btn primary" id="telBlAdd" type="button">＋ Добавить номер</button>':''}
      <span class="hint" style="margin:0">Звонки с этих номеров сервер не будет ставить в очередь к операторам.</span>
    </div>`;
  if(!telBlack.length)return head+'<div class="empty" style="margin:0 20px 18px"><div class="big">Список пуст</div></div>';
  return head+`<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Номер</th><th>Причина</th><th>Кто добавил</th><th>Когда</th><th></th>
    </tr></thead><tbody>${telBlack.map(b=>`<tr>
      <td data-label="Номер">${esc(telPhone(b.phone10))}</td>
      <td data-label="Причина">${esc(b.reason||'—')}</td>
      <td data-label="Кто добавил">${esc(b.created_by_name||'—')}</td>
      <td data-label="Когда">${esc(fmtDateTime(b.created_at))}</td>
      <td data-label="">${edit?`<button class="btn sm ghost" data-telbl="${esc(b.phone10)}">Убрать</button>`:''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
function telBlackBind(){
  if($('telBlAdd'))$('telBlAdd').onclick=()=>{
    showModal('Номер в чёрный список',`
      <div class="field"><label>Телефон *</label><input id="telBlPhone" inputmode="tel" placeholder="+7 7XX XXX XX XX"></div>
      <div class="field"><label>Причина</label><input id="telBlReason" maxlength="200" placeholder="например: спам, реклама"></div>`,
    async()=>{
      // Годность номера проверяем строго: цифр должно быть ровно 10 или 11, иначе обрезка
      // дала бы правдоподобный, но чужой номер (тот же довод, что у ketPhoneProblem).
      const d=String($('telBlPhone').value||'').replace(/\D/g,'');
      if(!(d.length===10||(d.length===11&&(d[0]==='7'||d[0]==='8')))){toast('Номер — 10 или 11 цифр');return false;}
      const {error}=await sb.from('tel_blacklist').insert({phone10:d.slice(-10),
        reason:String($('telBlReason').value||'').trim()||null,created_by_name:telMe()});
      if(error){toast(telErr(error,'save'),5000);return false;}
      await telBlackLoad();
      renderTelephony();
    },{saveLabel:'Добавить'});
  };
  $('main').querySelectorAll('[data-telbl]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Убрать '+telPhone(b.dataset.telbl)+' из чёрного списка?'))return;
    b.disabled=true;
    const {error}=await sb.from('tel_blacklist').delete().eq('phone10',b.dataset.telbl);
    if(error){b.disabled=false;toast(telErr(error,'save'),5000);return;}
    telBlack=(telBlack||[]).filter(x=>x.phone10!==b.dataset.telbl);
    renderTelephony();
  });
}

/* ---------- Экран ---------- */

function telBodyHtml(){
  if(telSub==='callbacks')return telCbsHtml();
  if(telSub==='operators')return telOpsHtml();
  if(telSub==='black')return telBlackHtml();
  return telCallsHtml();
}

async function telReload(){
  if(telBusy)return;
  telBusy=true;
  try{
    const jobs=[telStatsLoad(),telCbsLoad()];
    if(telSub==='calls')jobs.push(telCallsLoad());
    if(telSub==='operators')jobs.push(telOpsLoad());
    if(telSub==='black')jobs.push(telBlackLoad());
    await Promise.all(jobs);
  }finally{telBusy=false;}
  if(S.tab==='telephony')renderTelephony();
}

function renderTelephony(){
  if(!canMod('telephony')){
    $('main').innerHTML='<div class="empty"><div class="big">Нет доступа к этому разделу</div>Право выдаётся в «Сотрудники» → «Роли и права», столбец «Телефония».</div>';
    return;
  }
  // Операторов показываем только администратору: имена берутся из списка сотрудников, а он
  // грузится по праву «Сотрудники», и менять внутренние номера в базе может только админ.
  const subs=[['calls','Звонки'],['callbacks','Перезвонить']]
    .concat(isAdmin()?[['operators','Операторы']]:[]).concat([['black','Чёрный список']]);
  if(!subs.some(x=>x[0]===telSub))telSub='calls';
  const st=telStats;
  // «Ждут перезвона» стоит на самой вкладке, а не пятым числом в плашке: пять чисел на
  // телефоне вылезают за край экрана (замерено на 375 px).
  const cbN=telCbs?telCbs.length:null;
  $('main').innerHTML=moduleHead({
      title:'Телефония',
      actions:'<button class="btn ghost" id="telReload" type="button">🔄 Обновить</button>',
      hero:{k:'Звонков сегодня',v:st?st.all:'—'},
      stats:[
        {k:'пропущено',v:st?st.missed:'—'},
        {k:'входящих',v:st?st.inc:'—'},
        {k:'исходящих',v:st?st.out:'—'},
        {k:'звонил робот',v:st?st.robot:'—'},
      ]})+`
    <div class="filters wam-tabs" style="margin-bottom:14px">
      ${subs.map(([k,l])=>`<button class="btn ghost${telSub===k?' active':''}" data-telsub="${k}">${esc(l)}${k==='callbacks'&&cbN?` · ${cbN}`:''}</button>`).join('')}
    </div>
    <div class="panel"><div style="padding-top:16px">${telBodyHtml()}</div></div>`;

  $('main').querySelectorAll('[data-telsub]').forEach(b=>b.onclick=()=>{telSub=b.dataset.telsub;renderTelephony();});
  if($('telReload'))$('telReload').onclick=async()=>{
    const b=$('telReload');b.disabled=true;
    await telReload();
  };
  if(telSub==='calls')telCallsBind();
  else if(telSub==='callbacks')telCbsBind();
  else if(telSub==='operators')telOpsBind();
  else telBlackBind();

  /* Первая загрузка — лениво и только по заходу в раздел: складу и курьерам журнал звонков
     не нужен вовсе, и в общей загрузке при входе ему делать нечего. */
  const after=()=>{if(S.tab==='telephony')renderTelephony();};
  if(telBusy)return;
  // Счётчики не прочитались — ставим прочерки, а не оставляем null: иначе каждая
  // перерисовка спрашивала бы их снова.
  if(telStats===null&&!telLoading.stats)telOnce('stats',telStatsLoad).then(()=>{if(telStats===null)telStats={all:'—',missed:'—',inc:'—',out:'—',robot:'—'};after();});
  if(telCbs===null&&!telLoading.cbs)telOnce('cbs',telCbsLoad).then(after);
  if(telSub==='calls'&&telCalls===null&&!telLoading.calls)telOnce('calls',telCallsLoad).then(after);
  if(telSub==='operators'&&telOps===null&&!telLoading.ops)telOnce('ops',telOpsLoad).then(after);
  if(telSub==='black'&&telBlack===null&&!telLoading.black)telOnce('black',telBlackLoad).then(after);
}
