/* ================= ИИ-АССИСТЕНТ В WHATSAPP · GREEN API (24.11.2026) =================
   Вкладка «ИИ ассистент» модуля «WhatsApp · Green API» (js/30). Просьба владельца:
   «ассистент должен создавать заявку на заборы, обучиться по действующим чатам;
   сделай блок с тестовыми номерами, сперва будем тестить».

   САМ АССИСТЕНТ ЖИВЁТ НА СЕРВЕРЕ — Edge Function `green-assistant`, её будит база при
   каждом входящем (db/70). Здесь только настройки и журнал: открытая вкладка CRM для
   его работы не нужна.

   РЕЖИМОВ ТРИ, И ПОРЯДОК ИХ ВКЛЮЧЕНИЯ — ГЛАВНОЕ:
     off  — молчит;
     test — отвечает ТОЛЬКО номерам из блока «Тестовые номера»;
     on   — отвечает настоящим людям.
   Сообщение клиенту отозвать нечем, а заявку увидят диспетчеры, поэтому в «on»
   переводим отдельным подтверждением, а в тесте заявки по умолчанию НЕ создаются —
   в журнале видно, что создалось бы.

   «ОБУЧЕНИЕ» — ЭТО НЕ ПЕРЕНАСТРОЙКА МОДЕЛИ, А ПАМЯТКА. Сервер читает реальную переписку
   менеджеров и составляет по ней текст: как просят о заборе, что уточняют, каким тоном
   отвечают. Памятка лежит в настройках, её видно и можно править руками — ассистент
   читает её при каждом ответе вместе с «Правилами компании».

   НАСТРОЙКИ ПИШУТСЯ ИЗ БРАУЗЕРА (правило базы — «редактирование» модуля), а переписка и
   журнал — только сервером. Ключей здесь нет никаких. */

const GA_AI_LOG_LIMIT=60;
const GA_AI_MODELS=[['claude-opus-5-5','Opus 5.5 — точнее'],['claude-sonnet-5-5','Sonnet 5.5 — дешевле'],['claude-haiku-5-5','Haiku 5.5 — самый дешёвый']];
const GA_AI_OUT_RU={reply:'ответил',pickup:'заявка',order:'заказ',handoff:'передал менеджеру',skipped:'промолчал',error:'сбой'};
// Приём заказов сообщением появился в функции этой версии; на более старой блок честно говорит, что её нужно выложить.
const GA_AI_ORDERS_FN='2026-11-26.2';

let gaAi=null;            // строка green_ai_settings; null — ещё не грузили
let gaAiErr='';
let gaAiLog=null;
let gaAiLogErr='';
let gaAiInfo=null;        // что ответила функция на info (есть ли ключи на сервере)
let gaAiBusy='';          // pull | build | save — что сейчас идёт
let gaAiLastLog=0;
let gaAiDays=14;
let gaAiStt;              // undefined — не спрашивали; null — ключа нет; строка — «sk-…abcd»; false — не узнали
let gaAiDraft={instructions:null,learned:null};   // несохранённый текст переживает перерисовку

const gaAiCanEdit=()=>isAdmin()||can('greenapi','edit');
const gaAiCall=(action,extra)=>callEdge('green-assistant',Object.assign({action},extra||{}));

function gaAiTableErr(e){
  const s=String(e&&(e.message||e.code)||e);
  if(/42P01|does not exist|schema cache/i.test(s))return 'Таблиц ассистента ещё нет — нужно выполнить db/70';
  return 'Не удалось прочитать настройки ассистента: '+s;
}

async function gaAiLoad(){
  gaAiErr='';
  try{
    const {data,error}=await sb.from('green_ai_settings').select('*').eq('id',1).limit(1);
    if(error)throw error;
    gaAi=(data&&data[0])||null;
    if(!gaAi)gaAiErr='В таблице настроек ассистента нет строки — нужно выполнить db/70';
  }catch(e){gaAi=null;gaAiErr=gaAiTableErr(e);}
}

async function gaAiLogLoad(){
  gaAiLogErr='';gaAiLastLog=Date.now();
  try{
    const {data,error}=await sb.from('green_ai_log')
      .select('id,created_at,chat_id,who,inbound_text,reply_text,outcome,pickup_id,pickup_info,note,test,tokens_in,tokens_out,ms')
      .order('created_at',{ascending:false}).limit(GA_AI_LOG_LIMIT);
    if(error)throw error;
    gaAiLog=data||[];
  }catch(e){gaAiLog=[];gaAiLogErr=gaAiTableErr(e);}
}

