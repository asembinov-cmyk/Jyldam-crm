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
    impPreviewModal(file.name, parsed.rows);
  };
  inp.click();
}

function impPreviewModal(fileName, rows){
  // Партнёра подставляем по имени файла, если совпал: «ИП Азилжан 25.09.26.xls».
  const guess = (S.partners || []).find(p => normName(fileName).includes(normName(p.name))) || null;
  let partnerId = guess ? guess.id : '';
  let date = localToday();
  let busy = false;

  const body = () => {
    const pt = (S.partners || []).find(p => p.id === partnerId) || null;
    const seen = new Set((S.orders || []).map(o => String(o.track || '').trim()).filter(Boolean));
    const marked = rows.map(r => ({ ...r, problem: impProblem(r, seen) }));
    const ok = marked.filter(r => !r.problem);
    const bad = marked.filter(r => r.problem);
    return `
      <div class="imp-head">
        <div class="field"><label>Партнёр <span style="color:var(--rust)">*</span></label>
          <select id="impPartner"><option value="">— выберите —</option>
            ${(S.partners || []).slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''))
              .map(p => `<option value="${p.id}" ${partnerId === p.id ? 'selected' : ''}>${esc(p.name)}${p.is_baraholka ? ' · Барахолка' : ''}</option>`).join('')}
          </select></div>
        <div class="field"><label>Дата забора</label><input type="date" id="impDate" value="${esc(date)}"></div>
      </div>
      <p class="imp-note">
        Файл: <b>${esc(fileName)}</b> · строк с ФИО: <b>${rows.length}</b> ·
        создам: <b>${ok.length}</b>${bad.length ? ` · пропущу: <b>${bad.length}</b>` : ''}
        ${pt ? `<br>Тип доставки — почтовая. Менеджер продаж и обработчик возьмутся из карточки партнёра${pt.is_baraholka ? ', раздел — Барахолка' : ''}.` : ''}
      </p>
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
          <td data-label="Сумма">${r.sum ? esc(r.sum.toLocaleString('ru-RU')) + ' ₸' : '—'}</td>
          <td data-label="Что будет">${r.problem ? `<span class="imp-skip">пропуск · ${esc(r.problem)}</span>` : '<span class="imp-ok">создать</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
  };

  showModal('Загрузка заказов из Excel', body(), async () => {
    if(busy) return false;
    const pt = (S.partners || []).find(p => p.id === partnerId);
    if(!pt){ toast('Выберите партнёра'); return false; }
    const seen = new Set((S.orders || []).map(o => String(o.track || '').trim()).filter(Boolean));
    const ok = rows.filter(r => !impProblem(r, seen));
    if(!ok.length){ toast('Создавать нечего — все строки пропущены'); return false; }
    // Трек уникален, и это единственная защита от повторной загрузки того же файла.
    // Проверяем ПО БАЗЕ, а не по памяти вкладки: заказы мог создать кто-то другой.
    let exists = new Set();
    try{
      const { data } = await sb.from('orders').select('track').in('track', ok.map(r => r.track));
      (data || []).forEach(x => exists.add(String(x.track || '').trim()));
    }catch(e){ console.error('import dup check', e); }
    const fresh = ok.filter(r => !exists.has(r.track));
    if(!fresh.length){ toast('Все эти заказы уже загружены'); return false; }
    busy = true;
    const mail = (S.delivery || []).find(d => /почт/i.test(d.name || ''));
    const bar = (typeof baraholkaReady === 'function' && baraholkaReady());
    const now = new Date().toISOString();
    const built = fresh.map(r => ({
      code: genOrderCode(),
      partner_id: pt.id,
      sender: pt.name,
      client: r.client,
      phone: r.phone,
      address: r.address,
      index: r.index,
      track: r.track,
      weight: (isNaN(r.weight) || r.weight == null) ? null : r.weight,
      order_sum: r.sum || null,
      cost: r.sum || null,
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
    }));
    const made = await insertOrderRows(built);
    const skipped = rows.length - made.length;
    toast(`Создано заказов: ${made.length}${skipped ? ` · пропущено: ${skipped}` : ''}`, 6000);
    logAction('import', 'orders', { entity_label: fileName, meta: { created: made.length, skipped } });
    renderOrders(ordersMode);
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
    if(d2) d2.onchange = () => { date = d2.value || localToday(); };
  };
  bindImp();
}
