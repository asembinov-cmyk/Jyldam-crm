/* ================= МОДУЛЬ «WhatsApp · Green API» (24.11.2026) =================
   Второй канал WhatsApp рядом с Kelesu (js/22). Просьба владельца: «сделай модуль
   WhatsApp интеграции с Green API в боковое меню».

   ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ KELESU, и из этого следует всё устройство:
   Green API работает через ПРИВЯЗАННЫЙ ТЕЛЕФОН (QR-код, как WhatsApp Web), а не через
   официальный канал Meta. Поэтому у него НЕТ ни шаблонов, ни окна 24 часа — пишем
   свободным текстом кому угодно и когда угодно, и за сообщение Meta денег не берёт.
   Обратная сторона: номер обычный, и за массовые рассылки WhatsApp его блокирует.
   Поэтому здесь только переписка, рассылки по кнопкам остались на Kelesu.

   КЛЮЧ МОДУЛЯ — `greenapi`. Переименовывать нельзя: по нему хранятся выданные права
   в roles.perms и написано правило чтения таблицы green_messages (db/69).

   КЛЮЧЕЙ GREEN API В БРАУЗЕРЕ НЕТ ВОВСЕ — ни в коде, ни в базе. Они лежат в секретах
   Edge Function `green-api`, и всё, что ходит наружу (отправка, QR, настройка вебхука),
   идёт через неё. Она же пишет переписку в базу; из браузера таблица только читается.

   ЗАКАЗ КЛИЕНТА, «ГДЕ ПОСЫЛКА» И БЫСТРЫЕ ОТВЕТЫ — ТЕ ЖЕ, ЧТО В МОДУЛЕ KELESU, и это не
   копия, а вызов тех же функций (waModOrdersLoad, waModOrderCardHtml, waModWhereHtml,
   waModQuickHtml). Два модуля на экране одновременно не бывают, поэтому общая память
   у них не сталкивается, а вторая копия разошлась бы с первой на первой же правке. */

const GA_PAGE    = 400;     // сообщений за один запрос списка диалогов
const GA_CHAT    = 300;     // сообщений в открытом диалоге (самые свежие)
const GA_TICK_MS = 10000;   // как часто тикает таймер (сам запрос — реже)
const GA_SYNC_MS = 20000;   // сверка с базой, когда Realtime молчит
const GA_SYNC_RT = 60000;   // и когда он работает: тогда это страховка, а не доставка
const GA_STATE_MS= 120000;  // как часто спрашиваем состояние телефона на «Диалогах»
const GA_QR_STEP = 4000;    // QR у Green API живёт 20 секунд — обновляем чаще
const GA_QR_MAX  = 180000;  // и не крутим его дольше трёх минут без человека
// `select('*')` не делаем: колонки перечислены по именам, как в модуле Kelesu.
const GA_COLS='id,id_message,chat_id,phone_norm,chat_name,sender_name,direction,message_type,body_text,media_url,file_name,status,via,sent_by_name,done_at,created_at,ai_status,ai_note';

let gaSub='dialogs';        // dialogs | assistant | connect
let gaRows=null;            // последние сообщения — из них собираются диалоги
let gaErr='';
let gaChatId='';            // открытый диалог (chat_id у Green API)
let gaChat=null;            // его сообщения, старые сверху
let gaChatErr='';
let gaSearch='';
let gaFilter='all';         // all | wait | groups
let gaState=null;           // что ответило действие state; null — ещё не спрашивали
let gaStateAt=0;
let gaStateBusy=false;
let gaTimer=null;
let gaSending=false;
let gaRtCh=null, gaRtOk=false, gaRtSeen=false, gaRtDraw=null;
let gaLastSync=0;
let gaStick=true;           // человек смотрит конец переписки
let gaDrafts={};            // черновики ответов ПО ЧАТАМ: один на всех уехал бы чужому
let gaQr=null;              // {img,note,at} — пока открыт QR-код
let gaQrTimer=null;
let gaPause={};                // пауза ассистента по чатам: chat_id → {paused,resumed_at} | null (таблицы нет)
let gaPauseCfg=null;           // {mode,human_min} из настроек ассистента
let gaBusy='';              // какое действие на вкладке «Подключение» сейчас идёт

const gaCall=(action,extra)=>callEdge('green-api',Object.assign({action},extra||{}));
const gaIsGroup=id=>/@g\.us$/.test(String(id||''));
const gaDigits=id=>String(id||'').replace(/@.*$/,'').replace(/\D/g,'');
/* Десять цифр номера — ТОЛЬКО у казахстанского (+7 и десять цифр). По ним ищутся заказы
   клиента, а «последние десять цифр» турецкого или узбекского номера могут совпасть с
   чужим казахстанским — и менеджер увидел бы заказы постороннего человека. */
const gaNorm=id=>{const m=/^7(\d{10})@c\.us$/.exec(String(id||''));return m?m[1]:'';};

/* Номер так, как его привыкли видеть. Казахстанский — в общем формате CRM, любой
   другой — цифрами с плюсом: обрезать иностранный номер до десяти цифр нельзя. */
function gaPhoneText(id){
  if(gaIsGroup(id))return 'группа';
  const d=gaDigits(id);
  if(/^7\d{10}$/.test(d))return phoneDisplay(d);
  return d?'+'+d:'—';
}

/* Телефон, набранный руками, → chat_id. Правило то же, что в функции (toChatId):
   длиннее 15 цифр не берём — это склейка или номер с добавочным. */
function gaChatIdFromPhone(v){
  let d=String(v||'').replace(/\D/g,'');
  if(d.length===10)d='7'+d;
  else if(d.length===11&&d[0]==='8')d='7'+d.slice(1);
  if(d.length<11||d.length>15)return '';
  return d+'@c.us';
}

/* ---------- загрузка ---------- */

function gaTableErr(e){
  const s=String(e&&(e.message||e.code)||e);
  if(/42P01|does not exist|schema cache/i.test(s))return 'Таблицы переписки ещё нет — нужно выполнить db/69';
  return 'Не удалось прочитать переписку: '+s;
}

async function gaLoad(){
  gaErr='';
  try{
    const {data,error}=await sb.from('green_messages').select(GA_COLS)
      .order('created_at',{ascending:false}).limit(GA_PAGE);
    if(error)throw error;
    gaRows=data||[];
  }catch(e){gaRows=[];gaErr=gaTableErr(e);}
}

/* БЕРЁМ СВЕЖИЕ, А НЕ ПЕРВЫЕ: сортировка по убыванию с пределом и разворот. Запрос
   «по возрастанию, первые N» у длинной переписки отдал бы её начало, и новые
   сообщения в открытом диалоге не появились бы никогда. */
