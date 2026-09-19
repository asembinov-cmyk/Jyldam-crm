
/* ================= МОДУЛЬ: КАЛЬКУЛЯЦИЯ ================= */
// определения статей расходов калькуляции.
// kind: 'fixed' — фиксированная стоимость за заказ; 'fund' — месячный фонд, делится на заказы месяца
const CALC_FIELDS=[
  {key:'courier',   label:'Курьер (за заказ)',            kind:'fixed', hint:'Стоимость работы курьера'},
  {key:'pack',      label:'Пакет (за заказ)',             kind:'fixed', hint:'Стоимость пакета'},
  {key:'gofra',     label:'Гофра (за заказ)',             kind:'fixed', hint:'Стоимость гофры'},
  {key:'blank',     label:'Бланк (за заказ)',             kind:'fixed', hint:'Печать транспортной наклейки'},
  {key:'sms',       label:'SMS (за заказ)',               kind:'fixed', hint:'Стоимость SMS-уведомлений'},
  {key:'freight',   label:'Доставка груза (за заказ)',    kind:'fixed', hint:'Междугородняя перевозка (курьер по городу — 0)'},
  {key:'admin_courier', label:'ЗП Администратор курьера (за заказ)', kind:'fixed', hint:'Фиксированная ставка за заказ'},
  {key:'fund_logist',  label:'Фонд ЗП Менеджера заказов',   kind:'fund', hint:'Делится на кол-во заказов за месяц'},
  {key:'fund_pickers', label:'Фонд ЗП заборщиков (в месяц)', kind:'fund', hint:'Делится на кол-во заказов за месяц (курьер+почта)'},
  // Расходы компании: считаются ТАК ЖЕ, как фонды — делятся на заказы месяца и вычитаются
  // и у курьерских, и у почтовых заказов. Отдельная группа нужна только для отрисовки:
  // показываем их в своём блоке «Расходы», а не вперемешку с фондами ЗП.
  {key:'fund_smm',   label:'ЗП СММ команде (в месяц)', kind:'fund', group:'expense', hint:'Делится на кол-во заказов за месяц'},
  {key:'fund_other', label:'Иные расходы (в месяц)',   kind:'fund', group:'expense', hint:'Всё, что не вошло в другие статьи'},
];
// сотрудники с окладом (делится на заказы месяца) + ставкой за заказ
const CALC_SALARY_FIELDS=[
  {salaryKey:'salary_processor', perKey:'perorder_processor', label:'Менеджер обработчик'},
];
// ПОЧТОВЫЕ фиксированные расходы (за заказ) — применяются к заказам с типом доставки «почта»
const CALC_POST_FIELDS=[
  {key:'post_pack',   label:'Пакет (за заказ)',          hint:'Упаковка для почтового заказа'},
  {key:'post_gofra',  label:'Гофра (за заказ)',          hint:'Гофра для почтового заказа'},
  {key:'post_blank',  label:'Бланк (за заказ)',          hint:'Печать наклейки'},
  {key:'post_sms',    label:'SMS (за заказ)',            hint:'SMS-уведомления'},
  {key:'post_freight',label:'Доставка почтой (за заказ)',hint:'Стоимость отправки почтой'},
];
// настройки калькуляции для периода: сначала ищем строку месяца, иначе дефолтную (без периода)
function calcSettingsFor(period){
  const all=S.calcSettingsAll||[];
  if(period){
    const exact=all.find(r=>r.period===period);
    if(exact)return exact;
    // записи за этот месяц ещё нет — нормативы должны автоматически переноситься из месяца в месяц,
    // пока их явно не изменят и не сохранят, поэтому берём последнюю по времени запись СТРОГО ДО этого месяца
    const prior=all.filter(r=>r.period&&r.period<period).sort((a,b)=>b.period.localeCompare(a.period))[0];
    if(prior)return prior;
  }
  // дефолт: строка без периода, иначе первая
  return all.find(r=>!r.period)||all[0]||{};
}
// текущие настройки для выбранного в интерфейсе периода нормативов
function calcCurrentSettings(){return calcSettingsFor(calcPeriodStr());}
// значение норматива из настроек периода (или 0). admin_courier по умолчанию 120.
// period — YYYY-MM месяца заказа; если не передан, берём выбранный в интерфейсе период нормативов.
function calcNorm(key,period){const cs=calcSettingsFor(period||calcPeriodStr());const v=cs[key];
  if(v!=null&&v!=='')return parseFloat(v);
  if(key==='admin_courier')return 120; // дефолт ЗП администратора курьера
  return 0;}
