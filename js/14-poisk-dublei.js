
/* ============================================================
   ПОИСК ДУБЛЕЙ ЗАКАЗОВ (только «Заказы заборов», не KET)
   Правила:
   - тот же телефон + похожее ФИО + < 7 дней  → показать предупреждение при создании
   - тот же телефон, но >= 7 дней ИЛИ другое ФИО → «повторный клиент» (не мешаем)
   Ничего не блокируем жёстко — показываем и даём решить, факт пишем в историю.
   ============================================================ */
const DUP_WINDOW_DAYS=7;

// нормализация телефона: только цифры, последние 10 (без кода страны)
function normPhone(p){const d=String(p||'').replace(/\D/g,'');return d.slice(-10);}
// нормализация ФИО: нижний регистр, схлопнуть пробелы
function normFio(s){return String(s||'').toLowerCase().replace(/\s+/g,' ').trim();}
// первое слово имени (для сравнения «Асель» ≈ «Асель Жумабаева»)
function firstWord(s){return normFio(s).split(' ')[0]||'';}
// расстояние Левенштейна (для «похоже»: опечатки, разные написания)
function levenshtein(a,b){
  a=a||'';b=b||'';const m=a.length,n=b.length;
  if(!m)return n;if(!n)return m;
  const dp=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){
    const c=a[i-1]===b[j-1]?0:1;
    dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+c);
  }
  return dp[m][n];
}
// «похожи ли ФИО»: совпадает первое слово, или строки близки (Левенштейн <= 2)
function fioSimilar(a,b){
  const fa=firstWord(a),fb=firstWord(b);
  if(!fa||!fb)return false;
  if(fa===fb)return true;
  return levenshtein(fa,fb)<=2; // «асель» ≈ «асел»
}
// разница в днях между датами создания
function daysBetween(a,b){
  const da=new Date(a),db=new Date(b);
  return Math.abs((da-db)/(1000*60*60*24));
}
function salesNameSafe(id){try{return salesName(id);}catch(e){return '—';}}

/* проверка при СОЗДАНИИ: вернёт объект-предупреждение или null.
   Ищет по всем заказам заборов совпадение телефона.
   Дубль (показываем) = телефон совпал + ФИО похоже + < DUP_WINDOW_DAYS дней. */
async function checkOrderDuplicate(phone,client){
  const np=normPhone(phone);
  if(np.length<10)return null;
  const now=new Date().toISOString();
  // Барахолку в поиске дублей не ищем (решение владельца 02.10.2026): эти заказы
  // приходят реестром, и дубли там ловятся по трек-номеру при самой загрузке — там же
  // и перечисляются. Здесь они были бы шумом в чужой ветке бизнеса.
  const matches=mainOrders().filter(o=>{
    if(o.ket_id&&!o.code)return false; // на всякий случай не трогаем чисто-KET
    return normPhone(o.phone)===np;
  });
  if(!matches.length)return null;
  // ищем самый «подозрительный»: похожее ФИО и свежий
  for(const o of matches){
    const recent=daysBetween(now,o.created_at||now)<DUP_WINDOW_DAYS;
    const sim=fioSimilar(o.client,client);
    if(recent&&sim){
      return {
        matchedCode:o.code||String(o.id).slice(0,8),
        matchedId:o.id,
        managerName:salesNameSafe(o.sales_id),
        client:o.client||'',
        days:Math.round(daysBetween(now,o.created_at||now)),
        kind:'dup',
      };
    }
  }
  return null; // телефон совпал, но давно или другое имя — это повторный клиент, не мешаем
}

/* модалка подтверждения при создании дубля.
   Возвращает Promise<boolean>: true = всё равно создать, false = отмена.
   showModal не поддерживает кастомные кнопки/onCancel, поэтому:
   - «Сохранить» (onSave) → resolve(true)
   - закрытие крестиком/мимо/Escape → ловим через MutationObserver → resolve(false) */
function confirmDuplicate(w){
  return new Promise(resolve=>{
    let decided=false;
    const body=`
      <div style="display:grid;gap:10px;font-size:14px">
        <div style="padding:12px 14px;background:#fff4e5;border:1px solid #f0c27a;border-radius:10px">
          ⚠️ <b>Похоже на дубль.</b> Заказ с таким телефоном уже создан:
        </div>
        <div style="padding:10px 14px;border:1px solid var(--line);border-radius:10px">
          <div><b>Заказ:</b> ${esc(w.matchedCode)}</div>
          <div><b>Клиент:</b> ${esc(w.client||'—')}</div>
          <div><b>Менеджер:</b> ${esc(w.managerName||'—')}</div>
          <div><b>Создан:</b> ${w.days===0?'сегодня':(w.days+' дн. назад')}</div>
        </div>
        <div class="wh-cat">Если это тот же заказ — закройте окно (Отмена). Если клиент действительно заказал ещё раз — нажмите «Сохранить», заказ будет создан.</div>
      </div>`;
    const ov=showModal('Возможный дубль заказа',body,async()=>{decided=true;resolve(true);return true;},{wide:true});
    // если окно закрылось без «Сохранить» — это отмена
    const obs=new MutationObserver(()=>{
      if(!document.body.contains(ov)){obs.disconnect();if(!decided)resolve(false);}
    });
    obs.observe(document.body,{childList:true});
  });
}

