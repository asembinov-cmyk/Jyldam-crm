/* ================= РАССЫЛКА WhatsApp ПО ЗАКАЗАМ (19.10.2026) =================
   Просьба владельца: «рассылка ватсап сейчас в KET, может сами её к нам подключим».
   Шлём получателям два вида уведомлений — «трек и как забрать» по почтовым и
   «когда привезёт курьер» по курьерским, — кнопкой по заказам, отмеченным галочками.

   ПОЧЕМУ ТОЛЬКО ШАБЛОНЫ, А НЕ СВОБОДНЫЙ ТЕКСТ. WhatsApp разрешает произвольное
   сообщение только тому, кто написал нам сам за последние 24 часа (иначе Meta
   отвечает 131047 — «окно закрыто»). Получатель посылки нам не пишет никогда,
   поэтому любое наше уведомление — это шаблон, заранее одобренный Meta: текст
   фиксирован, меняются лишь подстановки {{1}}, {{2}}…

   ПОЭТОМУ ЖЕ ШАБЛОНЫ НЕ ЗАШИТЫ В КОД, А ЧИТАЮТСЯ ИЗ KELESU. Их правят и заводят в
   Meta Business Suite, и список в коде разошёлся бы с действительностью на первой же
   правке. Разметка параметров строится по ответу Kelesu: сколько в шаблоне {{N}} —
   столько строк и будет.

   КЛЮЧ ЛЕЖИТ В СЕКРЕТЕ Edge Function `kelesu-waba`, а не здесь: репозиторий
   публичный (раздел 9a), а по ключу Kelesu можно рассылать от нашего имени. */

const WA_CHUNK = 50;        // заказов за один вызов функции: дальше упираемся в её время
let waTemplates = null;     // список шаблонов; грузится раз за сеанс
let waSpecCache = {};       // подсказки по шаблону: что значит каждый {{N}}

/* Поля заказа, которые можно подставить в параметр шаблона. Берём их теми же
   функциями, что и остальная CRM (`orderSum`, `courierCityName`), — иначе в
   сообщении клиенту стояло бы одно число, а в гриде другое. */
const WA_FIELDS = [
  ['client',  'ФИО получателя',        o => o.client || ''],
  ['code',    'Номер заказа',          o => o.code || ''],
  ['track',   'Трек-номер',            o => o.track || ''],
  ['index',   'Индекс',                o => o.index || ''],
  ['city',    'Город назначения',      o => waCityOf(o)],
  ['address', 'Адрес получателя',      o => o.address || ''],
  ['sum',     'Сумма к оплате',        o => { const s = orderSum(o); return s ? String(Math.round(s)) : ''; }],
  ['deliver', 'Дата доставки',         o => o.deliver_date ? fmtDate(o.deliver_date) : ''],
  ['courier', 'Курьер — имя',          o => waCourier(o).fio],
  ['cphone',  'Курьер — телефон',      o => waCourier(o).phone],
  ['sender',  'Отправитель (партнёр)', o => (typeof orderPartnerLabel === 'function' ? orderPartnerLabel(o) : (o.sender || ''))],
];
const waFieldFn = key => (WA_FIELDS.find(f => f[0] === key) || [,, () => ''])[2];

/* ЧТО ПОДСТАВИТЬ В {{N}} — УГАДЫВАЕМ ПО ТЕКСТУ ВОКРУГ ПОДСТАНОВКИ. Шаблон пишет
   человек, и слово рядом почти всегда называет само поле: «Трек-номер: {{2}}»,
   «по индексу {{3}}», «Телефон курьера: {{4}}». Без этого пять выпадающих списков
   приходится выставлять руками на каждую рассылку, а ошибка в них уходит клиенту.

   Берём ближайшее совпадение, а не первое по списку: в «{{1}}, здравствуйте! Курьер
   привезёт…» есть и «здравствуйте», и «курьер», и по порядку в списке победил бы
   курьер — то есть в приветствие подставилось бы его имя.

   Это ДОГАДКА, и она не обязана быть верной: ровно поэтому под таблицей стоит
   предпросмотр по первому заказу — ошибку видно глазами до отправки. */
