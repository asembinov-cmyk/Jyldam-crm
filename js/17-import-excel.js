/* ============================================================
   ЗАГРУЗКА ЗАКАЗОВ ИЗ EXCEL — реестр Казпочты.

   Файл приходит от партнёра готовым реестром: трек-номера уже присвоены,
   посылки сданы. Из него надо создать заказы, не забивая полтораста строк
   руками.

   НИЧЕГО НЕ СОЗДАЁТСЯ ВСЛЕПУЮ. Сначала показываем разбор: что создастся,
   что пропустим и почему. Кнопка создания — после того, как это увидели.
   ============================================================ */

// Колонки ищем ПО НАЗВАНИЮ, а не по номеру: в выгрузке легко появится лишний
// столбец, и жёсткие номера молча сдвинут все данные на одну графу.
const IMP_COLS = {
  client: ['фио', 'ф.и.о', 'получатель'],
  index:  ['индекс'],
  address:['адрес'],
  track:  ['шпи', 'трек', 'штрихкод', 'штрих-код'],
  weight: ['вес'],
  sum:    ['сумма нал. платежа', 'сумма наложенного платежа', 'сумма нал платежа'],
  sum2:   ['сумма объявленной ценности'],
  phone:  ['телефон', 'тел'],
};
const impNorm = v => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// Ведущий ноль индекса в Excel превращается в букву «O» — визуально неотличимо,
// а для Казпочты это другой символ. Возвращаем ноль и дополняем до шести знаков.
function impIndex(v){
  let t = String(v == null ? '' : v).trim().replace(/^[OoОо]/, '0').replace(/\D/g, '');
  if(!t) return '';
  return t.length >= 6 ? t : t.padStart(6, '0');
}
// Телефон: оставляем цифры, приводим 8XXXXXXXXXX и 7XX… к одному виду.
function impPhone(v){
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if(d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if(d.length === 10) d = '7' + d;
  return d;
}

function impReadSheet(wb){
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: '' });
  // Шапка реестра занимает первые строки, и где именно начинается таблица —
  // заранее неизвестно. Ищем строку, в которой есть и ФИО, и ШПИ.
  let head = -1;
  for(let r = 0; r < Math.min(rows.length, 60); r++){
    const cells = (rows[r] || []).map(impNorm);
    const has = keys => keys.some(k => cells.some(c => c === k || c.startsWith(k)));
    if(has(IMP_COLS.client) && has(IMP_COLS.track)){ head = r; break; }
  }
  if(head < 0) return { error: 'Не нашёл строку заголовков — в файле должны быть колонки «ФИО» и «ШПИ»' };
  const cells = (rows[head] || []).map(impNorm);
  const find = keys => cells.findIndex(c => keys.some(k => c === k || c.startsWith(k)));
  const map = {};
  Object.keys(IMP_COLS).forEach(k => { map[k] = find(IMP_COLS[k]); });
  if(map.client < 0 || map.track < 0) return { error: 'В файле нет колонки «ФИО» или «ШПИ»' };
  const out = [];
  for(let r = head + 1; r < rows.length; r++){
    const row = rows[r] || [];
    const get = i => i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : '';
    const client = get(map.client);
    if(!client) continue; // пустая строка бланка — их в файле сотни
    out.push({
      line: r + 1,
      client,
      index: impIndex(get(map.index)),
      address: get(map.address),
      track: get(map.track),
      weight: parseWeight(get(map.weight)),
      sum: parseFloat(String(get(map.sum) || get(map.sum2)).replace(',', '.')) || 0,
      phone: impPhone(get(map.phone)),
      rawIndex: get(map.index),
      rawPhone: get(map.phone),
    });
  }
  return { rows: out, head };
}

// НАДБАВКИ ЗА ПЕРЕВЕС ЗДЕСЬ НЕТ. 08.10.2026 загрузка реестра начисляла её сама,
// 10.10.2026 владелец её убрал целиком: у Барахолки перевес не считается вовсе
// (weightSurcharge, js/11-zakazy.js).
//
// СУММА ЗАКАЗА — ИЗ ФАЙЛА, И ТОЛЬКО ПРИ НУЛЕВОМ ТАРИФЕ ПАРТНЁРА ОБНУЛЯЕТСЯ.
//
// Поправка владельца 10.10.2026, и она важнее, чем кажется: в реестре стоит УЖЕ
// ПОСЧИТАННАЯ цена доставки — тариф партнёра плюс надбавка за перевес. Его пример:
// тариф 1400, посылка на 2 кг тяжелее, в файл приходит 1520. Подставь мы сюда тариф из
// карточки — заказ стал бы 1400, то есть 120 ₸ потерялись бы на каждой тяжёлой посылке,
// и партнёру выставили бы меньше, чем он реально должен.
//
// Поэтому из карточки берётся НЕ ЦЕНА, А ПРИЗНАК: тариф ровно 0 означает, что партнёр
// платит за доставку отдельно, по счёту раз в месяц (раздел 5b), и в заказе должен стоять
// ноль, что бы ни стояло в файле. Во всех остальных случаях сумма файла — это и есть цена
// заказа, трогать её нельзя.
function impOrderSum(r, pt){
  if(pt && typeof isExplicitZero === 'function' && isExplicitZero(pt.tariff_post)) return 0;
  return r.sum || 0;
}
// Что сделаем с суммой — для подписи в предпросмотре. Обнуление цены в чужом реестре
// человек должен увидеть ДО создания заказов, а не искать потом по карточкам.
function impSumSource(pt){
  return (pt && typeof isExplicitZero === 'function' && isExplicitZero(pt.tariff_post))
    ? 'zero' : 'file';
}
// УСЛОВНАЯ ВЫРУЧКА при нулевом тарифе — то, что Калькуляция посчитает вместо нуля
// (`order_sum_orig`, правило «оплачено отправителем» в `calcOrder`). Вопрос владельца
// 10.10.2026: «как сделать, чтобы калькуляция считала верно — он платит заказы по 0,
// но сумма чтобы считалась».
//
// Берём СУММУ ИЗ ФАЙЛА, а не «условную сумму» из карточки: в файле стоит цена этого
// конкретного заказа вместе с надбавкой за перевес (1520 там, где тариф 1400), и
// по счёту в конце месяца партнёр заплатит именно её. Фиксированное число из карточки
// — грубее: оно одно на все заказы и перевес не знает. Оно и остаётся запасным
// вариантом, когда в файле суммы нет вовсе.
function impNotional(r, pt){
  if(!pt || typeof isExplicitZero !== 'function' || !isExplicitZero(pt.tariff_post)) return null;
  if(r.sum) return r.sum;
  return pt.direct_pay_amount != null && pt.direct_pay_amount !== '' ? +pt.direct_pay_amount : null;
}