/* ── БЛОК В ЦЕНТРЕ КОНТРОЛЯ: группировка дублей по телефону ── */
// возвращает массив групп: [{phone, orders:[...], hasDup:bool}]
function findDuplicateGroups(){
  const byPhone={};
  mainOrders().forEach(o=>{
    const np=normPhone(o.phone);
    if(np.length<10)return;
    (byPhone[np]=byPhone[np]||[]).push(o);
  });
  const groups=[];
  Object.keys(byPhone).forEach(np=>{
    const arr=byPhone[np];
    if(arr.length<2)return; // не дубль, если один
    // сортируем по дате
    arr.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
    // есть ли «настоящий» дубль внутри группы (похожее фио + <7 дней между какими-то двумя)
    let hasDup=false;
    for(let i=0;i<arr.length;i++)for(let j=i+1;j<arr.length;j++){
      if(fioSimilar(arr[i].client,arr[j].client)&&daysBetween(arr[i].created_at||0,arr[j].created_at||0)<DUP_WINDOW_DAYS){hasDup=true;}
    }
    groups.push({phone:np,orders:arr,hasDup});
  });
  // дубли — вверх
  groups.sort((a,b)=>(b.hasDup?1:0)-(a.hasDup?1:0));
  return groups;
}

// рендер HTML блока дублей (вставляется в Центр контроля)
function duplicatesPanelHtml(){
  const groups=findDuplicateGroups();
  const dupCount=groups.filter(g=>g.hasDup).length;
  const rows=groups.slice(0,50).map(g=>{
    const items=g.orders.map(o=>`<div data-duporder="${o.id}" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;cursor:pointer" title="Открыть карточку заказа">
        <b>${esc(o.code||String(o.id).slice(0,8))}</b>
        <span>${esc(o.client||'—')}</span>
        <span class="wh-cat">${esc(salesNameSafe(o.sales_id))}</span>
        <span class="wh-cat">${esc(fmtDate(o.created_at))}</span>
      </div>`).join('');
    return `<div class="nf-issue nf-i-${g.hasDup?'crit':'info'}" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="nf-i-ico">${g.hasDup?'🔴':'🔁'}</div>
        <div class="nf-i-body"><div class="nf-i-title">Телефон …${esc(g.phone.slice(-7))} — ${g.orders.length} заказа ${g.hasDup?'<span style="color:#c5221f">(возможный дубль)</span>':'<span class="wh-cat">(повторный клиент)</span>'}</div></div>
      </div>
      <div style="display:grid;gap:4px;padding-left:34px">${items}</div>
    </div>`;
  }).join('');
  return `
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head nf-collapse-head" id="dupToggle" style="cursor:pointer">
        <h2>🔁 Возможные дубли</h2><span class="count">${dupCount} / ${groups.length}</span>
        <span class="nf-collapse-ico" style="margin-left:6px">${window._dupOpen?'▴':'▾'}</span>
      </div>
      <div id="dupBody" style="${window._dupOpen?'':'display:none'}">
        <div style="padding:0 0 10px;display:flex;justify-content:flex-end">
          <button class="btn ai-btn sm" id="dupAiRun">🤖 Проверить дубли через ИИ</button>
        </div>
        <div id="dupAiBox"></div>
        ${groups.length?rows:'<div class="empty" style="padding:24px"><div class="big">✅ Дублей не найдено</div>Заказов с повторяющимися телефонами нет.</div>'}
      </div>
    </div>`;
}

// навесить кнопку ИИ (вызывается после рендера Центра контроля)
function bindDuplicatesPanel(){
  if($('dupToggle'))$('dupToggle').onclick=()=>{
    window._dupOpen=!window._dupOpen;
    const b=$('dupBody');if(b)b.style.display=window._dupOpen?'':'none';
    const ic=$('dupToggle').querySelector('.nf-collapse-ico');if(ic)ic.textContent=window._dupOpen?'▴':'▾';
  };
  if($('dupAiRun'))$('dupAiRun').onclick=()=>runDuplicatesAI();
  document.querySelectorAll('[data-duporder]').forEach(el=>el.onclick=()=>{
    try{orderModal(el.dataset.duporder,!can('orders','edit'));}catch(e){}
  });
}