const WA_GUESS = [
  [/трек|шпи|tracker|track|бақылау/i, 'track'], // tracker — подстановка внутри ссылки «#tracker/{{N}}»
  [/индекс/i,                        'index'],
  [/город/i,                         'city'],
  [/адрес/i,                         'address'],
  [/телефон курьера|курьер[а-я]*[ :\u2014-]*\+?\d|номер курьера/i, 'cphone'],
  [/курьер/i,                        'courier'],
  [/сумм|оплат|₸|тенге|стоимост/i,   'sum'],
  [/дат|привез|числа|срок/i,         'deliver'], // без «доставк»: «Адрес доставки» — это адрес
  [/здравствуйте|добрый|уважаем|фио|получател|\bимя\b|сәлеметсіз|қайырлы|құрметті|клиент/i, 'client'],
  [/заказ|№/i,                       'code'],   // без «номер»: «Трек-номер» иначе уходит сюда
  [/отправител|магазин|партн/i,      'sender'],
];
// Текст вокруг {{N}} (или [[N]] — в таком виде его отдаёт Kelesu в `spec`).
function waCtx(text, n){
  const t = String(text || '');
  const i = t.search(new RegExp('[\\[{]{2}' + n + '[\\]}]{2}'));
  return i < 0 ? '' : t.slice(Math.max(0, i - 34), i + 40);
}
function waGuessField(ctx, n){
  const t = String(ctx || '');
  const mark = new RegExp('[\\[{]{2}' + Number(n) + '[\\]}]{2}');
  const i = t.search(mark);
  const left  = i < 0 ? '' : t.slice(Math.max(0, i - 30), i);
  const right = i < 0 ? t : t.slice(i).replace(mark, '').slice(0, 30);
  // Слева смотрим ВСЕГДА и только потом справа: поле называют перед подстановкой
  // («Адрес доставки: {{3}}»), а справа уже начинается следующая фраза — по ней
  // в адрес подставлялась дата из соседнего предложения.
  const nearest = (txt, fromRight) => {
    let best = null, bestD = 1e9;
    WA_GUESS.forEach(([re, key]) => {
      const m = txt.match(re); if (!m) return;
      const d = fromRight ? (txt.length - (m.index + m[0].length)) : m.index;
      if (d < bestD) { bestD = d; best = key; }
    });
    return best;
  };
  return nearest(left, true) || nearest(right, false) || (Number(n) === 1 ? 'client' : 'code');
}

function waCityOf(o){
  if (typeof isCourierDelivery === 'function' && isCourierDelivery(o.delivery_id))
    return o.courier_city_id ? courierCityName(o.courier_city_id) : '';
  return o.city_id ? cityName(o.city_id) : '';
}
function waCourier(o){
  const c = (S.order_couriers || []).find(x => x.id === o.order_courier_id);
  return { fio: (c && c.fio) || '', phone: (c && c.phone) || '' };
}

/* Номер в том виде, в каком его ждёт Meta: 11 цифр, без плюса. Те же правила, что при
   загрузке реестра, — иначе один клиент оказался бы в двух видах. Пусто = слать некуда. */
