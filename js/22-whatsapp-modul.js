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

/* ---------- правая колонка, фильтры, быстрые ответы (06.11.2026) ---------- */
const WA_ORD_LIMIT = 20;    // сколько заказов клиента показываем
const WA_SOON_MIN  = 180;   // «окно закрывается скоро» — меньше трёх часов
const WA_STEPS     = ['Принят','В пути','Ждёт','Вручён'];

let waModFilter='wait';     // wait | all | voice | soon — как на макете, по умолчанию «ждут ответа»
let waModOrders=null;       // заказы открытого диалога (null — ещё не грузили)
let waModOrdErr='';
let waModOrdPhone='';       // для какого номера они загружены
let waModOrdPick=null;      // какой заказ раскрыт карточкой
let waModQuick=null;        // быстрые ответы (null — не грузили, [] — таблицы нет)
let waModRobotToday=null;   // сколько робот ответил сегодня — ТОЧНЫМ запросом, см. ниже

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

/* ЗАКАЗЫ КЛИЕНТА СПРАШИВАЕМ У БАЗЫ, а не ищем в памяти вкладки: в `S.orders` после
   входа лежат только сегодняшние, а спрашивают обычно про вчерашний.

   Телефон в заказе лежит в РАЗНЫХ видах — тем же набором вариантов ищет и робот
   (functions/wa-autoreply): `phone_norm` это последние 10 цифр.

   БЕРЁМ СТРОКУ ЦЕЛИКОМ, и это намеренно. Карточку открывает `orderModal(id)`, а он
   ищет заказ в `S.orders`; с урезанной строкой он работать не станет — то же правило,
   что в поиске дублей по треку. Двадцать строк «звёздочкой» ничего не стоят. */
async function waModOrdersLoad(norm){
  waModOrdErr='';waModOrders=null;waModOrdPhone=norm;waModOrdPick=null;
  const variants=[norm,'7'+norm,'8'+norm,'+7'+norm];
  try{
    const {data,error}=await sb.from('orders').select('*')
      .in('phone',variants).order('created_at',{ascending:false}).limit(WA_ORD_LIMIT);
    if(error)throw error;
    if(waModOrdPhone!==norm)return;        // пока грузили, открыли другой диалог
    waModOrders=data||[];
    waModOrdPick=waModOrders.length?waModOrders[0].id:null;
  }catch(e){
    if(waModOrdPhone!==norm)return;
    waModOrders=[];waModOrdErr=String((e&&e.message)||e);
  }
}

/* Быстрые ответы и заметка — обе таблицы из db/61. Пока он не выполнен, кнопок просто
   нет, а поле заметки не рисуется: всё остальное в модуле работает как прежде. */
async function waModQuickLoad(){
  try{
    const {data,error}=await sb.from('wa_quick_replies').select('id,label,body')
      .eq('enabled',true).order('sort',{ascending:true}).limit(40);
    if(error)throw error;
    waModQuick=data||[];
  }catch(e){waModQuick=[];}
}

/* «Ответил робот сегодня» считаем ТОЧНЫМ запросом (head:true — ни одной строки
   данных), а не по загруженным в список трёмстам сообщениям: по ним вышла бы
   нижняя граница, и число на экране врало бы в большую сторону работы.
   Границу дня берём МЕСТНУЮ: created_at в базе по Гринвичу, и всё, что до 05:00
   по Астане, иначе ушло бы во вчера. */
async function waModRobotCount(){
  try{
    const from=new Date(localToday()+'T00:00:00').toISOString();
    const {count,error}=await sb.from('kelesu_messages').select('id',{count:'exact',head:true})
      .eq('direction','outbound').eq('ai_status','robot').gte('created_at',from);
    if(error)throw error;
    waModRobotToday=typeof count==='number'?count:null;
  }catch(e){waModRobotToday=null;}
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
    if(!d){d={norm:String(m.phone_norm||''),last:m,lastIn:null,cnt:0,unread:0,closed:false,waiting:false,voice:false};by.set(key,d);}
    d.cnt++;
    /* ХВОСТ БЕЗ ОТВЕТА. Список идёт по убыванию даты, поэтому идём от свежих к старым и
       считаем входящие, пока не упрёмся в наш ответ или в отметку «разобрано». */
    if(!d.closed){
      if(m.direction==='outbound'||m.ai_status==='done')d.closed=true;
      else d.unread++;
    }
    if(m.direction==='inbound'){
      if(!d.lastIn)d.lastIn=m;              // самое свежее входящее
      if(/^(audio|voice)$/.test(String(m.message_type||'')))d.voice=true;
    }
    by.set(key,d);
  });
  const list=[...by.values()];
  list.forEach(d=>{ d.waiting=d.unread>0; });
  return list;
}

