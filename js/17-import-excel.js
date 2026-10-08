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

// НАДБАВКА ЗА ПЕРЕВЕС — начисляется прямо здесь, при загрузке реестра (просьба
// владельца 08.10.2026). В карточке она считается сама (weightSurcharge, js/11), но
// карточки этих заказов никто не открывает: их сотни, и приходят они готовыми.
//
// ПРИБАВЛЯЕМ К СУММЕ ИЗ ФАЙЛА — решение владельца. Ни размера пакета, ни тарифной
// цены в реестре нет, есть ровно колонка суммы, и она же становится суммой заказа.
//
// Если суммы в файле нет, надбавку НЕ начисляем: прибавлять её не к чему, а одна
// надбавка в поле суммы (100 ₸ вместо цены доставки) выглядела бы как настоящая цена
// и попала бы в выручку Калькуляции. Такие строки видно в предпросмотре отдельно.
//
// Ставка — своя у Барахолки, общая у остальных: это решает weightSurcharge по третьему
// аргументу. Тип доставки у реестра всегда почтовый, поэтому isCourier здесь false.
function impSurcharge(r, pt){
  if(!r.sum) return 0;
  if(typeof weightSurcharge !== 'function') return 0;
  return weightSurcharge(r.weight, false, !!(pt && pt.is_baraholka));
}
// Вес за порогом, а суммы в файле нет — надбавку начислить некуда. Строка создаётся,
// но об этом сказано в предпросмотре: молча потерянная надбавка — это недовыставленный счёт.
function impSurchargeLost(r, pt){
  if(r.sum) return false;
  if(typeof weightSurcharge !== 'function') return false;
  return weightSurcharge(r.weight, false, !!(pt && pt.is_baraholka)) > 0;
}
// Сумма, которая запишется в заказ: из файла плюс перевес.
const impTotal = (r, pt) => (r.sum || 0) + impSurcharge(r, pt);