function waPhone(v){
  let d = String(v == null ? '' : v).replace(/\D+/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return (d.length === 11 && d[0] === '7') ? d : '';
}

/* ЗНАЧЕНИЕ ПАРАМЕТРА ЧИСТИМ ОБЯЗАТЕЛЬНО. Meta отклоняет параметр с переводом строки,
   табуляцией и с четырьмя пробелами подряд — а адреса у нас приходят из чужих реестров
   ровно такими. Отказ приходит на КАЖДОЕ сообщение, то есть рассылка молча ложится
   целиком, и видно это только в журнале. */
function waParam(v){
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // Пустой параметр Meta тоже не принимает. Прочерк честнее: сразу видно, что в заказе
  // поля не было, а не что сообщение «просто не дошло».
  return s || '—';
}

/* ---------- кнопка в строке фильтров ---------- */
// Счётчик живёт ВНЕ таблицы и о галочках сам не знает: его дёргает updateKetAllChk,
// как и кнопку удаления. Любой новый путь, меняющий ketSelected без перерисовки,
// обязан позвать и эту функцию (раздел 8e).
function updateWaSelBtn(){
  const n = ketSelected.size;
  // Пунктов в меню столько, сколько строк в WA_BUTTONS, — подписываем каждый по его ключу.
  document.querySelectorAll('[data-wabtn]').forEach(b => {
    const label = (typeof waBtnLabel === 'function') ? waBtnLabel(b.dataset.wabtn) : b.textContent;
    b.textContent = n ? `${label} (${n})` : label;
    b.disabled = !n;
  });
}

async function waSendFromSelection(){
  const list = [...ketSelected].map(id => (S.orders || []).find(o => o.id === id)).filter(Boolean);
  if (!list.length) { toast('Сначала отметьте заказы галочками'); return; }
  await waSendModal(list);
}

/* ---------- список шаблонов ---------- */
async function waLoadTemplates(force){
  if (waTemplates && !force) return waTemplates;
  const r = await callEdge('kelesu-waba', { action: 'templates' });
  if (!r || r.error) { waTemplates = null; return { error: (r && r.error) || 'не удалось получить список шаблонов' }; }
  waTemplates = r.templates || [];
  waTemplates._key = r.key || '';
  return waTemplates;
}
async function waLoadSpec(name){
  if (waSpecCache[name]) return waSpecCache[name];
  const r = await callEdge('kelesu-waba', { action: 'spec', name });
  waSpecCache[name] = (r && r.spec) ? r.spec : null;
  return waSpecCache[name];
}

/* ---------- окно рассылки ---------- */
async function waSendModal(orders){
  const ov = showModal('Рассылка WhatsApp', '<div class="hint">Загружаем шаблоны…</div>', null,
    { wide: true, readonly: true, closeLabel: 'Закрыть' });
  const box = ov.querySelector('.modal-body');
  const tpls = await waLoadTemplates();
  if (!tpls || tpls.error) {
    box.innerHTML = `<div class="hint" style="color:var(--rust)">${esc((tpls && tpls.error) || 'ошибка')}</div>
      <p class="hint">Проверьте, что выложена функция <b>kelesu-waba</b> и заданы секреты
      <b>KELESU_API_KEY</b> и <b>KELESU_CHANNEL_ID</b>.</p>`;
    return;
  }
  const approved = tpls.filter(t => t.status === 'APPROVED');
  if (!approved.length) {
    box.innerHTML = `<div class="empty"><div class="big">Нет одобренных шаблонов</div>
      <p>В канале ${esc(String(tpls.length))} шаблон(ов), но ни один не со статусом APPROVED.
      Отправить можно только одобренный Meta — заведите шаблон в Meta Business Suite и дождитесь модерации.</p></div>`;
    return;
  }

  // Получателей считаем сразу: заказ без телефона отправить нельзя, и человек должен
  // увидеть это ДО отправки, а не в отчёте «не ушло 12 из 40».
  const rows = orders.map(o => ({ o, phone: waPhone(o.phone) }));
  const ok = rows.filter(r => r.phone), bad = rows.filter(r => !r.phone);

  const fieldOpts = sel => WA_FIELDS.map(f =>
    `<option value="${f[0]}" ${sel === f[0] ? 'selected' : ''}>${esc(f[1])}</option>`).join('');

  box.innerHTML = `
    <div class="field">
      <label>Шаблон <small class="cell-time">только одобренные Meta</small></label>
      <select id="waTpl">${approved.map(t =>
        `<option value="${esc(t.name)}">${esc(t.name)}${t.language ? ' · ' + esc(t.language) : ''}</option>`).join('')}</select>
    </div>
    <div id="waTplBox"></div>
    <div class="panel" style="margin-top:10px">
      <h3 style="margin:0 0 6px">Кому уйдёт</h3>
      <div class="hint">Отмечено заказов: <b>${rows.length}</b> · отправим <b>${ok.length}</b>${
        bad.length ? ` · <span style="color:var(--rust)">без телефона: ${bad.length}</span>` : ''}</div>
      ${bad.length ? `<div class="hint" style="color:var(--rust)">Без номера не отправить:
        ${bad.slice(0, 12).map(r => esc(r.o.code || '—')).join(', ')}${bad.length > 12 ? ' и ещё ' + (bad.length - 12) : ''}</div>` : ''}
      <div id="waPrev" class="hint" style="margin-top:8px"></div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap">
      <button class="btn primary" id="waGo" ${ok.length ? '' : 'disabled'}>Отправить ${ok.length}</button>
      <span id="waProg" class="hint"></span>
    </div>`;

  const drawTpl = async () => {
    const name = $('waTpl').value;
    const t = approved.find(x => x.name === name);
    const spec = await waLoadSpec(name);
    const ctx = (spec && spec.body && spec.body.placeholders) || [];
    // Контекст берём из `spec`, а если его нет — выкраиваем из самого текста шаблона:
    // одного без другого достаточно, и подсказка не должна пропадать из-за того, что
    // отдельный запрос за `spec` не прошёл.
    const ctxOf = n => {
      const c = ctx.find(p => Number(p.index) === n);
      return (c && c.context) ? String(c.context) : waCtx(t.body_text, n);
    };
    const hint = n => { const c = ctxOf(n); return c ? `<small class="cell-time">${esc(c)}</small>` : ''; };
    const n = t.body_params;
    const media = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header_format);
    $('waTplBox').innerHTML = `
      <div class="panel" style="margin:8px 0">
        <div class="hint" style="white-space:pre-wrap">${esc(t.body_text || '(в шаблоне нет текста)')}</div>
        ${t.footer_text ? `<div class="hint" style="opacity:.7">${esc(t.footer_text)}</div>` : ''}
      </div>
      ${media ? `<div class="field"><label>Картинка/файл в шапке шаблона — прямая ссылка</label>
        <input id="waHead" placeholder="https://…" ${t.header_format === 'DOCUMENT' ? '' : ''}>
        <div class="hint">У этого шаблона шапка типа ${esc(t.header_format)} — без ссылки Meta вернёт ошибку 132000.</div></div>` : ''}
      ${t.header_format === 'TEXT' && t.header_params ? `<div class="field"><label>Текст в шапке шаблона</label>
        <select class="wa-map" data-wa="h1">${fieldOpts(waGuessField(waCtx(t.header_text, 1), 1))}</select></div>` : ''}
      ${n ? `<table class="resp-table"><thead><tr><th>Параметр</th><th>Что подставить</th></tr></thead><tbody>${
        Array.from({ length: n }, (_, i) => i + 1).map(k => `<tr class="open">
          <td data-label="Параметр"><b>{{${k}}}</b> ${hint(k)}</td>
          <td data-label="Что подставить"><select class="wa-map" data-wa="${k}">${
            fieldOpts(waGuessField(ctxOf(k), k))}</select></td>
        </tr>`).join('')}</tbody></table>`
        : '<div class="hint">У шаблона нет подстановок — уйдёт как есть.</div>'}`;
    ov.querySelectorAll('.wa-map').forEach(s => s.onchange = drawPrev);
    drawPrev();
  };

  // Предпросмотр по ПЕРВОМУ заказу: текст клиенту нельзя увидеть иначе никак, а ошибка
  // в подстановке («город» вместо «трека») заметна только глазами.
  const drawPrev = () => {
    const t = approved.find(x => x.name === $('waTpl').value);
    const first = ok[0] && ok[0].o;
    if (!t || !first) { $('waPrev').innerHTML = ''; return; }
    let text = t.body_text || '';
    const empties = [];
    ov.querySelectorAll('.wa-map').forEach(s => {
      const k = s.dataset.wa; if (k === 'h1') return;
      const v = waParam(waFieldFn(s.value)(first));
      if (v === '—') empties.push(s.options[s.selectedIndex].text);
      text = text.split('{{' + k + '}}').join(v);
    });
    $('waPrev').innerHTML = `<b>Как увидит ${esc(first.client || first.code || 'клиент')}:</b>
      <div style="white-space:pre-wrap;margin-top:4px">${esc(text)}</div>
      ${empties.length ? `<div style="color:var(--rust);margin-top:4px">В этом заказе пусто: ${esc(empties.join(', '))}
        — уйдёт прочерк. Проверьте, тот ли шаблон.</div>` : ''}`;
  };

  $('waTpl').onchange = drawTpl;
  await drawTpl();

  $('waGo').onclick = async () => {
    const t = approved.find(x => x.name === $('waTpl').value);
    const head = $('waHead') ? $('waHead').value.trim() : '';
    const media = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header_format);
    if (media && !/^https?:\/\//i.test(head)) { toast('У шаблона шапка с файлом — нужна прямая ссылка'); return; }
    // Отправка клиентам — действие наружу, необратимое и ПЛАТНОЕ: Meta берёт за каждое
    // шаблонное сообщение. На большой пачке это уже деньги, а отметить «все» в гриде —
    // одно движение (у владельца в списке Барахолки их полторы тысячи), поэтому на
    // большой рассылке говорим об этом прямо в подтверждении.
    const many = ok.length >= 50;
    if (!confirm(`Отправить «${t.name}» ${ok.length} получателям?\n\n`
      + `Сообщение уйдёт клиентам сразу, отозвать его нельзя.\n`
      + (many ? `\nЭто ${ok.length} ПЛАТНЫХ сообщений: Meta берёт за каждое шаблонное.\n`
                + `Проверьте, что отмечены именно те заказы.\n` : ''))) return;

    const maps = [...ov.querySelectorAll('.wa-map')].map(s => ({ k: s.dataset.wa, f: s.value }));
    const build = o => {
      const comps = [];
      if (media) comps.push({ type: 'header', parameters: [{ type: t.header_format.toLowerCase(),
        [t.header_format.toLowerCase()]: t.header_format === 'DOCUMENT' ? { link: head, filename: 'Jyldam.pdf' } : { link: head } }] });
      const h = maps.find(m => m.k === 'h1');
      if (h) comps.push({ type: 'header', parameters: [{ type: 'text', text: waParam(waFieldFn(h.f)(o)) }] });
      const bodyParams = maps.filter(m => m.k !== 'h1')
        .sort((a, b) => Number(a.k) - Number(b.k))
        .map(m => ({ type: 'text', text: waParam(waFieldFn(m.f)(o)) }));
      if (bodyParams.length) comps.push({ type: 'body', parameters: bodyParams });
      return comps;
    };

    const btn = $('waGo'); btn.disabled = true;
    const all = [];
    // Шлём пачками: у функции есть предел по времени, а между сообщениями стоит пауза
    // (лимит Kelesu — 100 запросов в минуту на ключ). Заодно виден ход рассылки.
    for (let i = 0; i < ok.length; i += WA_CHUNK) {
      const part = ok.slice(i, i + WA_CHUNK);
      $('waProg').textContent = `Отправляю: ${i + 1}–${Math.min(i + part.length, ok.length)} из ${ok.length}…`;
      const r = await callEdge('kelesu-waba', {
        action: 'send', template: t.name,
        items: part.map(x => ({ order_id: x.o.id, code: x.o.code, phone: x.phone, components: build(x.o) })),
      });
      if (!r || r.error) { all.push({ code: '', ok: false, error: (r && r.error) || 'ошибка вызова' }); break; }
      all.push(...(r.results || []));
      if (r.logError) console.warn('wa_sends', r.logError);
    }
    btn.disabled = false; $('waProg').textContent = '';
    ov.remove(); syncModalOpenClass();
    waResultModal(all, bad);
  };
}

