/* ================= МОДУЛЬ: ДАШБОРД ================= */
// перерисовать дашборд, если он сейчас открыт (после изменения сумм и т.п.)
function renderDashboardIfActive(){if(S.tab==='dashboard'){try{renderDashboard();}catch(e){}}}
// выбранный период дашборда (по умолчанию текущий месяц/год)
let dashPeriod={year:new Date().getFullYear(),month:new Date().getMonth()}; // month 0-11
// ИИ-распознавание данных получателя (ФИО/адрес/телефон) с фото заказа → заполнение полей карточки
async function aiRecognizeFromPhoto(o){
  const note=$('oAiNote');const btn=$('oAiRecognize');
  const setNote=(t,cls)=>{if(note){note.textContent=t;note.className='ai-recog-note '+(cls||'');}};
  const ph=pickupPhotos(o);
  if(!ph.length){setNote('Нет фото для распознавания','err');return;}
  // фото лежит в закрытом хранилище: берём временную ссылку под текущего сотрудника.
  // Раньше здесь читалось поле url — постоянная публичная ссылка, которой больше нет.
  const url=await signedPhotoUrl(ph[0]);
  if(!url){setNote('Не удалось получить фото','err');return;}
  if(btn)btn.disabled=true;setNote('Распознаю данные с фото…','load');
  try{
    // грузим картинку и переводим в base64
    const resp=await fetch(url);const blob=await resp.blob();
    const media_type=blob.type||'image/jpeg';
    const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(blob);});
    const system='Ты распознаёшь рукописные и печатные бланки посылок логистической компании (Казахстан). На фото есть поле ПОЛУЧАТЕЛЬ с ФИО, адресом и телефоном. Верни СТРОГО JSON без пояснений и markdown, формат: {"client":"ФИО получателя","address":"адрес получателя","phone":"телефон только цифры"}. Телефон верни как есть на бланке, только цифры без пробелов и скобок (например 87026679187 или 7026679187). Если поле не читается — пустая строка. Не выдумывай — если не уверен, пустая строка.';
    const prompt='Извлеки данные ПОЛУЧАТЕЛЯ (ФИО, адрес, телефон) с этого бланка. Верни только JSON.';
    const r=await callAI({system,prompt,image:{media_type,data:b64},model:'claude-sonnet-5',max_tokens:400});
    if(r.error){setNote('Ошибка: '+r.error,'err');if(btn)btn.disabled=false;return;}
    let txt=(r.text||'').trim().replace(/^```json/i,'').replace(/```$/,'').trim();
    let data;try{data=JSON.parse(txt);}catch(e){setNote('Не удалось разобрать ответ ИИ. Попробуйте ещё раз.','err');if(btn)btn.disabled=false;return;}
    // заполняем поля (не затираем уже заполненное без надобности — но предлагаем распознанное)
    let filled=[];
    if(data.client&&$('o_client')){$('o_client').value=String(data.client).toUpperCase();filled.push('ФИО');}
    if(data.address&&$('o_address')){$('o_address').value=String(data.address).toUpperCase();filled.push('адрес');}
    if(data.phone&&$('o_phone')){
      let digits=String(data.phone).replace(/\D/g,''); // только цифры
      // код страны 7/8 убираем ТОЛЬКО если 11 цифр (иначе теряем первую 7 у номеров 77xx)
      if(digits.length===11&&(digits[0]==='7'||digits[0]==='8'))digits=digits.slice(1);
      digits=digits.slice(-10); // последние 10 цифр (без кода страны — +7 уже в поле)
      const el=$('o_phone');
      if(digits.length>=10){
        const d=digits.slice(0,10);
        el.dataset.phone=d;el.value=fmt10(d); // +7 не пишем — он уже отображён в поле
        filled.push('телефон');
      }else if(digits.length>=9){
        el.dataset.phone=digits;el.value=fmt10(digits);
        filled.push('телефон (проверьте)');
      }
    }
    if(filled.length)setNote('Заполнено: '+filled.join(', ')+'. Проверьте и при необходимости поправьте.','ok');
    else setNote('Не удалось распознать данные. Впишите вручную.','err');
  }catch(e){setNote('Ошибка распознавания: '+String(e&&e.message||e),'err');}
  if(btn)btn.disabled=false;
}