async function gaAiInfoLoad(){
  const r=await gaAiCall('info');
  gaAiInfo=(r&&r.ok)?r:{failed:String((r&&r.error)||'сервер не ответил')};
}

/* Запись настроек. Возвращаем строку из базы целиком: `active_since` двигает триггер
   на сервере, и после смены режима или списка номеров в памяти должно быть новое. */
async function gaAiSave(patch,okText){
  if(!gaAiCanEdit()){toast('Менять настройки ассистента можно по праву «WhatsApp Ассистент приёма заявок → редактирование»');return false;}
  try{
    const row=Object.assign({},patch,{updated_by_name:(S.me&&(S.me.full_name||S.me.name))||null});
    const {data,error}=await sb.from('green_ai_settings').update(row).eq('id',1).select('*');
    if(error)throw error;
    if(!data||!data.length)throw new Error('база не приняла изменение — проверьте право «редактирование»');
    gaAi=data[0];
    if(okText)toast(okText);
    return true;
  }catch(e){
    toast('Не сохранилось: '+String((e&&e.message)||e));
    return false;
  }
}

/* ---------- разметка ---------- */

function gaAiPartnerName(id){
  const p=(S.partners||[]).find(x=>x.id===id);
  return p?p.name:'';
}

function gaAiModeHtml(){
  const m=gaAi.mode, edit=gaAiCanEdit();
  const btn=(k,label)=>`<button class="btn ${m===k?'primary':'ghost'}" data-gaaimode="${k}"${edit&&m!==k?'':' disabled'}>${label}</button>`;
  const text={
    off:'Ассистент выключен: никому не отвечает и заявок не создаёт.',
    test:'Тест: ассистент отвечает ТОЛЬКО номерам из блока «Тестовые номера». Остальным, как и раньше, отвечают менеджеры.',
    on:gaAi.audience==='all'
      ?'Работает: отвечает всем личным чатам на этом номере. Группам — никогда.'
      :'Работает: отвечает номерам из карточек партнёров. Остальным и группам отвечают менеджеры.',
  }[m]||'';
  const warn=[];
  if(gaAiInfo&&gaAiInfo.failed)warn.push('Не удалось проверить сервер ассистента: '+gaAiInfo.failed);
  else if(gaAiInfo){
    if(!gaAiInfo.ai_key)warn.push('На сервере нет ключа Anthropic (секрет ANTHROPIC_API_KEY) — без него ассистент не ответит.');
    if(!gaAiInfo.green)warn.push('Green API не подключён — см. вкладку «Подключение».');
    if(!gaAiInfo.report_key)warn.push('На сервере нет секрета REPORT_KEY — база не сможет будить ассистента.');
  }
  if(gaState&&gaState.state&&gaState.state!=='authorized')warn.push('Телефон сейчас не привязан — ответы не уйдут.');
  if(m==='test'&&!(gaAi.test_numbers||[]).length)warn.push('Тестовых номеров нет — в этом режиме ассистент не ответит никому. Добавьте номер ниже.');
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Режим</div>
    <div class="ga-ai-modes">${btn('off','Выключен')}${btn('test','Тест')}${btn('on','Работает')}</div>
    <div class="hint" style="margin-top:8px">${esc(text)}</div>
    ${warn.map(w=>`<div class="hint" style="color:var(--rust);margin-top:6px">${esc(w)}</div>`).join('')}
    <div class="hint" style="margin-top:8px">Ассистент молчит, если в этом чате за последние 15 минут писал менеджер, и не отвечает на сообщения, пришедшие до включения режима.</div>
  </div>`;
}

function gaAiTestHtml(){
  const edit=gaAiCanEdit(), list=gaAi.test_numbers||[];
  const rows=list.length?list.map((t,i)=>`<tr>
      <td data-label="Номер">${esc(phoneDisplay(t.phone))}</td>
      <td data-label="Кем считать">${t.partner_id?esc(gaAiPartnerName(t.partner_id)||'партнёр удалён'):'<span class="hint">частное лицо</span>'}</td>
      <td data-label="Заметка">${esc(t.note||'')}</td>
      <td>${edit?`<button class="btn sm ghost" data-gaaidel="${i}">Убрать</button>`:''}</td>
    </tr>`).join('')
    :'<tr><td colspan="4" class="hint">Пока ни одного номера.</td></tr>';
  const partners=(S.partners||[]).filter(p=>!p.is_baraholka&&!(typeof isFizlicoName==='function'&&isFizlicoName(p.name)));
  const add=edit?`<div class="ga-ai-add">
      <input id="gaAiPhone" inputmode="tel" autocomplete="off" placeholder="+7 707 123 45 67">
      <input id="gaAiPartner" list="gaAiPartners" autocomplete="off" placeholder="Считать партнёром (необязательно)">
      <datalist id="gaAiPartners">${partners.map(p=>`<option value="${esc(p.name)}"></option>`).join('')}</datalist>
      <input id="gaAiNote" autocomplete="off" placeholder="Чей это номер">
      <button class="btn primary" id="gaAiAdd">Добавить номер</button>
    </div>
    <div class="hint">Пишите с тестового номера на рабочий WhatsApp. Поле «считать партнёром» нужно, чтобы проверить заявку от магазина: ассистент будет думать, что пишет этот партнёр. Пусто — он ведёт себя как с частным лицом.</div>
    <label class="ga-ai-chk"><input type="checkbox" id="gaAiReal"${gaAi.test_real?' checked':''}>
      <span>В тесте создавать <b>настоящие</b> заявки в CRM. Пока галочки нет, заявка не создаётся — в журнале ниже видно, что создалось бы.</span></label>`:'';
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Тестовые номера</div>
    <div class="table-scroll"><table class="resp-table"><thead><tr><th>Номер</th><th>Кем считать</th><th>Заметка</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${add}
  </div>`;
}

