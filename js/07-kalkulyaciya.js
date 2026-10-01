
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
// БАРАХОЛКА — заказы, пришедшие готовым реестром Казпочты: трек уже присвоен,
// курьер к партнёру не едет. Свой набор статей: ни курьера за забор, ни межгорода
// у них нет, а фонды свои и делятся только на заказы Барахолки.
const CALC_BAR_FIELDS=[
  {key:'bar_pack',   label:'Пакет (за заказ)',          hint:'Упаковка'},
  {key:'bar_gofra',  label:'Гофра (за заказ)',          hint:'Гофра'},
  {key:'bar_blank',  label:'Бланк (за заказ)',          hint:'Печать наклейки'},
  {key:'bar_sms',    label:'SMS (за заказ)',            hint:'SMS-уведомления'},
  {key:'bar_freight',label:'Доставка почтой (за заказ)',hint:'Стоимость отправки почтой'},
];
const CALC_BAR_FUNDS=[
  {key:'bar_fund_processor',label:'ЗП обработчика (в месяц)',      hint:'Делится на заказы Барахолки за месяц'},
  {key:'bar_fund_manager',  label:'ЗП менеджера (в месяц)',        hint:'Делится на заказы Барахолки за месяц'},
  {key:'bar_fund_warehouse',label:'Аренда склада (в месяц)',       hint:'Делится на заказы Барахолки за месяц'},
  {key:'bar_fund_delivery', label:'ЗП доставки до почты (в месяц)',hint:'Делится на заказы Барахолки за месяц'},
];
// Раздел заказа. Пусто = обычный; метка проставляется при создании из карточки партнёра.
// isBaraholkaOrder переехал в js/01-yadro.js: его спрашивают модули, которые
// подключаются раньше Калькуляции (Сортировка, Центр контроля, меню).
// Вкладка появляется, только если колонки в базе есть (db/13 выполнен).
const baraholkaReady=()=>!!(S.orders&&S.orders.length&&('calc_group' in S.orders[0]));

// БАЗОВЫЙ ТАРИФ КОМПАНИИ. Менеджер по продажам договаривается с партнёром выше
// базового, и разница — его заработок. Тариф партнёра в системе есть давно, не
// хватало цены, с которой его сравнивать.
const CALC_BASE_FIELDS=[
  {key:'base_post',   label:'Базовый тариф · почта (₸)',  hint:'Наша цена. Всё, что партнёр платит сверх, — доля менеджера'},
  {key:'base_courier',label:'Базовый тариф · курьер (₸)', hint:'То же для курьерской доставки'},
];
// Цены размеров пакета и перевеса. Хранятся НЕ в calc_settings, а в отдельной
// pricing_settings — её читают все вошедшие (см. priceNorm в js/01-yadro.js).
// Поэтому они не привязаны к месяцу: правка действует на новые заказы, а уже
// выставленные суммы не меняются — они записаны в самом заказе.
const CALC_PRICE_FIELDS=[
  {key:'size_mail_m',    label:'Почта · надбавка за M (₸)',   hint:'Сколько прибавить к тарифу партнёра за средний пакет'},
  {key:'size_mail_l',    label:'Почта · надбавка за L (₸)',   hint:'То же за большой пакет'},
  {key:'size_courier_m', label:'Курьер · надбавка за M (₸)',  hint:'Сколько прибавить к курьерскому тарифу партнёра'},
  {key:'size_courier_l', label:'Курьер · надбавка за L (₸)',  hint:'То же за большой пакет'},
  {key:'weight_free_kg', label:'Перевес · с какого веса (кг)', hint:'Всё до этого веса включительно — без надбавки', unit:'кг', step:'0.001'},
  {key:'weight_step_fee',label:'Перевес · за каждый кг (₸)',  hint:'За каждый НАЧАТЫЙ килограмм сверх порога. Только у почтовых'},
];
// Пример «S · M · L» под панелью: цифры проще проверить глазами, чем надбавки.
// Тариф для примера — базовый тариф компании, а если он не задан, самый частый
// тариф среди партнёров: абстрактная «надбавка 500» ни о чём не говорит.
function priceExampleTariff(courier,P){
  const base=calcNorm(courier?'base_courier':'base_post',P);
  if(base)return base;
  const cnt={};
  (S.partners||[]).forEach(p=>{const t=courier?p.tariff_courier:p.tariff_post;
    if(t!=null&&t!==''&&+t>0)cnt[+t]=(cnt[+t]||0)+1;});
  const top=Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0];
  return top?+top:0;
}
function priceExampleHtml(P){
  const money=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  const read=k=>{const el=document.querySelector(`[data-pricenorm="${k}"]`);
    return el&&el.value.trim()!==''?(parseFloat(el.value)||0):priceNorm(k);};
  const line=(courier,name)=>{
    const t=priceExampleTariff(courier,P);
    if(!t)return '';
    const m=t+read(courier?'size_courier_m':'size_mail_m');
    const l=t+read(courier?'size_courier_l':'size_mail_l');
    return `<div>${name} с тарифом <b>${money(t)}</b>: S ${money(t)} · M <b>${money(m)}</b> · L <b>${money(l)}</b></div>`;
  };
  const free=read('weight_free_kg'),fee=read('weight_step_fee');
  const kg=n=>String(Math.round(n*1000)/1000).replace('.',',');
  const w=fee?`<div>Посылка ${kg(free+0.1)} кг → +${money(fee)}, ${kg(free+1.1)} кг → +${money(fee*2)}</div>`:'';
  return line(false,'Почта')+line(true,'Курьер')+w;
}
const baseTariffReady=()=>{
  const cs=(S.calcSettingsAll||[])[0];
  return !!cs&&('base_post' in cs);
};
// Партнёр заказа: своё поле, а если пусто — по названию отправителя (у заказов,
// созданных пачкой из заявки, partner_id часто не заполнен).
function orderPartnerObj(o){
  if(o.partner_id){const p=(S.partners||[]).find(x=>x.id===o.partner_id);if(p)return p;}
  return (typeof findPartnerByNameLoose==='function')?findPartnerByNameLoose(o.sender):null;
}
// Доля менеджера: тариф партнёра минус базовый тариф компании.
//
// Считается от ТАРИФА, а не от суммы заказа: сумма растёт от размера пакета и
// перевеса, но договорённость у менеджера — на базовую цену, и с доплат за
// габарит и вес его доля не идёт.
//
// Только если у заказа указан менеджер: без него разница остаётся прибылью компании.
// Снимок в заказе есть — берём его. Базовый тариф хранится по месяцам, а тариф
// партнёра в карточке один на всё время: без снимка подъём цены пересчитал бы
// надбавку задним числом за все прошлые месяцы, уже после расчёта с менеджером.
const salesMarginReady=()=>!!(S.orders&&S.orders.length&&('sales_margin' in S.orders[0]));
// Поля «Доля менеджера» в карточке партнёра есть не всегда: пока не выполнен db/22 (почта)
// и db/23 (курьер), колонок нет, и слать их в запрос нельзя — партнёр перестал бы
// сохраняться целиком. Проверки РАЗДЕЛЬНЫЕ: файлы выполняют в разное время.
//
// ИМЯ sales_margin_fixed ИСТОРИЧЕСКОЕ — это ПОЧТОВАЯ доля. Появилась первой, когда
// курьерской ещё не планировалось; переименовывать её задним числом значит ломать
// сохранение у всех, кто ещё не выполнил миграцию. Курьерская — sales_margin_courier.
const salesFixedReady=()=>!!(S.partners&&S.partners.length&&('sales_margin_fixed' in S.partners[0]));
const salesCourierReady=()=>!!(S.partners&&S.partners.length&&('sales_margin_courier' in S.partners[0]));
// фиксированная доля партнёра по типу доставки; null — не задана
function partnerFixedMargin(pt,courier){
  const v=courier?pt.sales_margin_courier:pt.sales_margin_fixed;
  return (v==null||v==='')?null:Math.max(0,parseFloat(v)||0);
}
function salesMarginFor(o,P){
  if(o.sales_margin!=null&&o.sales_margin!=='')return parseFloat(o.sales_margin)||0;
  if(!o.sales_id)return 0;
  const pt=orderPartnerObj(o);if(!pt)return 0;
  const courier=isCourierDelivery(o.delivery_id);
  // ФИКСИРОВАННАЯ ДОЛЯ из карточки партнёра — СВОЯ НА КАЖДЫЙ ТИП ДОСТАВКИ и сильнее
  // разницы с базовым тарифом. Разница врёт сразу в трёх случаях:
  //   • партнёру ставят 2000 при базовых 1690, а менеджеру по договорённости те же 110 —
  //     лишние 200 держит компания;
  //   • партнёр с тарифом 0 платит раз в месяц по счёту, а менеджеру с него всё равно
  //     идут свои 110 — разница же не насчитает никогда ничего;
  //   • по курьеру базовый тариф 3000 совпадает с тарифом 457 партнёров из 468, то есть
  //     разница там структурно нулевая, сколько бы менеджер ни договорился.
  //
  // Поля два, а не одно: доли по почте и по курьеру разные, и одно число на оба типа
  // платило бы по курьеру то, чего там не было (так и сделали сначала — владелец поправил).
  const fixed=partnerFixedMargin(pt,courier);
  if(fixed!=null)return fixed;
  const tariff=courier?pt.tariff_courier:pt.tariff_post;
  if(tariff==null||tariff==='')return 0;
  const base=calcNorm(courier?'base_courier':'base_post',P);
  if(!base)return 0; // базовый тариф не задан — считать не от чего
  return Math.max(0,(parseFloat(tariff)||0)-base);
}

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
// таблицы может ещё не быть (db/16) — тогда блок не показываем и считаем по-старому
const processorNormsReady=()=>Array.isArray(S.calcProcessorNorms);
// ставка обработчика (оклад/за заказ) по id и периоду — как у менеджеров продаж
function calcProcessorNorm(procId,key,period){
  if(!procId)return 0;
  const all=S.calcProcessorNorms||[];
  let row=period?all.find(r=>r.processor_id===procId&&r.period===period):null;
  if(!row&&period)row=all.filter(r=>r.processor_id===procId&&r.period&&r.period<period).sort((a,b)=>b.period.localeCompare(a.period))[0];
  if(!row)row=all.find(r=>r.processor_id===procId&&!r.period)||all.find(r=>r.processor_id===procId);
  return row&&row[key]!=null&&row[key]!==''?parseFloat(row[key]):0;
}
// сумма окладов всех обработчиков за период (общий котёл)
function calcProcessorTotalSalary(period){
  let sum=0;
  (S.processors||[]).forEach(pr=>{sum+=calcProcessorNorm(pr.id,'salary',period);});
  return sum;
}
// Обработчиков стало двое, и платят им по-разному, поэтому появились персональные
// строки. Переход плавный и раздельный по двум статьям: пока персональные оклады не
// заданы, действует прежний общий оклад; пока у обработчика заказа нет своей ставки
// за заказ — прежняя общая. Иначе в день выполнения SQL зарплата обработчика молча
// выпала бы из расходов и прибыль подскочила бы на пустом месте.
// Переключатель — ЛЮБОЕ заполненное персональное поле. Пока их нет, всё считается по
// прежней общей строке «Менеджер обработчик»; как только появилось хоть одно, она
// перестаёт применяться целиком — и оклад, и ставка за заказ, — и уходит с экрана.
// Состояние ровно два, промежуточных нет: иначе строку убрали бы с глаз, а она
// продолжала бы влиять на прибыль, и искать её было бы негде.
const calcProcessorPersonal=period=>processorNormsReady()&&(S.processors||[]).some(pr=>
  calcProcessorNorm(pr.id,'salary',period)>0||calcProcessorNorm(pr.id,'per_order',period)>0);