/* ---------- что ушло, а что нет ---------- */
// Перечень группируем ПО ПРИЧИНЕ, как в загрузке реестра: «не ушло 12» без объяснения
// невозможно ни исправить, ни объяснить партнёру.
function waResultModal(results, noPhone){
  const sent = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const byErr = {};
  fail.forEach(r => { const k = r.error || 'без объяснения'; (byErr[k] = byErr[k] || []).push(r.code || '—'); });
  const plain = [
    `Отправлено: ${sent.length}`,
    fail.length ? `Не ушло: ${fail.length}` : '',
    ...Object.entries(byErr).map(([k, v]) => `• ${k}: ${v.join(', ')}`),
    (noPhone && noPhone.length) ? `• без телефона: ${noPhone.map(r => r.o.code || '—').join(', ')}` : '',
  ].filter(Boolean).join('\n');

  showInfo('Рассылка WhatsApp', `
    <div class="stats stats-2">
      <div class="stat"><div class="k">Отправлено</div><div class="v">${sent.length}</div></div>
      <div class="stat"><div class="k">Не ушло</div><div class="v">${fail.length + ((noPhone || []).length)}</div></div>
    </div>
    ${Object.keys(byErr).length ? `<div class="panel" style="margin-top:10px"><h3 style="margin:0 0 6px">Почему не ушло</h3>
      ${Object.entries(byErr).map(([k, v]) => `<div class="hint"><b>${esc(k)}</b><br>${esc(v.join(', '))}</div>`).join('')}
      <div class="hint" style="opacity:.75;margin-top:6px">132000 — не совпало число параметров шаблона ·
        131047 — окно 24 часа закрыто, нужен шаблон · 429 — упёрлись в лимит, повторите позже</div></div>` : ''}
    ${(noPhone && noPhone.length) ? `<div class="panel" style="margin-top:10px"><h3 style="margin:0 0 6px">Без телефона</h3>
      <div class="hint">${esc(noPhone.map(r => r.o.code || '—').join(', '))}</div></div>` : ''}
    <button class="btn sm ghost" id="waCopy" style="margin-top:10px">📋 Скопировать список</button>`,
    { wide: true });
  const c = $('waCopy');
  if (c) c.onclick = () => { copyText(plain); toast('Список скопирован'); };
}

