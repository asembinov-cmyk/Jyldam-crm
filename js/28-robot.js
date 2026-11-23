/* ================= РОБОТ-ОБЗВОН: СЦЕНАРИИ, ОЧЕРЕДЬ, ИТОГИ =================
   Просьба владельца 23.11.2026: «робот, который будет автоматом звонить сам по заказам,
   которым мы дадим соответствующий статус или закинем их в список», а «что будет говорить
   робот — в настройки».

   ЗДЕСЬ ТОЛЬКО НАСТРОЙКА И ПРОСМОТР. Звонит служба на сервере телефонии (ats/robot): берёт
   звонки из tel_robot_jobs, озвучивает текст сценария бесплатным синтезатором, набирает,
   ждёт кнопку и пишет итог. Браузер в этом не участвует — робот работает и тогда, когда CRM
   никто не открывал.

   КАК ЗАКАЗ ПОПАДАЕТ К РОБОТУ — двумя путями:
     · сам, когда получил статус, выбранный в сценарии («автозапуск»), — это делает база;
     · руками: отметили заказы в гриде → «⚙ Действие» → «🤖 Робот-обзвон».

   ПОДСТАНОВКИ {дата} {сумма} {номер}. Числа и даты робот произносит СЛОВАМИ («одна тысяча
   пятьсот», «двадцать четвёртого ноября»). Если в заказе нет того, что стоит в тексте, робот
   не звонит вовсе и пишет причину: фраза с дырой хуже молчания.

   «ПОСЛУШАТЬ» озвучивает текст тем же кодом, что и настоящий звонок (мост → speech.js),
   подставив пример: сумму 1500 и завтрашнюю дату.

   БЕЗ ЛИНИИ ОПЕРАТОРА СВЯЗИ робот наружу не звонит — экран это прямо говорит. */

const ROBOT_LANG={ru:'только русский',kz:'только казахский','ru+kz':'русский, потом казахский','kz+ru':'казахский, потом русский'};
const ROBOT_RESULT={key:'нажал кнопку',nokey:'взял трубку, ничего не нажал',noanswer:'не берёт трубку',busy:'занято',
  error:'сбой',skip:'не звонили'};
const ROBOT_STATUS={pending:'ждёт',calling:'звоним',done:'ответил',failed:'не получилось',cancelled:'отменён'};
const ROBOT_BRIDGE='https://ats.jyldam-crm.kz';
let robotCfg=null,robotScripts=null,robotJobs=null,robotCounts=null,robotErr='';

const robotCanEdit=()=>isAdmin()||can('telephony','edit');
const robotCanQueue=()=>isStaff()&&(isAdmin()||can('telephony','create')||can('telephony','edit'));
function robotPhone10(v){
  const d=String(v||'').replace(/\D/g,'');
  if(d.length===10)return d;
  if(d.length===11&&(d[0]==='7'||d[0]==='8'))return d.slice(1);
  return '';                                   // длиннее — номер с добавочным, не набираем
}
const robotStatusName=id=>{const s=(S.order_statuses||[]).find(x=>x.id===id);return s?s.name:'';};
function robotStatusOpts(sel,emptyLabel){
  return `<option value="">${esc(emptyLabel)}</option>`+(S.order_statuses||[]).slice()
    .sort((a,b)=>(a.name||'').localeCompare(b.name||'','ru'))
    .map(s=>`<option value="${s.id}" ${s.id===sel?'selected':''}>${esc(s.name)}</option>`).join('');
}

