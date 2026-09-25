/* ================= МОДУЛЬ: СПРАВОЧНИКИ ================= */
const canEditDir=()=>can('directories','create')||can('directories','edit');

function renderSettings(){
  const dirs=[['cities','Города'],['districts','Районы'],
    ['couriers','Курьеры (заборщики)'],['order_couriers','Курьеры по заказам'],
    ['sales','Менеджеры по продажам'],['processors','Менеджеры-обработчики'],
    ['statuses','Статус забора'],['order_statuses','Статус заказа'],['delivery','Тип доставки'],
    ['courier_cities','Курьерские города'],['post_ips','ИП для Почты'],['warehouses','Склады отправки'],
    ['fin_kassa','Финансы · Кассы'],['fin_categories','Финансы · Категории расходов'],['fin_income_categories','Финансы · Категории приходов'],['fin_partners','Финансы · Партнёры'],
    ['maillabel','Бланк Казпочты'],['apidocs','Документация API']];
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Настройки</h1><p>${canEditDir()?'Базовые данные системы':'Просмотр настроек (редактирование — у администратора)'}</p></div></div>
    <div class="subtabs">${dirs.map(([k,l])=>`<button data-dir="${k}" class="${S.dir===k?'active':''}">${l}</button>`).join('')}</div>
    <div id="dirContent"></div>`;
  $('main').querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>{S.dir=b.dataset.dir;saveNav();renderSettings();});
  const map={partners:dirPartners,cities:dirCities,districts:dirDistricts,couriers:dirCouriers,
    order_couriers:dirOrderCouriers,sales:dirSales,processors:dirProcessors,statuses:dirStatuses,order_statuses:dirOrderStatuses,
    delivery:dirDelivery,courier_cities:dirCourierCities,post_ips:dirPostIp,warehouses:dirWarehouses,
    fin_kassa:dirFinanceKassa,fin_categories:dirFinanceCategories,fin_income_categories:dirFinanceIncomeCategories,fin_partners:dirFinancePartners,
    maillabel:dirMailLabel,apidocs:renderApiDocsSettings};
  (map[S.dir]||dirCities)();
}
// вкладка «Документация API» в Настройках — две ссылки на документацию по интеграциям,
// раньше «Документация API КЕТ» была отдельным пунктом бокового меню (ссылка на api-docs.html)
// Настройки бланка Казпочты. Раньше эти строки были впечатаны в PDF-шаблон, и чтобы
// сменить ИП, адрес или договор, приходилось пересобирать файл. Теперь они здесь.
const MAIL_LABEL_FIELDS=[
  ['sender','От кого','ТОО, ИП — кто отправитель'],
  ['from_addr','Откуда','адрес отправителя одной строкой'],
  ['support','Номер тех. поддержки','строка целиком, как должна печататься'],
  ['index_code','Индекс','почтовый индекс отправителя'],
  ['contract','Договор','номер и дата договора с Казпочтой'],
  ['payment_code','Код платежа','число справа вверху бланка'],
];
async function dirMailLabel(){
  const can=canEditDir();
  $('dirContent').innerHTML='<div class="panel"><div class="loading">Загружаем настройки…</div></div>';
  const cfg=await loadMailLabelSettings(true);
  $('dirContent').innerHTML=`<div class="panel">
    <div class="panel-head"><h2>Бланк Казпочты</h2></div>
    <div style="padding:4px 16px 18px">
      <p class="hint" style="margin-bottom:14px">Эти строки печатаются на бланке «5 нысан — форма 5»
        в блоке отправителя. Менять можно в любой момент — новые бланки сразу печатаются с новыми данными,
        уже напечатанные не меняются.</p>
      ${MAIL_LABEL_FIELDS.map(([k,label,hint])=>`
        <div class="field" style="margin-bottom:12px">
          <label>${esc(label)}</label>
          <input id="ml_${k}" value="${esc(cfg[k]||'')}" ${can?'':'disabled'}>
          <span class="hint" style="font-size:12px">${esc(hint)}</span>
        </div>`).join('')}
      ${can?'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">'+
        '<button class="btn primary" id="mlSave">Сохранить</button>'+
        '<button class="btn ghost" id="mlPreview">👁 Посмотреть образец</button>'+
        '<button class="btn ghost" id="mlReset">Вернуть прежние</button></div>'
        :'<p class="hint">Изменять может тот, кому разрешено редактировать справочники.</p>'}
    </div></div>`;
  if(!can)return;
  const read=()=>{const r={};MAIL_LABEL_FIELDS.forEach(([k])=>r[k]=val('ml_'+k).trim());return r;};
  $('mlSave').onclick=async()=>{
    const b=$('mlSave');b.disabled=true;b.textContent='Сохраняем…';
    const ok=await saveMailLabelSettings(read());
    b.disabled=false;b.textContent='Сохранить';
    if(ok){toast('Сохранено');logAction('update','directories',{entity_label:'Бланк Казпочты'});}
  };
  $('mlReset').onclick=()=>{
    if(!confirm('Вернуть значения, которые были на старом бланке?'))return;
    MAIL_LABEL_FIELDS.forEach(([k])=>{const el=$('ml_'+k);if(el)el.value=MAIL_LABEL_DEFAULTS[k]||'';});
    toast('Значения возвращены — не забудьте сохранить');
  };
  // образец печатается с ТЕМ, ЧТО СЕЙЧАС В ПОЛЯХ, даже если ещё не сохранено —
  // чтобы можно было посмотреть, как ляжет текст, прежде чем сохранять
  $('mlPreview').onclick=async()=>{
    const b=$('mlPreview');b.disabled=true;b.textContent='Готовим…';
    try{
      const saved=_mailLabelSettings;
      _mailLabelSettings=Object.assign({},MAIL_LABEL_DEFAULTS,read());
      const bytes=await generateMailLabelsPdf([{client:'Образец Клиент Клиентович',address:'обл., район, посёлок, улица, дом',phone:'7010000000',amount:2000}]);
      _mailLabelSettings=saved;
      await openOrDownloadPdf(bytes,'Образец_бланка.pdf');
    }catch(e){console.error('preview',e);toast('Не удалось сделать образец');}
    b.disabled=false;b.textContent='👁 Посмотреть образец';
  };
}

function renderApiDocsSettings(){
  $('dirContent').innerHTML=`
    <div class="panel">
      <div class="panel-head"><h2>Документация API</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px;padding:4px 16px 18px">
        <button class="btn ghost" id="docsKetBtn" style="justify-content:flex-start">📄 Документация API КЕТ</button>
        <button class="btn ghost" id="docsPartnerBtn" style="justify-content:flex-start">📄 Документация API «Заказы заборов» (партнёрская интеграция)</button>
      </div>
    </div>`;
  if($('docsKetBtn'))$('docsKetBtn').onclick=()=>ketDocsModal();
  if($('docsPartnerBtn'))$('docsPartnerBtn').onclick=()=>partnerApiDocsModal();
}
// отдельная страница «Партнёры» (вынесена из справочников в боковое меню)
let partnersTab='delivery'; // delivery | baraholka | warehouse
function renderPartnersPage(){
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Партнёры</h1><p>Партнёры доставки и партнёры склада</p></div></div>
    <div class="subtabs">
      <button data-ptab="delivery" class="${partnersTab==='delivery'?'active':''}">🚚 Партнёры доставки</button>
      ${baraholkaReady()?`<button data-ptab="baraholka" class="${partnersTab==='baraholka'?'active':''}">🏷 Барахолка</button>`:''}
      <button data-ptab="warehouse" class="${partnersTab==='warehouse'?'active':''}">📦 Партнёры склада</button>
    </div>
    <div id="dirContent"></div>`;
  $('main').querySelectorAll('[data-ptab]').forEach(b=>b.onclick=()=>{partnersTab=b.dataset.ptab;renderPartnersPage();});
  if(partnersTab==='delivery')dirPartners();
  else if(partnersTab==='baraholka')dirPartners(true);
  else renderWhPartners();
}