async function gaChatLoad(chatId){
  gaChatErr='';
  try{
    const {data,error}=await sb.from('green_messages').select(GA_COLS)
      .eq('chat_id',chatId).order('created_at',{ascending:false}).limit(GA_CHAT);
    if(error)throw error;
    if(gaChatId!==chatId)return;            // пока грузили, открыли другой диалог
    gaChat=(data||[]).reverse();
    gaPauseLoad(chatId);                       // пауза ассистента — отдельно, чат её не ждёт
  }catch(e){
    if(gaChatId!==chatId)return;
    gaChat=[];gaChatErr=gaTableErr(e);
  }
}

/* ПАУЗА АССИСТЕНТА В ЭТОМ ЧАТЕ (просьба владельца 24.11.2026). Строка в green_ai_chats:
   paused — молчит, пока не снимут; resumed_at — «сняли с паузы» (сообщения менеджера до
   этого момента автопаузу не держат). Читает её функция green-assistant перед ответом.
   Таблицы или прав нет — кнопки просто нет. */
async function gaPauseLoad(chatId){
  if(gaIsGroup(chatId))return;
  try{
    if(!gaPauseCfg){
      const c=await sb.from('green_ai_settings').select('mode,human_min').eq('id',1).maybeSingle();
      if(!c.error&&c.data)gaPauseCfg=c.data;
    }
    const {data,error}=await sb.from('green_ai_chats').select('paused,resumed_at').eq('chat_id',chatId).maybeSingle();
    if(error)throw error;
    gaPause[chatId]=data||{paused:false,resumed_at:null};
  }catch(e){gaPause[chatId]=null;}
  if(gaChatId===chatId&&S.tab==='greenapi'&&gaSub==='dialogs')gaRedraw();
}
/* Что сейчас с ассистентом в открытом чате: null — показывать нечего. */
function gaPauseState(){
  const st=gaPause[gaChatId];
  if(!st||!gaPauseCfg||gaPauseCfg.mode==='off'||gaIsGroup(gaChatId))return null;
  if(st.paused)return {paused:true,text:'ассистент на паузе'};
  const hm=gaPauseCfg.human_min==null?15:Math.max(0,+gaPauseCfg.human_min||0);
  if(hm>0){
    const res=st.resumed_at?Date.parse(st.resumed_at)||0:0;
    const last=(gaChat||[]).filter(m=>m.direction==='outbound'&&m.via!=='ai').map(m=>Date.parse(m.created_at)||0).sort((a,b)=>b-a)[0]||0;
    const until=last+hm*60000;
    if(last>res&&until>nowMs()){
      const d=new Date(until);
      return {paused:true,auto:true,text:'пауза до '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+' — писал менеджер'};
    }
  }
  return {paused:false,text:'ассистент отвечает'};
}
async function gaPauseToggle(btn){
  const chatId=gaChatId, st=gaPauseState();
  if(!st)return;
  const resume=st.paused;
  btn.disabled=true;
  const row={chat_id:chatId,paused:!resume,updated_at:new Date(nowMs()).toISOString(),updated_by_name:(S.me&&(S.me.full_name||S.me.email))||''};
  if(resume)row.resumed_at=row.updated_at;
  const {error}=await sb.from('green_ai_chats').upsert(row,{onConflict:'chat_id'});
  if(error){btn.disabled=false;toast('Не удалось: '+dbErrText(error));return;}
  gaPause[chatId]={paused:!resume,resumed_at:resume?row.resumed_at:(gaPause[chatId]||{}).resumed_at||null};
  toast(resume?'Ассистент снят с паузы — на сообщения клиента без ответа ответит он':'Ассистент на паузе в этом чате — отвечаете вы');
  if(gaChatId===chatId)gaRedraw();
}

/* Состояние телефона спрашиваем у функции, а она — у Green API. Отказ самой функции
   (нет права, не выложена) кладём в `failed`, чтобы он не выглядел как «не настроено». */
async function gaStateLoad(){
  if(gaStateBusy)return;
  gaStateBusy=true;
  try{
    const r=await gaCall('state');
    gaState=(r&&typeof r.configured==='boolean')?r:{failed:String((r&&r.error)||'сервер не ответил')};
  }catch(e){gaState={failed:String(e&&e.message||e)};}
  gaStateAt=Date.now();gaStateBusy=false;
  gaPillLabel();
  if(S.tab==='greenapi'&&gaSub==='connect')gaConnRedraw();
}

/* ---------- Realtime и сверка — то же устройство, что в модуле Kelesu ---------- */

function gaRtStart(){
  if(gaRtCh||typeof sb?.channel!=='function')return;
  try{
    gaRtCh=sb.channel('green-live')
      .on('postgres_changes',{event:'*',schema:'public',table:'green_messages'},p=>{
        gaRtSeen=true;
        gaApplyRow(p&&p.new);
      })
      .subscribe(st=>{gaRtOk=(st==='SUBSCRIBED');});
  }catch(e){gaRtCh=null;gaRtOk=false;}
}
function gaRtStop(){
  if(gaRtDraw){clearTimeout(gaRtDraw);gaRtDraw=null;}
  if(!gaRtCh)return;
  try{sb.removeChannel(gaRtCh);}catch(e){}
  gaRtCh=null;gaRtOk=false;
}
function gaApplyRow(row){
  if(!row||!row.id)return;
  const m={};
  GA_COLS.split(',').forEach(k=>{m[k]=row[k];});
  const put=(arr,desc)=>{
    if(!arr)return;
    const i=arr.findIndex(x=>String(x.id)===String(m.id));
    if(i>=0){Object.assign(arr[i],m);return;}
    if(desc)arr.unshift(m); else arr.push(m);
  };
  put(gaRows,true);
  if(gaChatId&&m.chat_id===gaChatId)put(gaChat,false);
  if(gaRtDraw)return;                     // пачку событий рисуем одним разом
  gaRtDraw=setTimeout(()=>{gaRtDraw=null;if(S.tab==='greenapi'&&gaSub==='dialogs')gaRedraw();},300);
}

/* ТАЙМЕР ОДИН НА ВСЁ ВРЕМЯ РАБОТЫ С МОДУЛЕМ. Завести его повторно нельзя, а снимается
   он только при УХОДЕ из модуля (в render(), js/03): перезапуск на каждой перерисовке
   уже один раз сделал так, что свежие сообщения не подтягивались вовсе (раздел 14). */
function gaStopPoll(){
  if(gaTimer){clearInterval(gaTimer);gaTimer=null;}
  gaQrStop();
}
function gaStartPoll(){
  if(gaTimer)return;
  gaTimer=setInterval(gaTick,GA_TICK_MS);
}
async function gaTick(){
  if(S.tab!=='greenapi'||document.hidden||gaSending)return;
  // на «Подключении» состояние нужно чаще: человек только что отсканировал код
  const stEvery=gaSub==='connect'?15000:GA_STATE_MS;
  if(!gaQr&&Date.now()-gaStateAt>stEvery)gaStateLoad();
  if(gaSub==='assistant'&&typeof gaAiTick==='function'){gaAiTick();return;}
  if(gaSub!=='dialogs')return;
  const need=gaRtSeen?GA_SYNC_RT:GA_SYNC_MS;
  if(Date.now()-gaLastSync<need)return;
  await gaSync();
}
async function gaSync(){
  gaLastSync=Date.now();
  await gaLoad();
  if(gaChatId)await gaChatLoad(gaChatId);
  gaRedraw();
}