function calcMinProfit(period){const cs=calcSettingsFor(period||calcPeriodStr());return cs.min_profit!=null&&cs.min_profit!==''?parseFloat(cs.min_profit):0;}
// городской норматив (курьер/межгород) по id города и периоду; фолбэк: период→дефолт→общий
function calcCityNorm(cityId,key,period){
  const all=S.calcCityNorms||[];
  let row=period?all.find(r=>r.city_id===cityId&&r.period===period):null;
  if(!row&&period)row=all.filter(r=>r.city_id===cityId&&r.period&&r.period<period).sort((a,b)=>b.period.localeCompare(a.period))[0];
  if(!row)row=all.find(r=>r.city_id===cityId&&!r.period)||all.find(r=>r.city_id===cityId);
  if(row&&row[key]!=null&&row[key]!=='')return parseFloat(row[key]);
  return calcNorm(key,period); // запасной — общий норматив периода
}
// персональная ставка заборщика по id и периоду
function calcCourierPay(courierId,period){
  if(!courierId)return 0;
  const all=S.calcCourierNorms||[];
  let row=period?all.find(r=>r.courier_id===courierId&&r.period===period):null;
  if(!row&&period)row=all.filter(r=>r.courier_id===courierId&&r.period&&r.period<period).sort((a,b)=>b.period.localeCompare(a.period))[0];
  if(!row)row=all.find(r=>r.courier_id===courierId&&!r.period)||all.find(r=>r.courier_id===courierId);
  return row&&row.pay!=null&&row.pay!==''?parseFloat(row.pay):0;
}
// ставка менеджера продаж (оклад/за заказ) по id и периоду
function calcSalesNorm(salesId,key,period){
  if(!salesId)return 0;
  const all=S.calcSalesNorms||[];
  let row=period?all.find(r=>r.sales_id===salesId&&r.period===period):null;
  if(!row&&period)row=all.filter(r=>r.sales_id===salesId&&r.period&&r.period<period).sort((a,b)=>b.period.localeCompare(a.period))[0];
  if(!row)row=all.find(r=>r.sales_id===salesId&&!r.period)||all.find(r=>r.sales_id===salesId);
  return row&&row[key]!=null&&row[key]!==''?parseFloat(row[key]):0;
}
// сумма окладов всех менеджеров продаж за период (общий котёл)
function calcSalesTotalSalary(period){
  const ids=new Set((S.sales||[]).map(s=>s.id));
  let sum=0;
  ids.forEach(id=>{sum+=calcSalesNorm(id,'salary',period);});
  return sum;
}
// заборщик заказа: через заявку, из которой создан заказ (pickup.courier_id)
function orderPickerCourier(o){
  if(!o.pickup_id)return null;
  const pk=(S.pickups||[]).find(p=>p.id===o.pickup_id);
  return pk?pk.courier_id:null;
}
// финансовая раскладка курьерского заказа: все статьи расходов + остаток
function orderCourierFinance(o){
  const P=orderPeriodStr(o); // период (YYYY-MM) месяца забора заказа
  const revenue=(o.order_sum!=null&&o.order_sum!=='')?parseFloat(o.order_sum)||0:0;
  const cityId=o.courier_city_id||orderCalcCity(o);
  const monthOrders=ordersInOrderMonth(o); // кол-во заказов за месяц (для деления окладов/фондов)
  // межгород — из отправки (intercity_cost), иначе 0
  const intercity=(o.intercity_cost!=null&&o.intercity_cost!=='')?parseFloat(o.intercity_cost)||0:0;
  const courierPay=calcCityNorm(o.courier_city_id||cityId,'courier',P); // оплата курьеру города
  const pickerId=orderPickerCourier(o);
  const pickerPay=calcCourierPay(pickerId,P); // оплата заборщику (персонально)
  const blank=calcNorm('blank',P);
  const pack=calcNorm('pack',P);
  const adminCourier=calcNorm('admin_courier',P); // фикс 120 по умолчанию
  // ОБЩИЙ ОКЛАД = сумма окладов менеджеров продаж (все трое) + оклад обработчика + фонд логиста, ÷ все заказы месяца
  const totalSalary=calcSalesTotalSalary(P)+calcNorm('salary_processor',P)+calcNorm('fund_logist',P);
  const commonSalary=Math.round((totalSalary/monthOrders)*100)/100;
  // менеджер по продажам: персональная ставка за заказ того менеджера, что указан в заказе
  const manager=o.sales_id?calcSalesNorm(o.sales_id,'per_order',P):0;
  // менеджер обработчик: ставка за заказ (80), на все заказы
  const processor=calcNorm('perorder_processor',P);
  const totalCost=intercity+courierPay+pickerPay+blank+pack+adminCourier+commonSalary+manager+processor;
  const remainder=revenue-totalCost;
  return {revenue,intercity,courierPay,pickerId,pickerPay,blank,pack,adminCourier,commonSalary,
    manager,processor,monthOrders,totalCost,remainder,period:P};
}
// город забора заказа (pickup_city_id, иначе город партнёра)
function orderCalcCity(o){
  if(o.pickup_city_id)return o.pickup_city_id;
  if(o.partner_id){const p=(S.partners||[]).find(x=>x.id===o.partner_id);if(p&&p.city_id)return p.city_id;}
  return null;
}
// кол-во заказов за месяц даты забора заказа (для деления фондов)
// кэш количества заказов по месяцам (сбрасывается при изменении S.orders)
let _monthCountCache=null,_monthCountLen=-1;
function ordersInOrderMonth(o){
  const d=(o.pickup_date||o.created_at||'').slice(0,7); // YYYY-MM
  if(!d)return 1;
  // строим кэш один раз за проход, а не перебираем все заказы для каждого
  if(!_monthCountCache||_monthCountLen!==(S.orders||[]).length){
    _monthCountCache={};_monthCountLen=(S.orders||[]).length;
    (S.orders||[]).forEach(x=>{const m=(x.pickup_date||x.created_at||'').slice(0,7);if(m)_monthCountCache[m]=(_monthCountCache[m]||0)+1;});
  }
  return _monthCountCache[d]||1;
}
// ПОЛНЫЙ РАСЧЁТ калькуляции заказа: выручка, статьи расходов, прибыль, маржа, ROI.
// Если у заказа есть сохранённый снимок calc — используем его статьи (старые заказы не пересчитываются нормативами).
function calcOrder(o){
  const P=orderPeriodStr(o); // период месяца заказа
  const cityId=orderCalcCity(o);
  const snap=(o.calc&&typeof o.calc==='object')?o.calc:null;
  // выручка = сумма заказа. Если включено «Оплачено отправителем» (order_sum принудительно 0,
  // потому что партнёр платит за доставку сам, напрямую, минуя систему) — берём вместо этого ту
  // сумму, которая была бы обычной ценой заказа (она сохраняется в order_sum_orig в момент
  // включения галочки) — иначе такие заказы выглядели бы чистым убытком, хотя по факту денег
  // партнёр платит ровно столько же, просто не через сумму заказа в CRM.
  const isPaidBySender=!!o.paid_by_sender;
  const notionalRevenue=isPaidBySender&&o.order_sum_orig!=null&&o.order_sum_orig!==''?(parseFloat(o.order_sum_orig)||0):0;
  const revenue=isPaidBySender
    ? notionalRevenue
    : ((o.order_sum!=null&&o.order_sum!=='')?parseFloat(o.order_sum)||0:0);
  const monthOrders=ordersInOrderMonth(o);
  // тип доставки: курьерская или почтовая
  const isCourierType=isCourierDelivery(o.delivery_id);
  let items;
  if(isCourierType){
    // КУРЬЕРСКИЙ заказ — статьи из CALC_FIELDS (курьер/межгород по городу)
    items=CALC_FIELDS.map(f=>{
      let amount;
      if(snap&&snap.items&&snap.items[f.key]!=null)amount=parseFloat(snap.items[f.key])||0;
      else if(f.kind==='fund')amount=Math.round((calcNorm(f.key,P)/monthOrders)*100)/100;
      else if(f.key==='freight'){
        amount=(o.intercity_cost!=null&&o.intercity_cost!=='')?parseFloat(o.intercity_cost)||0:0; // только реальная стоимость из «Отправок межгород» — не привязан к отправке, не считаем эту статью вообще
      }
      else if(f.key==='courier')amount=calcCityNorm(cityId,f.key,P);
      else amount=calcNorm(f.key,P);
      return {key:f.key,label:f.label,amount};
    });
  }else{
    // ПОЧТОВЫЙ заказ — почтовые фиксированные статьи + распределяемые фонды (общие)
    const postItems=CALC_POST_FIELDS.map(f=>{
      let amount;
      if(snap&&snap.items&&snap.items[f.key]!=null)amount=parseFloat(snap.items[f.key])||0;
      else amount=calcNorm(f.key,P);
      return {key:f.key,label:f.label,amount};
    });
    const fundItems=CALC_FIELDS.filter(f=>f.kind==='fund').map(f=>{
      let amount;
      if(snap&&snap.items&&snap.items[f.key]!=null)amount=parseFloat(snap.items[f.key])||0;
      else amount=Math.round((calcNorm(f.key,P)/monthOrders)*100)/100;
      return {key:f.key,label:f.label,amount};
    });
    items=postItems.concat(fundItems);
  }
  // статьи «оклад + за заказ»: обработчик (общий) + менеджер продаж (персональный)
  CALC_SALARY_FIELDS.forEach(f=>{
    const salary=Math.round((calcNorm(f.salaryKey,P)/monthOrders)*100)/100;
    const per=calcNorm(f.perKey,P);
    items.push({key:f.salaryKey,label:f.label,amount:salary+per});
  });
  // менеджер продаж: оклады всех в котёл ÷ заказы месяца + персональная ставка за заказ
  const P2=orderPeriodStr(o);
  const salesCommon=Math.round((calcSalesTotalSalary(P2)/monthOrders)*100)/100;
  const salesPer=o.sales_id?calcSalesNorm(o.sales_id,'per_order',P2):0;
  items.push({key:'sales_manager',label:'Менеджер по продажам',amount:salesCommon+salesPer});
  const totalCost=items.reduce((s,it)=>s+(it.amount||0),0);
  const profit=revenue-totalCost;
  const margin=revenue>0?(profit/revenue*100):0;
  const roi=totalCost>0?(profit/totalCost*100):0;
  return {revenue,items,totalCost,profit,margin,roi,cityId,monthOrders,isCourierType,period:P2,isPaidBySender,notionalRevenue};
}
// цвет индикации прибыли: red/yellow/green
function calcProfitColor(profit,period){
  if(profit<0)return 'red';
  if(profit<calcMinProfit(period))return 'yellow';
  return 'green';
}