// ИИ-проверка дублей: отдаём модели список групп, где телефоны/имена ПОХОЖИ, но не точны
async function runDuplicatesAI(){
  const box=$('dupAiBox');if(box)box.innerHTML='<div class="nf-ai-empty">🤖 ИИ анализирует…</div>';
  // собираем компактный срез заказов для анализа (телефон, фио, менеджер, дата)
  const data=mainOrders().slice(0,400).map(o=>({
    code:o.code||String(o.id).slice(0,8),
    phone:normPhone(o.phone),
    fio:o.client||'',
    manager:salesNameSafe(o.sales_id),
    date:(o.created_at||'').slice(0,10),
  }));
  const system='Ты помощник по выявлению дублей заказов в логистической CRM. Дубль — это когда один и тот же заказ создан дважды (возможно, чтобы менеджер получил двойную оплату). Ищи не только точные совпадения, но и хитрые: переставленные/изменённые на 1 цифры в телефоне, разные написания того же имени, один клиент за короткий срок. НЕ считай дублем законные повторные заказы (тот же клиент через 2+ недели). Отвечай ТОЛЬКО JSON-массивом без markdown: [{"icon":"🔴","title":"краткое описание","action":"какие заказы и почему подозрительны, укажи коды и менеджера"}]. Максимум 8 записей, самые подозрительные.';
  const prompt='Заказы (код, телефон, фио, менеджер, дата):\n'+JSON.stringify(data);
  try{
    const r=await callAI({system,prompt,model:'claude-sonnet-5',max_tokens:2000});
    if(r.error)throw new Error(r.error);
    let txt=(r.text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let arr=null;
    try{arr=JSON.parse(txt);}catch(e){const m=txt.match(/\[[\s\S]*\]/);if(m){try{arr=JSON.parse(m[0]);}catch(e2){}}}
    if(!Array.isArray(arr))arr=txt?[{icon:'💡',title:'Анализ ИИ',action:txt.slice(0,600)}]:[];
    if(box)box.innerHTML=arr.filter(x=>x&&x.title).slice(0,8).map(x=>`
      <div class="nf-ai-item"><div class="nf-ai-ico">${esc(x.icon||'🔴')}</div>
        <div class="nf-ai-body"><div class="nf-ai-title">${esc(x.title||'')}</div>${x.action?`<div class="nf-ai-act">→ ${esc(x.action)}</div>`:''}</div>
      </div>`).join('')||'<div class="nf-ai-empty">ИИ не нашёл подозрительных дублей.</div>';
  }catch(e){
    if(box)box.innerHTML='<div class="nf-ai-empty">⚠️ Не удалось выполнить анализ: '+esc(String(e&&e.message||e).slice(0,140))+'</div>';
  }
}


/* ============================================================
   ДУБЛИ ТРЕК-КОДОВ ЗА ВСЁ ВРЕМЯ (19.10.2026)

   Просьба владельца: «в Барахолке в „Действие" добавь кнопку „Дубль", пусть этот фильтр
   показывает дубли трек-кода за всё время, за все даты». Через час он уточнил, и это
   переделало всю подачу: «в Барахолке пусть показывает заказы Барахолки только дубли, в
   заказах заборов — заказы заборов, и пусть они просто в гриде появляются списком отдельно,
   окно не надо».

   ПОЭТОМУ ОКНА ЗДЕСЬ НЕТ — РЕЗУЛЬТАТ ПОКАЗЫВАЕТ САМ ГРИД. Это и правильнее: в гриде есть
   всё, чего в окне не было, — колонки, сортировка, галочки, выгрузка в Excel, удаление,
   карточка по строке. Отдельное окно повторяло бы их бледной копией.

   И ПОЭТОМУ ЖЕ ДУБЛИ ТЕПЕРЬ СЧИТАЮТСЯ ПО РАЗДЕЛАМ. Барахолка — отдельная ветка бизнеса
   (раздел 5f), и список её дублей разбирает один человек, а дубли заборов — другой. Когда
   результат ложится в грид раздела, смешивать их нельзя физически: барахолочный заказ в
   гриде «Заказов заборов» не показывается вовсе.

   ПОБОЧНОЕ СЛЕДСТВИЕ, О КОТОРОМ НАДО ЗНАТЬ: трек, задвоенный МЕЖДУ разделами (один у
   барахолочного заказа, другой у заказа заборов), не покажет ни один из двух списков —
   внутри каждого раздела он встречается по одному разу. Это самый неприятный случай, и
   ловит его проверка `db/20` (`orders_track_uniq`), а не этот экран.

   ПОЧЕМУ ОТДЕЛЬНО ОТ СОСЕДНЕГО БЛОКА «Возможные дубли». Тот ищет повторных клиентов по
   телефону и ФИО среди ЗАГРУЖЕННЫХ в память вкладки заказов (`mainOrders()`), то есть по
   сегодняшним. Здесь другое и по смыслу, и по способу: один трек на две посылки — это не
   «похоже на дубль», а точно ошибка, и искать её надо ЗАПРОСОМ К БАЗЕ по всем датам.

   ЧЕМ ЭТО ОПАСНО: у Казпочты трек ведёт посылку. Два заказа с одним треком — это один
   статус и одна претензия на двоих, вторая посылка исчезает из отслеживания, а в KET трек
   уходит только при создании заказа и дослать его нечем (раздел 6b). */
const TDUP_PAGE=1000;          // строк в одном запросе
const TDUP_LOAD=100;           // по столько догружаем недостающие заказы целиком
const tdupKey=t=>String(t||'').trim().toUpperCase();
const tdupSection=o=>(o&&o.calc_group==='baraholka')?'baraholka':'main';

async function trackDupScan(say,group){
  const rows=[], cols='id,track,calc_group';
  for(let from=0;;from+=TDUP_PAGE){
    const {data,error}=await sb.from('orders').select(cols)
      .not('track','is',null).neq('track','')
      .order('track',{ascending:true}).order('id',{ascending:true})
      .range(from,from+TDUP_PAGE-1);
    if(error)return {error:dbErrText?dbErrText(error):(error.message||'ошибка запроса')};
    rows.push(...(data||[]));
    if(say)say(rows.length);
    if(!data||data.length<TDUP_PAGE)break;
  }
  // Раздел отбираем ДО группировки — см. выше, почему по разделам.
  const mine=group?rows.filter(o=>tdupSection(o)===group):rows;
  const by={};
  mine.forEach(o=>{const k=tdupKey(o.track);if(k)(by[k]=by[k]||[]).push(o);});
  const groups=Object.keys(by).filter(k=>by[k].length>1).map(k=>({track:k,ids:by[k].map(o=>o.id)}));
  // Сначала самые многочисленные: три заказа на один трек хуже двух.
  groups.sort((a,b)=>b.ids.length-a.ids.length||a.track.localeCompare(b.track));
  return {groups,scanned:mine.length,all:rows.length};
}

/* Грид рисует из `S.orders`, а там после входа только сегодняшние заказы — дубль за прошлую
   неделю ему просто неоткуда взять. Поэтому недостающие догружаем ЦЕЛИКОМ (`select('*')`):
   урезанной строкой карточка заказа работать не станет, а открывают её отсюда первым делом. */
async function trackDupLoad(ids){
  for(let i=0;i<ids.length;i+=TDUP_LOAD){
    const part=ids.slice(i,i+TDUP_LOAD);
    const {data,error}=await sb.from('orders').select('*').in('id',part);
    if(error)return dbErrText?dbErrText(error):(error.message||'ошибка запроса');
    (data||[]).forEach(o=>{if(!S.orders.some(x=>x.id===o.id))S.orders.push(o);});
  }
  return '';
}

// Кнопка «Дубль» в меню «Действие». Ничего не спрашивает и ничего не открывает: считает и
// показывает найденное в самом гриде, полосой сверху.
async function trackDupShowInGrid(){
  const group=(typeof ordersMode!=='undefined'&&ordersMode==='baraholka')?'baraholka':'main';
  const where=group==='baraholka'?'в Барахолке':'в заказах заборов';
  toast('Ищем дубли трек-кода за все даты…',4000);
  const res=await trackDupScan(null,group);
  if(res.error){toast('Не удалось прочитать заказы: '+res.error,7000);return;}
  if(!res.groups.length){
    // Пустой результат — это ответ, а не молчание: если выполнен `db/20`, дублей не бывает
    // вовсе, `orders_track_uniq` их не пускает.
    toast(`Дублей трек-кода ${where} нет — проверено заказов с треком: ${res.scanned}`,6000);
    return;
  }
  const ids=[];res.groups.forEach(g=>g.ids.forEach(id=>ids.push(id)));
  const need=ids.filter(id=>!(S.orders||[]).some(o=>o.id===id));
  if(need.length){
    toast(`Нашли ${ids.length} — догружаем заказы…`,4000);
    const err=await trackDupLoad(need);
    if(err){toast('Не удалось загрузить заказы: '+err,7000);return;}
  }
  ordersDupIds=new Set(ids);
  ordersDupGroups=res.groups.length;
  ordersDupMode=ordersMode;
  renderOrders();
}
