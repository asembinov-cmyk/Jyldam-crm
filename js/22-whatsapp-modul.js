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
const WA_MOD_TICK_MS= 10000;  // как часто тикает таймер (сам запрос — реже, см. ниже)
const WA_MOD_SYNC_MS= 20000;  // сверка с базой, когда Realtime молчит
const WA_MOD_SYNC_RT= 60000;  // и когда он работает: тогда это страховка, а не доставка
const WA_WINDOW_H   = 24;     // окно Meta для свободного текста
const WA_BACK_DAYS  = 7;      // за какой срок берём номера для добора
const WA_BACK_GAP   = 300;    // пауза между номерами, мс
const WA_BACK_MAX   = 400;    // сколько номеров спрашиваем за один добор

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
let waModRtCh=null;        // канал Realtime по переписке
let waModRtOk=false;       // канал подписан
let waModRtSeen=false;     // и ХОТЬ ОДНО событие по нему реально пришло
let waModRtDraw=null;      // отложенная перерисовка на пачку событий
let waModLastSync=0;       // когда последний раз спрашивали базу
/* «Человек смотрит конец переписки». Нужен из-за картинок: они грузятся ПОСЛЕ отрисовки
   и растягивают ленту уже после того, как мы прокрутили её вниз, — и чат оставался
   где-то наверху. Поймано на стенде. Флаг ведёт сама прокрутка, а по загрузке каждой
   картинки мы доезжаем до низа ещё раз, но только если человек не ушёл читать выше. */
let waModStick=true;
/* ЧЕРНОВИК ОТВЕТА ЖИВЁТ ПО НОМЕРАМ, а не в самом поле. Опрос перерисовывает
   переписку раз в 25 секунд и стёр бы набранное; а один черновик на всех уехал бы
   ЧУЖОМУ человеку при переключении диалога — это хуже потери текста. */
let waModDrafts={};

// поля перечислены по именам: `raw` в переписке — тяжёлый jsonb на каждое сообщение
/* `media_url` — ССЫЛКА, а не сам файл, поэтому её брать можно. Колонку `raw` (целый
   ответ Kelesu в jsonb на каждое сообщение) по-прежнему НЕ берём. */
const WA_MSG_COLS='id,phone,phone_norm,direction,body_text,message_type,media_url,created_at,status,ai_status,ai_intent,ai_note';

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

/* ---------- Realtime ---------- */

/* СООБЩЕНИЯ ПРИХОДЯТ СОБЫТИЕМ, А НЕ ОПРОСОМ. Канал свой (`wa-live`) и живёт ТОЛЬКО пока
   модуль открыт: в общий `jyldam-live` эту таблицу класть нельзя — тогда каждое сообщение
   клиента летело бы во все открытые вкладки компании, включая склад и курьеров, а платим
   мы за каждое такое сообщение Realtime.

   У `.subscribe()` ОБЯЗАТЕЛЬНО колбэк статуса — без него приложение не знает, работает
   канал или отвалился, и единственной честной страховкой осталась бы постоянная
   перекачка. Этим мы уже обожглись на заказах (раздел «Фоновый опрос»).

   ПОДПИСКА МОЖЕТ СКАЗАТЬ «SUBSCRIBED» И НЕ ПРИВЕЗТИ НИЧЕГО — если таблица не добавлена в
   публикацию (`db/59`). Поэтому «в реальном времени» показываем не по статусу канала, а
   только после того, как ХОТЬ ОДНО событие реально пришло (`waModRtSeen`). */
function waModRtStart(){
  if(waModRtCh||typeof sb?.channel!=='function')return;
  try{
    waModRtCh=sb.channel('wa-live')
      .on('postgres_changes',{event:'*',schema:'public',table:'kelesu_messages'},p=>{
        waModRtSeen=true;
        waModApplyRow(p&&p.new);
      })
      .subscribe(st=>{waModRtOk=(st==='SUBSCRIBED');});
  }catch(e){waModRtCh=null;waModRtOk=false;}
}

function waModRtStop(){
  if(waModRtDraw){clearTimeout(waModRtDraw);waModRtDraw=null;}
  if(!waModRtCh)return;
  try{sb.removeChannel(waModRtCh);}catch(e){}
  waModRtCh=null;waModRtOk=false;
}

