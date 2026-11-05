/* ================= МОДУЛЬ: WHATSAPP =================

   Просьба владельца 05.11.2026: «создай модуль Whatsapp и туда подтягивай все смс,
   которые приходят на номер — я хочу, чтобы менеджеры сидели через него, и там же
   пусть я вижу, кому робот ответил; Историю туда поставь».

   Две вкладки: «Диалоги» (вся переписка, ответ менеджера прямо отсюда) и «История
   робота» (кому автоответ ответил сам, а кого отдал человеку).

   ПОЧЕМУ ЭТО НЕ ПЕРЕНОС ПАНЕЛЕЙ, А ОТДЕЛЬНАЯ РАБОТА. Переписка растёт с каждым
   сообщением, и `select('*')` по ней делать НЕЛЬЗЯ: в `kelesu_messages` есть колонка
   `raw` — целый ответ Kelesu в jsonb на каждое сообщение. Поэтому поля всюду
   перечислены по именам, и `raw` среди них нет. Это ровно та ошибка, которую убрали
   из заказов 05.11.2026 (раздел «Фоновый опрос» в CLAUDE.md).

   ПЕРЕПИСКА НЕ ХОДИТ ПО REALTIME: канал `jyldam-live` подписан на `orders`, `pickups`
   и `inbound_orders`, а `kelesu_messages` в нём нет. Поэтому здесь свой опрос — но
   ТОЛЬКО пока модуль открыт и вкладка на экране (см. waModStartPoll). Добавить таблицу
   в публикацию Realtime было бы дешевле, но до выполнения такого SQL модуль не работал
   бы вовсе, а опрос работает сразу.

   ОТПРАВКА ОТСЮДА ВОЗМОЖНА ТОЛЬКО В ОКНЕ 24 ЧАСОВ. Свободный текст WhatsApp разрешает
   лишь тому, кто написал нам сам за последние сутки (иначе Meta отвечает 131047 и
   пускает только шаблон). Поэтому поле ответа ГАСНЕТ, когда окно закрыто, и прямо
   говорит почему — иначе менеджер писал бы в пустоту и получал непонятный отказ. */

const WA_MOD_PAGE   = 300;    // сообщений за один запрос списка диалогов
const WA_MOD_CHAT   = 200;    // сообщений в открытом диалоге
const WA_MOD_HIST   = 200;    // строк в истории робота
const WA_MOD_POLL_MS= 25000;  // опрос, пока модуль открыт
const WA_WINDOW_H   = 24;     // окно Meta для свободного текста

let waModSub='dialogs';   // dialogs | history | autoreply | broadcast
let waModRows=null;       // последние сообщения — из них собираются диалоги
let waModErr='';
let waModPhone='';        // открытый диалог (phone_norm)
let waModChat=null;       // сообщения открытого диалога
let waModChatErr='';
let waModSearch='';
let waModOnlyFlagged=false;
let waModHist=null;       // история разборов робота
let waModHistErr='';
let waModHistFilter='';   // '' | answered | flagged | failed
let waModStats=null;
let waModTimer=null;
let waModSending=false;
/* ЧЕРНОВИК ОТВЕТА ЖИВЁТ ПО НОМЕРАМ, а не в самом поле. Опрос перерисовывает
   переписку раз в 25 секунд и стёр бы набранное; а один черновик на всех уехал бы
   ЧУЖОМУ человеку при переключении диалога — это хуже потери текста. */
let waModDrafts={};

// поля перечислены по именам: `raw` в переписке — тяжёлый jsonb на каждое сообщение
const WA_MSG_COLS='id,phone,phone_norm,direction,body_text,message_type,created_at,status,ai_status,ai_intent,ai_note';

const WA_INTENT_RU={
  status:'где посылка',track:'трек-номер',when:'когда доставят',sum:'сколько платить',
  where_pickup:'где забрать',thanks:'благодарность',handoff:'вне скрипта',
};
const WA_OUTCOME_RU={
  answered:['ответил сам','#16a34a'],
  flagged:['отдал человеку','#b45309'],
  failed:['не удалось отправить','#dc2626'],
  done:['менеджер разобрал','#6b7280'],
  robot:['ответ робота','#16a34a'],
};