/* ПРИЁМ ЗАКАЗОВ СООБЩЕНИЕМ (26.11.2026, db/75). Выключатель ОТДЕЛЬНЫЙ от режима самого
   ассистента: тот уже работает на всех, а заказы сначала проверяют на тестовых номерах.
     off  — заказы не принимаются;
     test — только с тестовых номеров, у которых указано «считать партнёром»;
     on   — от партнёров с галочкой «Заказы через чат» в карточке.
   Блока нет, пока в базе нет колонки orders_mode. */
function gaAiOrdersHtml(){
  if(!gaAi||!('orders_mode' in gaAi))return '';
  const m=gaAi.orders_mode||'off', edit=gaAiCanEdit();
  const btn=(k,label)=>`<button class="btn ${m===k?'primary':'ghost'}" data-gaaiord="${k}"${edit&&m!==k?'':' disabled'}>${label}</button>`;
  const withFlag=(S.partners||[]).filter(p=>p.chat_orders===true&&!p.is_baraholka).length;
  const testPartners=(gaAi.test_numbers||[]).filter(t=>t.partner_id).length;
  const text={
    off:'Заказы сообщением не принимаются. Ассистент работает как раньше: заявки на забор и «где посылка».',
    test:'Тест: заказы принимаются только с номеров из блока «Тестовые номера», у которых указано «считать партнёром». Остальным ассистент отвечает как раньше.',
    on:'Работает: заказы принимаются от партнёров с галочкой «Заказы через чат» в карточке — сейчас таких: '+withFlag+'. Остальным ассистент отвечает как раньше.',
  }[m]||'';
  const warn=[];
  if(m!=='off'){
    if(gaAi.mode==='off')warn.push('Сам ассистент выключен (блок «Режим» выше) — заказы тоже не принимаются.');
    if(gaAiInfo&&!gaAiInfo.failed&&String(gaAiInfo.version||'')<GA_AI_ORDERS_FN)warn.push('На сервере прежняя версия ассистента ('+(gaAiInfo.version||'без версии')+') — она про заказы не знает. Нужно выложить functions/green-assistant.');
    if(m==='test'&&!testPartners)warn.push('Нет тестового номера с указанным партнёром — заказ принять не от кого. Добавьте номер в блоке «Тестовые номера» и заполните «считать партнёром».');
    if(m==='on'&&!withFlag)warn.push('Ни у одного партнёра не стоит галочка «Заказы через чат» — принимать не от кого. Она в карточке партнёра.');
  }
  const real=m==='test'&&edit?`<label class="ga-ai-chk"><input type="checkbox" id="gaAiOrdReal"${gaAi.orders_real?' checked':''}>
      <span>В тесте создавать <b>настоящие</b> заказы. Пока галочки нет, в CRM не создаётся ничего — ни заказ, ни заявка; что создалось бы, видно в журнале ниже.</span></label>`:'';
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Приём заказов сообщением</div>
    <div class="hint" style="margin-bottom:8px">Партнёр присылает данные получателя текстом — ассистент сразу заводит заказ и отвечает на это сообщение: «Заказ создан. ID: … — напишите этот ID на пакете». Заказ встаёт в заявку магазина, которую курьер ещё не забрал. Бланк и ручное «Заполнение» по таким заказам не нужны.</div>
    <div class="ga-ai-modes">${btn('off','Выключен')}${btn('test','Тест')}${btn('on','Работает')}</div>
    <div class="hint" style="margin-top:8px">${esc(text)}</div>
    ${warn.map(w=>`<div class="hint" style="color:var(--rust);margin-top:6px">${esc(w)}</div>`).join('')}
    ${real}
    <div class="hint" style="margin-top:8px">Что партнёр пишет на каждый заказ: ФИО и телефон получателя, «курьер» или «почта»; для курьерской — город и адрес, для почтовой — индекс. Заказ создаётся, даже если чего-то не хватает: ассистент тут же спрашивает недостающее и дописывает заказ, когда партнёр ответит. Отменить заказ или сменить тип доставки он не может — такой диалог уходит менеджеру.</div>
  </div>`;
}

async function gaAiSetOrders(mode){
  if(!gaAi||(gaAi.orders_mode||'off')===mode)return;
  if(mode==='on'&&!confirm('Включить приём заказов от партнёров?\n\nАссистент начнёт создавать НАСТОЯЩИЕ заказы по сообщениям партнёров, у которых в карточке стоит галочка «Заказы через чат», и отвечать им номером заказа. Сначала стоит проверить это в режиме «Тест».'))return;
  if(await gaAiSave({orders_mode:mode},mode==='off'?'Приём заказов выключен':(mode==='test'?'Приём заказов: тест':'Приём заказов работает')))gaAiRedraw();
}

function gaAiRulesHtml(){
  const edit=gaAiCanEdit();
  const val=gaAiDraft.instructions!=null?gaAiDraft.instructions:(gaAi.instructions||'');
  const dirty=gaAiDraft.instructions!=null&&gaAiDraft.instructions!==(gaAi.instructions||'');
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Правила компании</div>
    <div class="hint">То, что ассистент вправе говорить клиенту от имени компании: во сколько приезжает курьер, до скольки принимаются заявки на сегодня, что с пакетами, в каких городах забираем. Чего здесь нет, того он не обещает — передаёт вопрос менеджеру.</div>
    <textarea id="gaAiRules" rows="7"${edit?'':' disabled'} placeholder="Например:&#10;Забор заказов — с 11:00 до 16:00.&#10;Заявка на сегодня принимается до 12:00, позже — на завтра.&#10;Пакеты курьер привозит по просьбе партнёра.">${esc(val)}</textarea>
    ${edit?`<div class="ga-ai-row"><button class="btn primary sm" id="gaAiRulesSave"${dirty?'':' disabled'}>Сохранить правила</button>${dirty?'<span class="hint" style="color:var(--rust)">есть несохранённые изменения</span>':''}</div>`:''}
  </div>`;
}

