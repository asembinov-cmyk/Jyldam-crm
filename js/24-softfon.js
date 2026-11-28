/* ================= СОФТФОН: звонки прямо в CRM =================
   Кнопка телефона в правом нижнем углу — у тех, кто заведён во вкладке «Операторы»
   раздела «Телефония» и у кого включено «Принимает звонки в CRM».

   КАК ЭТО УСТРОЕНО. Голос идёт из браузера на свою АТС (ats.jyldam-crm.kz) по WebRTC.
   Данные внутреннего номера CRM просит у МОСТА на том же сервере, предъявляя токен входа:
   мост проверяет его у Supabase и смотрит tel_operators этим же токеном. В самой CRM
   пароля номера нет нигде — ни в коде, ни в базе, ни в localStorage; он живёт в памяти
   вкладки, пока человек на линии.

   БИБЛИОТЕКА JsSIP ГРУЗИТСЯ ЛЕНИВО — только когда оператор выходит на линию. В index.html
   её нет намеренно: это 240 КБ, а складу и курьерам они не нужны вовсе. Версия закреплена
   и сверяется по отпечатку (integrity): подменённый файл браузер просто не выполнит.

   БЕЗ ОПЕРАТОРА СВЯЗИ звонить можно только внутри: коллеге по его номеру, 600 — проверка
   звука, 601 — точное время. Наружу АТС ответит отказом, пока не подключён транк. */

const SF_BRIDGE  = 'https://ats.jyldam-crm.kz';
const SF_LIB     = 'https://cdnjs.cloudflare.com/ajax/libs/jssip/3.12.0/jssip.min.js';
const SF_LIB_SRI = 'sha384-1P/fuQbgbz98q82MgmDK/GNKqtF5Oq2T7xE3e7T3wJwcNFpQGILcaDpJuTgHrDCt';
const SF_AUTO_KEY= 'sfOnline';   // «был на линии» — чтобы после перезагрузки страницы вернуться самому

let sfOp=null;        // строка tel_operators текущего сотрудника
let sfUA=null;
let sfState='off';    // off | connecting | online | error
let sfErr='';
let sfDomain='';
let sfSession=null;
let sfCall='';        // '' | in | out | talk
let sfPeer='';        // с кем разговор — как показать
let sfNote='';        // чем закончился прошлый звонок
let sfOpen=false;
let sfMuted=false;
let sfKeys=false;     // показана ли клавиатура тонового набора
let sfNum='';         // что набрано в поле
let sfStart=0;
let sfTimer=null;
let sfAudioCtx=null;
let sfToneTimer=null;
let sfToneNodes=null;

function sfLsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function sfLsSet(k,v){try{v===null?localStorage.removeItem(k):localStorage.setItem(k,v);}catch(e){}}

/* ---------- Запуск ---------- */

// Зовётся из enterApp после входа. Курьеру и складу кнопка не рисуется вовсе.
async function sfBoot(){
  cbBoot();       // обратный звонок от права «Телефония» не зависит — он для курьеров
  if(sfOp||!S.me||!canMod('telephony'))return;
  try{
    const {data,error}=await sb.from('tel_operators').select('extension,webrtc_enabled').eq('user_id',S.me.id).maybeSingle();
    if(error||!data||!data.webrtc_enabled)return;
    sfOp=data;
  }catch(e){return;}
  sfMount();
  // Был на линии до перезагрузки — возвращаемся сами. Микрофон для этого не нужен:
  // его браузер спросит только при первом звонке.
  if(sfLsGet(SF_AUTO_KEY)==='1')sfGoOnline();
}

// Выход из CRM и закрытие вкладки: уходим с линии, иначе АТС до истечения регистрации
// будет считать человека доступным и звонить в никуда.
function sfShutdown(){
  sfStopTone();
  try{if(sfSession)sfSession.terminate();}catch(e){}
  try{if(sfUA)sfUA.stop();}catch(e){}
  sfUA=null;sfSession=null;sfCall='';sfState='off';sfOp=null;
  const r=document.getElementById('sfRoot');if(r)r.remove();
}
window.addEventListener('pagehide',()=>{try{if(sfUA)sfUA.stop();}catch(e){}});