/* ================= КНОПКА «WhatsApp ОПОВЕЩЕНИЕ»: БЕЗ ОКНА (19.10.2026) =================
   Просьба владельца: «при нажатии кнопки ватсап-оповещение надо, чтобы вот так было на
   автомате — это окно можно не открывать, просто пусть всплывает „отправить 1 смс? да или
   отмена"; шаблон закрепить; выборку шаблона, какой отправлять по какой кнопке, перемести
   в настройки».

   ПОЭТОМУ ЗДЕСЬ ДВА РАЗНЫХ ПУТИ, И ПУТАТЬ ИХ НЕ НАДО:
     • `waSendModal` — окно с выбором шаблона и предпросмотром. Осталось: им настраивают и
       им же шлют что-то разовое;
     • `waNotifySelection` — кнопка в гриде. Ничего не спрашивает, кроме «отправить N?»:
       шаблон и подстановки взяты из настроек (`wa_buttons`).

   ЗАЧЕМ ВООБЩЕ ПОДТВЕРЖДЕНИЕ, РАЗ ПРОСИЛИ «НА АВТОМАТЕ». Сообщение уходит клиенту сразу,
   отозвать его нечем, и оно платное. Один вопрос «да/отмена» — это и есть просьба владельца
   дословно, он сам его и назвал. */
/* КНОПКИ ЗАДАНЫ СПИСКОМ, А НЕ ПО ОДНОЙ (19.10.2026). Владелец попросил добавить к первой
   ещё «Прибыл заказ» и «Курьерское оповещение» — и так будет дальше: у него пять
   одобренных шаблонов на разные события. Поэтому кнопка — это строка здесь, и всё
   остальное (пункт меню, счётчик, вкладка в настройках, отправка) берётся из неё.
   НОВАЯ КНОПКА = СТРОКА В ЭТОМ СПИСКЕ, больше нигде ничего дописывать не нужно.

   Ключ (`notify`, `arrived`, `courier`) — это ключ строки в таблице `wa_buttons`, и
   МЕНЯТЬ ЕГО НЕЛЬЗЯ: по нему хранится выбранный шаблон. Переименовать подпись можно
   свободно, ключ — нет. */