/* ---------- загрузка ---------- */

async function waModLoad(){
  waModErr='';
  try{
    const {data,error}=await sb.from('kelesu_messages').select(WA_MSG_COLS)
      .order('created_at',{ascending:false}).limit(WA_MOD_PAGE);
    if(error)throw error;
    waModRows=data||[];
  }catch(e){
    waModRows=[];
    waModErr=waModTableErr(e);
  }
}

async function waModChatLoad(norm){
  waModChatErr='';
  try{
    const {data,error}=await sb.from('kelesu_messages').select(WA_MSG_COLS)
      .eq('phone_norm',norm).order('created_at',{ascending:true}).limit(WA_MOD_CHAT);
    if(error)throw error;
    waModChat=data||[];
  }catch(e){
    waModChat=[];
    waModChatErr=waModTableErr(e);
  }
}

async function waModHistLoad(){
  waModHistErr='';
  try{
    // Историю строим по ВХОДЯЩИМ, которые робот разобрал: там и сам вопрос, и исход.
    // По его собственным ответам (`ai_status='robot'`) видно только текст ответа —
    // непонятно, на что он отвечал.
    const {data,error}=await sb.from('kelesu_messages')
      .select(WA_MSG_COLS+',ai_handled_at')
      .eq('direction','inbound').not('ai_handled_at','is',null)
      .order('ai_handled_at',{ascending:false}).limit(WA_MOD_HIST);
    if(error)throw error;
    waModHist=data||[];
  }catch(e){
    waModHist=[];
    waModHistErr=waModTableErr(e);
  }
  // Счётчики за сегодня — отдельными `head:true`: ни одной строки данных.
  try{
    const since=new Date(Date.now()-86400000).toISOString();
    const q=st=>sb.from('kelesu_messages').select('id',{count:'exact',head:true})
      .eq('direction','inbound').eq('ai_status',st).gte('ai_handled_at',since);
    const [a,f,x]=await Promise.all([q('answered'),q('flagged'),q('failed')]);
    waModStats={answered:a.count||0,flagged:f.count||0,failed:x.count||0};
  }catch(e){waModStats=null;}
}

// 42703/42P01 — нет колонки или таблицы: это «ещё не включено», а не поломка,
// и говорить надо именно так, с именем файла SQL.
function waModTableErr(e){
  const s=String(e&&(e.message||e.code)||e);
  if(/42P01|does not exist/i.test(s)&&/kelesu_messages/i.test(s))
    return 'Переписки нет в базе — таблица kelesu_messages ещё не создана';
  if(/42703|ai_status|ai_handled_at/i.test(s))
    return 'Автоответ ещё не включён — выполните db/58, блок 1';
  return 'Не удалось прочитать переписку: '+s;
}

/* ---------- опрос ---------- */

/* Опрос живёт ТОЛЬКО пока модуль открыт и вкладка на экране. Таймер снимается из
   самого render() — как плавающие панели пагинации: иначе он продолжал бы ходить в
   базу с других разделов и из свёрнутого окна. */
function waModStopPoll(){ if(waModTimer){clearInterval(waModTimer);waModTimer=null;} }

function waModStartPoll(){
  waModStopPoll();
  waModTimer=setInterval(async()=>{
    if(S.tab!=='whatsapp'||document.hidden)return;
    if(waModSending)return;              // не дёргаем экран, пока уходит сообщение
    if(waModSettingsSub())return;        // там нечего обновлять, а перерисовка сбила бы набранное
    if(waModSub==='history'){await waModHistLoad();waModRedraw();return;}
    await waModLoad();
    if(waModPhone)await waModChatLoad(waModPhone);
    waModRedraw();
  },WA_MOD_POLL_MS);
}

/* ---------- диалоги ---------- */