// ── ИИ-АССИСТЕНТ: вопросы к данным словами ──
// собираем КОМПАКТНУЮ сводку (агрегаты, не сырые заказы) — дёшево и быстро для ИИ
function aiBuildDataSummary(){
  const orders=S.orders||[];
  const mon=o=>(o.pickup_date||o.created_at||'').slice(0,7);
  const by=(fn)=>{const m={};orders.forEach(o=>{const k=fn(o);if(k==null||k==='')return;m[k]=(m[k]||0)+1;});return m;};
  const byNested=(nameFn,filterFn)=>{
    const m={};
    orders.forEach(o=>{
      if(filterFn&&!filterFn(o))return;
      const n=nameFn(o);if(n==null||n==='')return;
      const mm=mon(o);if(!mm)return;
      if(!m[n])m[n]={Всего:0};
      m[n][mm]=(m[n][mm]||0)+1;m[n].Всего++;
    });
    return m;
  };
  const byMonth=by(o=>mon(o));
  const bySalesMonth=byNested(o=>o.sales_id?salesName(o.sales_id):'');
  const byCourierMonth=byNested(o=>o.order_courier_id?orderCourierName(o.order_courier_id):'');
  const byCityMonth=byNested(o=>o.courier_city_id?courierCityName(o.courier_city_id):'', o=>isCourierDelivery(o.delivery_id));
  // ПАРТНЁРЫ: заказы по партнёру и месяцам. Считаем через заявки (pickup → partner) + напрямую по orders.
  const pickupById={};(S.pickups||[]).forEach(p=>{pickupById[p.id]=p;});
  const partnerOrders=byNested(o=>{
    let pid=o.partner_id;
    if(!pid&&o.pickup_id&&pickupById[o.pickup_id])pid=pickupById[o.pickup_id].partner_id;
    return pid?partnerName(pid):'';
  });
  // дата ПОСЛЕДНЕГО заказа у каждого партнёра — прямой способ понять, кто «затих» и с какого
  // числа, без нужды в помесячной/недельной разбивке (например: «кто не заказывал с 15 августа»)
  const partnerLastOrderDate={};
  orders.forEach(o=>{
    let pid=o.partner_id;
    if(!pid&&o.pickup_id&&pickupById[o.pickup_id])pid=pickupById[o.pickup_id].partner_id;
    const nm=pid?partnerName(pid):'';if(!nm)return;
    const d=(o.pickup_date||o.created_at||'').slice(0,10);if(!d)return;
    if(!partnerLastOrderDate[nm]||d>partnerLastOrderDate[nm])partnerLastOrderDate[nm]=d;
  });
  // ВСЕ партнёры из справочника (чтобы видеть тех, кто дал 0 заказов)
  const allPartners={};(S.partners||[]).forEach(p=>{
    const nm=p.name||p.title||'';if(!nm)return;
    allPartners[nm]=partnerOrders[nm]?partnerOrders[nm].Всего:0;
  });
  const partnersNoOrders=Object.entries(allPartners).filter(([n,c])=>c===0).map(([n])=>n);
  // новые партнёры по месяцам регистрации (дата создания карточки партнёра, не дата первого заказа) —
  // и количество, и сами имена, чтобы ИИ мог перечислить их поимённо, а не только назвать цифру
  const partnersByRegMonth={};
  const partnersNamesByRegMonth={};
  (S.partners||[]).forEach(p=>{
    const mm=(p.created_at||'').slice(0,7);if(!mm)return;
    partnersByRegMonth[mm]=(partnersByRegMonth[mm]||0)+1;
    if(!partnersNamesByRegMonth[mm])partnersNamesByRegMonth[mm]=[];
    partnersNamesByRegMonth[mm].push(p.name||p.title||'без названия');
  });
  // заявки на забор по месяцам
  const pickupsByMonth={};(S.pickups||[]).forEach(p=>{const mm=(p.pickup_date||p.created_at||'').slice(0,7);if(mm)pickupsByMonth[mm]=(pickupsByMonth[mm]||0)+1;});
  const byStatus={};orders.forEach(o=>{if(!o.status_id)return;const s=orderStatusObj(o.status_id);const n=s?s.name:'';if(n)byStatus[n]=(byStatus[n]||0)+1;});
  let courier=0,mail=0;orders.forEach(o=>{if(isCourierDelivery(o.delivery_id))courier++;else mail++;});
  const revMonth={};orders.forEach(o=>{const mm=mon(o);if(!mm)return;const s=parseFloat(o.order_sum)||0;revMonth[mm]=(revMonth[mm]||0)+s;});
  const noTrack=orders.filter(o=>!o.track).length;
  const noClient=orders.filter(o=>!o.client).length;
  const noPhone=orders.filter(o=>!o.phone).length;
  return {
    Пояснение:'Разбивки — заказы по месяцам ГГГГ-ММ + поле Всего. Партнёры_все_заказов = сколько всего заказов дал каждый партнёр (0 = не давал). Партнёры_без_заказов — список тех, кто не дал ни одного заказа. Партнёры_дата_последнего_заказа — на какую дату (ГГГГ-ММ-ДД) был последний заказ у каждого партнёра, кто давал заказы хотя бы раз — используй это поле, чтобы отвечать на вопросы вида «кто перестал заказывать с такого-то числа» (сравнивай дату последнего заказа с нужным порогом). Новых_партнёров_по_месяцам_регистрации — сколько партнёров ЗАРЕГИСТРИРОВАНО (создана карточка) в каждом месяце ГГГГ-ММ, это НЕ то же самое, что заказы партнёра.',
    Сегодняшняя_дата:localToday(),
    Всего_заказов:orders.length,
    Всего_партнёров:(S.partners||[]).length,
    Новых_партнёров_по_месяцам_регистрации:partnersByRegMonth,
    Новых_партнёров_имена_по_месяцам:partnersNamesByRegMonth,
    Всего_заявок_на_забор:(S.pickups||[]).length,
    Курьерских:courier, Почтовых:mail,
    Заказов_по_месяцам:byMonth,
    Заявок_по_месяцам:pickupsByMonth,
    Выручка_по_месяцам:Object.fromEntries(Object.entries(revMonth).map(([k,v])=>[k,Math.round(v)])),
    Заказы_менеджеров:bySalesMonth,
    Заказы_курьеров_доставки:byCourierMonth,
    Заказы_по_городам:byCityMonth,
    Заказы_партнёров_по_месяцам:partnerOrders,
    Партнёры_все_заказов:allPartners,
    Партнёры_без_заказов:partnersNoOrders,
    Партнёры_дата_последнего_заказа:partnerLastOrderDate,
    Заказов_по_статусам:byStatus,
    Без_трек_кода:noTrack, Без_ФИО_клиента:noClient, Без_телефона:noPhone,
  };
}
let _aiHistory=[];
function aiAssistantModal(){
  const body=`
    <div class="ai-wrap">
      <div class="ai-hint">Задайте вопрос о заказах, партнёрах, курьерах словами. Например: «Какие партнёры не давали заказы?», «Какие партнёры перестали заказывать с 15 августа?», «Сколько заказов у Шамшиевой за июль?», «Какой курьер собрал больше всего?», «Сколько новых партнёров зарегистрировано в августе?», «Сколько заказов без трек-кода?»</div>
      <div class="ai-log" id="aiLog">${_aiHistory.map(m=>`<div class="ai-msg ai-${m.role}">${esc(m.text)}</div>`).join('')||'<div class="ai-empty">Пока нет вопросов</div>'}</div>
      <div class="ai-input-row">
        <input id="aiQ" placeholder="Ваш вопрос…" autocomplete="off">
        <button class="btn primary" id="aiAsk">Спросить</button>
      </div>
      <div class="ai-note">ИИ отвечает по сводке ваших данных. Точные списки смотрите в фильтрах.</div>
    </div>`;
  showInfo('🤖 Помощник по данным',body,{wide:true});
  const ask=async()=>{
    const q=($('aiQ')||{}).value?.trim();if(!q)return;
    const log=$('aiLog');const btn=$('aiAsk');
    _aiHistory.push({role:'user',text:q});
    log.innerHTML+=`<div class="ai-msg ai-user">${esc(q)}</div><div class="ai-msg ai-assistant ai-loading" id="aiLoading">Думаю…</div>`;
    log.scrollTop=log.scrollHeight;$('aiQ').value='';btn.disabled=true;
    const summary=aiBuildDataSummary();
    const system='Ты — аналитик логистической компании Jyldam. Отвечай кратко и по делу на русском, опираясь ТОЛЬКО на предоставленную сводку данных в JSON. В разбивках для каждого имени указаны заказы по месяцам ГГГГ-ММ и поле Всего. Месяцы: 2026-06 = июнь, 2026-07 = июль. Для партнёров: Партнёры_все_заказов — сколько всего заказов дал каждый (0 = не давал), Партнёры_без_заказов — готовый список не дававших, Новых_партнёров_по_месяцам_регистрации — количество ЗАРЕГИСТРИРОВАННЫХ (создана карточка, не заказ) партнёров по месяцам, Новых_партнёров_имена_по_месяцам — их имена по тем же месяцам (используй для вопросов «кто именно» / «список новых партнёров»). Если спрашивают про конкретный месяц — бери значение месяца из разбивки. Если данных нет — скажи об этом. Не выдумывай. Суммы округляй, добавляй «₸». Списки можешь давать полностью.';
    const prompt=`Сводка данных по заказам (JSON):\n${JSON.stringify(summary)}\n\nВопрос: ${q}`;
    const r=await callAI({system,prompt,model:'claude-haiku-4-5-20251001',max_tokens:1500});
    const loading=$('aiLoading');if(loading)loading.remove();
    const answer=r.error?('Ошибка: '+r.error):(r.text||'Нет ответа');
    _aiHistory.push({role:'assistant',text:answer});
    log.innerHTML+=`<div class="ai-msg ai-assistant">${esc(answer)}</div>`;
    log.scrollTop=log.scrollHeight;btn.disabled=false;$('aiQ').focus();
  };
  if($('aiAsk'))$('aiAsk').onclick=ask;
  if($('aiQ'))$('aiQ').onkeydown=e=>{if(e.key==='Enter')ask();};
}