// Что мешает создать заказ. Возвращаем причину или пусто.
/* ТРЕК СРАВНИВАЕМ ПО ОДНОМУ ПРАВИЛУ (20.10.2026, просьба владельца «в Барахолке прям
   сделай так, чтобы исключить дубль в трек-номерах, пусть проверяет прям, что грузим»).

   Из чужих реестров один и тот же номер приходит в разном виде: `qs013822592kz`,
   `QS013822592KZ`, иногда с пробелом внутри или по краям. Строковое сравнение считало их
   РАЗНЫМИ номерами, и дубль проходил проверку насквозь. То же правило стоит в поиске
   повторов по гриду (`tdupKey`, js/14), и расходиться им нельзя. */
const impTrackKey = t => String(t || '').replace(/\s+/g, '').toUpperCase();

/* Что мешает создать заказ. Возвращаем причину или пусто.

   ДУБЛЬ ВНУТРИ САМОГО ФАЙЛА — ЭТО БЫЛА НАСТОЯЩАЯ ДЫРА, и её не видел никто. Проверка
   смотрела только в базу: если один трек стоял в реестре ДВАЖДЫ, обе строки проходили
   «создать», и заказов создавалось два — с одним треком на двоих. Ловил бы это только
   уникальный индекс `orders_track_uniq` (db/20), а он не выполнен. */
function impProblem(r, seenTracks, fileSeen){
  if(r.phone.length < 10) return 'телефон неполный: ' + (r.rawPhone || 'пусто');
  if(!r.track) return 'нет трек-номера';
  const key = impTrackKey(r.track);
  if(fileSeen && fileSeen.has(key)) return 'такой трек уже есть выше в этом файле (строка ' + fileSeen.get(key) + ')';
  if(seenTracks.has(key)) return 'такой трек уже есть в системе';
  if(!r.index) return 'нет индекса';
  return '';
}