/* ОДИН НОМЕР — ОДИН ДИАЛОГ. Группируем по `phone_norm`: список отсортирован по
   убыванию даты, значит первое встреченное сообщение номера и есть последнее по
   времени. Диалоги идут в порядке свежести — так же, как в самом WhatsApp. */
function waModDialogs(){
  const by=new Map();
  (waModRows||[]).forEach(m=>{
    const key=String(m.phone_norm||'')||('id:'+m.id);
    let d=by.get(key);
    if(!d){d={norm:String(m.phone_norm||''),last:m,cnt:0,flagged:0,waiting:false};by.set(key,d);}
    d.cnt++;
    if(m.direction==='inbound'&&m.ai_status==='flagged')d.flagged++;
    by.set(key,d);
  });
  const list=[...by.values()];
  list.forEach(d=>{ d.waiting=d.last.direction==='inbound'; });
  return list;
}

function waModDialogsFiltered(){
  let list=waModDialogs();
  if(waModOnlyFlagged)list=list.filter(d=>d.flagged>0);
  const q=waModSearch.trim().toLowerCase();
  if(q){
    const digits=q.replace(/\D/g,'');
    list=list.filter(d=>
      (digits&&d.norm.includes(digits))||
      String(d.last.body_text||'').toLowerCase().includes(q));
  }
  return list;
}

/* ---------- окно 24 часа ---------- */

/* Считаем от последнего ВХОДЯЩЕГО: окно открывает сам клиент, а наши ответы его не
   продлевают. Часы берём серверные (nowMs) — сбитые часы на ноутбуке уже один раз
   делали разделы пустыми (раздел 8, syncServerTime). */
function waModWindow(msgs){
  const inb=(msgs||[]).filter(m=>m.direction==='inbound');
  if(!inb.length)return {open:false,left:0,never:true};
  const last=inb[inb.length-1];
  const t=Date.parse(last.created_at||'');
  if(!t)return {open:false,left:0,never:true};
  const now=typeof nowMs==='function'?nowMs():Date.now();
  const leftMs=t+WA_WINDOW_H*3600000-now;
  return {open:leftMs>0,left:Math.max(0,Math.round(leftMs/60000)),never:false,since:last.created_at};
}

function waModLeftText(min){
  if(min>=120)return Math.floor(min/60)+' ч';
  if(min>=60)return '1 ч '+(min-60)+' мин';
  return min+' мин';
}

/* ---------- отправка ---------- */

async function waModSend(){
  const ta=$('waModText');if(!ta)return;
  const text=String(ta.value||'').trim();
  if(!text){toast('Нечего отправлять');return;}
  if(!waModPhone){toast('Диалог не выбран');return;}
  const w=waModWindow(waModChat);
  if(!w.open){toast('Окно 24 часа закрыто — свободный текст Meta не пропустит');return;}
  const btn=$('waModSendBtn');
  waModSending=true;
  if(btn){btn.disabled=true;btn.textContent='Отправляю…';}
  if(ta)ta.disabled=true;
  try{
    // Отправка идёт через Edge Function kelesu-send: она проверяет вход сотрудника и
    // САМА пишет отправленное в kelesu_messages — поэтому после неё просто
    // перечитываем диалог, а не дописываем строку руками.
    const res=await callKelesuSend({phone:'7'+waModPhone,text});
    if(res&&res.error)throw new Error(res.error);
    ta.value='';
    delete waModDrafts[waModPhone];
    await waModChatLoad(waModPhone);
    await waModLoad();
    waModRedraw();
    toast('Отправлено');
  }catch(e){
    toast('Не отправлено: '+String(e&&e.message||e));
  }finally{
    waModSending=false;
    const b2=$('waModSendBtn');if(b2){b2.disabled=false;b2.textContent='Отправить';}
    const t2=$('waModText');if(t2){t2.disabled=false;t2.focus();}
  }
}

/* ---------- разметка ---------- */