const WA_BUTTONS=[
  ['notify',  '💬 WhatsApp оповещение'],
  ['arrived', '📦 Прибыл заказ'],
  ['courier', '🚚 Курьерское оповещение'],
];
const waBtnLabel=key=>((WA_BUTTONS.find(b=>b[0]===key)||[,key])[1]);
let _waCfg=null;                  // настройки кнопок: {ключ:{template,params}}

async function waCfgLoad(force){
  if(_waCfg&&!force)return _waCfg;
  // Спрашиваем таблицу НАПРЯМУЮ, а не через dbList: тот на отсутствующую таблицу отвечает
  // пустым массивом, и «db/34 не выполнен» было бы не отличить от «не настроено».
  const {data,error}=await sb.from('wa_buttons').select('*');
  if(error){_waCfg=null;return null;}
  _waCfg={};(data||[]).forEach(r=>{_waCfg[r.key]={template:r.template||'',params:r.params||null};});
  return _waCfg;
}
async function waCfgSave(key,template,params){
  const row={key,template:template||null,params:params||null,
    updated_at:new Date().toISOString(),updated_by:(S.me&&(S.me.full_name||S.me.email))||''};
  const {error}=await sb.from('wa_buttons').upsert(row,{onConflict:'key'});
  if(error){toast(dbErrText?dbErrText(error):(error.message||'не удалось сохранить'));return false;}
  if(_waCfg)_waCfg[key]={template:row.template||'',params:row.params||null};
  return true;
}

// Собрать components по закреплённым настройкам. Чего в настройках нет — угадываем по
// тексту шаблона, как в окне: так закрепление не разваливается от нового параметра.
function waComponentsFor(t,o,params){
  const n=t.body_params||0;
  const bodyParams=[];
  for(let k=1;k<=n;k++){
    const key=(params&&params[k])||(params&&params[String(k)])
      ||waGuessField(waCtx(t.body_text,k),k);
    bodyParams.push({type:'text',text:waParam(waFieldFn(key)(o))});
  }
  const comps=[];
  if(bodyParams.length)comps.push({type:'body',parameters:bodyParams});
  return comps;
}

// «1 сообщение · 2 сообщения · 5 сообщений» — вопрос читают бегло, и «2 сообщений» в нём
// спотыкает глаз ровно там, где надо подумать.
function waPlural(n){
  const d=n%10, dd=n%100;
  if(d===1&&dd!==11)return 'сообщение';
  if(d>=2&&d<=4&&(dd<12||dd>14))return 'сообщения';
  return 'сообщений';
}
async function waNotifySelection(key){
  key=key||WA_BUTTONS[0][0];
  const list=[...ketSelected].map(id=>(S.orders||[]).find(o=>o.id===id)).filter(Boolean);
  if(!list.length){toast('Сначала отметьте заказы галочками');return;}
  const cfg=await waCfgLoad();
  if(cfg===null){toast('Таблица настроек не найдена — выполните db/34 (блок 3)');return;}
  const pin=cfg[key];
  if(!pin||!pin.template){
    toast(`Для «${waBtnLabel(key)}» шаблон не выбран: Настройки → Оповещения`);return;
  }
  const tpls=await waLoadTemplates();
  if(!tpls||tpls.error){toast((tpls&&tpls.error)||'не удалось получить шаблоны');return;}
  const t=tpls.find(x=>x.name===pin.template);
  if(!t){toast(`Шаблон «${pin.template}» у Kelesu больше нет — поправьте в Настройках`);return;}
  if(t.status!=='APPROVED'){toast(`Шаблон «${t.name}» не одобрен Meta — отправить нельзя`);return;}

  const rows=list.map(o=>({o,phone:waPhone(o.phone)}));
  const ok=rows.filter(r=>r.phone), bad=rows.filter(r=>!r.phone);
  if(!ok.length){toast('Ни у одного из отмеченных заказов нет телефона');return;}

  // Вот то самое «отправить 1 смс? да или отмена». Про платность говорим от полусотни:
  // отметить «все» — одно движение, а в Барахолке их полторы тысячи.
  const msg=`${waBtnLabel(key)}\n\nОтправить ${ok.length} ${waPlural(ok.length)} в WhatsApp?`
    +(bad.length?`\n\nБез телефона и не уйдут: ${bad.length}`:'')
    +(ok.length>=50?`\n\nЭто ${ok.length} ПЛАТНЫХ сообщений — Meta берёт за каждое.`:'');
  if(!confirm(msg))return;

  const all=[];
  for(let i=0;i<ok.length;i+=WA_CHUNK){
    const part=ok.slice(i,i+WA_CHUNK);
    toast(`Отправляю: ${Math.min(i+part.length,ok.length)} из ${ok.length}…`);
    const r=await callEdge('kelesu-waba',{action:'send',template:t.name,
      items:part.map(x=>({order_id:x.o.id,code:x.o.code,phone:x.phone,
        components:waComponentsFor(t,x.o,pin.params)}))});
    if(!r||r.error){all.push({code:'',ok:false,error:(r&&r.error)||'ошибка вызова'});break;}
    all.push(...(r.results||[]));
  }
  const sent=all.filter(r=>r.ok).length, fail=all.length-sent;
  // Всё ушло — хватит тоста. Что-то не ушло — показываем разбор по причинам: иначе
  // «отправлено 38 из 40» остаётся загадкой, а повторить уже нечем.
  if(!fail&&!bad.length)toast(`Отправлено: ${sent}`);
  else waResultModal(all,bad);
}