// справочник партнёров склада (отдельная сущность)
function renderWhPartners(){
  const arr=[...(S.warehouse_partners||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const canEd=can('directories','create');
  $('dirContent').innerHTML=`<div class="panel">
    <div class="panel-head"><h2>Партнёры склада</h2><span class="count">${arr.length}</span>
      ${canEd?`<button class="btn primary sm" id="whpAdd" style="margin-left:auto">＋ Добавить</button>`:''}</div>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Название</th><th>Контакт</th><th>Телефон</th><th>Комментарий</th><th></th>
    </tr></thead><tbody>
    ${arr.length?arr.map(p=>`<tr>
      <td data-label="Название"><strong>${esc(p.name||'—')}</strong></td>
      <td data-label="Контакт">${esc(p.contact||'—')}</td>
      <td data-label="Телефон">${p.phone?phoneLink(p.phone):'—'}</td>
      <td data-label="Комментарий">${esc(p.comment||'—')}</td>
      <td data-label="" class="cell-actions">${can('directories','edit')||can('directories','delete')?`<div class="row-actions">
        ${can('directories','edit')?`<button class="btn sm ghost" data-whpe="${p.id}">Изм.</button>`:''}
        ${can('directories','delete')?`<button class="btn sm danger" data-whpd="${p.id}">✕</button>`:''}
      </div>`:''}</td>
    </tr>`).join(''):`<tr><td colspan="5"><div class="empty"><div class="big">Нет партнёров склада</div>Добавьте бутики/магазины, чьи товары хранятся на складе.</div></td></tr>`}
    </tbody></table></div></div>`;
  if($('whpAdd'))$('whpAdd').onclick=()=>whPartnerModal();
  $('dirContent').querySelectorAll('[data-whpe]').forEach(b=>b.onclick=()=>whPartnerModal(b.dataset.whpe));
  $('dirContent').querySelectorAll('[data-whpd]').forEach(b=>b.onclick=async()=>{
    const p=(S.warehouse_partners||[]).find(x=>x.id===b.dataset.whpd);
    if(!confirm(`Удалить «${p&&p.name||'партнёра'}»?`))return;
    if(await dbDelete('warehouse_partners',b.dataset.whpd)){S.warehouse_partners=S.warehouse_partners.filter(x=>x.id!==b.dataset.whpd);toast('Удалено');renderPartnersPage();}
  });
}
function whPartnerModal(id){
  const p=id?(S.warehouse_partners||[]).find(x=>x.id===id):null;const d=p||{};
  const body=`<div class="form-grid">
    <div class="field full"><label>Название <span style="color:var(--rust)">*</span></label><input id="whp_name" value="${esc(d.name||'')}" placeholder="Напр. Бутик Viterro"></div>
    <div class="field"><label>Контактное лицо</label><input id="whp_contact" value="${esc(d.contact||'')}"></div>
    <div class="field"><label>Телефон</label><input id="whp_phone" value="${esc(d.phone||'')}"></div>
    <div class="field full"><label>Комментарий</label><input id="whp_comment" value="${esc(d.comment||'')}"></div>
  </div>`;
  showModal(id?'Изменить партнёра склада':'Новый партнёр склада',body,async()=>{
    const name=val('whp_name').trim();if(!name){toast('Введите название');return false;}
    const payload={name,contact:val('whp_contact').trim()||null,phone:val('whp_phone').trim()||null,comment:val('whp_comment').trim()||null};
    let saved;
    if(id){saved=await dbUpdate('warehouse_partners',id,payload);if(saved){const i=S.warehouse_partners.findIndex(x=>x.id===id);if(i>=0)Object.assign(S.warehouse_partners[i],saved);}}
    else{saved=await dbInsert('warehouse_partners',payload);if(saved){if(!S.warehouse_partners)S.warehouse_partners=[];S.warehouse_partners.unshift(saved);}}
    if(!saved){toast('Не удалось сохранить');return false;}
    toast(id?'Изменено':'Добавлено');renderPartnersPage();return true;
  });
}
function dirShell(title,count,onAdd,tableHtml){
  $('dirContent').innerHTML=`<div class="panel"><div class="panel-head"><h2>${esc(title)}</h2><span class="count">${count}</span>
    ${can('directories','create')?`<button class="btn primary sm" id="dirAdd" style="margin-left:auto">＋ Добавить</button>`:''}</div>${tableHtml}</div>`;
  if($('dirAdd'))$('dirAdd').onclick=onAdd;
}
function dirActions(id){
  const e=can('directories','edit'),d=can('directories','delete');
  if(!e&&!d)return '';
  return `<div class="row-actions">${e?`<button class="btn sm ghost" data-e="${id}">Изм.</button>`:''}${d?`<button class="btn sm danger" data-d="${id}">✕</button>`:''}</div>`;
}
function bindDir(table,arrKey,modalFn,deps){
  const wrap=$('dirContent');
  wrap.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>modalFn(b.dataset.e));
  wrap.querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{
    const arr=S[arrKey];const item=arr.find(x=>x.id===b.dataset.d);const label=item.name||item.fio||'запись';
    if(!confirm(`Удалить «${label}»?`))return;
    if(await dbDelete(table,b.dataset.d)){S[arrKey]=arr.filter(x=>x.id!==b.dataset.d);toast('Удалено');render();}
  });
}