function sfMount(){
  if(document.getElementById('sfRoot'))return;
  const r=document.createElement('div');
  r.id='sfRoot';
  r.innerHTML='<audio id="sfAudio" autoplay playsinline></audio><div id="sfBox"></div>';
  document.body.appendChild(r);
  sfRender();
}

/* ---------- Связь с АТС ---------- */

function sfLoadLib(){
  return new Promise((res,rej)=>{
    if(window.JsSIP)return res();
    const s=document.createElement('script');
    s.src=SF_LIB;s.integrity=SF_LIB_SRI;s.crossOrigin='anonymous';
    s.onload=()=>window.JsSIP?res():rej(new Error('библиотека звонков не загрузилась'));
    s.onerror=()=>rej(new Error('библиотека звонков не загрузилась — проверьте интернет'));
    document.head.appendChild(s);
  });
}

async function sfFetchCreds(){
  const ask=async()=>{
    const {data}=await sb.auth.getSession();
    const token=data&&data.session&&data.session.access_token;
    if(!token)throw new Error('вход в CRM истёк — обновите страницу и войдите заново');
    let r;
    try{
      r=await fetch(SF_BRIDGE+'/api/softphone/credentials',{method:'POST',headers:{Authorization:'Bearer '+token}});
    }catch(e){throw new Error('сервер телефонии не отвечает');}
    let j={};try{j=await r.json();}catch(e){}
    return {status:r.status,j};
  };
  let a=await ask();
  // Токен входа живёт около часа. Отказ 401 — один раз обновляем сессию и спрашиваем снова,
  // как это делает callEdge для Edge-функций.
  if(a.status===401){try{await sb.auth.refreshSession();}catch(e){}a=await ask();}
  if(a.status!==200||!a.j.password)throw new Error(a.j.message||('сервер телефонии ответил '+a.status));
  return a.j;
}

async function sfGoOnline(){
  if(sfState==='connecting'||sfState==='online')return;
  sfState='connecting';sfErr='';sfRender();
  try{
    await sfLoadLib();
    const c=await sfFetchCreds();
    sfDomain=c.domain;
    const socket=new JsSIP.WebSocketInterface(c.ws);
    const ua=new JsSIP.UA({
      sockets:[socket],
      uri:'sip:'+c.extension+'@'+c.domain,
      password:c.password,
      display_name:c.name||undefined,
      register:true,
      register_expires:300,
      session_timers:false,
      user_agent:'Jyldam CRM',
      connection_recovery_min_interval:2,
      connection_recovery_max_interval:30,
    });
    ua.on('registered',()=>{sfState='online';sfErr='';sfRender();});
    ua.on('unregistered',()=>{if(sfUA===ua&&sfState==='online'){sfState='connecting';sfRender();}});
    ua.on('registrationFailed',e=>{
      if(sfUA!==ua)return;
      sfState='error';
      sfErr='АТС не приняла номер'+(e&&e.cause?' ('+e.cause+')':'');
      sfRender();
    });
    // Связь оборвалась — библиотека переподключается сама; показываем это честно,
    // а не оставляем зелёную точку у человека, до которого сейчас не дозвониться.
    ua.on('disconnected',()=>{if(sfUA===ua&&sfState==='online'){sfState='connecting';sfRender();}});
    ua.on('newRTCSession',e=>sfOnSession(e));
    sfUA=ua;
    ua.start();
    sfLsSet(SF_AUTO_KEY,'1');
  }catch(e){
    sfState='error';
    sfErr=String(e&&e.message||e);
    sfRender();
  }
}

function sfGoOffline(){
  sfLsSet(SF_AUTO_KEY,null);
  sfStopTone();
  try{if(sfSession)sfSession.terminate();}catch(e){}
  try{if(sfUA)sfUA.stop();}catch(e){}
  sfUA=null;sfSession=null;sfCall='';sfState='off';sfErr='';
  sfRender();
}

/* ---------- Звонок ---------- */

const SF_PC={iceServers:[]};   // у АТС белый адрес — посредники для связи не нужны

function sfAttachAudio(pc){
  if(!pc)return;
  pc.addEventListener('track',ev=>{
    const a=document.getElementById('sfAudio');
    if(a&&ev.streams&&ev.streams[0]){a.srcObject=ev.streams[0];const p=a.play();if(p&&p.catch)p.catch(()=>{});}
  });
}