/* ---------- диалоги ---------- */

/* ОДИН ЧАТ — ОДИН ДИАЛОГ. Список отсортирован по убыванию даты, значит первое
   встреченное сообщение чата — последнее по времени.

   «ЖДЁТ ОТВЕТА» — ЭТО ХВОСТ ВХОДЯЩИХ: идём от свежих к старым и считаем входящие, пока
   не упрёмся в наш ответ или в отметку «решено». Ответили с самого телефона — исходящее
   приезжает вебхуком, и диалог уходит из ждущих сам.

   ГРУППЫ В «ЖДУТ ОТВЕТА» НЕ СЧИТАЕМ: в группе пишут друг другу, и последнее слово почти
   всегда не за нами — они висели бы там вечно и прятали настоящих клиентов. */
function gaDialogs(){
  const by=new Map();
  (gaRows||[]).forEach(m=>{
    const key=String(m.chat_id||'');
    if(!key)return;
    let d=by.get(key);
    if(!d){d={id:key,norm:gaNorm(key),group:gaIsGroup(key),last:m,cnt:0,unread:0,closed:false,aiAnswered:false,handoff:'',name:''};by.set(key,d);}
    d.cnt++;
    /* С АССИСТЕНТОМ ПРАВИЛО ТОНЬШЕ (js/31). Его ответ диалог НЕ закрывает: если он при
       этом передал вопрос менеджеру (ai_status handoff / failed), человек обязан это
       увидеть — иначе «передал менеджеру» означало бы «потерял». А входящее, которое
       ассистент разобрал сам (answered), ответа человека не ждёт. */
    if(!d.closed){
      if(m.done_at)d.closed=true;
      else if(m.direction==='outbound'){
        if(m.via==='ai')d.aiAnswered=true; else d.closed=true;
      }else{
        const st=m.ai_status||'';
        if(st==='handoff'||st==='failed'){
          d.unread++;
          if(!d.handoff)d.handoff=m.ai_note||(st==='failed'?'ассистент не справился':'ассистент передал диалог менеджеру');
        }else if(st!=='answered'&&!d.aiAnswered)d.unread++;
      }
    }
    if(!d.name){
      if(m.chat_name)d.name=String(m.chat_name);
      else if(!d.group&&m.direction==='inbound'&&m.sender_name)d.name=String(m.sender_name);
    }
  });
  const list=[...by.values()];
  list.forEach(d=>{d.waiting=!d.group&&d.unread>0;});
  return list;
}

/* «Передал менеджеру» (просьба владельца 25.11.2026) — ждущие диалоги, где ассистент сам
   отдал вопрос человеку или не справился. Это часть «Ждут ответа», а не отдельный список:
   ответил менеджер или нажали «Решено» — диалог уходит из обоих. */
const GA_FILTERS=[['all','Все'],['wait','Ждут ответа'],['handoff','Передал менеджеру'],['groups','Группы']];

function gaDialogsFiltered(){
  let list=gaDialogs();
  if(gaFilter==='wait')list=list.filter(d=>d.waiting);
  else if(gaFilter==='handoff')list=list.filter(d=>d.waiting&&d.handoff);
  else if(gaFilter==='groups')list=list.filter(d=>d.group);
  const q=gaSearch.trim().toLowerCase();
  if(q){
    const qd=q.replace(/\D/g,'');
    // по цифрам ищем, только если они в запросе есть: пустая строка — подстрока чего угодно
    list=list.filter(d=>(qd&&gaDigits(d.id).includes(qd))
      ||d.name.toLowerCase().includes(q)
      ||String(d.last.body_text||'').toLowerCase().includes(q));
  }
  return list;
}

function gaCounters(){
  const all=gaDialogs();
  let today=0;
  const t=typeof localToday==='function'?localToday():'';
  if(t&&typeof localDay==='function')(gaRows||[]).forEach(m=>{if(m.direction==='inbound'&&localDay(m.created_at)===t)today++;});
  return {wait:all.filter(d=>d.waiting).length,handoff:all.filter(d=>d.waiting&&d.handoff).length,dialogs:all.length,today};
}

/* ---------- отправка и действия по диалогу ---------- */

/* Писать можно, когда телефон привязан. Если состояние узнать не удалось, НЕ запрещаем:
   отказ самой проверки не должен останавливать работу, а Green API скажет сам. */
function gaSendBlock(){
  const s=gaState;
  if(!s||s.failed||s.error)return '';
  if(s.configured===false)return 'Green API ещё не подключён — откройте вкладку «Подключение».';
  if(s.state&&s.state!=='authorized')return 'Сейчас написать нельзя: '+gaStateRu(s.state)+'. Откройте вкладку «Подключение».';
  return '';
}

async function gaSend(){
  const ta=$('gaText');if(!ta)return;
  const text=String(ta.value||'').trim();
  if(!text){toast('Нечего отправлять');return;}
  if(!gaChatId){toast('Диалог не выбран');return;}
  const chatId=gaChatId, btn=$('gaSendBtn');
  gaSending=true;
  if(btn){btn.disabled=true;btn.textContent='Отправляю…';}
  ta.disabled=true;
  try{
    const res=await gaCall('send',{chat_id:chatId,text});
    if(!res||res.error||!res.ok)throw new Error((res&&res.error)||'сервер не ответил');
    delete gaDrafts[chatId];
    if(gaChatId===chatId){
      const t0=$('gaText');if(t0)t0.value='';
      gaStick=true;
      await gaChatLoad(chatId);
    }
    await gaLoad();
    gaRedraw();
    toast(res.log_failed?'Отправлено, но в переписку CRM не записалось':'Отправлено');
  }catch(e){
    toast('Не отправлено: '+String(e&&e.message||e));
  }finally{
    gaSending=false;
    const b2=$('gaSendBtn');if(b2){b2.disabled=false;b2.textContent='Отправить';}
    const t2=$('gaText');if(t2){t2.disabled=false;t2.focus();}
  }
}

async function gaMarkDone(btn){
  if(!gaChatId)return;
  const chatId=gaChatId;
  if(btn){btn.disabled=true;btn.textContent='Отмечаю…';}
  const res=await gaCall('mark',{chat_id:chatId});
  if(!res||res.error){
    toast('Не удалось отметить: '+String((res&&res.error)||'сервер не ответил'));
    if(btn){btn.disabled=false;btn.textContent='✓ Отметить решённым';}
    return;
  }
  const now=new Date().toISOString();
  const mark=m=>{if(m.chat_id===chatId&&m.direction==='inbound'&&!m.done_at)m.done_at=now;};
  (gaRows||[]).forEach(mark);(gaChat||[]).forEach(mark);
  toast('Отмечено решённым');
  gaRedraw();
}