function waModBubbles(){
  if(waModChat===null)return '<div class="hint">Загружаем переписку…</div>';
  if(waModChatErr)return `<div class="hint" style="color:var(--rust)">${esc(waModChatErr)}</div>`;
  if(!waModChat.length)return '<div class="hint">Переписки с этим номером нет</div>';
  let day='';
  return waModChat.map(m=>{
    const out=m.direction==='outbound';
    const t=(fmtLogTime(m.created_at)||{});
    let sep='';
    if(t.date&&t.date!==day){day=t.date;sep=`<div class="wam-day">${esc(day)}</div>`;}
    // Ответ робота отличаем от ответа человека: робот ставит себе ai_status='robot',
    // а kelesu-send (менеджер) не ставит ничего.
    const byRobot=out&&m.ai_status==='robot';
    const body=m.body_text||(m.message_type&&m.message_type!=='text'?'['+m.message_type+']':'—');
    return sep+`<div class="wam-row ${out?'out':'in'}">
      <div class="wam-bub ${out?'out':'in'}${byRobot?' bot':''}">
        ${byRobot?'<div class="wam-who">🤖 робот</div>':''}
        <div class="wam-txt">${esc(body)}</div>
        <div class="wam-meta">${esc(t.time||'')}${out&&m.status?' · '+esc(m.status):''}</div>
      </div>
    </div>`;
  }).join('');
}

function waModChatHtml(){
  if(!waModPhone)return `<div class="empty" style="padding:40px"><div class="big">Выберите диалог</div>Слева — все номера, которые нам писали.</div>`;
  const w=waModWindow(waModChat);
  const canSend=typeof can==='function'?can('whatsapp','create'):false;
  const head=`<div class="wam-chead">
    <button class="btn sm ghost wam-back" id="waModBack">← к списку</button>
    <div class="wam-ctitle">${esc(phoneDisplay('7'+waModPhone))}</div>
    <a class="btn sm ghost" target="_blank" rel="noopener" href="https://wa.me/7${esc(waModPhone)}">Открыть в WhatsApp</a>
  </div>`;
  let foot;
  if(!canSend){
    foot=`<div class="wam-foot hint">Отвечать отсюда можно по праву «WhatsApp → создание». Прочитать переписку это не мешает.</div>`;
  }else if(!w.open){
    // Гасим поле, а не даём получить непонятный отказ от Meta: свободный текст она
    // пропускает только в сутки после сообщения клиента.
    foot=`<div class="wam-foot hint" style="color:var(--rust)">
      ${w.never?'Клиент нам ещё не писал':'Клиент писал больше 24 часов назад'} — свободный текст Meta не пропустит.
      Такому клиенту уходит только заранее одобренный шаблон: это кнопки рассылки в «Заказах» и «Барахолке».
    </div>`;
  }else{
    foot=`<div class="wam-foot">
      <div class="hint" style="margin:0 0 6px">Окно для свободного ответа открыто ещё ${esc(waModLeftText(w.left))}.</div>
      <div class="wam-send">
        <textarea id="waModText" rows="2" placeholder="Ответ клиенту…">${esc(waModDrafts[waModPhone]||'')}</textarea>
        <button class="btn primary" id="waModSendBtn">Отправить</button>
      </div>
    </div>`;
  }
  return head+`<div class="wam-scroll" id="waModScroll">${waModBubbles()}</div>`+foot;
}

