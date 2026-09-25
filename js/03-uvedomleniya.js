
/* ================= МОДУЛЬ: УВЕДОМЛЕНИЯ (лента активности) ================= */
// правила отображения событий: иконка, важность, текст
const NOTIFY_RULES={
  create:{icon:'➕',level:'info',verb:'создал'},
  update:{icon:'✏️',level:'info',verb:'изменил'},
  delete:{icon:'🗑',level:'warn',verb:'удалил'},
  status:{icon:'🔄',level:'info',verb:'сменил статус'},
  ket:   {icon:'📤',level:'ok',  verb:'отправил в KET'},
  login: {icon:'🔑',level:'muted',verb:'вошёл в систему'},
  logout:{icon:'🚪',level:'muted',verb:'вышел'},
};
// категория события (для фильтров)
function notifyCategory(a){
  const e=a.entity||'';
  if(e==='orders')return 'orders';
  if(e==='pickups')return 'pickups';
  if(e==='profiles'||e==='roles'||e==='auth')return 'staff';
  if(['couriers','order_couriers','sales_managers','processors','partners','cities','districts','statuses','order_statuses','delivery_types','courier_cities','post_ips','warehouses'].includes(e))return 'dict';
  if(e==='shipments')return 'intercity';
  return 'other';
}
let nf={cat:'',action:'',mine:false};
let _nfEventsOpen=false; // блок «Важные события» свёрнут по умолчанию

// ── СБОР ЗАДАЧ И ПРОБЛЕМ (то, что требует действия) ──
function notifyIssues(){
  const orders=S.orders||[];const pickups=S.pickups||[];
  const today=localToday();
  const issues=[];
  const isMine=o=>{ // для курьера — только его заказы/заявки
    if(!isCourier())return true;
    const me=(S.me&&S.me.id);
    return o.courier_id===me||o.order_courier_id===me;
  };
  // ── ЗАКАЗЫ: незаполненные поля
  const noPhone=orders.filter(o=>!o.phone&&isMine(o));
  const noClient=orders.filter(o=>!o.client&&isMine(o));
  const noSum=orders.filter(o=>(!o.order_sum||parseFloat(o.order_sum)===0)&&!o.paid_by_sender&&isMine(o));
  if(isStaff()){
    if(noPhone.length)issues.push({lvl:'crit',ico:'📵',title:`${noPhone.length} заказов без телефона`,desc:'Без телефона нельзя доставить и отправить в KET',act:'orders',filter:{missing:'phone'}});
    if(noClient.length)issues.push({lvl:'warn',ico:'👤',title:`${noClient.length} заказов без ФИО клиента`,desc:'Заполните получателя',act:'orders',filter:{missing:'client'}});
    if(noSum.length)issues.push({lvl:'info',ico:'₸',title:`${noSum.length} заказов без суммы`,desc:'Проверьте стоимость доставки',act:'orders'});
  }
  // ── ЗАЯВКИ: без курьера
  const noCourier=pickups.filter(p=>!p.courier_id&&(p.pickup_date||'').slice(0,10)>=today);
  if(isStaff()&&noCourier.length)issues.push({lvl:'crit',ico:'🚚',title:`${noCourier.length} заявок без курьера`,desc:'Назначьте заборщика на сегодня/будущее',act:'pickups'});
  // ── ЗАЯВКИ курьеру: его заявки на сегодня
  if(isCourier()){
    const me=(S.me&&S.me.id);
    const mine=pickups.filter(p=>p.courier_id===me&&(p.pickup_date||'').slice(0,10)===today);
    const notDone=mine.filter(p=>{const st=statusObj(p.status_id);return !st||!/забрал|завершен|выполн/i.test(st.name||'');});
    if(notDone.length)issues.push({lvl:'crit',ico:'📋',title:`У вас ${notDone.length} заявок на сегодня`,desc:'Не забудьте забрать посылки',act:'pickups'});
    const noPhotos=(S.orders||[]).filter(o=>o.order_courier_id===me&&!(Array.isArray(o.photos)&&o.photos.length));
    if(noPhotos.length)issues.push({lvl:'warn',ico:'📷',title:`${noPhotos.length} ваших заказов без фото`,desc:'Добавьте фото бланка',act:'orders'});
  }
  return issues;
}