/* ---- Универсальный построитель справочника с фильтром по каждой графе ---- */
// состояние фильтров по справочникам: { arrKey: { colKey: value } }
const dirFilters={};
function dirGrid(cfg){
  // cfg: {title, arrKey, table, modalFn, cols:[{key,label,text(row),cell(row)?,filter:'text'|'select',options(rows)?}], emptyText, filterRows?}
  // filterRows — отбор ДО фильтров пользователя: одна таблица показывается на двух
  // вкладках (обычные партнёры и Барахолка), и значения выпадающих фильтров должны
  // считаться уже по своей половине, иначе в списке городов будут чужие города.
  const arr=cfg.filterRows?cfg.filterRows(S[cfg.arrKey]||[]):(S[cfg.arrKey]||[]);
  if(!dirFilters[cfg.arrKey])dirFilters[cfg.arrKey]={};
  const f=dirFilters[cfg.arrKey];
  // если выбранное значение select-фильтра больше не доступно с учётом других фильтров — сбрасываем
  cfg.cols.forEach(c=>{
    if(c.filter!=='select'||!f[c.key])return;
    const base=arr.filter(row=>cfg.cols.every(oc=>{
      if(oc.key===c.key)return true;
      const ov=f[oc.key];if(!ov)return true;
      const t=(oc.text?oc.text(row):'')+'';
      if(oc.filter==='select')return t===ov;
      return t.toLowerCase().includes(ov.toLowerCase());
    }));
    const vals=new Set(base.map(r=>c.text?c.text(r):'').filter(Boolean));
    if(!vals.has(f[c.key]))f[c.key]='';
  });
  // применяем фильтры
  const filtered=arr.filter(row=>cfg.cols.every(c=>{
    const fv=f[c.key];if(!fv)return true;
    const cellText=(c.text?c.text(row):'')+'';
    if(c.filter==='select')return cellText===fv; // для select сравниваем по тексту значения
    return cellText.toLowerCase().includes(fv.toLowerCase());
  }));
  if(cfg.sort)filtered.sort(cfg.sort);
  // строка фильтров
  const filterRow=`<tr class="filter-row">${cfg.cols.map(c=>{
    if(c.filter==='select'){
      // опции строим из строк, прошедших фильтры ОСТАЛЬНЫХ колонок,
      // чтобы, например, при выбранном городе показывались только его районы
      const base=arr.filter(row=>cfg.cols.every(oc=>{
        if(oc.key===c.key)return true; // свой фильтр не учитываем
        const ov=f[oc.key];if(!ov)return true;
        const t=(oc.text?oc.text(row):'')+'';
        if(oc.filter==='select')return t===ov;
        return t.toLowerCase().includes(ov.toLowerCase());
      }));
      const vals=[...new Set(base.map(r=>c.text?c.text(r):'').filter(Boolean))].sort();
      // если выбранного значения больше нет среди доступных — сбрасываем
      if(f[c.key]&&!vals.includes(f[c.key]))f[c.key]='';
      return `<th><select class="dir-filter" data-fk="${c.key}"><option value="">Все</option>${vals.map(v=>`<option value="${esc(v)}" ${f[c.key]===v?'selected':''}>${esc(v)}</option>`).join('')}</select></th>`;
    }
    if(c.filter==='none')return `<th></th>`;
    return `<th><input class="dir-filter" data-fk="${c.key}" placeholder="фильтр…" value="${esc(f[c.key]||'')}"></th>`;
  }).join('')}<th></th></tr>`;
  const head=`<tr>${cfg.cols.map(c=>`<th>${esc(c.label)}</th>`).join('')}<th></th></tr>`;
  const body=filtered.length?filtered.map(row=>`<tr data-dirrow="${row.id}" style="cursor:pointer">${cfg.cols.map(c=>`<td>${c.cell?c.cell(row):esc(c.text?c.text(row):'')||'—'}</td>`).join('')}<td>${dirActions(row.id)}</td></tr>`).join('')
    :`<tr><td colspan="${cfg.cols.length+1}" style="text-align:center;color:var(--muted);padding:30px">Ничего не найдено</td></tr>`;
  const table=arr.length?`<div class="table-scroll"><table><thead>${head}${filterRow}</thead><tbody>${body}</tbody></table></div>`
    :`<div class="empty"><div class="big">${esc(cfg.emptyText||'Список пуст')}</div></div>`;
  // счётчик: при активном фильтре показываем «найдено / всего», иначе просто всего
  const anyFilter=cfg.cols.some(c=>f[c.key]);
  const countLabel=anyFilter?`${filtered.length} / ${arr.length}`:String(arr.length);
  dirShell(cfg.title,countLabel,()=>cfg.modalFn(),table);
  // привязки
  bindDir(cfg.table,cfg.arrKey,cfg.modalFn);
  // двойной клик по строке открывает карточку (кроме кликов по кнопкам действий)
  $('dirContent').querySelectorAll('[data-dirrow]').forEach(tr=>tr.ondblclick=e=>{
    if(e.target.closest('button,a,select,input'))return;
    if(canEditDir())cfg.modalFn(tr.dataset.dirrow);
  });
  $('dirContent').querySelectorAll('.dir-filter').forEach(el=>{
    const ev=el.tagName==='SELECT'?'onchange':'oninput';
    el[ev]=()=>{f[el.dataset.fk]=el.value;redrawDirGrid(cfg);};
  });
}
function redrawDirGrid(cfg){
  // перерисовываем только тело+фильтры, сохраняя фокус — проще целиком, но вернём фокус
  const active=document.activeElement;const fk=active&&active.dataset?active.dataset.fk:null;const pos=active&&active.selectionStart;
  dirGrid(cfg);
  if(fk){const el=$('dirContent').querySelector(`.dir-filter[data-fk="${fk}"]`);if(el){el.focus();try{el.setSelectionRange(pos,pos);}catch(e){}}}
}