async function importOrdersFromExcel(){
  if(!window.XLSX){ toast('Библиотека Excel ещё загружается, попробуйте снова'); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.xls,.xlsx,.xlsm';
  inp.onchange = async () => {
    const file = (inp.files || [])[0]; if(!file) return;
    let wb;
    try{
      const buf = await file.arrayBuffer();
      wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    }catch(e){ console.error(e); toast('Не удалось прочитать файл'); return; }
    const parsed = impReadSheet(wb);
    if(parsed.error){ toast(parsed.error, 6000); return; }
    if(!parsed.rows.length){ toast('В файле нет строк с ФИО'); return; }
    const dbTracks = await impExistingTracks(parsed.rows.map(r => r.track));
    impPreviewModal(file.name, parsed.rows, dbTracks);
  };
  inp.click();
}

// Какие из этих треков уже есть в базе. Запросом, а не по S.orders: сразу после входа
// в памяти вкладки лежат только СЕГОДНЯШНИЕ заказы, и дубль за прошлую неделю в
// предпросмотре не подсвечивался — он молча отваливался уже при сохранении, и человек
// видел только «пропущено: 14» без объяснения.
// Дробим по 100: адрес запроса не резиновый.
async function impExistingTracks(tracks){
  const out = new Set();
  /* Спрашиваем базу СРАЗУ В ТРЁХ ВИДАХ — как в файле, в верхнем и в нижнем регистре.
     `.in('track', …)` сравнивает строкой, и трек, лежащий в базе прописными, по
     строчному из файла просто не нашёлся бы: дубль тогда виден только базе, а она о нём
     молчит, пока не выполнен db/20. */
  const list = [...new Set(tracks.filter(Boolean).flatMap(t => {
    const v = String(t).trim();
    return [v, v.toUpperCase(), v.toLowerCase()];
  }))];
  for(let i = 0; i < list.length; i += 100){
    const part = list.slice(i, i + 100);
    try{
      const { data, error } = await sb.from('orders').select('track,code').in('track', part);
      if(error) throw error;
      (data || []).forEach(x => out.add(impTrackKey(x.track)));
    }catch(e){
      console.error('import dup check', e);
      // Проверку не выполнили — молчать нельзя: иначе предпросмотр покажет «создам все»,
      // а половина отвалится на уникальном индексе трека (db/20).
      toast('Не удалось проверить дубли по базе — показываю только по загруженным заказам', 7000);
      return null;
    }
  }
  return out;
}
// Итог загрузки: сколько создано и ЧТО ИМЕННО не загрузилось, с причиной и треком.
// Просьба владельца 02.10.2026: «пиши какие заказы не загрузились, если есть дубли».
// Раньше был один тост «пропущено: 14», в котором четыре разные причины складывались
// в одно число, а сами строки нигде не перечислялись.
function impResultModal(fileName, made, skipped){
  const byReason = {};
  skipped.forEach(r => { (byReason[r.problem] = byReason[r.problem] || []).push(r); });
  const plain = skipped.map(r => `${r.track || 'без трека'}\t${r.client || ''}\t${r.problem}`).join('\n');
  showInfo('Загрузка завершена', `
    <p class="imp-note">Файл: <b>${esc(fileName)}</b> · создано заказов: <b>${made}</b>${
      skipped.length ? ` · не загрузилось: <b style="color:var(--rust)">${skipped.length}</b>` : ''}</p>
    ${!skipped.length ? '<div class="hint">Все строки загружены.</div>' : `
      ${Object.entries(byReason).map(([why, list]) => `
        <div class="panel" style="margin-bottom:12px">
          <div class="panel-head"><h2 style="font-size:15px">${esc(why)}</h2><span class="count">${list.length}</span></div>
          <div class="table-scroll"><table class="resp-table"><thead><tr>
            <th>Стр.</th><th>Трек</th><th>ФИО</th><th>Телефон</th>
          </tr></thead><tbody>
            ${list.map(r => `<tr>
              <td data-label="Стр.">${r.line}</td>
              <td data-label="Трек">${esc(r.track || '—')}</td>
              <td data-label="ФИО">${esc(r.client || '—')}</td>
              <td data-label="Телефон">${esc(r.phone || r.rawPhone || '—')}</td>
            </tr>`).join('')}
          </tbody></table></div>
        </div>`).join('')}
      <button class="btn ghost sm" id="impCopySkipped">📋 Скопировать список</button>
      <div class="hint" style="margin-top:8px">Список можно отправить партнёру: трек, ФИО и причина по каждой строке.</div>`}`,
    { wide: true });
  const btn = $('impCopySkipped');
  if(btn) btn.onclick = async () => {
    try{ await navigator.clipboard.writeText(plain); toast('Скопировано'); }
    catch(e){ toast('Не удалось скопировать — выделите таблицу вручную'); }
  };
}

// ДАТА ЗАБОРА ОПРЕДЕЛЯЕТ МЕСЯЦ РАСЧЁТА. Калькуляция берёт месяц по pickup_date
// (ordersInOrderMonth), поэтому реестр, загруженный в октябре с сентябрьской датой,
// уходит в СЕНТЯБРЬ — в месяц, который может быть уже закрыт и выплачен.
//
// Так и вышло 02.10.2026: 51 заказ, загруженный в октябре, лёг в сентябрь, и владелец
// заметил это только по запросу к базе. В окне загрузки дата подставляется сегодняшняя,
// но её меняют руками, и ничего об этом не предупреждало.
//
// Жёстко не запрещаем: бывает, что заказ правда нужно отнести к прошлому месяцу.
// Названия в ИМЕНИТЕЛЬНОМ: подставляются в «попадут в сентябрь 2026». С родительным
// («сентября») выходило «попадут в сентября» — подстрочник.
const IMP_MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август',
  'сентябрь','октябрь','ноябрь','декабрь'];
function impMonthLabel(d){
  const p = String(d || '').slice(0, 10).split('-');
  if(p.length < 3) return '';
  return `${IMP_MONTHS[+p[1] - 1] || p[1]} ${p[0]}`;
}
// Пусто — дата из текущего месяца, предупреждать не о чем.
function impOtherMonth(d){
  const cur = localToday().slice(0, 7);
  const got = String(d || '').slice(0, 7);
  return (got && got !== cur) ? impMonthLabel(d) : '';
}