async function robotLoad(){
  robotErr='';
  const c=await sb.from('tel_robot_config').select('*').eq('id',1).maybeSingle();
  if(c.error){robotErr=(typeof dbErrText==='function')?dbErrText(c.error):String(c.error.message||c.error);robotCfg=null;return;}
  robotCfg=c.data;
  const s=await sb.from('tel_robot_scripts').select('*').order('created_at',{ascending:true});
  robotScripts=s.error?[]:(s.data||[]);
  const j=await sb.from('tel_robot_jobs').select('id,script_id,order_code,phone10,status,result,digit,attempts,last_error,created_at,finished_at,next_try_at,created_by_name')
    .order('created_at',{ascending:false}).limit(100);
  robotJobs=j.error?[]:(j.data||[]);
  // счётчики — запросами head:true, ни одной строки данных
  const day=new Date(localToday()+'T00:00:00').toISOString();
  const cnt=async f=>{const q=f(sb.from('tel_robot_jobs').select('id',{count:'exact',head:true}));const r=await q;return r.error?null:(r.count||0);};
  const [pending,calling,answered,failed]=await Promise.all([
    cnt(q=>q.eq('status','pending')),cnt(q=>q.eq('status','calling')),
    cnt(q=>q.eq('status','done').gte('finished_at',day)),cnt(q=>q.eq('status','failed').gte('finished_at',day))]);
  robotCounts={pending,calling,answered,failed};
}

async function renderRobotSettings(){
  const box=$('dirContent');if(!box)return;
  if(!(isAdmin()||canMod('telephony'))){
    box.innerHTML='<div class="panel"><div class="empty">Раздел доступен тем, кому выдано право «Телефония».</div></div>';return;
  }
  box.innerHTML='<div class="panel"><div class="empty">Загружаем…</div></div>';
  await robotLoad();
  if(S.dir!=='robot'||!$('dirContent'))return;
  robotDraw();
}

function robotWorkerLine(){
  const c=robotCfg||{};
  if(!c.worker_seen_at)return '<span style="color:var(--rust)">служба на сервере ещё ни разу не выходила на связь</span>';
  const ago=Math.round((nowMs()-new Date(c.worker_seen_at).getTime())/1000);
  const note=String(c.worker_note||'');
  if(ago>90)return `<span style="color:var(--rust)">служба на сервере молчит ${ago>3600?Math.round(ago/3600)+' ч':Math.round(ago/60)+' мин'} — робот не звонит</span>`;
  return `служба на сервере на связи${note?' · '+esc(note.replace(/^v[\d.\-]+ · /,'')):''}`;
}