/* ---------- вкладка «Оповещения» в Настройках ---------- */
/* ОДНА ВКЛАДКА НА ВСЕ КНОПКИ (19.10.2026). Просьба владельца: «в настройках сделай, чтобы
   можно было выбрать, на какую кнопку шаблон привязываешь». Кнопки перечислены чипами
   наверху, под ними — шаблон и подстановки выбранной. По вкладке на кнопку делать нельзя:
   кнопок будет пять, а список справочников и так на девятнадцать пунктов (раздел 8a).

   Шаблоны и настройки читаются ОДИН раз за открытие вкладки, переключение чипа только
   перерисовывает панель: иначе каждое нажатие ходило бы к Kelesu, а там лимит 100 запросов
   в минуту на ключ. */
let waCfgBtn = WA_BUTTONS[0][0];
async function renderWaSettings(){
  const box=$('dirContent');if(!box)return;
  box.innerHTML='<div class="loading" style="padding:40px">Загружаем шаблоны…</div>';
  const cfg=await waCfgLoad(true);
  if(cfg===null){
    box.innerHTML=`<div class="empty"><div class="big">Раздел ещё не включён</div>
      <p>Нет таблицы настроек. Выполните <b>db/34-WHATSAPP-рассылка.sql</b>, блок 3, и обновите страницу.</p></div>`;
    return;
  }
  const tpls=await waLoadTemplates(true);
  if(!tpls||tpls.error){
    box.innerHTML=`<div class="empty"><div class="big">Шаблоны не получены</div>
      <p>${esc((tpls&&tpls.error)||'ошибка')}</p>
      <p class="hint">Проверьте функцию <b>kelesu-waba</b> и секреты <b>KELESU_API_KEY</b>, <b>KELESU_CHANNEL_ID</b>.</p></div>`;
    return;
  }
  const appr=tpls.filter(t=>t.status==='APPROVED');
  if(!WA_BUTTONS.some(b=>b[0]===waCfgBtn))waCfgBtn=WA_BUTTONS[0][0];

  // Чип показывает не только название кнопки, но и привязанный шаблон: главный вопрос здесь —
  // «что по какой кнопке уйдёт», и отвечать на него перебором чипов было бы странно.
  const chips=()=>WA_BUTTONS.map(([key,label])=>{
    const t=(cfg[key]&&cfg[key].template)||'';
    // Кнопка — это flex-контейнер, и обычный <br> в ней не переносит: подпись и шаблон
    // должны быть ОТДЕЛЬНЫМИ элементами, иначе имя шаблона встаёт в ту же строку.
    return `<button type="button" class="btn sm ${key===waCfgBtn?'primary':'ghost'}" data-wacfgbtn="${esc(key)}"
      style="flex-direction:column;align-items:flex-start;gap:2px;line-height:1.25;height:auto;padding:8px 12px"><span>${esc(label)}</span
      ><small style="opacity:.8;font-weight:400">${t?esc(t):'шаблон не выбран'}</small></button>`;
  }).join('');

  const drawBtn=()=>{
    const pin=cfg[waCfgBtn]||{template:'',params:null};
    // У НЕПРИВЯЗАННОЙ кнопки в списке стоит «— не выбран —», а не первый шаблон по порядку.
    // Иначе чип пишет «шаблон не выбран», а список показывает order_accepted — и человек
    // уходит с вкладки, считая, что привязка есть. Та же ловушка, что с пустым пунктом в
    // «Типе доставки» (раздел 6): пустой пункт нужен, пока выбор не сделан, и только тогда.
    const cur=appr.find(t=>t.name===pin.template)||null;
    box.innerHTML=`
      <div class="panel">
        <div class="panel-head"><h2>Оповещения в WhatsApp</h2></div>
        <p class="hint">Выберите кнопку из меню «⚙ Действие» в «Заказах» и «Барахолке», затем шаблон,
          который по ней уйдёт. Отправка идёт без окна — только с подтверждением «отправить N?».</p>
        <div class="filters" style="padding:0;margin:0 0 12px;gap:8px;flex-wrap:wrap">${chips()}</div>
        <div class="field"><label>Шаблон для «${esc(waBtnLabel(waCfgBtn))}»</label>
          <select id="waCfgTpl">${cur?'':'<option value="" selected>— шаблон не выбран —</option>'}${appr.map(t=>`<option value="${esc(t.name)}" ${cur&&cur.name===t.name?'selected':''}>${esc(t.name)}${t.language?' · '+esc(t.language):''}</option>`).join('')}</select>
          ${appr.length?'':'<div class="hint" style="color:var(--rust)">Нет одобренных шаблонов — заведите их в Meta Business Suite</div>'}
        </div>
        <div id="waCfgBody"></div>
        <div style="margin-top:12px">
          <button class="btn primary" id="waCfgSave">Сохранить</button>
          ${pin.template?'<button class="btn ghost" id="waCfgClear" style="margin-left:8px">Отвязать шаблон</button>':''}
        </div>
      </div>`;
    box.querySelectorAll('[data-wacfgbtn]').forEach(b=>{
      b.onclick=()=>{waCfgBtn=b.dataset.wacfgbtn;drawBtn();};
    });
    const drawBody=()=>{
      const bodyBox=$('waCfgBody');if(!bodyBox)return;
      const t=appr.find(x=>x.name===$('waCfgTpl').value);
      if(!t){bodyBox.innerHTML='<div class="hint">Выберите шаблон — тогда покажем его текст и подстановки.</div>';return;}
      const n=t.body_params||0;
      const fieldOpts=sel=>WA_FIELDS.map(f=>`<option value="${f[0]}" ${sel===f[0]?'selected':''}>${esc(f[1])}</option>`).join('');
      // Сохранённые подстановки берём только у СВОЕГО шаблона: выбрали в списке другой —
      // у него и параметры другие, и чужая раскладка подставила бы адрес в дату.
      const saved=(t.name===pin.template&&pin.params)?pin.params:null;
      bodyBox.innerHTML=`
        <div class="panel" style="margin:8px 0"><div class="hint" style="white-space:pre-wrap">${esc(t.body_text||'')}</div></div>
        ${n?`<table class="resp-table"><thead><tr><th>Параметр</th><th>Что подставить</th></tr></thead><tbody>${
          Array.from({length:n},(_,i)=>i+1).map(k=>{
            const sel=(saved&&(saved[k]||saved[String(k)]))||waGuessField(waCtx(t.body_text,k),k);
            const ctx=waCtx(t.body_text,k);
            return `<tr class="open"><td data-label="Параметр"><b>{{${k}}}</b>${ctx?`<small class="cell-time">${esc(ctx)}</small>`:''}</td>
              <td data-label="Что подставить"><select class="wa-cfg" data-k="${k}">${fieldOpts(sel)}</select></td></tr>`;
          }).join('')}</tbody></table>`
          :'<div class="hint">У шаблона нет подстановок — уйдёт как есть.</div>'}`;
    };
    if($('waCfgTpl'))$('waCfgTpl').onchange=drawBody;
    drawBody();
    if($('waCfgSave'))$('waCfgSave').onclick=async()=>{
      const t=appr.find(x=>x.name===$('waCfgTpl').value);
      if(!t){toast('Выберите шаблон');return;}
      const params={};
      box.querySelectorAll('.wa-cfg').forEach(s=>{params[s.dataset.k]=s.value;});
      const btn=$('waCfgSave');btn.disabled=true;
      const okSave=await waCfgSave(waCfgBtn,t.name,params);
      btn.disabled=false;
      if(okSave){
        cfg[waCfgBtn]={template:t.name,params};
        toast(`«${waBtnLabel(waCfgBtn)}» будет слать шаблон ${t.name}`);
        drawBtn();   // чип этой кнопки должен сразу показать новый шаблон
      }
    };
    // Отвязать нужно по-настоящему: кнопку из меню убрать нельзя (она строкой в WA_BUTTONS),
    // а слать по ней старый шаблон после «я это больше не использую» — хуже, чем отказ.
    if($('waCfgClear'))$('waCfgClear').onclick=async()=>{
      if(!confirm(`Отвязать шаблон от «${waBtnLabel(waCfgBtn)}»?\n\nКнопка останется в меню, но будет писать, что шаблон не выбран.`))return;
      const btn=$('waCfgClear');btn.disabled=true;
      const okSave=await waCfgSave(waCfgBtn,'',null);
      btn.disabled=false;
      if(okSave){cfg[waCfgBtn]={template:'',params:null};toast('Отвязано');drawBtn();}
    };
  };
  drawBtn();
}