/* Добор переписки из журнала Green API — на случай, когда вебхук молчал или телефон
   привязали только что. Спрашиваем по ОДНОМУ открытому чату: у Green API на этот метод
   предел один запрос в секунду, обходить им сотни чатов нельзя. */
async function gaHistory(btn){
  if(!gaChatId)return;
  const chatId=gaChatId;
  if(btn){btn.disabled=true;btn.textContent='Загружаю…';}
  const res=await gaCall('history',{chat_id:chatId,count:200});
  if(btn){btn.disabled=false;btn.textContent='⟲ История';}
  if(!res||res.error){toast('История не загрузилась: '+String((res&&res.error)||'сервер не ответил'));return;}
  toast(res.got?'Из журнала Green API получено сообщений: '+res.got:'В журнале Green API по этому чату пусто');
  if(gaChatId===chatId)await gaChatLoad(chatId);
  await gaLoad();
  gaRedraw();
}

function gaNewDialog(){
  showModal('Новый диалог',`
    <div class="field"><label>Номер WhatsApp</label>
      <input id="gaNewPhone" inputmode="tel" autocomplete="off" placeholder="+7 707 123 45 67"></div>
    <div class="hint">Откроется пустой диалог — сообщение уйдёт, когда вы его напишете и нажмёте «Отправить».
      Номер должен быть зарегистрирован в WhatsApp, иначе Green API отметит сообщение как недоставленное.</div>`,
    ()=>{
      const id=gaChatIdFromPhone(($('gaNewPhone')||{}).value);
      if(!id){toast('Номер не похож на телефон: нужно 10–15 цифр');return false;}
      gaSub='dialogs';gaFilter='all';
      renderGreen();
      gaOpenDialog(id);
      return true;
    },{saveLabel:'Открыть диалог'});
}

async function gaOpenDialog(chatId){
  if(!chatId)return;
  gaChatId=chatId;gaChat=null;gaChatErr='';gaStick=true;
  const norm=gaNorm(chatId);
  // Заказы клиента — тем же кодом, что в модуле Kelesu; у группы заказов не бывает.
  if(norm&&typeof waModOrdersLoad==='function'){waModOrders=null;waModOrdPhone=norm;waModOrdErr='';}
  gaRedraw();
  await Promise.all([
    gaChatLoad(chatId),
    norm&&typeof waModOrdersLoad==='function'?waModOrdersLoad(norm):Promise.resolve(),
  ]);
  if(gaChatId!==chatId)return;
  gaRedraw();
}

/* ---------- разметка: переписка ---------- */

const GA_STATUS_RU={failed:'не отправлено',noAccount:'у номера нет WhatsApp',notInGroup:'нас нет в этой группе',
  yellowCard:'номер ограничен WhatsApp',suspended:'номер ограничен WhatsApp',pending:'отправляется'};

function gaStatusHtml(m){
  if(m.direction!=='outbound'||!m.status)return '';
  const s=String(m.status);
  if(s==='sent')return ' · ✓';
  if(s==='delivered')return ' · ✓✓';
  if(s==='read')return ' · <span style="color:#2563eb">✓✓</span>';
  return ' · <span style="color:var(--rust)">'+esc(GA_STATUS_RU[s]||s)+'</span>';
}

/* Вложение рисует общий waModMedia (картинка, плеер, ссылка). Своё здесь одно: у
   документа показываем имя файла — «📎 документ» без имени ничего не говорит. */
function gaMedia(m){
  const url=String(m.media_url||'');
  if(m.message_type==='document'&&url)
    return `<div class="wam-att"><a href="${esc(url)}" target="_blank" rel="noopener">📎 ${esc(m.file_name||'документ')}</a></div>`;
  return typeof waModMedia==='function'?waModMedia(m):'';
}

function gaBubbles(){
  if(gaChat===null)return '<div class="hint">Загружаем переписку…</div>';
  if(gaChatErr)return `<div class="hint" style="color:var(--rust)">${esc(gaChatErr)}</div>`;
  if(!gaChat.length)return '<div class="hint">Переписки с этим номером в CRM пока нет. Напишите первым — или нажмите «⟲ История», если переписывались с телефона.</div>';
  const group=gaIsGroup(gaChatId);
  let day='';
  return gaChat.map(m=>{
    const out=m.direction==='outbound';
    const t=(fmtLogTime(m.created_at)||{});
    let sep='';
    if(t.date&&t.date!==day){day=t.date;sep=`<div class="wam-day">${esc(day)}</div>`;}
    // Кто написал: в группе — участник, у нашего ответа — сотрудник или «с телефона».
    const byAi=out&&m.via==='ai';
    const who=byAi?'🤖 ИИ-ассистент':(out?(m.sent_by_name||(m.via==='phone'?'с телефона':'')):(group?(m.sender_name||''):''));
    const att=gaMedia(m);
    const body=m.body_text||(att?'':'—');
    return sep+`<div class="wam-row ${out?'out':'in'}">
      <div class="wam-bub ${out?'out':'in'}${byAi?' bot':''}">
        ${who?`<div class="wam-who">${esc(who)}</div>`:''}
        ${att}
        ${body?`<div class="wam-txt">${esc(body)}</div>`:''}
        <div class="wam-meta">${esc(t.time||'')}${gaStatusHtml(m)}</div>
      </div>
    </div>`;
  }).join('');
}

function gaDlgName(chatId){
  const d=gaDialogs().find(x=>x.id===chatId);
  return d?d.name:'';
}