function waModListHtml(){
  if(waModRows===null)return '<div class="hint" style="padding:14px">Загружаем…</div>';
  if(waModErr)return `<div class="hint" style="padding:14px;color:var(--rust)">${esc(waModErr)}</div>`;
  const list=waModDialogsFiltered();
  if(!list.length)return `<div class="hint" style="padding:14px">${waModRows.length?'Ничего не нашлось — снимите фильтр или поиск.':'Переписки пока нет.'}</div>`;
  return list.map(d=>{
    const m=d.last,t=(fmtLogTime(m.created_at)||{});
    const prev=String(m.body_text||(m.message_type&&m.message_type!=='text'?'['+m.message_type+']':'—')).slice(0,70);
    return `<div class="wam-item${d.norm===waModPhone?' on':''}" data-wadlg="${esc(d.norm)}">
      <div class="wam-i-top">
        <span class="wam-i-ph">${esc(phoneDisplay('7'+d.norm))}</span>
        <span class="wam-i-time">${esc(t.time||t.date||'')}</span>
      </div>
      <div class="wam-i-prev">${m.direction==='outbound'?'<span class="wam-i-you">вы: </span>':''}${esc(prev)}</div>
      <div class="wam-i-tags">
        ${d.flagged?`<span class="wam-tag warn">ждёт ответа · ${d.flagged}</span>`:''}
        ${!d.flagged&&d.waiting?'<span class="wam-tag">последнее от клиента</span>':''}
        <span class="wam-tag mute">${d.cnt} сообщ.</span>
      </div>
    </div>`;
  }).join('');
}

function waModHistHtml(){
  if(waModHist===null)return '<div class="hint" style="margin:0 20px 14px">Загружаем…</div>';
  if(waModHistErr)return `<div class="hint" style="margin:0 20px 14px;color:var(--rust)">${esc(waModHistErr)}</div>`;
  const st=waModStats;
  const cards=st?`<div class="wam-stats">
    <div class="wam-st"><b style="color:#16a34a">${st.answered}</b><span>ответил сам</span></div>
    <div class="wam-st"><b style="color:#b45309">${st.flagged}</b><span>отдал человеку</span></div>
    <div class="wam-st"><b style="color:#dc2626">${st.failed}</b><span>не удалось</span></div>
    <div class="wam-st-note">за последние сутки</div>
  </div>`:'';
  const chips=['','answered','flagged','failed'].map(k=>{
    const lbl=k?WA_OUTCOME_RU[k][0]:'все';
    return `<button class="btn sm ghost${waModHistFilter===k?' active':''}" data-wahf="${k}">${esc(lbl)}</button>`;
  }).join('');
  let rows=waModHist;
  if(waModHistFilter)rows=rows.filter(m=>m.ai_status===waModHistFilter);
  const table=!rows.length
    ? `<div class="hint" style="margin:0 20px 14px">${waModHist.length?'По этому исходу записей нет.':'Робот пока ничего не разбирал.'}</div>`
    : `<div class="table-scroll"><table class="resp-table"><thead><tr>
        <th>Когда</th><th>Клиент</th><th>Вопрос клиента</th><th>Распознано</th><th>Исход</th><th></th>
      </tr></thead><tbody>${rows.map(m=>{
        const t=(fmtLogTime(m.ai_handled_at||m.created_at)||{});
        const oc=WA_OUTCOME_RU[m.ai_status]||[m.ai_status||'—','#6b7280'];
        const intent=WA_INTENT_RU[m.ai_intent]||m.ai_intent||'—';
        return `<tr>
          <td data-label="Когда">${esc((t.date||'')+' '+(t.time||''))}</td>
          <td data-label="Клиент">${esc(phoneDisplay('7'+String(m.phone_norm||'')))}</td>
          <td data-label="Вопрос клиента">${esc(String(m.body_text||'—').slice(0,120))}</td>
          <td data-label="Распознано">${esc(intent)}</td>
          <td data-label="Исход"><span style="color:${oc[1]}">${esc(oc[0])}</span>${m.ai_note?`<div class="hint" style="margin:2px 0 0">${esc(m.ai_note)}</div>`:''}</td>
          <td data-label=""><button class="btn sm ghost" data-waopen="${esc(String(m.phone_norm||''))}">Диалог</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  return cards+`<div class="filters" style="margin:0 20px 12px">${chips}</div>`+table+
    `<div class="hint" style="margin:10px 20px 14px;color:var(--muted)">
      Показаны последние ${WA_MOD_HIST} разборов. «Отдал человеку» означает, что робот
      промолчал намеренно — вопрос вне скрипта или в заказе не хватило данных; такие
      видны и в «Центре контроля».
    </div>`;
}