const SF_CAUSE_RU={
  'Busy':'занято','Rejected':'отклонён','Canceled':'отменён','No Answer':'не отвечает',
  'Unavailable':'недоступен','Not Found':'такого номера нет','Address Incomplete':'номер набран не полностью',
  'User Denied Media Access':'браузер не дал доступ к микрофону — разрешите его для этого сайта',
  'Request Timeout':'нет ответа от АТС','Connection Error':'связь с АТС оборвалась',
  'SIP Failure Code':'АТС отказала в звонке','Terminated':'завершён',
};

function sfBindSession(s){
  sfSession=s;sfMuted=false;sfKeys=false;sfNote='';
  s.on('progress',()=>{if(sfSession===s&&sfCall==='out'&&!sfToneNodes)sfTone('back');});
  const talk=()=>{
    if(sfSession!==s||sfCall==='talk')return;
    sfStopTone();sfCall='talk';sfStart=Date.now();
    clearInterval(sfTimer);sfTimer=setInterval(sfTickTimer,1000);
    sfRender();
  };
  s.on('accepted',talk);
  s.on('confirmed',talk);
  const done=e=>{
    if(sfSession!==s)return;
    sfStopTone();clearInterval(sfTimer);sfTimer=null;
    const wasTalk=sfCall==='talk';
    sfSession=null;sfCall='';
    const cause=e&&e.cause;
    // После обычного разговора причину не пишем: «завершён» и так видно.
    sfNote=wasTalk?'':('Звонок не состоялся: '+(SF_CAUSE_RU[cause]||cause||'нет соединения'));
    const a=document.getElementById('sfAudio');if(a)a.srcObject=null;
    sfRender();
  };
  s.on('ended',done);
  s.on('failed',done);
}

function sfOnSession(e){
  const s=e.session;
  if(e.originator!=='remote')return;             // исходящий привязываем в sfDial
  if(sfSession){try{s.terminate({status_code:486});}catch(x){}return;}   // второй входящий — «занято»
  const ri=s.remote_identity||{};
  const num=(ri.uri&&ri.uri.user)||'';
  sfPeer=(ri.display_name&&ri.display_name!==num?ri.display_name+' · ':'')+num;
  sfCall='in';
  s.on('peerconnection',ev=>sfAttachAudio(ev.peerconnection));
  sfBindSession(s);
  sfOpen=true;
  sfTone('ring');
  sfRender();
}

/* ЗАКАЗ, ИЗ КАРТОЧКИ КОТОРОГО ЗВОНЯТ. Номер подставляется кнопкой «Позвонить» в карточке;
   если человек наберёт этот же номер руками из панели — заказ всё равно привяжется.
   Станции заказ уходит заголовком X-Jy-Order: по нему звонок и запись попадают в «Историю». */