function gaChatHtml(){
  if(!gaChatId)return `<div class="empty" style="padding:40px"><div class="big">Выберите диалог</div>Слева — все, с кем переписывались через этот номер. Написать новому номеру — кнопка «＋ Новый диалог» наверху.</div>`;
  const group=gaIsGroup(gaChatId), norm=gaNorm(gaChatId), name=gaDlgName(gaChatId);
  const canSend=can('greenapi','create');
  let sub='';
  if(group)sub='группа WhatsApp';
  else if(norm&&typeof waModOrders!=='undefined'){
    const pick=(waModOrders||[]).find(o=>o.id===waModOrdPick)||(waModOrders||[])[0];
    sub=pick?`Заказ №${esc(pick.code||'—')}`:(waModOrders===null?'ищем заказы…':'заказ по номеру не найден');
    if(name)sub=esc(name)+' · '+sub;
  }else if(name)sub=esc(name);
  const title=group?(name||'Группа'):gaPhoneText(gaChatId);
  const aiSt=gaPauseState();
  const head=`<div class="wam-chead">
    <button class="btn sm ghost wam-back" id="gaBack">← к списку</button>
    ${waModAvatar(group?(name||'гр'):(norm||gaDigits(gaChatId)))}
    <div class="wam-ctitle">${esc(title)}<span>${sub}</span></div>
    ${aiSt&&canSend?`<button class="btn sm ${aiSt.paused?'primary':'ghost'} ga-ai-btn" id="gaPauseBtn" title="${aiSt.paused?'Ассистент снова начнёт отвечать в этом чате':'Ассистент перестанет отвечать в этом чате, пока не снимете паузу'}">${aiSt.paused?'▶ Снять с паузы':'⏸ Пауза'}</button>`:''}
    ${canSend?'<button class="btn sm ghost" id="gaHist" title="Загрузить переписку этого чата из журнала Green API">⟲ История</button>':''}
  </div>${aiSt?`<div class="ga-ai-state${aiSt.paused?' paused':''}">🤖 ${esc(aiSt.text)}</div>`:''}`;
  let foot;
  const block=gaSendBlock();
  if(!canSend){
    foot=`<div class="wam-foot hint">Отвечать отсюда можно по праву «WhatsApp Ассистент приёма заявок → создание». Прочитать переписку это не мешает.</div>`;
  }else if(block){
    foot=`<div class="wam-foot hint" style="color:var(--rust)">${esc(block)}</div>`;
  }else{
    foot=`<div class="wam-foot">
      ${!group&&typeof waModQuickHtml==='function'?waModQuickHtml():''}
      <div class="wam-send">
        <textarea id="gaText" rows="2" placeholder="${group?'Сообщение в группу…':'Ответ клиенту…'}">${esc(gaDrafts[gaChatId]||'')}</textarea>
        <button class="btn primary" id="gaSendBtn">Отправить</button>
      </div>
    </div>`;
  }
  // Ассистент передал диалог человеку — причина видна прямо под перепиской.
  const dlg=gaDialogs().find(x=>x.id===gaChatId);
  const strip=dlg&&dlg.handoff?`<div class="wam-wait">🤖 Ассистент передал диалог менеджеру: ${esc(dlg.handoff)}</div>`:'';
  return head+`<div class="wam-scroll" id="gaScroll">${gaBubbles()}${strip}</div>`+foot;
}

/* Правая колонка: заказ клиента. Карточку, «Где посылка» и список заказов рисуют
   функции модуля Kelesu — данные заказа от канала переписки не зависят. */
function gaInfoHtml(){
  if(!gaChatId)return '';
  const msgs=gaChat||[];
  if(gaIsGroup(gaChatId))
    return `<div class="wam-i-sec">Группа</div>
      <div class="hint">Это общий чат, а не клиент: заказов по нему нет, и в «Ждут ответа» он не попадает.</div>
      <div class="wam-kv"><span>Сообщений в CRM</span><b>${msgs.length}</b></div>`;
  let ord='';
  if(typeof waModOrders==='undefined'||typeof waModOrderCardHtml!=='function')ord='';
  else if(!gaNorm(gaChatId))ord='<div class="hint">Номер не казахстанский — заказы по нему не ищем: последние цифры могли бы совпасть с чужим номером.</div>';
  else if(waModOrders===null)ord='<div class="hint">Ищем заказы по номеру…</div>';
  else if(waModOrdErr)ord=`<div class="hint" style="color:var(--rust)">Заказы не загрузились: ${esc(waModOrdErr)}</div>`;
  else if(!waModOrders.length)ord='<div class="hint">Заказов по этому номеру не нашли. Возможно, клиент пишет с другого телефона — спросите у него номер заказа.</div>';
  else{
    const pick=waModOrders.find(o=>o.id===waModOrdPick)||waModOrders[0];
    ord=waModOrderCardHtml(pick)+waModWhereHtml(pick)+waModOrdersListHtml();
  }
  const name=gaDlgName(gaChatId);
  // «Решено» — когда последнее слово за клиентом: кнопка убирает диалог из «Ждут ответа».
  const dlg=gaDialogs().find(x=>x.id===gaChatId);
  const done=can('greenapi','create')&&dlg&&dlg.unread>0
    ?'<button class="btn primary wam-done" id="gaDone">✓ Отметить решённым</button>':'';
  return `<div class="wam-i-sec">Заказ</div>${ord}
    <div class="wam-i-sec wam-deskonly">Диалог</div>
    ${name?`<div class="wam-kv wam-deskonly"><span>Имя в WhatsApp</span><b>${esc(name)}</b></div>`:''}
    <div class="wam-kv wam-deskonly"><span>Сообщений в CRM</span><b>${msgs.length}</b></div>
    ${done}`;
}