/* ПЕРЕРИСОВКА НЕ ДОЛЖНА МЕШАТЬ РАБОТЕ. Опрос зовёт её каждые 25 секунд, и без этих
   трёх мелочей менеджер терял бы фокус посреди слова, а переписка прыгала бы вниз
   ровно тогда, когда он отлистал наверх и читает начало разговора. */
/* ВКЛАДКИ НАСТРОЕК РИСУЕТ renderWaSettings из js/21, а своей копии панелей здесь нет:
   автоответ и рассылка связаны одной загрузкой шаблонов и одним набором состояний, и две
   копии разошлись бы на первой же правке — как разошлись бы пять копий шапки модуля. */
const waModSettingsSub=()=>waModSub==='autoreply'||waModSub==='broadcast';

function waModRedraw(){
  // Эти вкладки рисует чужая функция и перерисовывает себя сама: наш redraw затёр бы их
  // содержимое пустотой (waModBodyHtml про них ничего не знает).
  if(waModSettingsSub())return;
  const box=$('waModBox');if(!box)return;
  const ta=$('waModText'), sIn=$('waModSearch'), sc=$('waModScroll');
  const taFocus=!!(ta&&document.activeElement===ta);
  const sFocus=!!(sIn&&document.activeElement===sIn);
  // «Внизу» с запасом в 40 px: при точном сравнении достаточно пары пикселей отката,
  // чтобы новые сообщения перестали подкручиваться сами.
  const atBottom=sc?(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-40):true;
  const keepTop=sc?sc.scrollTop:0;
  box.innerHTML=waModBodyHtml();
  waModBind();
  const ta2=$('waModText');
  if(ta2&&taFocus){ta2.focus();try{ta2.setSelectionRange(ta2.value.length,ta2.value.length);}catch(_e){}}
  const s2=$('waModSearch');
  if(s2&&sFocus){s2.focus();try{s2.setSelectionRange(s2.value.length,s2.value.length);}catch(_e){}}
  const sc2=$('waModScroll');
  if(sc2)sc2.scrollTop=atBottom?sc2.scrollHeight:keepTop;
}

function waModScrollDown(){
  const sc=$('waModScroll');if(sc)sc.scrollTop=sc.scrollHeight;
}

function waModBodyHtml(){
  if(waModSub==='history')return waModHistHtml();
  return `<div class="wam-wrap${waModPhone?' chat':''}">
    <div class="wam-side">
      <div class="wam-filters">
        <input id="waModSearch" placeholder="Номер или текст" value="${esc(waModSearch)}">
        <label class="wam-chk"><input type="checkbox" id="waModFlag"${waModOnlyFlagged?' checked':''}> только ждущие ответа</label>
      </div>
      <div class="wam-list">${waModListHtml()}</div>
    </div>
    <div class="wam-chat">${waModChatHtml()}</div>
  </div>`;
}

function waModBind(){
  const main=$('main');if(!main)return;
  main.querySelectorAll('[data-wadlg]').forEach(el=>el.onclick=async()=>{
    const norm=el.dataset.wadlg;
    if(!norm)return;
    waModPhone=norm;waModChat=null;waModRedraw();
    await waModChatLoad(norm);waModRedraw();
  });
  const back=$('waModBack');if(back)back.onclick=()=>{waModPhone='';waModChat=null;waModRedraw();};
  const s=$('waModSearch');
  if(s)s.oninput=()=>{
    waModSearch=s.value;
    // перерисовываем ТОЛЬКО список, иначе фокус уходил бы из поля на каждой букве
    const box=$('waModBox')&&$('waModBox').querySelector('.wam-list');
    if(box){box.innerHTML=waModListHtml();waModBind();}
  };
  const f=$('waModFlag');if(f)f.onchange=()=>{waModOnlyFlagged=f.checked;waModRedraw();};
  const sb2=$('waModSendBtn');if(sb2)sb2.onclick=waModSend;
  const ta=$('waModText');
  if(ta)ta.oninput=()=>{waModDrafts[waModPhone]=ta.value;};
  if(ta)ta.onkeydown=e=>{
    // Enter отправляет, Shift+Enter — перенос строки: так же, как в самом WhatsApp.
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();waModSend();}
  };
  main.querySelectorAll('[data-wahf]').forEach(b=>b.onclick=()=>{
    waModHistFilter=b.dataset.wahf;waModRedraw();
  });
  main.querySelectorAll('[data-waopen]').forEach(b=>b.onclick=async()=>{
    const norm=b.dataset.waopen;if(!norm)return;
    waModSub='dialogs';waModPhone=norm;waModChat=null;
    renderWhatsapp();
    await waModChatLoad(norm);waModRedraw();
  });
}