/* Сколько минут осталось до закрытия окна Meta у этого диалога. −1 — клиент нам
   не писал вовсе, отрицательное — окно уже закрылось. Часы серверные (nowMs). */
function waModDlgLeft(d){
  if(!d||!d.lastIn)return -1;
  const t=Date.parse(d.lastIn.created_at||'');
  if(!t)return -1;
  const now=typeof nowMs==='function'?nowMs():Date.now();
  return Math.round((t+WA_WINDOW_H*3600000-now)/60000);
}

/* Сколько клиент уже ждёт — считаем только когда последнее слово за ним. */
function waModWaitMin(d){
  if(!d||!d.waiting)return 0;
  const t=Date.parse((d.last&&d.last.created_at)||'');
  if(!t)return 0;
  const now=typeof nowMs==='function'?nowMs():Date.now();
  return Math.max(0,Math.round((now-t)/60000));
}

/* Числа в шапке. «Ждут ответа» и «окно закрывается» считаются по загруженному списку —
   это ровно то, что человек видит слева. А «ответил робот сегодня» берётся отдельным
   точным запросом (waModRobotCount), иначе показывал бы нижнюю границу. */
function waModCounters(){
  let wait=0,soon=0;
  waModDialogs().forEach(d=>{
    if(d.waiting)wait++;
    const l=waModDlgLeft(d);
    if(l>0&&l<=WA_SOON_MIN)soon++;
  });
  return {wait,soon,robot:waModRobotToday};
}

/* ФИЛЬТРЫ — ЧИПАМИ, а не галочкой: их стало четыре, и выбранный должен быть виден
   сразу. «Ждут ответа» стоит по умолчанию — это и есть работа менеджера; когда по
   фильтру пусто, подсказка под списком называет фильтр и предлагает «Все». */
const WA_FILTERS=[['wait','Ждут ответа'],['all','Все'],['voice','Голосовые'],['soon','Окно < 3 ч']];

function waModDialogsFiltered(){
  let list=waModDialogs();
  if(waModFilter==='wait')list=list.filter(d=>d.waiting);
  else if(waModFilter==='voice')list=list.filter(d=>d.voice);
  else if(waModFilter==='soon')list=list.filter(d=>{const l=waModDlgLeft(d);return l>0&&l<=WA_SOON_MIN;});
  const q=waModSearch.trim().toLowerCase();
  if(q){
    const digits=q.replace(/\D/g,'');
    list=list.filter(d=>
      (digits&&d.norm.includes(digits))||
      String(d.last.body_text||'').toLowerCase().includes(q));
  }
  return list;
}

/* Кружок с двумя первыми цифрами номера. Цвет считается от самого номера, поэтому у
   одного клиента он всегда один и тот же — список читается глазами, а не построчно. */