function robotDraw(){
  const box=$('dirContent');if(!box)return;
  if(!robotCfg){
    box.innerHTML=`<div class="panel"><div class="empty">Не удалось открыть настройки робота: ${esc(robotErr||'таблицы не найдены')}</div></div>`;return;
  }
  const c=robotCfg,edit=robotCanEdit();
  const noLine=/линии нет/.test(String(c.worker_note||''));
  const scriptName=id=>{const s=(robotScripts||[]).find(x=>x.id===id);return s?s.name:'—';};
  const scripts=(robotScripts||[]).map(s=>`<tr data-rsid="${s.id}" style="cursor:pointer" class="${s.active?'':'pay-off'}">
      <td data-label="Сценарий"><strong>${esc(s.name)}</strong></td>
      <td data-label="Язык">${esc(ROBOT_LANG[s.lang]||s.lang)}</td>
      <td data-label="Кнопки">${(Array.isArray(s.keys)?s.keys:[]).map(k=>`<b>${esc(k.digit)}</b> — ${esc(k.label||'')}`).join('<br>')||'—'}</td>
      <td data-label="Автозапуск">${s.trigger_status_id?('по статусу «'+esc(robotStatusName(s.trigger_status_id)||'статус удалён')+'»'):'только вручную'}</td>
      <td data-label="Часы">${s.hour_from}:00–${s.hour_to}:00</td>
      <td data-label="Состояние">${s.active?'включён':'<span class="hint" style="margin:0">выключен</span>'}</td>
    </tr>`).join('');
  const jobs=(robotJobs||[]).map(j=>{
    const res=j.status==='done'?`нажал <b>${esc(j.digit||'')}</b>`
      :j.status==='failed'?esc(ROBOT_RESULT[j.result]||j.result||'не получилось')+(j.last_error&&j.result==='skip'?': '+esc(j.last_error):'')
      :j.status==='pending'&&j.result?`повтор после «${esc(ROBOT_RESULT[j.result]||j.result)}»`:esc(ROBOT_STATUS[j.status]||j.status);
    return `<tr><td data-label="Когда">${esc(fmtDateTime(j.finished_at||j.created_at))}</td>
      <td data-label="Заказ">${esc(j.order_code||'—')}</td>
      <td data-label="Сценарий">${esc(scriptName(j.script_id))}</td>
      <td data-label="Итог">${res}</td>
      <td data-label="Попыток">${j.attempts}</td>
      <td data-label="Откуда">${esc(j.created_by_name||'')}</td></tr>`;}).join('');
  const n=robotCounts||{};
  const num=v=>v==null?'—':v;
  box.innerHTML=`
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head" style="flex-wrap:wrap"><h3 style="margin:0;flex:1">Робот-обзвон</h3>
        ${edit?`<button class="btn ${c.enabled?'ghost':'primary'} sm" id="robToggle">${c.enabled?'⏸ Остановить робота':'▶ Включить робота'}</button>`:''}</div>
      <div style="padding:14px 20px">
        <div style="font-size:15px;margin-bottom:6px">${c.enabled?'<b style="color:var(--moss)">Робот включён</b> — звонит по очереди в часы, заданные в сценарии.':'<b>Робот выключен</b> — в очередь заказы встают, но звонков нет.'}</div>
        <div class="hint" style="margin:0 0 8px">${robotWorkerLine()}</div>
        ${noLine?'<div style="padding:10px 12px;border-radius:10px;background:#fdf1ee;color:var(--rust);font-size:14px;margin-bottom:8px"><b>Линия оператора связи не подключена.</b> Сценарии можно писать и слушать, но наружу робот звонить не будет, пока не подключим линию.</div>':''}
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="font-size:14px">Одновременных звонков:</label>
          <input id="robPar" inputmode="numeric" value="${esc(String(c.max_parallel||5))}" style="width:70px" ${edit?'':'disabled'}>
          ${edit?'<button class="btn ghost sm" id="robParSave">Сохранить</button>':''}
          <span class="hint" style="margin:0">каждый звонок робота занимает один канал линии</span>
        </div>
      </div>
    </div>
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head"><h3 style="margin:0;flex:1">Сценарии — что говорит робот</h3>
        ${edit?'<button class="btn primary sm" id="robAdd">＋ Сценарий</button>':''}</div>
      <div class="table-scroll"><table class="resp-table">
        <thead><tr><th>Сценарий</th><th>Язык</th><th>Кнопки</th><th>Автозапуск</th><th>Часы</th><th>Состояние</th></tr></thead>
        <tbody>${scripts||'<tr><td colspan="6"><div class="empty">Сценариев нет.</div></td></tr>'}</tbody></table></div>
    </div>
    <div class="panel">
      <div class="panel-head" style="flex-wrap:wrap"><h3 style="margin:0;flex:1">Очередь и итоги</h3>
        <button class="btn ghost sm" id="robReload">🔄 Обновить</button>
        ${edit&&n.pending?`<button class="btn ghost sm" id="robCancel" style="color:var(--rust)">Отменить ожидающие (${n.pending})</button>`:''}</div>
      <div style="padding:12px 20px;display:flex;gap:18px;flex-wrap:wrap;font-size:14px">
        <span>ждут звонка: <b>${num(n.pending)}</b></span><span>звоним сейчас: <b>${num(n.calling)}</b></span>
        <span>ответили сегодня: <b>${num(n.answered)}</b></span><span>не получилось сегодня: <b>${num(n.failed)}</b></span></div>
      <div class="table-scroll"><table class="resp-table">
        <thead><tr><th>Когда</th><th>Заказ</th><th>Сценарий</th><th>Итог</th><th>Попыток</th><th>Откуда</th></tr></thead>
        <tbody>${jobs||'<tr><td colspan="6"><div class="empty">Звонков ещё не было. Отметьте заказы в гриде и выберите «⚙ Действие → 🤖 Робот-обзвон» или задайте автозапуск по статусу в сценарии.</div></td></tr>'}</tbody></table></div>
      <p class="hint" style="margin:10px 20px 14px">Показаны последние 100 звонков. Итог по каждому заказу также пишется в «Историю изменений».</p>
    </div>`;
  const re=async()=>{await robotLoad();robotDraw();};
  if($('robReload'))$('robReload').onclick=re;
  if($('robAdd'))$('robAdd').onclick=()=>robotScriptModal(null);
  box.querySelectorAll('[data-rsid]').forEach(tr=>tr.onclick=()=>robotScriptModal(tr.dataset.rsid));
  if($('robToggle'))$('robToggle').onclick=async()=>{
    const on=!c.enabled;
    if(on&&!confirm('Включить робота?\n\nОн начнёт звонить клиентам из очереди — в часы, заданные в сценариях. Звонки идут с номера компании.'))return;
    const {error}=await sb.from('tel_robot_config').update({enabled:on,updated_at:new Date(nowMs()).toISOString()}).eq('id',1);
    if(error){toast('Не сохранилось: '+error.message,6000);return;}
    logAction('update','tel_robot_config',{entity_label:on?'робот-обзвон включён':'робот-обзвон остановлен'});
    toast(on?'Робот включён':'Робот остановлен');re();
  };
  if($('robParSave'))$('robParSave').onclick=async()=>{
    const v=parseInt(val('robPar'),10);
    if(!(v>=1&&v<=30)){toast('От 1 до 30');return;}
    const {error}=await sb.from('tel_robot_config').update({max_parallel:v,updated_at:new Date(nowMs()).toISOString()}).eq('id',1);
    toast(error?('Не сохранилось: '+error.message):'Сохранено');if(!error)re();
  };
  if($('robCancel'))$('robCancel').onclick=async()=>{
    if(!confirm(`Отменить ${n.pending} ожидающих звонков? Робот по ним звонить не будет.`))return;
    const {error}=await sb.from('tel_robot_jobs').update({status:'cancelled',finished_at:new Date(nowMs()).toISOString()}).eq('status','pending');
    toast(error?('Не получилось: '+error.message):'Очередь отменена');re();
  };
}