let sfCard=null;      // {num:'7XXXXXXXXXX', orderId}
function sfDial(raw,opts){
  if(sfState!=='online'||sfSession)return;
  // Оставляем только то, что бывает в номере. Пробелы, скобки и дефисы человек вставляет
  // вместе с номером из карточки — их просто убираем.
  const num=String(raw||'').replace(/[^\d+*#]/g,'');
  if(!num){sfNote='Введите номер';sfRender();return;}
  sfPeer=num;sfCall='out';sfNote='';
  let orderId=(opts&&opts.orderId)||'';
  if(!orderId&&sfCard&&sfCard.num.slice(-10)===num.replace(/\D/g,'').slice(-10))orderId=sfCard.orderId||'';
  const hdr=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)?['X-Jy-Order: '+orderId.toLowerCase()]:[];
  let s;
  try{
    s=sfUA.call('sip:'+num+'@'+sfDomain,{
      extraHeaders:hdr,
      mediaConstraints:{audio:true,video:false},
      pcConfig:SF_PC,
      rtcOfferConstraints:{offerToReceiveAudio:true,offerToReceiveVideo:false},
    });
  }catch(e){sfCall='';sfNote='Не удалось начать звонок';sfRender();return;}
  sfBindSession(s);
  sfAttachAudio(s.connection);
  sfRender();
}

function sfAnswer(){
  if(!sfSession||sfCall!=='in')return;
  sfStopTone();
  try{sfSession.answer({mediaConstraints:{audio:true,video:false},pcConfig:SF_PC});}catch(e){}
}
function sfHangup(){
  sfStopTone();
  try{if(sfSession)sfSession.terminate();}catch(e){}
}
function sfToggleMute(){
  if(!sfSession||sfCall!=='talk')return;
  sfMuted=!sfMuted;
  try{sfMuted?sfSession.mute({audio:true}):sfSession.unmute({audio:true});}catch(e){}
  sfRender();
}
function sfSendKey(k){
  if(!sfSession||sfCall!=='talk')return;
  try{sfSession.sendDTMF(k,{transportType:'RFC2833'});}catch(e){}
}

function sfDur(){
  const n=Math.max(0,Math.floor((Date.now()-sfStart)/1000));
  return Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
}
// Тикает ОДНА строка, а не вся панель: полная перерисовка раз в секунду сбивала бы нажатия.
function sfTickTimer(){const el=document.getElementById('sfDur');if(el)el.textContent=sfDur();}

/* ---------- Гудки ---------- */

/* Звук вызова делаем сами, генератором: файла рингтона нет, а входящий без звука оператор
   просто не заметит. Браузер может не дать звук, пока человек ни разу не нажал на странице
   (после перезагрузки с автовозвратом на линию) — тогда остаётся мигающая кнопка. */
function sfTone(kind){
  sfStopTone();
  try{
    if(!sfAudioCtx)sfAudioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(sfAudioCtx.state==='suspended')sfAudioCtx.resume().catch(()=>{});
    const ctx=sfAudioCtx;
    const osc=ctx.createOscillator(), gain=ctx.createGain();
    osc.frequency.value=kind==='ring'?480:425;
    gain.gain.value=0;
    osc.connect(gain);gain.connect(ctx.destination);osc.start();
    sfToneNodes={osc,gain};
    const vol=kind==='ring'?0.18:0.07;
    // вызов: секунда звука, три тишины; гудок ожидания — как у обычной линии
    const on=1000, period=4000;
    const beat=()=>{
      if(!sfToneNodes)return;
      gain.gain.setValueAtTime(vol,ctx.currentTime);
      gain.gain.setValueAtTime(0,ctx.currentTime+on/1000);
    };
    beat();
    sfToneTimer=setInterval(beat,period);
  }catch(e){}
}
function sfStopTone(){
  clearInterval(sfToneTimer);sfToneTimer=null;
  if(sfToneNodes){try{sfToneNodes.osc.stop();sfToneNodes.osc.disconnect();sfToneNodes.gain.disconnect();}catch(e){}sfToneNodes=null;}
}

/* ---------- Отрисовка ---------- */

const SF_ICON='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.6 3.5h2.2c.4 0 .8.3.9.7l.8 3.1c.1.4 0 .8-.3 1L8.7 9.6a11.5 11.5 0 005.7 5.7l1.3-1.5c.3-.3.7-.4 1-.3l3.1.8c.4.1.7.5.7.9v2.2c0 1.1-.9 2.1-2.1 2.1C10.8 19.5 4.5 13.2 4.5 5.6c0-1.2 1-2.1 2.1-2.1z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function sfStateText(){
  if(sfState==='online')return 'На линии';
  if(sfState==='connecting')return 'Подключаемся…';
  if(sfState==='error')return 'Нет связи';
  return 'Не на линии';
}