function gaAiLearnHtml(){
  const edit=gaAiCanEdit();
  const val=gaAiDraft.learned!=null?gaAiDraft.learned:(gaAi.learned||'');
  const dirty=gaAiDraft.learned!=null&&gaAiDraft.learned!==(gaAi.learned||'');
  const li=gaAi.learned_info||{};
  const when=gaAi.learned_at?`Составлена ${esc(fmtDateTime(gaAi.learned_at))} по ${li.chats||'?'} диалогам (${li.messages||'?'} сообщений за ${li.days||'?'} дн.).`:'Памятки ещё нет.';
  const busy=gaAiBusy==='pull'||gaAiBusy==='build';
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Обучение по переписке</div>
    <div class="hint">Ассистент читает реальные диалоги менеджеров на этом номере и составляет по ним памятку: как клиенты просят о заборе, что у них уточняют, каким тоном отвечают. Памятку видно ниже — её можно править руками. Имена, телефоны и адреса в неё не попадают.</div>
    ${edit?`<div class="ga-ai-row">
      <select id="gaAiDays"${busy?' disabled':''}>${[7,14,30].map(d=>`<option value="${d}"${gaAiDays===d?' selected':''}>за ${d} дней</option>`).join('')}</select>
      <button class="btn ghost sm" id="gaAiPull"${busy?' disabled':''}>${gaAiBusy==='pull'?'Подтягиваю…':'1. Подтянуть переписку из WhatsApp'}</button>
      <button class="btn primary sm" id="gaAiBuild"${busy?' disabled':''}>${gaAiBusy==='build'?'Читаю переписку… до двух минут':'2. Составить памятку'}</button>
    </div>`:''}
    <div class="hint" style="margin-top:8px">${when}</div>
    <textarea id="gaAiLearned" rows="12"${edit?'':' disabled'} placeholder="Здесь появится памятка после шага 2.">${esc(val)}</textarea>
    ${edit?`<div class="ga-ai-row"><button class="btn primary sm" id="gaAiLearnedSave"${dirty?'':' disabled'}>Сохранить памятку</button>${dirty?'<span class="hint" style="color:var(--rust)">есть несохранённые изменения</span>':''}</div>`:''}
  </div>`;
}

function gaAiOptsHtml(){
  const edit=gaAiCanEdit();
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Кому отвечать и какой моделью</div>
    <div class="ga-ai-row">
      <label class="ga-ai-lbl">В режиме «Работает» отвечать
        <select id="gaAiAudience"${edit?'':' disabled'}>
          <option value="partners"${gaAi.audience==='partners'?' selected':''}>только номерам из карточек партнёров</option>
          <option value="all"${gaAi.audience==='all'?' selected':''}>всем личным чатам (и частным лицам)</option>
        </select></label>
      <label class="ga-ai-lbl">Модель
        <select id="gaAiModel"${edit?'':' disabled'}>${GA_AI_MODELS.map(([k,l])=>`<option value="${k}"${gaAi.model===k?' selected':''}>${esc(l)}</option>`).join('')}</select></label>
    </div>
    <div class="hint">Партнёр определяется по телефону из его карточки. Если номера в карточке нет, для ассистента это частное лицо.</div>
  </div>`;
}