function robotKeyRow(k){
  k=k||{digit:'',label:'',status_id:'',say_ru:'',say_kz:''};
  return `<div class="rob-key">
      <select data-rk="digit" title="Кнопка">${['1','2','3','4','5','6','7','8','9','0'].map(d=>`<option ${d===String(k.digit)?'selected':''}>${d}</option>`).join('')}</select>
      <input data-rk="label" placeholder="что это значит — например: подтвердил" value="${esc(k.label||'')}">
      <select data-rk="status_id" title="Статус заказа после нажатия">${robotStatusOpts(k.status_id||'','статус заказа не менять')}</select>
      <input data-rk="say_ru" placeholder="что сказать в ответ по-русски" value="${esc(k.say_ru||'')}">
      <input data-rk="say_kz" placeholder="…и по-казахски (если нужен)" value="${esc(k.say_kz||'')}">
      <button type="button" class="btn ghost sm" data-rkdel title="Убрать кнопку">✕</button>
    </div>`;
}

function robotScriptModal(id){
  const s0=id?(robotScripts||[]).find(x=>x.id===id):null;
  const s=s0||{name:'',text_ru:'',text_kz:'',lang:'ru',voice_ru:'irina',keys:[{digit:'1',label:'',status_id:'',say_ru:'',say_kz:''}],
    repeat_times:2,max_attempts:3,retry_minutes:60,hour_from:9,hour_to:20,trigger_status_id:null,noanswer_status_id:null,active:false};
  const ro=!robotCanEdit();
  const ov=showModal(s0?'Сценарий робота':'Новый сценарий',`<div class="rob-form">
    <div class="field"><label>Название <span style="color:var(--rust)">*</span></label><input id="rs_name" value="${esc(s.name||'')}" placeholder="например: Подтверждение доставки"></div>
    <div class="field" style="margin-top:10px"><label>Что говорит робот — по-русски</label>
      <textarea id="rs_ru" rows="4">${esc(s.text_ru||'')}</textarea></div>
    <div class="field" style="margin-top:10px"><label>…по-казахски</label>
      <textarea id="rs_kz" rows="4">${esc(s.text_kz||'')}</textarea>
      <span class="hint" style="font-size:12px">Подстановки: <b>{дата}</b> — дата доставки словами, <b>{сумма}</b> — сумма заказа словами, <b>{номер}</b> — номер заказа по цифрам.
        Если в заказе нет того, что стоит в тексте, робот по нему не звонит и пишет причину.</span></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div class="field"><label>На каком языке говорить</label>
        <select id="rs_lang">${Object.keys(ROBOT_LANG).map(k=>`<option value="${k}" ${k===s.lang?'selected':''}>${ROBOT_LANG[k]}</option>`).join('')}</select></div>
      <div class="field"><label>Русский голос</label>
        <select id="rs_voice"><option value="irina" ${s.voice_ru!=='ruslan'?'selected':''}>женский</option><option value="ruslan" ${s.voice_ru==='ruslan'?'selected':''}>мужской</option></select></div>
    </div>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button type="button" class="btn ghost sm" id="rs_listen">🔊 Послушать</button>
      <span class="hint" style="margin:0" id="rs_listen_note">озвучит текст с примером: сумма 1500, дата — завтра</span></div>

    <div class="field" style="margin-top:16px"><label>Кнопки, которые может нажать клиент</label>
      <div id="rs_keys">${(Array.isArray(s.keys)?s.keys:[]).map(robotKeyRow).join('')}</div>
      <button type="button" class="btn ghost sm" id="rs_keyadd" style="margin-top:6px">＋ Кнопка</button>
      <span class="hint" style="font-size:12px;display:block;margin-top:4px">Нажатая кнопка — это ответ клиента: звонок закрыт, итог записан в заказ. Если выбран статус, робот сам поставит его заказу.</span></div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:14px">
      <div class="field"><label>Повторить фразу, если молчит</label><input id="rs_rep" inputmode="numeric" value="${esc(String(s.repeat_times))}"><span class="hint" style="font-size:12px">раз, от 1 до 4</span></div>
      <div class="field"><label>Попыток дозвона</label><input id="rs_att" inputmode="numeric" value="${esc(String(s.max_attempts))}"></div>
      <div class="field"><label>Пауза между попытками</label><input id="rs_retry" inputmode="numeric" value="${esc(String(s.retry_minutes))}"><span class="hint" style="font-size:12px">минут</span></div>
      <div class="field"><label>Звонить с</label><input id="rs_h1" inputmode="numeric" value="${esc(String(s.hour_from))}"><span class="hint" style="font-size:12px">час, по Астане</span></div>
      <div class="field"><label>…до</label><input id="rs_h2" inputmode="numeric" value="${esc(String(s.hour_to))}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div class="field"><label>Автозапуск: звонить, когда заказ получил статус</label>
        <select id="rs_trig">${robotStatusOpts(s.trigger_status_id||'','— только вручную —')}</select></div>
      <div class="field"><label>Если так и не дозвонились — поставить статус</label>
        <select id="rs_noans">${robotStatusOpts(s.noanswer_status_id||'','статус не менять')}</select></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="rs_active" ${s.active?'checked':''}> Сценарий включён</label>
    ${s0&&!ro?'<button type="button" class="btn ghost sm" id="rs_del" style="margin-top:14px;color:var(--rust)">Удалить сценарий</button>':''}</div>`,
    async()=>{
      const row=robotReadForm();
      if(row.error){toast(row.error,5000);return false;}
      const q=s0?sb.from('tel_robot_scripts').update(row.data).eq('id',s0.id):sb.from('tel_robot_scripts').insert(row.data);
      const {error}=await q;
      if(error){toast('Не сохранилось: '+((typeof dbErrText==='function')?dbErrText(error):error.message),6000);return false;}
      logAction(s0?'update':'create','tel_robot_scripts',{entity_label:'сценарий робота «'+row.data.name+'»'});
      await robotLoad();robotDraw();toast('Сохранено');
    },{wide:true,readonly:ro});
  const keysBox=ov.querySelector('#rs_keys');
  ov.querySelector('#rs_keyadd').onclick=()=>keysBox.insertAdjacentHTML('beforeend',robotKeyRow(null));
  keysBox.addEventListener('click',e=>{const b=e.target.closest('[data-rkdel]');if(b)b.closest('.rob-key').remove();});
  ov.querySelector('#rs_listen').onclick=()=>robotListen(ov);
  const del=ov.querySelector('#rs_del');
  if(del)del.onclick=async()=>{
    if(!confirm(`Удалить сценарий «${s0.name}»?\n\nВместе с ним удалятся его звонки из очереди и из списка итогов. В «Истории изменений» записи по заказам останутся.`))return;
    const {error}=await sb.from('tel_robot_scripts').delete().eq('id',s0.id);
    if(error){toast('Не удалилось: '+error.message,6000);return;}
    ov.remove();if(typeof syncModalOpenClass==='function')syncModalOpenClass();
    await robotLoad();robotDraw();toast('Удалено');
  };
}

