
/* ================= МОДУЛЬ: СКЛАД ================= */
// города склада (совпадают с названиями городов из справочника)
const WAREHOUSE_CITIES=['Алматы','Астана','Шымкент'];
// приводим произвольное написание города из заказа к одному из складов
function normalizeWhCity(raw){
  const s=String(raw||'').trim().toLowerCase();
  if(!s)return 'Алматы';
  if(s.includes('алмат')||s.includes('almat'))return 'Алматы';
  if(s.includes('астан')||s.includes('astana')||s.includes('нур-султан')||s.includes('нур султан')||s.includes('nur'))return 'Астана';
  if(s.includes('шымк')||s.includes('чимк')||s.includes('shym')||s.includes('chim'))return 'Шымкент';
  return 'Алматы';
}
let whCity='Алматы';           // выбранный город склада
let whSub='products';          // подвкладка: products (товары) | assembly_courier/assembly_mail (сборка) | intake (приёмка)
let whAssemblyType='courier';  // тип текущей сборки: courier | mail
let whSearch='';
let whPartner='';              // фильтр по партнёру (пусто = все)
let whProdPage=1;              // текущая страница списка товаров
let whProdPerPage=50;          // товаров на страницу

// генерация штрих-кода (если у товара нет своего) — EAN-13-подобный из времени + счётчика
// Счётчик на случай, когда штрих-коды генерируются в одну и ту же миллисекунду (пакетный
// импорт) — без него два товара могли получить одинаковый код.
let _barcodeSeq=0;
function genBarcode(){
  const uniq=(Date.now()+(_barcodeSeq++))%100000000000;
  const base='2'+String(uniq).padStart(11,'0').slice(-11); // 12 цифр, префикс 2 (внутренний диапазон)
  // контрольная цифра EAN-13
  let sum=0;for(let i=0;i<12;i++){sum+=parseInt(base[i],10)*(i%2?3:1);}
  const check=(10-(sum%10))%10;
  return base+check;
}
// сжимает выбранный файл-картинку до маленького квадратного JPEG (data URL) — храним прямо в products.photo,
// отдельное файловое хранилище (Supabase Storage) для этого не требуется
function resizeImageToDataURL(file,maxSize){
  maxSize=maxSize||300;
  return new Promise((resolve,reject)=>{
    if(!file||!file.type||!file.type.startsWith('image/')){reject(new Error('not an image'));return;}
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('read error'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('image error'));
      img.onload=()=>{
        const side=Math.min(img.width,img.height);
        const sx=(img.width-side)/2, sy=(img.height-side)/2;
        const canvas=document.createElement('canvas');
        canvas.width=maxSize;canvas.height=maxSize;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(img,sx,sy,side,side,0,0,maxSize,maxSize);
        resolve(canvas.toDataURL('image/jpeg',0.82));
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Вкладки-заглушки («Приёмка», «Инвентаризация») убраны: они показывали только надпись
// «в разработке» и создавали впечатление недоделанного раздела. Вернуть их — одна строка,
// когда эти разделы действительно появятся. Функция renderWhSoon оставлена для этого.
const WH_TABS=[ // ключ, иконка, подпись, реализовано ли (false = «скоро», честная заглушка)
  ['overview','🏠','Обзор',true],
  ['products','📦','Товары',true],
  ['assembly','🚚','Сборка',true],
  ['returns','↩️','Возвраты',true],   // = существующая «Приёмка невыкупа»
  ['moves','📊','Движения',true],
];
function whTabKeyFor(sub){ // внутренний whSub → ключ верхней вкладки (для подсветки активной)
  if(sub==='products')return'products';
  if(sub==='moves')return'moves';
  if(sub==='intake')return'returns';
  if(sub==='assembly_courier'||sub==='assembly_mail')return'assembly';
  return sub; // overview / receiving / stocktake
}
/* ==================== ФИНАНСЫ ==================== */
// «Остаток кассы» и «Остаток партнёра» — это НЕ то, что вводит пользователь, а вычисляемый
// накопительный итог (снимок на момент этой проводки). Пересчитываем всю цепочку по кассе/партнёру
// в хронологическом порядке (по дате проводки, затем по времени создания) при каждом
// создании/редактировании/удалении проводки — так остатки всегда остаются верными, даже если
// проводку задним числом вставили в середину цепочки.
async function recalcKassaBalances(kassaId){
  if(!kassaId)return;
  const rows=(S.finance_entries||[]).filter(e=>e.kassa_id===kassaId)
    .sort((a,b)=>(a.entry_date||'').localeCompare(b.entry_date||'')||(a.created_at||'').localeCompare(b.created_at||''));
  let bal=0;
  for(const e of rows){
    bal+=(e.type==='income'?1:-1)*(parseFloat(e.amount)||0);
    if(e.kassa_balance!==bal){
      const u=await dbUpdate('finance_entries',e.id,{kassa_balance:bal});
      if(u)Object.assign(e,u);
    }
  }
}
async function recalcPartnerBalances(partnerId){
  if(!partnerId)return;
  const rows=(S.finance_entries||[]).filter(e=>e.partner_id===partnerId)
    .sort((a,b)=>(a.entry_date||'').localeCompare(b.entry_date||'')||(a.created_at||'').localeCompare(b.created_at||''));
  let bal=0;
  for(const e of rows){
    bal+=(e.type==='income'?1:-1)*(parseFloat(e.amount)||0);
    if(e.partner_balance!==bal){
      const u=await dbUpdate('finance_entries',e.id,{partner_balance:bal});
      if(u)Object.assign(e,u);
    }
  }
}
// универсальный поиск-с-подсказками — заменяет ненадёжный <datalist> (плохо работает на мобильных)
// собственным выпадающим списком под полем. inputId — id текстового поля, items — [{id,name}],
// onPick(item|null) — вызывается при выборе (null, если поле очистили)
function bindSearchDropdown(inputId,items,onPick){
  const inp=document.getElementById(inputId);if(!inp)return;
  // оборачиваем поле в свой собственный контейнер — чтобы выпадающий список позиционировался
  // строго под этим полем, независимо от того, как устроен родитель (flex-ряд фильтров и т.п.)
  // если функцию вызывают ПОВТОРНО на том же поле (например, список категорий сменился из-за
  // выбора другого Типа) — переиспользуем уже готовую обёртку, а не плодим новые вложенные
  let wrap=inp.parentElement,drop;
  const isColumnField=wrap&&getComputedStyle(wrap).flexDirection==='column';
  if(wrap&&wrap.classList&&wrap.classList.contains('ac-wrap')){
    drop=wrap.querySelector('.ac-dropdown');
  }else{
    wrap=document.createElement('span');
    wrap.className='ac-wrap';
    wrap.style.cssText=isColumnField?'position:relative;display:block;width:100%':'position:relative;display:inline-block';
    inp.parentElement.insertBefore(wrap,inp);
    wrap.appendChild(inp);
    if(isColumnField){inp.style.width='100%';inp.style.boxSizing='border-box';}
    drop=document.createElement('div');
    drop.className='ac-dropdown';drop.style.display='none';
    wrap.appendChild(drop);
  }
  let hiIdx=-1; // индекс подсвеченного стрелками пункта (-1 = ничего не подсвечено)
  const renderList=()=>{
    const q=inp.value.trim().toLowerCase();
    const matches=(q?items.filter(it=>(it.name||'').toLowerCase().includes(q)):items).slice(0,50);
    hiIdx=matches.length?0:-1; // по умолчанию подсвечен первый — Enter/Tab сразу же его и возьмут
    if(!matches.length){drop.innerHTML=`<div class="ac-empty">${q?'Ничего не найдено':'Список пуст'}</div>`;}
    else{drop.innerHTML=matches.map((it,i)=>`<div class="ac-item${i===0?' ac-hi':''}" data-acid="${it.id}">${esc(it.name)}</div>`).join('');}
    const pick=item=>{
      inp.value=item?item.name:'';
      inp.dataset.selid=item?item.id:'';
      drop.style.display='none';
      if(onPick)onPick(item||null);
    };
    const setHi=i=>{
      const els=[...drop.querySelectorAll('[data-acid]')];
      if(!els.length)return;
      hiIdx=(i+els.length)%els.length; // по кругу — со дна списка снова наверх, и наоборот
      els.forEach((el,idx)=>el.classList.toggle('ac-hi',idx===hiIdx));
      els[hiIdx].scrollIntoView({block:'nearest'});
    };
    drop.querySelectorAll('[data-acid]').forEach(el=>{
      // mousedown, а не click — срабатывает РАНЬШЕ blur поля, иначе список успевает закрыться
      // до того, как клик по нему засчитается
      el.onmousedown=ev=>{ev.preventDefault();pick(items.find(x=>x.id===el.dataset.acid));};
      el.onmouseenter=()=>{const els=[...drop.querySelectorAll('[data-acid]')];setHi(els.indexOf(el));};
    });
    drop._matches=matches;drop._pick=pick;drop._setHi=setHi;drop._getHi=()=>hiIdx;
    drop.style.display='block';
  };
  // печатают заново — прежний выбор больше не действует, пока не выберут снова из списка
  inp.addEventListener('input',()=>{inp.dataset.selid='';});
  inp.oninput=renderList;
  inp.onfocus=renderList;
  inp.onblur=()=>{setTimeout(()=>{drop.style.display='none';},120);};
  // ↑/↓ — двигают подсветку по списку; Tab/Enter — выбирают ИМЕННО подсвеченный пункт (по
  // умолчанию первый, если стрелками ничего не трогали)
  inp.onkeydown=ev=>{
    if(drop.style.display==='none')return;
    if(ev.key==='ArrowDown'){ev.preventDefault();drop._setHi((drop._getHi()<0?-1:drop._getHi())+1);return;}
    if(ev.key==='ArrowUp'){ev.preventDefault();drop._setHi((drop._getHi()<0?1:drop._getHi())-1);return;}
    if((ev.key==='Tab'||ev.key==='Enter')&&drop._matches&&drop._matches.length){
      const idx=drop._getHi()>=0?drop._getHi():0;
      drop._pick(drop._matches[idx]);
      if(ev.key==='Enter')ev.preventDefault(); // Enter не должен ещё и отправлять форму
      // Tab НЕ отменяем — фокус спокойно уходит на следующее поле, как обычно
    }
  };
}
function financeKassaName(id){return ((S.finance_kassa||[]).find(k=>k.id===id)||{}).name||'—';}
function isKassaTechnical(id){return !!((S.finance_kassa||[]).find(k=>k.id===id)||{}).is_technical;}
function isFinPartnerTechnical(id){return !!((S.finance_partners||[]).find(p=>p.id===id)||{}).is_technical;}
// текущий остаток — берём из САМОЙ СВЕЖЕЙ (по дате, затем по времени) проводки этой кассы/партнёра;
// если проводок ещё не было — остаток 0
function currentKassaBalance(kassaId){
  const rows=(S.finance_entries||[]).filter(e=>e.kassa_id===kassaId)
    .sort((a,b)=>(b.entry_date||'').localeCompare(a.entry_date||'')||(b.created_at||'').localeCompare(a.created_at||''));
  return rows.length?(rows[0].kassa_balance||0):0;
}
function currentPartnerBalance(partnerId){
  const rows=(S.finance_entries||[]).filter(e=>e.partner_id===partnerId)
    .sort((a,b)=>(b.entry_date||'').localeCompare(a.entry_date||'')||(b.created_at||'').localeCompare(a.created_at||''));
  return rows.length?(rows[0].partner_balance||0):0;
}
function financeCategoryName(id){
  const exp=(S.finance_categories||[]).find(c=>c.id===id);if(exp)return exp.name;
  const inc=(S.finance_income_categories||[]).find(c=>c.id===id);if(inc)return inc.name;
  return '—';
}
/* Справочник категорий ПРИХОДА — отдельный от категорий расхода */
function dirFinanceIncomeCategories(){
  dirGrid({title:'Категории приходов',arrKey:'finance_income_categories',table:'finance_income_categories',modalFn:financeIncomeCategoryModal,emptyText:'Нет категорий',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Название',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`}]});
}
function financeIncomeCategoryModal(id){const c=id?S.finance_income_categories.find(x=>x.id===id):{name:''};
  showModal(id?'Категория прихода':'Новая категория прихода',`<div class="field"><label>Название</label><input id="fic_name" value="${esc(c.name)}"></div>`,
    async()=>{const name=val('fic_name').trim();if(!name){toast('Укажите название');return false;}
      if(id){const u=await dbUpdate('finance_income_categories',id,{name});if(!u)return false;Object.assign(S.finance_income_categories.find(x=>x.id===id),u);}
      else{const u=await dbInsert('finance_income_categories',{name});if(!u)return false;S.finance_income_categories.push(u);}
      toast('Сохранено');dirFinanceIncomeCategories();return true;});}
function financePartnerName(id){return ((S.finance_partners||[]).find(p=>p.id===id)||{}).name||'—';}
let finFilter={dateFrom:'',dateTo:'',kassa:'',partner:'',type:'',category:''};
// столбцы таблицы проводок — можно перетаскивать (менять порядок) и тянуть за правый край
// (менять ширину), как в Excel. Порядок и ширины запоминаются в браузере.
// без ₸ — используется и в конфигурации колонок (FIN_COLUMNS), и внутри renderFinance
const fmtNum=n=>Math.round(n||0).toLocaleString('ru-RU');
const FIN_COLUMNS=[
  {key:'date',label:'Дата',sortable:'date',width:150,
    cell:e=>`<td data-label="Дата">${esc(fmtDate(e.entry_date))}${e.created_at?`<small class="cell-time">${esc((fmtLogTime(e.created_at)||{}).time||'')}</small>`:''}</td>`,
    newCell:()=>`<td data-label="Дата"><input type="date" id="fen_date" value="${localToday()}"></td>`},
  {key:'kassa',label:'Касса',width:170,
    cell:e=>`<td data-label="Касса">${esc(financeKassaName(e.kassa_id))}${isKassaTechnical(e.kassa_id)?' <span class="wh-cat">⚙</span>':''}</td>`,
    newCell:()=>`<td data-label="Касса"><input id="fen_kassa" autocomplete="off" placeholder="Начните печатать…"></td>`},
  {key:'kassa_balance',label:'Остаток кассы',width:150,
    cell:e=>`<td data-label="Остаток кассы">${isKassaTechnical(e.kassa_id)?'<span class="wh-cat">не показывается</span>':(e.kassa_balance!=null?fmtNum(e.kassa_balance):'—')}</td>`,
    newCell:()=>`<td data-label="Остаток кассы">—</td>`},
  {key:'partner',label:'Партнёр',width:170,
    cell:e=>`<td data-label="Партнёр">${e.partner_id?esc(financePartnerName(e.partner_id))+(isFinPartnerTechnical(e.partner_id)?' <span class="wh-cat">⚙</span>':''):'—'}</td>`,
    newCell:()=>`<td data-label="Партнёр"><input id="fen_partner" autocomplete="off" placeholder="Необязательно"></td>`},
  {key:'partner_balance',label:'Остаток партнёра',width:160,
    cell:e=>`<td data-label="Остаток партнёра">${!e.partner_id?'—':(isFinPartnerTechnical(e.partner_id)?'<span class="wh-cat">не показывается</span>':(e.partner_balance!=null?fmtNum(e.partner_balance):'—'))}</td>`,
    newCell:()=>`<td data-label="Остаток партнёра">—</td>`},
  {key:'type',label:'Тип',width:110,
    cell:e=>`<td data-label="Тип"><span class="pill ${e.type==='income'?'moss':'gold'}">${e.type==='income'?'Приход':'Расход'}</span></td>`,
    newCell:()=>`<td data-label="Тип"><span id="fen_type_hint" style="color:var(--muted);font-size:12px">по категории</span></td>`},
  {key:'amount',label:'Сумма',sortable:'amount',width:130,
    cell:e=>`<td data-label="Сумма" style="color:${e.type==='income'?'#1a7f37':'#c0392b'};font-weight:600">${e.type==='income'?'+':'−'}${fmtNum(e.amount)}</td>`,
    newCell:()=>`<td data-label="Сумма"><input type="number" min="0" step="0.01" id="fen_amount" placeholder="0"></td>`},
  {key:'category',label:'Категория',sortable:'category',width:170,
    cell:e=>`<td data-label="Категория">${esc(financeCategoryName(e.category_id))}</td>`,
    newCell:()=>`<td data-label="Категория"><input id="fen_cat" autocomplete="off" placeholder="Начните печатать…"></td>`},
  {key:'comment',label:'Комментарий',width:200,
    cell:e=>`<td data-label="Комментарий">${esc(e.comment||'—')}</td>`,
    newCell:()=>`<td data-label="Комментарий"><input id="fen_comment" autocomplete="off" placeholder="—"></td>`},
  {key:'manager',label:'Менеджер',width:150,
    cell:e=>`<td data-label="Менеджер">${esc(e.manager_name||(e.manager_id?userNameById(e.manager_id):''))||'—'}</td>`,
    newCell:()=>`<td data-label="Менеджер">${esc((S.me&&(S.me.full_name||S.me.email))||'—')}</td>`},
];
let finColOrder=(()=>{try{const saved=JSON.parse(localStorage.getItem('finColOrder')||'null');
  if(Array.isArray(saved)&&saved.length===FIN_COLUMNS.length&&saved.every(k=>FIN_COLUMNS.some(c=>c.key===k)))return saved;}catch(e){}
  return FIN_COLUMNS.map(c=>c.key);})();
let finColWidths=(()=>{try{return JSON.parse(localStorage.getItem('finColWidths')||'{}')||{};}catch(e){return {};}})();
function finColumnsInOrder(){return finColOrder.map(k=>FIN_COLUMNS.find(c=>c.key===k)).filter(Boolean);}
function finColWidth(key){const c=FIN_COLUMNS.find(x=>x.key===key);return finColWidths[key]||( c?c.width:140);}
let finTab='entries'; // entries | summary
let finPage=1;
let finSummaryPage=1;
let finSort={col:null,dir:1}; // col: 'category'|'amount'; dir: 1=по возрастанию, -1=по убыванию
let finAddingNew=false; // показывать ли строку ввода новой проводки прямо в гриде (сверху)
let _finEscHandler=null; // текущий обработчик Escape на весь документ (пока открыта строка создания)
const finPerPage=50;
function exportFinanceToExcel(rows){
  if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
  if(!rows.length){toast('Нет проводок для выгрузки');return;}
  const data=rows.map(e=>({
    'Дата':fmtDate(e.entry_date),
    'Касса':financeKassaName(e.kassa_id),
    'Остаток кассы':isKassaTechnical(e.kassa_id)?'':(e.kassa_balance!=null?Math.round(e.kassa_balance):''),
    'Партнёр':e.partner_id?financePartnerName(e.partner_id):'',
    'Остаток партнёра':(!e.partner_id||isFinPartnerTechnical(e.partner_id))?'':(e.partner_balance!=null?Math.round(e.partner_balance):''),
    'Тип':e.type==='income'?'Приход':'Расход',
    'Сумма':Math.round(e.amount||0),
    'Категория':financeCategoryName(e.category_id),
    'Комментарий':e.comment||'',
    'Менеджер':e.manager_name||(e.manager_id?userNameById(e.manager_id):''),
  }));
  const ws=XLSX.utils.json_to_sheet(data);
  const cols=Object.keys(data[0]||{});
  ws['!cols']=cols.map(c=>({wch:c==='Комментарий'?28:(c==='Касса'||c==='Партнёр'||c==='Категория'||c==='Менеджер'?20:14)}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Проводки');
  const today=localToday();
  XLSX.writeFile(wb,`Финансы_проводки_${today}.xlsx`);
  toast(`Выгружено проводок: ${rows.length}`);
}
async function refreshFinanceData(){
  const btn=$('finRefresh');
  if(btn){btn.disabled=true;btn.textContent='Обновляем…';}
  try{
    const [kassa,cats,incomeCats,partners,entries]=await Promise.all([
      dbList('finance_kassa',{order:'name'}).catch(()=>S.finance_kassa||[]),
      dbList('finance_categories',{order:'name'}).catch(()=>S.finance_categories||[]),
      dbList('finance_income_categories',{order:'name'}).catch(()=>S.finance_income_categories||[]),
      dbList('finance_partners',{order:'name'}).catch(()=>S.finance_partners||[]),
      dbList('finance_entries',{order:'entry_date',asc:false}).catch(()=>S.finance_entries||[]),
    ]);
    S.finance_kassa=kassa;S.finance_categories=cats;S.finance_income_categories=incomeCats;
    S.finance_partners=partners;S.finance_entries=entries;
    toast('Обновлено');
  }catch(e){toast('Не удалось обновить');}
  finally{renderFinance();}
}
function renderFinance(){
  if(!canMod('finance')){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  // Escape закрывает строку создания проводки, ГДЕ БЫ ни стоял фокус (даже если ни в одно поле
  // ещё не кликали) — привязываем на весь документ, снимая предыдущий обработчик каждый раз,
  // чтобы они не копились
  if(_finEscHandler){document.removeEventListener('keydown',_finEscHandler);_finEscHandler=null;}
  if(finAddingNew){
    _finEscHandler=ev=>{if(ev.key==='Escape'&&S.tab==='finance'){finAddingNew=false;renderFinance();}};
    document.addEventListener('keydown',_finEscHandler);
  }
  const all=[...(S.finance_entries||[])].sort((a,b)=>(b.entry_date||'').localeCompare(a.entry_date||'')||(b.created_at||'').localeCompare(a.created_at||''));
  const rows=all.filter(e=>{
    if(finFilter.dateFrom&&(e.entry_date||'')<finFilter.dateFrom)return false;
    if(finFilter.dateTo&&(e.entry_date||'')>finFilter.dateTo)return false;
    if(finFilter.kassa&&e.kassa_id!==finFilter.kassa)return false;
    if(finFilter.partner&&e.partner_id!==finFilter.partner)return false;
    if(finFilter.type&&e.type!==finFilter.type)return false;
    if(finFilter.category&&e.category_id!==finFilter.category)return false;
    return true;
  });
  // сортировка по клику на заголовок столбца (Дата/Категория — по возрастанию-убыванию,
  // Сумма — по величине); без выбора сортировки список остаётся по дате (как отсортирован all)
  if(finSort.col==='category'){
    rows.sort((a,b)=>finSort.dir*financeCategoryName(a.category_id).localeCompare(financeCategoryName(b.category_id)));
  }else if(finSort.col==='amount'){
    rows.sort((a,b)=>finSort.dir*((parseFloat(a.amount)||0)-(parseFloat(b.amount)||0)));
  }else if(finSort.col==='date'){
    rows.sort((a,b)=>finSort.dir*((a.entry_date||'').localeCompare(b.entry_date||'')||(a.created_at||'').localeCompare(b.created_at||'')));
  }
  const totalPages=Math.max(1,Math.ceil(rows.length/finPerPage));
  if(finPage>totalPages)finPage=totalPages;
  if(finPage<1)finPage=1;
  const pageRows=rows.slice((finPage-1)*finPerPage,finPage*finPerPage);
  const head=`
    <div class="page-head"><div><h1>Финансы</h1><p>Учёт проводок по кассам и партнёрам</p></div></div>
    <div class="subtabs">
      <button data-fintab="entries" class="${finTab==='entries'?'active':''}">Проводки</button>
      <button data-fintab="summary" class="${finTab==='summary'?'active':''}">Общая сводка</button>
    </div>`;
  if(finTab==='summary'){
    // общая сводка: по каждому партнёру — текущий остаток (последняя проводка по дате/времени),
    // сколько всего проводок, дата последней. Показываем ВСЕХ партнёров, даже с нулём проводок.
    const byPartner=new Map();
    (S.finance_partners||[]).forEach(p=>byPartner.set(p.id,{partner:p,count:0,lastDate:null,balance:0}));
    all.forEach(e=>{
      if(!e.partner_id)return;
      let s=byPartner.get(e.partner_id);
      if(!s){s={partner:{id:e.partner_id,name:financePartnerName(e.partner_id)},count:0,lastDate:null,balance:0};byPartner.set(e.partner_id,s);}
      s.count++;
      // all уже отсортирован по убыванию даты — первая встреченная запись для партнёра и есть самая свежая
      if(!s.lastDate){s.lastDate=e.entry_date;s.balance=e.partner_balance!=null?e.partner_balance:s.balance;}
    });
    // плюсовые остатки сверху, минусовые снизу, по убыванию — во всех сводках
    const summaryRows=[...byPartner.values()].sort((a,b)=>b.balance-a.balance);
    const sTotalPages=Math.max(1,Math.ceil(summaryRows.length/finPerPage));
    if(finSummaryPage>sTotalPages)finSummaryPage=sTotalPages;
    if(finSummaryPage<1)finSummaryPage=1;
    const summaryPageRows=summaryRows.slice((finSummaryPage-1)*finPerPage,finSummaryPage*finPerPage);
    // балансы касс — отдельно от партнёров, и отдельно кассы городов от безналичной (ИП/ТОО);
    // касс обычно немного, показываем все разом без страниц
    const kassaRowsAll=(S.finance_kassa||[]).map(k=>({kassa:k,balance:currentKassaBalance(k.id)})).sort((a,b)=>b.balance-a.balance);
    const kassaRowsCity=kassaRowsAll.filter(k=>k.kassa.kassa_type!=='cashless');
    const kassaRowsCashless=kassaRowsAll.filter(k=>k.kassa.kassa_type==='cashless');
    const kassaTableHtml=(rows,emptyText)=>`<div class="table-scroll">
      <table class="resp-table"><thead><tr><th>Касса</th><th>Текущий остаток</th></tr></thead><tbody>
      ${rows.length?rows.map(k=>`<tr>
        <td data-label="Касса"><strong>${esc(k.kassa.name)}</strong>${k.kassa.is_technical?' <span class="wh-cat">⚙ техническая</span>':''}</td>
        <td data-label="Текущий остаток">${k.kassa.is_technical?'<span class="wh-cat">не показывается</span>':`<span style="font-weight:700;color:${k.balance>0?'#1a7f37':(k.balance<0?'#c0392b':'inherit')}">${fmtNum(k.balance)}</span>`}</td>
      </tr>`).join(''):`<tr><td colspan="2"><div class="empty"><div class="big">Пусто</div>${esc(emptyText)}</div></td></tr>`}
      </tbody></table></div>`;
    $('main').innerHTML=head+`
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head"><h2>Касса городов</h2><span class="count">${kassaRowsCity.length}</span></div>
      ${kassaTableHtml(kassaRowsCity,'Добавьте кассу города через «⚙ Кассы».')}
    </div>
    <div class="panel" style="margin-bottom:18px">
      <div class="panel-head"><h2>Безналичная касса</h2><span class="count">${kassaRowsCashless.length}</span></div>
      ${kassaTableHtml(kassaRowsCashless,'Добавьте безналичную кассу (ИП/ТОО) через «⚙ Кассы».')}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Общая сводка по партнёрам</h2><span class="count">${summaryRows.length}</span></div>
      <div class="table-scroll">
      <table class="resp-table"><thead><tr><th>Партнёр</th><th>Текущий остаток</th></tr></thead><tbody>
      ${summaryPageRows.length?summaryPageRows.map(s=>`<tr>
        <td data-label="Партнёр"><strong>${esc(s.partner.name)}</strong>${s.partner.is_technical?' <span class="wh-cat">⚙ технический</span>':''}</td>
        <td data-label="Текущий остаток">${s.partner.is_technical?'<span class="wh-cat">не показывается</span>':`<span style="font-weight:700;color:${s.balance>0?'#1a7f37':(s.balance<0?'#c0392b':'inherit')}">${fmtNum(s.balance)}</span>`}</td>
      </tr>`).join(''):`<tr><td colspan="2"><div class="empty"><div class="big">Нет партнёров</div>Добавьте партнёра через «⚙ Партнёры».</div></td></tr>`}
      </tbody></table></div>
      <div class="simple-pager">
        <button class="btn sm ghost" id="finRefresh" title="Подтянуть свежие данные — полезно, если с модулем работает ещё кто-то">🔄 Обновить</button>
        ${summaryRows.length>finPerPage?`
        <button class="btn sm ghost" id="finSPgFirst" ${finSummaryPage<=1?'disabled':''}>« В начало</button>
        <button class="btn sm ghost" id="finSPgPrev" ${finSummaryPage<=1?'disabled':''}>‹ Назад</button>
        <span class="simple-pager-label">Стр. ${finSummaryPage} / ${sTotalPages} · ${summaryRows.length} партнёров</span>
        <button class="btn sm ghost" id="finSPgNext" ${finSummaryPage>=sTotalPages?'disabled':''}>Вперёд ›</button>
        <button class="btn sm ghost" id="finSPgLast" ${finSummaryPage>=sTotalPages?'disabled':''}>В конец »</button>`:''}
      </div>
    </div>`;
    $('main').querySelectorAll('[data-fintab]').forEach(b=>b.onclick=()=>{finTab=b.dataset.fintab;renderFinance();});
    if($('finRefresh'))$('finRefresh').onclick=refreshFinanceData;
    if($('finSPgFirst'))$('finSPgFirst').onclick=()=>{finSummaryPage=1;renderFinance();};
    if($('finSPgPrev'))$('finSPgPrev').onclick=()=>{finSummaryPage=Math.max(1,finSummaryPage-1);renderFinance();};
    if($('finSPgNext'))$('finSPgNext').onclick=()=>{finSummaryPage=Math.min(sTotalPages,finSummaryPage+1);renderFinance();};
    if($('finSPgLast'))$('finSPgLast').onclick=()=>{finSummaryPage=sTotalPages;renderFinance();};
    return;
  }
  $('main').innerHTML=head+`
    <div class="panel">
      <div class="panel-head"><h2>Проводки</h2><span class="count">${rows.length}</span></div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
        ${can('finance','create')?'<button class="btn primary sm" id="finNew">＋ Новая проводка</button>':''}
        ${can('finance','create')?'<button class="btn ghost sm" id="finSetBalance">🎯 Задать остаток</button>':''}
        <button class="btn btn-excel sm" id="finExport">⬇ Скачать Excel</button>
      </div>
      <div class="ic-filters">
        <input type="date" id="finfDateFrom" value="${esc(finFilter.dateFrom)}" title="С даты">
        <input type="date" id="finfDateTo" value="${esc(finFilter.dateTo)}" title="По дату">
        <input id="finfKassa" autocomplete="off" placeholder="Касса: поиск…" value="${finFilter.kassa?esc(financeKassaName(finFilter.kassa)):''}">
        <input id="finfPartner" autocomplete="off" placeholder="Партнёр: поиск…" value="${finFilter.partner?esc(financePartnerName(finFilter.partner)):''}">
        <select id="finfType"><option value="">Тип: все</option><option value="income" ${finFilter.type==='income'?'selected':''}>Приход</option><option value="expense" ${finFilter.type==='expense'?'selected':''}>Расход</option></select>
        <input id="finfCategory" autocomplete="off" placeholder="Категория: поиск…" value="${finFilter.category?esc(financeCategoryName(finFilter.category)):''}" style="position:relative">
        <button class="btn ghost sm" id="finfToday">Сегодня</button>
        ${(finFilter.dateFrom||finFilter.dateTo||finFilter.kassa||finFilter.partner||finFilter.type||finFilter.category||finSort.col)?'<button class="btn ghost sm" id="finfClear">✕ Сбросить</button>':''}
      </div>
      <div class="table-scroll">
      <table class="resp-table fin-table" id="finTable"><colgroup>${finColumnsInOrder().map(c=>`<col style="width:${finColWidth(c.key)}px">`).join('')}<col style="width:220px"></colgroup>
      <thead><tr>
        ${finColumnsInOrder().map(c=>`<th draggable="true" class="fin-th${c.sortable?' fin-sortable':''}" data-finkey="${c.key}" ${c.sortable?`data-finsort="${c.sortable}"`:''} title="Перетащите — переставить столбец${c.sortable?' · нажмите — сортировать':''}">${esc(c.label)}${finSort.col===c.sortable?(finSort.dir===1?' ▲':' ▼'):''}<span class="fin-col-resize" data-finresize="${c.key}"></span></th>`).join('')}
        <th></th>
      </tr></thead><tbody>
      ${finAddingNew?`<tr class="fin-new-row">
        ${finColumnsInOrder().map(c=>c.newCell()).join('')}
        <td data-label="" class="cell-actions"><div class="row-actions">
          <button class="btn sm primary" id="fenSave">Сохранить</button>
          <button class="btn sm ghost" id="fenCancel">Отмена</button>
        </div></td>
      </tr>`:''}
      ${pageRows.length?pageRows.map(e=>`<tr data-finrow="${e.id}" ${can('finance','edit')?'style="cursor:pointer"':''}>
        ${finColumnsInOrder().map(c=>c.cell(e)).join('')}
        <td data-label="" class="cell-actions"><div class="row-actions">
          ${can('finance','delete')?`<button class="btn sm danger" data-findel="${e.id}">Удалить</button>`:''}
        </div></td>
      </tr>`).join(''):`<tr><td colspan="11"><div class="empty"><div class="big">Нет проводок</div>${(finFilter.dateFrom||finFilter.dateTo||finFilter.kassa||finFilter.partner||finFilter.type||finFilter.category)?'Измените фильтры.':'Нажмите «Новая проводка».'}</div></td></tr>`}
      </tbody></table></div>
      <div class="simple-pager">
        <button class="btn sm ghost" id="finRefresh" title="Подтянуть свежие данные — полезно, если с модулем работает ещё кто-то">🔄 Обновить</button>
        ${rows.length>finPerPage?`
        <button class="btn sm ghost" id="finPgFirst" ${finPage<=1?'disabled':''}>« В начало</button>
        <button class="btn sm ghost" id="finPgPrev" ${finPage<=1?'disabled':''}>‹ Назад</button>
        <span class="simple-pager-label">Стр. ${finPage} / ${totalPages} · ${rows.length} проводок</span>
        <button class="btn sm ghost" id="finPgNext" ${finPage>=totalPages?'disabled':''}>Вперёд ›</button>
        <button class="btn sm ghost" id="finPgLast" ${finPage>=totalPages?'disabled':''}>В конец »</button>`:''}
      </div>
    </div>`;
  $('main').querySelectorAll('[data-fintab]').forEach(b=>b.onclick=()=>{finTab=b.dataset.fintab;renderFinance();});
  if($('finRefresh'))$('finRefresh').onclick=refreshFinanceData;
  if($('finNew'))$('finNew').onclick=()=>{finAddingNew=true;renderFinance();};
  if($('finSetBalance'))$('finSetBalance').onclick=()=>financeSetBalanceModal();
  if($('finExport'))$('finExport').onclick=()=>exportFinanceToExcel(rows);
  if(can('finance','edit'))$('main').querySelectorAll('[data-finrow]').forEach(tr=>tr.ondblclick=e=>{
    if(e.target.closest('button,input,select,a'))return;
    financeEntryModal(tr.dataset.finrow);
  });
  // перетаскивание заголовков — меняет порядок столбцов; ручка справа — тянет ширину.
  // Оба сохраняются в браузере. Обычный клик по заголовку (без перетаскивания) — сортирует.
  let _finDragKey=null,_finDidDrag=false;
  $('main').querySelectorAll('.fin-th').forEach(th=>{
    th.ondragstart=e=>{
      // если тянут именно за ручку изменения ширины — это не перетаскивание столбца
      if(e.target.classList.contains('fin-col-resize')){e.preventDefault();return;}
      _finDragKey=th.dataset.finkey;_finDidDrag=false;e.dataTransfer.effectAllowed='move';th.classList.add('fin-dragging');
    };
    th.ondragend=()=>{th.classList.remove('fin-dragging');$('main').querySelectorAll('.fin-th').forEach(x=>x.classList.remove('fin-dragover'));};
    th.ondragover=e=>{e.preventDefault();if(th.dataset.finkey!==_finDragKey)th.classList.add('fin-dragover');};
    th.ondragleave=()=>th.classList.remove('fin-dragover');
    th.ondrop=e=>{
      e.preventDefault();th.classList.remove('fin-dragover');
      const toKey=th.dataset.finkey;
      if(!_finDragKey||_finDragKey===toKey)return;
      _finDidDrag=true;
      const from=finColOrder.indexOf(_finDragKey),to=finColOrder.indexOf(toKey);
      if(from<0||to<0)return;
      finColOrder.splice(from,1);finColOrder.splice(to,0,_finDragKey);
      try{localStorage.setItem('finColOrder',JSON.stringify(finColOrder));}catch(e2){}
      renderFinance();
    };
    th.onclick=()=>{
      if(_finDidDrag){_finDidDrag=false;return;}
      const col=th.dataset.finsort;if(!col)return;
      if(finSort.col===col)finSort.dir=-finSort.dir; // тот же столбец — переключаем направление
      else finSort={col,dir:1}; // новый столбец — начинаем с возрастания
      renderFinance();
    };
    // ручка изменения ширины — тянем мышкой вправо/влево
    const handle=th.querySelector('.fin-col-resize');
    if(handle)handle.onmousedown=ev=>{
      ev.preventDefault();ev.stopPropagation();
      const key=handle.dataset.finresize;
      const startX=ev.clientX;const startW=finColWidth(key);
      handle.classList.add('fin-resizing');
      const onMove=mv=>{
        const w=Math.max(70,startW+(mv.clientX-startX));
        finColWidths[key]=w;
        const table=$('finTable');
        if(table){
          const idx=finColOrder.indexOf(key);
          const col=table.querySelector('colgroup').children[idx];
          if(col)col.style.width=w+'px';
        }
      };
      const onUp=()=>{
        handle.classList.remove('fin-resizing');
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
        try{localStorage.setItem('finColWidths',JSON.stringify(finColWidths));}catch(e3){}
      };
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    };
  });
  if(finAddingNew){
    // привязываем поиск-с-подсказками к строке ввода прямо в гриде — тот же механизм, что и в форме
    bindSearchDropdown('fen_kassa',(S.finance_kassa||[]).map(k=>({id:k.id,name:k.name})));
    bindSearchDropdown('fen_partner',(S.finance_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>({id:p.id,name:p.name})));
    const combinedCats=[
      ...(S.finance_categories||[]).map(c=>({id:c.id,name:c.name,type:'expense'})),
      ...(S.finance_income_categories||[]).map(c=>({id:c.id,name:c.name,type:'income'})),
    ];
    bindSearchDropdown('fen_cat',combinedCats,item=>{
      const catEl=$('fen_cat');
      catEl.dataset.seltype=item?item.type:'';
      if($('fen_type_hint'))$('fen_type_hint').textContent=item?(item.type==='income'?'приход':'расход'):'по категории';
    });
    $('fen_cat').addEventListener('input',()=>{$('fen_cat').dataset.seltype='';if($('fen_type_hint'))$('fen_type_hint').textContent='по категории';});
    if($('fenCancel'))$('fenCancel').onclick=()=>{finAddingNew=false;renderFinance();};
    // сохранение вынесено в отдельную функцию — вызывается и кнопкой, и клавишей Enter из любого
    // поля строки. Проверка обязательных полей та же самая в обоих случаях — по Enter «мимо»
    // проверки не проскочить, если что-то не заполнено, просто ничего не произойдёт (с тостом-подсказкой)
    let _finSaving=false; // защита от повторного запуска, пока идёт сохранение (двойной Enter/клик)
    const saveInlineEntry=async()=>{
      if(_finSaving)return; // уже сохраняем — игнорируем повторный вызов
      const date=val('fen_date');if(!date){toast('Укажите дату');return;}
      const kassaId=($('fen_kassa')||{}).dataset&&$('fen_kassa').dataset.selid;
      if(!kassaId){toast('Выберите кассу из списка');return;}
      const amount=parseFloat(val('fen_amount'));if(!amount||amount<=0){toast('Укажите сумму больше нуля');return;}
      const partnerId=(($('fen_partner')||{}).dataset&&$('fen_partner').dataset.selid)||null;
      const catEl=$('fen_cat');
      const categoryId=catEl.dataset.selid||'';
      const type=catEl.dataset.seltype||'';
      if(!categoryId||!type){toast('Выберите категорию из списка — по ней определится приход это или расход');return;}
      const row={
        entry_date:date,kassa_id:kassaId,partner_id:partnerId,type,amount,
        category_id:categoryId,comment:val('fen_comment').trim()||null,
        manager_id:(S.me&&S.me.id)||null,manager_name:(S.me&&(S.me.full_name||S.me.email))||'',
      };
      _finSaving=true;
      const btn=$('fenSave');if(btn){btn.disabled=true;btn.textContent='Сохраняем…';}
      try{
        const u=await dbInsert('finance_entries',row);
        if(!u)return;
        if(!S.finance_entries)S.finance_entries=[];S.finance_entries.push(u);
        await recalcKassaBalances(kassaId);
        if(partnerId)await recalcPartnerBalances(partnerId);
        finAddingNew=false;
        toast('Сохранено');renderFinance();
      }finally{
        _finSaving=false;
        if(btn){btn.disabled=false;btn.textContent='Сохранить';}
      }
    };
    if($('fenSave'))$('fenSave').onclick=saveInlineEntry;
    // Enter в любом поле строки — тоже сохраняет (если поисковые поля Кассы/Партнёра/Категории в
    // этот момент сами не «съели» Enter для выбора подсказки — тогда сначала выбирается подсказка,
    // а уже следующий Enter сохранит проводку)
    ['fen_date','fen_kassa','fen_partner','fen_cat','fen_amount','fen_comment'].forEach(id=>{
      const el=$(id);if(!el)return;
      el.addEventListener('keydown',ev=>{
        if(ev.key==='Enter'&&!ev.defaultPrevented){ev.preventDefault();saveInlineEntry();}
      });
    });
  }
  $('main').querySelectorAll('[data-findel]').forEach(b=>b.onclick=()=>delFinanceEntry(b.dataset.findel));
  if($('finPgFirst'))$('finPgFirst').onclick=()=>{finPage=1;renderFinance();};
  if($('finPgPrev'))$('finPgPrev').onclick=()=>{finPage=Math.max(1,finPage-1);renderFinance();};
  if($('finPgNext'))$('finPgNext').onclick=()=>{finPage=Math.min(totalPages,finPage+1);renderFinance();};
  if($('finPgLast'))$('finPgLast').onclick=()=>{finPage=totalPages;renderFinance();};
  const redraw=()=>{finPage=1;renderFinance();};
  if($('finfDateFrom'))$('finfDateFrom').onchange=e=>{finFilter.dateFrom=e.target.value;redraw();};
  if($('finfDateTo'))$('finfDateTo').onchange=e=>{finFilter.dateTo=e.target.value;redraw();};
  if($('finfType'))$('finfType').onchange=e=>{finFilter.type=e.target.value;redraw();};
  // общий хелпер для полей-фильтров с поиском: выбор из списка ставит id, очистка поля — снимает фильтр
  const bindFilterSearch=(inputId,items,filterKey)=>{
    bindSearchDropdown(inputId,items,item=>{finFilter[filterKey]=item?item.id:'';redraw();});
    const el=$(inputId);
    if(el)el.addEventListener('blur',()=>{if(!el.value.trim()&&finFilter[filterKey]){finFilter[filterKey]='';redraw();}});
  };
  bindFilterSearch('finfKassa',(S.finance_kassa||[]).map(k=>({id:k.id,name:k.name})),'kassa');
  bindFilterSearch('finfPartner',(S.finance_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>({id:p.id,name:p.name})),'partner');
  bindFilterSearch('finfCategory',[...(S.finance_categories||[]),...(S.finance_income_categories||[])].map(c=>({id:c.id,name:c.name})),'category');
  if($('finfToday'))$('finfToday').onclick=()=>{finFilter.dateFrom=localToday();finFilter.dateTo=localToday();redraw();};
  if($('finfClear'))$('finfClear').onclick=()=>{finFilter={dateFrom:'',dateTo:'',kassa:'',partner:'',type:'',category:''};finSort={col:null,dir:1};redraw();};
}
function financeSetBalanceModal(){
  const body=`
    <div class="form-grid">
      <div class="field"><label>Что задаём <span style="color:var(--rust)">*</span></label><select id="fsb_target">
        <option value="kassa">Остаток кассы</option>
        <option value="partner">Остаток партнёра</option>
      </select></div>
      <div class="field"><label>Дата <span style="color:var(--rust)">*</span></label><input type="date" id="fsb_date" value="${localToday()}"></div>
      <div class="field"><label>Касса <span style="color:var(--rust)">*</span></label><input id="fsb_kassa" autocomplete="off" placeholder="Начните печатать…"><small style="color:var(--muted);font-size:12px">Проводка всё равно создаётся через кассу — например, через техническую «Ввод»</small></div>
      <div class="field" id="fsb_partner_field"><label>Партнёр <span style="color:var(--rust)">*</span></label><input id="fsb_partner" autocomplete="off" placeholder="Начните печатать…"></div>
      <div class="field"><label>Целевой остаток (₸) <span style="color:var(--rust)">*</span></label><input type="number" step="0.01" id="fsb_amount" placeholder="например -15000"><small style="color:var(--muted);font-size:12px">Можно отрицательное число. Сумма прихода/расхода посчитается сама — как разница между текущим остатком и этим числом.</small></div>
      <div class="field"><label>Категория <span style="color:var(--rust)">*</span></label><input id="fsb_cat" autocomplete="off" placeholder="Начните печатать…"><small style="color:var(--muted);font-size:12px">Например «Корректировка остатка» — если такой категории ещё нет, сначала добавьте через «⚙ Категории».</small></div>
      <div class="field full"><label>Комментарий</label><textarea id="fsb_comment" rows="2" placeholder="например: сверка на 04.09"></textarea></div>
    </div>
    <div class="hint" id="fsb_preview" style="margin-top:6px">Выберите кассу/партнёра — тут покажется, какая проводка получится.</div>`;
  showModal('Задать остаток',body,async()=>{
    const target=val('fsb_target');
    const date=val('fsb_date');if(!date){toast('Укажите дату');return false;}
    const kassaId=($('fsb_kassa')||{}).dataset&&$('fsb_kassa').dataset.selid;
    if(!kassaId){toast('Выберите кассу из списка');return false;}
    const partnerId=($('fsb_partner')||{}).dataset&&$('fsb_partner').dataset.selid;
    if(target==='partner'&&!partnerId){toast('Выберите партнёра из списка');return false;}
    const targetVal=val('fsb_amount').trim();
    if(targetVal===''||isNaN(parseFloat(targetVal))){toast('Укажите целевой остаток');return false;}
    const targetBalance=parseFloat(targetVal);
    const current=target==='kassa'?currentKassaBalance(kassaId):currentPartnerBalance(partnerId);
    const diff=targetBalance-current;
    if(Math.abs(diff)<0.005){toast('Остаток уже такой — менять нечего');return false;}
    const type=diff>0?'income':'expense';
    const amount=Math.abs(diff);
    const catEl=$('fsb_cat');
    const categoryId=catEl.dataset.selid||'';
    const catType=catEl.dataset.seltype||'';
    if(!categoryId){toast('Выберите категорию из списка');return false;}
    // категория для корректировки может быть из любого справочника (расход/приход) — тип самой
    // проводки уже определён разницей остатков, а не категорией (в отличие от обычной проводки)
    const row={
      entry_date:date,kassa_id:kassaId,partner_id:target==='partner'?partnerId:(partnerId||null),
      type,amount,category_id:categoryId,
      comment:val('fsb_comment').trim()||`Корректировка остатка ${target==='kassa'?'кассы':'партнёра'} до ${targetBalance.toLocaleString('ru-RU')} ₸`,
      manager_id:(S.me&&S.me.id)||null,manager_name:(S.me&&(S.me.full_name||S.me.email))||'',
    };
    const u=await dbInsert('finance_entries',row);if(!u)return false;
    if(!S.finance_entries)S.finance_entries=[];S.finance_entries.push(u);
    await recalcKassaBalances(kassaId);
    if(row.partner_id)await recalcPartnerBalances(row.partner_id);
    toast('Остаток обновлён');renderFinance();return true;
  });
  setTimeout(()=>{
    const targetEl=$('fsb_target');
    const partnerField=$('fsb_partner_field');
    const updatePartnerVisibility=()=>{if(partnerField)partnerField.style.display=targetEl.value==='partner'?'':'none';};
    updatePartnerVisibility();
    const updatePreview=()=>{
      const prev=$('fsb_preview');if(!prev)return;
      const target=targetEl.value;
      const kassaId=($('fsb_kassa')||{}).dataset&&$('fsb_kassa').dataset.selid;
      const partnerId=($('fsb_partner')||{}).dataset&&$('fsb_partner').dataset.selid;
      const targetVal=val('fsb_amount').trim();
      if((target==='kassa'&&!kassaId)||(target==='partner'&&!partnerId)||targetVal===''||isNaN(parseFloat(targetVal))){
        prev.textContent='Выберите кассу/партнёра и укажите остаток — тут покажется, какая проводка получится.';return;
      }
      const current=target==='kassa'?currentKassaBalance(kassaId):currentPartnerBalance(partnerId);
      const diff=parseFloat(targetVal)-current;
      if(Math.abs(diff)<0.005){prev.textContent=`Текущий остаток уже ${current.toLocaleString('ru-RU')} ₸ — менять нечего.`;return;}
      prev.textContent=`Текущий остаток: ${current.toLocaleString('ru-RU')} ₸ → создастся ${diff>0?'приход':'расход'} на ${Math.abs(diff).toLocaleString('ru-RU')} ₸, чтобы получилось ${parseFloat(targetVal).toLocaleString('ru-RU')} ₸.`;
    };
    targetEl.onchange=()=>{updatePartnerVisibility();updatePreview();};
    if($('fsb_amount'))$('fsb_amount').addEventListener('input',updatePreview);
    bindSearchDropdown('fsb_kassa',(S.finance_kassa||[]).map(k=>({id:k.id,name:k.name})),updatePreview);
    bindSearchDropdown('fsb_partner',(S.finance_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>({id:p.id,name:p.name})),updatePreview);
    const combinedCats=[
      ...(S.finance_categories||[]).map(c=>({id:c.id,name:c.name,type:'expense'})),
      ...(S.finance_income_categories||[]).map(c=>({id:c.id,name:c.name,type:'income'})),
    ];
    bindSearchDropdown('fsb_cat',combinedCats,item=>{$('fsb_cat').dataset.seltype=item?item.type:'';});
  },0);
}
function financeEntryModal(id){
  const e=id?(S.finance_entries||[]).find(x=>x.id===id):null;
  if(id&&!e)return;
  const body=`
    <div class="form-grid">
      <div class="field"><label>Дата <span style="color:var(--rust)">*</span></label><input type="date" id="fe_date" value="${esc(e?(e.entry_date||'').slice(0,10):localToday())}"></div>
      <div class="field"><label>Касса <span style="color:var(--rust)">*</span></label><input id="fe_kassa" autocomplete="off" placeholder="Начните печатать…" value="${e&&e.kassa_id?esc(financeKassaName(e.kassa_id)):''}" data-selid="${e&&e.kassa_id?esc(e.kassa_id):''}"></div>
      <div class="field"><label>Партнёр</label><input id="fe_partner" autocomplete="off" placeholder="— без партнёра — (необязательно)" value="${e&&e.partner_id?esc(financePartnerName(e.partner_id)):''}" data-selid="${e&&e.partner_id?esc(e.partner_id):''}"></div>
      <div class="field"><label>Категория <span style="color:var(--rust)">*</span> <span id="fe_cat_hint" style="color:var(--muted);font-weight:400"></span></label><input id="fe_cat" autocomplete="off" placeholder="Начните печатать…" value="${e&&e.category_id?esc(financeCategoryName(e.category_id)):''}" data-selid="${e&&e.category_id?esc(e.category_id):''}" data-seltype="${e?esc(e.type):''}"><small style="color:var(--muted);font-size:12px">Тип (приход/расход) определится сам — по выбранной категории. Если нужной категории ещё нет — сначала добавьте её через «⚙ Категории расходов»/«⚙ Категории приходов».</small></div>
      <div class="field"><label>Сумма (₸) <span style="color:var(--rust)">*</span></label><input type="number" min="0" step="0.01" id="fe_amount" value="${e&&e.amount!=null?esc(e.amount):''}" placeholder="0"></div>
      <div class="field full"><label>Комментарий</label><textarea id="fe_comment" rows="2">${esc(e?e.comment||'':'')}</textarea></div>
    </div>
    ${e?`<div class="hint" style="margin-top:6px">Менеджер: ${esc(e.manager_name||(e.manager_id?userNameById(e.manager_id):''))||'—'} · Остаток кассы на момент проводки: ${isKassaTechnical(e.kassa_id)?'не показывается (техническая касса)':(e.kassa_balance!=null?Math.round(e.kassa_balance).toLocaleString('ru-RU')+' ₸':'—')}${e.partner_id?` · Остаток партнёра: ${isFinPartnerTechnical(e.partner_id)?'не показывается (технический партнёр)':(e.partner_balance!=null?Math.round(e.partner_balance).toLocaleString('ru-RU')+' ₸':'—')}`:''}</div>`:''}`;
  showModal(id?'Изменить проводку':'Новая проводка',body,async()=>{
    const date=val('fe_date');if(!date){toast('Укажите дату');return false;}
    const kassaId=($('fe_kassa')||{}).dataset&&$('fe_kassa').dataset.selid;
    if(!kassaId){toast('Выберите кассу из списка (начните печатать и выберите вариант)');return false;}
    const amount=parseFloat(val('fe_amount'));if(!amount||amount<=0){toast('Укажите сумму больше нуля');return false;}
    const partnerId=(($('fe_partner')||{}).dataset&&$('fe_partner').dataset.selid)||null;
    // категория обязательна — и по ней же определяется Тип (приход/расход): смотря, из какого
    // справочника выбрана категория, из того и тип. Отдельного поля «Тип» в форме больше нет.
    const catEl=$('fe_cat');
    const categoryId=catEl.dataset.selid||'';
    const type=catEl.dataset.seltype||'';
    if(!categoryId||!type){toast('Выберите категорию из списка — по ней определится приход это или расход');return false;}
    const row={
      entry_date:date,kassa_id:kassaId,partner_id:partnerId,type,amount,
      category_id:categoryId,comment:val('fe_comment').trim()||null,
    };
    // старые значения кассы/партнёра — если их поменяли, нужно пересчитать остатки и там, и там
    const prevKassaId=e?e.kassa_id:null,prevPartnerId=e?e.partner_id:null;
    if(id){
      const u=await dbUpdate('finance_entries',id,row);if(!u)return false;
      Object.assign(e,u);
    }else{
      row.manager_id=(S.me&&S.me.id)||null;
      row.manager_name=(S.me&&(S.me.full_name||S.me.email))||'';
      const u=await dbInsert('finance_entries',row);if(!u)return false;
      if(!S.finance_entries)S.finance_entries=[];S.finance_entries.push(u);
    }
    // пересчитываем цепочки остатков — и для новой кассы/партнёра, и для старой (если поменяли)
    await recalcKassaBalances(kassaId);
    if(prevKassaId&&prevKassaId!==kassaId)await recalcKassaBalances(prevKassaId);
    if(partnerId)await recalcPartnerBalances(partnerId);
    if(prevPartnerId&&prevPartnerId!==partnerId)await recalcPartnerBalances(prevPartnerId);
    toast('Сохранено');renderFinance();return true;
  });
  setTimeout(()=>{
    // объединённый список: категории расхода и прихода вместе, каждая помечена своим типом —
    // по выбору сразу понятно, приход это или расход, без отдельного поля «Тип»
    const combinedCats=[
      ...(S.finance_categories||[]).map(c=>({id:c.id,name:c.name,type:'expense'})),
      ...(S.finance_income_categories||[]).map(c=>({id:c.id,name:c.name,type:'income'})),
    ];
    bindSearchDropdown('fe_cat',combinedCats,item=>{
      const catEl=$('fe_cat');
      catEl.dataset.seltype=item?item.type:'';
      if($('fe_cat_hint'))$('fe_cat_hint').textContent=item?`(${item.type==='income'?'приход':'расход'})`:'';
    });
    // печатают заново — прежний тип тоже больше не действует, пока не выберут категорию снова
    $('fe_cat').addEventListener('input',()=>{$('fe_cat').dataset.seltype='';if($('fe_cat_hint'))$('fe_cat_hint').textContent='';});
    // при открытии формы редактирования — сразу показываем тип уже сохранённой проводки
    if(e&&$('fe_cat_hint'))$('fe_cat_hint').textContent=`(${e.type==='income'?'приход':'расход'})`;
    bindSearchDropdown('fe_kassa',(S.finance_kassa||[]).map(k=>({id:k.id,name:k.name})));
    bindSearchDropdown('fe_partner',(S.finance_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(p=>({id:p.id,name:p.name})));
  },0);
}
async function delFinanceEntry(id){
  const e=(S.finance_entries||[]).find(x=>x.id===id);if(!e)return;
  if(!confirm('Удалить эту проводку? Остатки кассы/партнёра будут пересчитаны.'))return;
  const kassaId=e.kassa_id,partnerId=e.partner_id;
  const ok=await dbDelete('finance_entries',id);
  if(!ok){toast('Не удалось удалить');return;}
  S.finance_entries=(S.finance_entries||[]).filter(x=>x.id!==id);
  await recalcKassaBalances(kassaId);
  if(partnerId)await recalcPartnerBalances(partnerId);
  toast('Удалено');renderFinance();
}
/* Справочник касс */
function dirFinanceKassa(){
  dirGrid({title:'Кассы',arrKey:'finance_kassa',table:'finance_kassa',modalFn:financeKassaModal,emptyText:'Нет касс',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Название',filter:'text',text:k=>k.name||'',cell:k=>`<strong>${esc(k.name)}</strong> <span class="wh-cat">${k.kassa_type==='cashless'?'безналичная':'город'}</span>${k.is_technical?' <span class="wh-cat">⚙ техническая</span>':''}`}]});
}
function financeKassaModal(id){const k=id?S.finance_kassa.find(x=>x.id===id):{name:'',is_technical:false,kassa_type:'city'};
  showModal(id?'Касса':'Новая касса',`<div class="field"><label>Название</label><input id="fk_name" value="${esc(k.name)}"></div>
    <div class="field"><label>Тип кассы</label><select id="fk_type">
      <option value="city" ${(!k.kassa_type||k.kassa_type==='city')?'selected':''}>Касса города</option>
      <option value="cashless" ${k.kassa_type==='cashless'?'selected':''}>Безналичная касса (ИП/ТОО)</option>
    </select></div>
    <label class="pom-paid" style="margin-top:4px"><input type="checkbox" id="fk_tech" ${k.is_technical?'checked':''}> Техническая касса <span class="pom-paidhint">(например «Ввод» — для обнуления/корректировки остатка партнёра; её собственный остаток не имеет смысла и не будет показываться в таблице)</span></label>`,
    async()=>{const name=val('fk_name').trim();if(!name){toast('Укажите название');return false;}
      const row={name,kassa_type:val('fk_type')||'city',is_technical:!!($('fk_tech')&&$('fk_tech').checked)};
      if(id){const u=await dbUpdate('finance_kassa',id,row);if(!u)return false;Object.assign(S.finance_kassa.find(x=>x.id===id),u);}
      else{const u=await dbInsert('finance_kassa',row);if(!u)return false;S.finance_kassa.push(u);}
      toast('Сохранено');dirFinanceKassa();return true;});}
/* Справочник категорий */
function dirFinanceCategories(){
  dirGrid({title:'Категории расходов',arrKey:'finance_categories',table:'finance_categories',modalFn:financeCategoryModal,emptyText:'Нет категорий',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Название',filter:'text',text:c=>c.name||'',cell:c=>`<strong>${esc(c.name)}</strong>`}]});
}
function financeCategoryModal(id){const c=id?S.finance_categories.find(x=>x.id===id):{name:''};
  showModal(id?'Категория':'Новая категория',`<div class="field"><label>Название</label><input id="fc_name" value="${esc(c.name)}"></div>`,
    async()=>{const name=val('fc_name').trim();if(!name){toast('Укажите название');return false;}
      if(id){const u=await dbUpdate('finance_categories',id,{name});if(!u)return false;Object.assign(S.finance_categories.find(x=>x.id===id),u);}
      else{const u=await dbInsert('finance_categories',{name});if(!u)return false;S.finance_categories.push(u);}
      toast('Сохранено');dirFinanceCategories();return true;});}
/* Справочник партнёров финансов — ОТДЕЛЬНЫЙ от общего справочника «Партнёры» (логистика/забор
   заказов) — здесь партнёры именно для финансового учёта, свой собственный список */
function dirFinancePartners(){
  dirGrid({title:'Партнёры (финансы)',arrKey:'finance_partners',table:'finance_partners',modalFn:financePartnerModal,emptyText:'Нет партнёров',
    sort:(a,b)=>(a.name||'').localeCompare(b.name||''),
    cols:[{key:'name',label:'Название',filter:'text',text:p=>p.name||'',cell:p=>`<strong>${esc(p.name)}</strong>${p.is_technical?' <span class="wh-cat">⚙ технический</span>':''}`}]});
}
function financePartnerModal(id){const p=id?S.finance_partners.find(x=>x.id===id):{name:'',is_technical:false};
  showModal(id?'Партнёр':'Новый партнёр',`<div class="field"><label>Название</label><input id="fp_name" value="${esc(p.name)}"></div>
    <label class="pom-paid" style="margin-top:4px"><input type="checkbox" id="fp_tech" ${p.is_technical?'checked':''}> Технический партнёр <span class="pom-paidhint">(например «Без партнёра» — заглушка, а не реальный партнёр; его остаток не имеет смысла и не будет показываться в таблице)</span></label>`,
    async()=>{const name=val('fp_name').trim();if(!name){toast('Укажите название');return false;}
      const row={name,is_technical:!!($('fp_tech')&&$('fp_tech').checked)};
      if(id){const u=await dbUpdate('finance_partners',id,row);if(!u)return false;Object.assign(S.finance_partners.find(x=>x.id===id),u);}
      else{const u=await dbInsert('finance_partners',row);if(!u)return false;S.finance_partners.push(u);}
      toast('Сохранено');dirFinancePartners();return true;});}
/* ==================== /ФИНАНСЫ ==================== */
function renderCash(){ // ключ модуля остался 'cash', но это Склад
  if(!isStaff()){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  if(typeof removeWhProductsPager==='function')removeWhProductsPager();
  // на почтовой сборке город — только Алматы/Астана (в Шымкенте почтовой сборки нет)
  const cityList=whSub==='assembly_mail'?WAREHOUSE_CITIES.filter(c=>c!=='Шымкент'):WAREHOUSE_CITIES;
  if(whSub==='assembly_mail'&&!cityList.includes(whCity))whCity=cityList[0];
  const activeTab=whTabKeyFor(whSub);
  const canCreate=isAdmin()||can('cash','create');
  $('main').innerHTML=`
    <div class="page-head"><div><h1>📦 Склад</h1><p>Товары, остатками и складскими процессами</p></div></div>
    <div class="wh2-headrow">
      <div class="wh2-hfields">
        <div class="wh2-hfield"><span>Город</span><select id="whCitySel">${cityList.map(c=>`<option value="${esc(c)}" ${whCity===c?'selected':''}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="wh2-hactions">
        <button class="btn ghost" id="whScanBtn">▥ Сканировать</button>
        ${canCreate?`<button class="btn primary" id="whAddProduct2">＋ Добавить товар</button>
        <div class="wh2-impexp">
          <button class="btn ghost" id="whImpExpBtn">⬆ Импорт / экспорт ▾</button>
          <div class="wh2-impexp-menu" id="whImpExpMenu" style="display:none">
            <button id="whImpExpImport">⬆ Импорт списка товаров</button>
            <button id="whImpExpImportKet">⬆ Импорт тех.названий KET</button>
            <button id="whImpExpExport">⬇ Экспорт текущего списка (CSV)</button>
          </div>
        </div>`:''}
      </div>
    </div>
    <div class="wh2-tabs">
      ${WH_TABS.map(([k,ic,label,done])=>`<button data-whtab="${k}" class="${activeTab===k?'active':''} ${done?'':'soon'}">${ic} ${esc(label)}</button>`).join('')}
    </div>
    <div id="whContent"></div>`;
  $('main').querySelectorAll('[data-whtab]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.whtab;
    if(k==='products')whSub='products';
    else if(k==='moves')whSub='moves';
    else if(k==='returns')whSub='intake';
    else if(k==='assembly')whSub=(whSub==='assembly_courier'||whSub==='assembly_mail')?whSub:'assembly_courier';
    else whSub=k; // overview / receiving / transfers / stocktake / cells / issues
    renderCash();
  });
  const citySel=$('whCitySel');if(citySel)citySel.onchange=e=>{whCity=e.target.value;renderCash();};
  if($('whScanBtn'))$('whScanBtn').onclick=()=>{
    const code=prompt('Отсканируйте или введите штрих-код товара:');
    if(!code)return;
    whSub='products';whSearch=code.trim();whProdPage=1;renderCash();
  };
  if($('whAddProduct2'))$('whAddProduct2').onclick=()=>productModal();
  const impBtn=$('whImpExpBtn'),impMenu=$('whImpExpMenu');
  if(impBtn)impBtn.onclick=e=>{e.stopPropagation();impMenu.style.display=impMenu.style.display==='none'?'block':'none';};
  if(impMenu){
    document.addEventListener('click',function closeImpExp(ev){if(!impMenu.contains(ev.target)&&ev.target!==impBtn){impMenu.style.display='none';}},{once:true});
    if($('whImpExpImport'))$('whImpExpImport').onclick=()=>{impMenu.style.display='none';productImportModal();};
    if($('whImpExpImportKet'))$('whImpExpImportKet').onclick=()=>{impMenu.style.display='none';productImportKetModal();};
    if($('whImpExpExport'))$('whImpExpExport').onclick=()=>{impMenu.style.display='none';exportProductsCsv();};
  }
  if(whSub==='products')renderWhProducts();
  else if(whSub==='moves')renderWhMoves();
  else if(whSub==='assembly_courier')renderWhAssembly('courier');
  else if(whSub==='assembly_mail')renderWhAssembly('mail');
  else if(whSub==='intake')renderWhIntake();
  else if(whSub==='overview')renderWhOverview();
  else renderWhSoon(whSub);
}
// честная заглушка для разделов, которые ещё не реализованы (Этап 2/3) — не выдумываем данные
function renderWhSoon(key){
  const t=WH_TABS.find(x=>x[0]===key);
  $('whContent').innerHTML=`<div class="panel"><div class="wh2-soon">
    <div class="big">${t?t[1]+' '+t[2]:'Раздел'} — в разработке</div>
    Этот раздел ещё не реализован. Планируется в следующих этапах доработки склада.
  </div></div>`;
}
// экспорт текущего (отфильтрованного) списка товаров в CSV
function exportProductsCsv(){
  const rows=[['Название','Партнёр','Штрихкод','Артикул','Факт','Резерв','Доступно']];
  (S.products||[]).forEach(p=>{
    rows.push([p.name||'',whPartnerName(p.partner_id),p.barcode||'',p.sku||'',productStock(p),productReserved(p.id),productAvailable(p)]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`Товары_склад_${whCity}.csv`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
// вкладка «Обзор»: карточки статистики по всем товарам текущего города + честная сводка (без выдуманных данных)
function renderWhOverview(){
  const all=S.products||[];
  const cityStock=all.reduce((s,p)=>s+productStock(p),0);
  const availSum=all.reduce((s,p)=>s+Math.max(0,productAvailable(p)),0);
  const reservedSum=all.reduce((s,p)=>s+productReserved(p.id),0);
  const errCount=all.filter(p=>productAvailable(p)<0).length;
  const zeroCount=all.filter(p=>productStock(p)<=0).length;
  const activeReservations=(S.wh_reservations||[]).filter(r=>r.city===whCity&&r.status==='active').length;
  const hasIssues=errCount>0;
  $('whContent').innerHTML=`
    <div class="wh2-stats">
      <div class="wh2-stat wh2-stat--blue"><div class="wh2-stat-ic">📦</div><div class="wh2-stat-txt"><span>Товарных позиций</span><b>${all.length}</b></div></div>
      <div class="wh2-stat wh2-stat--green"><div class="wh2-stat-ic">🧮</div><div class="wh2-stat-txt"><span>Единиц в «${esc(whCity)}»</span><b>${cityStock}</b></div></div>
      <div class="wh2-stat wh2-stat--blue"><div class="wh2-stat-ic">✅</div><div class="wh2-stat-txt"><span>Доступно к продаже</span><b>${availSum}</b></div></div>
      <div class="wh2-stat wh2-stat--gold"><div class="wh2-stat-ic">⏳</div><div class="wh2-stat-txt"><span>Зарезервировано</span><b>${reservedSum}</b></div></div>
      <div class="wh2-stat wh2-stat--red"><div class="wh2-stat-ic">⚠️</div><div class="wh2-stat-txt"><span>Проблемных (резерв &gt; факта)</span><b>${errCount}</b></div></div>
    </div>
    <div class="wh2-overview-grid">
      <div class="wh2-tasks">
        <h3>📋 Что стоит проверить</h3>
        <ul>
          <li>📦 Товаров с нулевым остатком <b>${zeroCount}</b></li>
          <li>⏳ Активных резервов в «${esc(whCity)}» <b>${activeReservations}</b></li>
          <li>⚠️ Товаров с ошибкой остатка <b>${errCount}</b></li>
        </ul>
        <div class="hint" style="margin-top:10px">Приёмка, перемещения и инвентаризация появятся здесь, когда эти разделы будут реализованы — сейчас в «Задачах» показаны только реальные цифры по товарам, остаткам и резервам.</div>
      </div>
      <div class="wh2-banner ${hasIssues?'warn':'ok'}">
        <div class="wh2-banner-ic">${hasIssues?'⚠️':'✅'}</div>
        <div>
          <b>${hasIssues?'Есть расхождения на складе':'Склад работает в штатном режиме'}</b>
          <span>${hasIssues?errCount+' товар(ов) с резервом больше фактического остатка — загляните в «Товары» с фильтром':'Ошибок в остатках и резервах не обнаружено'}</span>
        </div>
      </div>
    </div>`;
}

// остаток товара в текущем городе
function productStock(p){
  const st=(p.stock&&typeof p.stock==='object')?p.stock:{};
  return parseInt(st[whCity]||0,10)||0;
}
// сумма активных резервов товара в указанном городе (по умолчанию — текущий выбранный город)
function productReserved(productId,city){
  city=city||whCity;
  return (S.wh_reservations||[]).filter(r=>r.product_id===productId&&r.city===city&&r.status==='active')
    .reduce((s,r)=>s+(parseInt(r.quantity,10)||0),0);
}
// доступно = факт − активный резерв (может уйти в минус, если резерв больше факта — это статус «Ошибка»)
function productAvailable(p,city){
  return productStock(p)-productReserved(p.id,city||whCity);
}
// ячейка хранения товара в текущем городе (jsonb по городам, как и stock)
function productCell(p,city){
  const c=(p.storage_cell&&typeof p.storage_cell==='object')?p.storage_cell:{};
  return c[city||whCity]||'';
}
const WH_LOW_STOCK_THRESHOLD=5; // порог «низкого остатка» — доступно в диапазоне (0; порог]
function productStatusBadge(p,city){
  const avail=productAvailable(p,city);
  if(avail<0)return{label:'Ошибка',cls:'wh2-badge--err'};
  if(avail===0)return{label:'Нет остатка',cls:'wh2-badge--out'};
  if(avail<=WH_LOW_STOCK_THRESHOLD)return{label:'Низкий остаток',cls:'wh2-badge--low'};
  return{label:'В наличии',cls:'wh2-badge--ok'};
}
// имя складского партнёра
function whPartnerName(id){return ((S.warehouse_partners||[]).find(x=>x.id===id)||{}).name||'—';}

let whQuickFilter='all'; // all | stock | nostock | reserved
let _whProdSearchTimer=null;
// отдельный лёгкий счётчик «требуют привязки» — раньше показывался в самих «Заказах партнёров»,
// теперь живёт здесь, на складе (где эта привязка и происходит). Не завязан на дату/окно.
let _whUnmatchedCount=null;
async function loadWhUnmatchedCount(){
  try{
    const {count}=await sb.from('inbound_orders').select('id',{count:'exact',head:true}).eq('match_status','unmatched');
    _whUnmatchedCount=count||0;
  }catch(e){console.error('loadWhUnmatchedCount',e);}
}
function renderWhProducts(){
  const all=(S.products||[]).filter(p=>{
    if(whPartner&&p.partner_id!==whPartner)return false;
    const avail=productAvailable(p);
    const reserved=productReserved(p.id);
    if(whQuickFilter==='stock'&&productStock(p)<=0)return false;
    if(whQuickFilter==='nostock'&&productStock(p)>0)return false;
    if(whQuickFilter==='reserved'&&reserved<=0)return false;
    if(!whSearch)return true;
    const q=whSearch.toLowerCase();
    return (p.name||'').toLowerCase().includes(q)||(p.barcode||'').includes(q)||(p.sku||'').toLowerCase().includes(q)
      ||(p.ket_sku||'').toLowerCase().includes(q)||whPartnerName(p.partner_id).toLowerCase().includes(q);
  });
  const allProds=S.products||[];
  const cityStock=all.reduce((s,p)=>s+productStock(p),0);
  const availSum=all.reduce((s,p)=>s+Math.max(0,productAvailable(p)),0);
  const reservedSum=all.reduce((s,p)=>s+productReserved(p.id),0);
  const partnersWithProducts=[...new Set(allProds.map(p=>p.partner_id).filter(Boolean))];
  const totalPages=Math.max(1,Math.ceil(all.length/whProdPerPage));
  if(whProdPage>totalPages)whProdPage=totalPages;
  const startIdx=(whProdPage-1)*whProdPerPage;
  const pageRows=all.slice(startIdx,startIdx+whProdPerPage);
  const QUICK=[['all','Все'],['stock','С остатком'],['nostock','Без остатка'],['reserved','В резерве']];
  $('whContent').innerHTML=`
    <div class="wh-toolbar">
      <input id="whProdSearch" placeholder="🔍 Название, штрих-код, артикул, KET, партнёр…" value="${esc(whSearch)}">
      <select id="whPartnerFilter"><option value="">Все партнёры</option>${partnersWithProducts.map(pid=>`<option value="${pid}" ${whPartner===pid?'selected':''}>${esc(whPartnerName(pid))}</option>`).join('')}</select>
    </div>
    <div class="wh2-qf">
      ${QUICK.map(([k,l])=>`<button data-whqf="${k}" class="${whQuickFilter===k?'active':''}">${esc(l)} (${
        k==='all'?allProds.length:k==='stock'?allProds.filter(p=>productStock(p)>0).length:k==='nostock'?allProds.filter(p=>productStock(p)<=0).length:
        allProds.filter(p=>productReserved(p.id)>0).length
      })</button>`).join('')}
      ${canMod('ket_orders')?`<button id="whUnmatchedBtn" class="${_whUnmatchedCount?'':''}" style="${_whUnmatchedCount?'color:var(--rust)':''}" title="Позиции заказов КЕТ, которым ещё не найден товар">🔍 Требуют привязки (КЕТ): ${_whUnmatchedCount!=null?_whUnmatchedCount:'…'}</button>`:''}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Товары</h2><span class="count">${all.length}</span></div>
      <div class="table-scroll"><table class="resp-table" id="whProdTable"><thead><tr>
        <th></th><th>Название</th><th>Партнёр</th><th>Штрих-код</th><th>Артикул</th><th>Факт</th><th>Резерв</th><th>Доступно</th><th>Статус</th><th></th>
      </tr></thead><tbody>
      ${pageRows.length?pageRows.map(p=>{
        const reserved=productReserved(p.id);const avail=productAvailable(p);const badge=productStatusBadge(p);
        return `<tr data-whrow="${p.id}">
        <td data-label="" style="width:44px"><div class="wh2-thumb" data-whthumb="${p.id}">${p.photo?`<img src="${p.photo}" alt="">`:'📦'}</div></td>
        <td data-label="Название"><strong>${esc(p.name||'—')}</strong>${p.category?`<div class="wh-cat">${esc(p.category)}</div>`:''}</td>
        <td data-label="Партнёр">${p.partner_id?esc(whPartnerName(p.partner_id)):'<span class="wh-cat">—</span>'}</td>
        <td data-label="Штрих-код"><span class="wh-barcode">${esc(p.barcode||'—')}</span></td>
        <td data-label="Артикул">${esc(p.sku||'—')}</td>
        <td data-label="Факт"><span class="wh-stock ${productStock(p)>0?'':'wh-zero'}">${productStock(p)}</span></td>
        <td data-label="Резерв">${reserved>0?'<span style="color:var(--gold)">'+reserved+'</span>':'0'}</td>
        <td data-label="Доступно">${avail<0?'<b style="color:#c23b3b">'+avail+'</b>':avail}</td>
        <td data-label="Статус"><span class="wh2-badge ${badge.cls}">${badge.label}</span></td>
        <td data-label="" class="cell-actions"><div class="row-actions">
          <button class="btn sm ghost" data-whedit="${p.id}">Открыть</button>
          <button class="btn sm ghost" data-whlabel="${p.id}">🏷</button>
        </div></td>
      </tr>`;}).join(''):`<tr><td colspan="10"><div class="empty"><div class="big">Нет товаров</div>${whSearch||whPartner||whQuickFilter!=='all'?'Измените фильтры.':'Добавьте первый товар или импортируйте список.'}</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  const s=$('whProdSearch');if(s)s.oninput=e=>{
    const v=e.target.value;
    clearTimeout(_whProdSearchTimer);
    _whProdSearchTimer=setTimeout(()=>{whSearch=v;whProdPage=1;renderWhProducts();const s2=$('whProdSearch');if(s2){s2.focus();s2.setSelectionRange(s2.value.length,s2.value.length);}},350);
  };
  if($('whPartnerFilter'))$('whPartnerFilter').onchange=e=>{whPartner=e.target.value;whProdPage=1;renderWhProducts();};
  $('whContent').querySelectorAll('[data-whqf]').forEach(b=>b.onclick=()=>{whQuickFilter=b.dataset.whqf;whProdPage=1;renderWhProducts();});
  if($('whAddProduct'))$('whAddProduct').onclick=()=>productModal();
  if($('whImport'))$('whImport').onclick=()=>productImportModal();
  if($('whImportKet'))$('whImportKet').onclick=()=>productImportKetModal();
  if($('whUnmatchedBtn'))$('whUnmatchedBtn').onclick=async()=>{
    const btn=$('whUnmatchedBtn');const orig=btn.textContent;btn.disabled=true;btn.textContent='⏳ Проверяем…';
    try{await inboundUnmatchedModal();}
    finally{if(btn){btn.disabled=false;btn.textContent=orig;}}
  };
  if(_whUnmatchedCount==null)loadWhUnmatchedCount().then(()=>{if(S.tab==='cash'&&whSub==='products')renderWhProducts();}).catch(()=>{});
  $('whContent').querySelectorAll('[data-whedit]').forEach(b=>b.onclick=()=>productPanel(b.dataset.whedit));
  $('whContent').querySelectorAll('[data-whlabel]').forEach(b=>b.onclick=()=>productLabelModal(b.dataset.whlabel));
  $('whContent').querySelectorAll('[data-whrow]').forEach(tr=>bindDoubleTap(tr,()=>productPanel(tr.dataset.whrow)));
  renderWhProductsPager(all.length,totalPages,startIdx,pageRows.length);
  // Фото подгружаем только для видимой страницы и дорисовываем на месте — без повторной
  // отрисовки всего списка, иначе сбрасывался бы курсор в поле поиска.
  ensureProductPhotos(pageRows.map(x=>x.id)).then(()=>{
    if(S.tab!=='cash'||whSub!=='products')return;
    pageRows.forEach(x=>{
      if(!x.photo)return;
      const el=document.querySelector(`[data-whthumb="${x.id}"]`);
      if(el&&!el.querySelector('img'))el.innerHTML=`<img src="${x.photo}" alt="">`;
    });
  });
}
// плавающая панель пагинации для списка товаров (тот же вид, что у заказов/заявок/КЕТ)
function removeWhProductsPager(){const ex=$('whProdPager');if(ex)ex.remove();
  const m=$('main');if(m&&!$('ordersPager')&&!$('pickupsPager')&&!$('inboundPager'))m.classList.remove('has-pager');}
function renderWhProductsPager(total,totalPages,startIdx,shownCount){
  removeWhProductsPager();
  if(!total)return;
  // Если всё уместилось на одной странице, панель не нужна: листать нечего, а выбор
  // «сколько на странице» на коротком списке ничего не меняет. Зато панель висит
  // поверх содержимого: она прикреплена к низу экрана, и на списке из пяти строк
  // закрывала их целиком — это и было видно на складе.
  if(totalPages<=1)return;
  const from=startIdx+1, to=startIdx+shownCount;
  const bar=document.createElement('div');
  bar.id='whProdPager';bar.className='orders-pager';
  {const m=$('main');if(m)m.classList.add('has-pager');}
  bar.innerHTML=`
    <button class="op-btn" id="whProdRefreshBtn" title="Подтянуть свежие данные">🔄</button>
    <div class="op-info">Показаны <b>${from}–${to}</b> из <b>${total}</b></div>
    <div class="op-perpage">
      <span>На странице:</span>
      <div class="op-pp-wrap">
        <button class="op-btn op-pp-btn" id="whProdPerPageBtn">${whProdPerPage} ▾</button>
        <div class="op-pp-menu" id="whProdPerPageMenu" style="display:none">
          ${ORDERS_PAGE_SIZES.map(s=>`<button class="op-pp-item ${s===whProdPerPage?'active':''}" data-whprodpp="${s}">${s}</button>`).join('')}
        </div>
      </div>
    </div>
    <div class="op-nav">
      <button class="op-btn" data-whprodpage="first" ${whProdPage<=1?'disabled':''} title="В начало">«</button>
      <button class="op-btn" data-whprodpage="prev" ${whProdPage<=1?'disabled':''}>‹ Назад</button>
      <span class="op-page">Стр. ${whProdPage} / ${totalPages}</span>
      <button class="op-btn" data-whprodpage="next" ${whProdPage>=totalPages?'disabled':''}>Вперёд ›</button>
      <button class="op-btn" data-whprodpage="last" ${whProdPage>=totalPages?'disabled':''} title="В конец">»</button>
    </div>`;
  document.body.appendChild(bar);
  const whProdRefreshBtn=bar.querySelector('#whProdRefreshBtn');
  if(whProdRefreshBtn)whProdRefreshBtn.onclick=async()=>{
    whProdRefreshBtn.disabled=true;whProdRefreshBtn.textContent='…';
    try{await refreshForTab(S.tab);renderWhProducts();toast('Обновлено');}
    finally{if(whProdRefreshBtn){whProdRefreshBtn.disabled=false;whProdRefreshBtn.textContent='🔄';}}
  };
  const ppBtn=bar.querySelector('#whProdPerPageBtn'), ppMenu=bar.querySelector('#whProdPerPageMenu');
  if(ppBtn)ppBtn.onclick=e=>{e.stopPropagation();ppMenu.style.display=ppMenu.style.display==='none'?'flex':'none';};
  bar.querySelectorAll('[data-whprodpp]').forEach(b=>b.onclick=()=>{
    whProdPerPage=parseInt(b.dataset.whprodpp,10)||50;whProdPage=1;renderWhProducts();
    const t=$('whProdTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.addEventListener('click',function closeWhProdPP(ev){
    if(ppMenu&&!ppMenu.contains(ev.target)&&ev.target!==ppBtn){ppMenu.style.display='none';}
  },{once:true});
  bar.querySelectorAll('[data-whprodpage]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.whprodpage;
    if(a==='first')whProdPage=1;
    else if(a==='prev')whProdPage=Math.max(1,whProdPage-1);
    else if(a==='next')whProdPage=Math.min(totalPages,whProdPage+1);
    else if(a==='last')whProdPage=totalPages;
    renderWhProducts();
    const t=$('whProdTable');if(t)t.scrollIntoView({behavior:'smooth',block:'start'});
  });
}

// форма добавления/редактирования товара
// форма СОЗДАНИЯ нового товара (центрированное модальное окно — как раньше)
function productModal(){
  if(!isAdmin()&&!can('cash','create')){toast('Нет прав на добавление товаров');return;}
  let photoDataUrl=null;
  const body=`
    <div class="form-grid">
      <div class="field full"><label>Фото товара</label>
        <div style="display:flex;align-items:center;gap:14px">
          <div id="p_photoPreview" style="width:64px;height:64px;border-radius:12px;background:#eef0f4;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:26px">📦</div>
          <input type="file" id="p_photoFile" accept="image/*">
        </div>
      </div>
      <div class="field full"><label>Название товара <span style="color:var(--rust)">*</span></label><input id="p_name" placeholder="Напр. Кроссовки Nike Air Max 42"></div>
      <div class="field full"><label>Партнёр склада <span style="color:var(--rust)">*</span></label>
        <select id="p_partner"><option value="">— выберите партнёра склада —</option>${(S.warehouse_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(pt=>`<option value="${pt.id}">${esc(pt.name)}</option>`).join('')}</select>
        ${(!S.warehouse_partners||!S.warehouse_partners.length)?'<span class="hint" style="color:var(--rust)">Сначала добавьте партнёров склада в разделе Партнёры → Партнёры склада</span>':''}</div>
      <div class="field"><label>Штрих-код</label><input id="p_barcode" placeholder="Оставьте пустым — сгенерируем"></div>
      <div class="field"><label>Артикул</label><input id="p_sku" placeholder="напр. NK-42"><span class="hint">Внутренний код товара. Раньше его можно было задать только импортом, поэтому колонка «Артикул» в списке почти всегда пустовала.</span></div>
      <div class="field full"><label>Коды KET (ket_sku)</label><input id="p_ketsku" placeholder="напр. brutalin, brutalin2, brutalin-m"><span class="hint">Если у товара несколько тех-названий в KET (разные листинги) — перечислите через запятую.</span></div>
      <div class="field full"><label>Начальные остатки по городам</label>
        <div class="wh-stock-grid">
          ${WAREHOUSE_CITIES.map(c=>`<div class="wh-stock-inp"><span>${esc(c)}</span><input type="number" min="0" step="1" data-pstock="${esc(c)}" value="0" placeholder="0"></div>`).join('')}
        </div>
        <span class="hint">Это стартовый остаток нового товара. Дальнейшие изменения — только через складские операции.</span>
      </div>
    </div>`;
  showModal('Новый товар',body,async()=>{
    const name=val('p_name').trim();
    if(!name){toast('Введите название');return false;}
    const partner_id=val('p_partner')||null;
    if(!partner_id){toast('Выберите партнёра');return false;}
    let barcode=val('p_barcode').trim();
    if(!barcode)barcode=genBarcode();
    const st={};
    document.querySelectorAll('[data-pstock]').forEach(el=>{const c=el.dataset.pstock;const v=el.value.trim();st[c]=v===''?0:parseInt(v,10)||0;});
    const payload={name,partner_id,barcode,sku:val('p_sku').trim()||null,ket_sku:val('p_ketsku').trim()||null,category:null,stock:st,storage_cell:{},photo:photoDataUrl};
    const saved=await dbInsert('products',payload);
    if(!saved){toast('Не удалось сохранить');return false;}
    if(!S.products)S.products=[];S.products.unshift(saved);
    logAction('create','products',{entity_id:saved.id,entity_label:name});
    if(payload.ket_sku){
      const matchedCount=await matchInboundItemsForCodes(saved.id,productKetSkuList(payload));
      // говорим и про ноль: раньше при нуле не показывалось ничего, и человек не понимал,
      // сработала привязка или просто нечего было привязывать
      toast(matchedCount?`Привязано позиций в заказах KET: ${matchedCount}`
                        :'Позиций с такими тех.названиями в заказах KET не нашлось',5000);
      _whUnmatchedCount=null;
      if(S.tab==='ket_orders'&&typeof drawInboundOrders==='function')drawInboundOrders();
    }
    toast('Товар добавлен');renderCash();return true;
  },{wide:true});
  const pf=$('p_photoFile');
  if(pf)pf.onchange=async()=>{
    const f=pf.files&&pf.files[0];if(!f)return;
    try{photoDataUrl=await resizeImageToDataURL(f,300);$('p_photoPreview').innerHTML=`<img src="${photoDataUrl}" style="width:100%;height:100%;object-fit:cover">`;}
    catch(e){toast('Не удалось загрузить изображение');}
  };
}
// боковая выезжающая панель товара (просмотр/редактирование существующего) — вкладки «Информация» / «Движения»
function productPanel(id){
  const p=(S.products||[]).find(x=>x.id===id);
  if(!p){toast('Товар не найден');return;}
  const canEdit=isAdmin()||can('cash','edit');
  let tab='info';
  const ov=document.createElement('div');ov.className='wh2-panel-ov';
  ov.innerHTML=`<div class="wh2-panel">
    <div class="wh2-panel-head"><h3>${esc(p.name||'Товар')}</h3><button class="wh2-panel-x" id="wp_x">×</button></div>
    <div class="wh2-panel-tabs">
      <button data-wptab="info" class="active">Информация</button>
      <button data-wptab="moves">Движения</button>
    </div>
    <div class="wh2-panel-body" id="wp_body"></div>
    <div class="wh2-panel-foot" id="wp_foot"></div>
  </div>`;
  document.body.appendChild(ov);
  ov.onclick=e=>{if(e.target===ov)ov.remove();};
  ov.querySelector('#wp_x').onclick=()=>ov.remove();
  document.addEventListener('keydown',function esc3(e){if(e.key==='Escape'){ov.remove();document.removeEventListener('keydown',esc3);}});

  // Фото грузится отдельно и может прийти уже после открытия карточки. Пока не пришло —
  // photoTouched остаётся false, и поле photo в сохранение НЕ попадает: иначе быстрое
  // «Сохранить» затёрло бы существующее фото пустотой.
  let panelPhotoDataUrl=p.photo||null;
  let photoTouched=(p.photo!==undefined);
  function infoHtml(){
    const stock=(p.stock&&typeof p.stock==='object')?p.stock:{};
    return `
    <div class="form-grid">
      <div class="field full"><label>Фото товара</label>
        <div style="display:flex;align-items:center;gap:14px">
          <div id="p_photoPreview" style="width:72px;height:72px;border-radius:12px;background:#eef0f4;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:28px">${panelPhotoDataUrl?`<img src="${panelPhotoDataUrl}" style="width:100%;height:100%;object-fit:cover">`:'📦'}</div>
          ${canEdit?`<div style="display:flex;flex-direction:column;gap:6px">
            <input type="file" id="p_photoFile" accept="image/*">
            ${panelPhotoDataUrl?'<button type="button" class="btn sm ghost" id="p_photoRemove">Удалить фото</button>':''}
          </div>`:''}
        </div>
      </div>
      <div class="field full"><label>Название товара <span style="color:var(--rust)">*</span></label><input id="p_name" value="${esc(p.name||'')}" ${canEdit?'':'disabled'}></div>
      <div class="field full"><label>Партнёр склада <span style="color:var(--rust)">*</span></label>
        <select id="p_partner" ${canEdit?'':'disabled'}>${(S.warehouse_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(pt=>`<option value="${pt.id}" ${p.partner_id===pt.id?'selected':''}>${esc(pt.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Штрих-код</label><input id="p_barcode" value="${esc(p.barcode||'')}" ${canEdit?'':'disabled'}></div>
      <div class="field"><label>Артикул</label><input id="p_sku" value="${esc(p.sku||'')}" ${canEdit?'':'disabled'}></div>
      <div class="field full"><label>Коды KET (ket_sku)</label><input id="p_ketsku" value="${esc(p.ket_sku||'')}" ${canEdit?'':'disabled'}><span class="hint">Через запятую, если несколько тех-названий.</span></div>
      <div class="field full"><label>Остатки и резерв по городам</label>
        <div class="table-scroll"><table class="resp-table wh-prod-city-tbl"><thead><tr>
          <th>Город</th><th>Факт</th><th>Резерв</th><th>Доступно</th><th></th>
        </tr></thead><tbody>
        ${WAREHOUSE_CITIES.map(c=>{
          const fact=parseInt(stock[c]||0,10)||0;
          const reserved=productReserved(id,c);
          const avail=fact-reserved;
          return `<tr>
            <td>${esc(c)}</td>
            <td><b>${fact}</b></td>
            <td>${reserved>0?'<span style="color:var(--rust)">'+reserved+'</span>':'0'}</td>
            <td>${avail<0?'<b style="color:var(--rust)">'+avail+'</b>':avail}</td>
            <td><div class="row-actions">
              <button type="button" class="btn sm ghost" data-wmquick="${esc(c)}">Скорректировать</button>
              <button type="button" class="btn sm ghost" data-wrquick="${esc(c)}">Резерв</button>
            </div></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>
        <span class="hint">Остаток меняется только через складские операции. Ячейку можно менять здесь напрямую.</span>
      </div>
    </div>`;
  }
  function movesHtml(){
    const rows=(S.wh_moves||[]).filter(m=>m.product_id===id).slice(0,50);
    if(!rows.length)return '<div class="empty">Движений по этому товару ещё нет</div>';
    return `<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Дата</th><th>Тип</th><th>Город</th><th>Δ</th><th>Остаток</th><th>Причина</th><th>Комментарий</th><th>Сотрудник</th>
    </tr></thead><tbody>${rows.map(m=>{
      const t=whMoveType(m.op);const tt=fmtLogTime(m.created_at);
      return `<tr>
        <td>${esc(tt.date||'—')}<br><span class="wh-cat">${esc(tt.time||'')}</span></td>
        <td>${esc(t.label)}</td><td>${esc(m.city||'—')}</td>
        <td class="${t.dir>0?'wh-op-in':t.dir<0?'wh-op-out':''}">${t.dir>0?'+':t.dir<0?'−':''}${Math.abs(m.qty||0)}</td>
        <td>${m.balance_before!=null?m.balance_before+' → ':''}${m.balance_after!=null?m.balance_after:'—'}</td>
        <td>${esc(m.reason||'—')}</td><td>${esc(m.comment||'—')}</td><td>${esc(m.user_name||'—')}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function wireInfoActions(){
    document.querySelectorAll('[data-wmquick]').forEach(b=>b.onclick=()=>{ov.remove();whMoveModal(id,b.dataset.wmquick);});
    document.querySelectorAll('[data-wrquick]').forEach(b=>b.onclick=()=>{ov.remove();whReservationModal(id,b.dataset.wrquick);});
    const pf=$('p_photoFile');
    if(pf)pf.onchange=async()=>{
      const f=pf.files&&pf.files[0];if(!f)return;
      try{panelPhotoDataUrl=await resizeImageToDataURL(f,300);photoTouched=true;paint();}
      catch(e){toast('Не удалось загрузить изображение');}
    };
    const pr=$('p_photoRemove');
    if(pr)pr.onclick=()=>{panelPhotoDataUrl=null;photoTouched=true;paint();};
  }
  function paint(){
    ov.querySelectorAll('[data-wptab]').forEach(b=>b.classList.toggle('active',b.dataset.wptab===tab));
    $('wp_body').innerHTML=tab==='info'?infoHtml():movesHtml();
    $('wp_foot').innerHTML=tab==='info'&&canEdit?`<button class="btn ghost" id="wp_cancel">Закрыть</button><button class="btn primary" id="wp_save">Сохранить</button>`:`<button class="btn ghost" id="wp_cancel">Закрыть</button>`;
    $('wp_cancel').onclick=()=>ov.remove();
    if(tab==='info'){
      wireInfoActions();
      const saveBtn=$('wp_save');
      if(saveBtn)saveBtn.onclick=async()=>{
        saveBtn.disabled=true;
        try{
          const name=val('p_name').trim();
          if(!name){toast('Введите название');return;}
          const partner_id=val('p_partner')||null;
          if(!partner_id){toast('Выберите партнёра');return;}
          let barcode=val('p_barcode').trim();if(!barcode)barcode=genBarcode();
          const payload={name,partner_id,barcode,sku:val('p_sku').trim()||null,ket_sku:val('p_ketsku').trim()||null};
          if(photoTouched)payload.photo=panelPhotoDataUrl;   // иначе фото не трогаем вовсе
          const saved=await dbUpdate('products',id,payload);
          if(!saved){toast('Не удалось сохранить');return;}
          Object.assign(p,saved);
          const i=(S.products||[]).findIndex(x=>x.id===id);if(i>=0)Object.assign(S.products[i],saved);
          logAction('update','products',{entity_id:id,entity_label:name});
          if(payload.ket_sku){
            const matchedCount=await matchInboundItemsForCodes(id,productKetSkuList(payload));
            toast(matchedCount?`Привязано позиций в заказах KET: ${matchedCount}`
                              :'Позиций с такими тех.названиями в заказах KET не нашлось',5000);
            _whUnmatchedCount=null;
          }
          toast('Товар изменён');ov.remove();renderCash();
        }finally{saveBtn.disabled=false;}
      };
    }
  }
  ov.querySelectorAll('[data-wptab]').forEach(b=>b.onclick=()=>{tab=b.dataset.wptab;paint();});
  paint();
  // фото в списке не грузится (оно тяжёлое) — подтягиваем для открытой карточки и
  // перерисовываем, когда пришло
  if(p.photo===undefined){
    ensureProductPhotos([id]).then(()=>{
      // Отмечаем «фото под нашим контролем» ТОЛЬКО если оно реально пришло. Иначе (запрос не
      // удался, строку не вернули) сохранение отправило бы photo:null и затёрло существующее.
      if(p.photo===undefined)return;
      panelPhotoDataUrl=p.photo||null;photoTouched=true;
      if(document.body.contains(ov)&&tab==='info')paint();
    });
  }
}

// этикетка со штрих-кодом (для печати)
function productLabelModal(id){
  const p=(S.products||[]).find(x=>x.id===id);if(!p)return;
  const bc=p.barcode||'';
  // простой рисунок штрих-кода полосками из цифр, растянутый под ширину этикетки 58мм
  const bars=bc.split('').map(d=>{const w=(2.3+(parseInt(d,10)%3)*1.5).toFixed(2);return `<span style="display:inline-block;width:${w}mm;height:100%;background:#000;margin-right:0.4mm"></span>`;}).join('');
  const body=`
    <div class="wh-label" id="whLabelPrint">
      <div class="wh-label-name">${esc(p.name||'')}</div>
      <div class="wh-label-bars">${bars}</div>
      <div class="wh-label-code">${esc(bc)}</div>
      ${p.sku?`<div class="wh-label-sku">Арт: ${esc(p.sku)}</div>`:''}
    </div>
    <div class="hint" style="text-align:center;margin-top:8px">Размер этикетки: 58×40 мм — при печати выберите этот же размер бумаги в настройках принтера.</div>
    <div style="text-align:center;margin-top:10px"><button class="btn primary" onclick="window.print()">🖨 Печать</button></div>`;
  showInfo('Этикетка товара',body);
}

// импорт списка товаров из CSV/вставленного текста
function productImportModal(){
  const body=`
    <div class="wh-hint">Вставьте список товаров. Каждый товар с новой строки. Формат: <b>название;штрих-код;артикул;категория</b><br>Штрих-код, артикул и категория необязательны. Если штрих-кода нет — сгенерируется.</div>
    <div class="field full"><label>Партнёр склада (для всех импортируемых товаров) <span style="color:var(--rust)">*</span></label>
      <select id="whImportPartner"><option value="">— выберите партнёра склада —</option>${(S.warehouse_partners||[]).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(pt=>`<option value="${pt.id}" ${whPartner===pt.id?'selected':''}>${esc(pt.name)}</option>`).join('')}</select></div>
    <textarea id="whImportText" rows="9" placeholder="Кроссовки Nike;4870123456789;NK-42;Обувь&#10;Футболка белая M;;TS-M;Одежда&#10;Носки;;;"></textarea>
    <div class="wh-hint">Товары добавятся с остатком 0. Остатки проставите потом при редактировании.</div>`;
  showModal('Импорт товаров',body,async()=>{
    const partner_id=val('whImportPartner')||null;
    if(!partner_id){toast('Выберите партнёра');return false;}
    const txt=(val('whImportText')||'').trim();
    if(!txt){toast('Вставьте список');return false;}
    const lines=txt.split('\n').map(l=>l.trim()).filter(Boolean);
    let added=0;const batch=[];
    for(const line of lines){
      const [name,barcode,sku,category]=line.split(';').map(s=>(s||'').trim());
      if(!name)continue;
      batch.push({name,partner_id,barcode:barcode||genBarcode(),sku:sku||null,category:category||null,stock:{}});
    }
    if(!batch.length){toast('Нет строк для импорта');return false;}
    // Вставляем пачками, а не по одной строке: сто товаров — это был сто запросов подряд.
    // Рядом, в создании заказов по заявке, так уже сделано.
    const CH=200;
    for(let i=0;i<batch.length;i+=CH){
      const {data,error}=await sb.from('products').insert(batch.slice(i,i+CH)).select();
      if(error){console.error('импорт товаров',error);toast('Ошибка импорта: '+error.message);break;}
      if(data){if(!S.products)S.products=[];data.forEach(r=>S.products.unshift(r));added+=data.length;}
    }
    logAction('create','products',{entity_label:`импорт ${added} товаров`});
    toast(`Добавлено товаров: ${added}`);renderCash();return true;
  },{wide:true});
}
// импорт тех.названий KET (напр. выгрузка «Общие данные»): строка = тех.название;описание;партнёр(менеджер)
// у одного описания может быть несколько строк с разными тех.названиями — они автоматически
// объединяются в один товар (ket_sku через запятую). Партнёр сопоставляется по названию (без учёта регистра).
// Если товар с таким названием ИЛИ с таким тех.названием уже существует — новые коды добавляются к нему,
// а не создаётся дубль.
function productImportKetModal(){
  const body=`
    <div class="wh-hint">Вставьте строки в формате <b>тех.название;описание товара;партнёр (менеджер)</b> — по одной на строку.
      Партнёр ищется по названию среди уже заведённых «Партнёров склада» (регистр не важен).
      Если у одного описания несколько строк с разными тех.названиями — они объединятся в один товар.
      Уже существующие товары (по названию или по уже привязанному тех.названию) не дублируются — новые коды просто добавятся к ним.</div>
    <textarea id="whImportKetText" rows="10" placeholder="146;Ketoform;VECTOR&#10;146H;Ketoform;VECTOR&#10;janamen_for_man;Janamen for man;JanaMen"></textarea>`;
  showModal('Импорт тех.названий KET',body,async()=>{
    const txt=(val('whImportKetText')||'').trim();
    if(!txt){toast('Вставьте список');return false;}
    const rows=txt.split('\n').map(l=>l.trim()).filter(Boolean).map(line=>{
      const parts=(line.includes('\t')?line.split('\t'):line.split(';')).map(s=>(s||'').trim());
      return {tech:parts[0]||'',desc:parts[1]||'',mgr:parts[2]||''};
    }).filter(r=>r.tech&&r.desc);
    if(!rows.length){toast('Нет строк для импорта');return false;}
    // группировка по нормализованному описанию — объединяем тех.названия одного товара
    const groups=new Map(); // descNorm -> {desc,mgr,codes:[]}
    rows.forEach(r=>{
      const key=r.desc.toLowerCase().replace(/\s+/g,' ').trim();
      if(!groups.has(key))groups.set(key,{desc:r.desc,mgr:r.mgr,codes:[]});
      const g=groups.get(key);
      if(!g.codes.some(c=>normKetSku(c)===normKetSku(r.tech)))g.codes.push(r.tech);
    });
    // индекс уже привязанных кодов по всем товарам (чтобы не плодить дубли)
    const codeIndex=new Map(); // normCode -> product
    (S.products||[]).forEach(p=>productKetSkuList(p).forEach(c=>codeIndex.set(normKetSku(c),p)));
    const nameIndex=new Map(); // normName -> product
    (S.products||[]).forEach(p=>nameIndex.set((p.name||'').toLowerCase().trim(),p));
    const partnerByName=new Map();
    (S.warehouse_partners||[]).forEach(pt=>partnerByName.set((pt.name||'').toLowerCase().trim(),pt.id));
    let created=0,updated=0,noPartner=0;const noPartnerNames=new Set();
    const touched=[];   // товары, которых импорт коснулся — по ним и запускаем привязку
    for(const g of groups.values()){
      // существующий товар: сперва по совпадению тех.кода, иначе по точному названию
      let existing=null;
      for(const c of g.codes){const p=codeIndex.get(normKetSku(c));if(p){existing=p;break;}}
      if(!existing)existing=nameIndex.get(g.desc.toLowerCase().trim())||null;
      if(existing){
        let merged=existing.ket_sku||'';
        g.codes.forEach(c=>{merged=mergeKetSku(merged,c);});
        if(merged!==(existing.ket_sku||'')){
          const upd=await dbUpdate('products',existing.id,{ket_sku:merged});
          if(upd){Object.assign(existing,upd);updated++;}
        }
        touched.push(existing);
        continue;
      }
      const partner_id=partnerByName.get((g.mgr||'').toLowerCase().trim())||null;
      if(!partner_id){noPartner++;noPartnerNames.add(g.mgr||'(пусто)');continue;}
      const payload={name:g.desc,partner_id,barcode:genBarcode(),sku:null,category:null,stock:{},ket_sku:g.codes.join(', ')};
      const saved=await dbInsert('products',payload);
      if(saved){if(!S.products)S.products=[];S.products.unshift(saved);nameIndex.set(g.desc.toLowerCase().trim(),saved);g.codes.forEach(c=>codeIndex.set(normKetSku(c),saved));created++;touched.push(saved);}
    }
    logAction('create','products',{entity_label:`импорт KET: создано ${created}, обновлено ${updated}`});
    // Привязка идёт по базе, а не по загруженным на экран заказам. Раньше здесь ради неё
    // выкачивалась вся история KET (десятки тысяч заказов со всем составом), и всё равно
    // привязывалось только то, что попало в память — см. matchInboundItemsForCodes.
    let linked=0;
    for(const pr of touched){
      try{linked+=await matchInboundItemsForCodes(pr.id,productKetSkuList(pr));}catch(e){console.error('привязка после импорта',e);}
    }
    _whUnmatchedCount=null;   // счётчик «требуют привязки» пересчитаем заново
    let msg=`Создано товаров: ${created}, обновлено (добавлены коды): ${updated}`;
    msg+=`. Привязано позиций в заказах KET: ${linked}`;
    if(noPartner)msg+=`. Пропущено без партнёра: ${noPartner} (${[...noPartnerNames].join(', ')})`;
    toast(msg,7000);renderCash();return true;
  },{wide:true});
}

// Этап 3 и 4 — сделаем после обкатки товаров
/* ── ЭТАП 3: СБОРКА ЗАКАЗА СО СКАНИРОВАНИЕМ ── */
// состав заказа хранится в wh_order_items: {order_code, product_id, qty}
// пока состав вводится вручную; позже придёт из KET
let _asmOrder=null;      // текущий собираемый заказ {code, items:[{product_id,qty,scanned}]}
function renderWhAssembly(asmType){
  whAssemblyType=asmType||whAssemblyType||'courier';
  // если переключились на другую вкладку сборки — незавершённую сборку другого типа не показываем
  if(_asmOrder&&_asmOrder.assemblyType!==whAssemblyType)_asmOrder=null;
  const label=whAssemblyType==='mail'?'Почтовая':'Курьерская';
  $('whContent').innerHTML=`
    <div class="wh2-qf" style="margin-bottom:14px">
      <button data-asmtype="courier" class="${whAssemblyType==='courier'?'active':''}">🚚 Курьер</button>
      <button data-asmtype="mail" class="${whAssemblyType==='mail'?'active':''}">✉️ Почта</button>
    </div>
    <div class="asm-scan">
      <div class="asm-scan-label">🔍 ${esc(label)} сборка — отсканируйте или введите код заказа</div>
      <div class="asm-scan-row">
        <input id="asmOrderInput" placeholder="Код заказа / трек…" autocomplete="off">
        <button class="btn primary" id="asmOpen">Открыть</button>
      </div>
      <div class="hint">Наведите сканер и пикните штрих-код заказа, или введите код вручную и нажмите «Открыть». Если заказ окажется ${whAssemblyType==='mail'?'курьерским':'почтовым'} — подскажем открыть другую вкладку.</div>
    </div>
    <div id="asmBody"></div>`;
  $('whContent').querySelectorAll('[data-asmtype]').forEach(b=>b.onclick=()=>{whSub='assembly_'+b.dataset.asmtype;renderCash();});
  const open=async()=>{
    const code=($('asmOrderInput')||{}).value?.trim();
    if(!code)return;
    await startAssembly(code,whAssemblyType);
  };
  if($('asmOpen'))$('asmOpen').onclick=open;
  if($('asmOrderInput')){
    $('asmOrderInput').focus();
    // сканер-пистолет вводит код и жмёт Enter — ловим Enter
    $('asmOrderInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open();}};
  }
  if(_asmOrder)drawAssembly();
}
// сообщение, когда введённый заказ относится к другому типу доставки (не той вкладке)
function asmWrongTabHtml(code,actualType){
  const otherLabel=actualType==='mail'?'Почтовая':'Курьерская';
  const otherWord=actualType==='mail'?'почтовый':'курьерский';
  return `<div class="panel"><div class="empty"><div class="big">Не та вкладка сборки</div>
    Заказ «${esc(code)}» — ${otherWord}. Откройте вкладку «${otherLabel} сборка», чтобы собрать его.</div></div>`;
}

// находим заказ по коду/треку и его состав
async function startAssembly(code,asmType){
  asmType=asmType||whAssemblyType||'courier';
  // 1) собственные заказы (созданы из заявок на забор, состав вводится вручную через "Указать состав заказа")
  const order=(S.orders||[]).find(o=>String(o.code||'')===code||String(o.track||'')===code||String(o.id).slice(0,8)===code);
  if(order&&order.delivery_id){
    const ownType=isCourierDelivery(order.delivery_id)?'courier':'mail';
    if(ownType!==asmType){$('asmBody').innerHTML=asmWrongTabHtml(code,ownType);return;}
  }
  const items=(S.wh_order_items||[]).filter(it=>it.order_code===code||(order&&it.order_code===String(order.code)));
  if(items.length){
    _asmOrder={kind:'own',assemblyType:asmType,code,order,items:items.map(it=>({product_id:it.product_id,qty:it.qty||1,scanned:0}))};
    drawAssembly();
    return;
  }
  // 2) заказы из интеграции KET (Заказы → Заказы КЕТ) — состав уже привязан к товарам там
  if(!S.inbound_full_loaded){try{await loadInbound({full:true});}catch(e){}}
  const inb=(S.inbound_orders||[]).find(o=>String(o.external_id||'')===code||String(o.id).slice(0,8)===code);
  if(inb){
    const inbType=inboundDeliveryType(inb);
    if(inbType!==asmType){$('asmBody').innerHTML=asmWrongTabHtml(code,inbType);return;}
    if(inb.stock_written){
      $('asmBody').innerHTML=`<div class="panel"><div class="empty"><div class="big">Заказ уже собран</div>Склад по заказу КЕТ «${esc(code)}» уже был списан ранее (в разделе «Заказы КЕТ»).</div></div>`;
      return;
    }
    const inbItems=inboundItemsFor(inb.id);
    if(!inbItems.length||inbItems.some(it=>!it.matched||!it.product_id)){
      $('asmBody').innerHTML=`<div class="panel"><div class="empty"><div class="big">Товары ещё не привязаны</div>Это заказ из KET, но не все позиции привязаны к товарам склада. Откройте «Заказы → Заказы КЕТ», найдите заказ «${esc(code)}» и нажмите «Привязать».</div></div>`;
      return;
    }
    _asmOrder={kind:'ket',assemblyType:asmType,code,inboundId:inb.id,items:inbItems.map(it=>({product_id:it.product_id,qty:it.qty||1,scanned:0}))};
    drawAssembly();
    return;
  }
  // 3) нигде не нашли — предложим ввести состав вручную (старое поведение)
  $('asmBody').innerHTML=`<div class="panel"><div class="empty"><div class="big">Состав заказа не задан</div>
    Для заказа «${esc(code)}» не указано, какие товары внутри. Пока состав вводится вручную.
    <div style="margin-top:14px"><button class="btn primary" id="asmSetItems">Указать состав заказа</button></div></div></div>`;
  if($('asmSetItems'))$('asmSetItems').onclick=()=>orderItemsModal(code,order);
}

function drawAssembly(){
  if(!_asmOrder)return;
  const pn=id=>{const p=(S.products||[]).find(x=>x.id===id);return p?p.name:'—';};
  const pbc=id=>{const p=(S.products||[]).find(x=>x.id===id);return p?p.barcode:'';};
  const allDone=_asmOrder.items.every(it=>it.scanned>=it.qty);
  $('asmBody').innerHTML=`
    <div class="panel">
      <div class="panel-head"><h2>Сборка заказа ${esc(_asmOrder.code)}
        <span class="pill ${_asmOrder.assemblyType==='mail'?'gold':'moss'}">${_asmOrder.assemblyType==='mail'?'Почта':'Курьер'}</span>
        ${_asmOrder.kind==='ket'?' <span class="ket-badge" style="font-size:11px;vertical-align:middle">KET</span>':''}</h2>
        <button class="btn ghost sm" id="asmCancel" style="margin-left:auto">Отменить</button></div>
      <div class="asm-scan-row" style="padding:14px 18px">
        <input id="asmItemInput" placeholder="Пикните штрих-код товара…" autocomplete="off">
        <span class="asm-progress">${_asmOrder.items.reduce((s,it)=>s+it.scanned,0)} / ${_asmOrder.items.reduce((s,it)=>s+it.qty,0)}</span>
      </div>
      <div id="asmFeedback"></div>
      <div class="asm-items">
        ${_asmOrder.items.map(it=>{
          const done=it.scanned>=it.qty;
          const p=(S.products||[]).find(x=>x.id===it.product_id);
          const stockNow=p?productStock(p):0;
          const short=stockNow<it.qty;
          return `<div class="asm-item ${done?'asm-ok':''}">
            <div class="asm-item-ico">${done?'✅':'⬜'}</div>
            <div class="asm-item-body"><div class="asm-item-name">${esc(pn(it.product_id))}</div><div class="asm-item-bc">${esc(pbc(it.product_id))}${short?` · <span style="color:#c23b3b">на складе: ${stockNow}</span>`:''}</div></div>
            <div class="asm-item-qty">${it.scanned} / ${it.qty}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="asm-foot">
        <button class="btn primary" id="asmFinish" ${allDone?'':'disabled'}>${allDone?'✅ Завершить сборку':'Отсканируйте все товары'}</button>
      </div>
    </div>`;
  const inp=$('asmItemInput');
  if(inp){inp.focus();inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();scanItem(inp.value.trim());inp.value='';}};}
  if($('asmCancel'))$('asmCancel').onclick=()=>{_asmOrder=null;renderWhAssembly();};
  if($('asmFinish'))$('asmFinish').onclick=()=>finishAssembly();
}

function scanItem(code){
  if(!code||!_asmOrder)return;
  const p=(S.products||[]).find(x=>String(x.barcode||'')===code);
  const fb=$('asmFeedback');
  if(!p){flashFeedback(fb,'❌ Товар не найден','err');return;}
  const it=_asmOrder.items.find(i=>i.product_id===p.id);
  if(!it){flashFeedback(fb,`❌ «${p.name}» не в этом заказе`,'err');return;}
  if(it.scanned>=it.qty){flashFeedback(fb,`⚠️ «${p.name}» уже собран полностью`,'warn');return;}
  // остатка на складе не должно хватать меньше, чем уже отсканировано в этой сборке — иначе уйдём в минус
  const stockLeft=productStock(p)-it.scanned;
  if(stockLeft<=0){flashFeedback(fb,`🚫 «${p.name}» — остатка товара нет на складе (${esc(whCity)})`,'err');return;}
  it.scanned++;
  flashFeedback(fb,`✅ ${p.name} (${it.scanned}/${it.qty})`,'ok');
  drawAssembly();
}
function flashFeedback(el,msg,kind){
  if(!el)return;
  el.innerHTML=`<div class="asm-fb asm-fb-${kind}">${esc(msg)}</div>`;
  // звук: короткий бип (ok — высокий, err — низкий)
  try{const ctx=new (window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=kind==='ok'?880:220;g.gain.value=0.1;o.start();setTimeout(()=>{o.stop();ctx.close();},kind==='ok'?90:200);}catch(e){}
}
// Проверка «склад по этому заказу уже списывали». У заказов KET для этого есть отметка
// stock_written, у собственных её не было вовсе — тот же код можно было отсканировать
// второй раз и списать товар повторно, молча. Журнал движений и есть запись о списании,
// по нему и проверяем — отдельное поле в базе заводить не нужно.
async function assemblyAlreadyWritten(code){
  try{
    const {data,error}=await sb.from('wh_moves').select('created_at')
      .eq('target','Заказ '+code).order('created_at',{ascending:false}).limit(1);
    if(error){console.error('проверка повторного списания',error);return '';}
    if(data&&data.length)return fmtDate(data[0].created_at)||'ранее';
  }catch(e){console.error('проверка повторного списания',e);}
  return '';
}
// К какому городу относится собираемый заказ (для сверки со складом, выбранным в шапке)
function assemblyOrderCity(asm){
  if(asm&&asm.kind==='own'&&asm.order&&asm.order.pickup_city_id){
    const nm=cityName(asm.order.pickup_city_id);
    return normalizeWhCity(nm)||'';
  }
  return '';
}
async function finishAssembly(){
  if(!_asmOrder)return;
  const code=_asmOrder.code;
  // 1) Не списываем дважды.
  const already=await assemblyAlreadyWritten(code);
  if(already&&!confirm(`Склад по заказу «${code}» уже списывали (${already}).\nСписать ещё раз?`))return;
  // 2) Город. Списание идёт в тот город, что выбран в шапке склада. Если заказ относится
  //    к другому — спрашиваем прямо, а не уводим остаток с чужого склада молча.
  const orderCity=assemblyOrderCity(_asmOrder);
  if(orderCity&&orderCity!==whCity&&
     !confirm(`Заказ «${code}» — город «${orderCity}», а выбран склад «${whCity}».\nВсё равно списать со склада «${whCity}»?`))return;
  // 3) Нехватка. Раньше остаток упирался в ноль: было 2, списали 5 — стало 0, и расхождение
  //    исчезало. Теперь оно видно: предупреждаем и списываем как есть, в минус.
  const pn=id=>{const p=(S.products||[]).find(x=>x.id===id);return p?p.name:'—';};
  const short=[];
  for(const it of _asmOrder.items){
    const p=(S.products||[]).find(x=>x.id===it.product_id);if(!p)continue;
    const before=parseInt(((p.stock&&typeof p.stock==='object')?p.stock:{})[whCity]||0,10)||0;
    if(before<it.qty)short.push(`${pn(it.product_id)}: на складе ${before}, нужно ${it.qty}`);
  }
  if(short.length&&!confirm(`На складе «${whCity}» не хватает товара:\n\n${short.join('\n')}\n\nСписать всё равно? Остаток уйдёт в минус — это и покажет недостачу.`))return;
  // списываем товары со склада (расход — отгрузка) и пишем движения
  for(const it of _asmOrder.items){
    const p=(S.products||[]).find(x=>x.id===it.product_id);if(!p)continue;
    const stock=(p.stock&&typeof p.stock==='object')?Object.assign({},p.stock):{};
    const before=parseInt(stock[whCity]||0,10)||0;
    const after=before-it.qty;   // без обрезки по нулю: недостача должна быть видна
    stock[whCity]=after;
    const move={product_id:it.product_id,city:whCity,op:'out_courier',qty:it.qty,balance_after:after,
      target:`Заказ ${_asmOrder.code}`,comment:'Сборка заказа',user_id:(S.me&&S.me.id)||null,user_name:(S.me&&(S.me.full_name||S.me.email))||'—'};
    const sm=await dbInsert('wh_moves',move);if(sm){if(!S.wh_moves)S.wh_moves=[];S.wh_moves.unshift(sm);}
    const sp=await dbUpdate('products',it.product_id,{stock});if(sp){const i=S.products.findIndex(x=>x.id===it.product_id);if(i>=0)S.products[i].stock=stock;}
  }
  // 4) Снимаем резервы этого заказа: товар уже уехал, держать его «занятым» незачем.
  //    Раньше резерв не снимался ничем, кроме ручной отмены, и «Доступно» оставалось
  //    заниженным навсегда.
  let released=0;
  for(const r of (S.wh_reservations||[]).filter(r=>r.status==='active'&&r.order_code===code)){
    const u=await dbUpdate('wh_reservations',r.id,{status:'cancelled',updated_at:new Date().toISOString()});
    if(u){Object.assign(r,u);released++;}
  }
  logAction('create','wh_moves',{entity_label:`Собран заказ ${_asmOrder.code}`});
  // если это заказ из интеграции KET — помечаем его как списанный, чтобы не списать склад повторно
  if(_asmOrder.kind==='ket'&&_asmOrder.inboundId){
    const upd={stock_written:true,stock_written_at:new Date().toISOString()};
    await dbUpdate('inbound_orders',_asmOrder.inboundId,upd);
    const inb=(S.inbound_orders||[]).find(x=>x.id===_asmOrder.inboundId);
    if(inb)Object.assign(inb,upd);
  }
  toast(`Заказ ${_asmOrder.code} собран ✅${released?` · снято резервов: ${released}`:''}`);
  _asmOrder=null;renderWhAssembly();
}

// ручной ввод состава заказа (пока нет интеграции с KET)
function orderItemsModal(code,order){
  const products=[...(S.products||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  let rows=[{product_id:'',qty:1}];
  const existing=(S.wh_order_items||[]).filter(it=>it.order_code===code);
  if(existing.length)rows=existing.map(it=>({product_id:it.product_id,qty:it.qty||1}));
  const rowHtml=(r,i)=>`<div class="oi-row" data-oirow="${i}">
    <select class="oi-product" data-i="${i}"><option value="">— товар —</option>${products.map(p=>`<option value="${p.id}" ${r.product_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>
    <input type="number" min="1" step="1" class="oi-qty" data-i="${i}" value="${r.qty}" style="width:80px">
    <button class="btn sm danger oi-del" data-i="${i}">✕</button>
  </div>`;
  const body=`
    <div class="hint" style="margin-bottom:10px">Заказ «${esc(code)}». Укажите товары, которые должны быть внутри. Потом сборщик отсканирует их.</div>
    <div id="oiRows">${rows.map(rowHtml).join('')}</div>
    <button class="btn ghost sm" id="oiAdd" style="margin-top:8px">＋ Добавить товар</button>`;
  showModal('Состав заказа',body,async()=>{
    const rws=[...document.querySelectorAll('[data-oirow]')].map(el=>{
      const i=el.dataset.oirow;
      const pid=el.querySelector('.oi-product').value;
      const q=parseInt(el.querySelector('.oi-qty').value,10)||1;
      return {product_id:pid,qty:q};
    }).filter(r=>r.product_id);
    if(!rws.length){toast('Добавьте хотя бы один товар');return false;}
    // удаляем старый состав и пишем новый
    for(const it of existing){await dbDelete('wh_order_items',it.id).catch(()=>{});}
    S.wh_order_items=(S.wh_order_items||[]).filter(it=>it.order_code!==code);
    for(const r of rws){
      const saved=await dbInsert('wh_order_items',{order_code:code,product_id:r.product_id,qty:r.qty});
      if(saved){S.wh_order_items.push(saved);}
    }
    toast('Состав сохранён');startAssembly(code);return true;
  },{wide:true});
  setTimeout(()=>{
    const bind=()=>{
      document.querySelectorAll('.oi-del').forEach(b=>b.onclick=()=>{b.closest('[data-oirow]').remove();});
    };
    bind();
    if($('oiAdd'))$('oiAdd').onclick=()=>{
      const wrap=$('oiRows');const i=Date.now();
      const div=document.createElement('div');div.innerHTML=rowHtml({product_id:'',qty:1},i);
      wrap.appendChild(div.firstElementChild);bind();
    };
  },50);
}

/* ── ЭТАП 4: ПРИЁМКА НЕВЫКУПА ── */
let _intakeOrder=null;
function renderWhIntake(){
  $('whContent').innerHTML=`
    <div class="asm-scan">
      <div class="asm-scan-label">↩️ Приёмка возврата (невыкуп)</div>
      <div class="asm-scan-row">
        <input id="intakeInput" placeholder="Код возвращённого заказа…" autocomplete="off">
        <button class="btn primary" id="intakeOpen">Открыть</button>
      </div>
      <div class="hint">Курьер вернул невыкупленный заказ — пикните его код, товары вернутся на склад города «${esc(whCity)}».</div>
    </div>
    <div id="intakeBody"></div>`;
  const open=()=>{const code=($('intakeInput')||{}).value?.trim();if(!code)return;startIntake(code);};
  if($('intakeOpen'))$('intakeOpen').onclick=open;
  if($('intakeInput')){$('intakeInput').focus();$('intakeInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();open();}};}
}
// Приёмка возврата. Раньше состав искался ТОЛЬКО среди вручную заведённых составов
// (wh_order_items) — значит невыкуп по заказу из KET принять было нечем, хотя собрать его
// склад умел. Теперь оба источника, как и в сборке.
async function startIntake(code){
  const body=$('intakeBody');if(!body)return;
  let items=(S.wh_order_items||[]).filter(it=>it.order_code===code)
    .map(it=>({product_id:it.product_id,qty:it.qty||1}));
  let inboundId=null;
  if(!items.length){
    body.innerHTML='<div class="panel"><div class="empty">Ищем заказ…</div></div>';
    if(!S.inbound_orders){try{await loadInbound({full:true});}catch(e){}}
    const inb=(S.inbound_orders||[]).find(o=>String(o.external_id||'')===code||String(o.id).slice(0,8)===code);
    if(inb){
      const inbItems=inboundItemsFor(inb.id);
      if(!inbItems.length||inbItems.some(it=>!it.matched||!it.product_id)){
        body.innerHTML=`<div class="panel"><div class="empty"><div class="big">Товары ещё не привязаны</div>
          Это заказ из KET, но его позиции не сопоставлены с товарами склада. Пропишите тех.названия в карточках товаров.</div></div>`;
        return;
      }
      items=inbItems.map(it=>({product_id:it.product_id,qty:it.qty||1}));
      inboundId=inb.id;
    }
  }
  if(!items.length){
    body.innerHTML=`<div class="panel"><div class="empty"><div class="big">Состав заказа не найден</div>Для «${esc(code)}» не указано, какие товары внутри — ни у нас, ни в заказах KET.</div></div>`;
    return;
  }
  const pn=id=>{const p=(S.products||[]).find(x=>x.id===id);return p?p.name:'—';};
  body.innerHTML=`
    <div class="panel">
      <div class="panel-head"><h2>Возврат заказа ${esc(code)}</h2><span class="count">${esc(whCity)}</span></div>
      <div class="asm-items">
        ${items.map(it=>`<div class="asm-item"><div class="asm-item-ico">↩️</div>
          <div class="asm-item-body"><div class="asm-item-name">${esc(pn(it.product_id))}</div></div>
          <div class="asm-item-qty">+${it.qty||1}</div></div>`).join('')}
      </div>
      <div class="asm-foot"><button class="btn primary" id="intakeConfirm">✅ Принять возврат на склад «${esc(whCity)}»</button></div>
    </div>`;
  if($('intakeConfirm'))$('intakeConfirm').onclick=async()=>{
    const btn=$('intakeConfirm');btn.disabled=true;btn.textContent='Принимаем…';
    for(const it of items){
      const p=(S.products||[]).find(x=>x.id===it.product_id);if(!p)continue;
      const stock=(p.stock&&typeof p.stock==='object')?Object.assign({},p.stock):{};
      const before=parseInt(stock[whCity]||0,10)||0;const after=before+(it.qty||1);stock[whCity]=after;
      const move={product_id:it.product_id,city:whCity,op:'return',qty:it.qty||1,balance_after:after,
        target:`Возврат заказа ${code}`,comment:'Приёмка невыкупа',user_id:(S.me&&S.me.id)||null,user_name:(S.me&&(S.me.full_name||S.me.email))||'—'};
      const sm=await dbInsert('wh_moves',move);if(sm){if(!S.wh_moves)S.wh_moves=[];S.wh_moves.unshift(sm);}
      const sp=await dbUpdate('products',it.product_id,{stock});if(sp){const i=S.products.findIndex(x=>x.id===it.product_id);if(i>=0)S.products[i].stock=stock;}
    }
    // заказ KET вернулся — снимаем отметку о списании, иначе его нельзя будет собрать заново
    if(inboundId){
      const upd={stock_written:false,stock_written_at:null};
      await dbUpdate('inbound_orders',inboundId,upd);
      const inb=(S.inbound_orders||[]).find(x=>x.id===inboundId);if(inb)Object.assign(inb,upd);
    }
    logAction('create','wh_moves',{entity_label:`Приёмка возврата ${code}`});
    toast(`Возврат ${code} принят ✅`);renderWhIntake();
  };
}

/* ── ДВИЖЕНИЯ ТОВАРОВ (журнал операций, как в системе Money) ── */
// типы операций: приход (+) и расход (−)
const WH_MOVE_TYPES=[
  {k:'in_stock',   label:'Приход на склад',  dir:+1},
  {k:'out_mail',   label:'Расход почты',     dir:-1},
  {k:'out_courier',label:'Отгрузка курьера', dir:-1},
  {k:'to_city',    label:'Отправка в город', dir:-1},
  {k:'return',     label:'Возврат',          dir:+1},
  {k:'defect',     label:'Брак / списание',  dir:-1},
  {k:'correct',    label:'Корректировка',    dir:0},
];
function whMoveType(k){return WH_MOVE_TYPES.find(t=>t.k===k)||{label:k,dir:0};}
let whMoveFilter={product:'',type:'',partner:'',from:'',to:''};
let whMovesPage=1;const WH_MOVES_PER=50;

function renderWhMoves(){
  const all=[...(S.wh_moves||[])]
    .filter(m=>m.city===whCity) // движения выбранного города
    .sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  // фильтры
  const rows=all.filter(m=>{
    if(whMoveFilter.product&&m.product_id!==whMoveFilter.product)return false;
    if(whMoveFilter.type&&m.op!==whMoveFilter.type)return false;
    if(whMoveFilter.partner){const p=(S.products||[]).find(x=>x.id===m.product_id);if(!p||p.partner_id!==whMoveFilter.partner)return false;}
    if(whMoveFilter.from&&(m.created_at||'').slice(0,10)<whMoveFilter.from)return false;
    if(whMoveFilter.to&&(m.created_at||'').slice(0,10)>whMoveFilter.to)return false;
    return true;
  });
  const productName=id=>{const p=(S.products||[]).find(x=>x.id===id);return p?p.name:'—';};
  const productPartner=id=>{const p=(S.products||[]).find(x=>x.id===id);return p&&p.partner_id?whPartnerName(p.partner_id):'—';};
  // товары/партнёры для фильтров
  const usedProducts=[...new Set(all.map(m=>m.product_id))];
  const usedPartners=[...new Set(all.map(m=>{const p=(S.products||[]).find(x=>x.id===m.product_id);return p&&p.partner_id;}).filter(Boolean))];
  // пагинация
  const pages=Math.max(1,Math.ceil(rows.length/WH_MOVES_PER));
  if(whMovesPage>pages)whMovesPage=1;
  const pageRows=rows.slice((whMovesPage-1)*WH_MOVES_PER,whMovesPage*WH_MOVES_PER);
  const fmtT=s=>{const t=fmtLogTime?fmtLogTime(s):{date:(s||'').slice(0,10),time:(s||'').slice(11,16)};return t;};
  $('whContent').innerHTML=`
    <div class="wh-toolbar">
      ${(isAdmin()||can('cash','create'))?'<button class="btn primary" id="whAddMove">＋ Операция</button>':''}
      <span class="hint" style="align-self:center">Движения товаров в городе «${esc(whCity)}»</span>
    </div>
    <div class="ic-filters">
      <select id="wmfType"><option value="">Все операции</option>${WH_MOVE_TYPES.map(t=>`<option value="${t.k}" ${whMoveFilter.type===t.k?'selected':''}>${esc(t.label)}</option>`).join('')}</select>
      <select id="wmfPartner"><option value="">Все партнёры</option>${usedPartners.map(pid=>`<option value="${pid}" ${whMoveFilter.partner===pid?'selected':''}>${esc(whPartnerName(pid))}</option>`).join('')}</select>
      <select id="wmfProduct"><option value="">Все товары</option>${usedProducts.map(pid=>`<option value="${pid}" ${whMoveFilter.product===pid?'selected':''}>${esc(productName(pid))}</option>`).join('')}</select>
      <input type="date" id="wmfFrom" value="${esc(whMoveFilter.from)}" title="С даты">
      <input type="date" id="wmfTo" value="${esc(whMoveFilter.to)}" title="По дату">
      ${(whMoveFilter.product||whMoveFilter.type||whMoveFilter.partner||whMoveFilter.from||whMoveFilter.to)?'<button class="btn ghost sm" id="wmfClear">Сбросить</button>':''}
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Журнал движений</h2><span class="count">${rows.length}</span></div>
      <div class="table-scroll"><table class="resp-table wh-moves-tbl"><thead><tr>
        <th>Дата и время</th><th>Партнёр</th><th>Товар</th><th>Операция</th><th>Кол-во</th><th>Остаток</th><th>Получатель</th><th>Сотрудник</th>
      </tr></thead><tbody>
      ${pageRows.length?pageRows.map(m=>{
        const t=whMoveType(m.op);const tt=fmtT(m.created_at);
        return `<tr>
          <td data-label="Дата и время"><div class="log-when"><b>${esc(tt.date)}</b>${esc(tt.time)}</div></td>
          <td data-label="Партнёр">${esc(productPartner(m.product_id))}</td>
          <td data-label="Товар"><strong>${esc(productName(m.product_id))}</strong></td>
          <td data-label="Операция"><span class="wh-op ${t.dir>0?'wh-op-in':t.dir<0?'wh-op-out':''}">${esc(t.label)}</span></td>
          <td data-label="Кол-во"><span class="${t.dir>0?'wh-op-in':t.dir<0?'wh-op-out':''}">${t.dir>0?'+':t.dir<0?'−':''}${Math.abs(m.qty||0)}</span></td>
          <td data-label="Остаток"><b>${m.balance_after!=null?m.balance_after:'—'}</b></td>
          <td data-label="Получатель">${esc(m.target||'—')}</td>
          <td data-label="Сотрудник">${esc(m.user_name||'—')}</td>
        </tr>`;
      }).join(''):`<tr><td colspan="8"><div class="empty"><div class="big">Нет движений</div>${rows.length===0&&all.length?'Измените фильтры.':'Создайте первую операцию прихода товара.'}</div></td></tr>`}
      </tbody></table></div>
      ${pages>1?`<div class="hist-pager">
        <span class="hp-info">Показаны ${(whMovesPage-1)*WH_MOVES_PER+1}–${Math.min(whMovesPage*WH_MOVES_PER,rows.length)} из ${rows.length}</span>
        <div class="hp-btns">
          <button class="btn sm ghost" id="wmPrev" ${whMovesPage<=1?'disabled':''}>‹ Назад</button>
          <span class="hp-page">Стр. ${whMovesPage} / ${pages}</span>
          <button class="btn sm ghost" id="wmNext" ${whMovesPage>=pages?'disabled':''}>Вперёд ›</button>
        </div>
      </div>`:''}
    </div>`;
  if($('whAddMove'))$('whAddMove').onclick=()=>whMoveModal();
  if($('wmfType'))$('wmfType').onchange=e=>{whMoveFilter.type=e.target.value;whMovesPage=1;renderWhMoves();};
  if($('wmfPartner'))$('wmfPartner').onchange=e=>{whMoveFilter.partner=e.target.value;whMovesPage=1;renderWhMoves();};
  if($('wmfProduct'))$('wmfProduct').onchange=e=>{whMoveFilter.product=e.target.value;whMovesPage=1;renderWhMoves();};
  if($('wmfFrom'))$('wmfFrom').onchange=e=>{whMoveFilter.from=e.target.value;whMovesPage=1;renderWhMoves();};
  if($('wmfTo'))$('wmfTo').onchange=e=>{whMoveFilter.to=e.target.value;whMovesPage=1;renderWhMoves();};
  if($('wmfClear'))$('wmfClear').onclick=()=>{whMoveFilter={product:'',type:'',partner:'',from:'',to:''};whMovesPage=1;renderWhMoves();};
  if($('wmPrev'))$('wmPrev').onclick=()=>{if(whMovesPage>1){whMovesPage--;renderWhMoves();}};
  if($('wmNext'))$('wmNext').onclick=()=>{if(whMovesPage<pages){whMovesPage++;renderWhMoves();}};
}

// форма создания складской операции
// форма создания складской операции.
// presetProductId/presetCity — если открыта из карточки товара («Скорректировать»): товар и город
// уже выбраны и не меняются.
function whMoveModal(presetProductId,presetCity){
  if(!isAdmin()&&!can('cash','create')){toast('Нет прав на складские операции');return;}
  const products=[...(S.products||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if(!products.length){showInfo('Нет товаров','Сначала добавьте товары в разделе «Товары».');return;}
  const city=presetCity||whCity;
  const canSetFact=isAdmin()||can('cash','edit');
  const body=`
    <div class="form-grid">
      <div class="field"><label>Тип операции <span style="color:var(--rust)">*</span></label>
        <select id="wm_op">${WH_MOVE_TYPES.map(t=>`<option value="${t.k}">${esc(t.label)} ${t.dir>0?'(+)':t.dir<0?'(−)':''}</option>`).join('')}</select></div>
      <div class="field"><label>Город</label><input value="${esc(city)}" disabled></div>
      <div class="field full"><label>Товар <span style="color:var(--rust)">*</span></label>
        <select id="wm_product" ${presetProductId?'disabled':''}>${presetProductId?'':'<option value="">— выберите товар —</option>'}${products.map(p=>`<option value="${p.id}" ${presetProductId===p.id?'selected':''}>${esc(p.name)}${p.partner_id?' · '+esc(whPartnerName(p.partner_id)):''} (остаток: ${(p.stock&&p.stock[city])||0})</option>`).join('')}</select>
        ${presetProductId?`<input type="hidden" id="wm_product_fallback" value="${presetProductId}">`:''}</div>
      <div class="field full" id="wm_correctModeWrap" style="display:none"><label>Способ корректировки <span style="color:var(--rust)">*</span></label>
        <select id="wm_correctMode">
          <option value="add">Добавить</option>
          <option value="subtract">Уменьшить</option>
          ${canSetFact?'<option value="set">Установить фактический остаток</option>':''}
        </select></div>
      <div class="field"><label>Количество <span style="color:var(--rust)">*</span></label><input type="number" min="1" step="1" id="wm_qty" placeholder="0"></div>
      <div class="field"><label>Получатель / город назначения</label><input id="wm_target" placeholder="напр. Алматы, ФИО клиента"></div>
      <div class="field full" id="wm_reasonWrap" style="display:none"><label>Причина <span style="color:var(--rust)">*</span></label><input id="wm_reason" placeholder="напр. пересчёт, недостача, ошибка приёмки"></div>
      <div class="field full"><label>Комментарий</label><input id="wm_comment" placeholder="необязательно"></div>
    </div>
    <div class="hint" style="margin-top:8px">Остаток пересчитается автоматически. Операция зафиксирует вас и время.</div>`;
  showModal('Складская операция',body,async()=>{
    const op=val('wm_op');
    const product_id=presetProductId||val('wm_product');
    const qty=parseInt(val('wm_qty'),10)||0;
    const isCorrect=op==='correct';
    const correctMode=isCorrect?(val('wm_correctMode')||'add'):null;
    if(!product_id){toast('Выберите товар');return false;}
    if(qty<=0){toast('Введите количество');return false;}
    if(isCorrect&&!val('wm_reason').trim()){toast('Укажите причину корректировки');return false;}
    if(isCorrect&&!val('wm_comment').trim()){toast('Комментарий обязателен для ручной корректировки');return false;}
    if(isCorrect&&correctMode==='set'&&!canSetFact){toast('Нет прав устанавливать фактический остаток');return false;}
    // свежая загрузка товара мимо кэша — уменьшает (не исключает) окно гонки при параллельной работе
    const freshP=await dbGetOne('products',product_id);
    const p=freshP||(S.products||[]).find(x=>x.id===product_id);
    if(!p){toast('Товар не найден');return false;}
    const t=whMoveType(op);
    const stock=(p.stock&&typeof p.stock==='object')?Object.assign({},p.stock):{};
    const before=parseInt(stock[city]||0,10)||0;
    let after=before;
    if(isCorrect){
      if(correctMode==='set')after=qty;
      else if(correctMode==='subtract'){
        if(before-qty<0){toast(`Недостаточно на складе: есть ${before}, нужно ${qty}`);return false;}
        after=before-qty;
      }else after=before+qty; // add
    }else if(t.dir>0)after=before+qty;
    else if(t.dir<0){
      if(before-qty<0){toast(`Недостаточно на складе: есть ${before}, нужно ${qty}`);return false;}
      after=before-qty;
    }
    if(after<0){toast('Остаток не может быть отрицательным');return false;}
    stock[city]=after;
    // сохраняем движение
    const move={
      product_id,city,op,qty,
      balance_before:before,
      balance_after:after,
      target:val('wm_target').trim()||null,
      reason:isCorrect?val('wm_reason').trim():null,
      comment:val('wm_comment').trim()||null,
      user_id:(S.me&&S.me.id)||null,
      user_name:(S.me&&(S.me.full_name||S.me.email))||'—',
    };
    const savedMove=await dbInsert('wh_moves',move);
    if(!savedMove){toast('Не удалось сохранить операцию');return false;}
    // обновляем остаток товара
    const savedProd=await dbUpdate('products',product_id,{stock});
    if(savedProd){const i=(S.products||[]).findIndex(x=>x.id===product_id);if(i>=0)Object.assign(S.products[i],savedProd);}
    if(!S.wh_moves)S.wh_moves=[];S.wh_moves.unshift(savedMove);
    logAction('create','wh_moves',{entity_id:savedMove.id,entity_label:`${t.label}: ${p.name} ×${qty}`});
    toast('Операция проведена');renderCash();return true;
  },{wide:true});
  const opSel=$('wm_op');
  const syncCorrectFields=()=>{
    const isCorrect=opSel.value==='correct';
    $('wm_correctModeWrap').style.display=isCorrect?'':'none';
    $('wm_reasonWrap').style.display=isCorrect?'':'none';
  };
  if(opSel){opSel.onchange=syncCorrectFields;syncCorrectFields();}
}
// модалка резервирования товара под заказ: создание нового резерва + список активных с возможностью отмены
function whReservationModal(productId,city){
  city=city||whCity;
  const p=(S.products||[]).find(x=>x.id===productId);
  if(!p){toast('Товар не найден');return;}
  const active=(S.wh_reservations||[]).filter(r=>r.product_id===productId&&r.city===city&&r.status==='active');
  const fmtWhen=ts=>{if(!ts)return'—';const d=new Date(ts);const q=n=>String(n).padStart(2,'0');return `${q(d.getDate())}.${q(d.getMonth()+1)}.${d.getFullYear()} ${q(d.getHours())}:${q(d.getMinutes())}`;};
  const canCreate=isAdmin()||can('cash','create');
  const body=`
    <div class="hint">Товар: <b>${esc(p.name)}</b> · Город: <b>${esc(city)}</b> · Факт: <b>${productStock(p)}</b> · Уже в резерве: <b>${productReserved(productId,city)}</b> · Доступно: <b>${productAvailable(p,city)}</b></div>
    ${canCreate?`
    <div class="form-grid" style="margin-top:12px">
      <div class="field"><label>Код заказа <span style="color:var(--rust)">*</span></label><input id="wr_order" placeholder="напр. KZ123456789"></div>
      <div class="field"><label>Количество <span style="color:var(--rust)">*</span></label><input type="number" min="1" step="1" id="wr_qty" placeholder="0"></div>
      <div class="field full"><label>Комментарий</label><input id="wr_comment" placeholder="необязательно"></div>
    </div>
    <button type="button" class="btn primary sm" id="wrCreateBtn" style="margin-top:8px">Создать резерв</button>`:'<div class="hint" style="color:var(--rust);margin-top:8px">Нет прав на создание резерва</div>'}
    <h3 class="calc-h" style="margin-top:18px">Активные резервы в «${esc(city)}»</h3>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Заказ</th><th>Кол-во</th><th>Создан</th><th>Автор</th><th></th>
    </tr></thead><tbody id="wrList">
      ${active.length?active.map(r=>`<tr data-wrrow="${r.id}">
        <td>${esc(r.order_code||'—')}</td><td>${r.quantity}</td><td>${fmtWhen(r.created_at)}</td><td>${esc(r.created_by_name||'—')}</td>
        <td>${canCreate?`<button type="button" class="btn sm ghost" data-wrcancel="${r.id}">Отменить</button>`:''}</td>
      </tr>`).join(''):'<tr><td colspan="5"><div class="empty">Нет активных резервов</div></td></tr>'}
    </tbody></table></div>`;
  const ov=showModal('Резерв товара',body,null,{readonly:true,closeLabel:'Закрыть'});
  const refresh=()=>{closeTopModal();whReservationModal(productId,city);};
  const createBtn=ov.querySelector('#wrCreateBtn');
  if(createBtn)createBtn.onclick=async()=>{
    createBtn.disabled=true;
    try{
      const order_code=val('wr_order').trim();
      const qty=parseInt(val('wr_qty'),10)||0;
      if(!order_code){toast('Укажите код заказа');return;}
      if(qty<=0){toast('Введите количество');return;}
      // свежая проверка остатка и суммы резервов прямо перед записью
      const freshP=await dbGetOne('products',productId);
      const factNow=freshP?parseInt((freshP.stock||{})[city]||0,10)||0:productStock(p);
      const freshReserved=(await dbList('wh_reservations',{})).filter(r=>r.product_id===productId&&r.city===city&&r.status==='active').reduce((s,r)=>s+(parseInt(r.quantity,10)||0),0);
      const availNow=factNow-freshReserved;
      if(qty>availNow){toast(`Недостаточно доступного остатка: доступно ${availNow}, нужно ${qty}`);return;}
      const row={product_id:productId,order_code,city,quantity:qty,status:'active',
        created_by:(S.me&&S.me.id)||null,created_by_name:(S.me&&(S.me.full_name||S.me.email))||'—',
        comment:val('wr_comment').trim()||null};
      const saved=await dbInsert('wh_reservations',row);
      if(!saved){toast('Не удалось создать резерв');return;}
      if(!S.wh_reservations)S.wh_reservations=[];S.wh_reservations.unshift(saved);
      logAction('create','wh_reservations',{entity_id:saved.id,entity_label:`Резерв: ${p.name} ×${qty} (заказ ${order_code})`});
      toast('Резерв создан');refresh();
    }finally{createBtn.disabled=false;}
  };
  ov.querySelectorAll('[data-wrcancel]').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    const rid=b.dataset.wrcancel;
    const upd=await dbUpdate('wh_reservations',rid,{status:'cancelled',updated_at:new Date().toISOString()});
    if(!upd){toast('Не удалось отменить резерв');b.disabled=false;return;}
    const r=(S.wh_reservations||[]).find(x=>x.id===rid);if(r)Object.assign(r,upd);
    logAction('update','wh_reservations',{entity_id:rid,entity_label:`Отмена резерва: ${p.name}`});
    toast('Резерв отменён');refresh();
  });
}