/* КЛЮЧ РАСШИФРОВКИ ГОЛОСОВЫХ (просьба владельца 24.11.2026: «выведи, куда вставить ключ»).
   Ключ уходит в хранилище секретов базы функцией green_ai_set_stt_key и обратно в браузер
   НЕ возвращается никогда — видно только начало и конец. В таблицах и в коде его нет. */
async function gaAiSttLoad(){
  try{
    const {data,error}=await sb.rpc('green_ai_stt_hint');
    if(error)throw error;
    gaAiStt=data||null;
  }catch(e){gaAiStt=false;}
}
function gaAiSttHtml(){
  const adm=isAdmin();
  let st;
  if(gaAiStt===undefined)st='<span class="hint">проверяем…</span>';
  else if(gaAiStt===false)st='<span style="color:var(--rust)">не удалось узнать, задан ли ключ</span>';
  else if(gaAiStt)st=`<b style="color:#15803d">ключ задан</b> <span class="hint">(${esc(gaAiStt)})</span> — голосовые расшифровываются`;
  else st='<b style="color:var(--rust)">ключ не задан</b> — на голосовые ассистент просит написать текстом';
  return `<div class="ga-ai-sec">
    <div class="ga-ai-h">Распознавание голосовых сообщений</div>
    <div style="margin-bottom:8px">${st}</div>
    ${adm?`<div class="ga-ai-row">
      <label class="ga-ai-lbl" style="flex:1;min-width:240px">Ключ API OpenAI
        <input type="password" id="gaAiSttKey" autocomplete="off" placeholder="sk-…" style="width:100%"></label>
      <button class="btn primary" id="gaAiSttSave" style="align-self:flex-end">Сохранить ключ</button>
      ${gaAiStt?'<button class="btn ghost" id="gaAiSttDel" style="align-self:flex-end">Удалить</button>':''}
    </div>`:'<div class="hint">Ключ задаёт администратор.</div>'}
    <div class="hint">Ключ создаётся на platform.openai.com → API keys. Он хранится на сервере в зашифрованном виде и обратно не показывается. Расшифровка стоит меньше цента за минуту аудио; новый ключ начинает действовать в течение пяти минут.</div>
  </div>`;
}
async function gaAiSttSave(key){
  const {data,error}=await sb.rpc('green_ai_set_stt_key',{p_key:key});
  if(error){toast('Не сохранено: '+dbErrText(error));return;}
  gaAiStt=data||null;
  toast(key?'Ключ сохранён':'Ключ удалён');
  gaAiRedraw();
}