function calcProcessorSalaryTotal(period){
  return calcProcessorPersonal(period)?calcProcessorTotalSalary(period):calcNorm('salary_processor',period);
}
// В персональном режиме ставку несут только заказы того обработчика, кому она задана.
// Заказ без обработчика (такие остались у старых записей) не несёт её вовсе.
function calcProcessorPerOrder(o,period){
  if(!calcProcessorPersonal(period))return calcNorm('perorder_processor',period);
  return o&&o.processor_id?calcProcessorNorm(o.processor_id,'per_order',period):0;
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
  const revenue=orderSum(o);
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
  const totalSalary=calcSalesTotalSalary(P)+calcProcessorSalaryTotal(P)+calcNorm('fund_logist',P);
  const commonSalary=Math.round((totalSalary/monthOrders)*100)/100;
  // менеджер по продажам: персональная ставка за заказ того менеджера, что указан в заказе
  const manager=o.sales_id?calcSalesNorm(o.sales_id,'per_order',P):0;
  // менеджер обработчик: ставка за заказ (80), на все заказы
  const processor=calcProcessorPerOrder(o,P);
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
  // Считаем отдельно по разделам: фонды Барахолки делятся на её заказы, общие — на
  // остальные. Если делить общие фонды на все заказы вместе, Барахолка разбавляла бы
  // общий котёл, ничего из него не оплачивая, и прибыль по обычным заказам росла бы
  // на пустом месте.
  const grp=isBaraholkaOrder(o)?'bar':'main';
  if(!_monthCountCache||_monthCountLen!==(S.orders||[]).length){
    _monthCountCache={};_monthCountLen=(S.orders||[]).length;
    (S.orders||[]).forEach(x=>{
      const m=(x.pickup_date||x.created_at||'').slice(0,7);if(!m)return;
      const g=isBaraholkaOrder(x)?'bar':'main';
      _monthCountCache[g+'|'+m]=(_monthCountCache[g+'|'+m]||0)+1;
    });
  }
  return _monthCountCache[grp+'|'+d]||1;
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
  const revenue=isPaidBySender?notionalRevenue:orderSum(o);
  const monthOrders=ordersInOrderMonth(o);
  // тип доставки: курьерская или почтовая
  const isCourierType=isCourierDelivery(o.delivery_id);
  const isBar=isBaraholkaOrder(o);
  let items;
  if(isBar){
    // БАРАХОЛКА: свои пять статей за заказ и свои четыре фонда. Общие фонды,
    // курьер, межгород и зарплаты из общего блока к таким заказам не применяются —
    // курьер за ними не ездил, а свои расходы у них перечислены полностью.
    const barFixed=CALC_BAR_FIELDS.map(f=>{
      const amount=(snap&&snap.items&&snap.items[f.key]!=null)?(parseFloat(snap.items[f.key])||0):calcNorm(f.key,P);
      return {key:f.key,label:f.label,amount};
    });
    const barFunds=CALC_BAR_FUNDS.map(f=>{
      const amount=(snap&&snap.items&&snap.items[f.key]!=null)?(parseFloat(snap.items[f.key])||0)
        :Math.round((calcNorm(f.key,P)/monthOrders)*100)/100;
      return {key:f.key,label:f.label,amount};
    });
    const barMargin=salesMarginFor(o,P);
    const barItems=barFixed.concat(barFunds)
      .concat(barMargin?[{key:'sales_margin',label:'Доля менеджера сверх базового тарифа',amount:barMargin}]:[]);
    const barCost=barItems.reduce((s2,it)=>s2+(it.amount||0),0);
    const barProfit=revenue-barCost;
    return {revenue,items:barItems,totalCost:barCost,profit:barProfit,
      margin:revenue>0?(barProfit/revenue*100):0,
      roi:barCost>0?(barProfit/barCost*100):0,
      cityId,monthOrders,isCourierType,period:P,isPaidBySender,notionalRevenue,isBar:true};
  }
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
  // обработчик: оклады всех в котёл ÷ заказы месяца + ставка за заказ того,
  // кто указан в заказе (персональная, иначе общая)
  const procCommon=Math.round((calcProcessorSalaryTotal(P)/monthOrders)*100)/100;
  const procPer=calcProcessorPerOrder(o,P);
  items.push({key:'salary_processor',label:'Менеджер обработчик',amount:procCommon+procPer});
  // менеджер продаж: оклады всех в котёл ÷ заказы месяца + персональная ставка за заказ
  const P2=orderPeriodStr(o);
  const salesCommon=Math.round((calcSalesTotalSalary(P2)/monthOrders)*100)/100;
  const salesPer=o.sales_id?calcSalesNorm(o.sales_id,'per_order',P2):0;
  items.push({key:'sales_manager',label:'Менеджер по продажам',amount:salesCommon+salesPer});
  // Доля менеджера сверх базового тарифа — отдельной статьёй, а не внутри строки
  // выше: выручка остаётся полной (что партнёр платит), и видно, сколько из неё
  // ушло менеджеру. Если вычитать её из выручки, обе цифры пропадают из виду.
  const marg=salesMarginFor(o,P2);
  if(marg)items.push({key:'sales_margin',label:'Доля менеджера сверх базового тарифа',amount:marg});
  const totalCost=items.reduce((s,it)=>s+(it.amount||0),0);
  const profit=revenue-totalCost;
  const margin=revenue>0?(profit/revenue*100):0;
  const roi=totalCost>0?(profit/totalCost*100):0;
  return {revenue,items,totalCost,profit,margin,roi,cityId,monthOrders,isCourierType,period:P2,isPaidBySender,notionalRevenue,isBar:false};
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
      ${baraholkaReady()?`<button data-calcsub="bar" class="${calcSub==='bar'?'active':''}">Барахолка</button>`:''}
      <button data-calcsub="summary" class="${calcSub==='summary'?'active':''}">Общая сводка</button>
      <button data-calcsub="partner" class="${calcSub==='partner'?'active':''}">Расчёт партнёра</button>
    </div>
    <div id="calcContent"></div>`;
  $('main').querySelectorAll('[data-calcsub]').forEach(b=>b.onclick=()=>{calcSub=b.dataset.calcsub;renderCalc();});
  // вкладок нормативов было две — курьерская и почтовая, но состав у них одинаковый,
  // поэтому осталась одна. Старые значения принимаем на случай, если calcSub где-то
  // выставят прежним именем.
  if(calcSub==='bar')renderCalcBarNorms();
  else if(calcSub==='norms'||calcSub==='courier'||calcSub==='mail')renderCalcNorms();
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
// Сводит веса одного файла в разбивку по килограммам. ОДНА функция на оба режима —
// одиночный файл и пачку: разойдись они, в счёте партнёру и в сводке по пачке стояли бы
// разные числа по одному и тому же файлу.
function calcPartnerTotals(weights,partner){
  const byKg={};let orders=0,charge=0,margin=0;
  (weights||[]).forEach(w=>{
    const r=calcPartnerOrderCharge(w,partner,_calcGlobalPerKg);
    if(!byKg[r.totalKg])byKg[r.totalKg]={kg:r.totalKg,count:0,charge:0,margin:0};
    byKg[r.totalKg].count++;byKg[r.totalKg].charge+=r.charge;byKg[r.totalKg].margin+=r.margin;
    orders++;charge+=r.charge;margin+=r.margin;
  });
  return {breakdown:Object.values(byKg).sort((a,b)=>a.kg-b.kg),orders,charge,margin};
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
// ==================== ПАЧКА ФАЙЛОВ ====================
// Реестры приходят за месяц пачкой, и по одному их прогонять — тридцать заходов в одну и
// ту же вкладку. Теперь файлы выбираются все сразу: каждый считается отдельно (сводить их
// в одну сумму нельзя — у партнёров разные ставки, да и счёт выставляется по файлу), а на
// экране сводка строкой на файл и кнопка «сохранить всё в архив».
//
// ПАРТНЁР УГАДЫВАЕТСЯ ПО ИМЕНИ ФАЙЛА и его можно поправить в самой строке. Так же сделано
// в загрузке заказов из Excel (js/17): реестры называют по партнёру — «Казпочта 25.09.xls».
// Не угадался — берётся тот, что выбран сверху: тридцать файлов ОДНОГО партнёра тогда
// разбираются одним выбором, ничего не тыкая по строкам.
//
// ПАЧКА В АРХИВ САМА НЕ УХОДИТ, в отличие от одиночного файла, и это не забывчивость:
// там партнёра выбрал человек, а здесь его угадала программа по имени файла. Тридцать
// записей с чужим партнёром потом разгребать руками, поэтому сначала таблица на проверку,
// потом кнопка.
let calcPartnerBatch=null;      // [{name,weights,meta,error,partnerId,runId,savedSig}]
let calcPartnerBatchBusy='';    // текст прогресса: чтение и сохранение идут по одному файлу
const calcPartnerParseOne=file=>new Promise(res=>
  calcPartnerParseFile(file,(weights,error,meta)=>res({weights,error,meta})));
// партнёр по имени файла; из совпавших берём САМОЕ ДЛИННОЕ название — иначе «Казпочта»
// перебивала бы «Казпочта Астана» и счёт ушёл бы по чужим ставкам
function calcPartnerBatchGuess(fileName){
  const f=normName(fileName);
  const hit=(S.calc_partners||[]).filter(p=>p.name&&f.includes(normName(p.name)))
    .sort((a,b)=>normName(b.name).length-normName(a.name).length)[0];
  return hit?hit.id:(calcPartnerId||'');
}
async function calcPartnerReadBatch(files){
  calcPartnerBatch=[];
  // одиночный режим и пачка — разные экраны: иначе под сводкой висел бы итог от прошлого файла
  calcPartnerWeights=null;calcPartnerFileName='';calcPartnerFileMeta=null;calcPartnerFileError='';
  for(let i=0;i<files.length;i++){
    calcPartnerBatchBusy=`Читаю файл ${i+1} из ${files.length}: ${files[i].name}`;
    calcPartnerBatchRender();
    // отдаём кадр браузеру: без этого тридцать файлов читаются с наглухо замершим экраном
    await new Promise(r=>setTimeout(r,0));
    const {weights,error,meta}=await calcPartnerParseOne(files[i]);
    calcPartnerBatch.push({name:files[i].name,weights:error?null:weights,meta:meta||null,
      error:error||'',partnerId:calcPartnerBatchGuess(files[i].name),runId:null,savedSig:''});
  }
  calcPartnerBatchBusy='';
  calcPartnerBatchRender();
}
// расчёт одной строки пачки; null — считать нечем (нет партнёра или файл не прочитался)
function calcPartnerBatchCalc(row){
  const p=(S.calc_partners||[]).find(x=>x.id===row.partnerId);
  if(!p||!row.weights||!row.weights.length)return null;
  const t=calcPartnerTotals(row.weights,p);
  return {partner:p,breakdown:t.breakdown,orders:t.orders,charge:t.charge,margin:t.margin};
}
// что ещё не в архиве ИЛИ изменилось после сохранения (поправили партнёра, столбец, надбавку).
// Отпечаток тот же, что в одиночном режиме, — повторное нажатие кнопки дублей не делает.
function calcPartnerBatchPending(){
  return (calcPartnerBatch||[]).filter(r=>{
    const c=calcPartnerBatchCalc(r);
    return c&&calcPartnerRunSig(c.partner,c.breakdown,r.name)!==r.savedSig;
  });
}
async function calcPartnerSaveBatch(){
  if(calcPartnerRuns==null){toast('Архив недоступен — сначала выполните db/21');return;}
  const todo=calcPartnerBatchPending();
  if(!todo.length)return;
  let done=0,fail=0;
  for(let i=0;i<todo.length;i++){
    const row=todo[i],c=calcPartnerBatchCalc(row);
    if(!c)continue;
    calcPartnerBatchBusy=`Сохраняю в архив: ${i+1} из ${todo.length}`;
    calcPartnerBatchRender();
    await new Promise(r=>setTimeout(r,0));
    const saved=await calcPartnerSaveRun(c.partner,c.breakdown,{orders:c.orders,charge:c.charge,margin:c.margin},
      {fileName:row.name,meta:row.meta,runId:row.runId||null});
    if(saved){row.runId=saved.id;row.savedSig=calcPartnerRunSig(c.partner,c.breakdown,row.name);done++;}
    else fail++;
  }
  calcPartnerBatchBusy='';
  calcPartnerBatchRender();
  toast(fail?`В архив ушло ${done}, не удалось ${fail}`:`В архив сохранено расчётов: ${done}`);
}
// свод по пачке — строка на файл. Ради него пачку и делают: по нему выставляют счёта,
// а не по тридцати открытым по очереди карточкам
function calcPartnerBatchExcel(){
  const data=(calcPartnerBatch||[]).map(r=>{
    const c=calcPartnerBatchCalc(r);
    return {'Файл':r.name,'Партнёр':c?c.partner.name:'—','Заказов':c?c.orders:0,
      'К оплате партнёром':c?Math.round(c.charge):0,'Наша прибыль':c?Math.round(c.margin):0,
      'Примечание':r.error?r.error:(c?'':'не выбран партнёр')};
  });
  const t=calcPartnerBatchSum();
  data.push({'Файл':'Итого','Партнёр':'','Заказов':t.orders,'К оплате партнёром':Math.round(t.charge),
    'Наша прибыль':Math.round(t.margin),'Примечание':''});
  if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
  const ws=XLSX.utils.json_to_sheet(data);
  ws['!cols']=[{wch:38},{wch:20},{wch:10},{wch:20},{wch:16},{wch:28}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Свод по файлам');
  XLSX.writeFile(wb,`Свод_расчётов_${localToday()}.xlsx`);
}
function calcPartnerBatchSum(calcs){
  calcs=calcs||(calcPartnerBatch||[]).map(calcPartnerBatchCalc);
  let orders=0,charge=0,margin=0,ready=0;
  calcs.forEach(c=>{if(c){orders+=c.orders;charge+=c.charge;margin+=c.margin;ready++;}});
  return {orders,charge,margin,ready};
}
// как и грид архива, рисуется ОТДЕЛЬНО: иначе перерисовка при каждом прочитанном файле
// сбрасывала бы выбор в <input type=file> и прогресс некуда было бы показывать
function calcPartnerBatchRender(){
  const box=$('cpBatchBox');if(!box)return;
  box.innerHTML=calcPartnerBatchHtml();
  box.querySelectorAll('[data-cpbpartner]').forEach(sel=>sel.onchange=e=>{
    calcPartnerBatch[+sel.dataset.cpbpartner].partnerId=e.target.value;calcPartnerBatchRender();});
  box.querySelectorAll('[data-cpbcol]').forEach(sel=>sel.onchange=e=>{
    const row=calcPartnerBatch[+sel.dataset.cpbcol],col=parseInt(e.target.value,10);
    const w=calcPartnerWeightsFromCol(row.meta,col);
    if(!w.length){toast('В этом столбце не нашлось весов больше 0');calcPartnerBatchRender();return;}
    row.weights=w;
    row.meta=Object.assign({},row.meta,{weightCol:col,autoDetected:true,
      usedHeaderName:row.meta.headerRow[col]||('Столбец '+(col+1)),
      avgWeight:w.reduce((a,b)=>a+b,0)/w.length,maxWeight:Math.max(...w),sample:w.slice(0,5)});
    calcPartnerBatchRender();
  });
  if(box.querySelector('#cpbSave'))box.querySelector('#cpbSave').onclick=()=>calcPartnerSaveBatch();
  if(box.querySelector('#cpbExcel'))box.querySelector('#cpbExcel').onclick=()=>calcPartnerBatchExcel();
  if(box.querySelector('#cpbClear'))box.querySelector('#cpbClear').onclick=()=>{
    calcPartnerBatch=null;calcPartnerBatchBusy='';renderCalcPartner();};
}
function calcPartnerBatchHtml(){
  if(!calcPartnerBatch)return '';
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  // расчёт по каждому файлу — РОВНО ОДИН раз на отрисовку: считать его заново в каждой
  // строке значит тридцать раз пройти по всем весам всех файлов
  const calcs=calcPartnerBatch.map(calcPartnerBatchCalc);
  const t=calcPartnerBatchSum(calcs);
  const fresh=calcPartnerBatch.map((r,i)=>!!calcs[i]&&calcPartnerRunSig(calcs[i].partner,calcs[i].breakdown,r.name)===r.savedSig);
  const pending=calcs.filter((c,i)=>c&&!fresh[i]).length;
  const partnersSorted=[...(S.calc_partners||[])].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const busy=!!calcPartnerBatchBusy;
  const rowHtml=(r,i)=>{
    const c=calcs[i];
    const inArchive=!!r.runId&&fresh[i];
    const heavy=r.meta&&r.meta.avgWeight>50;
    let status='';
    if(r.error)status=`<span style="color:var(--rust)">${esc(r.error)}</span>`;
    else if(!r.partnerId)status='<span style="color:var(--rust)">выберите партнёра</span>';
    else if(inArchive)status='<span style="color:#2e7d32">в архиве ✓</span>';
    else status='<span style="color:var(--muted)">готов к сохранению</span>';
    if(heavy)status+=`<br><span style="color:var(--rust)" title="Похоже, распознан не тот столбец">⚠️ средний вес ${r.meta.avgWeight.toFixed(0)} кг</span>`;
    return `<tr>
      <td data-label="Файл">${esc(r.name)}</td>
      <td data-label="Партнёр"><select data-cpbpartner="${i}"${busy?' disabled':''}>
        <option value="">— не выбран —</option>
        ${partnersSorted.map(p=>`<option value="${p.id}" ${r.partnerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
      </select></td>
      <td data-label="Столбец веса">${r.meta?`<select data-cpbcol="${i}"${busy?' disabled':''}>
        ${r.meta.headerRow.map((h,ci)=>`<option value="${ci}" ${ci===r.meta.weightCol?'selected':''}>${esc(h||('Столбец '+(ci+1)))}</option>`).join('')}
      </select>`:'—'}</td>
      <td data-label="Заказов">${c?c.orders:'—'}</td>
      <td data-label="Средний вес">${r.meta?r.meta.avgWeight.toFixed(2)+' кг':'—'}</td>
      <td data-label="К оплате партнёром">${c?fmtMoney(c.charge):'—'}</td>
      <td data-label="Наша прибыль" style="color:#2e7d32">${c?fmtMoney(c.margin):'—'}</td>
      <td data-label="Состояние">${status}</td>
    </tr>`;
  };
  return `<div class="panel calc-panel" style="margin-bottom:18px">
    <h3 class="calc-h">Пачка файлов (${calcPartnerBatch.length})</h3>
    <p class="calc-note">Каждый файл считается ОТДЕЛЬНО и попадает в архив своей строкой: ставки у
    партнёров разные, да и счёт выставляется по файлу — складывать их в одну сумму нельзя.
    Партнёр подставлен по имени файла, а где не угадался — взят выбранный сверху; поправьте прямо в строке.</p>
    ${busy?`<div class="hint" style="margin-bottom:10px">⏳ ${esc(calcPartnerBatchBusy)}</div>`:''}
    <div class="stats stats-4" style="margin:10px 0">
      <div class="stat"><div class="k">Файлов посчитано</div><div class="v">${t.ready} из ${calcPartnerBatch.length}</div></div>
      <div class="stat"><div class="k">Заказов всего</div><div class="v">${t.orders}</div></div>
      <div class="stat"><div class="k">К оплате всего</div><div class="v">${fmtMoney(t.charge)}</div></div>
      <div class="stat"><div class="k">Наша прибыль всего</div><div class="v" style="color:#2e7d32">${fmtMoney(t.margin)}</div></div>
    </div>
    <div class="table-scroll"><table class="resp-table calc-courier-tbl"><thead><tr>
      <th>Файл</th><th>Партнёр</th><th>Столбец веса</th><th>Заказов</th><th>Средний вес</th><th>К оплате партнёром</th><th>Наша прибыль</th><th>Состояние</th>
    </tr></thead><tbody>${calcPartnerBatch.map(rowHtml).join('')}
      <tr style="border-top:2px solid var(--line)"><td data-label=""><b>Итого</b></td><td data-label=""></td><td data-label=""></td>
        <td data-label="Заказов"><b>${t.orders}</b></td><td data-label=""></td>
        <td data-label="К оплате партнёром"><b>${fmtMoney(t.charge)}</b></td>
        <td data-label="Наша прибыль"><b style="color:#2e7d32">${fmtMoney(t.margin)}</b></td><td data-label=""></td></tr>
    </tbody></table></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" id="cpbSave"${busy||!pending?' disabled':''}>${pending?`💾 Сохранить в архив (${pending})`:'💾 Всё в архиве'}</button>
      <button class="btn btn-excel sm" id="cpbExcel"${busy?' disabled':''}>⬇ Свод в Excel</button>
      <button class="btn ghost sm" id="cpbClear"${busy?' disabled':''}>✕ Убрать пачку</button>
    </div>
  </div>`;
}
// ==================== АРХИВ ПРОГОНОВ ====================
// Прогнали файл — расчёт остался. До этого он жил ровно до обновления страницы: закрыл
// вкладку — и нечем ни свериться с партнёром, ни объяснить, откуда взялась сумма в счёте.
// Таблица calc_partner_runs (db/21).
//
// В архив ложится РАЗБИВКА ПО КГ, а не сами веса. Для этой модели она полная: плата
// зависит только от округлённого веса, поэтому по разбивке восстанавливаются и итоги, и
// выгрузка в Excel. Список из тысяч чисел хранить незачем.
//
// СТАВКИ ПИШУТСЯ СНИМКОМ (base_price, base_margin, per_kg_margin, per_kg_charge). Их
// правят: подняли надбавку за кг — и прошлый прогон, пересчитанный по карточке, дал бы
// другую сумму, чем та, что уже ушла партнёру. Та же причина, по которой снимок берётся
// у orders.sales_margin (раздел 5b).
//
// ВНЕШНЕГО КЛЮЧА НА ПАРТНЁРА НЕТ, вместо него имя снимком: партнёра из списка расчёта
// удаляют кнопкой тут же, а архив это обязан переживать — иначе удаление одной карточки
// молча уносило бы историю расчётов по ней.
let calcPartnerRuns=null;   // строки архива; null = ещё не загружали или таблицы нет
let calcPartnerRunsErr='';  // отказ базы. Архива нет — сам расчёт на экране работает как раньше
let _cpRunIds={};           // 'партнёр|файл' → id строки: правка столбца не плодит записи
let _cpRunSig='';           // отпечаток сохранённого прогона — защита от повтора при перерисовке
const CALC_RUNS_LIMIT=200;  // в гриде последние N: архив растёт, а листают всегда свежее
async function calcPartnerRunsLoad(){
  try{
    const {data,error}=await sb.from('calc_partner_runs').select('*')
      .order('created_at',{ascending:false}).limit(CALC_RUNS_LIMIT);
    // dbList на отсутствующую таблицу отвечает пустым массивом, а не ошибкой, — по нему
    // «таблицы нет» не отличить от «прогонов не было». Поэтому спрашиваем напрямую.
    if(error){calcPartnerRuns=null;calcPartnerRunsErr=error.message||'не удалось прочитать';return;}
    calcPartnerRuns=data||[];calcPartnerRunsErr='';
  }catch(e){calcPartnerRuns=null;calcPartnerRunsErr=(e&&e.message)||'не удалось прочитать';}
}
// отпечаток прогона: по нему видно, изменился ли расчёт с прошлого сохранения. Без него
// каждая перерисовка (а их много — Realtime, смена периода, возврат во вкладку) писала бы
// в архив ещё одну копию того же самого.
function calcPartnerRunSig(partner,breakdown,fileName){
  return [partner.id,fileName!=null?fileName:calcPartnerFileName,_calcGlobalPerKg,partner.base_price,partner.base_margin,
    partner.per_kg_margin,breakdown.map(r=>r.kg+':'+r.count).join(',')].join('|');
}
// Сохраняет прогон: ОДНА строка на «партнёр + загруженный файл». Поправили столбец с весом
// или надбавку — та же строка обновляется, а не появляется вторая: иначе в архиве осели бы
// промежуточные, заведомо неверные попытки, и найти среди них настоящий расчёт было бы
// нельзя. Выбрали заново файл — это новый прогон, ключи сбрасываются.
// opts.runId — правим КОНКРЕТНУЮ строку архива: пачка ведёт id по каждому файлу сама.
// Без opts строка ищется в _cpRunIds по «партнёр|файл» — это одиночный режим.
async function calcPartnerSaveRun(partner,breakdown,totals,opts){
  if(calcPartnerRuns==null)return null; // архива нет — молча, расчёт важнее
  opts=opts||{};
  const keyed=opts.runId===undefined;
  const fileName=opts.fileName!=null?opts.fileName:calcPartnerFileName;
  const meta=opts.meta!==undefined?opts.meta:calcPartnerFileMeta;
  const key=partner.id+'|'+fileName;
  const runId=keyed?_cpRunIds[key]:opts.runId;
  const num=v=>v!=null&&v!==''?parseFloat(v):null;
  const row={
    partner_id:String(partner.id),
    partner_name:partner.name||'',
    file_name:fileName||'',
    orders:totals.orders,
    total_charge:Math.round(totals.charge),
    total_margin:Math.round(totals.margin),
    per_kg_charge:num(_calcGlobalPerKg),
    base_price:num(partner.base_price),
    base_margin:num(partner.base_margin),
    per_kg_margin:num(partner.per_kg_margin),
    weight_col:meta?(meta.usedHeaderName||('Столбец '+(meta.weightCol+1))):'',
    breakdown:breakdown.map(r=>({kg:r.kg,count:r.count,charge:Math.round(r.charge),margin:Math.round(r.margin)})),
    author:(S.me&&(S.me.full_name||S.me.email))||'',
  };
  let saved;
  if(runId){
    saved=await dbUpdate('calc_partner_runs',runId,row);
    if(!saved)return null;
    calcPartnerRuns=(calcPartnerRuns||[]).map(r=>r.id===saved.id?saved:r);
  }else{
    saved=await dbInsert('calc_partner_runs',row);
    if(!saved)return null;
    calcPartnerRuns=[saved,...(calcPartnerRuns||[])];
  }
  if(keyed)_cpRunIds[key]=saved.id;
  calcPartnerRunsRender();
  return saved;
}
// грид рисуется ОТДЕЛЬНО от всей вкладки: сохранение вызывается из перерисовки, и полная
// перерисовка отсюда закрутила бы бесконечный круг «сохранил → нарисовал → сохранил».
function calcPartnerRunsRender(){
  const box=$('cpRunsBox');if(!box)return;
  box.innerHTML=calcPartnerRunsHtml();
  // список грузится один раз за сеанс, а расчёты прогоняют и коллеги — иначе свежие чужие
  // прогоны появлялись бы только после перезагрузки страницы
  box.querySelectorAll('.cp-runs-reload').forEach(b=>b.onclick=async()=>{
    b.disabled=true;b.textContent='Обновляю…';
    calcPartnerRuns=null;calcPartnerRunsErr='';await calcPartnerRunsLoad();calcPartnerRunsRender();
  });
  box.querySelectorAll('[data-cprun]').forEach(tr=>tr.onclick=()=>calcPartnerRunOpen(tr.dataset.cprun));
  box.querySelectorAll('[data-cprunxls]').forEach(b=>b.onclick=e=>{e.stopPropagation();calcPartnerRunExcel(b.dataset.cprunxls);});
  box.querySelectorAll('[data-cprundel]').forEach(b=>b.onclick=e=>{e.stopPropagation();calcPartnerRunDelete(b.dataset.cprundel);});
}
function calcPartnerRunsHtml(){
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  if(calcPartnerRuns==null){
    return `<div class="panel calc-panel" style="margin-top:18px">
      <h3 class="calc-h">Архив расчётов</h3>
      <p class="calc-note">Складывать прогоны пока некуда: ${esc(calcPartnerRunsErr||'таблица недоступна')}.
      Архив заработает, когда в базе появится таблица <b>calc_partner_runs</b> — файл <b>db/21</b>.
      Сам расчёт выше от этого не зависит и считает как раньше.</p></div>`;
  }
  const rows=calcPartnerRuns;
  return `<div class="panel calc-panel" style="margin-top:18px">
    <h3 class="calc-h">Архив расчётов${rows.length?` (${rows.length})`:''} <button class="btn ghost sm cp-runs-reload" style="margin-left:8px">🔄 Обновить</button></h3>
    <p class="calc-note">Каждый прогнанный файл ложится сюда сам — со ставками, которые действовали
    в тот момент. Нажмите на строку, чтобы открыть разбивку по весу.${rows.length>=CALC_RUNS_LIMIT?` Показаны последние ${CALC_RUNS_LIMIT}.`:''}</p>
    ${!rows.length?'<div class="hint">Пока ни одного прогона. Выберите партнёра и файл — расчёт сохранится сюда сам.</div>':`
    <div class="table-scroll"><table class="resp-table calc-courier-tbl"><thead><tr>
      <th>Когда</th><th>Партнёр</th><th>Файл</th><th>Заказов</th><th>К оплате партнёром</th><th>Наша прибыль</th><th>Кто считал</th><th></th>
    </tr></thead><tbody>
      ${rows.map(r=>`<tr data-cprun="${esc(r.id)}" style="cursor:pointer">
        <td data-label="Когда">${esc(fmtDateTime(r.created_at))}</td>
        <td data-label="Партнёр">${esc(r.partner_name||'—')}</td>
        <td data-label="Файл">${esc(r.file_name||'—')}</td>
        <td data-label="Заказов">${r.orders||0}</td>
        <td data-label="К оплате партнёром">${fmtMoney(r.total_charge)}</td>
        <td data-label="Наша прибыль" style="color:#2e7d32">${fmtMoney(r.total_margin)}</td>
        <td data-label="Кто считал">${esc(r.author||'—')}</td>
        <td data-label=""><button class="btn ghost sm" data-cprunxls="${esc(r.id)}">⬇ Excel</button>
          ${can('calc','delete')?` <button class="btn danger sm" data-cprundel="${esc(r.id)}">🗑</button>`:''}</td>
      </tr>`).join('')}
    </tbody></table></div>`}
  </div>`;
}
function calcPartnerRunOpen(id){
  const r=(calcPartnerRuns||[]).find(x=>String(x.id)===String(id));if(!r)return;
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  const bd=Array.isArray(r.breakdown)?r.breakdown:[];
  showInfo(`Расчёт · ${r.partner_name||'партнёр'} · ${fmtDateTime(r.created_at)}`,`
    <div class="hint" style="margin-bottom:12px">
      Файл: <b>${esc(r.file_name||'—')}</b>${r.weight_col?` · столбец с весом: <b>${esc(r.weight_col)}</b>`:''}<br>
      Ставки на момент расчёта: база <b>${fmtMoney(r.base_price)}</b> за первые ${CALC_PARTNER_BASE_WEIGHT} кг ·
      наше с базы <b>${fmtMoney(r.base_margin)}</b> · надбавка партнёру за доп. кг <b>${fmtMoney(r.per_kg_charge)}</b> ·
      наше с доп. кг <b>${fmtMoney(r.per_kg_margin)}</b><br>
      <span style="color:var(--muted)">Ставки записаны снимком: если их с тех пор меняли, расчёт
      всё равно показывает те, по которым считали и выставляли счёт.</span>
    </div>
    <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Вес (округлённо)</th><th>Заказов</th><th>К оплате партнёром</th><th>Наша прибыль</th></tr></thead>
      <tbody>${bd.map(x=>`<tr><td>${x.kg} кг</td><td>${x.count}</td><td>${fmtMoney(x.charge)}</td><td style="color:#2e7d32">${fmtMoney(x.margin)}</td></tr>`).join('')}
      <tr style="border-top:2px solid var(--line)"><td><b>Итого</b></td><td><b>${r.orders||0}</b></td><td><b>${fmtMoney(r.total_charge)}</b></td><td><b style="color:#2e7d32">${fmtMoney(r.total_margin)}</b></td></tr>
      </tbody></table></div>`,{wide:true});
}
function calcPartnerRunExcel(id){
  const r=(calcPartnerRuns||[]).find(x=>String(x.id)===String(id));if(!r)return;
  // дата в имени файла — дата ПРОГОНА, а не сегодняшняя: выгрузка августовского расчёта,
  // подписанная сегодняшним числом, потом никому ничего не докажет
  calcPartnerExcel(r.partner_name,Array.isArray(r.breakdown)?r.breakdown:[],
    {orders:r.orders||0,charge:r.total_charge||0,margin:r.total_margin||0},
    String(r.created_at||'').slice(0,10)||localToday());
}
async function calcPartnerRunDelete(id){
  const r=(calcPartnerRuns||[]).find(x=>String(x.id)===String(id));if(!r)return;
  if(!confirm(`Удалить из архива расчёт «${r.partner_name||''}» от ${fmtDateTime(r.created_at)}?`))return;
  if(!await dbDelete('calc_partner_runs',id))return;
  calcPartnerRuns=(calcPartnerRuns||[]).filter(x=>String(x.id)!==String(id));
  // ключ убираем, а отпечаток НЕ сбрасываем: со сброшенным следующая же перерисовка сочла бы
  // текущий прогон новым и записала бы удалённое обратно
  Object.keys(_cpRunIds).forEach(k=>{if(String(_cpRunIds[k])===String(id))delete _cpRunIds[k];});
  toast('Удалено');calcPartnerRunsRender();
}
// одна выгрузка на два места — экран и архив: расходись они, в счёте партнёру и в архивной
// копии стояли бы разные столбцы
function calcPartnerExcel(name,rows,totals,stamp){
  if(!window.XLSX){toast('Библиотека Excel ещё загружается, попробуйте снова');return;}
  const data=rows.map(r=>({'Вес (кг)':r.kg,'Заказов':r.count,'К оплате партнёром':Math.round(r.charge),'Наша прибыль':Math.round(r.margin)}));
  data.push({'Вес (кг)':'Итого','Заказов':totals.orders,'К оплате партнёром':Math.round(totals.charge),'Наша прибыль':Math.round(totals.margin)});
  const ws=XLSX.utils.json_to_sheet(data);
  ws['!cols']=[{wch:14},{wch:12},{wch:20},{wch:16}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Расчёт');
  XLSX.writeFile(wb,`Расчёт_${String(name||'партнёр').replace(/[^\wа-яА-ЯёЁ]+/g,'_')}_${stamp||localToday()}.xlsx`);
}
async function renderCalcPartner(){
  if(_calcGlobalPerKg==null)await loadCalcGlobalPerKg();
  // повторно не спрашиваем, если таблицы нет: иначе запрос уходил бы на каждую перерисовку
  if(calcPartnerRuns==null&&!calcPartnerRunsErr)await calcPartnerRunsLoad();
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
    const t=calcPartnerTotals(calcPartnerWeights,partner);
    breakdown=t.breakdown;totalOrders=t.orders;totalCharge=t.charge;totalMargin=t.margin;
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
        <input type="file" id="cpFile" accept=".xlsx,.xls,.csv" multiple>
        <span class="hint" style="font-size:12px">(можно выбрать СРАЗУ НЕСКОЛЬКО файлов — каждый посчитается отдельной строкой; партнёр нужен только для самого расчёта)</span>
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
    <div id="cpBatchBox"></div>
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
    </div>`:''}
    <div id="cpRunsBox"></div>`;
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
    const files=e.target.files?[...e.target.files]:[];
    if(!files.length)return;
    if(files.length>1){calcPartnerReadBatch(files);return;}
    const file=files[0];
    calcPartnerBatch=null; // вернулись к одному файлу — сводка по пачке не про него
    calcPartnerFileError='';calcPartnerFileMeta=null;
    // выбрали файл заново — это НОВЫЙ прогон, даже если файл тот же: прошлый в архиве
    // остаётся как был, а не затирается свежими числами
    _cpRunIds={};_cpRunSig='';
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
  if($('cpExport'))$('cpExport').onclick=()=>
    calcPartnerExcel(partner.name,breakdown,{orders:totalOrders,charge:totalCharge,margin:totalMargin});
  // пачка и грид архива — в самом конце, когда разметка уже на месте
  calcPartnerBatchRender();
  calcPartnerRunsRender();
  if(partner&&breakdown.length){
    const sig=calcPartnerRunSig(partner,breakdown);
    if(sig!==_cpRunSig){_cpRunSig=sig;calcPartnerSaveRun(partner,breakdown,{orders:totalOrders,charge:totalCharge,margin:totalMargin});}
  }
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
// Нормативы Барахолки — отдельной вкладкой, а не блоком на общей странице:
// её фонды не имеют отношения к общим и делятся на другое число заказов.
// Стоять рядом с ними — значит приглашать перепутать.
function renderCalcBarNorms(){
  const P=calcPeriodStr();
  const cs=calcCurrentSettings();
  const monthsRU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const fieldRow=f=>`<div class="calc-norm-row">
    <div class="cn-label">${esc(f.label)}<span class="cn-hint">${esc(f.hint)}</span></div>
    <div class="cn-input"><input type="number" min="0" step="0.01" data-calcnorm="${f.key}" value="${cs[f.key]!=null&&cs[f.key]!==''?esc(cs[f.key]):''}" placeholder="0"> ₸</div>
  </div>`;
  // Сколько заказов Барахолки в выбранном месяце — по этому числу делятся её фонды.
  // Показываем прямо тут: иначе «в месяц» остаётся абстракцией, и непонятно, сколько
  // из фонда ляжет на один заказ.
  const cnt=(S.orders||[]).filter(o=>isBaraholkaOrder(o)&&String(o.pickup_date||o.created_at||'').slice(0,7)===P).length;
  const fundsSum=CALC_BAR_FUNDS.reduce((a,f)=>a+calcNorm(f.key,P),0);
  const perOrder=cnt?Math.round(fundsSum/cnt*100)/100:null;
  $('calcContent').innerHTML=`
    <div class="calc-period-bar"><span>Нормативы за:</span>
      <select id="calcNormMonth">${monthsRU.map((m,i)=>`<option value="${i}" ${calcNormPeriod.month===i?'selected':''}>${m}</option>`).join('')}</select>
      <select id="calcNormYear">${(()=>{const ny=new Date().getFullYear();let o='';for(let y=2025;y<=ny+1;y++)o+=`<option value="${y}" ${calcNormPeriod.year===y?'selected':''}>${y}</option>`;return o;})()}</select></div>
    <div class="calc-grid">
      <div class="panel calc-panel">
        <h3 class="calc-h">Барахолка — расходы за заказ</h3>
        <p class="calc-note">Применяются к заказам партнёров, отмеченных как «Барахолка».
          Курьера и межгорода у них нет: посылки сданы в почту готовыми.</p>
        ${CALC_BAR_FIELDS.map(fieldRow).join('')}
      </div>
      <div class="panel calc-panel">
        <h3 class="calc-h">Барахолка — распределяемые фонды (в месяц)</h3>
        <p class="calc-note">Делятся на заказы Барахолки за месяц. Общие фонды компании к этим заказам не применяются.</p>
        ${CALC_BAR_FUNDS.map(fieldRow).join('')}
        <p class="calc-note" style="margin-top:14px">
          Заказов Барахолки за ${esc(P)}: <b>${cnt}</b>.
          ${perOrder!=null?`Фонды дают <b>${perOrder.toLocaleString('ru-RU')} ₸</b> на заказ.`:'Пока делить не на что — заказов нет.'}
        </p>
      </div>
    </div>
    <div class="calc-save-bar"><button class="btn primary" id="calcSaveBtn">Сохранить нормативы за ${esc(monthsRU[calcNormPeriod.month])} ${calcNormPeriod.year}</button><span class="calc-saved" id="calcSaved"></span></div>
    ${barSummaryHtml(P)}`;
  $('calcSaveBtn').onclick=saveCalcSettings;
  if($('calcNormMonth'))$('calcNormMonth').onchange=e=>{calcNormPeriod.month=parseInt(e.target.value,10);renderCalc();};
  if($('calcNormYear'))$('calcNormYear').onchange=e=>{calcNormPeriod.year=parseInt(e.target.value,10);renderCalc();};
}

// Сводка прямо под нормативами: поменял число — сразу видно, во что это вылилось.
// Ходить за этим в «Общую сводку» и искать там одну строку — лишний круг.
function barSummaryHtml(P){
  const fmtMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
  const list=(S.orders||[]).filter(o=>isBaraholkaOrder(o)&&String(o.pickup_date||o.created_at||'').slice(0,7)===P);
  if(!list.length)return `<div class="panel calc-panel" style="margin-top:18px">
    <h3 class="calc-h">Итоги Барахолки за ${esc(P)}</h3>
    <p class="calc-note">Заказов Барахолки за этот месяц пока нет — считать нечего.</p></div>`;
  const calcs=list.map(o=>calcOrder(o));
  const rev=calcs.reduce((a,c)=>a+c.revenue,0);
  const cost=calcs.reduce((a,c)=>a+c.totalCost,0);
  const profit=rev-cost;
  const margin=rev>0?(profit/rev*100):0;
  const roi=cost>0?(profit/cost*100):0;
  const avgSum=rev/list.length;
  // по статьям — чтобы было видно, какая из них съедает больше всего
  const byItem={};
  calcs.forEach(c=>c.items.forEach(it=>{byItem[it.label]=(byItem[it.label]||0)+(it.amount||0);}));
  const items=Object.entries(byItem).sort((a,b)=>b[1]-a[1]);
  // МЕСЯЧНЫЕ ФОНДЫ — главная причина, по которой итоги в начале месяца выглядят странно:
  // фонд за ВЕСЬ месяц делится на заказы, которые уже есть. 2 октября их полторы сотни,
  // и на заказ ложится в разы больше, чем ляжет к 31-му. Пишем это прямо под карточками,
  // иначе цифра выглядит ошибкой расчёта (вопрос владельца 02.10.2026).
  const fundsSum=CALC_BAR_FUNDS.reduce((a,f)=>a+calcNorm(f.key,P),0);
  const fundsPer=fundsSum/list.length;
  // НАДБАВКА ПО ЛЮДЯМ. В «Общей сводке» Барахолки больше нет вовсе (решение владельца
  // 02.10.2026), а надбавка по её заказам — настоящие деньги менеджера, и потеряться они
  // не должны: считаем их здесь, рядом с остальной Барахолкой.
  const bySales={};
  list.forEach((o,i2)=>{
    if(!o.sales_id)return;
    const m=(calcs[i2].items.find(it=>it.key==='sales_margin')||{}).amount||0;
    const r=bySales[o.sales_id]||(bySales[o.sales_id]={id:o.sales_id,cnt:0,margin:0});
    r.cnt++;r.margin+=m;
  });
  const salesRows=Object.values(bySales).map(r=>({...r,name:salesName(r.id)}))
    .sort((a,b)=>b.margin-a.margin);
  const profitColor=profit<0?'#c0392b':'#2e7d32';
  return `
    <h3 class="calc-h" style="margin:22px 0 10px">Итоги Барахолки за ${esc(P)}</h3>
    <div class="calc-sum-bar">
      <span class="calc-sum-cnt">Заказов: <b>${list.length}</b></span>
      <span class="calc-sum-cnt">Средняя сумма заказа: <b>${fmtMoney(avgSum)}</b></span>
      <span class="calc-sum-cnt" style="opacity:.7">месяц — по дате забора</span>
    </div>
    <div class="calc-totals">
      <div class="ct-card"><div class="ct-k">Выручка</div><div class="ct-v">${fmtMoney(rev)}</div></div>
      <div class="ct-card"><div class="ct-k">Итого расходы</div><div class="ct-v">${fmtMoney(cost)}</div>
        <div class="ct-s">${fmtMoney(cost/list.length)} на заказ</div></div>
      <div class="ct-card"><div class="ct-k">Чистая прибыль</div><div class="ct-v" style="color:${profitColor}">${fmtMoney(profit)}</div>
        <div class="ct-s">${fmtMoney(profit/list.length)} на заказ</div></div>
      <div class="ct-card"><div class="ct-k">Маржинальность</div><div class="ct-v">${margin.toFixed(1)}%</div></div>
      <div class="ct-card"><div class="ct-k">ROI</div><div class="ct-v">${roi.toFixed(1)}%</div></div>
    </div>
    ${fundsSum?`<p class="calc-note" style="margin:10px 0 0">
      ⚠️ <b>Месячные фонды считаются на весь месяц, а делятся на те заказы, что уже есть.</b>
      Фонды Барахолки за ${esc(P)} — ${fmtMoney(fundsSum)}, заказов пока ${list.length},
      значит на заказ ложится <b>${fmtMoney(fundsPer)}</b>. Это ${cost>0?Math.round(fundsPer/(cost/list.length)*100):0}% всей
      себестоимости заказа. Чем ближе к концу месяца, тем больше заказов и тем меньше эта доля —
      поэтому в первые дни прибыль занижена, и это не ошибка расчёта.</p>`:''}
    <div class="panel calc-panel" style="margin-top:18px">
      <h3 class="calc-h">Разбивка по статьям расходов</h3>
      <p class="calc-note">Свои пять статей за заказ и четыре месячных фонда. Курьера, межгорода и
        общих фондов у Барахолки нет вовсе — за ней курьер не ездил.</p>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr>
        <th>Статья</th><th>Сумма за месяц</th><th>На заказ</th><th>Доля</th>
      </tr></thead><tbody>
        ${items.map(([label,sum])=>`<tr>
          <td>${esc(label)}</td>
          <td><b>${fmtMoney(sum)}</b></td>
          <td>${fmtMoney(sum/list.length)}</td>
          <td>${cost>0?(sum/cost*100).toFixed(1):'0'}%</td>
        </tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td><b>Итого расходы</b></td>
          <td><b>${fmtMoney(cost)}</b></td><td><b>${fmtMoney(cost/list.length)}</b></td><td><b>100%</b></td></tr>
      </tbody></table></div>
    </div>
    ${salesRows.length?`<div class="panel calc-panel" style="margin-top:18px">
      <h3 class="calc-h">Заработок менеджеров по продажам</h3>
      <p class="calc-note">Надбавка — единственная общая статья, которая к Барахолке применяется:
        эти деньги менеджер реально зарабатывает. Ставка за заказ по Барахолке не начисляется — у неё
        свои статьи и свой месячный фонд. <b>К выплате менеджеру — эта надбавка ПЛЮС его строка
        в «Общей сводке»</b>: там только заказы заборов.</p>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr>
        <th>Менеджер</th><th>Заказов</th><th>Надбавка</th><th>На заказ</th>
      </tr></thead><tbody>
        ${salesRows.map(r=>`<tr>
          <td>${esc(r.name)}</td><td>${r.cnt}</td>
          <td><b>${fmtMoney(r.margin)}</b></td><td>${fmtMoney(r.margin/r.cnt)}</td>
        </tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td><b>Итого</b></td>
          <td><b>${salesRows.reduce((a,r)=>a+r.cnt,0)}</b></td>
          <td><b>${fmtMoney(salesRows.reduce((a,r)=>a+r.margin,0))}</b></td><td></td></tr>
      </tbody></table></div>
    </div>`:''}`;
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
  // Цены размеров/перевеса — своя строка: единица не всегда ₸ (порог задаётся в кг),
  // и пишутся они в другую таблицу, поэтому и атрибут другой — data-pricenorm.
  const priceRow=f=>`<div class="calc-norm-row">
    <div class="cn-label">${esc(f.label)}<span class="cn-hint">${esc(f.hint)}</span></div>
    <div class="cn-input"><input type="number" min="0" step="${f.step||'0.01'}" data-pricenorm="${f.key}" value="${(S.pricing&&S.pricing[f.key]!=null&&S.pricing[f.key]!=='')?esc(S.pricing[f.key]):''}" placeholder="${esc(PRICING_DEFAULTS[f.key])}"> ${esc(f.unit||'₸')}</div>
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
        ${calcProcessorPersonal(P)?'':`        <h3 class="calc-h" style="margin-top:18px">Сотрудники: оклад + за заказ</h3>
        <p class="calc-note">Оклад делится на все заказы за месяц. «За заказ»: менеджер продаж (150₸) — заказам с указанным менеджером; обработчик (80₸) — на каждый.</p>
        <div class="calc-city-head" style="grid-template-columns:1fr 110px 110px"><span>Сотрудник</span><span>Оклад/мес</span><span>За заказ</span></div>
        ${CALC_SALARY_FIELDS.map(f=>`<div class="calc-city-row" style="grid-template-columns:1fr 110px 110px">
          <span class="ccr-name">${esc(f.label)}</span>
          <input type="number" min="0" step="0.01" data-calcnorm="${f.salaryKey}" value="${cs[f.salaryKey]!=null&&cs[f.salaryKey]!==''?esc(cs[f.salaryKey]):''}" placeholder="0">
          <input type="number" min="0" step="0.01" data-calcnorm="${f.perKey}" value="${cs[f.perKey]!=null&&cs[f.perKey]!==''?esc(cs[f.perKey]):''}" placeholder="0">
        </div>`).join('')}`}
        ${processorNormsReady()?`<h3 class="calc-h" style="margin-top:18px">Менеджеры обработчики (персонально)</h3>
        <p class="calc-note">Оклад каждого идёт в общий котёл и делится на все заказы месяца.
          Ставка за заказ применяется к заказам этого обработчика.
          ${calcProcessorPersonal(P)?'Общая строка «Менеджер обработчик» больше не применяется — считается только то, что здесь.':
            'Пока оклады не заданы, действует общая строка «Менеджер обработчик» выше.'}</p>
        <div class="calc-city-head" style="grid-template-columns:1fr 110px 110px"><span>Обработчик</span><span>Оклад/мес</span><span>За заказ</span></div>
        ${(S.processors||[]).map(pr=>{
          const salV=calcProcessorNorm(pr.id,'salary',P);const perV=calcProcessorNorm(pr.id,'per_order',P);
          return `<div class="calc-city-row" data-procpay="${pr.id}" style="grid-template-columns:1fr 110px 110px">
            <span class="ccr-name">${esc(pr.fio)}</span>
            <input type="number" min="0" step="0.01" data-psalary="${pr.id}" value="${salV?esc(salV):''}" placeholder="0">
            <input type="number" min="0" step="0.01" data-pper="${pr.id}" value="${perV?esc(perV):''}" placeholder="0">
          </div>`;
        }).join('')}`:''}
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
        ${baseTariffReady()?`<div class="panel calc-panel" style="margin-top:18px">
          <h3 class="calc-h">Базовый тариф компании</h3>
          <p class="calc-note">Наша цена доставки. Всё, что партнёр платит сверх неё, идёт менеджеру по продажам
            отдельной статьёй расхода — и видно в сводке по каждому.</p>
          ${CALC_BASE_FIELDS.map(fieldRow).join('')}
        </div>`:''}
        ${pricingReady()?`<div class="panel calc-panel" style="margin-top:18px">
          <h3 class="calc-h">Размеры пакетов и перевес</h3>
          <p class="calc-note">Размер S — это тариф партнёра из его карточки. M и L считаются от него
            с надбавкой, которую вы задаёте здесь. Действует на новые заказы: суммы уже выставленных
            заказов не пересчитываются — они записаны в самом заказе.</p>
          ${CALC_PRICE_FIELDS.map(priceRow).join('')}
          <div class="calc-note" id="priceExample" style="margin:12px 0 0">${priceExampleHtml(P)}</div>
        </div>`:''}
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
  // пример S/M/L пересчитываем прямо при вводе — иначе надбавку приходится складывать в уме
  document.querySelectorAll('[data-pricenorm]').forEach(inp=>{inp.oninput=()=>{
    const box=$('priceExample');if(box)box.innerHTML=priceExampleHtml(P);};});
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
    // Цены размеров и перевеса — в свою таблицу и БЕЗ периода: они не месячные.
    // Пустое поле = «как в коде», поэтому пишем null, а не 0: ноль значил бы
    // «надбавки нет», и пакет L стоил бы столько же, сколько S.
    const priceInputs=document.querySelectorAll('[data-pricenorm]');
    if(priceInputs.length&&S.pricing){
      const pr={};
      priceInputs.forEach(inp=>{const v=inp.value.trim();pr[inp.dataset.pricenorm]=v===''?null:(parseFloat(v)||0);});
      const up=await dbUpdate('pricing_settings',S.pricing.id,pr);
      if(up)S.pricing=up;
    }
    // ставки обработчиков за период — так же, как у менеджеров продаж
    const procRows=document.querySelectorAll('[data-procpay]');
    for(const el of procRows){
      const pid=el.dataset.procpay;
      const sal=el.querySelector(`[data-psalary="${pid}"]`).value.trim();
      const per=el.querySelector(`[data-pper="${pid}"]`).value.trim();
      const existing=(S.calcProcessorNorms||[]).find(r=>r.processor_id===pid&&r.period===P);
      if(sal===''&&per===''&&!existing)continue;
      const payload={processor_id:pid,period:P,salary:sal===''?0:parseFloat(sal)||0,per_order:per===''?0:parseFloat(per)||0};
      if(existing){const u=await dbUpdate('calc_processor_norms',existing.id,payload);if(u)Object.assign(existing,u);}
      else{const u=await dbInsert('calc_processor_norms',payload);if(u){if(!S.calcProcessorNorms)S.calcProcessorNorms=[];S.calcProcessorNorms.push(u);}}
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
  // Общих итогов «по компании» здесь больше нет: вся сводка — только заказы заборов,
  // а Барахолка считается в своей вкладке. Складывать две ветки в одно число незачем.
  // разбивка курьерские / почтовые — межгород (freight) относится только к курьерским, поэтому
  // корректировку по дате отправки применяем именно к курьерской сумме, почтовую не трогаем
  // Барахолку считаем отдельной строкой, а не внутри «Почтовой»: набор расходов у неё
  // свой, и в общей строке она бы растворилась — ради этого разделения всё и делалось.
  const bar=calcs.filter(x=>x.c.isBar);
  const cour=calcs.filter(x=>!x.c.isBar&&x.c.isCourierType);
  const post=calcs.filter(x=>!x.c.isBar&&!x.c.isCourierType);
  const sumBlock=arr=>({cnt:arr.length,rev:arr.reduce((s,x)=>s+x.c.revenue,0),cost:arr.reduce((s,x)=>s+x.c.totalCost,0),profit:arr.reduce((s,x)=>s+(x.c.revenue-x.c.totalCost),0)});
  const courSum=sumBlock(cour);courSum.cost+=freightAdjust;courSum.profit-=freightAdjust;
  const postSum=sumBlock(post);
  const barSum=sumBlock(bar);
  // ВСЯ «ОБЩАЯ СВОДКА» — ТОЛЬКО ЗАКАЗЫ ЗАБОРОВ (решение владельца 02.10.2026:
  // «оттуда всё, что связано с барахолкой, убери, пусть будет только заказы заборов»).
  // Барахолка — отдельная ветка бизнеса (раздел 5f), и её деньги теперь живут в своей
  // вкладке: карточки и заработок менеджеров по ней там же, рядом с её нормативами.
  // Ничего не потерялось, но к выплате менеджеру — сумма двух таблиц.
  //
  // ГЛАВНЫЕ ЦИФРЫ СВОДКИ — БЕЗ БАРАХОЛКИ (решение владельца 28.09.2026).
  // У неё свой набор статей и свои фонды, общие к ней не применяются (раздел 5a). Пока
  // оба учёта лежали в одних карточках, «Итого расходы» наверху не сходились ни с одной
  // таблицей под ними, а прибыль двух разных бизнесов складывалась в одно число, по
  // которому нельзя понять ни один из них. Теперь наверху — обычные заказы, у Барахолки
  // свой блок, а общий котёл остался строкой «Всего» в разбивке по типу доставки.
  const mainCalcs=calcs.filter(x=>!x.c.isBar);
  const mainRevenue=courSum.rev+postSum.rev;
  const mainCost=courSum.cost+postSum.cost;
  const mainProfit=mainRevenue-mainCost;
  const avgMargin=mainRevenue>0?(mainProfit/mainRevenue*100):0;
  const avgRoi=mainCost>0?(mainProfit/mainCost*100):0;
  // заказы «Оплачено отправителем» — их выручка (условная, по сохранённой исходной сумме) уже
  // учтена в итогах выше; здесь просто выделяем её отдельно для прозрачности
  const paidBySenderCalcs=mainCalcs.filter(x=>x.c.isPaidBySender);
  const paidBySenderSum={cnt:paidBySenderCalcs.length,rev:paidBySenderCalcs.reduce((s,x)=>s+x.c.notionalRevenue,0),cost:paidBySenderCalcs.reduce((s,x)=>s+x.c.totalCost,0)};
  // заработок курьеров доставки: courier-норматив города заказа, по order_courier_id
  const byCourier={};
  mainCalcs.forEach(({o,c})=>{
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
  // БАРАХОЛКА В ЭТУ РАЗБИВКУ НЕ ВХОДИТ (решение владельца 28.09.2026). У неё свой набор
  // статей — пять за заказ и четыре фонда (CALC_BAR_FIELDS/CALC_BAR_FUNDS, раздел 5a), —
  // и в общей таблице они сливались с одноимёнными обычными: строка «Пакеты» складывала
  // два разных норматива, а курьера и межгорода у Барахолки нет вовсе. Смотреть на такую
  // сумму нельзя ни как на общую, ни как на чью-то конкретную.
  // Итог и доли считаются от расходов БЕЗ Барахолки — иначе проценты не сошлись бы в 100.
  const expenseCost=mainCost;
  const byExpense={};
  calcs.filter(x=>!x.c.isBar).forEach(({c})=>c.items.forEach(it=>{
    const label=EXPENSE_LABELS[it.key]||it.label;
    if(!byExpense[label])byExpense[label]={label,amount:0};
    byExpense[label].amount+=(it.amount||0);
  }));
  // сумму межгорода в разбивке подменяем на посчитанную по дате отправки (см. freightByShipDate
  // выше) — та же логика, что и в итогах, чтобы разбивка и итог не расходились между собой
  if(byExpense['Межгород / доставка груза'])byExpense['Межгород / доставка груза'].amount=freightByShipDate;
  const expenseRows=Object.values(byExpense).sort((a,b)=>b.amount-a.amount);
  // Заработок менеджеров по продажам за месяц: надбавка сверх базового тарифа,
  // ставка за заказ и оклад. Собираем по sales_id заказов.
  // ТОЛЬКО ЗАКАЗЫ ЗАБОРОВ. Надбавка по Барахолке — настоящие деньги менеджера (это
  // единственная общая статья, которая к ней применяется), но считается она теперь в
  // ЕЁ вкладке: «Общая сводка» — только про заказы заборов (решение владельца 02.10.2026).
  // К выплате менеджеру — сумма двух таблиц, и об этом прямо написано в обеих.
  const salesRows=(()=>{
    const by={};
    const row=id=>by[id]||(by[id]={id,cnt:0,margin:0,per:0});
    const marginOf=c=>((c.items.find(i=>i.key==='sales_margin')||{}).amount||0);
    mainCalcs.forEach(({o,c})=>{
      if(!o.sales_id)return;
      const r=row(o.sales_id);
      r.cnt++;
      r.margin+=marginOf(c);
      r.per+=calcSalesNorm(o.sales_id,'per_order',sel);
    });
    // Менеджеров с окладом показываем, даже если заказов за месяц не было:
    // оклад им всё равно начислен, и в сводке он должен быть виден.
    (S.sales||[]).forEach(sm=>{
      const sal=calcSalesNorm(sm.id,'salary',sel);
      if(sal&&!by[sm.id])row(sm.id);
    });
    return Object.values(by).map(r=>{
      const salary=calcSalesNorm(r.id,'salary',sel);
      return {...r,salary,total:r.margin+r.per+salary,name:salesName(r.id)};
    }).sort((a,b)=>b.total-a.total);
  })();
  // Обработчиков двое, платят им по-разному — считаем каждому: сколько заказов он
  // обработал, сколько набежало по ставке за заказ и какой у него оклад.
  const procRowsSum=(()=>{
    const by={};
    mainCalcs.forEach(({o})=>{
      if(!o.processor_id)return;
      const r=by[o.processor_id]||(by[o.processor_id]={id:o.processor_id,cnt:0,per:0});
      r.cnt++;r.per+=calcProcessorPerOrder(o,sel);
    });
    (S.processors||[]).forEach(pr=>{
      const sal=calcProcessorNorm(pr.id,'salary',sel);
      if(sal&&!by[pr.id])by[pr.id]={id:pr.id,cnt:0,per:0};
    });
    return Object.values(by).map(r=>{
      const salary=calcProcessorNorm(r.id,'salary',sel);
      const pr=(S.processors||[]).find(x=>x.id===r.id);
      return {...r,salary,total:r.per+salary,name:pr?pr.fio:'—'};
    }).sort((a,b)=>b.total-a.total);
  })();
  const procTotals=procRowsSum.reduce((a,r)=>({cnt:a.cnt+r.cnt,per:a.per+r.per,salary:a.salary+r.salary,
    total:a.total+r.total}),{cnt:0,per:0,salary:0,total:0});
  // Заказы, у которых человек не указан вовсе. В таблицах их нет, и итог по ним не сходится
  // с числом заказов за месяц — 28.09.2026 владелец как раз и спросил, где остальные 361.
  // Молчать об этом нельзя: по таким заказам ставка за заказ не начисляется НИКОМУ.
  const procNone=mainCalcs.filter(({o})=>!o.processor_id).length;
  const salesNone=mainCalcs.filter(({o})=>!o.sales_id).length;
  const salesTotals=salesRows.reduce((a,r)=>({cnt:a.cnt+r.cnt,margin:a.margin+r.margin,per:a.per+r.per,
    salary:a.salary+r.salary,total:a.total+r.total}),{cnt:0,margin:0,per:0,salary:0,total:0});
  const fmtMoney=n=>Math.round(n).toLocaleString('ru-RU')+' ₸';
  const profitColor=mainProfit<0?'#c0392b':(mainProfit<calcMinProfit()*mainCalcs.length?'#c08a2d':'#2e7d32');
  $('calcContent').innerHTML=`
    <div class="calc-sum-bar">
      <select id="calcSumMonth">${months.map((m,i)=>`<option value="${i}" ${calcSummaryMonth.month===i?'selected':''}>${m}</option>`).join('')}</select>
      <select id="calcSumYear">${(()=>{const ny=new Date().getFullYear();let o='';for(let y=2025;y<=ny+1;y++)o+=`<option value="${y}" ${calcSummaryMonth.year===y?'selected':''}>${y}</option>`;return o;})()}</select>
      <span class="calc-sum-cnt">Заказов: <b>${mainCalcs.length}</b></span>
      <span class="calc-sum-cnt" style="opacity:.7">месяц — по дате забора</span>
    </div>
    <div class="calc-totals">
      <div class="ct-card"><div class="ct-k">Выручка</div><div class="ct-v">${fmtMoney(mainRevenue)}</div></div>
      <div class="ct-card"><div class="ct-k">Итого расходы</div><div class="ct-v">${fmtMoney(mainCost)}</div></div>
      <div class="ct-card"><div class="ct-k">Чистая прибыль</div><div class="ct-v" style="color:${profitColor}">${fmtMoney(mainProfit)}</div></div>
      <div class="ct-card"><div class="ct-k">Маржинальность</div><div class="ct-v">${avgMargin.toFixed(1)}%</div></div>
      <div class="ct-card"><div class="ct-k">ROI</div><div class="ct-v">${avgRoi.toFixed(1)}%</div></div>
    </div>
    ${salesRows.length?`<div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Заработок менеджеров по продажам</h3>
      <p class="calc-note">«Надбавка» — доля менеджера с заказа: фиксированная из карточки партнёра,
        а если не задана — разница между тарифом партнёра и базовым тарифом компании.
        Оклад показан целиком за месяц, он не зависит от числа заказов.${
        barSum.cnt?' <b>Барахолка сюда не входит</b> — надбавка по её заказам считается на вкладке «Барахолка», и к выплате менеджеру идёт сумма двух таблиц.':''}</p>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr>
        <th>Менеджер</th><th>Заказов</th><th>Надбавка</th><th>За заказ</th><th>Оклад</th><th>Итого</th>
      </tr></thead><tbody>
        ${salesRows.map(r=>`<tr>
          <td>${esc(r.name)}</td>
          <td>${r.cnt}</td>
          <td>${fmtMoney(r.margin)}${r.cnt?`<small class="cell-time">${fmtMoney(r.margin/r.cnt)} на заказ</small>`:''}</td>
          <td>${fmtMoney(r.per)}</td><td>${fmtMoney(r.salary)}</td>
          <td><b>${fmtMoney(r.total)}</b></td></tr>`).join('')}
        ${salesNone?`<tr><td style="color:var(--muted)">Менеджер не указан
          <span class="cn-hint" style="display:block">надбавка по ним остаётся прибылью компании</span></td>
          <td><a href="#" id="calcNoSales" style="color:var(--rust)"><b>${salesNone}</b></a></td>
          <td>—</td><td>—</td><td>—</td><td>—</td></tr>`:''}
      </tbody><tfoot><tr style="border-top:2px solid var(--line)">
        <td><b>Итого</b></td>
        <td><b>${salesTotals.cnt}</b></td>
        <td><b>${fmtMoney(salesTotals.margin)}</b></td>
        <td><b>${fmtMoney(salesTotals.per)}</b></td><td><b>${fmtMoney(salesTotals.salary)}</b></td>
        <td><b>${fmtMoney(salesTotals.total)}</b></td></tr>
        <tr><td style="color:var(--muted)">Всего заказов за месяц</td>
        <td style="color:var(--muted)"><b>${salesTotals.cnt+salesNone}</b></td><td colspan="4"></td></tr></tfoot></table></div>
    </div>`:''}
    ${procRowsSum.length?`<div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Заработок менеджеров обработчиков</h3>
      <p class="calc-note">Заказы считаются по обработчику, указанному в самом заказе.
        Оклад показан целиком за месяц, он не зависит от числа заказов.${
        barSum.cnt?' Барахолка сюда не входит: ставка за заказ на ней не начисляется, у неё свой месячный фонд.':''}</p>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr>
        <th>Обработчик</th><th>Заказов</th><th>За заказ</th><th>Оклад</th><th>Итого</th>
      </tr></thead><tbody>
        ${procRowsSum.map(r=>`<tr>
          <td>${esc(r.name)}</td>
          <td>${r.cnt}</td>
          <td>${fmtMoney(r.per)}${r.cnt?`<small class="cell-time">${fmtMoney(r.per/r.cnt)} на заказ</small>`:''}</td>
          <td>${fmtMoney(r.salary)}</td><td><b>${fmtMoney(r.total)}</b></td></tr>`).join('')}
        ${procNone?`<tr><td style="color:var(--muted)">Обработчик не указан
          <span class="cn-hint" style="display:block">ставка за заказ по ним не начисляется никому</span></td>
          <td><a href="#" id="calcNoProc" style="color:var(--rust)"><b>${procNone}</b></a></td>
          <td>—</td><td>—</td><td>—</td></tr>`:''}
      </tbody><tfoot><tr style="border-top:2px solid var(--line)">
        <td><b>Итого</b></td><td><b>${procTotals.cnt}</b></td><td><b>${fmtMoney(procTotals.per)}</b></td>
        <td><b>${fmtMoney(procTotals.salary)}</b></td><td><b>${fmtMoney(procTotals.total)}</b></td></tr>
        <tr><td style="color:var(--muted)">Всего заказов за месяц</td>
        <td style="color:var(--muted)"><b>${procTotals.cnt+procNone}</b></td><td colspan="3"></td></tr></tfoot></table></div>
    </div>`:''}
    <div class="panel calc-panel" style="margin-bottom:18px">
      <h3 class="calc-h">Разбивка по типу доставки</h3>
      <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Тип</th><th>Заказов</th><th>Выручка</th><th>Расходы</th><th>Прибыль</th></tr></thead>
        <tbody>
          <tr><td>Курьерская</td><td>${courSum.cnt}</td><td>${fmtMoney(courSum.rev)}</td><td>${fmtMoney(courSum.cost)}</td><td><b style="color:${courSum.profit<0?'#c0392b':'#2e7d32'}">${fmtMoney(courSum.profit)}</b></td></tr>
          <tr><td>Почтовая</td><td>${postSum.cnt}</td><td>${fmtMoney(postSum.rev)}</td><td>${fmtMoney(postSum.cost)}</td><td><b style="color:${postSum.profit<0?'#c0392b':'#2e7d32'}">${fmtMoney(postSum.profit)}</b></td></tr>
          <tr style="border-top:2px solid var(--line)"><td><b>Всего</b></td><td><b>${courSum.cnt+postSum.cnt}</b></td><td><b>${fmtMoney(mainRevenue)}</b></td><td><b>${fmtMoney(mainCost)}</b></td><td><b style="color:${profitColor}">${fmtMoney(mainProfit)}</b></td></tr>
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
      <p class="calc-note">Сколько всего потрачено за месяц по каждой статье — курьерские и почтовые заказы вместе.${
        barSum.cnt?' Барахолка сюда не входит: у неё свой набор статей и своя вкладка.':''}</p>
      ${expenseRows.length?`<div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Статья</th><th>Сумма</th><th>Доля</th></tr></thead>
        <tbody>${expenseRows.map(r=>`<tr><td>${esc(r.label)}</td><td><b>${fmtMoney(r.amount)}</b></td><td>${expenseCost>0?(r.amount/expenseCost*100).toFixed(1):'0'}%</td></tr>`).join('')}
        <tr style="border-top:2px solid var(--line)"><td><b>Итого расходы</b></td><td><b>${fmtMoney(expenseCost)}</b></td><td><b>100%</b></td></tr></tbody></table></div>`
        :'<div class="empty"><div class="big">Нет данных</div>За этот месяц нет заказов.</div>'}
    </div>
    <div class="panel calc-panel">
      <h3 class="calc-h">Заработок курьеров доставки</h3>
      <p class="calc-note">Считается по нормативу «Курьер» города заказа, для заказов, присвоенных курьеру в этом месяце.</p>
      ${courierRows.length?`<div class="table-scroll"><table class="calc-courier-tbl"><thead><tr><th>Курьер</th><th>Заказов</th><th>Заработок</th></tr></thead>
        <tbody>${courierRows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.count}</td><td><b>${fmtMoney(r.earn)}</b></td></tr>`).join('')}</tbody></table></div>`
        :'<div class="empty"><div class="big">Нет данных</div>За этот месяц нет заказов с назначенным курьером.</div>'}
    </div>`;
  if($('calcNoProc'))$('calcNoProc').onclick=e=>{e.preventDefault();calcNoOneList('processor_id',sel,'Заказы без обработчика');};
  if($('calcNoSales'))$('calcNoSales').onclick=e=>{e.preventDefault();calcNoOneList('sales_id',sel,'Заказы без менеджера по продажам');};
  $('calcSumMonth').onchange=e=>{calcSummaryMonth.month=parseInt(e.target.value,10);renderCalcSummary();};
  $('calcSumYear').onchange=e=>{calcSummaryMonth.year=parseInt(e.target.value,10);renderCalcSummary();};
}

/* ---------- MODAL ENGINE ---------- */
// «А где остальные?» — вопрос, который сводка раньше оставляла без ответа: в таблицах
// считаются только заказы с указанным человеком, а в гриде заказов колонки «Обработчик»
// нет вовсе, и найти их было нечем. Теперь число открывает список — и из него же можно
// проставить, не обходя заказы по одному.
function calcNoOneList(field,period,title){
  const human=field==='processor_id'?'обработчика':'менеджера';
  const nameOf=id=>field==='processor_id'
    ? (((S.processors||[]).find(x=>x.id===id)||{}).fio||'—')
    : (typeof salesName==='function'?salesName(id):'—');
  const rows=(S.orders||[]).filter(o=>((o.pickup_date||o.created_at||'').slice(0,7))===period&&!o[field]);
  const senderOf=o=>o.sender||partnerName(o.partner_id)||'—';
  // Группируем по отправителю: почти всегда это «у партнёра в карточке не заполнено поле»,
  // и список из трёхсот строк этого не покажет, а десяток партнёров — покажет сразу.
  const by={};
  rows.forEach(o=>{const k=senderOf(o);(by[k]=by[k]||[]).push(o);});
  // Партнёр заказа: своим полем, а если пусто — по названию отправителя. У заказов,
  // созданных пачкой из заявки, partner_id часто не заполнен (см. salesMarginFor).
  const partnerOfGroup=list=>{
    const withId=list.find(o=>o.partner_id);
    if(withId){const p=(S.partners||[]).find(x=>x.id===withId.partner_id);if(p)return p;}
    return (typeof findPartnerByNameLoose==='function')?findPartnerByNameLoose(senderOf(list[0])):null;
  };
  const groups=Object.entries(by).map(([nm,list])=>{
    const p=partnerOfGroup(list);
    return {nm,list,partner:p,val:p?(p[field]||null):null};
  }).sort((a,b)=>b.list.length-a.list.length);
  const ready=groups.filter(g=>g.val);
  const readyCnt=ready.reduce((n,g)=>n+g.list.length,0);
  showModal(title,`
    <p class="calc-note">Всего таких заказов за месяц: <b>${rows.length}</b>. Поле подставляется
      из карточки партнёра в момент создания заказа — если там пусто или партнёр у заказа
      не определился, заказ остаётся без него.</p>
    ${readyCnt?`<div style="margin:0 0 12px"><button class="btn primary" id="calcFixAll">
      Проставить ${esc(human)} по карточкам партнёров (${readyCnt})</button>
      <span class="cn-hint" style="display:block;margin-top:6px">Берётся из карточки партнёра.
        Там, где в карточке пусто, заказы останутся как есть — сначала заполните её.</span></div>`:''}
    <div class="table-scroll"><table class="calc-courier-tbl"><thead><tr>
      <th>Отправитель</th><th>Заказов</th><th>В карточке партнёра</th><th>Номера</th></tr></thead><tbody>
      ${groups.map((g,i)=>`<tr><td>${esc(g.nm)}</td><td><b>${g.list.length}</b></td>
        <td>${g.val
          ? `${esc(nameOf(g.val))} <button class="btn sm ghost" data-calcfix="${i}">Проставить</button>`
          : `<span style="color:var(--rust)">${g.partner?'в карточке не задан':'партнёр не найден'}</span>`}</td>
        <td style="font-size:12px;color:var(--muted)">${g.list.slice(0,10).map(o=>esc(o.code||'')).join(', ')}${
          g.list.length>10?` … и ещё ${g.list.length-10}`:''}</td></tr>`).join('')}
    </tbody></table></div>`,null,{readonly:true,wide:true});

  const ov=[...document.querySelectorAll('.overlay')].pop();
  if(!ov)return;
  const apply=async list=>{
    // Пишем ПАЧКАМИ, мимо dbUpdate: он делает по два обращения на заказ плюс запись
    // в журнал на каждое — на трёхстах заказах это больше тысячи запросов подряд, и
    // кнопка выглядит мёртвой (те же грабли, что были в разборе межгорода).
    const byVal={};
    list.forEach(({o,val})=>{(byVal[val]=byVal[val]||[]).push(o);});
    let done=0;
    for(const [val,orders] of Object.entries(byVal)){
      for(let i=0;i<orders.length;i+=100){
        const chunk=orders.slice(i,i+100);
        const {error}=await sb.from('orders').update({[field]:val}).in('id',chunk.map(o=>o.id));
        if(error){console.error('calc fix '+field,error);toast('Ошибка: '+error.message);return done;}
        chunk.forEach(o=>{o[field]=val;});
        done+=chunk.length;
      }
    }
    return done;
  };
  const finish=async(list,btn)=>{
    if(!list.length)return;
    if(!confirm(`Проставить ${human} в ${list.length} заказ(ах)?\n\nЭто меняет расчёт за месяц: по этим заказам появится ставка за заказ.`))return;
    btn.disabled=true;btn.textContent='Проставляем…';
    const n=await apply(list);
    toast(n?`Проставлено в ${n} заказах`:'Ничего не изменилось');
    const x=ov.querySelector('.x');if(x)x.click();
    renderCalcSummary();
  };
  if(ov.querySelector('#calcFixAll'))ov.querySelector('#calcFixAll').onclick=e=>
    finish(ready.flatMap(g=>g.list.map(o=>({o,val:g.val}))),e.target);
  ov.querySelectorAll('[data-calcfix]').forEach(b=>b.onclick=e=>{
    const g=groups[+b.dataset.calcfix];
    finish(g.list.map(o=>({o,val:g.val})),e.target);
  });
}

function showModal(title,bodyHtml,onSave,opts={}){
  const ov=document.createElement('div');ov.className='overlay';
  const foot=opts.readonly
    ? `<div class="modal-foot"><button class="btn primary" data-close>${esc(opts.closeLabel||'Закрыть')}</button></div>`
    : `<div class="modal-foot">${opts.clearBtn?'<button class="btn ghost" data-clear>Очистить</button>':''}<button class="btn ghost" data-cancel>Отмена</button><button class="btn primary" data-save>${esc(opts.saveLabel||'Сохранить')}</button></div>`;
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
    if(data&&data.session){
      await loadMe(data.session);
      // Карточку могли удалить, пока человек оставался со старой сессией: без этой
      // проверки он просто продолжал бы работать до истечения токена.
      if(S.meMissing){await signOutNoProfile();showLogin();const e2=$('loginErr');if(e2)e2.textContent=NO_PROFILE_MSG;}
      else await enterApp();
    }
    else showLogin();
  }catch(e){console.error('init',e);showLogin();}
})();