function renderWhatsapp(){
  if(!canMod('whatsapp')){
    $('main').innerHTML='<div class="empty"><div class="big">Нет доступа к этому разделу</div>Право выдаётся в «Сотрудники» → «Роли и права», столбец «WhatsApp».</div>';
    return;
  }
  /* Настройки — только тем, кто вправе их менять. Раньше они жили в «Настройках» под
     правом «Справочники»; теперь это модуль WhatsApp, и логично спрашивать его же.
     Просмотр переписки при этом остаётся у всех, кому выдан модуль. */
  const canCfg=(typeof isAdmin==='function'&&isAdmin())||can('whatsapp','edit');
  const subs=[['dialogs','Диалоги'],['history','История робота']]
    .concat(canCfg?[['autoreply','Автоответ'],['broadcast','Рассылка']]:[]);
  // Право могли отобрать, пока человек стоял на вкладке настроек — иначе он смотрел бы
  // закрытый раздел до перезагрузки (та же механика, что у вкладки Барахолки в Статистике).
  if(!subs.some(x=>x[0]===waModSub))waModSub='dialogs';
  $('main').innerHTML=`
    <div class="page-head"><div><h1>WhatsApp</h1><p>Переписка с получателями и то, что ответил робот</p></div>
      <div class="head-actions"><button class="btn ghost" id="waModReload">⟳ Обновить</button></div>
    </div>
    <div class="filters" style="margin-bottom:14px">
      ${subs.map(([k,l])=>`<button class="btn ghost${waModSub===k?' active':''}" data-wasub="${k}">${esc(l)}</button>`).join('')}
    </div>
    ${waModSettingsSub()?'<div id="waModBox"></div>':`<div class="panel"><div id="waModBox">${waModBodyHtml()}</div></div>`}`;

  $('main').querySelectorAll('[data-wasub]').forEach(b=>b.onclick=async()=>{
    waModSub=b.dataset.wasub;
    renderWhatsapp();
    if(waModSub==='history'&&waModHist===null){await waModHistLoad();waModRedraw();}
  });
  const r=$('waModReload');
  if(r)r.onclick=async()=>{
    r.disabled=true;
    try{
      if(waModSub==='history')await waModHistLoad();
      else{await waModLoad();if(waModPhone)await waModChatLoad(waModPhone);}
      waModRedraw();
    }finally{r.disabled=false;}
  };
  if(waModSettingsSub()){
    // Своего содержимого у этих вкладок нет — его кладёт renderWaSettings в наш контейнер.
    renderWaSettings('waModBox',waModSub==='autoreply'?'ai':'rest');
    waModStopPoll();
    return;
  }
  waModBind();
  waModScrollDown();

  // Первая загрузка — лениво и только по заходу в модуль: переписка большая, и в общей
  // загрузке при входе ей делать нечего (курьеру и складу она не нужна вовсе).
  if(waModSub==='dialogs'&&waModRows===null)waModLoad().then(waModRedraw).catch(()=>{});
  if(waModSub==='history'&&waModHist===null)waModHistLoad().then(waModRedraw).catch(()=>{});
  waModStartPoll();
}