function gaAiLogHtml(){
  if(gaAiLog===null)return '<div class="hint">Загружаем журнал…</div>';
  if(gaAiLogErr)return `<div class="hint" style="color:var(--rust)">${esc(gaAiLogErr)}</div>`;
  if(!gaAiLog.length)return '<div class="hint">Ассистент ещё ничего не делал. Включите режим «Тест», добавьте номер и напишите с него на рабочий WhatsApp.</div>';
  return `<div class="table-scroll"><table class="resp-table ga-ai-log"><thead><tr>
      <th>Когда</th><th>Кто</th><th>Написали</th><th>Ответ ассистента</th><th>Итог</th><th></th>
    </tr></thead><tbody>${gaAiLog.map(r=>{
      const pi=r.pickup_info||null;
      const pick=pi?`<div class="ga-ai-pick">${pi.simulated?'В тесте — создалась бы заявка':'Создана заявка'}: ${esc(pi.name||'')} · ${esc(pi.date?fmtDate(pi.date):'')} · заказов ${esc(String(pi.orders??0))}${pi.pack_size?' · пакет '+esc(pi.pack_size):''}${pi.invoices?' · бланки':''}${pi.courier?'<br>курьер: '+esc(pi.courier)+(pi.simulated?' (назначился бы)':''):(pi.courier_note?'<br>курьер не назначен: '+esc(pi.courier_note):'')}${pi.address?'<br>откуда: '+esc(pi.address):''}${pi.delivery_address?'<br>куда: '+esc(pi.delivery_address):''}</div>`:'';
      const oi=Array.isArray(r.orders_info)?r.orders_info:[];
      const ords=oi.length?`<div class="ga-ai-pick">${oi.some(o=>o.simulated)?'В тесте — заказы (в CRM не созданы)':'Заказы из чата'}${oi[0].date?' на '+esc(fmtDate(oi[0].date)):''}:${oi.map(o=>`<br>ID ${esc(String(o.code))} — ${esc([o.client||(o.phone?'тел. +7'+o.phone:''),o.delivery==='courier'?'курьер':(o.delivery==='post'?'почта':''),o.to||''].filter(Boolean).join(' · '))}${o.sum!=null?' · '+esc(fmtNum(o.sum))+' ₸':''}${o.size&&o.size!=='S'?' · '+esc(o.size):''}${o.track?' · '+esc(o.track):''}${o.updated?' · <i>дописан</i>':''}${(o.missing||[]).length?'<br><span style="color:var(--rust)">&nbsp;&nbsp;не хватает: '+esc(o.missing.join('; '))+'</span>':''}`).join('')}</div>`:'';
      const cls=r.outcome==='error'?'err':((r.outcome==='pickup'||r.outcome==='order')?'ok':(r.outcome==='handoff'?'warn':''));
      return `<tr>
        <td data-label="Когда">${esc(fmtDateTime(r.created_at))}${r.test?'<br><span class="wam-tag">тест</span>':''}</td>
        <td data-label="Кто">${esc(gaPhoneText(r.chat_id))}<br><span class="hint">${esc(r.who||'')}</span></td>
        <td data-label="Написали">${esc(r.inbound_text||'')}</td>
        <td data-label="Ответ">${r.reply_text?esc(r.reply_text):'<span class="hint">— не писал —</span>'}${pick}${ords}</td>
        <td data-label="Итог"><span class="ga-ai-out ${cls}">${esc(GA_AI_OUT_RU[r.outcome]||r.outcome)}</span>${r.note?`<br><span class="hint">${esc(r.note)}</span>`:''}</td>
        <td><button class="btn sm ghost" data-gaaiopen="${esc(r.chat_id)}">Диалог</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function gaAiHtml(){
  if(gaAiErr)return `<div class="ga-ai"><div class="hint" style="color:var(--rust)">${esc(gaAiErr)}</div></div>`;
  if(!gaAi)return '<div class="ga-ai"><div class="hint">Загружаем настройки ассистента…</div></div>';
  return `<div class="ga-ai">
    <div class="hint" style="margin-bottom:6px">Ассистент принимает в WhatsApp заявки на забор и заводит их в CRM. Всё остальное — вопросы о доставке, деньги, жалобы — он передаёт менеджеру: такой диалог появляется во вкладке «Диалоги» в «Ждут ответа».${gaAiCanEdit()?'':' Менять настройки можно по праву «редактирование».'}</div>
    ${gaAiModeHtml()}${gaAiTestHtml()}${gaAiOrdersHtml()}${gaAiRulesHtml()}${gaAiLearnHtml()}${gaAiOptsHtml()}${gaAiSttHtml()}
    <div class="ga-ai-sec">
      <div class="ga-ai-h">Журнал ассистента <button class="btn sm ghost" id="gaAiLogReload" style="margin-left:10px">Обновить</button></div>
      <div id="gaAiLogBox">${gaAiLogHtml()}</div>
    </div>
  </div>`;
}

/* ---------- действия ---------- */

async function gaAiSetMode(mode){
  if(!gaAi||gaAi.mode===mode)return;
  if(mode==='on'){
    const whom=gaAi.audience==='all'?'ВСЕМ личным чатам на этом номере':'всем номерам из карточек партнёров';
    if(!confirm('Включить ассистента для настоящих клиентов?\n\nОн начнёт отвечать '+whom+' и создавать НАСТОЯЩИЕ заявки на забор. Отправленное сообщение отозвать нельзя.\n\nСначала стоит проверить его в режиме «Тест».'))return;
  }
  if(await gaAiSave({mode},mode==='off'?'Ассистент выключен':(mode==='test'?'Режим «Тест» включён':'Ассистент работает')))gaAiRedraw();
}

async function gaAiAddNumber(){
  const phone=phoneStored(($('gaAiPhone')||{}).value||'');
  if(phone.length!==10){toast('Номер не похож на телефон: нужно 10 цифр после +7');return;}
  const list=(gaAi.test_numbers||[]).slice();
  if(list.some(t=>t.phone===phone)){toast('Этот номер уже в списке');return;}
  const pname=String(($('gaAiPartner')||{}).value||'').trim();
  let partner_id=null;
  if(pname){
    const p=(S.partners||[]).find(x=>String(x.name||'').trim().toLowerCase()===pname.toLowerCase());
    if(!p){toast('Партнёра с таким названием нет — выберите из списка или оставьте поле пустым');return;}
    partner_id=p.id;
  }
  list.push({phone,partner_id,note:String(($('gaAiNote')||{}).value||'').trim().slice(0,80)});
  if(await gaAiSave({test_numbers:list},'Номер добавлен'))gaAiRedraw();
}

async function gaAiLearn(kind){
  if(gaAiBusy)return;
  if(kind==='build'&&String(gaAi.learned||'').trim()
     &&!confirm('Составить памятку заново?\n\nТекущая памятка будет заменена новой. Правки, внесённые в неё руками, пропадут.'))return;
  gaAiBusy=kind;gaAiRedraw();
  const r=await gaAiCall(kind==='pull'?'learn_pull':'learn_build',{days:gaAiDays});
  gaAiBusy='';
  if(!r||r.error||!r.ok){
    showInfo(kind==='pull'?'Переписка не подтянулась':'Памятка не составлена',
      `<div class="hint">${esc(String((r&&r.error)||'сервер не ответил'))}</div>`);
    gaAiRedraw();return;
  }
  if(kind==='pull'){
    toast(`Из WhatsApp получено: входящих ${r.incoming}, исходящих ${r.outgoing}`);
    gaRows=null;                       // список диалогов перечитается при возврате на «Диалоги»
  }else{
    gaAiDraft.learned=null;
    await gaAiLoad();
    toast(`Памятка составлена по ${r.chats} диалогам`);
  }
  gaAiRedraw();
}

function gaAiRedraw(){
  const box=$('gaBox');if(!box||gaSub!=='assistant')return;
  box.innerHTML=gaAiHtml();
  gaAiBind();
}

function gaAiLogRedraw(){
  const b=$('gaAiLogBox');if(!b)return;
  b.innerHTML=gaAiLogHtml();
  gaAiBindLog();
}

function gaAiBindLog(){
  const box=$('gaBox');if(!box)return;
  box.querySelectorAll('[data-gaaiopen]').forEach(b=>b.onclick=()=>{
    gaSub='dialogs';gaFilter='all';
    renderGreen();
    gaOpenDialog(b.dataset.gaaiopen);
  });
}

function gaAiBind(){
  const box=$('gaBox');if(!box)return;
  box.querySelectorAll('[data-gaaimode]').forEach(b=>b.onclick=()=>gaAiSetMode(b.dataset.gaaimode));
  box.querySelectorAll('[data-gaaidel]').forEach(b=>b.onclick=async()=>{
    const list=(gaAi.test_numbers||[]).slice();
    list.splice(parseInt(b.dataset.gaaidel,10),1);
    if(await gaAiSave({test_numbers:list},'Номер убран'))gaAiRedraw();
  });
  box.querySelectorAll('[data-gaaiord]').forEach(b=>b.onclick=()=>gaAiSetOrders(b.dataset.gaaiord));
  const ordReal=$('gaAiOrdReal');
  if(ordReal)ordReal.onchange=async()=>{
    if(ordReal.checked&&!confirm('Создавать в тесте настоящие заказы?\n\nОни появятся в «Заказах заборов» и в заявке партнёра, указанного у тестового номера, как обычные; почтовым сразу выдаётся трек-номер. После проверки их нужно будет удалить руками.')){ordReal.checked=false;return;}
    if(await gaAiSave({orders_real:ordReal.checked},ordReal.checked?'В тесте создаются настоящие заказы':'В тесте заказы не создаются'))gaAiRedraw();
    else ordReal.checked=!ordReal.checked;
  };
  const add=$('gaAiAdd');if(add)add.onclick=gaAiAddNumber;
  const real=$('gaAiReal');
  if(real)real.onchange=async()=>{
    if(real.checked&&!confirm('Создавать в тесте настоящие заявки?\n\nОни появятся в «Заявках на забор» у диспетчеров, как обычные. После проверки их нужно будет удалить руками.')){real.checked=false;return;}
    if(!await gaAiSave({test_real:real.checked},real.checked?'В тесте создаются настоящие заявки':'В тесте заявки не создаются'))real.checked=!real.checked;
  };
  // Несохранённый текст держим в черновике: перерисовка вкладки его не теряет.
  const dirtyBtn=(ta,key,btnId)=>{
    if(!ta)return;
    ta.oninput=()=>{
      gaAiDraft[key]=ta.value;
      const b=$(btnId);if(b)b.disabled=ta.value===(gaAi[key]||'');
    };
  };
  dirtyBtn($('gaAiRules'),'instructions','gaAiRulesSave');
  dirtyBtn($('gaAiLearned'),'learned','gaAiLearnedSave');
  const rs=$('gaAiRulesSave');
  if(rs)rs.onclick=async()=>{
    const v=String(($('gaAiRules')||{}).value||'').slice(0,6000);
    if(await gaAiSave({instructions:v},'Правила сохранены')){gaAiDraft.instructions=null;gaAiRedraw();}
  };
  const ls=$('gaAiLearnedSave');
  if(ls)ls.onclick=async()=>{
    const v=String(($('gaAiLearned')||{}).value||'').slice(0,9000);
    if(await gaAiSave({learned:v},'Памятка сохранена')){gaAiDraft.learned=null;gaAiRedraw();}
  };
  const days=$('gaAiDays');if(days)days.onchange=()=>{gaAiDays=parseInt(days.value,10)||14;};
  const pl=$('gaAiPull');if(pl)pl.onclick=()=>gaAiLearn('pull');
  const bd=$('gaAiBuild');if(bd)bd.onclick=()=>gaAiLearn('build');
  const au=$('gaAiAudience');
  if(au)au.onchange=async()=>{
    if(au.value==='all'&&gaAi.mode==='on'
       &&!confirm('Отвечать всем личным чатам?\n\nАссистент начнёт отвечать и тем, кого нет в карточках партнёров: частным лицам, новым клиентам, любому, кто напишет на этот номер.')){au.value=gaAi.audience;return;}
    if(await gaAiSave({audience:au.value},'Сохранено'))gaAiRedraw(); else au.value=gaAi.audience;
  };
  const mo=$('gaAiModel');
  if(mo)mo.onchange=async()=>{if(!await gaAiSave({model:mo.value},'Модель сохранена'))mo.value=gaAi.model;};
  const sk=$('gaAiSttSave');
  if(sk)sk.onclick=()=>{
    const v=String(($('gaAiSttKey')||{}).value||'').trim();
    if(!v){toast('Вставьте ключ в поле');return;}
    sk.disabled=true;gaAiSttSave(v);
  };
  const sd=$('gaAiSttDel');
  if(sd)sd.onclick=()=>{if(confirm('Удалить ключ? Голосовые перестанут расшифровываться.')){sd.disabled=true;gaAiSttSave('');}};
  const lr=$('gaAiLogReload');
  if(lr)lr.onclick=async()=>{lr.disabled=true;await gaAiLogLoad();gaAiLogRedraw();const b=$('gaAiLogReload');if(b)b.disabled=false;};
  gaAiBindLog();
}

/* Журнал обновляется сам раз в 20 секунд — в тесте человек пишет с телефона и смотрит
   сюда. Перерисовываем ТОЛЬКО журнал: вся вкладка сбила бы набранное в полях. */
async function gaAiTick(){
  if(gaSub!=='assistant'||gaAiBusy||!gaAi)return;
  if(Date.now()-gaAiLastLog<20000)return;
  await gaAiLogLoad();
  if(gaSub==='assistant')gaAiLogRedraw();
}

/* Вход во вкладку: рисуем сразу то, что есть, и догружаем остальное. */
function gaAiRender(){
  gaAiRedraw();
  const jobs=[];
  if(!gaAi||gaAiErr)jobs.push(gaAiLoad());
  if(gaAiLog===null||Date.now()-gaAiLastLog>20000)jobs.push(gaAiLogLoad());
  if(!gaAiInfo||gaAiInfo.failed)jobs.push(gaAiInfoLoad());
  if(!gaState)jobs.push(gaStateLoad());
  if(gaAiStt===undefined||gaAiStt===false)jobs.push(gaAiSttLoad());
  if(jobs.length)Promise.all(jobs).then(()=>{if(gaSub==='assistant'&&!gaAiBusy)gaAiRedraw();}).catch(()=>{});
}