/* Кладём пришедшую строку в память и перерисовываем. Берём ТОЛЬКО нужные поля: в событии
   приезжает вся строка вместе с `raw` (ответ Kelesu в jsonb), и за долгую смену сотни
   таких накопились бы в памяти вкладки зря. */
function waModApplyRow(row){
  if(!row||!row.id)return;
  const m={};
  WA_MSG_COLS.split(',').forEach(k=>{m[k]=row[k];});
  const put=(arr,desc)=>{
    if(!arr)return;
    const i=arr.findIndex(x=>String(x.id)===String(m.id));
    if(i>=0){Object.assign(arr[i],m);return;}
    if(desc)arr.unshift(m); else arr.push(m);
  };
  put(waModRows,true);                                   // список — свежие сверху
  if(waModPhone&&String(m.phone_norm||'')===waModPhone)
    put(waModChat,false);                                // переписка — свежие снизу
  // Пачку событий (клиент шлёт реплики подряд) рисуем одним разом.
  if(waModRtDraw)return;
  waModRtDraw=setTimeout(()=>{waModRtDraw=null;if(S.tab==='whatsapp'&&!waModSettingsSub())waModRedraw();},300);
}

/* ---------- опрос ---------- */

/* СВЕРКА С БАЗОЙ — СТРАХОВКА, А НЕ ДОСТАВКА. Realtime историю не досылает: за время
   обрыва или сна ноутбука события теряются безвозвратно, и догнать их можно только
   запросом. Пока события идут — спрашиваем раз в минуту, когда молчат — раз в 20 секунд.

   ⚠️ ТАЙМЕР НЕ ПЕРЕЗАПУСКАЕТСЯ НА КАЖДОЙ ПЕРЕРИСОВКЕ, и это не мелочь. Первая версия
   снимала и заводила его заново из render(), а render() зовёт КАЖДОЕ событие Realtime по
   заказам (`scheduleRtRender`, задержка 400 мс). В рабочей CRM события идут постоянно —
   робот Казпочты, автоответ, KET, — поэтому отсчёт сбрасывался раньше, чем успевал
   дойти до конца, и свежие сообщения не подтягивались ВООБЩЕ. Снаружи это выглядело как
   «модуль не обновляется». Теперь таймер один на сеанс работы с модулем: завести его
   повторно нельзя, а снимается он только при УХОДЕ из модуля. */
function waModStopPoll(){
  if(waModTimer){clearInterval(waModTimer);waModTimer=null;}
}

function waModStartPoll(){
  if(waModTimer)return;                  // уже идёт — перезаводить нельзя
  waModTimer=setInterval(waModTick,WA_MOD_TICK_MS);
}

async function waModTick(){
  if(S.tab!=='whatsapp'||document.hidden)return;
  if(waModSending)return;                // не дёргаем экран, пока уходит сообщение
  if(waModSettingsSub())return;          // там нечего обновлять, а перерисовка сбила бы набранное
  const need=waModRtSeen?WA_MOD_SYNC_RT:WA_MOD_SYNC_MS;
  if(Date.now()-waModLastSync<need)return;
  await waModSync();
}