/* Партнёры */
// Барахолка — это те же партнёры, отмеченные галочкой, а не отдельная таблица:
// заказ ссылается на партнёра из общего справочника, и вторая таблица заставила бы
// тянуть вторую связь через всю систему.
function dirPartners(onlyBar){
  const bar=p=>!!p.is_baraholka;
  dirGrid({title:onlyBar?'Партнёры Барахолки':'Справочник партнёров',arrKey:'partners',table:'partners',modalFn:partnerModal,
    filterRows:rows=>rows.filter(p=>onlyBar?bar(p):!bar(p)),
    emptyText:onlyBar?'Пока нет партнёров Барахолки — поставьте галочку в карточке партнёра':'Список партнёров пуст',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[
      {key:'name',label:'Наименование',filter:'text',text:p=>p.name||'',cell:p=>`<strong>${esc(p.name)}</strong>`},
      {key:'city',label:'Город',filter:'select',text:p=>cityName(p.city_id),cell:p=>cityPill(p.city_id)},
      {key:'district',label:'Район',filter:'select',text:p=>p.district_id?districtName(p.district_id):'',cell:p=>p.district_id?`<span class="pill moss">${esc(districtName(p.district_id))}</span>`:'—'},
      {key:'address',label:'Адрес',filter:'text',text:p=>p.address||''},
      {key:'sales',label:'Менеджер продаж',filter:'select',text:p=>p.sales_id?salesName(p.sales_id):''},
      {key:'proc',label:'Обработчик',filter:'select',text:p=>p.processor_id?processorName(p.processor_id):''},
      {key:'tpost',label:'Тариф почта',filter:'select',text:p=>p.tariff_post!=null&&p.tariff_post!==''?(+p.tariff_post).toLocaleString('ru-RU')+' ₸':''},
      {key:'tcour',label:'Тариф курьер',filter:'select',text:p=>p.tariff_courier!=null&&p.tariff_courier!==''?(+p.tariff_courier).toLocaleString('ru-RU')+' ₸':''},
    ]});
}
function partnerModal(id){
  const p=id?S.partners.find(x=>x.id===id):{name:'',city_id:'',district_id:'',address:'',phone:'',sales_id:'',processor_id:'',tariff_post:'',tariff_courier:''};
  const dOpts=cid=>S.districts.filter(d=>!cid||d.city_id===cid);
  showModal(id?'Партнёр':'Новый партнёр',`
    <div class="field"><label>Наименование <span style="color:var(--rust)">*</span></label><input id="p_name" value="${esc(p.name)}"></div>
    <div class="field"><label>Город <span style="color:var(--rust)">*</span></label><select id="p_city"><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${p.city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Район <span style="color:var(--rust)">*</span></label><select id="p_district"><option value="">—</option>${dOpts(p.city_id).map(d=>`<option value="${d.id}" ${p.district_id===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Адрес <span style="color:var(--rust)">*</span></label><input id="p_addr" value="${esc(p.address)}"></div>
    <div class="field"><label>Телефон <span style="color:var(--rust)">*</span></label><input id="p_phone" inputmode="numeric"></div>
    <div class="field"><label>Менеджер по продажам <span style="color:var(--rust)">*</span></label><select id="p_sales"><option value="">—</option>${S.sales.map(s=>`<option value="${s.id}" ${p.sales_id===s.id?'selected':''}>${esc(s.fio)}</option>`).join('')}</select></div>
    <div class="field"><label>Обработчик <span style="color:var(--rust)">*</span></label><select id="p_proc"><option value="">—</option>${S.processors.map(s=>`<option value="${s.id}" ${p.processor_id===s.id?'selected':''}>${esc(s.fio)}</option>`).join('')}</select></div>
    <div class="grid2">
      <div class="field"><label>Тариф · почтовая (₸) <span style="color:var(--rust)">*</span></label><input type="number" min="0" id="p_tpost" value="${esc(p.tariff_post)}" placeholder="0"></div>
      <div class="field"><label>Тариф · курьерская (₸) <span style="color:var(--rust)">*</span></label><input type="number" min="0" id="p_tcour" value="${esc(p.tariff_courier)}" placeholder="0"></div>
    </div>
    ${baraholkaReady()?`<label class="pom-paid" style="margin-top:4px"><input type="checkbox" id="p_bar" ${p.is_baraholka?'checked':''}> Барахолка <span class="pom-paidhint">(заказы считаются по своим нормативам; на уже созданные не влияет)</span></label>`:''}
    <label class="pom-paid" style="margin-top:4px"><input type="checkbox" id="p_protected" ${p.is_protected?'checked':''}> Неприкосновенный <span class="pom-paidhint">(любой размер пакета — по тарифу выше, без надбавок S/M/L)</span></label>
    <div class="field"><label>Условная сумма заказа при прямой оплате (₸)</label><input type="number" min="0" id="p_direct_pay" value="${esc(p.direct_pay_amount)}" placeholder="например 3000"><small style="color:var(--muted);font-size:12px">Для партнёров с тарифом 0 (платят за доставку сами, напрямую, минуя сумму заказа). Эта сумма подставится в «Калькуляцию» как условная выручка, чтобы такие заказы не выглядели чистым убытком.</small></div>
    <div class="field"><label>Доступ в кабинет партнёра</label>
      <input id="p_qr" value="${esc(p.qr_code||'')}" readonly placeholder="код ещё не выдан"
        style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.02em">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button type="button" class="btn ghost sm" id="p_gen_qr">🔐 ${p.qr_code?'Сменить код':'Выдать код'}</button>
        <button type="button" class="btn ghost sm" id="p_copy_qr">📋 Скопировать ссылку</button>
        <button type="button" class="btn ghost sm" id="p_show_qr">🔳 Показать QR</button>
      </div>
      <small style="color:var(--muted);font-size:12px">Ссылка с этим кодом пускает в кабинет <b>без пароля</b> — отправляйте её только самому партнёру. Смена кода сразу ломает старую ссылку.</small>
      <div id="p_qr_box" style="margin-top:10px"></div>
    </div>
    ${id?`<div class="field"><label>Приём заказов по API</label>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="wh-cat">${p.api_token_hash?'✅ токен настроен':'токен не выдан'}</span>
        <button type="button" class="btn ghost sm" id="p_gen_token">🔑 ${p.api_token_hash?'Перевыпустить токен':'Выдать токен'}</button>
      </div>
      <small style="color:var(--muted);font-size:12px">Партнёр сможет присылать готовые заказы напрямую через API — они автоматически попадут в «Заказы заборов» с заявкой на забор, выделены другим цветом. Перевыпуск токена отзывает старый — если у партнёра уже настроена интеграция, старый токен перестанет работать.</small>
      <div id="p_token_reveal"></div>
    </div>`:''}`,
    async()=>{
      // проверка обязательных полей (кроме QR-кода)
      const req=[
        ['p_name','Укажите наименование',()=>val('p_name').trim()],
        ['p_city','Выберите город',()=>val('p_city')],
        ['p_district','Выберите район',()=>val('p_district')],
        ['p_addr','Укажите адрес',()=>val('p_addr').trim()],
        ['p_phone','Укажите телефон',()=>phoneVal('p_phone').length>=10],
        ['p_sales','Выберите менеджера по продажам',()=>val('p_sales')],
        ['p_proc','Выберите обработчика',()=>val('p_proc')],
        ['p_tpost','Укажите тариф почтовой доставки',()=>val('p_tpost')!==''],
        ['p_tcour','Укажите тариф курьерской доставки',()=>val('p_tcour')!==''],
      ];
      for(const [fid,msg,ok] of req){
        if(!ok()){toast(msg);const el=$(fid);if(el){el.focus();el.style.borderColor='var(--rust)';}return false;}
      }
      const name=val('p_name').trim();
      const row={name,city_id:val('p_city')||null,district_id:val('p_district')||null,address:val('p_addr').trim(),phone:phoneVal('p_phone'),sales_id:val('p_sales')||null,processor_id:val('p_proc')||null,
        tariff_post:val('p_tpost')!==''?parseFloat(val('p_tpost')):null,tariff_courier:val('p_tcour')!==''?parseFloat(val('p_tcour')):null,qr_code:val('p_qr').trim()||null,
        direct_pay_amount:val('p_direct_pay')!==''?parseFloat(val('p_direct_pay')):null,
        is_protected:!!($('p_protected')&&$('p_protected').checked),
        ...($('p_bar')?{is_baraholka:!!$('p_bar').checked}:{})};
      let syncMsg='';
      if(id){
        const before=S.partners.find(x=>x.id===id);
        const salesChanged=before&&before.sales_id!==row.sales_id;
        const procChanged=before&&before.processor_id!==row.processor_id;
        const u=await dbUpdate('partners',id,row);if(!u)return false;Object.assign(before,u);
        // менеджер/обработчик у партнёра сменился — подтягиваем это же на ВСЕ уже существующие
        // заказы этого партнёра, а не только на новые (иначе старые заказы «зависают» на прежнем
        // менеджере навсегда, и это приходится чинить руками)
        if(salesChanged||procChanged){
          const patch={};
          if(salesChanged)patch.sales_id=row.sales_id;
          if(procChanged)patch.processor_id=row.processor_id;
          const {data:updated,error}=await sb.from('orders').update(patch).eq('partner_id',id).select('id');
          if(error){console.error('sync orders manager',error);syncMsg=' (но не удалось обновить менеджера в заказах: '+error.message+')';}
          else if(updated&&updated.length){
            const idsSet=new Set(updated.map(x=>x.id));
            S.orders.forEach(o=>{if(idsSet.has(o.id))Object.assign(o,patch);});
            syncMsg=` · обновлён менеджер в ${updated.length} существующих заказах`;
          }
        }
      }
      else{const u=await dbInsert('partners',row);if(!u)return false;S.partners.push(u);}
      toast('Сохранено'+syncMsg);renderPartnersPage();return true;});
  attachPhone('p_phone',p.phone);
  const cs=$('p_city');cs.onchange=()=>{$('p_district').innerHTML='<option value="">—</option>'+dOpts(cs.value).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');};
  // ---- доступ в кабинет партнёра ----
  const qrInp=$('p_qr');
  // новому партнёру код выдаём сразу, чтобы менеджер не забыл этот шаг
  if(qrInp&&!id&&!qrInp.value.trim())qrInp.value=genPartnerCode();
  const qrBox=$('p_qr_box');
  const paintQr=()=>{
    const code=qrInp?qrInp.value.trim():'';
    if(!qrBox)return;
    if(!code){qrBox.innerHTML='';return;}
    qrBox.dataset.shown='1';
    qrBox.innerHTML='<div style="background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;display:inline-block">'+
      '<img id="p_qr_img" width="200" height="200" alt="QR партнёра"></div>';
    renderQrInto($('p_qr_img'),partnerCabinetLink(code),200);
  };
  const genQr=$('p_gen_qr');
  if(genQr)genQr.onclick=()=>{
    if(qrInp.value.trim()&&!confirm('Старая ссылка партнёра перестанет работать сразу после сохранения. Сменить код?'))return;
    qrInp.value=genPartnerCode();
    genQr.textContent='🔐 Сменить код';
    toast('Код создан. Сохраните карточку и отправьте партнёру новую ссылку');
    if(qrBox&&qrBox.dataset.shown)paintQr();
  };
  const copyQr=$('p_copy_qr');
  if(copyQr)copyQr.onclick=async()=>{
    const code=qrInp.value.trim();
    if(!code){toast('Сначала выдайте код');return;}
    const link=partnerCabinetLink(code);
    try{await navigator.clipboard.writeText(link);toast('Ссылка скопирована');}
    catch(e){prompt('Скопируйте ссылку для партнёра:',link);}   // запасной путь, если буфер недоступен
  };
  const showQr=$('p_show_qr');
  if(showQr)showQr.onclick=()=>{
    if(!qrInp.value.trim()){toast('Сначала выдайте код');return;}
    paintQr();
  };
  const genBtn=$('p_gen_token');
  if(genBtn)genBtn.onclick=async()=>{
    if(p.api_token_hash&&!confirm('Старый токен перестанет работать, если у партнёра уже настроена интеграция. Продолжить?'))return;
    genBtn.disabled=true;genBtn.textContent='Генерируем…';
    // случайный токен — 32 байта в hex; хешируем тем же способом (sha256), что и на сервере,
    // сохраняем только хеш — сам токен нигде не хранится, показываем один раз
    const bytes=crypto.getRandomValues(new Uint8Array(32));
    const token=Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
    const hashBuf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    const hash=Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const u=await dbUpdate('partners',id,{api_token_hash:hash});
    genBtn.disabled=false;genBtn.textContent='🔑 Перевыпустить токен';
    if(!u){toast('Не удалось сохранить токен');return;}
    Object.assign(p,u);
    const reveal=$('p_token_reveal');
    if(reveal)reveal.innerHTML=`<div class="hint" style="margin-top:8px;border-color:var(--rust)">
      <b>Новый токен (покажется только сейчас, потом нигде не сохранён):</b><br>
      <code style="user-select:all;word-break:break-all;font-size:13px">${esc(token)}</code><br>
      <small style="color:var(--muted)">Отдайте это партнёру для настройки интеграции — вместе с адресом приёма заказов.</small>
    </div>`;
    toast('Токен выдан');
  };
}
/* Города */
function dirCities(){
  dirGrid({title:'Справочник городов',arrKey:'cities',table:'cities',modalFn:cityModal,emptyText:'Нет городов',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[
      {key:'name',label:'Город',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`},
      {key:'distr',label:'Районов',filter:'none',text:c=>String(S.districts.filter(d=>d.city_id===c.id).length)},
      {key:'cour',label:'Курьеров',filter:'none',text:c=>String(S.couriers.filter(k=>k.city_id===c.id).length)},
    ]});
}
function cityModal(id){const c=id?S.cities.find(x=>x.id===id):{name:''};
  showModal(id?'Город':'Новый город',`<div class="field"><label>Название города</label><input id="c_name" value="${esc(c.name)}"></div>`,
    async()=>{const name=val('c_name').trim();if(!name){toast('Укажите название');return false;}
      if(id){const u=await dbUpdate('cities',id,{name});if(!u)return false;Object.assign(S.cities.find(x=>x.id===id),u);}
      else{const u=await dbInsert('cities',{name});if(!u)return false;S.cities.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* Районы */
function dirDistricts(){
  dirGrid({title:'Справочник районов',arrKey:'districts',table:'districts',modalFn:districtModal,emptyText:'Нет районов',
    sort:(a,b)=>cityName(a.city_id).localeCompare(cityName(b.city_id))||(a.name||'').localeCompare(b.name||''),
    cols:[
      {key:'name',label:'Район',filter:'text',text:d=>d.name||'',cell:d=>`<strong>${esc(d.name)}</strong>`},
      {key:'city',label:'Город',filter:'select',text:d=>cityName(d.city_id),cell:d=>`<span class="pill gold">${esc(cityName(d.city_id))}</span>`},
    ]});
}
function districtModal(id){const d=id?S.districts.find(x=>x.id===id):{name:'',city_id:''};
  if(!S.cities.length){toast('Сначала добавьте город');return;}
  showModal(id?'Район':'Новый район',`
    <div class="field"><label>Название района</label><input id="d_name" value="${esc(d.name)}"></div>
    <div class="field"><label>Город</label><select id="d_city"><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${d.city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>`,
    async()=>{const name=val('d_name').trim();if(!name){toast('Укажите название');return false;}if(!val('d_city')){toast('Выберите город');return false;}
      const row={name,city_id:val('d_city')};
      if(id){const u=await dbUpdate('districts',id,row);if(!u)return false;Object.assign(S.districts.find(x=>x.id===id),u);}
      else{const u=await dbInsert('districts',row);if(!u)return false;S.districts.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* Курьеры-заборщики */
function dirCouriers(){
  dirGrid({title:'Справочник курьеров (заборщики)',arrKey:'couriers',table:'couriers',modalFn:courierModal,emptyText:'Нет курьеров',
    sort:(a,b)=>(a.fio||'').localeCompare(b.fio||''),
    cols:[
      {key:'fio',label:'ФИО',filter:'text',text:c=>c.fio||'',cell:c=>`<strong>${esc(c.fio)}</strong>`},
      {key:'city',label:'Город',filter:'select',text:c=>cityName(c.city_id),cell:c=>`<span class="pill gold">${esc(cityName(c.city_id))}</span>`},
      {key:'district',label:'Район',filter:'select',text:c=>c.district_id?districtName(c.district_id):'',cell:c=>c.district_id?`<span class="pill moss">${esc(districtName(c.district_id))}</span>`:'—'},
      {key:'phone',label:'Номер',filter:'text',text:c=>phoneDisplay(c.phone),cell:c=>phoneLink(c.phone)},
      {key:'iddoc',label:'Уд. личности',filter:'text',text:c=>c.id_doc||''},
      {key:'acc',label:'Аккаунт',filter:'select',text:c=>c.account_id?accountEmail(c.account_id):''},
    ]});
}
function courierModal(id){
  const c=id?S.couriers.find(x=>x.id===id):{fio:'',city_id:'',district_id:'',phone:'',id_doc:'',account_id:''};
  if(!S.cities.length){toast('Сначала добавьте город');return;}
  const dOpts=cid=>S.districts.filter(d=>!cid||d.city_id===cid);
  showModal(id?'Курьер':'Новый курьер',`
    <div class="field"><label>ФИО</label><input id="k_fio" value="${esc(c.fio)}"></div>
    <div class="field"><label>Город</label><select id="k_city"><option value="">—</option>${S.cities.map(ct=>`<option value="${ct.id}" ${c.city_id===ct.id?'selected':''}>${esc(ct.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Район</label><select id="k_district"><option value="">—</option>${dOpts(c.city_id).map(d=>`<option value="${d.id}" ${c.district_id===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Номер телефона</label><input id="k_phone" inputmode="numeric"></div>
    <div class="field"><label>Данные уд. личности</label><textarea id="k_id" rows="2">${esc(c.id_doc)}</textarea></div>
    ${courierAccountField('k_account',c.account_id,'pickup')}`,
    async()=>{const fio=val('k_fio').trim();if(!fio){toast('Укажите ФИО');return false;}if(!val('k_city')){toast('Выберите город');return false;}
      const row={fio,city_id:val('k_city'),district_id:val('k_district')||null,phone:phoneVal('k_phone'),id_doc:val('k_id').trim(),account_id:val('k_account')||null};
      if(id){const u=await dbUpdate('couriers',id,row);if(!u)return false;Object.assign(S.couriers.find(x=>x.id===id),u);}
      else{const u=await dbInsert('couriers',row);if(!u)return false;S.couriers.push(u);}
      toast('Сохранено');renderSettings();return true;});
  attachPhone('k_phone',c.phone);
  const cs=$('k_city');cs.onchange=()=>{$('k_district').innerHTML='<option value="">—</option>'+dOpts(cs.value).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');};
}
/* Курьеры по заказам */
function dirOrderCouriers(){
  dirGrid({title:'Справочник курьеров по заказам',arrKey:'order_couriers',table:'order_couriers',modalFn:orderCourierModal,emptyText:'Нет курьеров по заказам',
    sort:(a,b)=>(a.fio||'').localeCompare(b.fio||''),
    cols:[
      {key:'fio',label:'ФИО',filter:'text',text:c=>c.fio||'',cell:c=>`<strong>${esc(c.fio)}</strong>`},
      {key:'ccity',label:'Курьерский город',filter:'select',text:c=>courierCityName(c.courier_city_id),cell:c=>`<span class="pill gold">${esc(courierCityName(c.courier_city_id))}</span>`},
      {key:'phone',label:'Номер',filter:'text',text:c=>phoneDisplay(c.phone),cell:c=>phoneLink(c.phone)},
      {key:'iddoc',label:'Уд. личности',filter:'text',text:c=>c.id_doc||''},
      {key:'acc',label:'Аккаунт',filter:'select',text:c=>c.account_id?accountEmail(c.account_id):''},
    ]});
}
function orderCourierModal(id){
  const c=id?S.order_couriers.find(x=>x.id===id):{fio:'',courier_city_id:'',phone:'',id_doc:'',account_id:''};
  if(!S.courier_cities.length){toast('Сначала добавьте курьерский город');return;}
  showModal(id?'Курьер по заказам':'Новый курьер по заказам',`
    <div class="field"><label>ФИО</label><input id="oc_fio" value="${esc(c.fio)}"></div>
    <div class="field"><label>Курьерский город</label><select id="oc_city"><option value="">—</option>${S.courier_cities.map(ct=>`<option value="${ct.id}" ${c.courier_city_id===ct.id?'selected':''}>${esc(ct.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Номер телефона</label><input id="oc_phone" inputmode="numeric"></div>
    <div class="field"><label>Данные уд. личности</label><textarea id="oc_id" rows="2">${esc(c.id_doc)}</textarea></div>
    ${courierAccountField('oc_account',c.account_id,'order')}`,
    async()=>{const fio=val('oc_fio').trim();if(!fio){toast('Укажите ФИО');return false;}if(!val('oc_city')){toast('Выберите курьерский город');return false;}
      const row={fio,courier_city_id:val('oc_city'),phone:phoneVal('oc_phone'),id_doc:val('oc_id').trim(),account_id:val('oc_account')||null};
      if(id){const u=await dbUpdate('order_couriers',id,row);if(!u)return false;Object.assign(S.order_couriers.find(x=>x.id===id),u);}
      else{const u=await dbInsert('order_couriers',row);if(!u)return false;S.order_couriers.push(u);}
      toast('Сохранено');renderSettings();return true;});
  attachPhone('oc_phone',c.phone);
}
// поле привязки аккаунта (список профилей-курьеров), доступно только админу
function accountEmail(accId){const p=S.profiles.find(x=>x.id===accId);return p?(p.email||p.full_name||'аккаунт'):'аккаунт';}
function userNameById(id){const p=(S.profiles||[]).find(x=>x.id===id);return p?(p.full_name||p.email||'—'):'—';}
// является ли профиль курьером (по старому полю role или по базовому типу роли)
function isCourierProfile(p){
  if(p.role==='courier')return true;
  if(p.role_id){const r=S.roles.find(x=>x.id===p.role_id);if(r&&r.base_type==='courier')return true;}
  return false;
}
// courierAccountField(fieldId,current,kind): kind — 'pickup' (заборщик) | 'order' (по заказам)
function courierAccountField(fieldId,current,kind){
  if(!isAdmin())return '';
  let all=S.profiles.filter(isCourierProfile);
  // профили нужного типа курьера; те, у кого тип не задан (старые) — показываем во второй группе
  const match=all.filter(p=>p.courier_kind===kind);
  const unset=all.filter(p=>!p.courier_kind);
  // если привязан профиль другого типа — всё равно включим его, чтобы выбор не потерялся
  const cur=current?all.find(p=>p.id===current):null;
  let list=[...match,...unset];
  if(cur&&!list.find(p=>p.id===cur.id))list.unshift(cur);
  const kindLabel=p=>p.courier_kind==='pickup'?'заборщик':p.courier_kind==='order'?'по заказам':(p.position||'тип не задан');
  const optLabel=p=>esc((p.full_name||p.email||'аккаунт')+' · '+kindLabel(p));
  const noteEmpty=kind==='pickup'?'Нет нужного? Создайте пользователя с ролью «Курьер» и типом «Курьер заборщик» во вкладке «Пользователи».'
                                  :'Нет нужного? Создайте пользователя с ролью «Курьер» и типом «Курьер по заказам» во вкладке «Пользователи».';
  return `<div class="field"><label>Привязанный аккаунт (логин курьера)</label>
    <select id="${fieldId}"><option value="">— не привязан —</option>${list.map(p=>`<option value="${p.id}" ${current===p.id?'selected':''}>${optLabel(p)}</option>`).join('')}</select>
    <span class="hint">${noteEmpty}</span></div>`;
}
/* Менеджеры */
function managerCols(){return [
  {key:'fio',label:'ФИО',filter:'text',text:m=>m.fio||'',cell:m=>`<strong>${esc(m.fio)}</strong>`},
  {key:'phone',label:'Номер телефона',filter:'text',text:m=>phoneDisplay(m.phone),cell:m=>phoneLink(m.phone)},
];}
function dirSales(){dirGrid({title:'Менеджеры по продажам',arrKey:'sales',table:'sales_managers',modalFn:id=>managerModal('sales','sales_managers',id),emptyText:'Список пуст',sort:(a,b)=>(a.fio||'').localeCompare(b.fio||''),cols:managerCols()});}
function dirProcessors(){dirGrid({title:'Менеджеры-обработчики',arrKey:'processors',table:'processors',modalFn:id=>managerModal('processors','processors',id),emptyText:'Список пуст',sort:(a,b)=>(a.fio||'').localeCompare(b.fio||''),cols:managerCols()});}
function managerModal(arrKey,table,id){
  const m=id?S[arrKey].find(x=>x.id===id):{fio:'',phone:''};
  showModal(id?'Изменить':'Новая запись',`
    <div class="field"><label>ФИО</label><input id="mg_fio" value="${esc(m.fio)}"></div>
    <div class="field"><label>Номер телефона</label><input id="mg_phone" inputmode="numeric"></div>`,
    async()=>{const fio=val('mg_fio').trim();if(!fio){toast('Укажите ФИО');return false;}
      const row={fio,phone:phoneVal('mg_phone')};
      if(id){const u=await dbUpdate(table,id,row);if(!u)return false;Object.assign(S[arrKey].find(x=>x.id===id),u);}
      else{const u=await dbInsert(table,row);if(!u)return false;S[arrKey].push(u);}
      toast('Сохранено');renderSettings();return true;});
  attachPhone('mg_phone',m.phone);
}
/* Статусы */
function dirStatuses(){
  dirGrid({title:'Статусы забора',arrKey:'statuses',table:'statuses',modalFn:statusModal,emptyText:'Нет статусов',
    cols:[
      {key:'name',label:'Статус',filter:'text',text:s=>s.name||'',cell:s=>statusBadge(s.id)},
      {key:'pk',label:'Заявок',filter:'none',text:s=>String(S.pickups.filter(p=>p.status_id===s.id).length)},
    ]});
}
function statusModal(id){const s=id?S.statuses.find(x=>x.id===id):{name:'',color:'#c08a2d'};
  showModal(id?'Статус забора':'Новый статус забора',`
    <div class="field"><label>Название статуса</label><input id="s_name" value="${esc(s.name)}"></div>
    <div class="field"><label>Цвет метки</label><input type="color" id="s_color" value="${esc(s.color||'#c08a2d')}" style="height:44px;padding:4px;cursor:pointer"></div>`,
    async()=>{const name=val('s_name').trim();if(!name){toast('Укажите название');return false;}
      const row={name,color:val('s_color')||'#c08a2d'};
      if(id){const u=await dbUpdate('statuses',id,row);if(!u)return false;Object.assign(S.statuses.find(x=>x.id===id),u);}
      else{const u=await dbInsert('statuses',row);if(!u)return false;S.statuses.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* Статус заказа (отдельный справочник) */
function dirOrderStatuses(){
  dirGrid({title:'Статусы заказа',arrKey:'orderStatuses',table:'order_statuses',modalFn:orderStatusModal,emptyText:'Нет статусов заказа',
    cols:[
      {key:'name',label:'Статус',filter:'text',text:s=>s.name||'',cell:s=>orderStatusBadge(s.id)},
      {key:'or',label:'Заказов',filter:'none',text:s=>String(S.orders.filter(o=>o.status_id===s.id).length)},
    ]});
}
function orderStatusModal(id){const s=id?S.orderStatuses.find(x=>x.id===id):{name:'',color:'#3a7d44'};
  showModal(id?'Статус заказа':'Новый статус заказа',`
    <div class="field"><label>Название статуса</label><input id="os_name" value="${esc(s.name)}"></div>
    <div class="field"><label>Цвет метки</label><input type="color" id="os_color" value="${esc(s.color||'#3a7d44')}" style="height:44px;padding:4px;cursor:pointer"></div>`,
    async()=>{const name=val('os_name').trim();if(!name){toast('Укажите название');return false;}
      const row={name,color:val('os_color')||'#3a7d44'};
      if(id){const u=await dbUpdate('order_statuses',id,row);if(!u)return false;Object.assign(S.orderStatuses.find(x=>x.id===id),u);}
      else{const u=await dbInsert('order_statuses',row);if(!u)return false;S.orderStatuses.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* Тип доставки */
function dirDelivery(){
  dirGrid({title:'Типы доставки',arrKey:'delivery',table:'delivery_types',modalFn:deliveryModal,emptyText:'Нет типов',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Тип доставки',filter:'text',text:d=>d.name||'',cell:d=>`<strong>${esc(d.name)}</strong>`}]});
}
function deliveryModal(id){const d=id?S.delivery.find(x=>x.id===id):{name:''};
  showModal(id?'Тип доставки':'Новый тип',`<div class="field"><label>Наименование</label><input id="dl_name" value="${esc(d.name)}"></div>`,
    async()=>{const name=val('dl_name').trim();if(!name){toast('Укажите наименование');return false;}
      if(id){const u=await dbUpdate('delivery_types',id,{name});if(!u)return false;Object.assign(S.delivery.find(x=>x.id===id),u);}
      else{const u=await dbInsert('delivery_types',{name});if(!u)return false;S.delivery.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* Курьерские города */
function dirCourierCities(){
  dirGrid({title:'Курьерские города',arrKey:'courier_cities',table:'courier_cities',modalFn:courierCityModal,emptyText:'Нет городов',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Город',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`}]});
}
function courierCityModal(id){const c=id?S.courier_cities.find(x=>x.id===id):{name:''};
  showModal(id?'Курьерский город':'Новый город',`<div class="field"><label>Название города</label><input id="cc_name" value="${esc(c.name)}"></div>`,
    async()=>{const name=val('cc_name').trim();if(!name){toast('Укажите название');return false;}
      if(id){const u=await dbUpdate('courier_cities',id,{name});if(!u)return false;Object.assign(S.courier_cities.find(x=>x.id===id),u);}
      else{const u=await dbInsert('courier_cities',{name});if(!u)return false;S.courier_cities.push(u);}
      toast('Сохранено');renderSettings();return true;});}
/* ИП для Почты */
/* ИП для Почты. Набор полей повторяет «Настройки отправителей» в кабинете KET —
   чтобы данные отправителя лежали в одном месте и не приходилось лазить к ним.
   На бланк Казпочты попадают только поля из POST_IP_LABEL_FIELDS (см. MAIL_LABEL_KEYS
   в 11-zakazy.js); остальные — справочные: реквизиты и контакты. */
const POST_IP_LABEL_FIELDS=[
  ['label_prefix','Приставка','печатается перед названием ИП: «ТОО QP Service»'],
  ['from_addr','Адрес','пусто — возьмётся общий адрес из «Бланка Казпочты»'],
  ['support','Текст с номером тех. поддержки','строка целиком, как печатать на бланке'],
  ['contract','Номер договора',''],
  ['payment_code','Код платежа',''],
  ['index_code','Индекс',''],
];
const POST_IP_EXTRA_FIELDS=[
  ['inn','ИНН',''],
  ['iik','ИИК',''],
  ['bank_name','Название банка',''],
  ['bik','БИКС',''],
  ['support_phone','Телефон тех. поддержки','только номер, без текста'],
  ['manager','Менеджер',''],
  ['manager_contacts','Менеджер (контакты на бланке)',''],
];
// Баланс НЕ вводится руками: ИП связывается с безналичной кассой из «Финансов»,
// и остаток берётся оттуда — той же функцией, что показывает его в самом модуле.
// Если у сотрудника нет доступа к финансам, проводки ему не приходят и остаток
// показывать нечестно — пишем «—», а не ноль.
function postIpBalanceHtml(ip){
  if(!ip||!ip.kassa_id)return '<span class="wh-cat">касса не выбрана</span>';
  if(typeof can==='function'&&!can('finance','view'))return '<span class="wh-cat">нет доступа</span>';
  if(typeof currentKassaBalance!=='function')return '—';
  const v=currentKassaBalance(ip.kassa_id);
  return `<span style="font-weight:600">${Math.round(v).toLocaleString('ru-RU')} ₸</span>`;
}
function postIpKassaName(id){
  const k=(S.finance_kassa||[]).find(x=>x.id===id);
  return k?k.name:'';
}
function dirPostIp(){
  const col=(k,label)=>({key:k,label,filter:'text',text:c=>c[k]==null?'':String(c[k])});
  dirGrid({title:'ИП для Почты',arrKey:'post_ips',table:'post_ips',modalFn:postIpModal,emptyText:'Нет записей',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[
      col('label_prefix','Приставка'),
      {key:'name',label:'Название',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`},
      col('from_addr','Адрес'),
      col('support','Текст с номером тех. поддержки'),
      col('contract','Номер договора'),
      col('payment_code','Код'),
      col('index_code','Индекс'),
      col('inn','ИНН'),
      col('iik','ИИК'),
      col('bank_name','Название банка'),
      col('bik','БИКС'),
      col('support_phone','Телефон тех. поддержки'),
      {key:'kassa',label:'Безналичная касса',filter:'select',text:c=>postIpKassaName(c.kassa_id)},
      {key:'balance',label:'Баланс',text:c=>'',cell:c=>`<td data-label="Баланс">${postIpBalanceHtml(c)}</td>`},
      col('manager','Менеджер'),
      col('manager_contacts','Менеджер (контакты на бланке)'),
    ]});
}
function postIpModal(id){
  const c=id?S.post_ips.find(x=>x.id===id):{name:''};
  const fld=([k,label,hint])=>`
    <div class="field" style="margin-bottom:10px"><label>${esc(label)}</label>
      <input id="ip_${k}" value="${esc(c[k]==null?'':String(c[k]))}">
      ${hint?`<span class="hint" style="font-size:12px">${esc(hint)}</span>`:''}</div>`;
  // в выбор попадают только безналичные кассы — кассы городов к ИП отношения не имеют
  const kassas=(S.finance_kassa||[]).filter(k=>k.kassa_type==='cashless')
    .sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  showModal(id?'ИП для Почты':'Новый ИП',
    `<div class="field"><label>Название <span style="color:var(--rust)">*</span></label>
       <input id="ip_name" value="${esc(c.name||'')}"></div>
     <p class="hint" style="margin:10px 0 8px">Печатается на бланке Казпочты. Пустое поле берётся
       из общих настроек (Настройки → «Бланк Казпочты»), так что заполняйте только то, что у этого ИП своё.</p>
     ${POST_IP_LABEL_FIELDS.map(fld).join('')}
     <p class="hint" style="margin:14px 0 8px">Реквизиты и контакты — на бланк не печатаются,
       хранятся здесь для справки, чтобы не искать их в кабинете KET.</p>
     ${POST_IP_EXTRA_FIELDS.map(fld).join('')}
     <div class="field"><label>Безналичная касса (Финансы)</label>
       <select id="ip_kassa">
         <option value="">— не связана —</option>
         ${kassas.map(k=>`<option value="${k.id}" ${c.kassa_id===k.id?'selected':''}>${esc(k.name)}</option>`).join('')}
       </select>
       <span class="hint" style="font-size:12px">Баланс не вводится руками — он берётся из этой кассы.
         Сейчас: ${postIpBalanceHtml(c)}</span></div>`,
    async()=>{
      const name=val('ip_name').trim();
      if(!name){toast('Укажите название');return false;}
      const row={name,kassa_id:val('ip_kassa')||null};
      [...POST_IP_LABEL_FIELDS,...POST_IP_EXTRA_FIELDS].forEach(([k])=>{row[k]=val('ip_'+k).trim()||null;});
      if(id){const u=await dbUpdate('post_ips',id,row);if(!u)return false;Object.assign(S.post_ips.find(x=>x.id===id),u);}
      else{const u=await dbInsert('post_ips',row);if(!u)return false;S.post_ips.push(u);}
      dirPostIp();return true;
    });
}

/* Склады отправки (для модуля Отправки межгород) */
function dirWarehouses(){
  dirGrid({title:'Склады отправки',arrKey:'warehouses',table:'warehouses',modalFn:warehouseModal,emptyText:'Нет складов',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Склад',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`}]});
}
function warehouseModal(id){const c=id?S.warehouses.find(x=>x.id===id):{name:''};
  showModal(id?'Склад отправки':'Новый склад',`<div class="field"><label>Название склада</label><input id="wh_name" value="${esc(c.name)}" placeholder="Напр. Астана, Алматы"></div>`,
    async()=>{const name=val('wh_name').trim();if(!name){toast('Укажите название');return false;}
      if(id){const u=await dbUpdate('warehouses',id,{name});if(!u)return false;Object.assign(S.warehouses.find(x=>x.id===id),u);}
      else{const u=await dbInsert('warehouses',{name});if(!u)return false;S.warehouses.push(u);}
      toast('Сохранено');renderSettings();return true;});}