// Что мешает создать заказ. Возвращаем причину или пусто.
function impProblem(r, seenTracks){
  if(r.phone.length < 10) return 'телефон неполный: ' + (r.rawPhone || 'пусто');
  if(!r.track) return 'нет трек-номера';
  if(seenTracks.has(r.track)) return 'такой трек уже есть в системе';
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
  const list = [...new Set(tracks.filter(Boolean))];
  for(let i = 0; i < list.length; i += 100){
    const part = list.slice(i, i + 100);
    try{
      const { data, error } = await sb.from('orders').select('track,code').in('track', part);
      if(error) throw error;
      (data || []).forEach(x => out.add(String(x.track || '').trim()));
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
  const seen = dbTracks || new Set((S.orders || []).map(o => String(o.track || '').trim()).filter(Boolean));

  const body = () => {
    const pt = pool.find(p => p.id === partnerId) || null;
    const marked = rows.map(r => ({ ...r, problem: impProblem(r, seen) }));
    const ok = marked.filter(r => !r.problem);
    const bad = marked.filter(r => r.problem);
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
        ${pt ? `<br>Тип доставки — почтовая. Менеджер продаж и обработчик возьмутся из карточки партнёра${pt.is_baraholka ? ', раздел — Барахолка' : ''}.` : ''}
        ${(() => {
          // Перевес называем числом и суммой: надбавка меняет деньги, и видеть её надо
          // ДО создания заказов, а не искать потом по карточкам.
          const rows = ok.filter(r => impSurcharge(r, pt) > 0);
          if(!rows.length) return '';
          const total = rows.reduce((a, r) => a + impSurcharge(r, pt), 0);
          const free = pt && pt.is_baraholka ? barPriceNorm('weight_free_kg') : priceNorm('weight_free_kg');
          const fee  = pt && pt.is_baraholka ? barPriceNorm('weight_step_fee') : priceNorm('weight_step_fee');
          return `<br>Перевес: надбавка у <b>${rows.length}</b> заказов на <b>${total.toLocaleString('ru-RU')} ₸</b>`
            + ` — по ${fee} ₸ за каждый начатый кг свыше ${String(free).replace('.', ',')} кг`
            + `${pt && pt.is_baraholka ? ' (ставка Барахолки)' : ''}. Прибавляется к сумме из файла.`;
        })()}
      </p>
      ${ok.some(r => impSurchargeLost(r, pt)) ? `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ У части строк вес больше порога, но суммы в файле нет — надбавку за перевес прибавить не к чему,
        и эти заказы создадутся без неё. Такие строки отмечены в таблице.</div>` : ''}
      ${impOtherMonth(date) ? `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ Дата забора — <b>${esc(fmtDate(date))}</b>, а это не текущий месяц. В Калькуляции и в
        отчёте эти заказы лягут в <b>${esc(impOtherMonth(date))}</b>, а не в текущий месяц.
        Если тот месяц уже закрыт и выплачен, цифры по нему изменятся.</div>` : ''}
      ${pt && !pt.is_baraholka ? `<div class="hint" style="color:var(--rust);margin:-4px 0 10px">
        ⚠️ У партнёра «${esc(pt.name)}» не стоит галочка «Барахолка», поэтому заказы попадут
        не сюда, а в «Заказы заборов» — и смешаются с обычными. Если это реестр Барахолки,
        сначала поставьте галочку в карточке партнёра.</div>` : ''}
      <div class="table-scroll imp-table"><table class="resp-table"><thead><tr>
        <th>Стр.</th><th>ФИО</th><th>Телефон</th><th>Индекс</th><th>Трек</th><th>Вес</th>
        <th>Сумма из файла</th><th>Перевес</th><th>Итого</th><th>Что будет</th>
      </tr></thead><tbody>
        ${marked.map(r => `<tr class="${r.problem ? 'imp-bad' : ''}">
          <td data-label="Стр.">${r.line}</td>
          <td data-label="ФИО">${esc(r.client)}</td>
          <td data-label="Телефон">${esc(r.phone || r.rawPhone || '—')}</td>
          <td data-label="Индекс">${esc(r.index || '—')}${r.rawIndex && r.index !== r.rawIndex ? `<small class="cell-time">было ${esc(r.rawIndex)}</small>` : ''}</td>
          <td data-label="Трек">${esc(r.track || '—')}</td>
          <td data-label="Вес">${isNaN(r.weight) || r.weight == null ? '—' : esc(fmtWeight(r.weight))}</td>
          <td data-label="Сумма из файла">${r.sum ? esc(r.sum.toLocaleString('ru-RU')) + ' ₸' : '—'}</td>
          <td data-label="Перевес">${impSurcharge(r, pt)
            ? '<b>+' + esc(impSurcharge(r, pt).toLocaleString('ru-RU')) + ' ₸</b>'
            : (impSurchargeLost(r, pt) ? '<span class="imp-skip">не начислю · в файле нет суммы</span>' : '—')}</td>
          <td data-label="Итого">${impTotal(r, pt) ? esc(impTotal(r, pt).toLocaleString('ru-RU')) + ' ₸' : '—'}</td>
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
    const marked = rows.map(r => ({ ...r, problem: impProblem(r, seen) }));
    const ok = marked.filter(r => !r.problem);
    const skipped = marked.filter(r => r.problem);
    if(!ok.length){ toast('Создавать нечего — все строки пропущены'); impResultModal(fileName, 0, skipped); return false; }
    // Трек уникален, и это единственная защита от повторной загрузки того же файла.
    // Проверяем ПО БАЗЕ ещё раз, уже перед записью: между открытием окна и нажатием
    // кнопки реестр мог загрузить кто-то другой.
    const exists = (await impExistingTracks(ok.map(r => r.track))) || new Set();
    const fresh = ok.filter(r => !exists.has(r.track));
    ok.filter(r => exists.has(r.track)).forEach(r => skipped.push({ ...r, problem: 'такой трек уже есть в системе' }));
    if(!fresh.length){ toast('Все эти заказы уже загружены'); impResultModal(fileName, 0, skipped); return false; }
    busy = true;
    // ЗАРАНЕЕ ВЫДАННЫЕ БЛАНКИ. Если этот трек мы сами выпустили и отдали партнёру
    // (db/17), заказ должен сесть НА ТОТ ЖЕ номер: Казпочта выдала ШПИ именно под него,
    // и новый код развёл бы их между собой — у неё один номер заказа, у нас другой.
    const poolByTrack = new Map();
    try{
      const { data } = await sb.from('track_pool').select('id,code,track,amount,post_ip_id')
        .in('track', fresh.map(r => r.track)).is('order_id', null);
      (data || []).forEach(x => poolByTrack.set(String(x.track || '').trim(), x));
    }catch(e){ console.error('pool lookup', e); } // таблицы может не быть — тогда как раньше
    const mail = (S.delivery || []).find(d => /почт/i.test(d.name || ''));
    const bar = (typeof baraholkaReady === 'function' && baraholkaReady());
    const now = new Date().toISOString();
    const built = fresh.map(r => {
      const pool = poolByTrack.get(String(r.track || '').trim());
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
      // Сумма из файла плюс надбавка за перевес — одной функцией, той же, что
      // показывала её в предпросмотре: разойдись они, в заказ ушло бы не то, что видели.
      order_sum: impTotal(r, pt) || null,
      cost: impTotal(r, pt) || null,
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
        const pool = poolByTrack.get(String(o.track || '').trim());
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
    const madeTracks = new Set(made.map(o => String(o.track || '').trim()));
    fresh.filter(r => !madeTracks.has(r.track)).forEach(r =>
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