function sfPanelHtml(){
  const ext=sfOp?sfOp.extension:'';
  let body='';
  if(sfCall==='in'){
    body=`<div class="sf-peer">${esc(sfPeer||'неизвестный')}</div>
      <div class="sf-sub">Входящий звонок</div>
      <div class="sf-row">
        <button type="button" class="sf-btn sf-ok" data-sf="answer">Ответить</button>
        <button type="button" class="sf-btn sf-no" data-sf="hangup">Отклонить</button>
      </div>`;
  }else if(sfCall==='out'){
    body=`<div class="sf-peer">${esc(sfPeer)}</div>
      <div class="sf-sub">Вызов…</div>
      <div class="sf-row"><button type="button" class="sf-btn sf-no" data-sf="hangup">Отменить</button></div>`;
  }else if(sfCall==='talk'){
    const keys=['1','2','3','4','5','6','7','8','9','*','0','#'];
    body=`<div class="sf-peer">${esc(sfPeer)}</div>
      <div class="sf-sub">Разговор · <span id="sfDur">${sfDur()}</span>${sfMuted?' · микрофон выключен':''}</div>
      <div class="sf-row">
        <button type="button" class="sf-btn${sfMuted?' sf-on':''}" data-sf="mute">${sfMuted?'Включить микрофон':'Выключить микрофон'}</button>
        <button type="button" class="sf-btn" data-sf="keys">Клавиши</button>
      </div>
      ${sfKeys?`<div class="sf-keys">${keys.map(k=>`<button type="button" data-sfkey="${k}">${k}</button>`).join('')}</div>`:''}
      <div class="sf-row"><button type="button" class="sf-btn sf-no" data-sf="hangup">Завершить</button></div>`;
  }else if(sfState==='online'){
    body=`<div class="sf-dial">
        <input id="sfNum" type="tel" inputmode="tel" autocomplete="off" placeholder="Номер" value="${esc(sfNum)}">
        <button type="button" class="sf-btn sf-ok" data-sf="dial">Позвонить</button>
      </div>
      ${sfNote?`<div class="sf-note">${esc(sfNote)}</div>`:''}
      <div class="sf-hint">Коллеге — его внутренний номер. 600 — проверка звука, 601 — точное время.</div>`;
  }else{
    body=`${sfErr?`<div class="sf-note">${esc(sfErr)}</div>`:''}
      <div class="sf-hint">${sfState==='connecting'?'Соединяемся с сервером телефонии…'
        :'Пока вы не на линии, звонки к вам не приходят.'}</div>`;
  }
  const toggle=sfCall?'':(sfState==='off'||sfState==='error'
    ? '<button type="button" class="sf-btn sf-ok sf-wide" data-sf="on">Выйти на линию</button>'
    : '<button type="button" class="sf-btn sf-wide" data-sf="off">Уйти с линии</button>');
  return `<div class="sf-panel" role="dialog" aria-label="Телефон">
      <div class="sf-head">
        <span class="sf-dot sf-${sfState}"></span>
        <b>Телефон${ext?' · '+esc(ext):''}</b>
        <span class="sf-state">${esc(sfStateText())}</span>
        <button type="button" class="sf-x" data-sf="close" aria-label="Свернуть">×</button>
      </div>
      <div class="sf-body">${body}${toggle}</div>
    </div>`;
}

function sfRender(){
  const box=document.getElementById('sfBox');
  if(!box)return;
  // Поле номера может быть в фокусе: запоминаем набранное и каретку, чтобы перерисовка
  // от события АТС не стёрла полномера.
  const cur=document.getElementById('sfNum');
  const hadFocus=cur&&document.activeElement===cur;
  if(cur)sfNum=cur.value;
  const fabCls='sf-fab sf-'+sfState+(sfCall==='in'?' sf-ringing':'')+(sfCall?' sf-incall':'');
  const title='Телефон — '+sfStateText().toLowerCase();
  box.innerHTML=(sfOpen?sfPanelHtml():'')
    +`<button type="button" class="${fabCls}" data-sf="toggle" title="${esc(title)}" aria-label="${esc(title)}">${SF_ICON}<span class="sf-dot sf-${sfState}"></span></button>`;
  document.getElementById('sfRoot').classList.toggle('sf-busy',!!sfCall);
  const inp=document.getElementById('sfNum');
  if(inp){
    inp.oninput=()=>{sfNum=inp.value;};
    inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();sfNum=inp.value;sfDial(sfNum);}};
    if(hadFocus){inp.focus();try{inp.setSelectionRange(inp.value.length,inp.value.length);}catch(e){}}
  }
}

// Один слушатель на всё: панель перерисовывается часто, и вешать обработчики на каждую
// кнопку заново незачем (тот же приём, что у кнопки «скопировать»).
document.addEventListener('click',e=>{
  const key=e.target.closest&&e.target.closest('#sfRoot [data-sfkey]');
  if(key){sfSendKey(key.dataset.sfkey);return;}
  const b=e.target.closest&&e.target.closest('#sfRoot [data-sf]');
  if(!b)return;
  const a=b.dataset.sf;
  if(a==='toggle'){sfOpen=!sfOpen;sfRender();if(sfOpen){const i=document.getElementById('sfNum');if(i)i.focus();}}
  else if(a==='close'){sfOpen=false;sfRender();}
  else if(a==='on')sfGoOnline();
  else if(a==='off')sfGoOffline();
  else if(a==='dial'){const i=document.getElementById('sfNum');sfDial(i?i.value:sfNum);}
  else if(a==='answer')sfAnswer();
  else if(a==='hangup')sfHangup();
  else if(a==='mute')sfToggleMute();
  else if(a==='keys'){sfKeys=!sfKeys;sfRender();}
});