async function waModSync(){
  waModLastSync=Date.now();
  if(waModSub==='history'){await waModHistLoad();waModRedraw();return;}
  await waModLoad();
  if(waModPhone)await waModChatLoad(waModPhone);
  waModRedraw();
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

/* ---------- ДОБОР ПРОПУЩЕННОЙ ПЕРЕПИСКИ ----------

   Нужен, когда вебхук Kelesu молчал. Так уже было 05.11.2026: Kelesu отключил нашу
   подписку сам («ваш сервер не отвечал, 10 ошибок подряд» — он падал на событии
   `message.sent`), и за 17 часов в базу не легло ни одного входящего. Вебхук историю
   задним числом не досылает — догнать можно только запросом по каждому номеру.

   СПРАШИВАЕМ ПО НОМЕРАМ, КОТОРЫЕ УЖЕ ЗНАЕМ, и это главное ограничение: `kelesu-sync-history`
   принимает телефон, а списка «кто писал за это время» у нас нет — он и есть то, что
   потерялось. Поэтому берём всех, с кем переписывались за последние дни. Клиент,
   написавший ВПЕРВЫЕ во время простоя, так не найдётся: его сообщение лежит только у
   Kelesu и появится, когда он напишет снова. Об этом сказано прямо в итоге, а не
   умолчано — иначе «добрали» читалось бы как «вернули всё». */

async function waModCount(){
  try{
    const {count,error}=await sb.from('kelesu_messages').select('id',{count:'exact',head:true});
    if(error)throw error;
    return typeof count==='number'?count:null;
  }catch(e){return null;}
}

async function waModBackfill(btn){
  const label=btn?btn.textContent:'';
  if(!confirm('Добрать переписку у Kelesu?\n\nСпросим по каждому номеру, с кем переписывались за последние '
    +WA_BACK_DAYS+' дней, и дольём то, чего нет в базе. Займёт пару минут, вкладку закрывать нельзя.'))return;
  if(btn){btn.disabled=true;}
  try{
    // 1. кого спрашивать
    const since=new Date(Date.now()-WA_BACK_DAYS*86400000).toISOString();
    const {data,error}=await sb.from('kelesu_messages').select('phone_norm')
      .gte('created_at',since).limit(5000);
    if(error)throw error;
    const all=[...new Set((data||[]).map(r=>String(r.phone_norm||'')).filter(Boolean))];
    const phones=all.slice(0,WA_BACK_MAX);
    if(!phones.length){alert('Не нашлось ни одного номера за последние '+WA_BACK_DAYS+' дней — добирать нечего.');return;}

    // 2. сколько было — по нему и считаем, что прибавилось
    const before=await waModCount();

    let done=0,failed=0;
    for(let i=0;i<phones.length;i++){
      if(S.tab!=='whatsapp')break;        // ушли из модуля — не держим цикл
      if(btn)btn.textContent='Добираю '+(i+1)+' из '+phones.length+'…';
      try{
        const r=await callKelesuSyncHistory({phone:phones[i]});
        if(r&&r.error)failed++; else done++;
      }catch(e){failed++;}
      if(i<phones.length-1)await new Promise(r=>setTimeout(r,WA_BACK_GAP));
    }

    const after=await waModCount();
    const added=(before!=null&&after!=null)?Math.max(0,after-before):null;
    await waModSync();

    alert('Добор закончен.\n\n'
      +'Опрошено номеров: '+done+(failed?' · не ответили: '+failed:'')
      +(all.length>phones.length?'\nПоказаны первые '+WA_BACK_MAX+' из '+all.length+' — повторите, чтобы добрать остальные.':'')
      +'\nНовых сообщений в базе: '+(added==null?'не смогли посчитать':added)
      +'\n\nКлиенты, написавшие ВПЕРВЫЕ за время простоя, так не находятся: их номеров у нас нет. '
      +'Их сообщения останутся в Kelesu и придут сами, когда человек напишет снова.');
  }catch(e){
    alert('Добор не удался: '+String(e&&e.message||e));
  }finally{
    if(btn){btn.disabled=false;btn.textContent=label||'⟲ Добрать переписку';}
  }
}

/* ---------- ВЛОЖЕНИЯ ----------

   Фото показываем картинкой, голосовые и видео — плеером браузера. До этого в переписке
   стояло «[image]» и «[audio]», то есть менеджер видел, что файл есть, и не мог его
   посмотреть — приходилось открывать WhatsApp.

   ССЫЛКА МОЖЕТ НЕ ОТКРЫТЬСЯ: `media_url` даёт Kelesu, и это чужой адрес — он может быть
   с ограничением по времени или по доступу. Поэтому у картинки есть запасной путь: не
   загрузилась — на её месте появляется обычная ссылка (вешаем обработчик в waModBind, а
   не инлайном). У плеера запасного пути нет — браузер сам покажет, что не воспроизводит,
   и рядом стоит ссылка на файл. */
/* ТИПЫ ПЕРЕЧИСЛЕНЫ СПИСКОМ, а не «всё, что не текст». У сообщений бывает тип `template`
   (наш шаблон рассылки), `interactive`, `button` — файла там нет и не было, а первая
   версия честно писала под каждым «[template — файла нет]». Незнакомый тип считаем
   обычным сообщением: лишняя подпись хуже её отсутствия. */
const WA_MEDIA_RU={image:'фото',audio:'голосовое',voice:'голосовое',video:'видео',
  document:'документ',sticker:'стикер'};

function waModMedia(m){
  const t=String(m.message_type||'').toLowerCase();
  const name=WA_MEDIA_RU[t];
  if(!name)return '';
  const url=String(m.media_url||'');
  if(!url)return `<div class="wam-att none">[${esc(name)} — файл не передан]</div>`;
  if(t==='image'||t==='sticker')
    return `<a class="wam-att" href="${esc(url)}" target="_blank" rel="noopener"
      ><img class="wam-img" src="${esc(url)}" alt="${esc(name)}" loading="lazy" data-waimg="${esc(url)}"></a>`;
  if(t==='audio'||t==='voice')
    return `<div class="wam-att"><audio class="wam-audio" controls preload="none" src="${esc(url)}"></audio>
      <a class="wam-dl" href="${esc(url)}" target="_blank" rel="noopener">скачать</a></div>`;
  if(t==='video')
    return `<div class="wam-att"><video class="wam-video" controls preload="none" src="${esc(url)}"></video>
      <a class="wam-dl" href="${esc(url)}" target="_blank" rel="noopener">скачать</a></div>`;
  return `<div class="wam-att"><a href="${esc(url)}" target="_blank" rel="noopener">📎 ${esc(name)}</a></div>`;
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
    const att=waModMedia(m);
    // У вложения подпись бывает пустой — тогда и строку с текстом не рисуем вовсе,
    // иначе под фото висел бы прочерк.
    const body=m.body_text||(att?'':'—');
    return sep+`<div class="wam-row ${out?'out':'in'}">
      <div class="wam-bub ${out?'out':'in'}${byRobot?' bot':''}">
        ${byRobot?'<div class="wam-who">🤖 робот</div>':''}
        ${att}
        ${body?`<div class="wam-txt">${esc(body)}</div>`:''}
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
    const m=d.last;
    const prev=String(m.body_text||(m.message_type&&m.message_type!=='text'?'['+m.message_type+']':'—')).slice(0,70);
    return `<div class="wam-item${d.norm===waModPhone?' on':''}" data-wadlg="${esc(d.norm)}">
      <div class="wam-i-top">
        <span class="wam-i-ph">${esc(phoneDisplay('7'+d.norm))}</span>
        <span class="wam-i-time">${esc(waModWhen(m.created_at))}</span>
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
const waModSettingsSub=()=>waModSub==='autoreply';

/* Режим обновления виден человеку. «Не подтягивает свежие» иначе невозможно отличить от
   «сообщений и не было», и выяснять это приходится по базе — так и вышло 05.11.2026. */
/* В СПИСКЕ ДИАЛОГОВ НУЖЕН ДЕНЬ, А НЕ ТОЛЬКО ВРЕМЯ. Список отсортирован по свежести, но
   если у всех строк показано одно время суток, порядок выглядит случайным: «11:48, 22:32,
   19:10» читается как сбой, хотя 22:32 — это вчера. Поймано на живом экране 05.11.2026.
   День считаем МЕСТНЫЙ (`localDay`): `created_at` в базе по Гринвичу, и всё, что пришло
   до 05:00 по Астане, иначе уехало бы во вчера. */
function waModWhen(ts){
  const t=(fmtLogTime(ts)||{});
  if(typeof localDay!=='function'||typeof localToday!=='function')return t.time||t.date||'';
  const d=localDay(ts);
  if(d===localToday())return t.time||'';
  if(typeof localDaysAgo==='function'&&d===localDaysAgo(1))return 'вчера '+(t.time||'');
  const p=String(d||'').split('-');
  return p.length===3?p[2]+'.'+p[1]:(t.date||'');
}

function waModSyncText(){
  const t=waModLastSync?new Date(waModLastSync):null;
  const hh=t?String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+':'+String(t.getSeconds()).padStart(2,'0'):'—';
  if(waModRtSeen)return '⚡ в реальном времени · сверка '+hh;
  if(waModRtOk)return 'жду событий · сверка раз в 20 с, последняя '+hh;
  return 'обновление раз в 20 с · последнее '+hh;
}

function waModSyncLabel(){
  const el=$('waModSync');if(el)el.textContent=waModSyncText();
}

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
  const atBottom=sc?(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-40):waModStick;
  const keepTop=sc?sc.scrollTop:0;
  box.innerHTML=waModBodyHtml();
  waModBind();
  const ta2=$('waModText');
  if(ta2&&taFocus){ta2.focus();try{ta2.setSelectionRange(ta2.value.length,ta2.value.length);}catch(_e){}}
  const s2=$('waModSearch');
  if(s2&&sFocus){s2.focus();try{s2.setSelectionRange(s2.value.length,s2.value.length);}catch(_e){}}
  waModStick=atBottom;
  const sc2=$('waModScroll');
  if(sc2)sc2.scrollTop=atBottom?sc2.scrollHeight:keepTop;
  waModSyncLabel();
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
  // Картинка не загрузилась (ссылка Kelesu протухла или закрыта) — показываем ссылку
  // вместо битого значка: так видно, что файл есть, и его можно открыть руками.
  main.querySelectorAll('[data-waimg]').forEach(img=>{
    img.onload=()=>{const sc=$('waModScroll');if(sc&&waModStick)sc.scrollTop=sc.scrollHeight;};
    img.onerror=()=>{
      const a=img.parentElement;
      if(!a)return;
      a.classList.add('dead');
      a.textContent='📎 файл не открылся — нажмите, чтобы попробовать';
    };
  });

  main.querySelectorAll('[data-wadlg]').forEach(el=>el.onclick=async()=>{
    const norm=el.dataset.wadlg;
    if(!norm)return;
    waModPhone=norm;waModChat=null;waModStick=true;waModRedraw();
    await waModChatLoad(norm);waModRedraw();
  });
  const back=$('waModBack');if(back)back.onclick=()=>{waModPhone='';waModChat=null;waModStick=true;waModRedraw();};
  const scb=$('waModScroll');
  if(scb)scb.onscroll=()=>{waModStick=scb.scrollTop+scb.clientHeight>=scb.scrollHeight-40;};
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
  // «Рассылка» вернулась в «Настройки» по просьбе владельца 05.11.2026 — её настраивают
  // один раз, а сидят здесь каждый день. Автоответ остался: он про эти же диалоги.
  const subs=[['dialogs','Диалоги'],['history','История робота']]
    .concat(canCfg?[['autoreply','Автоответ']]:[]);
  // Право могли отобрать, пока человек стоял на вкладке настроек — иначе он смотрел бы
  // закрытый раздел до перезагрузки (та же механика, что у вкладки Барахолки в Статистике).
  if(!subs.some(x=>x[0]===waModSub))waModSub='dialogs';
  $('main').innerHTML=`
    <div class="page-head"><div><h1>WhatsApp</h1><p>Переписка с получателями и то, что ответил робот</p></div>
      <div class="head-actions"><span class="hint" id="waModSync" style="margin-right:10px">${esc(waModSyncText())}</span>${waModSub==='dialogs'&&canCfg?'<button class="btn ghost" id="waModBack24" style="margin-right:8px">⟲ Добрать переписку</button>':''}<button class="btn ghost" id="waModReload">⟳ Обновить</button></div>
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
  const bf=$('waModBack24');
  if(bf)bf.onclick=()=>waModBackfill(bf);
  const r=$('waModReload');
  if(r)r.onclick=async()=>{
    r.disabled=true;
    try{
      await waModSync();
    }finally{r.disabled=false;}
  };
  if(waModSettingsSub()){
    // Своего содержимого у этих вкладок нет — его кладёт renderWaSettings в наш контейнер.
    renderWaSettings('waModBox','ai');
    waModStopPoll();
    return;
  }
  waModBind();
  waModScrollDown();

  // Первая загрузка — лениво и только по заходу в модуль: переписка большая, и в общей
  // загрузке при входе ей делать нечего (курьеру и складу она не нужна вовсе).
  if(waModSub==='dialogs'&&waModRows===null)waModLoad().then(()=>{waModLastSync=Date.now();waModRedraw();}).catch(()=>{});
  if(waModSub==='history'&&waModHist===null)waModHistLoad().then(()=>{waModLastSync=Date.now();waModRedraw();}).catch(()=>{});
  waModRtStart();
  waModStartPoll();
}