// Форма сценария → строка для базы. Возвращает {data} или {error}.
function robotReadForm(){
  const name=val('rs_name').trim();
  if(!name)return {error:'Назовите сценарий'};
  const lang=val('rs_lang')||'ru';
  const text_ru=val('rs_ru').trim(),text_kz=val('rs_kz').trim();
  if(/ru/.test(lang)&&!text_ru)return {error:'Напишите текст по-русски — он выбран в «языке»'};
  if(/kz/.test(lang)&&!text_kz)return {error:'Напишите текст по-казахски — он выбран в «языке»'};
  const keys=[],seen=new Set();
  for(const el of document.querySelectorAll('#rs_keys .rob-key')){
    const g=k=>el.querySelector(`[data-rk="${k}"]`).value.trim();
    const digit=g('digit');
    if(seen.has(digit))return {error:`Кнопка ${digit} указана дважды`};
    seen.add(digit);
    if(!g('label'))return {error:`Напишите, что означает кнопка ${digit}`};
    keys.push({digit,label:g('label'),status_id:g('status_id'),say_ru:g('say_ru'),say_kz:g('say_kz')});
  }
  if(!keys.length)return {error:'Добавьте хотя бы одну кнопку — иначе робот не поймёт ответ клиента'};
  const int=(id,min,max,label)=>{const v=parseInt(val(id),10);return (v>=min&&v<=max)?v:{bad:`${label}: от ${min} до ${max}`};};
  const rep=int('rs_rep',1,4,'Повторов фразы'),att=int('rs_att',1,10,'Попыток дозвона'),retry=int('rs_retry',5,1440,'Пауза между попытками'),
    h1=int('rs_h1',0,23,'«Звонить с»'),h2=int('rs_h2',1,24,'«Звонить до»');
  for(const v of [rep,att,retry,h1,h2])if(v&&v.bad)return {error:v.bad};
  if(h2<=h1)return {error:'«Звонить до» должно быть позже, чем «звонить с»'};
  return {data:{name,text_ru:text_ru||null,text_kz:text_kz||null,lang,voice_ru:val('rs_voice')==='ruslan'?'ruslan':'irina',keys,
    repeat_times:rep,max_attempts:att,retry_minutes:retry,hour_from:h1,hour_to:h2,
    trigger_status_id:val('rs_trig')||null,noanswer_status_id:val('rs_noans')||null,
    active:$('rs_active').checked,updated_at:new Date(nowMs()).toISOString()}};
}