function waModAvatar(norm){
  const d=String(norm||'');
  let h=0;for(let i=0;i<d.length;i++)h=(h*31+d.charCodeAt(i))%360;
  return `<span class="wam-av" style="background:hsl(${h} 42% 40%)">${esc(d.slice(0,2)||'··')}</span>`;
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

/* ---------- правая колонка: заказ клиента ---------- */

/* Ступень по данным Казпочты — та же лесенка, что у робота статусов (раздел 13):
   код есть → «принято», STR → «ждёт получателя», BOXISS → «вручено». */
function waModStage(o){
  const c=String((o&&o.kz_status_code)||'').toUpperCase();
  if(c==='BOXISS')return 4;
  if(c==='STR')return 3;
  if(c)return 2;
  return 1;
}

function waModIsCourier(o){
  const d=(S.delivery||[]).find(x=>x.id===(o&&o.delivery_id));
  return /курьер/i.test((d&&d.name)||'');
}

function waModOrderStatus(o){
  const st=(S.orderStatuses||[]).find(x=>x.id===(o&&o.status_id));
  return (st&&st.name)||'';
}

/* День заказа — по дате забора, а при её отсутствии по дате создания. Ровно так же
   считает месяц Калькуляция (`ordersInOrderMonth`): два экрана про одни и те же
   заказы не должны раскладывать их по разным дням. */
function waModOrderDay(o){
  if(o&&o.pickup_date)return String(o.pickup_date).slice(0,10);
  return (typeof localDay==='function'?localDay(o&&o.created_at):String((o&&o.created_at)||'').slice(0,10))||'';
}
function waModDayRu(d){
  const p=String(d||'').split('-');
  if(p.length!==3)return d||'—';
  if(typeof localToday==='function'&&d===localToday())return 'сегодня';
  if(typeof localDaysAgo==='function'&&d===localDaysAgo(1))return 'вчера';
  return p[2]+'.'+p[1]+'.'+p[0];
}

function waModOrderCardHtml(o){
  const courier=waModIsCourier(o);
  const sum=typeof orderSum==='function'?orderSum(o):(Number(o.order_sum)||Number(o.cost)||0);
  const st=waModOrderStatus(o);
  /* Партнёр и город забора — просьба владельца 07.11.2026. Партнёр берётся полем
     «Отправитель», а если оно пустое — по `partner_id`: у заказов, созданных пачкой из
     заявки, заполнено обычно одно из двух. Город забора лежит в `pickup_city_id` и
     означает «где посылку ЗАБРАЛИ» — это НЕ город назначения (раздел 3). */
  const partner=(o.sender||'').trim()
    ||(((S.partners||[]).find(x=>x.id===o.partner_id)||{}).name||'');
  const pcity=((S.cities||[]).find(c=>c.id===o.pickup_city_id)||{}).name||'';
  // Лесенка Казпочты — только у почтовых с треком. У курьерского заказа её шагов не
  // существует вовсе, и рисовать «Принят → Вручён» по пустым данным значило бы врать.
  let flow='';
  if(!courier&&o.track){
    const stage=waModStage(o);
    flow=`<div class="wam-flow">${WA_STEPS.map((n,k)=>{
      const num=k+1, cls=num<stage?'done':(num===stage?'now':'');
      return `<div class="wam-step ${cls}"><i></i><span>${esc(n)}</span></div>`;
    }).join('')}</div>`;
  }
  return `<div class="wam-ord">
    <div class="wam-ord-top">
      <b>№${esc(o.code||'—')}</b>
      ${st?`<span class="wam-badge">${esc(st)}</span>`:''}
    </div>
    <div class="wam-ord-sub">${courier?'Курьерская доставка':'Почтовая доставка'}</div>
    ${flow}
    ${partner?`<div class="wam-kv"><span>Партнёр</span><b>${esc(partner)}</b></div>`:''}
    <div class="wam-kv"><span>Сумма заказа</span><b>${sum?esc(Math.round(sum).toLocaleString('ru-RU'))+' ₸':'—'}</b></div>
    ${pcity?`<div class="wam-kv"><span>Город забора</span><b>${esc(pcity)}</b></div>`:''}
    ${o.track?`<div class="wam-track"><span>Трек Казпочты</span><b>${esc(o.track)}</b>${copyBtn(o.track)}</div>`:''}
    ${o.kz_dep_name?`<div class="wam-kv"><span>Отделение</span><b>${esc(o.kz_dep_name)}</b></div>`:''}
    ${o.kz_storage_left!=null&&o.kz_storage_left!==''?`<div class="wam-kv"><span>Хранение</span><b>${esc(String(o.kz_storage_left))} дн.</b></div>`:''}
    ${o.deliver_date?`<div class="wam-kv"><span>Доставка</span><b>${esc(fmtDate(o.deliver_date))}</b></div>`:''}
    ${o.address?`<div class="wam-kv"><span>Адрес</span><b>${esc(o.address)}</b></div>`:''}
    <button class="btn sm ghost wam-open" data-waord="${esc(String(o.id))}">Открыть заказ в CRM</button>
  </div>`;
}

/* СПИСОК ЗАКАЗОВ ПО ДНЯМ — просьба владельца: «а если вдруг у клиента много заказов».
   Раскрыт один (самый свежий), остальные строками с днём — нажатием переключаются. */
function waModOrdersListHtml(){
  const list=waModOrders||[];
  if(list.length<2)return '';
  const by=new Map();
  list.forEach(o=>{const d=waModOrderDay(o);if(!by.has(d))by.set(d,[]);by.get(d).push(o);});
  const days=[...by.keys()].sort().reverse();
  return `<div class="wam-i-sec">Все заказы этого номера · ${list.length}</div>`+days.map(d=>
    `<div class="wam-oday">${esc(waModDayRu(d))}</div>`+
    by.get(d).map(o=>{
      const st=waModOrderStatus(o);
      return `<div class="wam-oitem${o.id===waModOrdPick?' on':''}" data-wapick="${esc(String(o.id))}">
        <b>№${esc(o.code||'—')}</b>${st?`<span>${esc(st)}</span>`:''}
      </div>`;
    }).join('')
  ).join('');
}

function waModInfoHtml(){
  if(!waModPhone)return '';
  let ord;
  if(waModOrders===null)ord='<div class="hint">Ищем заказы по номеру…</div>';
  else if(waModOrdErr)ord=`<div class="hint" style="color:var(--rust)">Заказы не загрузились: ${esc(waModOrdErr)}</div>`;
  else if(!waModOrders.length)ord='<div class="hint">Заказов по этому номеру не нашли. Возможно, клиент писал с другого телефона — спросите у него номер заказа.</div>';
  else{
    const pick=waModOrders.find(o=>o.id===waModOrdPick)||waModOrders[0];
    ord=waModOrderCardHtml(pick)+waModOrdersListHtml();
  }
  const msgs=waModChat||[];
  const robot=msgs.filter(m=>m.direction==='outbound'&&m.ai_status==='robot').length;
  const first=msgs.length?((fmtLogTime(msgs[0].created_at)||{}).time||'—'):'—';
  const dlg=(waModOrders!==null||msgs.length)?`<div class="wam-i-sec wam-deskonly">Диалог</div>
    <div class="wam-kv wam-deskonly"><span>Сообщений</span><b>${msgs.length}</b></div>
    <div class="wam-kv wam-deskonly"><span>Ответов робота</span><b>${robot}</b></div>
    <div class="wam-kv wam-deskonly"><span>Первое сообщение</span><b>${esc(first)}</b></div>`:'';
  /* «Заметка для команды» убрана по просьбе владельца 07.11.2026 — на её месте данные
     заказа: партнёр, сумма и город забора. Кнопки «Передать оператору» с макета тоже нет:
     списка операторов и назначения в системе не существует, и она была бы обманом. */
  const canDone=(waModChat||[]).some(m=>m.direction==='inbound'&&m.ai_status!=='done');
  return `<div class="wam-i-sec">Заказ</div>${ord}${dlg}
    ${canDone?'<button class="btn primary wam-done" id="waModDone">✓ Отметить решённым</button>':''}`;
}

/* ---------- быстрые ответы ---------- */

/* Кнопка ТОЛЬКО ПОДСТАВЛЯЕТ ТЕКСТ в поле, отправку по-прежнему нажимает человек.
   Иначе одно случайное касание ушло бы живому клиенту, а отозвать его нечем. */
function waModQuickHtml(){
  if(!waModQuick||!waModQuick.length)return '';
  return `<div class="wam-quick">${waModQuick.map(q=>
    `<button class="wam-qr" data-waqr="${esc(String(q.id))}" title="${esc(q.body||'')}">${esc(q.label||'')}</button>`
  ).join('')}</div>`;
}

function waModChatHtml(){
  if(!waModPhone)return `<div class="empty" style="padding:40px"><div class="big">Выберите диалог</div>Слева — все номера, которые нам писали.</div>`;
  const w=waModWindow(waModChat);
  const canSend=typeof can==='function'?can('whatsapp','create'):false;
  const pick=(waModOrders||[]).find(o=>o.id===waModOrdPick)||(waModOrders||[])[0];
  const sub=pick?`Заказ №${esc(pick.code||'—')} · ${waModIsCourier(pick)?'Курьерская':'Почтовая'} доставка`
    :(waModOrders===null?'ищем заказы…':'заказ по номеру не найден');
  const pill=w.never?'<span class="wam-pill off">клиент нам не писал</span>'
    :w.open?`<span class="wam-pill ok">Свободный ответ ещё ${esc(waModLeftText(w.left))}</span>`
    :'<span class="wam-pill off">окно 24 ч закрыто</span>';
  const head=`<div class="wam-chead">
    <button class="btn sm ghost wam-back" id="waModBack">← к списку</button>
    ${waModAvatar(waModPhone)}
    <div class="wam-ctitle">${esc(phoneDisplay('7'+waModPhone))}<span>${sub}</span></div>
    ${pill}
  </div>`;
  /* Полоса «клиент ждёт» — не украшение: это единственное место, где видно, что робот
     вопрос НЕ взял, а менеджер его ещё не открыл. */
  const dlg=waModDialogs().find(d=>d.norm===waModPhone);
  const waitMin=waModWaitMin(dlg);
  const strip=(dlg&&dlg.flagged&&waitMin>0)
    ? `<div class="wam-wait">Клиент ждёт ответа уже ${esc(waModLeftText(waitMin))} — робот на это сообщение не ответил</div>`:'';
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
      ${waModQuickHtml()}
      <div class="wam-send">
        <textarea id="waModText" rows="2" placeholder="Ответ клиенту…">${esc(waModDrafts[waModPhone]||'')}</textarea>
        <button class="btn primary" id="waModSendBtn">Отправить</button>
      </div>
    </div>`;
  }
  return head+`<div class="wam-scroll" id="waModScroll">${waModBubbles()}${strip}</div>`+foot;
}

function waModListHtml(){
  if(waModRows===null)return '<div class="hint" style="padding:14px">Загружаем…</div>';
  if(waModErr)return `<div class="hint" style="padding:14px;color:var(--rust)">${esc(waModErr)}</div>`;
  const list=waModDialogsFiltered();
  if(!list.length){
    const name=(WA_FILTERS.find(f=>f[0]===waModFilter)||[])[1]||'';
    if(!waModRows.length)return '<div class="hint" style="padding:14px">Переписки пока нет.</div>';
    return `<div class="hint" style="padding:14px">По фильтру «${esc(name)}»${waModSearch.trim()?' и поиску':''} ничего нет.
      <button class="btn sm ghost" data-wafl="all" style="margin-top:8px">Показать все диалоги</button></div>`;
  }
  return list.map(d=>{
    const m=d.last;
    const prev=String(m.body_text||(m.message_type&&m.message_type!=='text'?(WA_MEDIA_RU[m.message_type]||m.message_type):'—')).slice(0,70);
    const left=waModDlgLeft(d);
    return `<div class="wam-item${d.norm===waModPhone?' on':''}" data-wadlg="${esc(d.norm)}">
      ${waModAvatar(d.norm)}
      <div class="wam-i-body">
        <div class="wam-i-top">
          <span class="wam-i-ph">${esc(phoneDisplay('7'+d.norm))}</span>
          <span class="wam-i-time">${esc(waModWhen(m.created_at))}</span>
        </div>
        <div class="wam-i-prev">${m.direction==='outbound'?'<span class="wam-i-you">вы: </span>':''}${d.voice?'🎤 ':''}${esc(prev)}</div>
        <div class="wam-i-tags">
          ${d.waiting?`<span class="wam-tag warn">ждёт ответа · ${d.unread}</span>`:''}
          ${left>0&&left<=WA_SOON_MIN?`<span class="wam-tag soon">окно ${esc(waModLeftText(left))}</span>`:''}
          <span class="wam-tag mute">${d.cnt} сообщ.</span>
        </div>
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
  waModNumsLabel();
}

/* Числа стоят в ШАПКЕ, а redraw перерисовывает только тело — без точечного обновления
   они навсегда остались бы теми, что посчитались ДО загрузки списка. Поймано на стенде:
   в чипе «Ждут ответа 4», а в шапке ноль. */
function waModNumsLabel(){
  const el=$('waModNums');
  if(el&&waModSub==='dialogs')el.outerHTML=waModHeadNums();
}

function waModScrollDown(){
  const sc=$('waModScroll');if(sc)sc.scrollTop=sc.scrollHeight;
}

/* Три числа справа от вкладок. Это не украшение: по ним менеджер понимает, есть ли
   работа, НЕ открывая список, а «окно закрывается скоро» — единственное место, где
   видно, что клиенту скоро нельзя будет ответить свободным текстом. */
function waModHeadNums(){
  const c=waModCounters();
  const one=(n,l,col)=>`<span class="wam-num"><b style="color:${col}">${n}</b> ${esc(l)}</span>`;
  return `<div class="wam-nums" id="waModNums">
    ${one(c.wait,'ждут ответа','#b45309')}
    ${one(c.robot==null?'—':c.robot,'ответил робот сегодня','#16a34a')}
    ${one(c.soon,'окно закрывается скоро','#dc2626')}
  </div>`;
}

function waModBodyHtml(){
  if(waModSub==='history')return waModHistHtml();
  const c=waModCounters();
  const chips=WA_FILTERS.map(([k,l])=>{
    const n=k==='wait'?c.wait:(k==='soon'?c.soon:0);
    return `<button class="wam-chip${waModFilter===k?' on':''}" data-wafl="${k}">${esc(l)}${n?' '+n:''}</button>`;
  }).join('');
  return `<div class="wam-wrap${waModPhone?' chat':''}">
    <div class="wam-side">
      <div class="wam-filters">
        <input id="waModSearch" placeholder="Номер или текст" value="${esc(waModSearch)}">
        <div class="wam-chips">${chips}</div>
      </div>
      <div class="wam-list">${waModListHtml()}</div>
    </div>
    <div class="wam-chat">${waModChatHtml()}</div>
    ${waModPhone?`<div class="wam-info">${waModInfoHtml()}</div>`:''}
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

  main.querySelectorAll('[data-wadlg]').forEach(el=>el.onclick=()=>waModOpenDialog(el.dataset.wadlg));
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
  main.querySelectorAll('[data-waopen]').forEach(b=>b.onclick=()=>{
    const norm=b.dataset.waopen;if(!norm)return;
    waModSub='dialogs';
    renderWhatsapp();
    waModOpenDialog(norm);
  });
  main.querySelectorAll('[data-wafl]').forEach(b=>b.onclick=()=>{waModFilter=b.dataset.wafl;waModRedraw();});
  main.querySelectorAll('[data-wapick]').forEach(b=>b.onclick=()=>{
    waModOrdPick=(waModOrders||[]).some(o=>String(o.id)===b.dataset.wapick)
      ? (waModOrders.find(o=>String(o.id)===b.dataset.wapick)||{}).id : waModOrdPick;
    waModRedraw();
  });
  main.querySelectorAll('[data-waord]').forEach(b=>b.onclick=()=>waModOpenOrder(b.dataset.waord));
  /* Быстрый ответ ПОДСТАВЛЯЕТСЯ в поле, а не отправляется: отправку нажимает человек. */
  main.querySelectorAll('[data-waqr]').forEach(b=>b.onclick=()=>{
    const q=(waModQuick||[]).find(x=>String(x.id)===b.dataset.waqr);
    const ta=$('waModText');
    if(!q||!ta)return;
    ta.value=ta.value.trim()?ta.value.replace(/\s*$/,'')+'\n'+q.body:q.body;
    waModDrafts[waModPhone]=ta.value;
    ta.focus();
    try{ta.setSelectionRange(ta.value.length,ta.value.length);}catch(_e){}
  });
  const dn=$('waModDone');if(dn)dn.onclick=()=>waModMarkDone(dn);
}

/* Открыть диалог: переписка, заказы клиента и заметка. Заказы и заметка грузятся
   ПАРАЛЛЕЛЬНО с перепиской — три последовательных запроса человек бы заметил. */
async function waModOpenDialog(norm){
  if(!norm)return;
  waModPhone=norm;waModChat=null;waModStick=true;
  waModOrders=null;waModOrdPhone=norm;waModOrdErr='';
  waModRedraw();
  await Promise.all([
    waModChatLoad(norm),
    waModOrdersLoad(norm),
  ]);
  if(waModPhone!==norm)return;   // пока грузили, открыли другой диалог
  waModRedraw();
}

/* Карточку заказа открывает общий orderModal(id), а он ищет заказ в S.orders. Старого
   заказа там нет — и без этой досылки он открыл бы пустую карточку НОВОГО заказа. */
function waModOpenOrder(id){
  const o=(waModOrders||[]).find(x=>String(x.id)===String(id));
  if(!o)return;
  if(Array.isArray(S.orders)&&!S.orders.some(x=>x.id===o.id))S.orders.push(o);
  if(typeof orderModal==='function')orderModal(o.id);
}

/* «Решено» — та же отметка, что в «Центре контроля» (ai_status='done'), и ставится
   она СРАЗУ ВСЕМ репликам номера без ответа: робот метит пачку целиком, да и человек
   разбирает разговор, а не отдельное сообщение. */
async function waModMarkDone(btn){
  const ids=(waModChat||[]).filter(m=>m.direction==='inbound'&&m.ai_status!=='done').map(m=>m.id);
  if(!ids.length)return;
  if(btn){btn.disabled=true;btn.textContent='Отмечаю…';}
  try{
    const {error}=await sb.from('kelesu_messages').update({ai_status:'done'}).in('id',ids);
    if(error)throw error;
    /* И закрываем вопрос для робота — но ТОЛЬКО там, где он его ещё не брал
       (`ai_handled_at is null`). Иначе робот через минуту ответил бы на то, что человек
       уже разобрал; а перезаписывать чужую отметку нельзя — по ней строится «История
       робота», и старые разборы уехали бы на сегодняшнее число. */
    await sb.from('kelesu_messages')
      .update({ai_handled_at:new Date().toISOString(),ai_note:'разобрал менеджер'})
      .in('id',ids).is('ai_handled_at',null);
    (waModChat||[]).forEach(m=>{if(ids.includes(m.id))m.ai_status='done';});
    (waModRows||[]).forEach(m=>{if(ids.includes(m.id))m.ai_status='done';});
    toast('Отмечено решённым: '+ids.length);
    waModRedraw();
  }catch(e){
    toast('Не удалось отметить: '+String((e&&e.message)||e));
    if(btn){btn.disabled=false;btn.textContent='✓ Отметить решённым';}
  }
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
    <div class="page-head"><div><h1>WhatsApp</h1></div>
      <div class="head-actions"><span class="hint" id="waModSync" style="margin-right:10px">${esc(waModSyncText())}</span>${waModSub==='dialogs'&&canCfg?'<button class="btn ghost" id="waModBack24" style="margin-right:8px">⟲ Добрать переписку</button>':''}<button class="btn ghost" id="waModReload">⟳ Обновить</button></div>
    </div>
    <div class="filters wam-tabs" style="margin-bottom:14px">
      ${subs.map(([k,l])=>`<button class="btn ghost${waModSub===k?' active':''}" data-wasub="${k}">${esc(l)}</button>`).join('')}
      ${waModSub==='dialogs'?waModHeadNums():''}
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
  // Быстрые ответы и «ответил робот сегодня» — по одному разу за заход в модуль:
  // кнопки меняются редко, а счётчик всё равно обновляется сверкой.
  if(waModSub==='dialogs'&&waModQuick===null)waModQuickLoad().then(waModRedraw).catch(()=>{});
  if(waModSub==='dialogs'&&waModRobotToday===null)waModRobotCount().then(waModRedraw).catch(()=>{});
  if(waModSub==='history'&&waModHist===null)waModHistLoad().then(()=>{waModLastSync=Date.now();waModRedraw();}).catch(()=>{});
  waModRtStart();
  waModStartPoll();
}
