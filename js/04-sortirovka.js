
/* ================= МОДУЛЬ: СОРТИРОВКА ================= */
// кладовщик фотографирует накладную посылки (штрих-кодов на них нет — только рукописный/печатный
// текст) → ИИ распознаёт ФИО/адрес/телефон получателя → ищем среди СЕГОДНЯШНИХ ещё не
// отсортированных заказов лучшее совпадение → показываем город крупно + тип доставки → кладовщик
// подтверждает («Принял») — заказ помечается отсортированным. Так склад может начинать сортировку
// по городам сразу по мере поступления заказов, не дожидаясь, пока все «забивальщики» закончат
// вносить данные, и без отдельного реестра-выгрузки в Excel.
let sortingDate=null; // выбранная дата для просмотра/сортировки — по умолчанию сегодня
let sortingListFilter='all'; // 'all'|'sorted'|'unsorted' — фильтр статуса в списке заказов
let sortingListSearch=''; // текст поиска по ФИО/телефону/номеру в списке заказов
let sortListPage=1; // текущая страница (компьютерная пагинация)
let sortListPerPage=50; // заказов на странице (компьютер)
let sortListMobileLimit=20; // сколько показано на мобиле («показать ещё») — то же число, что MOBILE_STEP (она объявлена ниже по файлу, поэтому не ссылаемся на неё здесь напрямую)
// применяет фильтр статуса и поиск к списку — используется и для подсчёта, и для построения страницы
function sortingListFiltered(processed){
  let rows=[...processed];
  if(sortingListFilter==='sorted')rows=rows.filter(o=>o.sorted_at);
  else if(sortingListFilter==='unsorted')rows=rows.filter(o=>!o.sorted_at);
  const q=sortingListSearch.trim().toLowerCase();
  if(q){
    const qDigits=q.replace(/\D/g,'');
    rows=rows.filter(o=>
      (o.client||'').toLowerCase().includes(q)
      ||(o.code||'').toLowerCase().includes(q)
      ||(qDigits&&(o.phone||'').includes(qDigits)) // цифры сравниваем только если в запросе реально есть цифры
    );
  }
  rows.sort((a,b)=>(a.client||'').localeCompare(b.client||''));
  return rows;
}
function sortingListRowHtml(o){
  const isS=!!o.sorted_at;
  const courier=isCourierDelivery(o.delivery_id);
  return `<tr class="open" data-sortrow="${o.id}" style="cursor:pointer;background:${isS?'rgba(46,125,50,0.12)':'rgba(192,57,43,0.10)'}">
    <td data-label="ФИО">${esc(o.client||'—')}</td>
    <td data-label="Телефон">${o.phone?phoneLink(o.phone):'—'}</td>
    <td data-label="Тип доставки">${courier?'🚚 Курьер':'📮 Почта'}</td>
    <td data-label="Адрес">${esc(o.address||'—')}</td>
    <td data-label="№ заказа" style="font-family:monospace">${esc(o.code||'')}</td>
    <td data-label="Статус">${isS?'✅ Принят':'🔴 Не принят'}</td>
  </tr>`;
}
// перерисовывает только тело таблицы + пагинацию под ней (не всю страницу) — используется при
// вводе в поиск/смене фильтра/странице, чтобы курсор в поле поиска не сбрасывался
function renderSortListOnly(){
  const tbody=document.querySelector('#sortListTbody');if(!tbody)return;
  const myCity=S.me&&S.me.city_id;
  const cityFilter=o=>sortingCityId(o)===myCity;
  const dayOrders=(S.orders||[]).filter(o=>(o.created_at||'').slice(0,10)===sortingDate&&(!myCity||cityFilter(o)));
  const processed=dayOrders.filter(orderIsProcessed);
  const filtered=sortingListFiltered(processed);
  const mobile=isMobileView();
  let rows;
  if(mobile){
    rows=filtered.slice(0,sortListMobileLimit);
  }else{
    const totalPages=Math.max(1,Math.ceil(filtered.length/sortListPerPage));
    if(sortListPage>totalPages)sortListPage=totalPages;
    const startIdx=(sortListPage-1)*sortListPerPage;
    rows=filtered.slice(startIdx,startIdx+sortListPerPage);
  }
  tbody.innerHTML=rows.length?rows.map(sortingListRowHtml).join(''):'<tr><td colspan="6"><div class="empty" style="padding:20px">Заказов нет</div></td></tr>';
  bindSortRowClicks();
  renderSortListFooter(filtered,mobile);
}
// подпись/пагинация под таблицей — компьютер: плавающая панель (как везде), мобиле: «показать ещё»
function renderSortListFooter(filtered,mobile){
  const old=$('sortListMoreWrap');if(old)old.remove();
  if(mobile){
    removeSortListPager();
    const shown=Math.min(sortListMobileLimit,filtered.length);
    const wrap=document.createElement('div');wrap.id='sortListMoreWrap';
    if(shown<filtered.length){
      wrap.innerHTML=`<button class="btn ghost show-more" id="sortListMoreBtn">Показать ещё (${filtered.length-shown})</button>
        <div class="list-count">Показано ${shown} из ${filtered.length}</div>`;
    }else{
      wrap.innerHTML=`<div class="list-count">Показано ${shown} из ${filtered.length}</div>`;
    }
    const tbl=document.querySelector('#sortListTbody');
    if(tbl)tbl.closest('.table-scroll').insertAdjacentElement('afterend',wrap);
    const moreBtn=$('sortListMoreBtn');
    if(moreBtn)moreBtn.onclick=()=>{sortListMobileLimit+=MOBILE_STEP;renderSortListOnly();};
  }else{
    const totalPages=Math.max(1,Math.ceil(filtered.length/sortListPerPage));
    const startIdx=(sortListPage-1)*sortListPerPage;
    const shownCount=Math.min(sortListPerPage,filtered.length-startIdx);
    renderSortListPager(filtered.length,totalPages,startIdx,Math.max(0,shownCount));
  }
}
function removeSortListPager(){const ex=$('sortListPager');if(ex)ex.remove();
  const m=$('main');if(m&&!$('ordersPager')&&!$('pickupsPager')&&!$('inboundPager')&&!$('whProdPager'))m.classList.remove('has-pager');}