// ── СВОДКА ДНЯ (для руководителя/персонала) ──
// ── НЕОБЫЧНЫЕ СОБЫТИЯ (аномалии, а не вся лента) ──
function notifyHighlights(){
  const orders=S.orders||[];const out=[];
  const today=localToday();
  const dayCount=d=>orders.filter(o=>(o.pickup_date||o.created_at||'').slice(0,10)===d).length;
  // считаем заказы по дням за последние 30 дней
  const days=[];
  for(let i=0;i<30;i++){const d=new Date();d.setDate(d.getDate()-i);days.push(d.toISOString().slice(0,10));}
  const counts=days.map(dayCount).filter(n=>n>0);
  const tCount=dayCount(today);
  if(counts.length>3){
    const max=Math.max(...counts.slice(1)); // максимум без сегодня
    const avg=Math.round(counts.slice(1).reduce((a,b)=>a+b,0)/(counts.length-1));
    if(tCount>max&&tCount>0)out.push({ico:'🏆',lvl:'ok',title:`Сегодня рекорд: ${tCount} заказов`,desc:`Прошлый максимум — ${max}`});
    else if(avg&&tCount>0&&tCount<avg*0.6)out.push({ico:'📉',lvl:'warn',title:`Сегодня заказов меньше обычного: ${tCount}`,desc:`Средний день — ${avg} заказов`});
    else if(avg&&tCount>avg*1.4)out.push({ico:'📈',lvl:'ok',title:`Сегодня заказов больше обычного: ${tCount}`,desc:`Средний день — ${avg} заказов`});
  }
  // новые партнёры (появились за последние 7 дней)
  const weekAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString().slice(0,10);})();
  const newPartners=(S.partners||[]).filter(p=>(p.created_at||'').slice(0,10)>=weekAgo);
  newPartners.slice(0,3).forEach(p=>out.push({ico:'🤝',lvl:'ok',title:`Новый партнёр: ${p.name||''}`,desc:'Подключён за последнюю неделю'}));
  // партнёры, которые давно не давали заказов (были активны, но 14+ дней тишина)
  const pickupById={};(S.pickups||[]).forEach(p=>{pickupById[p.id]=p;});
  const lastOrderByPartner={};
  orders.forEach(o=>{
    let pid=o.partner_id;
    if(!pid&&o.pickup_id&&pickupById[o.pickup_id])pid=pickupById[o.pickup_id].partner_id;
    if(!pid)return;
    const d=(o.pickup_date||o.created_at||'').slice(0,10);
    if(!lastOrderByPartner[pid]||d>lastOrderByPartner[pid])lastOrderByPartner[pid]=d;
  });
  const twoWeeks=(()=>{const d=new Date();d.setDate(d.getDate()-14);return d.toISOString().slice(0,10);})();
  const sleeping=Object.entries(lastOrderByPartner).filter(([pid,d])=>d<twoWeeks).slice(0,3);
  sleeping.forEach(([pid,d])=>out.push({ico:'😴',lvl:'warn',title:`Партнёр «${partnerName(pid)}» молчит`,desc:`Последний заказ — ${fmtDate(d)}`}));
  return out;
}

// важные события (сырые) — для сворачиваемого блока
function notifyEvents(){
  const log=S.activityLog||[];
  return log.filter(a=>['create','delete','ket'].includes(a.action)).slice(0,20);
}

// ── ИИ-ИНСАЙТЫ: выводы и рекомендации по данным ──
let _aiInsights=null,_aiInsightsLoading=false;
async function loadAiInsights(){
  if(_aiInsightsLoading)return;
  _aiInsightsLoading=true;
  const box=$('nfAiBox');
  if(box)box.innerHTML='<div class="nf-ai-load">🤖 Анализирую данные…</div>';
  try{
    const summary=aiBuildDataSummary();
    const system='Ты — аналитик логистической компании. Найди 3-5 ВАЖНЫХ наблюдений для руководителя: аномалии, падения, риски, возможности. Для каждого — конкретная рекомендация.\nВерни ТОЛЬКО валидный JSON-массив, без markdown и пояснений:\n[{"icon":"📉","title":"краткий вывод","action":"что сделать"}]\nСтрого: title не длиннее 80 символов, action не длиннее 60 символов, максимум 5 элементов. По-русски. Только выводы из данных, не выдумывай.';
    const prompt=`Данные компании (JSON):\n${JSON.stringify(summary)}\n\nНайди важные наблюдения и дай рекомендации.`;
    const r=await callAI({system,prompt,model:'claude-sonnet-5',max_tokens:2000});
    if(r.error)throw new Error(r.error);
    let txt=(r.text||'').trim();
    txt=txt.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    let arr=null;
    // 1) пробуем разобрать как есть
    try{arr=JSON.parse(txt);}catch(e){
      // 2) вырезаем массив из текста
      const m=txt.match(/\[[\s\S]*\]/);
      if(m){try{arr=JSON.parse(m[0]);}catch(e2){}}
      // 3) спасаем обрезанный ответ: собираем целые объекты
      if(!arr){
        const objs=[];const re=/\{[^{}]*"title"[^{}]*\}/g;let mm;
        while((mm=re.exec(txt))!==null){try{objs.push(JSON.parse(mm[0]));}catch(e3){}}
        if(objs.length)arr=objs;
      }
    }
    if(Array.isArray(arr)&&arr.length){
      _aiInsights=arr.filter(x=>x&&x.title).slice(0,6);
    }else if(txt){
      _aiInsights=[{icon:'💡',title:'Анализ ИИ',action:txt.slice(0,600)}];
    }else{
      _aiInsights=[{icon:'ℹ️',title:'Нет выводов',action:'ИИ не нашёл значимых наблюдений'}];
    }
  }catch(e){
    _aiInsights=[{icon:'⚠️',title:'Не удалось получить выводы',action:String(e&&e.message||e).slice(0,140)}];
  }
  _aiInsightsLoading=false;
  renderNotify();
}