/* ================= ОБРАТНЫЙ ЗВОНОК =================
   Решение владельца 23.11.2026 для курьеров: кнопка в карточке → станция звонит САМОМУ
   сотруднику на мобильный → он берёт трубку → станция набирает клиента и соединяет.
   Клиент видит номер компании, разговор пишется, приложение ставить не нужно.

   Телефон в браузере (всё, что выше в этом файле) курьеру не годится: погас экран —
   оборвался WebSocket. А здесь от браузера нужен один запрос, дальше всё делает станция.

   НОМЕРА В ЗАПРОСЕ НЕТ — уходит только id заказа или заявки. Свой номер и номер клиента мост
   достаёт из базы сам и токеном вызывающего: иначе это был бы бесплатный телефон «звони
   куда хочешь за счёт компании».

   КНОПКИ НЕТ, ПОКА НЕТ ЛИНИИ. Мост отвечает на /api/call/status, готова ли линия оператора
   связи; до этого кнопка не рисуется вовсе — кнопка, которая не может сработать, хуже её
   отсутствия. Подключили линию — она появится сама, без выкладки CRM. */
let cbReady=null;                 // null — ещё не спрашивали
async function cbBoot(){
  if(cbReady!==null)return;
  cbReady=false;
  try{
    const r=await fetch(SF_BRIDGE+'/api/call/status');
    const j=await r.json();
    cbReady=!!(j&&j.callback);
  }catch(e){cbReady=false;}
  // Карточки уже нарисованы без кнопки — перерисуем, если линия есть и человек не занят.
  if(cbReady&&typeof render==='function'&&typeof canAutoRefresh==='function'&&canAutoRefresh())render();
}
// kind: 'order' | 'pickup'
function cbBtn(kind,id){
  if(!cbReady||!id)return '';
  return `<button type="button" class="cb-btn" data-cb="${kind}:${esc(id)}" title="Станция позвонит вам и соединит с клиентом">📞 Позвонить через станцию</button>`;
}
async function cbCall(btn){
  const [kind,id]=String(btn.dataset.cb||'').split(':');
  if(!id||btn.disabled)return;
  btn.disabled=true;
  const was=btn.textContent;btn.textContent='Соединяем…';
  // 8 секунд — столько же держит мост: двойное нажатие не должно поднять два звонка клиенту
  setTimeout(()=>{btn.disabled=false;btn.textContent=was;},8000);
  try{
    const {data:sess}=await sb.auth.getSession();
    const token=sess&&sess.session?sess.session.access_token:'';
    const r=await fetch(SF_BRIDGE+'/api/call/callback',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify(kind==='pickup'?{pickup_id:id}:{order_id:id})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok){toast((j&&j.message)||'Не получилось позвонить — попробуйте ещё раз',6000);return;}
    toast(j.message||'Сейчас вам позвонит станция — возьмите трубку',6000);
    // След в журнале: кто и по какому заказу звонил. Сам разговор пишет станция.
    if(typeof logAction==='function')logAction('call',kind==='pickup'?'pickups':'orders',{entity_id:id,entity_label:'обратный звонок через станцию'});
  }catch(e){toast('Нет связи с сервером телефонии',5000);}
}
// Один слушатель на страницу и в фазе ПЕРЕХВАТА: кнопка живёт внутри карточки, у которой
// свой обработчик раскрытия, — без остановки всплытия нажатие заодно раскрывало бы её.
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('[data-cb]');
  if(!b)return;
  e.preventDefault();e.stopPropagation();
  cbCall(b);
},true);