let robotAudio=null;
async function robotListen(ov){
  const btn=ov.querySelector('#rs_listen'),note=ov.querySelector('#rs_listen_note');
  if(robotAudio){try{robotAudio.pause();}catch(e){}robotAudio=null;}
  btn.disabled=true;note.textContent='озвучиваю…';
  try{
    const {data:sess}=await sb.auth.getSession();
    const token=sess&&sess.session?sess.session.access_token:'';
    const r=await fetch(ROBOT_BRIDGE+'/api/robot/preview',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({text_ru:val('rs_ru'),text_kz:val('rs_kz'),lang:val('rs_lang'),voice_ru:val('rs_voice')})});
    if(!r.ok){const j=await r.json().catch(()=>({}));note.textContent=(j&&j.message)||('не получилось ('+r.status+')');return;}
    const url=URL.createObjectURL(await r.blob());
    robotAudio=new Audio(url);
    robotAudio.onended=()=>{URL.revokeObjectURL(url);note.textContent='озвучит текст с примером: сумма 1500, дата — завтра';};
    await robotAudio.play();
    note.textContent='▶ играет — так услышит клиент';
  }catch(e){note.textContent='нет связи с сервером телефонии';}
  finally{btn.disabled=false;}
}

/* ---------- постановка в очередь из грида заказов ---------- */
async function robotQueueSelection(){
  const ids=[...ketSelected];
  if(!ids.length){showInfo('Робот-обзвон','<p>Не отмечено ни одного заказа. Поставьте галочки у заказов, которым робот должен позвонить.</p>');return;}
  const sc=await sb.from('tel_robot_scripts').select('id,name,active,text_ru,text_kz,lang').order('created_at',{ascending:true});
  if(sc.error){showInfo('Робот-обзвон',`<p>Не удалось прочитать сценарии: ${esc(sc.error.message||'')}</p><p class="hint">Нужно право «Телефония» в «Ролях и правах».</p>`);return;}
  const scripts=(sc.data||[]).filter(s=>s.active);
  if(!scripts.length){showInfo('Робот-обзвон','<p>Нет включённых сценариев.</p><p class="hint">Откройте «Настройки → Робот-обзвон», напишите текст и поставьте галочку «Сценарий включён».</p>');return;}
  const orders=ids.map(id=>S.orders.find(o=>o.id===id)).filter(Boolean);
  const withPhone=orders.filter(o=>robotPhone10(o.phone));
  const body=()=>`
    <div class="field"><label>Сценарий</label>
      <select id="rq_script">${scripts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <p style="margin:12px 0 4px;font-size:15px">Отмечено заказов: <b>${orders.length}</b> · с годным номером: <b>${withPhone.length}</b></p>
    ${orders.length-withPhone.length?`<p class="hint" style="margin:0">Без номера или с неверным номером — ${orders.length-withPhone.length}: по ним робот звонить не будет.</p>`:''}
    <p class="hint" style="margin:8px 0 0">Заказы, которые уже стоят в очереди этого сценария, второй раз не встанут. Робот звонит в часы, заданные в сценарии, и только когда он включён.</p>`;
  showModal('Робот-обзвон',body(),async()=>{
    const sid=val('rq_script');
    if(!withPhone.length){toast('Нет заказов с годным номером');return false;}
    // что уже в очереди этого сценария — спрашиваем базу, а не память вкладки
    const busy=new Set();
    for(let i=0;i<withPhone.length;i+=150){
      const r=await sb.from('tel_robot_jobs').select('order_id').eq('script_id',sid).in('status',['pending','calling']).in('order_id',withPhone.slice(i,i+150).map(o=>o.id));
      if(r.error){toast('Не удалось проверить очередь: '+r.error.message,6000);return false;}
      (r.data||[]).forEach(x=>busy.add(x.order_id));
    }
    const rows=withPhone.filter(o=>!busy.has(o.id)).map(o=>({script_id:sid,order_id:o.id,order_code:o.code,phone10:robotPhone10(o.phone),
      created_by:S.me&&S.me.id||null,created_by_name:S.me&&(S.me.full_name||S.me.email)||null}));
    if(!rows.length){toast('Все отмеченные заказы уже стоят в очереди этого сценария',5000);return;}
    for(let i=0;i<rows.length;i+=200){
      const {error}=await sb.from('tel_robot_jobs').insert(rows.slice(i,i+200));
      if(error){toast('Не встали в очередь: '+((typeof dbErrText==='function')?dbErrText(error):error.message),7000);return false;}
    }
    logAction('create','tel_robot_jobs',{entity_label:`в очередь робота: ${rows.length} заказ(ов)`,meta:{count:rows.length,script:sid}});
    toast(`В очередь робота: ${rows.length}`+(busy.size?` · уже стояли: ${busy.size}`:''),5000);
  },{mid:true,saveLabel:'Поставить в очередь'});
}