function impPreviewModal(fileName, rows, dbTracks){
  // В списке — ТОЛЬКО партнёры Барахолки: загрузка реестра живёт в её модуле, и заказы
  // здесь создаются с её меткой. Партнёр без галочки увёл бы их в «Заказы заборов», то
  // есть ровно в ту мешанину, из-за которой модуль и делали (раздел 5f).
  //
  // Если галочек нет НИ У КОГО — показываем всех, как раньше: это значит, что db/13 не
  // выполнен и раздела Барахолки в базе нет вовсе. Пустой список был бы тупиком: ни
  // загрузить, ни понять почему.
  const barPartners = (S.partners || []).filter(p => p.is_baraholka);
  const onlyBar = barPartners.length > 0;
  const pool = onlyBar ? barPartners : (S.partners || []);
  // Партнёра подставляем по имени файла, если совпал: «ИП Азилжан 25.09.26.xls».
  // Ищем в том же списке, что показываем, — иначе угадали бы того, кого в списке нет.
  const guess = pool.find(p => normName(fileName).includes(normName(p.name))) || null;
  let partnerId = guess ? guess.id : '';
  let date = localToday();
  let busy = false;
  // dbTracks — что уже есть в базе (null, если проверку не выполнили). Запасной вариант —
  // по памяти вкладки, как было раньше: лучше неполная проверка, чем никакой.
  const seen = dbTracks || new Set((S.orders || []).map(o => impTrackKey(o.track)).filter(Boolean));

  const body = () => {
    const pt = pool.find(p => p.id === partnerId) || null;
    /* Набор встреченных в ФАЙЛЕ строится заново на каждую отрисовку: `body()` зовётся
       при каждой смене партнёра и даты, и накопленный снаружи набор пометил бы дублями
       все строки подряд уже со второго раза. */
    const fileSeen = new Map();
    const marked = rows.map(r => {
      const problem = impProblem(r, seen, fileSeen);
      const key = impTrackKey(r.track);
      if(key && !problem) fileSeen.set(key, r.line);   // запоминаем только принятые
      return { ...r, problem };
    });
    const ok = marked.filter(r => !r.problem);
    const bad = marked.filter(r => r.problem);
    const dupInFile = bad.filter(r => /в этом файле/.test(r.problem)).length;
    const dupInDb = bad.filter(r => r.problem === 'такой трек уже есть в системе').length;
    return `
      <div class="imp-head">
        <div class="field"><label>Партнёр <span style="color:var(--rust)">*</span></label>
          <select id="impPartner"><option value="">— выберите —</option>
            ${pool.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''))
              .map(p => `<option value="${p.id}" ${partnerId === p.id ? 'selected' : ''}>${esc(p.name)}${(!onlyBar && p.is_baraholka) ? ' · Барахолка' : ''}</option>`).join('')}
          </select>
          <small style="color:var(--muted);font-size:12px">${onlyBar
            ? 'Только партнёры Барахолки. Нет нужного — поставьте галочку «Барахолка» в его карточке.'
            : 'Галочка «Барахолка» не стоит ни у одного партнёра — показаны все.'}</small></div>
        <div class="field"><label>Дата забора</label><input type="date" id="impDate" value="${esc(date)}"></div>
      </div>
      <p class="imp-note">
        Файл: <b>${esc(fileName)}</b> · строк с ФИО: <b>${rows.length}</b> ·
        создам: <b>${ok.length}</b>${bad.length ? ` · пропущу: <b>${bad.length}</b>` : ''}
        ${(dupInFile || dupInDb) ? `<br><b style="color:var(--rust)">Дубли трек-кода:</b>${
          dupInDb ? ` уже в системе — <b>${dupInDb}</b>` : ''}${
          (dupInDb && dupInFile) ? ' ·' : ''}${
          dupInFile ? ` повтор внутри файла — <b>${dupInFile}</b>` : ''}. Эти строки не создадутся;
          какие именно — в таблице ниже и в итоге после загрузки.` : ''}
        ${pt ? `<br>Тип доставки — почтовая. Менеджер продаж и обработчик возьмутся из карточки партнёра${pt.is_baraholka ? ', раздел — Барахолка' : ''}.` : ''}
        ${pt && impSumSource(pt) === 'file'
          ? `<br>Сумма заказа — как в файле: там уже посчитана цена доставки с надбавкой за перевес,
             и CRM её не пересчитывает.`
          : ''}
      </p>
      ${pt && impSumSource(pt) === 'zero' ? (() => {
        // Деньги не теряются, а переезжают в «условную выручку»: в заказе 0, в Калькуляции
        // — сумма из файла. Пишем это числом, иначе обнуление выглядит потерей.
        const withSum = ok.filter(r => r.sum).length;
        const noSum = ok.length - withSum;
        const total = ok.reduce((a, r) => a + (impNotional(r, pt) || 0), 0);
        return `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ Тариф у партнёра «${esc(pt.name)}» — <b>0</b>: доставку он оплачивает отдельно, по счёту.
        Поэтому в самих заказах будет <b>0 ₸</b> и отметка «Оплачено отправителем», а в Калькуляцию
        уйдёт условная выручка — сумма из файла по каждому заказу, всего
        <b>${total.toLocaleString('ru-RU')} ₸</b>.
        ${noSum ? `У ${noSum} ${noSum === 1 ? 'строки' : 'строк'} суммы в файле нет — ${
          pt.direct_pay_amount != null && pt.direct_pay_amount !== ''
            ? `для них возьму условную сумму <b>${(+pt.direct_pay_amount).toLocaleString('ru-RU')} ₸</b> из карточки.`
            : `а условная сумма в карточке не задана, и в Калькуляции они будут чистым убытком.`}` : ''}</div>`;
      })() : ''}
      ${impOtherMonth(date) ? `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ Дата забора — <b>${esc(fmtDate(date))}</b>, а это не текущий месяц. В Калькуляции и в
        отчёте эти заказы лягут в <b>${esc(impOtherMonth(date))}</b>, а не в текущий месяц.
        Если тот месяц уже закрыт и выплачен, цифры по нему изменятся.</div>` : ''}
      ${pt && !pt.is_baraholka ? `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ У партнёра «${esc(pt.name)}» не стоит галочка «Барахолка», поэтому заказы попадут
        не сюда, а в «Заказы заборов» — и смешаются с обычными. Если это реестр Барахолки,
        сначала поставьте галочку в карточке партнёра.</div>` : ''}
      <div class="table-scroll imp-table"><table class="resp-table"><thead><tr>
        <th>Стр.</th><th>ФИО</th><th>Телефон</th><th>Индекс</th><th>Трек</th><th>Вес</th><th>Сумма</th><th>Что будет</th>
      </tr></thead><tbody>
        ${marked.map(r => `<tr class="${r.problem ? 'imp-bad' : ''}">
          <td data-label="Стр.">${r.line}</td>
          <td data-label="ФИО">${esc(r.client)}</td>
          <td data-label="Телефон">${esc(r.phone || r.rawPhone || '—')}</td>
          <td data-label="Индекс">${esc(r.index || '—')}${r.rawIndex && r.index !== r.rawIndex ? `<small class="cell-time">было ${esc(r.rawIndex)}</small>` : ''}</td>
          <td data-label="Трек">${esc(r.track || '—')}</td>
          <td data-label="Вес">${isNaN(r.weight) || r.weight == null ? '—' : esc(fmtWeight(r.weight))}</td>
          <td data-label="Сумма">${pt && impSumSource(pt) === 'zero'
            ? `<b>0 ₸</b><small class="cell-time">${impNotional(r, pt)
                ? 'в Калькуляцию ' + esc(impNotional(r, pt).toLocaleString('ru-RU')) + ' ₸'
                : 'в Калькуляцию ничего — суммы нет'}</small>`
            : (r.sum ? esc(r.sum.toLocaleString('ru-RU')) + ' ₸' : '—')}</td>
          <td data-label="Что будет">${r.problem ? `<span class="imp-skip">пропуск · ${esc(r.problem)}</span>` : '<span class="imp-ok">создать</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
  };

  showModal('Загрузка заказов из Excel', body(), async () => {
    if(busy) return false;
    const pt = pool.find(p => p.id === partnerId);
    if(!pt){ toast('Выберите партнёра'); return false; }
    // Дата не из текущего месяца — спрашиваем отдельно и называем месяц прямо.
    const otherMonth = impOtherMonth(date);
    if(otherMonth && !confirm(`Дата забора ${fmtDate(date)} — заказы попадут в ${otherMonth},\n`
      + `а не в текущий месяц.\n\nЕсли этот месяц уже закрыт и выплачен, его цифры в Калькуляции\n`
      + `и в отчёте изменятся.\n\nСоздать заказы с этой датой?`)) return false;
    // Причину пропуска запоминаем по каждой строке — в конце она попадёт в итог.
    // Раньше тут считалась только разница чисел, и четыре разные причины складывались
    // в одно «пропущено: 14».
    const fileSeen = new Map();
    const marked = rows.map(r => {
      const problem = impProblem(r, seen, fileSeen);
      const key = impTrackKey(r.track);
      if(key && !problem) fileSeen.set(key, r.line);
      return { ...r, problem };
    });
    const ok = marked.filter(r => !r.problem);
    const skipped = marked.filter(r => r.problem);
    if(!ok.length){ toast('Создавать нечего — все строки пропущены'); impResultModal(fileName, 0, skipped); return false; }
    // Трек уникален, и это единственная защита от повторной загрузки того же файла.
    // Проверяем ПО БАЗЕ ещё раз, уже перед записью: между открытием окна и нажатием
    // кнопки реестр мог загрузить кто-то другой.
    const exists = (await impExistingTracks(ok.map(r => r.track))) || new Set();
    /* ПОСЛЕДНИЙ РУБЕЖ ПЕРЕД ЗАПИСЬЮ. Отсеиваем и то, что появилось в базе, пока окно было
       открыто, и повтор внутри самой пачки — `impProblem` его уже поймал, но этот проход
       идёт по ключу и не зависит от того, что показали на экране. Дальше в базу уходит
       заведомо уникальный по треку список, даже если db/20 не выполнен. */
    const fresh = [], seenNow = new Set();
    ok.forEach(r => {
      const key = impTrackKey(r.track);
      if(exists.has(key)){ skipped.push({ ...r, problem: 'такой трек уже есть в системе' }); return; }
      if(seenNow.has(key)){ skipped.push({ ...r, problem: 'такой трек уже есть выше в этом файле' }); return; }
      seenNow.add(key); fresh.push(r);
    });
    if(!fresh.length){ toast('Все эти заказы уже загружены'); impResultModal(fileName, 0, skipped); return false; }
    busy = true;
    // ЗАРАНЕЕ ВЫДАННЫЕ БЛАНКИ. Если этот трек мы сами выпустили и отдали партнёру
    // (db/17), заказ должен сесть НА ТОТ ЖЕ номер: Казпочта выдала ШПИ именно под него,
    // и новый код развёл бы их между собой — у неё один номер заказа, у нас другой.
    const poolByTrack = new Map();
    try{
      const { data } = await sb.from('track_pool').select('id,code,track,amount,post_ip_id')
        .in('track', fresh.map(r => r.track)).is('order_id', null);
      (data || []).forEach(x => poolByTrack.set(impTrackKey(x.track), x));
    }catch(e){ console.error('pool lookup', e); } // таблицы может не быть — тогда как раньше
    const mail = (S.delivery || []).find(d => /почт/i.test(d.name || ''));
    const bar = (typeof baraholkaReady === 'function' && baraholkaReady());
    const now = new Date().toISOString();
    // Тариф 0 — партнёр платит за доставку сам, по счёту: ставим «Оплачено отправителем»
    // и условную выручку из карточки. Ровно то же делают создание заказов по заявке
    // (js/11) и кабинет партнёра (js/08) — правило в системе должно быть одно.
    const zeroTariff = typeof isExplicitZero === 'function' && isExplicitZero(pt.tariff_post);
    const built = fresh.map(r => {
      const pool = poolByTrack.get(impTrackKey(r.track));
      const sum = impOrderSum(r, pt);
      return {
      code: pool ? pool.code : genOrderCode(),
      partner_id: pt.id,
      sender: pt.name,
      client: r.client,
      phone: r.phone,
      address: r.address,
      index: r.index,
      track: r.track,
      weight: (isNaN(r.weight) || r.weight == null) ? null : r.weight,
      // Сумма из файла как есть; ноль пишем именно нулём, а не null, только когда его
      // поставил нулевой тариф: у партнёра «по счёту раз в месяц» это настоящая цена
      // заказа, а не «не заполнено». Пустая сумма в файле так и остаётся пустой.
      order_sum: zeroTariff ? 0 : (sum || null),
      cost: zeroTariff ? 0 : (sum || null),
      paid_by_sender: zeroTariff,
      // Условная выручка — сумма ЭТОГО заказа из файла (impNotional): в заказе ноль, а
      // Калькуляция считает по ней. Иначе обнуление превращало бы месяц в чистый убыток.
      order_sum_orig: impNotional(r, pt),
      delivery_id: mail ? mail.id : null,
      pickup_date: date,
      pickup_city_id: pt.city_id || null,
      sales_id: pt.sales_id || null,
      processor_id: pt.processor_id || null,
      status_id: defaultOrderStatusId(),
      qty: 1, size: 'S',
      // Заказ из реестра считается заполненным сразу: ФИО, адрес и телефон уже есть,
      // менеджеру с ним делать нечего — в очередь «Заполнения» он попадать не должен.
      ...(bar ? { calc_group: pt.is_baraholka ? 'baraholka' : null } : {}),
      ...((typeof salesMarginReady === 'function' && salesMarginReady() && pt.sales_id)
        ? { sales_margin: salesMarginFor({ sales_id: pt.sales_id, partner_id: pt.id,
            delivery_id: mail ? mail.id : null }, date.slice(0, 7)) } : {}),
      ...(typeof fillReady === 'function' && fillReady()
        ? { filled_at: now, filled_by: (S.me && S.me.id) || null,
            filled_by_name: 'загрузка из Excel' } : {}),
      // ИП с бланка, а не из настроек: бланк уже напечатан и переиграть его нечем
      ...(pool && pool.post_ip_id ? { post_ip_id: pool.post_ip_id } : {}),
    };});
    const made = await insertOrderRows(built);
    // Отмечаем в пуле, какой заказ сел на номер. Если не вышло — заказ уже создан и
    // работает, потеряется только отметка, поэтому молчать тут нельзя.
    if(poolByTrack.size && made.length){
      const nowIso = new Date().toISOString();
      let bound = 0;
      for(const o of made){
        const pool = poolByTrack.get(impTrackKey(o.track));
        if(!pool) continue;
        const { error } = await sb.from('track_pool')
          .update({ order_id: o.id, used_at: nowIso }).eq('id', pool.id);
        if(error) console.error('pool bind', error); else bound++;
      }
      if(bound) toast(`Из них по выданным бланкам: ${bound}`, 5000);
      if(bound < poolByTrack.size) toast('Часть бланков не отметилась в пуле — заказы созданы, проверьте раздел «Бланки»', 7000);
    }
    // Строки, которые отвалились уже на записи (например уникальный индекс трека),
    // тоже должны попасть в итог — иначе «создано 118 из 120» без объяснения.
    const madeTracks = new Set(made.map(o => impTrackKey(o.track)));
    fresh.filter(r => !madeTracks.has(impTrackKey(r.track))).forEach(r =>
      skipped.push({ ...r, problem: 'база отклонила запись — проверьте, нет ли такого трека' }));
    logAction('import', 'orders', { entity_label: fileName, meta: { created: made.length, skipped: skipped.length } });
    renderOrders(ordersMode);
    impResultModal(fileName, made.length, skipped);
    return true;
  }, { wide: true, saveLabel: 'Создать заказы' });

  // Смена партнёра перерисовывает разбор: от партнёра зависит раздел калькуляции
  // и подпись под таблицей. Поля после перерисовки — новые узлы, привязываем заново.
  const bindImp = () => {
    const p2 = $('impPartner');
    if(p2) p2.onchange = () => {
      partnerId = p2.value;
      const box = document.querySelector('.modal-body');
      if(box){ box.innerHTML = body(); bindImp(); }
    };
    const d2 = $('impDate');
    // Перерисовываем тело: предупреждение о чужом месяце должно появиться сразу, а не
    // всплыть только при нажатии «Создать заказы».
    if(d2) d2.onchange = () => {
      date = d2.value || localToday();
      const box = document.querySelector('.modal-body');
      if(box){ box.innerHTML = body(); bindImp(); }
    };
  };
  bindImp();
}

/* ============================================================
   БАРАХОЛКА: ЗАКАЗ СО СКАНЕРА (21.10.2026)

   Просьба владельца: «хочу, чтобы не только грузили заказы по экселю, но и создавали
   заказы внутри модуля Барахолка — добавь кнопку „Создать заказ": нажимаешь, сканируешь
   трек-номер штрих-кодером, заказ создаётся, трек автоматом встаёт в нужное место как
   карточка заказа, менеджеру надо заполнить только ФИО, индекс, адрес; все заказы
   почтовые; когда нажимаешь сохранить — надо, чтобы сразу почтовый бланк формировался;
   плюс добавь выборку партнёра после сканирования ШПИ».

   ШТРИХ-КОДЕР — ЭТО КЛАВИАТУРА. Он печатает код в поле, которое сейчас в фокусе, и жмёт
   Enter. Поэтому никакой камеры и никакой библиотеки не нужно: нужно лишь поле, которое
   УЖЕ в фокусе при открытии окна, и обработка Enter. Камеру телефона сюда добавлять не
   стали — просили именно сканер, а второй способ ввода одного и того же — это второй
   путь, который потом разойдётся с первым.

   ENTER НЕ СОЗДАЁТ ЗАКАЗ СРАЗУ, А ПЕРЕВОДИТ ФОКУС НА ПАРТНЁРА — ровно в том порядке, как
   просил владелец («выборку партнёра ПОСЛЕ сканирования»). Партнёр выбран и трек прочитан —
   второй Enter уже создаёт.

   КАРТОЧКА ОТКРЫВАЕТСЯ ОБЫЧНАЯ, своей формы под сканер нет. Иначе два экрана заказа
   разошлись бы на первой же правке — ровно как разошлись бы пять копий шапки модуля
   (раздел 4). Трек, тип доставки, партнёр и сумма приезжают в неё заготовкой
   (`orderPrefill` в js/11-zakazy.js), остальное менеджер заполняет руками.
   ============================================================ */

// Похоже ли на ШПИ Казпочты: две буквы, девять цифр, две буквы (QS013822592KZ).
const BAR_SPI_RE = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

async function barCreateOrderModal(){
  // Партнёры — только Барахолки, как в загрузке реестра. Если галочек нет ни у кого,
  // значит db/13 не выполнен: показываем всех, иначе список был бы тупиком.
  const barPartners = (S.partners || []).filter(p => p.is_baraholka);
  const onlyBar = barPartners.length > 0;
  const pool = (onlyBar ? barPartners : (S.partners || []))
    .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  if(!pool.length){ toast('Сначала заведите партнёра в разделе «Партнёры»', 6000); return; }
  const mail = (S.delivery || []).find(d => /почт/i.test(d.name || ''));

  const ov = showModal('Новый заказ Барахолки', `
    <div class="field full"><label>Трек-номер (ШПИ) <span style="color:var(--rust)">*</span></label>
      <input id="bscTrack" autocomplete="off" inputmode="text" placeholder="Отсканируйте штрих-код с бланка">
      <span class="hint">Поле уже в фокусе — просто сканируйте. Сканер сам нажмёт Enter,
        и фокус перейдёт на партнёра.</span>
      <div id="bscInfo" class="idx-info"></div></div>
    <div class="field full"><label>Партнёр <span style="color:var(--rust)">*</span></label>
      <select id="bscPartner"><option value="">— выберите —</option>
        ${pool.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <span class="hint">${onlyBar
        ? 'Только партнёры Барахолки — от партнёра зависят тариф, менеджер и обработчик.'
        : 'Галочка «Барахолка» не стоит ни у одного партнёра — показаны все.'}</span></div>
    <div class="field full"><label>Дата заказа</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="date" id="bscDate" value="${localToday()}" max="${localToday()}" style="flex:0 1 180px">
        <button type="button" class="btn sm ghost" id="bscToday">Сегодня</button>
        <button type="button" class="btn sm ghost" id="bscYday">Вчера</button>
      </div>
      <span class="hint">По ней считается МЕСЯЦ в Калькуляции. По умолчанию сегодняшняя.</span>
      <div id="bscDateInfo" class="idx-info"></div></div>
    <div class="hint" style="line-height:1.6">Заказ создастся <b>почтовым</b>. В карточке
      останется заполнить ФИО, индекс и адрес; после сохранения сразу откроется бланк Казпочты.</div>`,
    async () => {
      const el = $('bscTrack'), info = $('bscInfo');
      const track = impTrackKey(el ? el.value : '');
      if(!track){ toast('Отсканируйте или введите трек-номер'); if(el) el.focus(); return false; }
      const partnerId = ($('bscPartner') || {}).value || '';
      if(!partnerId){ toast('Выберите партнёра'); const ps = $('bscPartner'); if(ps) ps.focus(); return false; }
      const pt = (S.partners || []).find(p => p.id === partnerId);
      if(!pt){ toast('Партнёр не найден — обновите страницу'); return false; }
      /* ДАТА ЗАКАЗА = МЕСЯЦ РАСЧЁТА. Калькуляция берёт месяц по `pickup_date`
         (раздел 5a), поэтому чужой месяц здесь — это деньги в уже закрытом периоде.
         Ровно так 02.10.2026 уехал 51 заказ реестром. Спрашиваем отдельно, но НЕ
         запрещаем: бывает, что заказ правда нужно отнести к прошлому месяцу. */
      const orderDate = (($('bscDate') || {}).value || '').slice(0, 10) || localToday();
      const otherMonth = impOtherMonth(orderDate);
      if(otherMonth && !confirm(`Дата ${fmtDate(orderDate)} — это ${otherMonth}.\n\n`
        + `Заказ попадёт в расчёт за ${otherMonth}, а не за текущий месяц. Создать?`)) return false;
      if(!mail){ toast('В справочнике нет типа доставки «Почтовая» — заведите его в Настройках', 7000); return false; }

      /* ДУБЛЬ ПРОВЕРЯЕМ ДО СОЗДАНИЯ, запросом к базе и тем же ключом, что в загрузке
         реестра: один трек на две посылки — это один статус и одна претензия на двоих,
         а в памяти вкладки после входа лежат только сегодняшние заказы. */
      if(info) info.innerHTML = '<span class="idx-wait">проверяем трек по базе…</span>';
      const exists = await impExistingTracks([track]);
      if(exists === null){ if(info) info.innerHTML = ''; return false; }   // своё сообщение уже показано
      if(exists.has(track)){
        if(info) info.innerHTML = '<span class="idx-bad">⚠ Такой трек уже есть у другого заказа — '
          + 'найдите его поиском и проверьте, какой из них верный</span>';
        return false;
      }
      if(info) info.innerHTML = '';

      /* ЗАРАНЕЕ ВЫДАННЫЙ БЛАНК. Если этот ШПИ мы сами выпустили и отдали партнёру (db/17),
         заказ обязан сесть НА ТОТ ЖЕ номер: Казпочта выдала ШПИ именно под него, и новый
         код развёл бы их между собой — у неё один номер заказа, у нас другой. Та же
         логика, что в загрузке реестра. */
      let poolRow = null;
      try{
        const { data } = await sb.from('track_pool').select('id,code,track,amount,post_ip_id')
          .eq('track', track).is('order_id', null).limit(1);
        poolRow = (data || [])[0] || null;
      }catch(e){ console.error('pool lookup', e); }   // таблицы может не быть — тогда как раньше

      /* СУММА — ПО ТАРИФУ ПАРТНЁРА, как у заказов из заявки. Тариф ровно 0 означает «платит
         отдельно, по счёту раз в месяц» (раздел 5b): в заказе ноль и отметка «Оплачено
         отправителем», а в Калькуляцию идёт условная выручка. Файла здесь нет, поэтому
         условную берём из карточки партнёра (`direct_pay_amount`) — другого источника у
         ручного заказа и нет. */
      const zero = typeof isExplicitZero === 'function' && isExplicitZero(pt.tariff_post);
      const tariff = (pt.tariff_post != null && pt.tariff_post !== '') ? +pt.tariff_post : '';
      const notional = (pt.direct_pay_amount != null && pt.direct_pay_amount !== '') ? +pt.direct_pay_amount : null;
      const sum = zero ? 0 : tariff;
      orderPrefill = {
        track,
        pickup_date: orderDate,
        delivery_id: mail.id,
        partner_id: pt.id,
        sender: pt.name,
        pickup_city_id: pt.city_id || null,
        sales_id: pt.sales_id || null,
        processor_id: pt.processor_id || null,
        // Карточка читает сумму из `order_sum` (поле «Сумма заказа»), а `cost` — его копия
        // в базе: пишем оба, иначе поле открылось бы пустым.
        order_sum: sum, cost: sum, qty: 1, size: 'S',
        /* Признак раздела — чтобы карточка СРАЗУ знала, что это Барахолка: по нему она
           прячет фото, город забора, размер пакета, тип доставки, ИП и дату оплаты. При
           сохранении он всё равно пересчитывается от партнёра (js/11), так что это не
           второй источник правды, а подсказка открывающейся карточке. */
        calc_group: pt.is_baraholka ? 'baraholka' : null,
        paid_by_sender: zero,
        ...(zero && notional != null ? { order_sum_orig: notional } : {}),
        ...(poolRow ? { code: poolRow.code, ...(poolRow.post_ip_id ? { post_ip_id: poolRow.post_ip_id } : {}) } : {}),
        /* ПОСЛЕ СОХРАНЕНИЯ — СРАЗУ БЛАНК (просьба владельца). Печать идёт по уже
           СОХРАНЁННОМУ заказу, а не по тому, что набрано в полях: на бланк уходят ФИО,
           адрес, индекс и сумма, и печатать надо ровно то, что записано в базу.
           Заодно отмечаем выданный бланк использованным — иначе он остался бы свободным
           и мог уехать на второй заказ. */
        _afterSave: async (saved) => {
          if(poolRow){
            try{
              await sb.from('track_pool').update({ order_id: saved.id, used_at: new Date().toISOString() })
                .eq('id', poolRow.id);
            }catch(e){ console.error('pool bind', e); toast('Заказ создан, но бланк в пуле не отметился', 6000); }
          }
          /* Печатаем СРАЗУ 100×150: на складе термопринтер с этикеткой 100×150 мм,
             и лист A4 на нём приходится подгонять масштабом руками. */
          if(typeof printMailLabelsPdf === 'function') await printMailLabelsPdf([saved],'label');
        },
      };
      orderModal();
      return true;
    }, { saveLabel: 'Далее — карточка заказа' });

  /* ПОЛЕ ДАТЫ СТОИТ ПОСЛЕ ПАРТНЁРА, И ЭТО НЕ ПОРЯДОК «ПО СМЫСЛУ». `showModal` ставит
     фокус в ПЕРВОЕ поле окна, а туда печатает сканер: поставь дату первой — и штрих-код
     уехал бы в неё. По той же причине у кнопок `type="button"`. */
  const dateEl = ov.querySelector('#bscDate');
  const dateNote = () => {
    const box = ov.querySelector('#bscDateInfo'); if(!box) return;
    const other = impOtherMonth(dateEl ? dateEl.value : '');
    box.innerHTML = other
      ? `<span class="idx-bad">⚠ заказ попадёт в расчёт за ${esc(other)}, а не за текущий месяц</span>`
      : '';
  };
  if(dateEl) dateEl.onchange = dateNote;
  const setDate = d => { if(dateEl){ dateEl.value = d; dateNote(); } };
  const tdBtn = ov.querySelector('#bscToday'); if(tdBtn) tdBtn.onclick = () => setDate(localToday());
  const ydBtn = ov.querySelector('#bscYday');  if(ydBtn) ydBtn.onclick  = () => setDate(localDaysAgo(1));

  // Фокус на поле трека ставит сам `showModal` (первое поле окна) — сканер печатает туда,
  // куда смотрит курсор, и ждать нажатия мышью значило бы получить код в пустоту.
  const tr = ov.querySelector('#bscTrack');
  if(tr) tr.onkeydown = e => {
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const val = impTrackKey(tr.value);
    const info = ov.querySelector('#bscInfo');
    // Не похоже на ШПИ — говорим, но НЕ запрещаем: формат у Казпочты может смениться,
    // а бланк уже напечатан и посылка сдана.
    if(info) info.innerHTML = (val && !BAR_SPI_RE.test(val))
      ? '<span class="idx-type">не похоже на ШПИ Казпочты (QS013822592KZ) — проверьте, что сканер прочитал код целиком</span>'
      : '';
    const ps = ov.querySelector('#bscPartner');
    if(ps && !ps.value){ ps.focus(); return; }     // сначала партнёр — как и просили
    // Кнопку берём В СВОЁМ окне, а не первую на странице: модалок бывает несколько
    // (карточка заказа поверх списка), и общий селектор нажал бы чужую.
    const btn = ov.querySelector('[data-save]');
    if(btn) btn.click();
  };
}