function renderSortListPager(total,totalPages,startIdx,shownCount){
  removeSortListPager();
  if(!total)return;
  const from=startIdx+1, to=startIdx+shownCount;
  const bar=document.createElement('div');
  bar.id='sortListPager';bar.className='orders-pager';
  {const m=$('main');if(m)m.classList.add('has-pager');}
  bar.innerHTML=`
    <div class="op-info">Показаны <b>${from}–${to}</b> из <b>${total}</b></div>
    <div class="op-perpage">
      <span>На странице:</span>
      <div class="op-pp-wrap">
        <button class="op-btn op-pp-btn" id="slPerPageBtn">${sortListPerPage} ▾</button>
        <div class="op-pp-menu" id="slPerPageMenu" style="display:none">
          ${ORDERS_PAGE_SIZES.map(s=>`<button class="op-pp-item ${s===sortListPerPage?'active':''}" data-slpp="${s}">${s}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="op-nav">
      <button class="op-btn" data-slpage="first" ${sortListPage<=1?'disabled':''} title="В начало">«</button>
      <button class="op-btn" data-slpage="prev" ${sortListPage<=1?'disabled':''}>‹ Назад</button>
      <span class="op-page">Стр. ${sortListPage} / ${totalPages}</span>
      <button class="op-btn" data-slpage="next" ${sortListPage>=totalPages?'disabled':''}>Вперёд ›</button>
      <button class="op-btn" data-slpage="last" ${sortListPage>=totalPages?'disabled':''} title="В конец">»</button>
    </div>`;
  document.body.appendChild(bar);
  const ppBtn=bar.querySelector('#slPerPageBtn'), ppMenu=bar.querySelector('#slPerPageMenu');
  if(ppBtn)ppBtn.onclick=e=>{e.stopPropagation();ppMenu.style.display=ppMenu.style.display==='none'?'flex':'none';};
  bar.querySelectorAll('[data-slpp]').forEach(b=>b.onclick=()=>{
    sortListPerPage=parseInt(b.dataset.slpp,10)||50;sortListPage=1;renderSortListOnly();
  });
  bar.querySelectorAll('[data-slpage]').forEach(b=>b.onclick=()=>{
    const totalPagesNow=Math.max(1,Math.ceil(total/sortListPerPage));
    if(b.dataset.slpage==='first')sortListPage=1;
    else if(b.dataset.slpage==='prev')sortListPage=Math.max(1,sortListPage-1);
    else if(b.dataset.slpage==='next')sortListPage=Math.min(totalPagesNow,sortListPage+1);
    else if(b.dataset.slpage==='last')sortListPage=totalPagesNow;
    renderSortListOnly();
  });
}
function renderSorting(){
  if(!sortingDate)sortingDate=localToday();
  // если у сотрудника в карточке указан город («Упаковщик Алматы» и т.п.) — видит только заказы
  // в этот город; если город не указан (админ, общий доступ) — видит все города, как раньше
  const myCity=S.me&&S.me.city_id;
  const cityFilter=o=>sortingCityId(o)===myCity;
  const dayOrders=(S.orders||[]).filter(o=>(o.created_at||'').slice(0,10)===sortingDate&&(!myCity||cityFilter(o)));
  // «обработан» — менеджер уже внёс данные получателя И определился с типом доставки (курьер/почта).
  // Заказы, которые только созданы «пустышкой» по заявке (ждут забивки), кладовщику пока не нужны —
  // тип доставки во время забивки ещё может поменяться, показывать их рано.
  const processed=dayOrders.filter(orderIsProcessed);
  const total=processed.length;
  const notProcessed=dayOrders.length-total;
  const sorted=processed.filter(o=>o.sorted_at).length;
  const left=total-sorted;
  const courierCnt=processed.filter(o=>isCourierDelivery(o.delivery_id)).length;
  const mailCnt=total-courierCnt;
  const isToday=sortingDate===localToday();
  const labelQueue=processed.filter(labelNeedsPrint);
  // для админа (город не задан) — разбивка по городам: сколько заказов в каждом, сколько принято
  let cityBreakdownHtml='';
  if(!myCity){
    const byCity={};
    processed.forEach(o=>{
      const cid=sortingCityId(o);const nm=cid?cityName(cid):'Без города';
      if(!byCity[nm])byCity[nm]={total:0,sorted:0};
      byCity[nm].total++;if(o.sorted_at)byCity[nm].sorted++;
    });
    const entries=Object.entries(byCity).sort((a,b)=>b[1].total-a[1].total);
    if(entries.length){
      cityBreakdownHtml=`<div class="panel" style="margin-bottom:16px">
        <div class="panel-head"><h2>По городам</h2></div>
        <div class="table-scroll"><table class="resp-table"><thead><tr><th>Город</th><th>Заказов</th><th>Принято</th><th>Осталось</th></tr></thead><tbody>
          ${entries.map(([nm,c])=>`<tr>
            <td data-label="Город"><strong>${esc(nm)}</strong></td>
            <td data-label="Заказов">${c.total}</td>
            <td data-label="Принято" style="color:var(--rust)">${c.sorted}</td>
            <td data-label="Осталось">${c.total-c.sorted}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
    }
  }
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Сортировка</h1><p>Отсканируйте накладную посылки — подскажем, в какой она город${myCity?` · только ${esc(cityName(myCity))}`:''}</p></div></div>
    <div class="stats stats-3" style="margin-bottom:8px">
      <div class="stat"><div class="k">Заказов${isToday?' сегодня':''}</div><div class="v">${total}</div></div>
      <div class="stat"><div class="k">Принято</div><div class="v" style="color:var(--rust)">${sorted}</div></div>
      <div class="stat"><div class="k">Осталось</div><div class="v">${left}</div></div>
    </div>
    <div class="stats stats-3" style="margin-bottom:16px">
      <div class="stat"><div class="k">🚚 Курьерских</div><div class="v">${courierCnt}</div></div>
      <div class="stat"><div class="k">📮 Почтовых</div><div class="v">${mailCnt}</div></div>
      <div class="stat"><div class="k">Не обработано</div><div class="v" style="color:var(--muted)">${notProcessed}</div></div>
    </div>
    ${cityBreakdownHtml}
    <div class="panel" style="max-width:560px;margin:0 auto">
      <div style="text-align:center;padding:24px 16px">
        <label class="btn primary" style="cursor:pointer;font-size:17px;padding:18px 28px;display:inline-block">
          📷 Сканировать накладную
          <input type="file" accept="image/*" capture="environment" id="sortPhotoInput" style="display:none">
        </label>
      </div>
      <div id="sortResult"></div>
      <div style="border-top:1px solid var(--line);padding:14px 16px;display:flex;align-items:center;gap:10px;justify-content:center">
        <label style="font-size:13px;color:var(--muted)">Дата:</label>
        <input type="date" id="sortDateFilter" value="${sortingDate}" max="${localToday()}">
        ${!isToday?'<button class="btn ghost sm" id="sortDateToday">Сегодня</button>':''}
      </div>
    </div>
    ${labelPrintPanelHtml(labelQueue,isToday)}
    <div class="panel" style="margin-top:18px">
      <div class="panel-head"><h2>Список заказов</h2><span class="count">${total}</span></div>
      <p class="hint" style="margin:0 20px 10px;color:var(--muted)">Нажмите на заказ, чтобы вручную отметить его принятым/непринятым.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;padding:0 20px 14px;align-items:center">
        <select id="sortListStatusFilter" style="min-width:220px;padding:10px 14px;font-size:15px;border-radius:10px;border:1px solid var(--line);flex:1 1 220px">
          <option value="all" ${sortingListFilter==='all'?'selected':''}>Все статусы</option>
          <option value="sorted" ${sortingListFilter==='sorted'?'selected':''}>✅ Принятые</option>
          <option value="unsorted" ${sortingListFilter==='unsorted'?'selected':''}>🔴 Непринятые</option>
        </select>
        <input id="sortListSearch" placeholder="Поиск по ФИО или номеру…" value="${esc(sortingListSearch)}" style="flex:2 1 260px;min-width:260px;padding:10px 14px;font-size:15px;border-radius:10px;border:1px solid var(--line)">
      </div>
      <div class="table-scroll"><table class="resp-table"><thead><tr>
        <th>ФИО</th><th>Телефон</th><th>Тип доставки</th><th>Адрес</th><th>№ заказа</th><th>Статус</th>
      </tr></thead><tbody id="sortListTbody"></tbody></table></div>
    </div>`;
  const inp=$('sortPhotoInput');
  if(inp)inp.onchange=async e=>{
    const file=(inp.files||[])[0];if(!file)return;
    await handleSortPhoto(file);
    inp.value='';
  };
  const dateInp=$('sortDateFilter');
  if(dateInp)dateInp.onchange=()=>{if(dateInp.value){sortingDate=dateInp.value;sortListPage=1;sortListMobileLimit=MOBILE_STEP;renderSorting();}};
  const todayBtn=$('sortDateToday');
  if(todayBtn)todayBtn.onclick=()=>{sortingDate=localToday();sortListPage=1;sortListMobileLimit=MOBILE_STEP;renderSorting();};
  const statusFilterEl=$('sortListStatusFilter');
  if(statusFilterEl)statusFilterEl.onchange=()=>{sortingListFilter=statusFilterEl.value;sortListPage=1;sortListMobileLimit=MOBILE_STEP;renderSortListOnly();};
  const searchEl=$('sortListSearch');
  if(searchEl){
    searchEl.oninput=()=>{sortingListSearch=searchEl.value;sortListPage=1;sortListMobileLimit=MOBILE_STEP;renderSortListOnly();};
    // курсор остаётся в поле при вводе — перерисовываем только таблицу, не весь экран
  }
  bindLabelPrintPanel(labelQueue,isToday);
  renderSortListOnly();
}
// обработчик клика по строке в списке заказов — вынесен отдельно, используется и при полной,
// и при частичной (только таблица, при поиске) перерисовке
function bindSortRowClicks(){
  document.querySelectorAll('[data-sortrow]').forEach(tr=>tr.onclick=async e=>{
    if(e.target.closest('a,button'))return; // клик по ссылке-телефону не должен переключать статус
    const oid=tr.dataset.sortrow;
    const o=(S.orders||[]).find(x=>x.id===oid);if(!o)return;
    const willSort=!o.sorted_at;
    if(willSort&&!confirm(`Отметить заказ «${o.client||o.code||''}» принятым?`))return;
    if(!willSort&&!confirm(`Снять отметку «принят» с заказа «${o.client||o.code||''}»?`))return;
    const payload=willSort?{sorted_at:new Date().toISOString(),sorted_by_name:(S.me&&(S.me.full_name||S.me.email))||''}:{sorted_at:null,sorted_by_name:null};
    const u=await dbUpdate('orders',oid,payload);
    if(u){Object.assign(o,u);toast(willSort?'Отмечено принятым':'Отметка снята');renderSorting();}
    else toast('Не удалось сохранить');
  });
}
// «обработан» ли заказ менеджером — есть ФИО получателя и определён тип доставки (курьер/почта).
// Пока это не так — заказ существует (по заявке), но данные ещё забивают, показывать его
// кладовщику рано (тип доставки, а с ним и город, может ещё поменяться).
function orderIsProcessed(o){return !!(o.client&&o.client.trim())&&!!o.delivery_id;}
// город назначения заказа — курьерский берёт из courier_city_id, почтовый из city_id
function orderDestCityId(o){return isCourierDelivery(o.delivery_id)?o.courier_city_id:o.city_id;}
// для «Сортировки» город кладовщика сверяется с городом ЗАБОРА заказа (pickup_city_id) — то есть
// в какой склад физически привезли посылку, а не куда она в итоге едет (это отдельно, для показа
// кладовщику, см. orderDestCityId выше). Талдыкорган считается «своим» для склада Алматы — заказы,
// забранные там, физически привозят на склад Алматы (нет отдельного склада в Талдыкоргане)
function sortingCityId(o){
  const cid=o.pickup_city_id;
  const cName=(cityName(cid)||'').toLowerCase();
  if(cName.includes('талдыкорган')){
    const almaty=(S.cities||[]).find(c=>(c.name||'').toLowerCase().includes('алматы')&&!(c.name||'').toLowerCase().includes('область'));
    if(almaty)return almaty.id;
  }
  return cid;
}
// заказы, которые сотрудник вообще может видеть в «Сортировке» — за выбранную дату, ещё не
// отсортированные, УЖЕ ОБРАБОТАННЫЕ менеджером, и (если у сотрудника задан город) только в его город
function sortingPool(){
  const day=sortingDate||localToday();
  const myCity=S.me&&S.me.city_id;
  return (S.orders||[]).filter(o=>(o.created_at||'').slice(0,10)===day&&!o.sorted_at&&orderIsProcessed(o)&&(!myCity||sortingCityId(o)===myCity));
}
// необработанные (пустые) заказы за тот же день/город — чтобы отличить «правда нет такого заказа»
// от «заказ есть, просто ещё не забили» и показать кладовщику понятное сообщение вместо путаницы
function sortingUnprocessedCount(){
  const day=sortingDate||localToday();
  const myCity=S.me&&S.me.city_id;
  return (S.orders||[]).filter(o=>(o.created_at||'').slice(0,10)===day&&!orderIsProcessed(o)&&(!myCity||sortingCityId(o)===myCity)).length;
}
// сжимает фото перед отправкой на распознавание — полноразмерный снимок с телефона (часто
// несколько МБ) не нужен для чтения текста на бланке, а сильно замедляет и отправку, и саму
// работу ИИ. Уменьшаем до разумного размера и пережимаем в JPEG с хорошим, но не максимальным
// качеством — текст остаётся полностью читаемым, а объём падает в разы.
function resizeImageForAI(file,maxDim=1400,quality=0.75){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{
      URL.revokeObjectURL(url);
      let w=img.width,h=img.height;
      if(w>maxDim||h>maxDim){
        if(w>h){h=Math.round(h*maxDim/w);w=maxDim;}else{w=Math.round(w*maxDim/h);h=maxDim;}
      }
      const canvas=document.createElement('canvas');
      canvas.width=w;canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      const dataUrl=canvas.toDataURL('image/jpeg',quality);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Не удалось обработать изображение'));};
    img.src=url;
  });
}
async function handleSortPhoto(file){
  const resultEl=$('sortResult');if(!resultEl)return;
  resultEl.innerHTML='<div class="hint" style="text-align:center;padding:24px">⏳ Распознаём накладную…</div>';
  try{
    const b64=await resizeImageForAI(file);
    const media_type='image/jpeg'; // после сжатия всегда jpeg, независимо от исходного формата (heic/png/…)
    const system='Ты распознаёшь рукописные и печатные бланки посылок логистической компании (Казахстан). На фото есть поле ПОЛУЧАТЕЛЬ с ФИО, адресом и телефоном. Верни СТРОГО JSON без пояснений и markdown, формат: {"client":"ФИО получателя","address":"адрес получателя","phone":"телефон только цифры"}. Телефон верни как есть на бланке, только цифры без пробелов и скобок. Если поле не читается — пустая строка. Не выдумывай.';
    const prompt='Извлеки данные ПОЛУЧАТЕЛЯ (ФИО, адрес, телефон) с этого бланка. Верни только JSON.';
    const r=await callAI({system,prompt,image:{media_type,data:b64},model:'claude-sonnet-5',max_tokens:400});
    if(r.error){resultEl.innerHTML=`<div class="empty">Ошибка распознавания: ${esc(r.error)}<br><button class="btn ghost sm" id="sortRetryErr" style="margin-top:10px">🔄 Попробовать снова</button></div>`;const rb=$('sortRetryErr');if(rb)rb.onclick=()=>renderSorting();return;}
    let txt=(r.text||'').trim().replace(/^```json/i,'').replace(/```$/,'').trim();
    let data;try{data=JSON.parse(txt);}catch(e){resultEl.innerHTML='<div class="empty">Не удалось разобрать ответ ИИ. Попробуйте переснять чётче.<br><button class="btn ghost sm" id="sortRetryErr2" style="margin-top:10px">🔄 Попробовать снова</button></div>';const rb=$('sortRetryErr2');if(rb)rb.onclick=()=>renderSorting();return;}
    const matches=findSortMatches(data);
    renderSortResult(data,matches);
  }catch(e){resultEl.innerHTML=`<div class="empty">Ошибка: ${esc(String(e&&e.message||e))}</div>`;}
}
// ищем среди сегодняшних НЕотсортированных заказов (в своём городе, если он задан) совпадения
// по телефону/ФИО/адресу — возвращаем отсортированный по «похожести» список {order,score}
function findSortMatches(data){
  const pool=sortingPool();
  const phoneDigits=String(data.phone||'').replace(/\D/g,'').slice(-10);
  const nameNorm=String(data.client||'').toLowerCase().trim().replace(/\s+/g,' ');
  const addrNorm=String(data.address||'').toLowerCase().trim();
  const scored=pool.map(o=>{
    let score=0;
    const oPhone=String(o.phone||'').replace(/\D/g,'').slice(-10);
    if(phoneDigits&&oPhone&&oPhone===phoneDigits)score+=100; // телефон совпал — почти наверняка тот заказ
    const oName=(o.client||'').toLowerCase().trim().replace(/\s+/g,' ');
    if(nameNorm&&oName){
      if(oName===nameNorm)score+=60;
      else if(oName.includes(nameNorm)||nameNorm.includes(oName))score+=35;
      else{
        // частичное совпадение по отдельным словам (порядок ФИО на бланке может отличаться)
        const nWords=nameNorm.split(' ').filter(w=>w.length>2);
        const oWords=oName.split(' ').filter(w=>w.length>2);
        const common=nWords.filter(w=>oWords.includes(w)).length;
        if(common)score+=common*15;
      }
    }
    const oAddr=(o.address||'').toLowerCase().trim();
    if(addrNorm&&oAddr&&addrNorm.length>6&&oAddr.length>6){
      if(oAddr.includes(addrNorm.slice(0,12))||addrNorm.includes(oAddr.slice(0,12)))score+=15;
    }
    return {o,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
  return scored;
}
function renderSortResult(data,matches){
  const resultEl=$('sortResult');if(!resultEl)return;
  const best=matches[0];
  if(!best){
    const unprocessedCnt=sortingUnprocessedCount();
    resultEl.innerHTML=`<div class="empty" style="padding:20px">
      <div class="big">Заказ не найден</div>
      <div style="margin:10px 0;color:var(--muted);font-size:13px">Распознано: ${esc(data.client||'—')} · ${esc(data.address||'—')} · ${esc(data.phone||'—')}</div>
      ${unprocessedCnt?`<div style="margin:10px 0;padding:10px;background:var(--card);border-radius:10px;font-size:13px;color:var(--rust)">⏳ Заказ, возможно, есть, но ещё не обработан менеджером (сейчас необработанных: ${unprocessedCnt}). Попробуйте чуть позже.</div>`:''}
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">
        <button class="btn ghost sm" id="sortRetry">🔄 Переснять</button>
        <button class="btn ghost sm" id="sortManual">🔍 Искать вручную</button>
      </div>
    </div>`;
    bindSortResultButtons(data);
    return;
  }
  // Найденный заказ показываем окном: кроме города кладовщику надо вписать вес
  // и отсканировать штрих-код, а это уже форма, а не строчка под кнопкой.
  resultEl.innerHTML='';
  openSortOrderModal(best.o,best.score>=80,data,matches);
}
function bindSortResultButtons(data){
  const retry=$('sortRetry');if(retry)retry.onclick=()=>renderSorting();
  const manual=$('sortManual');if(manual)manual.onclick=()=>renderSortManualPick(data,[]);
}
// ручной поиск/выбор — на случай, если ИИ не нашёл совпадение или нашёл не тот заказ
function renderSortManualPick(data,extraCandidates){
  const resultEl=$('sortResult');if(!resultEl)return;
  const pool=sortingPool();
  const renderList=(q)=>{
    const ql=q.trim().toLowerCase();
    let list=ql?pool.filter(o=>(o.client||'').toLowerCase().includes(ql)||(o.phone||'').includes(ql.replace(/\D/g,''))||(o.address||'').toLowerCase().includes(ql)):extraCandidates.map(x=>x.o);
    list=list.slice(0,20);
    if(!list.length)return `<div class="hint" style="padding:10px 0">${ql?'Ничего не найдено':'Начните вводить ФИО, телефон или адрес'}</div>`;
    return list.map(o=>{
      const courier=isCourierDelivery(o.delivery_id);
      const cty=courier?cityName(o.courier_city_id):cityName(o.city_id);
      return `<div class="sort-cand" data-sortpick="${o.id}" style="padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer;text-align:left">
        <div style="font-weight:600">${esc(o.client||'—')} <span style="float:right;color:var(--muted);font-weight:400">${esc(cty||'')}</span></div>
        <div style="font-size:12px;color:var(--muted)">${esc(o.address||'—')} · ${esc(o.phone||'')}</div>
      </div>`;
    }).join('');
  };
  resultEl.innerHTML=`<div style="padding:10px 0">
    <input id="sortSearchInp" placeholder="ФИО, телефон или адрес…" style="width:100%;margin-bottom:10px">
    <div id="sortSearchList">${renderList('')}</div>
    <button class="btn ghost sm" id="sortBackToPhoto" style="margin-top:8px">← Назад к фото</button>
  </div>`;
  const searchInp=$('sortSearchInp');
  if(searchInp)searchInp.oninput=()=>{const l=$('sortSearchList');if(l)l.innerHTML=renderList(searchInp.value);bindPickClicks();};
  const back=$('sortBackToPhoto');if(back)back.onclick=()=>renderSorting();
  const bindPickClicks=()=>{
    resultEl.querySelectorAll('[data-sortpick]').forEach(el=>{
      el.onclick=async()=>{
        const o=pool.find(x=>x.id===el.dataset.sortpick);if(!o)return;
        const meName=(S.me&&(S.me.full_name||S.me.email))||'';
        const u=await dbUpdate('orders',o.id,{sorted_at:new Date().toISOString(),sorted_by_name:meName});
        if(u){Object.assign(o,u);const courier=isCourierDelivery(o.delivery_id);const cty=courier?cityName(o.courier_city_id):cityName(o.city_id);toast(`Отмечено: «${cty}» · ${o.client||''}`);renderSorting();}
        else toast('Не удалось сохранить');
      };
    });
  };
  bindPickClicks();
}

// ==================== ПЕЧАТЬ ПОЧТОВЫХ БЛАНКОВ ИЗ «СОРТИРОВКИ» ====================
// Задача: кладовщик отсканировал накладную телефоном — и на складском принтере
// сам по себе выехал бланк, который остаётся наклеить.
//
// Телефон напрямую на складской принтер печатать не умеет, поэтому сканирование и
// печать разведены: телефон только отмечает заказ принятым, а бланк печатает тот
// компьютер, где включена «Автопечать» (галочка ниже) и открыт этот раздел.
// Галочка хранится в localStorage — она СВОЯ У КАЖДОГО УСТРОЙСТВА, чтобы телефон
// кладовщика не начал печатать заодно с компьютером.
//
// Молча, без диалога «куда печатать», печатает только Chrome, запущенный с ключом
// --kiosk-printing. В обычном браузере выйдет обычный диалог печати.
const LABEL_AUTOPRINT_KEY='jyldam_label_autoprint';
const LABEL_SINGLE_WAIT_MS=60000;  // сколько ждать пару к одинокому бланку, прежде чем печатать его одного
let _labelSingleTimer=null;        // таймер этого ожидания
let _labelSingleSince=null;        // {id,at} — когда одинокий бланк появился впервые
let _labelPrintBusy=false;         // защита от повторного запуска, пока готовится лист
let _labelPrintPauseUntil=0;       // до какого момента не пробовать печатать после неудачи
let _lastLabelSheet=null;          // последний собранный лист — для «Перепечатать»

function labelAutoPrintOn(){
  try{return localStorage.getItem(LABEL_AUTOPRINT_KEY)==='1';}catch(e){return false;}
}
function setLabelAutoPrint(on){
  try{localStorage.setItem(LABEL_AUTOPRINT_KEY,on?'1':'0');}catch(e){}
}
// бланк нужен почтовому заказу, который уже приняли на складе и на который бланк ещё не печатали
function labelNeedsPrint(o){
  return !isCourierDelivery(o.delivery_id)&&!!o.sorted_at&&!o.label_printed_at;
}
function labelPrintPanelHtml(queue,isToday){
  const auto=labelAutoPrintOn();
  return `
    <div class="panel" style="max-width:560px;margin:16px auto 0">
      <div class="panel-head"><h2>🖨 Печать бланков</h2><span class="count">${queue.length}</span></div>
      <div style="padding:12px 16px 16px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:15px">
          <input type="checkbox" id="labelAutoPrint" ${auto?'checked':''} style="width:18px;height:18px">
          <span>Автопечать на этом устройстве</span>
        </label>
        <p class="hint" style="margin:8px 0 0;color:var(--muted);font-size:12px">
          Включайте только на компьютере, к которому подключён принтер. На лист A4 идут два
          бланка, по линии реза лист разрезается пополам. Одинокий бланк ждёт пару до минуты,
          потом печатается один.
        </p>
        ${!isToday?'<p class="hint" style="margin:8px 0 0;color:var(--rust);font-size:12px">Выбран прошлый день — автопечать не работает, чтобы не напечатать старое. Кнопкой ниже можно напечатать вручную.</p>':''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button class="btn primary sm" id="labelPrintNow" ${queue.length?'':'disabled'}>🖨 Печатать все (${queue.length})</button>
          <button class="btn ghost sm" id="labelOpenPdf" ${queue.length?'':'disabled'}>Открыть PDF</button>
          ${_lastLabelSheet?'<button class="btn ghost sm" id="labelReprint">↻ Перепечатать последний лист</button>':''}
        </div>
      </div>
    </div>`;
}
function bindLabelPrintPanel(queue,isToday){
  const chk=$('labelAutoPrint');
  if(chk)chk.onchange=()=>{
    setLabelAutoPrint(chk.checked);
    toast(chk.checked?'Автопечать включена на этом устройстве':'Автопечать выключена');
    renderSorting();
  };
  const nowBtn=$('labelPrintNow');
  if(nowBtn)nowBtn.onclick=()=>printLabelsFor(queue,{open:false});
  const openBtn=$('labelOpenPdf');
  if(openBtn)openBtn.onclick=()=>printLabelsFor(queue,{open:true});
  const rep=$('labelReprint');
  if(rep)rep.onclick=async()=>{
    if(!_lastLabelSheet)return;
    await printPdfBytes(_lastLabelSheet);
  };
  labelAutoPrintTick(queue,isToday);
}
// Решает, печатать ли прямо сейчас. Вызывается при каждой перерисовке раздела —
// в том числе когда заказ прилетел через Realtime от телефона кладовщика.
function labelAutoPrintTick(queue,isToday){
  if(_labelSingleTimer){clearTimeout(_labelSingleTimer);_labelSingleTimer=null;}
  if(!queue.length)_labelSingleSince=null;
  if(!isToday||!labelAutoPrintOn()||_labelPrintBusy||!queue.length)return;
  // Пауза после неудачной попытки. Без неё автопечать зацикливается: печать не
  // удалась → заказ остался в очереди → перерисовка → снова попытка, и так без
  // конца, десятки запросов в секунду. Ловилось на проверке.
  if(Date.now()<_labelPrintPauseUntil){
    _labelSingleTimer=setTimeout(()=>{_labelSingleTimer=null;renderSorting();},_labelPrintPauseUntil-Date.now()+200);
    return;
  }
  if(queue.length>=2){_labelSingleSince=null;printLabelsFor(queue,{open:false});return;}
  // Один бланк — ждём пару, чтобы не тратить лист на половину. Если за минуту никто
  // ничего не отсканировал, печатаем его одного: посылка не должна ждать.
  //
  // Отсчёт идёт от ПЕРВОГО появления этого бланка, а не от последней перерисовки.
  // Иначе ожидание не кончится никогда: раздел перерисовывается на каждое изменение
  // в базе (Realtime), и таймер сбрасывался бы снова и снова.
  const id=queue[0].id;
  if(!_labelSingleSince||_labelSingleSince.id!==id)_labelSingleSince={id,at:Date.now()};
  const left=Math.max(0,LABEL_SINGLE_WAIT_MS-(Date.now()-_labelSingleSince.at));
  _labelSingleTimer=setTimeout(()=>{
    _labelSingleTimer=null;
    const fresh=(S.orders||[]).filter(o=>o.id===id&&labelNeedsPrint(o));
    if(fresh.length)printLabelsFor(fresh,{open:false});
  },left);
}
// Занимаем заказы ДО печати: условие `is('label_printed_at',null)` не даст двум
// устройствам напечатать один бланк дважды — второму просто ничего не достанется.
async function claimLabels(orders){
  const meName=(S.me&&(S.me.full_name||S.me.email))||'';
  const stamp={label_printed_at:new Date().toISOString(),label_printed_by:meName};
  const claimed=[];
  for(const o of orders){
    const {data,error}=await sb.from('orders').update(stamp).eq('id',o.id).is('label_printed_at',null).select();
    if(error){
      console.error('отметка о печати бланка',error);
      // Ошибку возвращаем наружу: «не смогли» и «уже напечатано другим» — разные
      // вещи, и сообщать о них надо по-разному.
      return {claimed,error};
    }
    if(data&&data.length){Object.assign(o,data[0]);claimed.push(o);continue;}
    // Ничего не обновилось — бланк уже занят другим устройством. Обязательно
    // подтягиваем его отметку в память: иначе заказ останется в очереди и
    // следующая же перерисовка попытается напечатать его снова, и так без конца.
    const {data:cur}=await sb.from('orders').select('id,label_printed_at,label_printed_by').eq('id',o.id).single();
    if(cur)Object.assign(o,cur);
  }
  return {claimed,error:null};
}
const LABEL_PAUSE_AFTER_FAIL_MS=60000; // пауза перед следующей попыткой, если печать не удалась
async function printLabelsFor(orders,opts){
  if(_labelPrintBusy||!orders.length)return;
  _labelPrintBusy=true;
  let printed=false;
  const btn=$('labelPrintNow');const orig=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent='Готовим…';}
  try{
    const {claimed,error}=await claimLabels(orders);
    if(error){toast('Не удалось отметить бланки: '+error.message);return;}
    if(!claimed.length){toast('Бланки уже напечатаны на другом устройстве');return;}
    const bytes=await buildMailLabelSheet(claimed);
    if(!bytes){
      // лист не собрался — снимаем отметку, иначе бланки потеряются молча
      await unclaimLabels(claimed);
      return;
    }
    _lastLabelSheet=bytes;
    if(opts&&opts.open)await openOrDownloadPdf(bytes,'Бланки_сортировка.pdf');
    else await printPdfBytes(bytes);
    printed=true;
    toast(`Бланков: ${claimed.length}`);
  }catch(e){
    console.error('печать бланков',e);
    toast('Ошибка печати: '+(e&&e.message||e));
  }finally{
    _labelPrintBusy=false;
    // Ничего не напечаталось — ждём минуту, прежде чем пробовать снова. Причина
    // обычно не проходит мгновенно (нет колонок в базе, нет сети), а без паузы
    // автопечать зациклится на перерисовках.
    _labelPrintPauseUntil=printed?0:Date.now()+LABEL_PAUSE_AFTER_FAIL_MS;
    if(btn){btn.disabled=false;btn.textContent=orig;}
    renderSorting();
  }
}
// возврат в очередь, если лист так и не собрался
async function unclaimLabels(orders){
  for(const o of orders){
    const u=await dbUpdate('orders',o.id,{label_printed_at:null,label_printed_by:null});
    if(u)Object.assign(o,u);
  }
  toast('Не удалось собрать бланки — заказы остались в очереди');
}


// ==================== ОКНО НАЙДЕННОГО ЗАКАЗА ====================
// Раньше найденный заказ показывался строчкой под кнопкой сканирования. Теперь это
// окно: кроме города кладовщику надо взвесить посылку и отсканировать штрих-код,
// а вес и код — это уже форма, и её лучше держать отдельно от списка заказов.
//
// Вес уходит в orders.weight — то же поле, что в карточке заказа и в выгрузке;
// штрих-код в orders.track — то же поле, что и трек Казпочты, и именно оно
// уезжает в KET (см. раздел 6b в CLAUDE.md).
function openSortOrderModal(o,confident,data,matches){
  const courier=isCourierDelivery(o.delivery_id);
  const ctyId=courier?o.courier_city_id:o.city_id;
  // cityName для неизвестного города возвращает прочерк — здесь он не нужен:
  // строка с городом либо есть целиком, либо её нет совсем.
  const cty=ctyId?cityName(ctyId):'';
  const deliveryType=courier?'🚚 Курьерская доставка':'📮 Почтовая доставка';
  // Вес и штрих-код спрашиваем только у почтовых: курьерские никуда не сдаются по
  // весу и трека у них нет — для них окно остаётся прежним, «город и Принял».
  const fields=courier?'':`
    <div style="border-top:1px solid var(--line);margin:14px 0 0;padding-top:14px">
      <div class="field">
        <label>Вес (кг)</label>
        <input id="sortWeight" type="text" inputmode="decimal"
               value="${o.weight!=null&&o.weight!==''?esc(o.weight):''}" placeholder="0"
               style="font-size:22px;padding:14px;text-align:center;font-weight:700">
        <span class="hint">Взвесьте посылку и впишите вес — он попадёт в карточку заказа. Можно через запятую.</span>
      </div>
      <div class="field" style="margin-top:12px">
        <label>Штрих-код</label>
        <div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">
          <input id="sortBarcode" value="${esc(o.track||'')}" placeholder="отсканируйте или введите" style="flex:1 1 180px;min-width:0;font-size:16px;padding:12px">
          <button type="button" class="btn ghost" id="sortScanBarcode" style="flex:1 1 150px;white-space:nowrap">📷 Сканировать</button>
        </div>
        <span class="hint">Тот же номер, что уходит в KET и служит треком.</span>
      </div>
      <div id="sortScanBox"></div>
    </div>`;
  // Город показываем, только если он в заказе указан: пустое место занимал прочерк
  // на весь экран, а данные клиента из-за него уезжали вниз. У почтовых заказов город
  // бывает не заполнен — тогда кладовщик ориентируется по адресу.
  const body=`
    <div style="text-align:center">
      ${cty?`<div style="font-size:38px;font-weight:800;line-height:1.1;margin:0 0 6px">${esc(cty)}</div>`:''}
      <div style="font-size:14px;color:var(--muted);margin-bottom:8px">${deliveryType}</div>
      <div style="font-size:16px;font-weight:600">${esc(o.client||'—')}</div>
      <div style="font-size:14px;color:var(--muted)">${esc(o.address||'—')}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">Заказ № ${esc(o.code||'')}</div>
    </div>${fields}`;
  const ov=showModal('Посылка',body,async()=>{
    const meName=(S.me&&(S.me.full_name||S.me.email))||'';
    const payload={sorted_at:new Date().toISOString(),sorted_by_name:meName};
    // Поле текстовое, а не числовое: у type="number" запятая считается ошибкой ввода,
    // значение молча становится пустым, и вес терялся бы при каждом «2,4».
    const wEl=ov.querySelector('#sortWeight');
    const wRaw=wEl?(wEl.value||'').trim().replace(',','.'):'';
    if(wRaw!==''){
      const w=parseFloat(wRaw);
      if(isNaN(w)||w<0||!/^\d*[.]?\d*$/.test(wRaw)){toast('Вес указан неверно — например 2,4');return false;}
      payload.weight=w;
    }
    const bcEl=ov.querySelector('#sortBarcode');
    const bc=bcEl?(bcEl.value||'').trim():'';
    if(bc)payload.track=bc;
    const u=await dbUpdate('orders',o.id,payload);
    if(!u){toast('Не удалось сохранить, попробуйте ещё раз');return false;}
    Object.assign(o,u);
    stopBarcodeScan();
    toast(`Отмечено: «${cty}» · ${o.client||''}`);
    renderSorting();
  },{mid:true});
  // «Заказ найден» — в шапку окна, рядом с заголовком: это про само окно, а не про
  // заказ, и сверху оно не отодвигает вниз данные клиента.
  const h3=ov.querySelector('.modal-head h3');
  if(h3)h3.insertAdjacentHTML('afterend',
    `<span style="margin-left:10px;font-size:12px;white-space:nowrap;color:${confident?'var(--muted)':'var(--rust)'}">${confident?'✅ Заказ найден':'⚠️ Сверьте данные'}</span>`);
  // кнопка «Сохранить» здесь по смыслу — «Принял», а рядом нужен выход к ручному выбору
  const saveBtn=ov.querySelector('[data-save]');
  if(saveBtn)saveBtn.textContent='✅ Принял';
  const cancelBtn=ov.querySelector('[data-cancel]');
  if(cancelBtn){
    cancelBtn.textContent='✕ Это не тот заказ';
    cancelBtn.onclick=()=>{stopBarcodeScan();ov.remove();syncModalOpenClass();
      document.querySelectorAll('.orders-pager[data-hidden-by-modal]').forEach(p=>{p.style.display='';delete p.dataset.hiddenByModal;});
      renderSortManualPick(data,matches.slice(1,6));};
  }
  const xBtn=ov.querySelector('.x');
  if(xBtn)xBtn.addEventListener('click',stopBarcodeScan);
  const scanBtn=ov.querySelector('#sortScanBarcode');
  if(scanBtn)scanBtn.onclick=()=>startBarcodeScan(ov);
  return ov;
}

// ==================== СКАНЕР ШТРИХ-КОДА ====================
// Камера включается прямо в окне заказа и читает код живьём, без снимка: ИИ тут не
// нужен и был бы медленнее и дороже.
//
// Где есть BarcodeDetector (Chrome, Android) — берём его: он встроен в браузер,
// ничего качать не надо. Где нет (Safari, iPhone) — подгружаем ZXing с CDN, но
// только в момент нажатия кнопки, чтобы не тянуть библиотеку всем и всегда.
let _barcodeStream=null;   // поток камеры — его обязательно надо гасить, иначе камера останется включённой
let _barcodeTimer=null;
let _zxingReader=null;
function stopBarcodeScan(){
  if(_barcodeTimer){clearInterval(_barcodeTimer);_barcodeTimer=null;}
  if(_zxingReader){try{_zxingReader.reset();}catch(e){}_zxingReader=null;}
  if(_barcodeStream){_barcodeStream.getTracks().forEach(t=>t.stop());_barcodeStream=null;}
  const box=document.getElementById('sortScanBox');if(box)box.innerHTML='';
}
async function startBarcodeScan(ov){
  const box=ov.querySelector('#sortScanBox');if(!box)return;
  stopBarcodeScan();
  box.innerHTML=`
    <div style="margin-top:12px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#000;position:relative">
      <video id="sortScanVideo" playsinline muted style="width:100%;display:block;max-height:280px;object-fit:cover"></video>
      <div style="position:absolute;inset:18% 8%;border:2px solid rgba(255,255,255,.9);border-radius:8px;pointer-events:none"></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px">
      <span class="hint" id="sortScanHint">Наведите камеру на штрих-код</span>
      <button type="button" class="btn ghost sm" id="sortScanStop">Отмена</button>
    </div>`;
  const stopBtn=box.querySelector('#sortScanStop');
  if(stopBtn)stopBtn.onclick=stopBarcodeScan;
  const video=box.querySelector('#sortScanVideo');
  const hint=box.querySelector('#sortScanHint');
  const done=code=>{
    const inp=ov.querySelector('#sortBarcode');
    if(inp)inp.value=code;
    stopBarcodeScan();
    toast('Штрих-код: '+code);
  };
  try{
    _barcodeStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
  }catch(e){
    console.error('камера',e);
    box.innerHTML=`<p class="hint" style="color:var(--rust);margin-top:10px">Камера недоступна: ${esc(String(e&&e.message||e))}. Введите код вручную.</p>`;
    return;
  }
  video.srcObject=_barcodeStream;
  try{await video.play();}catch(e){}
  if(box)box.scrollIntoView({block:'nearest',behavior:'smooth'});
  if('BarcodeDetector' in window){
    // Список форматов у браузеров разный: чего он не умеет, того просить нельзя —
    // конструктор ругнётся, и сканер не откроется вовсе. Поэтому пересекаем свой
    // список с тем, что браузер объявляет сам.
    let det=null;
    try{
      const want=['code_128','code_39','ean_13','ean_8','itf','qr_code'];
      const have=await window.BarcodeDetector.getSupportedFormats();
      const formats=want.filter(f=>have.includes(f));
      if(formats.length)det=new window.BarcodeDetector({formats});
    }catch(e){console.error('BarcodeDetector',e);}
    if(det){
      _barcodeTimer=setInterval(async()=>{
        try{
          const found=await det.detect(video);
          if(found&&found.length&&found[0].rawValue)done(found[0].rawValue.trim());
        }catch(e){/* кадр не разобрался — просто ждём следующий */}
      },300);
      return;
    }
  }
  // запасной путь для Safari/iPhone
  if(hint)hint.textContent='Готовим сканер…';
  try{
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
  }catch(e){
    box.innerHTML='<p class="hint" style="color:var(--rust);margin-top:10px">Сканер не загрузился — проверьте интернет или введите код вручную.</p>';
    stopBarcodeScan();return;
  }
  if(!window.ZXing){
    box.innerHTML='<p class="hint" style="color:var(--rust);margin-top:10px">Сканер не загрузился — введите код вручную.</p>';
    stopBarcodeScan();return;
  }
  if(hint)hint.textContent='Наведите камеру на штрих-код';
  _zxingReader=new window.ZXing.BrowserMultiFormatReader();
  _zxingReader.decodeFromStream(_barcodeStream,video,(res,err)=>{
    if(res&&res.getText)done(String(res.getText()).trim());
  });
}