let notifyTrashCollapsed=true; // корзина свёрнута при открытии раздела — в ней сотни записей
// и они оттесняют вниз выводы и важные изменения. Разворачивается кликом по заголовку,
// выбор держится до перезагрузки страницы.
function renderNotify(){
  if(!isStaff()&&!isCourier()){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  const trash=S.deletedItems||[];
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Центр контроля</h1><p>Резервная корзина, выводы и важные изменения</p></div>
      <div class="head-actions"><button class="btn ghost" id="nfReload">⟳ Обновить</button></div>
    </div>

    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head" data-trashtoggle style="cursor:pointer"><h2>🗑 Корзина</h2><span class="count">${trash.length}</span><span style="margin-left:auto;font-size:12px;color:var(--muted)">${notifyTrashCollapsed?'▸ развернуть':'▾ свернуть'}</span></div>
      ${notifyTrashCollapsed?'':`
      <div class="hint" style="margin:0 20px 12px;color:var(--muted)">Здесь хранится всё удалённое (заказы, заявки, сотрудники и т.д.) — 30 дней, потом чистится само. Если что-то удалили по ошибке — можно восстановить.</div>
      ${trash.length?trash.map(it=>`
        <div class="nf-issue">
          <div class="nf-i-ico">🗑</div>
          <div class="nf-i-body">
            <div class="nf-i-title">${esc(it.entity_label||it.record_id||'')} <span class="wh-cat">(${esc(ENTITY_LABEL[it.table_name]||it.table_name)})</span></div>
            <div class="nf-i-desc">Удалено ${it.deleted_at?esc(fmtDateTime(it.deleted_at)):''}${it.deleted_by?' · '+esc(it.deleted_by):''}</div>
          </div>
          <button class="btn sm primary" data-restore="${it.id}">↩ Восстановить</button>
        </div>`).join(''):'<div class="empty" style="padding:28px"><div class="big">Пусто</div>За последние 30 дней ничего не удаляли.</div>'}`}
    </div>

    ${isStaff()?`
    <div class="panel nf-ai-panel" style="margin-bottom:18px">
      <div class="panel-head"><h2>💡 Выводы ИИ</h2>
        <button class="btn ai-btn sm" id="nfAiRun" style="margin-left:auto">${_aiInsights?'Обновить анализ':'Проанализировать'}</button>
      </div>
      <div id="nfAiBox">
        ${_aiInsights?_aiInsights.map(x=>`
          <div class="nf-ai-item">
            <div class="nf-ai-ico">${esc(x.icon||'💡')}</div>
            <div class="nf-ai-body">
              <div class="nf-ai-title">${esc(x.title||'')}</div>
              ${x.action?`<div class="nf-ai-act">→ ${esc(x.action)}</div>`:''}
            </div>
          </div>`).join(''):'<div class="nf-ai-empty">ИИ проанализирует данные и найдёт важные тенденции: падение заказов у партнёров, аномалии, риски. Нажмите «Проанализировать».</div>'}
      </div>
    </div>`:''}

    ${isStaff()?duplicatesPanelHtml():''}`;
  if($('nfAiRun'))$('nfAiRun').onclick=()=>loadAiInsights();
  bindDuplicatesPanel();
  // переходы по клику на задачу
  $('main').querySelectorAll('[data-nfgo]').forEach(el=>el.onclick=()=>{
    const tab=el.dataset.nfgo;
    S.tab=tab;saveNav();buildNav();render();
    refreshForTab(tab).then(()=>{if(S.tab===tab)render();}).catch(()=>{});
  });
  if($('nfReload'))$('nfReload').onclick=async()=>{
    await loadActivityLog();
    try{S.deletedItems=await dbList('deleted_items',{order:'deleted_at',asc:false});}catch(e){}
    renderNotify();toast('Обновлено');
  };
  $('main').querySelectorAll('[data-restore]').forEach(b=>b.onclick=()=>restoreDeletedItem(b.dataset.restore));
  const trashToggle=$('main').querySelector('[data-trashtoggle]');
  if(trashToggle)trashToggle.onclick=()=>{notifyTrashCollapsed=!notifyTrashCollapsed;renderNotify();};
}

function renderHistory(){
  if(!isStaff()){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа к этому разделу</div></div>';return;}
  const all=S.activityLog||[];
  const users=[...new Set(all.map(r=>r.user_name).filter(Boolean))].sort();
  $('main').innerHTML=`
    <div class="page-head"><div><h1>История изменений</h1><p>Журнал всех действий пользователей в системе</p></div>
      <div class="head-actions"><button class="btn ghost" id="histReload">↻ Обновить</button></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Журнал действий</h2><span class="count" id="histCount">0</span></div>
      <div class="filters">
        <input class="search" id="hfq" placeholder="Поиск: объект, пользователь, поле…" value="${esc(hf.q)}">
        <select id="hfaction"><option value="">Все действия</option>${Object.entries(ACTION_LABEL).map(([k,l])=>`<option value="${k}" ${hf.action===k?'selected':''}>${l}</option>`).join('')}</select>
        <select id="hfentity"><option value="">Все объекты</option>${Object.entries(ENTITY_LABEL).map(([k,l])=>`<option value="${k}" ${hf.entity===k?'selected':''}>${l}</option>`).join('')}</select>
        <select id="hfuser"><option value="">Все пользователи</option>${users.map(u=>`<option value="${esc(u)}" ${hf.user===u?'selected':''}>${esc(u)}</option>`).join('')}</select>
      </div>
      <div class="filters filters-dates">
        <span class="fdate-lbl">Период:</span>
        <input type="date" id="hffrom" value="${esc(hf.from)}" title="С даты">
        <input type="date" id="hfto" value="${esc(hf.to)}" title="По дату">
        <button class="btn sm ghost" id="hfAll" title="Показать за всё время">Все дни</button>
        <button class="btn sm" id="hfclear">Сбросить</button>
      </div>
      <div id="histTable"></div>
    </div>`;
  $('histReload').onclick=async()=>{$('histTable').innerHTML='<div class="loading">Обновляем…</div>';await loadActivityLog();renderHistory();};
  const hDraw=()=>{histPage=1;drawHistory();}; // при смене фильтра — на первую страницу
  $('hfq').oninput=e=>{hf.q=e.target.value;hDraw();};
  $('hfaction').onchange=e=>{hf.action=e.target.value;hDraw();};
  $('hfentity').onchange=e=>{hf.entity=e.target.value;hDraw();};
  $('hfuser').onchange=e=>{hf.user=e.target.value;hDraw();};
  $('hffrom').onchange=e=>{hf.from=e.target.value;hDraw();};
  $('hfto').onchange=e=>{hf.to=e.target.value;hDraw();};
  $('hfclear').onclick=()=>{hf={q:'',action:'',entity:'',user:'',from:_todayStr,to:_todayStr};histPage=1;renderHistory();};
  if($('hfAll'))$('hfAll').onclick=()=>{hf.from='';hf.to='';histPage=1;renderHistory();};
  drawHistory();
}
function filteredHistory(){
  const q=hf.q.toLowerCase().trim();
  return (S.activityLog||[]).filter(r=>{
    if(hf.action&&r.action!==hf.action)return false;
    if(hf.entity&&r.entity!==hf.entity)return false;
    if(hf.user&&r.user_name!==hf.user)return false;
    const d=(r.created_at||'').slice(0,10);
    if(hf.from&&(!d||d<hf.from))return false;
    if(hf.to&&(!d||d>hf.to))return false;
    if(q){
      const chg=(r.changes||[]).map(c=>`${c.label} ${c.old} ${c.new}`).join(' ');
      const hay=[r.user_name,ENTITY_LABEL[r.entity]||r.entity,r.entity_label,ACTION_LABEL[r.action]||r.action,chg].join(' ').toLowerCase();
      if(!hay.includes(q))return false;
    }
    return true;
  });
}
function changesHtml(r){
  if(r.action==='ket')return '<span style="color:var(--muted);font-size:12px">Отправлен в KET'+(r.meta&&r.meta.ket_id?(' · ID '+esc(r.meta.ket_id)):'')+'</span>';
  if(!r.changes||!r.changes.length)return '<span style="color:var(--muted)">—</span>';
  return `<div class="log-changes">${r.changes.map(c=>`<div class="log-chg"><span class="f">${esc(c.label)}:</span> <span class="old">${esc(c.old)}</span><span class="arr">→</span><span class="new">${esc(c.new)}</span></div>`).join('')}</div>`;
}
function drawHistory(){
  const el=$('histTable');const rows=filteredHistory();
  const cnt=$('histCount');if(cnt)cnt.textContent=rows.length;
  if(!rows.length){el.innerHTML='<div class="empty"><div class="big">Записей нет</div>Измените фильтры или период — по умолчанию показан сегодняшний день.</div>';return;}
  // пагинация
  const pages=Math.max(1,Math.ceil(rows.length/HIST_PER_PAGE));
  if(histPage>pages)histPage=pages;
  const from=(histPage-1)*HIST_PER_PAGE;
  const pageRows=rows.slice(from,from+HIST_PER_PAGE);
  el.innerHTML=`<div class="table-scroll"><table class="resp-table"><thead><tr>
    <th>Дата и время</th><th>Пользователь</th><th>Действие</th><th>Объект</th><th>Что изменилось</th></tr></thead>
    <tbody>${pageRows.map(r=>{
      const t=fmtLogTime(r.created_at);
      const ent=ENTITY_LABEL[r.entity]||r.entity;
      const lbl=r.entity_label?(' '+r.entity_label):'';
      return `<tr>
        <td data-label="Дата и время"><div class="log-when"><b>${t.date}</b>${t.time}</div></td>
        <td data-label="Пользователь"><span class="log-user">${esc(logActorName(r))}</span></td>
        <td data-label="Действие"><span class="log-act ${esc(r.action)}">${esc(ACTION_LABEL[r.action]||r.action)}</span></td>
        <td data-label="Объект">${esc(ent)}${lbl?`<strong>${esc(lbl)}</strong>`:''}</td>
        <td data-label="Что изменилось">${changesHtml(r)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>
    ${pages>1?`<div class="hist-pager">
      <span class="hp-info">Показаны ${from+1}–${Math.min(from+HIST_PER_PAGE,rows.length)} из ${rows.length}</span>
      <div class="hp-btns">
        <button class="btn sm ghost" id="hpPrev" ${histPage<=1?'disabled':''}>‹ Назад</button>
        <span class="hp-page">Стр. ${histPage} / ${pages}</span>
        <button class="btn sm ghost" id="hpNext" ${histPage>=pages?'disabled':''}>Вперёд ›</button>
      </div>
    </div>`:''}`;
  if($('hpPrev'))$('hpPrev').onclick=()=>{if(histPage>1){histPage--;drawHistory();}};
  if($('hpNext'))$('hpNext').onclick=()=>{if(histPage<pages){histPage++;drawHistory();}};
}

/* ---------- РОУТЕР ---------- */
function render(){
  if(typeof removeOrdersPager==='function')removeOrdersPager(); // снять плавающую панель пагинации
  if(typeof removePickupsPager==='function')removePickupsPager();
  if(typeof removeInboundPager==='function')removeInboundPager();
  if(typeof removeWhProductsPager==='function')removeWhProductsPager();
  if(typeof removeSortListPager==='function')removeSortListPager();
  if(S.tab==='dashboard')renderDashboard();
  else if(S.tab==='pickups')renderPickups();
  else if(S.tab==='orders')renderOrders();
  else if(S.tab==='ket_orders')renderInboundOrders();
  else if(S.tab==='courier')renderOrders('courier');
  else if(S.tab==='mail')renderOrders('mail');
  else if(S.tab==='today')renderOrders('today');
  else if(S.tab==='partners')renderPartnersPage();
  else if(S.tab==='settings')renderSettings();
  else if(S.tab==='users')renderUsers();
  else if(S.tab==='history')renderHistory();
  else if(S.tab==='notify')renderNotify();
  else if(S.tab==='cash')renderCash();
  else if(S.tab==='sorting')renderSorting();
  else if(S.tab==='filling')renderFilling();
  else if(S.tab==='finance')renderFinance();
  else if(S.tab==='calc')renderCalc();
  else if(S.tab==='intercity')renderIntercity();
  else if(S.tab==='blanks')renderBlanks();
}