let calcSub='norms'; // подвкладка раздела Калькуляция: norms | summary | partner
// состояние вкладки «Расчёт партнёра» — отдельная логика, свой отдельный список партнёров
// (S.calc_partners), НЕ связанный с обычными партнёрами CRM (S.partners)
let calcPartnerId=''; // выбранный партнёр (из S.calc_partners)
let calcPartnerWeights=null; // веса заказов из загруженного файла (массив чисел, кг)
let calcPartnerFileName='';
let calcPartnerFileError='';
let calcPartnerFileMeta=null; // {rows,headerRow,weightCol,autoDetected,usedHeaderName,avgWeight,maxWeight,sample} — для проверки и ручного выбора столбца
const CALC_PARTNER_BASE_WEIGHT=2; // базовый вес в кг — фиксированный, одинаковый для всех партнёров
let _calcGlobalPerKg=null; // надбавка партнёру за доп. кг — общая для всех, из базы
// выбранный период нормативов (год-месяц). По умолчанию текущий.
let calcNormPeriod={year:new Date().getFullYear(),month:new Date().getMonth()};
function calcPeriodStr(p){p=p||calcNormPeriod;return `${p.year}-${String(p.month+1).padStart(2,'0')}`;}
// период месяца заказа (по дате забора) в формате YYYY-MM
function orderPeriodStr(o){return (o.pickup_date||o.created_at||'').slice(0,7);}
function renderCalc(){
  if(!canMod('calc')){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа</div></div>';return;}
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Калькуляция</h1><p>Себестоимость, прибыль и заработок по заказам</p></div></div>
    <div class="subtabs">
      <button data-calcsub="norms" class="${calcSub==='norms'?'active':''}">Расходы компании</button>
      <button data-calcsub="summary" class="${calcSub==='summary'?'active':''}">Общая сводка</button>
      <button data-calcsub="partner" class="${calcSub==='partner'?'active':''}">Расчёт партнёра</button>
    </div>
    <div id="calcContent"></div>`;
  $('main').querySelectorAll('[data-calcsub]').forEach(b=>b.onclick=()=>{calcSub=b.dataset.calcsub;renderCalc();});
  // вкладок нормативов было две — курьерская и почтовая, но состав у них одинаковый,
  // поэтому осталась одна. Старые значения принимаем на случай, если calcSub где-то
  // выставят прежним именем.
  if(calcSub==='norms'||calcSub==='courier'||calcSub==='mail')renderCalcNorms();
  else if(calcSub==='partner')renderCalcPartner();
  else renderCalcSummary();
}

// ==================== РАСЧЁТ ПАРТНЁРА — отдельная логика ====================
// Модель: у каждого партнёра своя базовая цена за первые 2 кг (calc_base_price) и своя доля
// «наше» с этой базовой цены (calc_base_margin) + своя доля «наше» с каждого доп. кг сверху
// (calc_per_kg_margin). А вот сама надбавка партнёру за каждый доп. кг — ОДНА на всех
// (глобальная настройка, хранится в calc_global_settings). Вес каждого заказа округляется
// вверх до целого кг перед расчётом (2.3 кг → 3 кг).
async function loadCalcGlobalPerKg(){
  try{
    const {data}=await sb.from('calc_global_settings').select('per_kg_charge').eq('id','default').maybeSingle();
    _calcGlobalPerKg=data&&data.per_kg_charge!=null?parseFloat(data.per_kg_charge):70;
  }catch(e){_calcGlobalPerKg=70;}
}
async function saveCalcGlobalPerKg(val){
  const v=parseFloat(val)||0;
  try{
    await sb.from('calc_global_settings').upsert({id:'default',per_kg_charge:v});
    _calcGlobalPerKg=v;
    return true;
  }catch(e){toast('Не удалось сохранить');return false;}
}
// считает по одному заказу: сколько кг после округления, сколько сверх базы, сколько партнёру
// платить и сколько из этого — наше
function calcPartnerOrderCharge(weight,partner,perKgCharge){
  const totalKg=Math.max(1,Math.ceil(parseFloat(weight)||0));
  const extraKg=Math.max(0,totalKg-CALC_PARTNER_BASE_WEIGHT);
  const charge=(parseFloat(partner.base_price)||0)+extraKg*(perKgCharge||0);
  const margin=(parseFloat(partner.base_margin)||0)+extraKg*(parseFloat(partner.per_kg_margin)||0);
  return {totalKg,extraKg,charge,margin};
}
// читает файл (xlsx/csv/xls) — ищет столбец с весом по названию заголовка (вес/kg/weight),
// если не нашли по названию — берёт столбец, где большинство значений похожи на числа В
// РАЗУМНЫХ ДЛЯ ВЕСА ГРАНИЦАХ (0.05–200 кг) — чтобы случайно не схватить № заказа/телефон/сумму.
// Возвращает не только сами веса, но и что было определено — чтобы это можно было проверить
// глазами и выбрать другой столбец вручную, если автоопределение ошиблось.
function calcPartnerParseFile(file,cb){
  if(!window.XLSX){cb(null,'Библиотека для чтения файлов ещё загружается, попробуйте снова через пару секунд');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const wb=XLSX.read(e.target.result,{type:'binary'});
      const sheet=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''});
      if(!rows.length){cb(null,'Файл пустой');return;}
      // ищем строку с заголовками в первых 5 строках файла — не только в самой первой (часто
      // выше настоящей таблицы стоит строка-название вроде «Всего РПО»)
      let headerRowIdx=-1,weightCol=-1;
      for(let r=0;r<Math.min(5,rows.length);r++){
        const cells=(rows[r]||[]).map(h=>String(h||'').toLowerCase().trim());
        const idx=cells.findIndex(h=>/вес|weight|\bkg\b|кг/i.test(h));
        if(idx>=0){headerRowIdx=r;weightCol=idx;break;}
      }
      const headerRow=headerRowIdx>=0?(rows[headerRowIdx]||[]).map(h=>String(h||'').trim()):(rows[0]||[]).map(h=>String(h||'').trim());
      let startRow=headerRowIdx>=0?headerRowIdx+1:1;
      let autoDetected=weightCol>=0;
      if(weightCol<0){
        // явного заголовка «Вес» нет — ищем столбец, где большинство значений похожи на ВЕС
        // (число в разумных границах 0.05–200 кг). Среди подходящих отдаём предпочтение
        // столбцу с ДРОБНЫМИ значениями (2.436, 1.874…) — вес обычно дробный, а строго
        // последовательные целые (1, 2, 3, 4…) — это почти наверняка № по порядку, не вес.
        const width=Math.max(...rows.slice(0,50).map(r=>r.length));
        let best=-1,bestScore=-1;
        for(let c=0;c<width;c++){
          const vals=rows.slice(0,50).map(r=>r[c]);
          const nums=vals.map(v=>{
            if(v===''||v==null)return null;
            const n=parseFloat(String(v).replace(',','.'));
            return isNaN(n)?null:n;
          }).filter(n=>n!=null);
          const plausible=nums.filter(n=>n>=0.05&&n<=200).length;
          if(plausible<1)continue;
          const hasDecimals=nums.some(n=>n%1!==0);
          // похоже на строго последовательный номер по порядку (1,2,3,4…) — почти наверняка не вес
          const looksSequential=nums.length>3&&nums.every((n,i)=>i===0||n===nums[i-1]+1);
          let score=plausible;
          if(hasDecimals)score+=1000; // сильный приоритет столбцу с дробными значениями
          if(looksSequential)score-=1000; // и сильный штраф явному порядковому номеру
          if(score>bestScore){bestScore=score;best=c;}
        }
        if(best<0||bestScore<1){cb(null,'Не удалось найти столбец с весом — добавьте в файл заголовок «Вес» над нужной колонкой',null);return;}
        weightCol=best;
        headerRow[weightCol]=headerRow[weightCol]||'';
        // начало данных — первая строка, где в этом столбце реально стоит число (сколько бы
        // строк-заголовков/названий ни было выше)
        const firstNumRow=rows.findIndex(r=>r[weightCol]!==''&&r[weightCol]!=null&&!isNaN(parseFloat(String(r[weightCol]).replace(',','.'))));
        startRow=firstNumRow>=0?firstNumRow:1;
      }
      const weights=[];
      for(let i=startRow;i<rows.length;i++){
        const raw=rows[i][weightCol];
        if(raw===''||raw==null)continue;
        const w=parseFloat(String(raw).replace(',','.'));
        if(!isNaN(w)&&w>0)weights.push(w);
      }
      if(!weights.length){cb(null,'В файле не нашлось ни одной строки с весом больше 0',null);return;}
      const meta={
        rows,headerRow,weightCol,autoDetected,
        usedHeaderName:autoDetected?headerRow[weightCol]:null,
        avgWeight:weights.reduce((s,w)=>s+w,0)/weights.length,
        maxWeight:Math.max(...weights),
        sample:weights.slice(0,5),
      };
      cb(weights,null,meta);
    }catch(err){cb(null,'Не удалось прочитать файл: '+err.message,null);}
  };
  reader.onerror=()=>cb(null,'Не удалось прочитать файл',null);
  reader.readAsBinaryString(file);
}
// пересчитать веса из уже прочитанного файла, но по вручную выбранному столбцу (без повторного
// чтения самого файла) — используется, когда автоопределение ошиблось
function calcPartnerWeightsFromCol(meta,col){
  const weights=[];
  // находим первую строку, где в ЭТОМ столбце реально стоит число — это и есть начало данных
  // (сколько бы строк-заголовков/названий ни было выше)
  let startRow=meta.rows.findIndex(r=>r[col]!==''&&r[col]!=null&&!isNaN(parseFloat(String(r[col]).replace(',','.'))));
  if(startRow<0)startRow=0;
  for(let i=startRow;i<meta.rows.length;i++){
    const raw=meta.rows[i][col];
    if(raw===''||raw==null)continue;
    const w=parseFloat(String(raw).replace(',','.'));
    if(!isNaN(w)&&w>0)weights.push(w);
  }
  return weights;
}
async function renderCalcPartner(){
  if(_calcGlobalPerKg==null)await loadCalcGlobalPerKg();
  let calcPartnersLoadError='';
  if(!S.calc_partners){
    $('calcContent').innerHTML='<div class="empty"><div class="big">Загрузка…</div></div>';
    try{S.calc_partners=await dbList('calc_partners',{order:'name'});}
    catch(e){S.calc_partners=[];calcPartnersLoadError='Не удалось загрузить список партнёров — скорее всего, таблица calc_partners ещё не создана в базе. Выполните add_calc_partners_table.sql в Supabase.';}
  }
  if(calcPartnersLoadError){
    $('calcContent').innerHTML=`<div class="empty"><div class="big">Таблица не найдена</div>${esc(calcPartnersLoadError)}</div>`;
    return;
  }
  const partner=calcPartnerId?(S.calc_partners||[]).find(p=>p.id===calcPartnerId):null;
  const partnersSorted=[...(S.calc_partners||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  // сам расчёт — если партнёр выбран и файл загружен
  let breakdown=[],totalOrders=0,totalCharge=0,totalMargin=0;
  if(partner&&calcPartnerWeights&&calcPartnerWeights.length){
    const byKg={};
    calcPartnerWeights.forEach(w=>{
      const r=calcPartnerOrderCharge(w,partner,_calcGlobalPerKg);
      if(!byKg[r.totalKg])byKg[r.totalKg]={kg:r.totalKg,count:0,charge:0,margin:0};
      byKg[r.totalKg].count++;byKg[r.totalKg].charge+=r.charge;byKg[r.totalKg].margin+=r.margin;
      totalOrders++;totalCharge+=r.charge;totalMargin+=r.margin;
    });
    breakdown=Object.values(byKg).sort((a,b)=>a.kg-b.kg);
  }
  $('calcContent').innerHTML=`
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Партнёр для расчёта</h3>
      <p class="calc-note">Свой отдельный список — не связан с партнёрами из «Заказов заборов». Надбавка за доп. кг ниже — общая для всех; база и доли «наше» — свои у каждого партнёра из этого списка.</p>
      <div class="form-grid">
        <div class="field"><label>Партнёр</label><select id="cpPartner">
          <option value="">— выберите партнёра —</option>
          ${partnersSorted.map(p=>`<option value="${p.id}" ${calcPartnerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
        </select></div>
        <div class="field"><label>Надбавка партнёру за доп. кг сверх ${CALC_PARTNER_BASE_WEIGHT} кг (₸)</label>
          <input type="number" min="0" id="cpPerKg" value="${_calcGlobalPerKg}">
          <small style="color:var(--muted);font-size:12px">Одна на все — сохраняется сразу для всех расчётов, не только для этого партнёра</small></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn ghost sm" id="cpAddPartner">＋ Новый партнёр</button>
        ${partner?'<button class="btn ghost sm" id="cpEditPartner">✎ Изменить</button><button class="btn danger sm" id="cpDelPartner">🗑 Удалить</button>':''}
      </div>
      ${partner?`<div class="hint" style="margin-top:10px">
        База (то, что партнёр платит нам за первые ${CALC_PARTNER_BASE_WEIGHT} кг): <b>${fmtMoney(partner.base_price)}</b> · наше с базы: <b>${fmtMoney(partner.base_margin)}</b> ·
        наше с каждого доп. кг: <b>${fmtMoney(partner.per_kg_margin)}</b>
      </div>`:''}
    </div>
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Файл с заказами</h3>
      <p class="calc-note">Excel/CSV с одной строкой на заказ — нужен хотя бы один столбец с весом в кг (в идеале с заголовком «Вес»).</p>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <input type="file" id="cpFile" accept=".xlsx,.xls,.csv">
        <span class="hint" style="font-size:12px">(можно выбрать файл заранее, партнёр нужен только для самого расчёта)</span>
        ${calcPartnerFileName?`<span class="wh-cat">${esc(calcPartnerFileName)} — ${calcPartnerWeights?calcPartnerWeights.length+' заказов':''}</span>`:''}
      </div>
      ${!partner?'<div class="hint" style="margin-top:8px;color:var(--rust)">Сначала выберите или добавьте партнёра</div>':''}
      ${calcPartnerFileError?`<div class="hint" style="margin-top:8px;color:var(--rust)">${esc(calcPartnerFileError)}</div>`:''}
      ${calcPartnerFileMeta?`<div class="hint" style="margin-top:10px;padding:10px;background:#f5f5f7;border-radius:8px">
        <b>Столбец с весом:</b> ${calcPartnerFileMeta.autoDetected?`«${esc(calcPartnerFileMeta.usedHeaderName)}» (найден по заголовку)`:`столбец №${calcPartnerFileMeta.weightCol+1} — заголовка «Вес» не нашлось, определён по числам`}
        · средний вес: <b>${calcPartnerFileMeta.avgWeight.toFixed(2)} кг</b>, макс: <b>${calcPartnerFileMeta.maxWeight} кг</b>
        · первые значения: ${calcPartnerFileMeta.sample.join(', ')} кг
        <div style="margin-top:8px">
          <label style="font-size:12px;color:var(--muted)">Если столбец определён неверно — выберите нужный вручную:</label>
          <select id="cpWeightColOverride" style="margin-left:8px">
            ${calcPartnerFileMeta.headerRow.map((h,i)=>`<option value="${i}" ${i===calcPartnerFileMeta.weightCol?'selected':''}>${esc(h||('Столбец '+(i+1)))}</option>`).join('')}
          </select>
        </div>
      </div>`:''}
    </div>
    ${(calcPartnerFileMeta&&calcPartnerFileMeta.avgWeight>50)?`<div class="panel calc-panel" style="margin-bottom:18px;border-color:var(--rust)">
      <p class="calc-note" style="color:var(--rust)">⚠️ Средний вес получился ${calcPartnerFileMeta.avgWeight.toFixed(0)} кг — это очень много для обычных посылок. Похоже, распознан не тот столбец (например, номер заказа или сумма вместо веса). Проверьте выбор столбца выше.</p>
    </div>`:''}
    ${breakdown.length?`
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Итог по ${esc(partner.name)}</h3>
      <div class="stats stats-4" style="margin-top:10px">
        <div class="stat"><div class="k">Заказов</div><div class="v">${totalOrders}</div></div>
        <div class="stat"><div class="k">К оплате партнёром</div><div class="v">${fmtMoney(totalCharge)}</div></div>
        <div class="stat"><div class="k">Наша прибыль</div><div class="v" style="color:#2e7d32">${fmtMoney(totalMargin)}</div></div>
        <div class="stat"><div class="k">В среднем на заказ</div><div class="v">${fmtMoney(totalOrders?totalMargin/totalOrders:0)}</div></div>
      </div>
    </div>
    <div class="panel calc-panel">
      <h3 class="calc-h">Разбивка по весу</h3>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Вес (округлённо)</th><th>Заказов</th><th>К оплате партнёром</th><th>Наша прибыль</th></tr></thead>
        <tbody>${breakdown.map(r=>`<tr><td>${r.kg} кг</td><td>${r.count}</td><td>${fmtMoney(r.charge)}</td><td style="color:#2e7d32">${fmtMoney(r.margin)}</td></tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td><b>Итого</b></td><td><b>${totalOrders}</b></td><td><b>${fmtMoney(totalCharge)}</b></td><td><b style="color:#2e7d32">${fmtMoney(totalMargin)}</b></td></tr>
        </tbody></table></div>
      <div style="margin-top:12px"><button class="btn btn-excel sm" id="cpExport">⬇ Выгрузить в Excel</button></div>
    </div>`:''}`;
  if($('cpPartner'))$('cpPartner').onchange=e=>{calcPartnerId=e.target.value;renderCalcPartner();};
  if($('cpPerKg'))$('cpPerKg').onchange=async e=>{
    const ok2=await saveCalcGlobalPerKg(e.target.value);
    if(ok2)toast('Сохранено');
    renderCalcPartner();
  };
  if($('cpAddPartner'))$('cpAddPartner').onclick=()=>calcPartnerModal();
  if($('cpEditPartner'))$('cpEditPartner').onclick=()=>calcPartnerModal(calcPartnerId);
  if($('cpDelPartner'))$('cpDelPartner').onclick=async()=>{
    if(!confirm(`Удалить партнёра «${partner.name}» из списка расчёта?`))return;
    const okDel=await dbDelete('calc_partners',calcPartnerId);
    if(!okDel){toast('Не удалось удалить');return;}
    S.calc_partners=(S.calc_partners||[]).filter(p=>p.id!==calcPartnerId);
    calcPartnerId='';calcPartnerWeights=null;calcPartnerFileName='';calcPartnerFileMeta=null;
    toast('Удалено');renderCalcPartner();
  };
  if($('cpFile'))$('cpFile').onchange=e=>{
    const file=e.target.files&&e.target.files[0];if(!file)return;
    calcPartnerFileError='';calcPartnerFileMeta=null;
    calcPartnerParseFile(file,(weights,error,meta)=>{
      if(error){calcPartnerFileError=error;calcPartnerWeights=null;calcPartnerFileName='';calcPartnerFileMeta=null;}
      else{calcPartnerWeights=weights;calcPartnerFileName=file.name;calcPartnerFileMeta=meta;}
      renderCalcPartner();
    });
  };
  if($('cpWeightColOverride'))$('cpWeightColOverride').onchange=e=>{
    const col=parseInt(e.target.value,10);
    const newWeights=calcPartnerWeightsFromCol(calcPartnerFileMeta,col);
    if(!newWeights.length){toast('В этом столбце не нашлось весов больше 0');return;}
    calcPartnerWeights=newWeights;
    calcPartnerFileMeta={
      ...calcPartnerFileMeta,weightCol:col,autoDetected:true,
      usedHeaderName:calcPartnerFileMeta.headerRow[col]||('Столбец '+(col+1)),
      avgWeight:newWeights.reduce((s,w)=>s+w,0)/newWeights.length,
      maxWeight:Math.max(...newWeights),
      sample:newWeights.slice(0,5),
    };
    renderCalcPartner();
  };
  if($('cpExport'))$('cpExport').onclick=()=>{
    if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
    const data=breakdown.map(r=>({'Вес (кг)':r.kg,'Заказов':r.count,'К оплате партнёром':Math.round(r.charge),'Наша прибыль':Math.round(r.margin)}));
    data.push({'Вес (кг)':'Итого','Заказов':totalOrders,'К оплате партнёром':Math.round(totalCharge),'Наша прибыль':Math.round(totalMargin)});
    const ws=XLSX.utils.json_to_sheet(data);
    ws['!cols']=[{wch:14},{wch:12},{wch:20},{wch:16}];
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'Расчёт');
    XLSX.writeFile(wb,`Расчёт_${(partner.name||'партнёр').replace(/[^\wа-яА-ЯёЁ]+/g,'_')}_${localToday()}.xlsx`);
  };
}
// форма партнёра ИМЕННО для «Расчёта партнёра» — свой отдельный список (calc_partners),
// никак не связанный с обычными партнёрами CRM
function calcPartnerModal(id){
  const p=id?(S.calc_partners||[]).find(x=>x.id===id):{name:'',base_price:'',base_margin:'',per_kg_margin:''};
  showModal(id?'Партнёр (расчёт)':'Новый партнёр (расчёт)',`
    <div class="field"><label>Название</label><input id="cpm_name" value="${esc(p.name)}" placeholder="например Казпочта"></div>
    <div class="field"><label>База — сколько партнёр платит нам за первые ${CALC_PARTNER_BASE_WEIGHT} кг (₸)</label><input type="number" min="0" id="cpm_base" value="${esc(p.base_price)}" placeholder="например 1030"></div>
    <div class="field"><label>Наше с базы (₸)</label><input type="number" min="0" id="cpm_base_margin" value="${esc(p.base_margin)}" placeholder="например 30"></div>
    <div class="field"><label>Наше с каждого доп. кг сверх базы (₸)</label><input type="number" min="0" id="cpm_perkg_margin" value="${esc(p.per_kg_margin)}" placeholder="например 10"></div>
  `,async()=>{
    const name=val('cpm_name').trim();if(!name){toast('Укажите название');return false;}
    const row={
      name,
      base_price:val('cpm_base')!==''?parseFloat(val('cpm_base')):null,
      base_margin:val('cpm_base_margin')!==''?parseFloat(val('cpm_base_margin')):null,
      per_kg_margin:val('cpm_perkg_margin')!==''?parseFloat(val('cpm_perkg_margin')):null,
    };
    if(id){
      const u=await dbUpdate('calc_partners',id,row);if(!u)return false;
      Object.assign((S.calc_partners||[]).find(x=>x.id===id),u);
    }else{
      const u=await dbInsert('calc_partners',row);if(!u)return false;
      if(!S.calc_partners)S.calc_partners=[];S.calc_partners.push(u);
      calcPartnerId=u.id;
    }
    toast('Сохранено');renderCalcPartner();return true;
  });
}
function renderCalcNorms(){
  const P=calcPeriodStr();
  const cs=calcCurrentSettings();
  const monthsRU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const fixedFields=CALC_FIELDS.filter(f=>f.kind==='fixed'&&f.key!=='freight'); // «Доставка груза» больше не редактируется тут — сумма тянется из «Отправок межгород»
  const fundFields=CALC_FIELDS.filter(f=>f.kind==='fund'&&f.group!=='expense');
  const expenseFields=CALC_FIELDS.filter(f=>f.group==='expense');
  const fieldRow=f=>`<div class="calc-norm-row">
    <div class="cn-label">${esc(f.label)}<span class="cn-hint">${esc(f.hint)}</span></div>
    <div class="cn-input"><input type="number" min="0" step="0.01" data-calcnorm="${f.key}" value="${cs[f.key]!=null&&cs[f.key]!==''?esc(cs[f.key]):''}" placeholder="0"> ₸</div>
  </div>`;
  const cities=(S.cities||[]);
  const cityNorm=(cid,key)=>{const all=S.calcCityNorms||[];let r=all.find(x=>x.city_id===cid&&x.period===P)||all.find(x=>x.city_id===cid&&!x.period);return r&&r[key]!=null&&r[key]!==''?r[key]:'';};
  const periodBar=`<div class="calc-period-bar"><span>Нормативы за:</span>
    <select id="calcNormMonth">${monthsRU.map((m,i)=>`<option value="${i}" ${calcNormPeriod.month===i?'selected':''}>${m}</option>`).join('')}</select>
    <select id="calcNormYear">${(()=>{const ny=new Date().getFullYear();let o='';for(let y=2025;y<=ny+1;y++)o+=`<option value="${y}" ${calcNormPeriod.year===y?'selected':''}>${y}</option>`;return o;})()}</select></div>`;
  // общий блок: фонды + сотрудники + менеджеры + контроль прибыли (нужен на обеих вкладках)
  const fundsBlock=`
      <div class="panel calc-panel">
        <h3 class="calc-h">Распределяемые фонды (в месяц)</h3>
        <p class="calc-note">Делятся на количество заказов за месяц. Чем больше заказов — тем меньше на каждый.</p>
        ${fundFields.map(fieldRow).join('')}
        <h3 class="calc-h" style="margin-top:18px">Сотрудники: оклад + за заказ</h3>
        <p class="calc-note">Оклад делится на все заказы за месяц. «За заказ»: менеджер продаж (150₸) — заказам с указанным менеджером; обработчик (80₸) — на каждый.</p>
        <div class="calc-city-head" style="grid-template-columns:1fr 110px 110px"><span>Сотрудник</span><span>Оклад/мес</span><span>За заказ</span></div>
        ${CALC_SALARY_FIELDS.map(f=>`<div class="calc-city-row" style="grid-template-columns:1fr 110px 110px">
          <span class="ccr-name">${esc(f.label)}</span>
          <input type="number" min="0" step="0.01" data-calcnorm="${f.salaryKey}" value="${cs[f.salaryKey]!=null&&cs[f.salaryKey]!==''?esc(cs[f.salaryKey]):''}" placeholder="0">
          <input type="number" min="0" step="0.01" data-calcnorm="${f.perKey}" value="${cs[f.perKey]!=null&&cs[f.perKey]!==''?esc(cs[f.perKey]):''}" placeholder="0">
        </div>`).join('')}
        <h3 class="calc-h" style="margin-top:18px">Менеджеры по продажам (персонально)</h3>
        <p class="calc-note">Оклад каждого идёт в общий котёл. Ставка за заказ применяется к заказам этого менеджера.</p>
        <div class="calc-city-head" style="grid-template-columns:1fr 110px 110px"><span>Менеджер</span><span>Оклад/мес</span><span>За заказ</span></div>
        ${(S.sales||[]).map(sm=>{
          const salV=calcSalesNorm(sm.id,'salary',P);const perV=calcSalesNorm(sm.id,'per_order',P);
          return `<div class="calc-city-row" data-salespay="${sm.id}" style="grid-template-columns:1fr 110px 110px">
            <span class="ccr-name">${esc(sm.fio)}</span>
            <input type="number" min="0" step="0.01" data-ssalary="${sm.id}" value="${salV?esc(salV):''}" placeholder="0">
            <input type="number" min="0" step="0.01" data-sper="${sm.id}" value="${perV?esc(perV):''}" placeholder="0">
          </div>`;
        }).join('')}
        <h3 class="calc-h" style="margin-top:18px">Расходы</h3>
        <p class="calc-note">Делятся на количество заказов за месяц и вычитаются так же, как фонды —
          и у курьерских заказов, и у почтовых.</p>
        ${expenseFields.map(fieldRow).join('')}
      </div>`;
  // Фонды, зарплаты и расходы общие для обоих типов доставки, а два блока «за заказ»
  // (курьерский и почтовый) раньше показывались по одному на вкладку — левая колонка
  // пустовала наполовину. Теперь оба слева, общее справа, и вкладка всего одна.
  const html=`
    <div class="calc-grid">
      <div>
        <div class="panel calc-panel">
          <h3 class="calc-h">Курьерская доставка — общие расходы (за заказ)</h3>
          <p class="calc-note">Применяются к заказам с типом доставки «курьер».</p>
          ${fixedFields.map(fieldRow).join('')}
        </div>
        <div class="panel calc-panel" style="margin-top:18px">
          <h3 class="calc-h">Почтовая доставка — фиксированные расходы (за заказ)</h3>
          <p class="calc-note">Применяются к заказам с типом доставки «почта».</p>
          ${CALC_POST_FIELDS.map(fieldRow).join('')}
        </div>
      </div>
      ${fundsBlock}
    </div>
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Нормативы по городам</h3>
      <p class="calc-note">Курьер и доставка груза по городам. Пусто = берётся общий норматив. Показаны города, где заданы значения.</p>
      ${compactCityNorms(cities,cityNorm)}
    </div>`;
  $('calcContent').innerHTML=periodBar+html+
    `<div class="calc-save-bar"><button class="btn primary" id="calcSaveBtn">Сохранить нормативы за ${esc(monthsRU[calcNormPeriod.month])} ${calcNormPeriod.year}</button><span class="calc-saved" id="calcSaved"></span></div>`;
  $('calcSaveBtn').onclick=saveCalcSettings;
  if($('calcNormMonth'))$('calcNormMonth').onchange=e=>{calcNormPeriod.month=parseInt(e.target.value,10);renderCalc();};
  if($('calcNormYear'))$('calcNormYear').onchange=e=>{calcNormPeriod.year=parseInt(e.target.value,10);renderCalc();};
  const showAllBtn=$('cityShowAll');if(showAllBtn)showAllBtn.onclick=()=>{_calcShowAllCities=true;renderCalc();};
  const hideBtn=$('cityHide');if(hideBtn)hideBtn.onclick=()=>{_calcShowAllCities=false;renderCalc();};
}

// сворачиваемый блок городских нормативов: по умолчанию свёрнут, раскрывается по кнопке
let _calcShowAllCities=false;
function compactCityNorms(cities,cityNorm){
  const row=c=>`<div class="calc-city-row" data-citynorm="${c.id}" style="grid-template-columns:1fr 110px">
    <span class="ccr-name">${esc(c.name)}</span>
    <input type="number" min="0" step="0.01" data-ccourier="${c.id}" value="${esc(cityNorm(c.id,'courier'))}" placeholder="общий">
  </div>`;
  if(!_calcShowAllCities){
    // свёрнуто — только кнопка (но поля рендерим скрытыми, чтобы сохранение видело значения)
    return `<button type="button" class="btn ghost sm" id="cityShowAll"><i style="font-style:normal">▾</i> Показать нормативы по городам (${cities.length})</button>
      <div style="display:none">${cities.map(row).join('')}</div>`;
  }
  return `<div class="calc-city-head" style="grid-template-columns:1fr 110px"><span>Город</span><span>Курьер (₸)</span></div>
    ${cities.map(row).join('')}
    <button type="button" class="btn ghost sm" id="cityHide" style="margin-top:10px"><i style="font-style:normal">▴</i> Свернуть список</button>`;
}

async function saveCalcSettings(){
  const btn=$('calcSaveBtn');if(btn)btn.disabled=true;
  const P=calcPeriodStr(); // сохраняем в выбранный месяц
  // стартуем с уже действующих для этого месяца значений (свои за этот месяц, либо унаследованные с прошлого) —
  // иначе при ПЕРВОМ сохранении за новый месяц с одной вкладки (напр. «Курьерская») поля другой вкладки
  // («Почтовая», фонды) и так далее обнулятся, т.к. их полей нет в DOM текущей вкладки
  const base=calcSettingsFor(P)||{};
  const row={period:P};
  Object.keys(base).forEach(k=>{if(k!=='id'&&k!=='period'&&k!=='created_at'&&k!=='updated_at')row[k]=base[k];});
  document.querySelectorAll('[data-calcnorm]').forEach(inp=>{
    const k=inp.dataset.calcnorm;const v=inp.value.trim();
    row[k]=v===''?0:parseFloat(v)||0;
  });
  try{
    const allS=S.calcSettingsAll||[];
    const existS=allS.find(r=>r.period===P);
    let saved;
    if(existS){saved=await dbUpdate('calc_settings',existS.id,row);if(saved)Object.assign(existS,saved);}
    else{saved=await dbInsert('calc_settings',row);if(saved){if(!S.calcSettingsAll)S.calcSettingsAll=[];S.calcSettingsAll.push(saved);}}
    // городские нормативы (курьер) за период — «межгород» больше не сохраняется отсюда,
    // сумма берётся из «Отправок межгород» напрямую
    const cityRows=document.querySelectorAll('[data-citynorm]');
    for(const el of cityRows){
      const cid=el.dataset.citynorm;
      const courierV=el.querySelector(`[data-ccourier="${cid}"]`).value.trim();
      const existing=(S.calcCityNorms||[]).find(r=>r.city_id===cid&&r.period===P);
      if(courierV===''&&!existing)continue;
      const payload={city_id:cid,period:P,courier:courierV===''?null:parseFloat(courierV)||0};
      if(existing){const u=await dbUpdate('calc_city_norms',existing.id,payload);if(u)Object.assign(existing,u);}
      else{const u=await dbInsert('calc_city_norms',payload);if(u){if(!S.calcCityNorms)S.calcCityNorms=[];S.calcCityNorms.push(u);}}
    }
    // ставки менеджеров продаж за период
    const salesRows=document.querySelectorAll('[data-salespay]');
    for(const el of salesRows){
      const sid=el.dataset.salespay;
      const sal=el.querySelector(`[data-ssalary="${sid}"]`).value.trim();
      const per=el.querySelector(`[data-sper="${sid}"]`).value.trim();
      const existing=(S.calcSalesNorms||[]).find(r=>r.sales_id===sid&&r.period===P);
      if(sal===''&&per===''&&!existing)continue;
      const payload={sales_id:sid,period:P,salary:sal===''?0:parseFloat(sal)||0,per_order:per===''?0:parseFloat(per)||0};
      if(existing){const u=await dbUpdate('calc_sales_norms',existing.id,payload);if(u)Object.assign(existing,u);}
      else{const u=await dbInsert('calc_sales_norms',payload);if(u){if(!S.calcSalesNorms)S.calcSalesNorms=[];S.calcSalesNorms.push(u);}}
    }
    const s=$('calcSaved');if(s){s.textContent='Сохранено ✓';setTimeout(()=>{if(s)s.textContent='';},2500);}
    toast('Нормативы сохранены за '+P);
  }catch(e){console.error(e);toast('Ошибка сохранения');}
  if(btn)btn.disabled=false;
}

// ── СВОДКА: итоги и заработок курьеров ──
let calcSummaryMonth={year:new Date().getFullYear(),month:new Date().getMonth()};
function renderCalcSummary(){
  const months=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const sel=`${calcSummaryMonth.year}-${String(calcSummaryMonth.month+1).padStart(2,'0')}`;
  // заказы выбранного месяца (по дате забора)
  const monthOrders=(S.orders||[]).filter(o=>((o.pickup_date||o.created_at||'').slice(0,7))===sel);
  // считаем калькуляцию каждого
  const calcs=monthOrders.map(o=>({o,c:calcOrder(o)}));
  // межгород (freight) в ИТОГОВОЙ сводке считаем по дате САМОЙ ОТПРАВКИ, а не по дате забора
  // заказа — так сумма точно сходится с «Отправками межгород» (там считают по дате отправки).
  // Из-за «дня-донора» у некоторых городов заказ мог быть забран в одном месяце, а сама отправка
  // уйти уже в следующем — по заказу это две разные даты, и старый способ (по заказу) их путал.
  const freightByOrderDate=calcs.reduce((s,x)=>s+((x.c.items.find(i=>i.key==='freight')||{}).amount||0),0);
  const freightByShipDate=(S.shipments||[]).filter(s=>(s.ship_date||'').slice(0,7)===sel).reduce((s,sh)=>s+(parseFloat(sh.box_cost)||0),0);
  const freightAdjust=freightByShipDate-freightByOrderDate; // прибавляем/вычитаем разницу к общим итогам
  const totRevenue=calcs.reduce((s,x)=>s+x.c.revenue,0);
  const totCost=calcs.reduce((s,x)=>s+x.c.totalCost,0)+freightAdjust;
  const totProfit=totRevenue-totCost;
  const avgMargin=totRevenue>0?(totProfit/totRevenue*100):0;
  const avgRoi=totCost>0?(totProfit/totCost*100):0;
  // разбивка курьерские / почтовые — межгород (freight) относится только к курьерским, поэтому
  // корректировку по дате отправки применяем именно к курьерской сумме, почтовую не трогаем
  const cour=calcs.filter(x=>x.c.isCourierType), post=calcs.filter(x=>!x.c.isCourierType);
  const sumBlock=arr=>({cnt:arr.length,rev:arr.reduce((s,x)=>s+x.c.revenue,0),cost:arr.reduce((s,x)=>s+x.c.totalCost,0),profit:arr.reduce((s,x)=>s+(x.c.revenue-x.c.totalCost),0)});
  const courSum=sumBlock(cour);courSum.cost+=freightAdjust;courSum.profit-=freightAdjust;
  const postSum=sumBlock(post);
  // заказы «Оплачено отправителем» — их выручка (условная, по сохранённой исходной сумме) уже
  // учтена в totRevenue/totProfit выше; здесь просто выделяем её отдельно для прозрачности
  const paidBySenderCalcs=calcs.filter(x=>x.c.isPaidBySender);
  const paidBySenderSum={cnt:paidBySenderCalcs.length,rev:paidBySenderCalcs.reduce((s,x)=>s+x.c.notionalRevenue,0),cost:paidBySenderCalcs.reduce((s,x)=>s+x.c.totalCost,0)};
  // заработок курьеров доставки: courier-норматив города заказа, по order_courier_id
  const byCourier={};
  calcs.forEach(({o,c})=>{
    const cid=o.order_courier_id;if(!cid)return;
    const courierCost=(c.items.find(i=>i.key==='courier')||{}).amount||0;
    if(!byCourier[cid])byCourier[cid]={count:0,earn:0};
    byCourier[cid].count++;byCourier[cid].earn+=courierCost;
  });
  const courierRows=Object.entries(byCourier)
    .map(([cid,v])=>({name:orderCourierName(cid),count:v.count,earn:v.earn}))
    .sort((a,b)=>b.earn-a.earn);
  // разбивка по каждой статье расходов — курьерский и почтовый аналог одной и той же статьи
  // (например pack/post_pack — оба «Пакет») объединяем в одну строку, чтобы видеть общую сумму
  const EXPENSE_LABELS={
    courier:'Курьер (доставка)',pack:'Пакеты',post_pack:'Пакеты',gofra:'Гофра',post_gofra:'Гофра',
    blank:'Бланки (печать наклеек)',post_blank:'Бланки (печать наклеек)',sms:'SMS-уведомления',post_sms:'SMS-уведомления',
    freight:'Межгород / доставка груза',post_freight:'Доставка почтой (Казпочта)',
    admin_courier:'ЗП администратора курьеров',fund_logist:'Фонд ЗП менеджера заказов',
    fund_pickers:'Фонд ЗП заборщиков',salary_processor:'ЗП обработчиков',sales_manager:'ЗП менеджеров по продажам',
  };
  const byExpense={};
  calcs.forEach(({c})=>c.items.forEach(it=>{
    const label=EXPENSE_LABELS[it.key]||it.label;
    if(!byExpense[label])byExpense[label]={label,amount:0};
    byExpense[label].amount+=(it.amount||0);
  }));
  // сумму межгорода в разбивке подменяем на посчитанную по дате отправки (см. freightByShipDate
  // выше) — та же логика, что и для totCost, чтобы разбивка и итог не расходились между собой
  if(byExpense['Межгород / доставка груза'])byExpense['Межгород / доставка груза'].amount=freightByShipDate;
  const expenseRows=Object.values(byExpense).sort((a,b)=>b.amount-a.amount);
  const fmtMoney=n=>Math.round(n).toLocaleString('ru-RU')+' ₸';
  const profitColor=totProfit<0?'#c0392b':(totProfit<calcMinProfit()*monthOrders.length?'#c08a2d':'#2e7d32');
  $('calcContent').innerHTML=`
    <div class="calc-sum-bar">
      <select id="calcSumMonth">${months.map((m,i)=>`<option value="${i}" ${calcSummaryMonth.month===i?'selected':''}>${m}</option>`).join('')}</select>
      <select id="calcSumYear">${(()=>{const ny=new Date().getFullYear();let o='';for(let y=2025;y<=ny+1;y++)o+=`<option value="${y}" ${calcSummaryMonth.year===y?'selected':''}>${y}</option>`;return o;})()}</select>
      <span class="calc-sum-cnt">Заказов: <b>${monthOrders.length}</b></span>
    </div>
    <div class="calc-totals">
      <div class="ct-card"><div class="ct-k">Выручка</div><div class="ct-v">${fmtMoney(totRevenue)}</div></div>
      <div class="ct-card"><div class="ct-k">Итого расходы</div><div class="ct-v">${fmtMoney(totCost)}</div></div>
      <div class="ct-card"><div class="ct-k">Чистая прибыль</div><div class="ct-v" style="color:${profitColor}">${fmtMoney(totProfit)}</div></div>
      <div class="ct-card"><div class="ct-k">Маржинальность</div><div class="ct-v">${avgMargin.toFixed(1)}%</div></div>
      <div class="ct-card"><div class="ct-k">ROI</div><div class="ct-v">${avgRoi.toFixed(1)}%</div></div>
    </div>
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Разбивка по типу доставки</h3>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Тип</th><th>Заказов</th><th>Выручка</th><th>Расходы</th><th>Прибыль</th></tr></thead>
        <tbody>
          <tr><td>Курьерская</td><td>${courSum.cnt}</td><td>${fmtMoney(courSum.rev)}</td><td>${fmtMoney(courSum.cost)}</td><td><b style="color:${courSum.profit<0?'#c0392b':'#2e7d32'}">${fmtMoney(courSum.profit)}</b></td></tr>
          <tr><td>Почтовая</td><td>${postSum.cnt}</td><td>${fmtMoney(postSum.rev)}</td><td>${fmtMoney(postSum.cost)}</td><td><b style="color:${postSum.profit<0?'#c0392b':'#2e7d32'}">${fmtMoney(postSum.profit)}</b></td></tr>
          <tr style="border-top:2px solid var(--line)"><td><b>Всего (общий котёл)</b></td><td><b>${courSum.cnt+postSum.cnt}</b></td><td><b>${fmtMoney(totRevenue)}</b></td><td><b>${fmtMoney(totCost)}</b></td><td><b style="color:${profitColor}">${fmtMoney(totProfit)}</b></td></tr>
        </tbody></table></div>
    </div>
    ${paidBySenderSum.cnt?`<div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Из них «Оплачено отправителем»</h3>
      <p class="calc-note">Партнёр платит за доставку сам, напрямую (например раз в месяц) — сумма заказа в CRM стоит 0. Ниже — сколько эти заказы условно «весят» в общей выручке/прибыли выше (уже учтено, не добавляется сверху) и сколько на них реально потрачено.</p>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Заказов</th><th>Условная выручка</th><th>Расходы</th><th>Условная прибыль</th></tr></thead>
        <tbody><tr><td>${paidBySenderSum.cnt}</td><td>${fmtMoney(paidBySenderSum.rev)}</td><td>${fmtMoney(paidBySenderSum.cost)}</td><td><b style="color:${(paidBySenderSum.rev-paidBySenderSum.cost)<0?'#c0392b':'#2e7d32'}">${fmtMoney(paidBySenderSum.rev-paidBySenderSum.cost)}</b></td></tr></tbody></table></div>
    </div>`:''}
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Разбивка по статьям расходов</h3>
      <p class="calc-note">Сколько всего потрачено за месяц по каждой статье — курьерские и почтовые заказы вместе.</p>
      ${expenseRows.length?`<div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Статья</th><th>Сумма</th><th>Доля</th></tr></thead>
        <tbody>${expenseRows.map(r=>`<tr><td>${esc(r.label)}</td><td><b>${fmtMoney(r.amount)}</b></td><td>${totCost>0?(r.amount/totCost*100).toFixed(1):'0'}%</td></tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td><b>Итого расходы</b></td><td><b>${fmtMoney(totCost)}</b></td><td><b>100%</b></td></tr></tbody></table></div>`
        :'<div class="empty"><div class="big">Нет данных</div>За этот месяц нет заказов.</div>'}
    </div>
    <div class="panel calc-panel">
      <h3 class="calc-h">Заработок курьеров доставки</h3>
      <p class="calc-note">Считается по нормативу «Курьер» города заказа, для заказов, присвоенных курьеру в этом месяце.</p>
      ${courierRows.length?`<div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Курьер</th><th>Заказов</th><th>Заработок</th></tr></thead>
        <tbody>${courierRows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.count}</td><td><b>${fmtMoney(r.earn)}</b></td></tr>`).join('')}</tbody></table></div>`
        :'<div class="empty"><div class="big">Нет данных</div>За этот месяц нет заказов с назначенным курьером.</div>'}
    </div>`;
  $('calcSumMonth').onchange=e=>{calcSummaryMonth.month=parseInt(e.target.value,10);renderCalcSummary();};
  $('calcSumYear').onchange=e=>{calcSummaryMonth.year=parseInt(e.target.value,10);renderCalcSummary();};
}

/* ---------- MODAL ENGINE ---------- */
function showModal(title,bodyHtml,onSave,opts={}){
  const ov=document.createElement('div');ov.className='overlay';
  const foot=opts.readonly
    ? `<div class="modal-foot"><button class="btn primary" data-close>${esc(opts.closeLabel||'Закрыть')}</button></div>`
    : `<div class="modal-foot">${opts.clearBtn?'<button class="btn ghost" data-clear>Очистить</button>':''}<button class="btn ghost" data-cancel>Отмена</button><button class="btn primary" data-save>Сохранить</button></div>`;
  ov.innerHTML=`<div class="modal${opts.wide?' modal-wide':''}${opts.mid?' modal-mid':''}"><div class="modal-head"><h3>${esc(title)}</h3><button class="x">×</button></div>
    <div class="modal-body">${bodyHtml}</div>${foot}</div>`;
  document.body.appendChild(ov);
  // плавающая панель пагинации (z-index:8000) перекрывает модальные окна (z-index:100) —
  // прячем её, пока открыта карточка, возвращаем обратно при закрытии
  // Одного скрытия здесь мало: пока карточка открыта, экран может перерисоваться —
  // от обновлений KET, заявок или фонового обновления — и панель создастся заново,
  // уже видимой, поверх карточки. Поэтому вешаем признак на <body>, а прячет панель
  // правило в CSS: оно действует и на те панели, что появятся позже.
  syncModalOpenClass();
  document.querySelectorAll('.orders-pager').forEach(p=>{if(p.style.display!=='none'){p.dataset.hiddenByModal='1';p.style.display='none';}});
  const restorePagers=()=>{
    syncModalOpenClass();
    document.querySelectorAll('.orders-pager[data-hidden-by-modal]').forEach(p=>{p.style.display='';delete p.dataset.hiddenByModal;});
  };
  // жёсткое закрытие — всегда работает (крестик, Escape, клик мимо): выход без сохранения
  const forceClose=()=>{ov.remove();restorePagers();};
  // закрытие с проверкой (кнопка Сохранить/Закрыть): beforeClose может запретить
  const close=()=>{
    if(typeof opts.beforeClose==='function'&&opts.beforeClose()===false)return;
    ov.remove();restorePagers();
  };
  ov.querySelector('.x').onclick=forceClose;         // крестик — всегда закрывает
  if(ov.querySelector('[data-cancel]'))ov.querySelector('[data-cancel]').onclick=forceClose;
  if(ov.querySelector('[data-close]'))ov.querySelector('[data-close]').onclick=close; // кнопка «Сохранить» — с проверкой
  ov.onclick=e=>{if(e.target===ov)forceClose();};    // клик мимо — закрывает
  const sv=ov.querySelector('[data-save]');
  if(sv)sv.onclick=async()=>{sv.disabled=true;const ok=await onSave();sv.disabled=false;if(ok!==false)forceClose();};
  const clr=ov.querySelector('[data-clear]');
  if(clr&&typeof opts.clearBtn==='function')clr.onclick=()=>opts.clearBtn(ov);
  document.addEventListener('keydown',function esc2(e){if(e.key==='Escape'){forceClose();document.removeEventListener('keydown',esc2);}});
  const first=ov.querySelector('input,select,textarea');if(first)setTimeout(()=>first.focus(),50);
  return ov;
}
function showInfo(title,bodyHtml,opts){return showModal(title,bodyHtml,null,Object.assign({readonly:true},opts||{}));}
// закрыть самую верхнюю открытую модалку (используется для перехода «карточка товара» → «операция/резерв»)
// признак «открыта карточка» на <body>: снимаем только когда закрыта последняя
function syncModalOpenClass(){
  document.body.classList.toggle('modal-open',!!document.querySelector('.overlay'));
}
function closeTopModal(){const ovs=document.querySelectorAll('.overlay');if(ovs.length){ovs[ovs.length-1].remove();syncModalOpenClass();document.querySelectorAll('.orders-pager[data-hidden-by-modal]').forEach(p=>{p.style.display='';delete p.dataset.hiddenByModal;});}}

/* автологин / спец-кабинеты по ссылке */
(async()=>{
  // страховка: если что-то пойдёт не так, сплэш всё равно уйдёт максимум через 12 сек
  setTimeout(()=>{const s=$('splash');if(s&&!s.classList.contains('hide'))hideSplash();},12000);
  // кабинет партнёра по QR-ссылке: ?p=НОМЕР
  const urlp=new URLSearchParams(location.search);
  const partnerCode=urlp.get('p');
  if(partnerCode){
    // сразу прячем логин-экран, чтобы он не мелькал, пока грузится кабинет
    const ls=$('loginScreen');if(ls)ls.style.display='none';
    const as=$('appShell');if(as)as.style.display='none';
    try{await openPartnerCabinet(partnerCode);}catch(e){console.error('partner cab',e);document.body.innerHTML='<div style="padding:40px;text-align:center;font-family:sans-serif">Ошибка загрузки кабинета</div>';}return;
  }
  try{
    const {data}=await sb.auth.getSession();
    if(data&&data.session){await loadMe(data.session);await enterApp();}
    else showLogin();
  }catch(e){console.error('init',e);showLogin();}
})();