function gaListHtml(){
  if(gaRows===null)return '<div class="hint" style="padding:14px">Загружаем…</div>';
  if(gaErr)return `<div class="hint" style="padding:14px;color:var(--rust)">${esc(gaErr)}</div>`;
  const list=gaDialogsFiltered();
  if(!list.length){
    if(!gaRows.length)return '<div class="hint" style="padding:14px">Переписки пока нет. Сообщения появятся здесь, как только телефон привязан и клиент напишет — либо напишите первым через «＋ Новый диалог».</div>';
    const fname=(GA_FILTERS.find(f=>f[0]===gaFilter)||[])[1]||'';
    return `<div class="hint" style="padding:14px">По фильтру «${esc(fname)}»${gaSearch.trim()?' и поиску':''} ничего нет.
      <button class="btn sm ghost" data-gafl="all" style="margin-top:8px">Показать все диалоги</button></div>`;
  }
  const MEDIA={image:'фото',audio:'голосовое',voice:'голосовое',video:'видео',document:'документ',sticker:'стикер'};
  return list.map(d=>{
    const m=d.last;
    const prev=String(m.body_text||(m.message_type==='document'&&m.file_name?'📎 '+m.file_name:'')||MEDIA[m.message_type]||(m.message_type&&m.message_type!=='text'?m.message_type:'—')).slice(0,70);
    const title=d.group?(d.name||'Группа'):gaPhoneText(d.id);
    return `<div class="wam-item${d.id===gaChatId?' on':''}" data-gadlg="${esc(d.id)}">
      ${waModAvatar(d.group?(d.name||'гр'):(d.norm||gaDigits(d.id)))}
      <div class="wam-i-body">
        <div class="wam-i-top">
          <span class="wam-i-ph">${esc(title)}</span>
          <span class="wam-i-time">${esc(waModWhen(m.created_at))}</span>
        </div>
        <div class="wam-i-prev">${m.direction==='outbound'?'<span class="wam-i-you">вы: </span>':''}${esc(prev)}</div>
        <div class="wam-i-tags">
          ${d.waiting?`<span class="wam-tag warn">ждёт ответа · ${d.unread}</span>`:''}
          ${d.handoff&&!d.group?'<span class="wam-tag warn">🤖 передал менеджеру</span>':''}
          ${d.group?'<span class="wam-tag">группа</span>':(d.name?`<span class="wam-tag">${esc(d.name.slice(0,28))}</span>`:'')}
          <span class="wam-tag mute">${d.cnt} сообщ.</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function gaBodyHtml(){
  const c=gaCounters();
  const chips=GA_FILTERS.map(([k,l])=>
    `<button class="wam-chip${gaFilter===k?' on':''}" data-gafl="${k}">${esc(l)}${k==='wait'&&c.wait?' '+c.wait:(k==='handoff'&&c.handoff?' '+c.handoff:'')}</button>`).join('');
  return `<div class="wam-wrap${gaChatId?' chat':''}">
    <div class="wam-side">
      <div class="wam-filters">
        <input id="gaSearch" placeholder="Номер, имя или текст" value="${esc(gaSearch)}">
        <div class="wam-chips">${chips}</div>
      </div>
      <div class="wam-list">${gaListHtml()}</div>
    </div>
    <div class="wam-chat">${gaChatHtml()}</div>
    ${gaChatId?`<div class="wam-info">${gaInfoHtml()}</div>`:''}
  </div>`;
}

/* ---------- вкладка «Подключение» ---------- */

const GA_STATE_RU={authorized:'телефон привязан',notAuthorized:'телефон не привязан',
  starting:'инстанс запускается',blocked:'номер заблокирован WhatsApp',sleepMode:'телефон не в сети',
  yellowCard:'номер ограничен WhatsApp',suspended:'номер временно ограничен WhatsApp'};
const gaStateRu=s=>GA_STATE_RU[s]||s||'состояние неизвестно';

function gaPillHtml(){
  const s=gaState;
  if(!s)return '<span class="wam-pill off" id="gaPill">проверяем телефон…</span>';
  if(s.failed)return '<span class="wam-pill off" id="gaPill" title="'+esc(s.failed)+'">состояние не получено</span>';
  if(s.configured===false)return '<span class="wam-pill off" id="gaPill">не подключён</span>';
  if(s.error)return '<span class="wam-pill off" id="gaPill" title="'+esc(s.error)+'">Green API не отвечает</span>';
  if(s.state==='authorized')
    return '<span class="wam-pill ok" id="gaPill">● '+esc(s.phone?gaPhoneText(s.phone+'@c.us'):'телефон привязан')+'</span>';
  return '<span class="wam-pill off" id="gaPill" style="color:var(--rust)">'+esc(gaStateRu(s.state))+'</span>';
}
function gaPillLabel(){
  const el=$('gaPill');if(el)el.outerHTML=gaPillHtml();
}

function gaStepHtml(ok,title,body){
  return `<div class="ga-step${ok?' ok':''}"><div class="ga-step-n">${ok?'✓':'○'}</div>
    <div class="ga-step-b"><div class="ga-step-t">${title}</div>${body||''}</div></div>`;
}

function gaConnHtml(){
  const s=gaState, canCfg=isAdmin()||can('greenapi','edit');
  const again='<button class="btn sm ghost" data-gaact="recheck"'+(gaStateBusy?' disabled':'')+'>Проверить снова</button>';
  const intro=`<div class="hint" style="margin-bottom:14px">Green API подключает обычный номер WhatsApp через привязанный телефон — так же, как WhatsApp Web.
    Шаблоны и окно 24 часа здесь не действуют: писать можно любому номеру и свободным текстом.
    <b>Массовые рассылки с такого номера WhatsApp блокирует</b> — для них остаётся модуль «WhatsApp» (Kelesu).</div>`;
  if(!s)return intro+'<div class="hint">Проверяем подключение…</div>';
  if(s.failed)return intro+`<div class="hint" style="color:var(--rust);margin-bottom:10px">Не удалось узнать состояние: ${esc(s.failed)}</div>${again}`;
  if(s.configured===false){
    return intro+gaStepHtml(false,'Шаг 1. Ключи Green API',`
      <div class="hint">На сервере ещё нет ключей${s.missing&&s.missing.length?' ('+esc(s.missing.join(', '))+')':''}. Что сделать:</div>
      <ol class="ga-ol">
        <li>Зарегистрируйтесь на <b>green-api.com</b> и создайте инстанс. Бесплатный тариф «Developer» годится для пробы, но пишет только в несколько чатов — для работы нужен платный.</li>
        <li>В личном кабинете Green API откройте инстанс — там три значения: <b>apiUrl</b>, <b>idInstance</b>, <b>apiTokenInstance</b>.</li>
        <li>В Supabase откройте <b>Edge Functions → Secrets</b> и добавьте три секрета:
          <code>GREEN_API_URL</code> = apiUrl, <code>GREEN_ID_INSTANCE</code> = idInstance, <code>GREEN_API_TOKEN</code> = apiTokenInstance.</li>
        <li>Вернитесь сюда и нажмите «Проверить снова».</li>
      </ol>
      <div class="hint">Ключи в чат и в саму CRM вводить не нужно: они хранятся только на сервере.</div>
      <div style="margin-top:10px">${again}</div>`)
      +gaStepHtml(false,'Шаг 2. Приём сообщений','<div class="hint">Настроится одной кнопкой после шага 1.</div>')
      +gaStepHtml(false,'Шаг 3. Привязка телефона','<div class="hint">QR-код появится здесь после шага 1.</div>');
  }
  if(s.error)return intro+gaStepHtml(false,'Шаг 1. Ключи Green API',
    `<div class="hint" style="color:var(--rust)">${esc(s.error)}</div><div style="margin-top:10px">${again}</div>`);

  const step1=gaStepHtml(true,'Шаг 1. Ключи приняты',`<div class="hint">Инстанс № ${esc(s.instance||'—')}</div>`);

  // --- шаг 2: вебхук ---
  let b2;
  if(s.settings_error)b2=`<div class="hint" style="color:var(--rust)">Настройки инстанса не прочитались: ${esc(s.settings_error)}</div>`;
  else if(s.hook_ok)b2='<div class="hint">Входящие, ваши ответы с телефона и отметки «доставлено / прочитано» приходят в CRM сами.</div>';
  else b2=`<div class="hint">${s.hook_other
      ?'Сейчас сообщения этого инстанса уходят <b>на другой адрес</b>. Кнопка переключит их на CRM — прежний получатель перестанет их получать.'
      :'Пока это не сделано, входящие сообщения в CRM не попадают.'}
      Green API при этом перезапускает инстанс: настройки вступают в силу в течение пяти минут.</div>
    ${canCfg?`<button class="btn primary sm" data-gaact="setup" style="margin-top:8px"${gaBusy?' disabled':''}>${gaBusy==='setup'?'Настраиваю…':'Настроить приём сообщений'}</button>`
      :'<div class="hint">Настроить может тот, у кого право «WhatsApp Ассистент приёма заявок → редактирование».</div>'}`;
  const step2=gaStepHtml(!!s.hook_ok,'Шаг 2. Приём сообщений'+(s.hook_ok?' настроен':''),b2);

  // --- шаг 3: телефон ---
  let b3, ok3=false;
  if(s.state==='authorized'){
    ok3=true;
    b3=`<div class="hint">Номер: <b>${esc(s.phone?gaPhoneText(s.phone+'@c.us'):'—')}</b>. Телефон должен оставаться включённым и в сети, иначе сообщения встанут в очередь.</div>
      ${canCfg?`<button class="btn ghost sm" data-gaact="logout" style="margin-top:8px"${gaBusy?' disabled':''}>${gaBusy==='logout'?'Отвязываю…':'Отвязать телефон'}</button>`:''}`;
  }else if(s.state==='notAuthorized'){
    if(gaQr){
      b3=`<div class="ga-qr">
          ${gaQr.img?`<img src="data:image/png;base64,${esc(gaQr.img)}" alt="QR-код для привязки WhatsApp">`:'<div class="ga-qr-wait">Получаем QR-код…</div>'}
          <div class="ga-qr-how">
            <b>На телефоне с рабочим номером:</b>
            <ol class="ga-ol"><li>Откройте WhatsApp.</li><li>Настройки → «Связанные устройства».</li><li>«Привязка устройства» и наведите камеру на код.</li></ol>
            <div class="hint">Код обновляется сам каждые несколько секунд.${gaQr.note?'<br><span style="color:var(--rust)">'+esc(gaQr.note)+'</span>':''}</div>
            <button class="btn ghost sm" data-gaact="qrstop" style="margin-top:8px">Скрыть код</button>
          </div>
        </div>`;
    }else{
      b3=`<div class="hint">Привяжите телефон с рабочим номером WhatsApp — по QR-коду, как WhatsApp Web.</div>
        ${canCfg?'<button class="btn primary sm" data-gaact="qr" style="margin-top:8px">Показать QR-код</button>'
          :'<div class="hint">Привязать может тот, у кого право «WhatsApp Ассистент приёма заявок → редактирование».</div>'}`;
    }
  }else if(s.state==='starting'){
    b3=`<div class="hint">Инстанс запускается — обычно до пяти минут (так бывает после смены настроек). Страница проверит сама.</div><div style="margin-top:8px">${again}</div>`;
  }else{
    b3=`<div class="hint" style="color:var(--rust)">${esc(gaStateRu(s.state))}. Это состояние на стороне WhatsApp или Green API — подробности в личном кабинете Green API.</div><div style="margin-top:8px">${again}</div>`;
  }
  const step3=gaStepHtml(ok3,'Шаг 3. '+(ok3?'Телефон привязан':'Привязка телефона'),b3);
  const ready=s.hook_ok&&ok3
    ?'<div class="ga-ready">Всё готово: переписка идёт во вкладке «Диалоги».</div>':'';
  return intro+step1+step2+step3+ready;
}

function gaConnRedraw(){
  const box=$('gaBox');if(!box||gaSub!=='connect')return;
  box.innerHTML='<div class="ga-conn">'+gaConnHtml()+'</div>';
  box.querySelectorAll('[data-gaact]').forEach(b=>b.onclick=()=>gaConnAct(b.dataset.gaact));
}

async function gaConnAct(act){
  if(act==='recheck'){gaConnRedraw();await gaStateLoad();return;}
  if(act==='qr'){gaQrStart();return;}
  if(act==='qrstop'){gaQrStop();gaConnRedraw();return;}
  if(gaBusy)return;
  if(act==='logout'&&!confirm('Отвязать телефон от Green API?\n\nПереписка через этот модуль остановится, пока телефон не привяжут заново по QR-коду. Сообщения в самом WhatsApp на телефоне никуда не денутся.'))return;
  gaBusy=act;gaConnRedraw();
  const res=await gaCall(act);
  gaBusy='';
  if(!res||res.error||!res.ok){
    toast((act==='setup'?'Не настроилось: ':'Не получилось: ')+String((res&&res.error)||'сервер не ответил'));
    gaConnRedraw();return;
  }
  toast(act==='setup'?'Настройки отправлены — Green API применит их в течение пяти минут':'Телефон отвязан');
  await gaStateLoad();
}

/* QR-КОД ОБНОВЛЯЕМ САМИ: у Green API он живёт двадцать секунд. Крутим не дольше трёх
   минут и только пока открыта эта вкладка — забытая страница иначе дёргала бы чужой
   сервис всю ночь. */
function gaQrStop(){
  if(gaQrTimer){clearTimeout(gaQrTimer);gaQrTimer=null;}
  gaQr=null;
}
function gaQrStart(){
  gaQrStop();
  gaQr={img:'',note:'',at:Date.now()};
  gaConnRedraw();
  gaQrStep();
}
async function gaQrStep(){
  const mine=gaQr;
  if(!mine)return;
  if(S.tab!=='greenapi'||gaSub!=='connect'){gaQrStop();return;}
  if(Date.now()-mine.at>GA_QR_MAX){
    gaQrStop();gaConnRedraw();
    toast('QR-код больше не обновляется — нажмите «Показать QR-код» ещё раз');
    return;
  }
  const r=await gaCall('qr');
  if(gaQr!==mine)return;                       // пока ждали ответ, код скрыли
  if(!r||r.error){mine.note=String((r&&r.error)||'сервер не ответил');}
  else if(r.type==='qrCode'){mine.img=String(r.message||'');mine.note='';}
  else if(r.type==='alreadyLogged'||(r.type==='error'&&/auth|log ?out/i.test(String(r.message||'')))){
    // телефон уже привязан — код больше не нужен, показываем новое состояние
    gaQrStop();
    await gaStateLoad();
    toast('Телефон привязан');
    return;
  }
  else mine.note=r.type==='timeout'?'Green API не успел выдать код — пробуем ещё раз':String(r.message||r.type||'');
  gaConnRedraw();
  gaQrTimer=setTimeout(gaQrStep,GA_QR_STEP);
}

/* ---------- перерисовка и обработчики ---------- */

function gaSyncText(){
  const t=gaLastSync?new Date(gaLastSync):null;
  const hh=t?String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0'):'—';
  if(gaRtSeen)return '⚡ в реальном времени · сверка '+hh;
  return 'обновление раз в 20 с · последнее '+hh;
}

function gaHeadNums(){
  const c=gaCounters();
  const one=(n,l,col)=>`<span class="wam-num"><b style="color:${col}">${n}</b> ${esc(l)}</span>`;
  return `<div class="wam-nums" id="gaNums">
    ${one(c.wait,'ждут ответа','#b45309')}
    ${one(c.today,'входящих сегодня','#16a34a')}
    ${one(c.dialogs,'диалогов в списке','var(--muted)')}
  </div>`;
}

/* Перерисовка БЕРЕЖЁТ РАБОТУ ЧЕЛОВЕКА: фокус с кареткой в ответе и в поиске, и место
   прокрутки — вниз подкручиваем, только если он и так смотрел конец переписки. */
function gaRedraw(){
  if(gaSub!=='dialogs')return;
  const box=$('gaBox');if(!box)return;
  const ta=$('gaText'), sIn=$('gaSearch'), sc=$('gaScroll');
  const taFocus=!!(ta&&document.activeElement===ta);
  const sFocus=!!(sIn&&document.activeElement===sIn);
  const atBottom=sc?(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-40):gaStick;
  const keepTop=sc?sc.scrollTop:0;
  box.innerHTML=gaBodyHtml();
  gaBind();
  const ta2=$('gaText');
  if(ta2&&taFocus){ta2.focus();try{ta2.setSelectionRange(ta2.value.length,ta2.value.length);}catch(_e){}}
  const s2=$('gaSearch');
  if(s2&&sFocus){s2.focus();try{s2.setSelectionRange(s2.value.length,s2.value.length);}catch(_e){}}
  gaStick=atBottom;
  const sc2=$('gaScroll');
  if(sc2)sc2.scrollTop=atBottom?sc2.scrollHeight:keepTop;
  const sy=$('gaSync');if(sy)sy.textContent=gaSyncText();
  // числа стоят в ШАПКЕ, а перерисовываем мы только тело — обновляем их точечно
  const nm=$('gaNums');if(nm)nm.outerHTML=gaHeadNums();
}

function gaPutText(txt){
  const ta=$('gaText');
  if(!ta){toast('Ответить сейчас нельзя — см. подпись под перепиской');return;}
  ta.value=ta.value.trim()?ta.value.replace(/\s*$/,'')+'\n'+txt:txt;
  gaDrafts[gaChatId]=ta.value;
  ta.focus();
  try{ta.setSelectionRange(ta.value.length,ta.value.length);}catch(_e){}
}

function gaBind(){
  const main=$('main');if(!main)return;
  main.querySelectorAll('[data-waimg]').forEach(img=>{
    img.onload=()=>{const sc=$('gaScroll');if(sc&&gaStick)sc.scrollTop=sc.scrollHeight;};
    img.onerror=()=>{
      const a=img.parentElement;if(!a)return;
      a.classList.add('dead');
      a.textContent='📎 файл не открылся — нажмите, чтобы попробовать';
    };
  });
  main.querySelectorAll('[data-gadlg]').forEach(el=>el.onclick=()=>gaOpenDialog(el.dataset.gadlg));
  const back=$('gaBack');if(back)back.onclick=()=>{gaChatId='';gaChat=null;gaStick=true;gaRedraw();};
  const scb=$('gaScroll');
  if(scb)scb.onscroll=()=>{gaStick=scb.scrollTop+scb.clientHeight>=scb.scrollHeight-40;};
  const s=$('gaSearch');
  if(s)s.oninput=()=>{
    gaSearch=s.value;
    // перерисовываем ТОЛЬКО список, иначе фокус уходил бы из поля на каждой букве
    const lst=$('gaBox')&&$('gaBox').querySelector('.wam-list');
    if(lst){lst.innerHTML=gaListHtml();gaBind();}
  };
  main.querySelectorAll('[data-gafl]').forEach(b=>b.onclick=()=>{gaFilter=b.dataset.gafl;gaRedraw();});
  const sb2=$('gaSendBtn');if(sb2)sb2.onclick=gaSend;
  const ta=$('gaText');
  if(ta){
    ta.oninput=()=>{gaDrafts[gaChatId]=ta.value;};
    // Enter отправляет, Shift+Enter — перенос строки: так же, как в самом WhatsApp.
    ta.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();gaSend();}};
  }
  const dn=$('gaDone');if(dn)dn.onclick=()=>gaMarkDone(dn);
  const hs=$('gaHist');if(hs)hs.onclick=()=>gaHistory(hs);
  const ab=$('gaPauseBtn');if(ab)ab.onclick=()=>gaPauseToggle(ab);
  // заказ клиента — разметка модуля Kelesu, обработчики свои (рисуем и пишем в своё поле)
  main.querySelectorAll('[data-wapick]').forEach(b=>b.onclick=()=>{
    const o=(waModOrders||[]).find(x=>String(x.id)===b.dataset.wapick);
    if(o){waModOrdPick=o.id;gaRedraw();}
  });
  main.querySelectorAll('[data-waord]').forEach(b=>b.onclick=()=>waModOpenOrder(b.dataset.waord));
  // «Текст для клиента» и быстрый ответ ПОДСТАВЛЯЮТСЯ в поле, отправку нажимает человек.
  main.querySelectorAll('[data-wawhere]').forEach(b=>b.onclick=()=>{
    const o=(waModOrders||[]).find(x=>String(x.id)===b.dataset.wawhere);
    if(o)gaPutText(waModWhereText(o));
  });
  main.querySelectorAll('[data-waqr]').forEach(b=>b.onclick=()=>{
    const q=(waModQuick||[]).find(x=>String(x.id)===b.dataset.waqr);
    if(q)gaPutText(q.body);
  });
}

function renderGreen(){
  if(!canMod('greenapi')){
    $('main').innerHTML='<div class="empty"><div class="big">Нет доступа к этому разделу</div>Право выдаётся в «Сотрудники» → «Роли и права», столбец «Green API».</div>';
    return;
  }
  const subs=[['dialogs','Диалоги'],['assistant','ИИ ассистент'],['connect','Подключение']];
  if(!subs.some(x=>x[0]===gaSub))gaSub='dialogs';
  const canSend=can('greenapi','create');
  $('main').innerHTML=`
    <div class="page-head"><div><h1>WhatsApp Ассистент приёма заявок</h1></div>
      <div class="head-actions">
        ${gaSub==='dialogs'?`<span class="hint" id="gaSync" style="margin-right:10px">${esc(gaSyncText())}</span>`:''}
        ${gaPillHtml()}
        ${gaSub==='dialogs'&&canSend?'<button class="btn primary" id="gaNew" style="margin-left:8px">＋ Новый диалог</button>':''}
      </div>
    </div>
    <div class="filters wam-tabs" style="margin-bottom:14px">
      ${subs.map(([k,l])=>`<button class="btn ghost${gaSub===k?' active':''}" data-gasub="${k}">${esc(l)}</button>`).join('')}
      ${gaSub==='dialogs'?gaHeadNums():''}
    </div>
    <div class="panel"><div id="gaBox">${gaSub==='dialogs'?gaBodyHtml():''}</div></div>`;

  $('main').querySelectorAll('[data-gasub]').forEach(b=>b.onclick=()=>{
    if(gaSub==='connect'&&b.dataset.gasub!=='connect')gaQrStop();
    gaSub=b.dataset.gasub;
    renderGreen();
  });
  const nw=$('gaNew');if(nw)nw.onclick=gaNewDialog;

  if(gaSub==='connect'){
    gaConnRedraw();
    if(!gaState||Date.now()-gaStateAt>15000)gaStateLoad();
  }else if(gaSub==='assistant'){
    // вкладку рисует js/31; он подключён позже, поэтому зовём по имени в момент вызова
    if(typeof gaAiRender==='function')gaAiRender();
  }else{
    gaBind();
    const sc=$('gaScroll');if(sc&&gaStick)sc.scrollTop=sc.scrollHeight;
    // Первая загрузка — лениво и только по заходу в модуль, как у модуля Kelesu.
    if(gaRows===null)gaLoad().then(()=>{gaLastSync=Date.now();gaRedraw();}).catch(()=>{});
    if(typeof waModQuick!=='undefined'&&waModQuick===null&&typeof waModQuickLoad==='function')
      waModQuickLoad().then(gaRedraw).catch(()=>{});
    if(!gaState)gaStateLoad();
  }
  gaRtStart();
  gaStartPoll();
}