function renderDashboard(){
  // заказы ещё догружаются в фоне — показываем аккуратный лоадер вместо нулей
  if((!S.orders||!S.orders.length)&&S._heavyLoading&&!S._heavyLoaded){
    $('main').innerHTML='<div class="page-head"><div><h1>Добро пожаловать 👋</h1></div></div><div class="loading" style="padding:60px">Загружаем заказы…</div>';
    return;
  }
  const orders=S.orders||[];
  const pickups=S.pickups||[];
  // классификация по названию статуса
  const isNew=o=>{const s=orderStatusObj(o.status_id);return !s||/получено от отправ|нов|создан/i.test(s.name||'');};
  const inWay=o=>{const s=orderStatusObj(o.status_id);return s&&/прибыл|выехал|пути|курьер|отправл|передан/i.test(s.name||'');};
  const delivered=o=>{const s=orderStatusObj(o.status_id);return s&&/доставлен|выдан|заверш/i.test(s.name||'');};
  const problem=o=>{const s=orderStatusObj(o.status_id);return s&&/проблем|возврат|отмен|ошибк/i.test(s.name||'');};
  const today=new Date().toISOString().slice(0,10);
  const cNew=orders.filter(isNew).length, cWay=orders.filter(inWay).length,
        cDel=orders.filter(delivered).length, cProb=orders.filter(problem).length;
  const todayCount=orders.filter(o=>(o.created_at||'').slice(0,10)===today).length;
  const couriersOn=new Set(orders.filter(o=>o.order_courier_id).map(o=>o.order_courier_id)).size;
  const d=new Date();const days=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
  const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const dateStr=`${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${days[d.getDay()]}`;

  // ── СВОДНАЯ СТАТИСТИКА ПО ДНЯМ ──
  // помощники: город Алматы/Астана
  const isAlmaty=cid=>/алмат/i.test(cityName(cid)||'');
  const isAstana=cid=>/астан|нур-?султан/i.test(cityName(cid)||'');
  // город забора заказа: pickup_city_id, а если пусто — город партнёра-отправителя
  const orderPickupCity=o=>{
    if(o.pickup_city_id)return o.pickup_city_id;
    if(o.partner_id){const p=S.partners.find(x=>x.id===o.partner_id);if(p&&p.city_id)return p.city_id;}
    return null;
  };
  // собираем все даты (по дате создания заказов и заявок)
  const dateSet=new Set();
  orders.forEach(o=>{const dt=(o.created_at||'').slice(0,10);if(dt)dateSet.add(dt);});
  pickups.forEach(p=>{const dt=(p.pickup_date||'').slice(0,10);if(dt)dateSet.add(dt);});
  const allDatesAll=[...dateSet].sort((a,b)=>b.localeCompare(a)); // новые сверху
  // фильтруем даты по выбранному месяцу/году (как и верхние карточки)
  const selMonthStr=`${dashPeriod.year}-${String(dashPeriod.month+1).padStart(2,'0')}`;
  const allDates=allDatesAll.filter(dt=>dt.slice(0,7)===selMonthStr);
  // строим строки статистики
  const statRows=allDates.map(dt=>{
    const dayOrders=orders.filter(o=>(o.created_at||'').slice(0,10)===dt);
    // заявки этого дня — по ДАТЕ ЗАБОРА (pickup_date)
    const dayPickups=pickups.filter(p=>(p.pickup_date||'').slice(0,10)===dt);
    // собранные заявки (статус «забрал посылки / собрано»)
    const collectedPickups=dayPickups.filter(p=>isCollectedStatus(p.status_id));
    // заказы: всего + по городу забора (pickup_city_id)
    const ordTotal=dayOrders.length;
    const ordAlmaty=dayOrders.filter(o=>isAlmaty(orderPickupCity(o))).length;
    const ordAstana=dayOrders.filter(o=>isAstana(orderPickupCity(o))).length;
    // заборы: СОБРАНО из ВСЕГО + собранные по городу заявки
    const pkTotal=dayPickups.length;            // всего заявок с забором в этот день
    const pkCollected=collectedPickups.length;  // из них собрано (забрал посылки)
    const pkAlmaty=collectedPickups.filter(p=>isAlmaty(p.city_id)).length;
    const pkAstana=collectedPickups.filter(p=>isAstana(p.city_id)).length;
    // курьерская / почтовая доставка (по типу доставки заказа)
    const courierDel=dayOrders.filter(o=>isCourierDelivery(o.delivery_id)).length;
    const mailDel=dayOrders.filter(o=>o.delivery_id&&!isCourierDelivery(o.delivery_id)).length;
    return {dt,ordTotal,ordAlmaty,ordAstana,pkTotal,pkCollected,pkAlmaty,pkAstana,courierDel,mailDel};
  });

  // ── ДАННЫЕ ДЛЯ ВЕРХНИХ КАРТОЧЕК (за выбранный месяц) ──
  // границы выбранного месяца (dashPeriod)
  const mStart=new Date(dashPeriod.year,dashPeriod.month,1);
  const mEnd=new Date(dashPeriod.year,dashPeriod.month+1,0);
  const monthStr=`${mStart.getFullYear()}-${String(mStart.getMonth()+1).padStart(2,'0')}-01`;
  const monthEndStr=`${mEnd.getFullYear()}-${String(mEnd.getMonth()+1).padStart(2,'0')}-${String(mEnd.getDate()).padStart(2,'0')}`;
  const inMonth=d=>{const x=(d||'').slice(0,10);return x&&x>=monthStr&&x<=monthEndStr;};
  // подпись периода: 01.06.2026 – 30.06.2026
  const periodLabel=`${fmtDate(monthStr)} – ${fmtDate(monthEndStr)}`;

  // 1) ОБЩЕЕ КОЛ-ВО ЗАКАЗОВ за месяц по ДАТЕ СОЗДАНИЯ (created_at) — как и в списке «Заказы»,
  // чтобы цифры на дашборде и в самом списке совпадали (раньше считали по дате забора, из-за
  // правила про 12:00 заказ мог «переехать» в другой месяц по одной дате, но не по другой)
  const ordersMonth=orders.filter(o=>inMonth(o.created_at)).length;
  // 2) Заявки на забор: собрано за месяц (по дате забора) + сегодня ожидается
  const pkMonth=pickups.filter(p=>inMonth(p.pickup_date));
  const pkCollectedMonth=pkMonth.filter(p=>isCollectedStatus(p.status_id)).length;
  const isWaiting=p=>{const s=statusObj(p.status_id);return !s||/нов|ожид|создан|принят/i.test(s.name||'');};
  const pkTodayWaiting=pickups.filter(p=>(p.pickup_date||'').slice(0,10)===today&&isWaiting(p)).length;
  // 3) По городам: СОБРАНО за месяц (по дате забора)
  const pkCollMonth=pkMonth.filter(p=>isCollectedStatus(p.status_id));
  const cityAstana=pkCollMonth.filter(p=>isAstana(p.city_id)).length;
  const cityAlmaty=pkCollMonth.filter(p=>isAlmaty(p.city_id)).length;
  // 4) Курьерская vs Почтовая за месяц (по дате создания заказа — тот же принцип, что и в п.1)
  const ordMonth=orders.filter(o=>inMonth(o.created_at));
  const delCourier=ordMonth.filter(o=>isCourierDelivery(o.delivery_id)).length;
  const delMail=ordMonth.filter(o=>o.delivery_id&&!isCourierDelivery(o.delivery_id)).length;
  const delTotal=delCourier+delMail;
  const pctCourier=delTotal?Math.round(delCourier/delTotal*100):0;
  const pctMail=delTotal?100-pctCourier:0;
  // 5) Финансы (выручка по order_sum) — сегодня и за месяц (по дате забора)
  const sumOf=arr=>arr.reduce((s,o)=>s+(parseFloat(o.order_sum)||0),0);
  const revToday=sumOf(orders.filter(o=>(o.created_at||'').slice(0,10)===today));
  const revMonth=sumOf(ordMonth);
  const fmtMoney=n=>{if(n>=1000000)return (n/1000000).toFixed(1).replace('.0','')+' млн';return Math.round(n).toLocaleString('ru-RU');};
  // SVG-донат курьерская/почтовая
  const R=34,C=2*Math.PI*R;const courLen=C*pctCourier/100;
  const donut=`<svg viewBox="0 0 90 90" width="78" height="78"><circle cx="45" cy="45" r="${R}" fill="none" stroke="#3d6478" stroke-width="14"/>
    <circle cx="45" cy="45" r="${R}" fill="none" stroke="#c97a3d" stroke-width="14" stroke-dasharray="${courLen} ${C}" transform="rotate(-90 45 45)" stroke-linecap="butt"/>
    <text x="45" y="49" text-anchor="middle" font-size="17" font-weight="800" font-family="'Fraunces',serif" fill="var(--ink)">${pctCourier}%</text></svg>`;
  // ТРЕНДЫ: сравнение с прошлым месяцем
  const prevM=(()=>{let y=dashPeriod.year,m=dashPeriod.month-1;if(m<0){m=11;y--;}return `${y}-${String(m+1).padStart(2,'0')}`;})();
  const inPrev=d=>(d||'').slice(0,7)===prevM;
  const ordersPrev=orders.filter(o=>inPrev(o.pickup_date)).length;
  const pkPrev=pickups.filter(p=>inPrev(p.pickup_date)&&isCollectedStatus(p.status_id)).length;
  const trendPct=(cur,prev)=>prev>0?Math.round((cur-prev)/prev*100):null;
  const trOrders=trendPct(ordersMonth,ordersPrev);
  const trPickups=trendPct(pkCollectedMonth,pkPrev);
  const trendHtml=v=>{
    if(v===null||v===0)return '';
    const up=v>0;
    return `<div class="dc-trend ${up?'tr-up':'tr-down'}">${up?'↑':'↓'} ${Math.abs(v)}% <span>к прошлому месяцу</span></div>`;
  };
  // ── ВТОРОЙ РЯД КАРТОЧЕК ──
  // заказы по городам за месяц (по городу забора)
  const ordAstana=ordMonth.filter(o=>isAstana(o.pickup_city_id)).length;
  const ordAlmaty=ordMonth.filter(o=>isAlmaty(o.pickup_city_id)).length;

  $('main').innerHTML=`
    <div class="page-head dash-head"><div><h1>Добро пожаловать</h1><p>${esc(dateStr)}</p></div>
      <div class="dash-period-filter">
        ${isStaff()?'<button class="btn ai-btn sm" id="dashAI">🤖 Помощник</button>':''}
        <select id="dashMonth">${months.map((m,i)=>`<option value="${i}" ${dashPeriod.month===i?'selected':''}>${m.charAt(0).toUpperCase()+m.slice(1)}</option>`).join('')}</select>
        <select id="dashYear">${(()=>{const ny=new Date().getFullYear();let o='';for(let y=2025;y<=ny+1;y++)o+=`<option value="${y}" ${dashPeriod.year===y?'selected':''}>${y}</option>`;return o;})()}</select>
        <button class="btn ghost sm" id="dashThisMonth">Текущий</button>
      </div>
    </div>
    <div class="dash-cards">
      <div class="dash-card c-new"><div class="dc-ic">📦</div><div><div class="dc-v">${ordersMonth}</div><div class="dc-k">Общее кол-во заказов</div>${trendHtml(trOrders)}<div class="dc-period">${esc(periodLabel)}</div></div></div>
      <div class="dash-card c-pickup"><div class="dc-ic">📥</div><div><div class="dc-v">${pkCollectedMonth}</div><div class="dc-k">Заявки на забор</div>${trendHtml(trPickups)}<div class="dc-extra">собрано за месяц · сегодня ожидается ${pkTodayWaiting}</div><div class="dc-period">${esc(periodLabel)}</div></div></div>
      <div class="dash-card c-cities"><div class="dc-cities"><div class="dc-cities-h">Собрано заявок по городам</div><div class="dcity"><span class="dcity-n">Астана</span><span class="dcity-dots">${'●'.repeat(Math.min(12,Math.ceil(cityAstana/5)))||'○'}</span><span class="dcity-v">${cityAstana}</span></div><div class="dcity"><span class="dcity-n">Алматы</span><span class="dcity-dots">${'●'.repeat(Math.min(12,Math.ceil(cityAlmaty/5)))||'○'}</span><span class="dcity-v">${cityAlmaty}</span></div><div class="dc-period">${esc(periodLabel)}</div></div></div>
    </div>
    <div class="dash-cards dash-cards-2">
      <div class="dash-card c-donut"><div class="dc-donut-wrap">${donut}<div class="dc-donut-leg"><div><span class="lg-dot" style="background:#c97a3d"></span>Курьерская <b>${pctCourier}%</b></div><div><span class="lg-dot" style="background:#3d6478"></span>Почтовая <b>${pctMail}%</b></div><div class="dc-period">${esc(periodLabel)}</div></div></div></div>
      <div class="dash-card c-fin"><div class="dc-ic">₸</div><div><div class="dc-fin-row"><span>Сегодня</span><b>${fmtMoney(revToday)}</b></div><div class="dc-fin-row"><span>За месяц</span><b>${fmtMoney(revMonth)}</b></div><div class="dc-period">${esc(periodLabel)}</div></div></div>
      <div class="dash-card c-cities"><div class="dc-cities"><div class="dc-cities-h">Заказы по городам</div><div class="dcity"><span class="dcity-n">Астана</span><span class="dcity-dots">${'●'.repeat(Math.min(12,Math.ceil(ordAstana/30)))||'○'}</span><span class="dcity-v">${ordAstana}</span></div><div class="dcity"><span class="dcity-n">Алматы</span><span class="dcity-dots">${'●'.repeat(Math.min(12,Math.ceil(ordAlmaty/30)))||'○'}</span><span class="dcity-v">${ordAlmaty}</span></div><div class="dc-period">${esc(periodLabel)}</div></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Статистика по дням</h2><span class="count">${statRows.length}</span></div>
      <div class="table-scroll dash-stat-scroll"><table class="dash-stat"><thead>
        <tr>
          <th rowspan="2">Дата</th>
          <th colspan="3" class="grp grp-ord">Кол-во заказов</th>
          <th colspan="3" class="grp grp-pk">Заборы (собрано / всего)</th>
          <th colspan="2" class="grp grp-del">Доставка</th>
        </tr>
        <tr>
          <th>Всего</th><th class="c-alm">Алматы</th><th class="c-ast">Астана</th>
          <th>Всего</th><th class="c-alm">Алматы</th><th class="c-ast">Астана</th>
          <th>Курьерская</th><th>Почтовая</th>
        </tr></thead>
        <tbody>${statRows.length?statRows.map(r=>`<tr>
          <td class="d-date"><b>${esc(fmtDate(r.dt))}</b></td>
          <td class="num"><b>${r.ordTotal}</b></td><td class="num c-alm">${r.ordAlmaty||'—'}</td><td class="num c-ast">${r.ordAstana||'—'}</td>
          <td class="num"><b>${r.pkCollected}</b><small style="color:var(--muted)"> / ${r.pkTotal}</small></td><td class="num c-alm">${r.pkAlmaty||'—'}</td><td class="num c-ast">${r.pkAstana||'—'}</td>
          <td class="num">${r.courierDel||'—'}</td><td class="num">${r.mailDel||'—'}</td>
        </tr>`).join(''):`<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:30px">Пока нет данных</td></tr>`}</tbody>
        ${statRows.length?`<tfoot><tr class="dash-total">
          <td>Итого</td>
          <td class="num"><b>${statRows.reduce((s,r)=>s+r.ordTotal,0)}</b></td>
          <td class="num c-alm">${statRows.reduce((s,r)=>s+r.ordAlmaty,0)}</td>
          <td class="num c-ast">${statRows.reduce((s,r)=>s+r.ordAstana,0)}</td>
          <td class="num"><b>${statRows.reduce((s,r)=>s+r.pkCollected,0)}</b><small style="color:var(--muted)"> / ${statRows.reduce((s,r)=>s+r.pkTotal,0)}</small></td>
          <td class="num c-alm">${statRows.reduce((s,r)=>s+r.pkAlmaty,0)}</td>
          <td class="num c-ast">${statRows.reduce((s,r)=>s+r.pkAstana,0)}</td>
          <td class="num">${statRows.reduce((s,r)=>s+r.courierDel,0)}</td>
          <td class="num">${statRows.reduce((s,r)=>s+r.mailDel,0)}</td>
        </tr></tfoot>`:''}
      </table></div>
    </div>`;
  // обработчики фильтра периода
  if($('dashMonth'))$('dashMonth').onchange=e=>{dashPeriod.month=parseInt(e.target.value,10);renderDashboard();};
  if($('dashYear'))$('dashYear').onchange=e=>{dashPeriod.year=parseInt(e.target.value,10);renderDashboard();};
  if($('dashThisMonth'))$('dashThisMonth').onclick=()=>{dashPeriod={year:new Date().getFullYear(),month:new Date().getMonth()};renderDashboard();};
  if($('dashAI'))$('dashAI').onclick=()=>aiAssistantModal();
}