/* ================= «ПОЗВОНИТЬ» В КАРТОЧКЕ ЗАКАЗА (28.11.2026) =================
   Одна кнопка на все разделы: «Заказы заборов», Барахолка, SPA трафик. Номер берётся из
   карточки, набирать ничего не нужно.
   • Сотрудник с телефоном в CRM (есть во вкладке «Операторы») — звонок идёт из браузера.
   • Остальные, в первую очередь курьеры, — обратный звонок: станция звонит человеку на
     мобильный и соединяет с клиентом. Клиент в обоих случаях видит номер компании.
   Кнопки нет вовсе, если человеку звонить нечем: ни телефона в CRM, ни линии. */
function callAvailable(){return !!sfOp||!!cbReady;}
// field — id поля с телефоном: тогда берём то, что в нём набрано СЕЙЧАС, а не сохранённое.
function callBtn(phone,orderId,field){
  if(!callAvailable())return '';
  const d=typeof phoneStored==='function'?phoneStored(String(phone||'')):String(phone||'').replace(/\D/g,'').slice(-10);
  if(!d&&!field)return '';
  return `<button type="button" class="call-btn" data-call="${esc(d)}" data-callorder="${esc(orderId||'')}"${field?` data-callfield="${esc(field)}"`:''} title="Позвонить клиенту">${SF_ICON}<span>Позвонить</span></button>`;
}
async function callFromCard(btn){
  let raw=btn.dataset.call||'';
  if(btn.dataset.callfield){
    const f=document.getElementById(btn.dataset.callfield);
    const live=f?(f.dataset.phone||f.value||''):'';
    if(String(live).replace(/\D/g,'').length)raw=live;
  }
  const d=String(raw).replace(/\D/g,'');
  const num=d.length===10?d:(d.length===11&&(d[0]==='7'||d[0]==='8')?d.slice(1):'');
  if(!num){toast('В карточке нет номера телефона или он записан не полностью',5000);return;}
  const orderId=btn.dataset.callorder||'';
  if(sfOp){
    sfCard={num:'7'+num,orderId};
    sfNum='7'+num;sfOpen=true;
    if(sfSession){sfRender();toast('Сначала завершите текущий разговор');return;}
    if(sfState!=='online'){sfRender();toast('Номер подставлен. Нажмите «Выйти на линию», затем «Позвонить»',6000);return;}
    sfDial('7'+num,{orderId});
    return;
  }
  if(cbReady&&orderId){
    btn.dataset.cb='order:'+orderId;
    await cbCall(btn);
    delete btn.dataset.cb;
    return;
  }
  toast('Звонки из CRM вам не подключены — попросите администратора добавить вас в «Телефония» → «Операторы»',7000);
}
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('[data-call]');
  if(!b)return;
  e.preventDefault();e.stopPropagation();
  callFromCard(b);
},true);

/* ЗАПИСЬ РАЗГОВОРА. Файл лежит на сервере станции; мост отдаёт его только сотруднику,
   которому база разрешила слушать. Поэтому качаем с токеном входа и играем из памяти,
   а не ссылкой — ссылку можно было бы переслать кому угодно. */
function telRecBtn(callId){
  return `<button type="button" class="rec-btn" data-rec="${esc(callId)}" title="Прослушать запись разговора">▶ Слушать</button>`;
}
async function telRecPlay(btn){
  const id=btn.dataset.rec;
  if(!id||btn.disabled)return;
  btn.disabled=true;const was=btn.textContent;btn.textContent='Загружаю…';
  try{
    const {data:sess}=await sb.auth.getSession();
    const token=sess&&sess.session?sess.session.access_token:'';
    const r=await fetch(SF_BRIDGE+'/api/call/rec?id='+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token}});
    if(!r.ok){
      const j=await r.json().catch(()=>({}));
      toast((j&&j.message)||'Запись не открылась',6000);
      btn.disabled=false;btn.textContent=was;return;
    }
    const url=URL.createObjectURL(await r.blob());
    const a=document.createElement('audio');
    a.controls=true;a.autoplay=true;a.src=url;a.className='rec-audio';
    btn.replaceWith(a);
  }catch(e){
    toast('Нет связи с сервером телефонии',5000);
    btn.disabled=false;btn.textContent=was;
  }
}
document.addEventListener('click',e=>{
  const b=e.target.closest&&e.target.closest('[data-rec]');
  if(!b)return;
  e.preventDefault();e.stopPropagation();
  telRecPlay(b);
},true);
