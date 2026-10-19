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
// В ОЧЕРЕДЬ кладём крупнее: это обычная запись без пауз, и 1594 строки встают за секунды.
// Ограничивает только размер запроса — у каждой строки внутри лежат подстановки шаблона.
const WA_QUEUE_CHUNK = 500;
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
/* ПОЧЕМУ ОТКАЗ — ОКНОМ, А НЕ ТОСТОМ (19.10.2026). Владелец отметил заказы, нажал кнопку и
   получил «тишину»: отказ уходил тостом — полоска внизу на 2,2 секунды, под плавающей
   панелью страниц, в гриде на полторы тысячи строк. Со стороны это неотличимо от «кнопка
   не работает», а причина каждый раз РАЗНАЯ и требует разных действий — выложить функцию,
   выполнить SQL, выбрать шаблон. Поэтому здесь окно с конкретным шагом.
   Правило раздела 12: молчаливая кнопка в рассылке клиентам недопустима. */
function waBlockModal(title,html){
  if(typeof showInfo==='function')showInfo('💬 '+title,`<div class="hint" style="line-height:1.6">${html}</div>`);
  else alert(title);
}
async function waNotifySelection(key){
  key=key||WA_BUTTONS[0][0];
  const label=waBtnLabel(key);
  const list=[...ketSelected].map(id=>(S.orders||[]).find(o=>o.id===id)).filter(Boolean);
  if(!list.length){
    waBlockModal('Заказы не отмечены',
      `Отметьте заказы галочками в первой колонке — рассылка идёт только по отмеченным.`
      +(ketSelected.size?`<br><br>Отмечено ${ketSelected.size}, но этих заказов нет в загруженном списке: смените фильтр или обновите страницу.`:''));
    return;
  }
  const cfg=await waCfgLoad();
  if(cfg===null){
    waBlockModal('Раздел ещё не включён',
      `Нет таблицы настроек <b>wa_buttons</b> — она хранит, какой шаблон уходит по какой кнопке.
       <br><br>Выполните <b>db/34-WHATSAPP-рассылка.sql</b>, <b>блок 3</b>, и обновите страницу.`);
    return;
  }
  const pin=cfg[key];
  if(!pin||!pin.template){
    waBlockModal('Шаблон не выбран',
      `Для кнопки «${esc(label)}» не выбран шаблон WhatsApp, поэтому отправлять нечего.
       <br><br>Откройте <b>Настройки → Оповещения WhatsApp</b>, нажмите чип «${esc(label)}»,
       выберите шаблон и сохраните.`);
    return;
  }
  const tpls=await waLoadTemplates();
  if(!tpls||tpls.error){
    waBlockModal('Шаблоны не получены',
      `Не удалось спросить список шаблонов у Kelesu:<br><br><b>${esc((tpls&&tpls.error)||'ошибка')}</b>
       <br><br>Проверьте, что функция <b>kelesu-waba</b> выложена в Supabase и у неё заданы секреты
       <b>KELESU_API_KEY</b> и <b>KELESU_CHANNEL_ID</b>. После правки секретов функцию нужно
       выложить заново — они читаются при запуске.`);
    return;
  }
  const t=tpls.find(x=>x.name===pin.template);
  if(!t){
    waBlockModal('Шаблона больше нет',
      `Шаблон <b>${esc(pin.template)}</b> у Kelesu не найден — его переименовали или удалили.
       <br><br>Выберите другой в <b>Настройки → Оповещения WhatsApp</b>.`);
    return;
  }
  if(t.status!=='APPROVED'){
    waBlockModal('Шаблон не одобрен Meta',
      `У шаблона <b>${esc(t.name)}</b> статус <b>${esc(t.status||'—')}</b>. Отправлять можно только
       одобренные — это ограничение Meta, а не Kelesu.`);
    return;
  }

  const rows=list.map(o=>({o,phone:waPhone(o.phone)}));
  let ok=rows.filter(r=>r.phone);
  const bad=rows.filter(r=>!r.phone);
  if(!ok.length){
    waBlockModal('Не на что отправлять',
      `Среди отмеченных заказов (${list.length}) нет ни одного с телефоном получателя.`);
    return;
  }
  // Кому этот шаблон уже уходил — пропускаем: сообщения платные, а повторное нажатие после
  // оборвавшейся рассылки иначе оплатило бы всё заново.
  const seen=await waAlreadySent(ok.map(r=>r.o.id),t.name);
  if(seen.error){waBlockModal('Журнал не прочитан',
    `Не удалось проверить, кому уже слали: ${esc(seen.error)}<br><br>Без этой проверки отправлять`
    +' опасно — повтор оплачивается заново. Попробуйте ещё раз.');return;}
  const again=ok.filter(r=>seen.done.has(r.o.id));
  ok=ok.filter(r=>!seen.done.has(r.o.id));
  if(!ok.length){
    waBlockModal('Уже отправлено',
      `Все отмеченные заказы (${again.length}) уже получали шаблон <b>${esc(t.name)}</b>.`
      +'<br><br>Повторно он не уходит: сообщения платные. Нужен именно повтор — отправьте его'
      +' другим шаблоном или спросите меня, как снять отметку.');
    return;
  }

  // Вот то самое «отправить 1 смс? да или отмена». Про платность говорим от полусотни:
  // отметить «все» — одно движение, а в Барахолке их полторы тысячи.
  const msg=`${label}\n\nОтправить ${ok.length} ${waPlural(ok.length)} в WhatsApp?`
    +(again.length?`\n\nПропустим ${again.length} — им этот шаблон уже уходил.`:'')
    +(bad.length?`\n\nБез телефона и не уйдут: ${bad.length}`:'')
    +(ok.length>=50?`\n\nЭто ${ok.length} ПЛАТНЫХ сообщений — Meta берёт за каждое.`
      +`\n\nШлёт сервер, примерно ${waEta(ok.length)}. Вкладку можно закрыть сразу после`
      +' постановки в очередь — отправка от неё больше не зависит.':'');
  if(!confirm(msg))return;

  /* ОТПРАВЛЯЕТ СЕРВЕР, А НЕ ЭТА ВКЛАДКА (19.10.2026, очередь — db/37, db/38).
     Просьба владельца после разбора «1594 отправили — ушло 251»: «сделай отправку на
     сервере через очередь». Здесь теперь только постановка в очередь: пачки по 500 строк,
     без пауз — это обычная запись, секунды. Дальше шлёт планировщик, раз в минуту по
     60 сообщений, и вкладку можно закрыть. */
  let queued=0, skipped=again.length, failEnq='';
  for(let i=0;i<ok.length;i+=WA_QUEUE_CHUNK){
    const part=ok.slice(i,i+WA_QUEUE_CHUNK);
    waProgress(`💬 Ставим в очередь: ${i} из ${ok.length}…`);
    const r=await callEdge('kelesu-waba',{action:'enqueue',template:t.name,button:key,
      items:part.map(x=>({order_id:x.o.id,code:x.o.code,phone:x.phone,
        // Раздел пишем ПО ЗАКАЗУ, а не по гриду: в отчёте (db/36) разбивка именно по нему,
        // а смешанная выборка иначе легла бы в один раздел целиком.
        section:(typeof isBaraholkaOrder==='function'&&isBaraholkaOrder(x.o))?'baraholka':'main',
        button:key,
        components:waComponentsFor(t,x.o,pin.params)}))});
    if(!r||r.error){failEnq=(r&&r.error)||'ошибка вызова';break;}
    queued+=r.queued||0; skipped+=r.skipped||0;
  }
  waProgress('');
  if(failEnq&&!queued){
    waBlockModal('Не удалось поставить в очередь',`${esc(failEnq)}`
      +'<br><br>Если это «relation wa_queue does not exist» — выполните <b>db/37</b>,'
      +' а расписание включает <b>db/38</b>.');
    return;
  }
  /* Первую пачку толкаем сразу, не дожидаясь планировщика: при отправке на десяток
     заказов ждать минуту незачем, да и видно сразу, работает ли связка. Ответа НЕ ждём —
     проход идёт до 45 секунд, а человеку держать вкладку ради него уже не нужно. */
  callEdge('kelesu-waba',{action:'drain'}).catch(()=>{});
  waBlockModal('Поставлено в очередь',
    `В очередь: <b>${queued}</b> ${waPlural(queued)}.`
    +(skipped?`<br>Пропущено (уже уходило): ${skipped}.`:'')
    +(bad.length?`<br>Без телефона: ${bad.length}.`:'')
    +(failEnq?`<br><br><b style="color:var(--rust)">Часть не встала в очередь:</b> ${esc(failEnq)}`:'')
    +'<br><br><b>Вкладку можно закрыть</b> — дальше шлёт сервер, примерно по 60 сообщений'
    +` в минуту, то есть около ${waEta(queued)}.`
    +'<br><br>Сколько осталось и что ушло — в <b>Настройки → Оповещения WhatsApp</b>.'
    +' Если очередь стоит на месте, значит не выполнено <b>db/38</b> (расписание).');
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

  // Две панели в разных контейнерах: чип переключают часто, а отчёт читает журнал за две
  // недели — перечитывать его на каждое нажатие чипа незачем.
  box.innerHTML='<div id="waCfgPanel"></div><div id="waQueueBox"></div><div id="waRepBox"></div>';
  const drawBtn=()=>{
    const pin=cfg[waCfgBtn]||{template:'',params:null};
    // У НЕПРИВЯЗАННОЙ кнопки в списке стоит «— не выбран —», а не первый шаблон по порядку.
    // Иначе чип пишет «шаблон не выбран», а список показывает order_accepted — и человек
    // уходит с вкладки, считая, что привязка есть. Та же ловушка, что с пустым пунктом в
    // «Типе доставки» (раздел 6): пустой пункт нужен, пока выбор не сделан, и только тогда.
    const cur=appr.find(t=>t.name===pin.template)||null;
    $('waCfgPanel').innerHTML=`
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
    $('waCfgPanel').querySelectorAll('[data-wacfgbtn]').forEach(b=>{
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
      $('waCfgPanel').querySelectorAll('.wa-cfg').forEach(s=>{params[s.dataset.k]=s.value;});
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
  waQueueRender();
  waReportRender();
}

/* ================= ПАНЕЛЬ ОЧЕРЕДИ (19.10.2026) =================
   Очередь живёт на сервере (db/37), шлёт её планировщик (db/38). Значит в CRM обязательно
   должно быть видно, ЕДЕТ ЛИ ОНА: если расписание не выполнено, строки будут копиться молча,
   и «я отправил, а клиенты ничего не получили» выяснится через сутки.

   Поэтому здесь три числа — в очереди, отправлено, не ушло — и время последней отправки.
   Плюс кнопка «Отправить пачку сейчас»: ею же проверяется связка целиком, не дожидаясь
   следующей минуты. */
const WA_QUEUE_STALE_MIN=5;       // столько ждём, прежде чем сказать «очередь стоит»
async function waQueueRender(){
  const box=$('waQueueBox');if(!box)return;
  box.innerHTML='<div class="panel" style="margin-top:14px"><div class="loading" style="padding:20px">Смотрим очередь…</div></div>';
  const r=await callEdge('kelesu-waba',{action:'queue'});
  if(!$('waQueueBox'))return;
  if(!r||r.error){
    box.innerHTML=`<div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Очередь отправки</h2></div>
      <div class="hint">Не удалось спросить очередь: ${esc((r&&r.error)||'нет ответа')}<br>
      Если это про <b>wa_queue</b> — выполните <b>db/37</b>, а расписание включает <b>db/38</b>.</div></div>`;
    return;
  }
  const q=r.queue||{};
  const left=(q.pending||0)+(q.sending||0);
  const lastMs=r.last_done?Date.parse(r.last_done):0;
  const minAgo=lastMs?Math.round((nowMs()-lastMs)/60000):null;
  // Очередь не пуста, а последняя отправка была давно (или её не было вовсе) — значит
  // планировщик не ходит. Это главное, что надо сказать вслух.
  const stale=left>0&&(minAgo===null||minAgo>WA_QUEUE_STALE_MIN);
  box.innerHTML=`<div class="panel" style="margin-top:14px">
    <div class="panel-head"><h2>Очередь отправки</h2><span class="count">${left}</span></div>
    <div class="stats stats-3">
      <div class="stat"><div class="k">Ждут отправки</div><div class="v">${left}</div></div>
      <div class="stat"><div class="k">Отправлено всего</div><div class="v">${q.sent||0}</div></div>
      <div class="stat"><div class="k">Не ушло всего</div><div class="v">${q.failed||0}</div></div>
    </div>
    <div class="hint" style="margin-top:8px">${r.last_done
      ? `Последняя отправка: ${esc(fmtDateTime?fmtDateTime(r.last_done):String(r.last_done).slice(0,16).replace('T',' '))}`
      : 'Отправок ещё не было'}</div>
    ${stale?`<div class="hint" style="margin-top:8px;color:var(--rust);line-height:1.6">
      <b>Очередь стоит.</b> В ней ${left}, а сервер ничего не отправлял
      ${minAgo===null?'ни разу':`${minAgo} мин`}. Скорее всего не выполнено <b>db/38</b>
      (расписание) либо у функции <b>kelesu-waba</b> не выключен «Verify JWT» — планировщик
      приходит без токена сотрудника, и платформа отрезает его раньше нашего кода.</div>`:''}
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn sm" id="waDrainNow">▶️ Отправить пачку сейчас</button>
      <button class="btn sm ghost" id="waQueueReload">🔄 Обновить</button>
    </div>
    <div class="hint" style="margin-top:8px">Отправляет сервер — вкладку держать открытой не нужно.
      Пачка — до 60 сообщений, следующая через минуту: пауза между сообщениями обязательна,
      у Kelesu лимит 100 запросов в минуту.</div>
  </div>`;
  if($('waQueueReload'))$('waQueueReload').onclick=()=>waQueueRender();
  if($('waDrainNow'))$('waDrainNow').onclick=async()=>{
    const b=$('waDrainNow');b.disabled=true;b.textContent='Отправляем…';
    const d=await callEdge('kelesu-waba',{action:'drain'});
    b.disabled=false;b.textContent='▶️ Отправить пачку сейчас';
    if(!d||d.error)toast('Не получилось: '+((d&&d.error)||'нет ответа'),6000);
    else toast(d.drained?`Ушло ${d.sent||0}, не ушло ${d.failed||0}, осталось ${d.left??'?'}`:'Очередь пуста',6000);
    waQueueRender();waReportRender();
  };
}

/* ================= ОТЧЁТ ПО РАССЫЛКЕ (19.10.2026) =================
   Просьба владельца: «в настройках надо оповещение — сколько ушло, и чтобы такая разбивка:
   модуль Барахолка, WhatsApp оповещение, отправлено 1594, доставлено до клиента 1500,
   столько-то не доставлено по такой-то причине, и прямо как грид, каждый день чтобы
   сохраняло и показывало».

   СОХРАНЯТЬ ОТДЕЛЬНО НИЧЕГО НЕ НАДО, И ЗАДАНИЯ ПО РАСПИСАНИЮ ТОЖЕ: каждую отправку функция
   кладёт строкой в `wa_sends` (db/34), строки не удаляются, и грид считает по журналу на
   лету. Ежедневный снимок был бы вторым источником правды о том же самом — разойдутся, и
   будет не понять, какой верен.

   РАЗБИВКА ПО МОДУЛЮ ЖИВЁТ В САМОМ ЖУРНАЛЕ (`section`, `button` — db/36), а не считается
   join-ом к заказам: раздел известен в момент отправки, а заказ потом могут и удалить —
   счёт за рассылку при этом останется.

   ⚠️ «ДОСТАВЛЕНО» ПОКА НЕ ЗАПОЛНЯЕТСЯ, И ЭТО НЕ ОШИБКА ОТЧЁТА. `status` пишется на момент
   отправки: `sent` или `failed`. «Доставлено» и «прочитано» Meta присылает ПОЗЖЕ, событием
   `message.status`, и приходит оно на вебхук Kelesu — в функцию `kelesu-webhook`, исходника
   которой у нас нет (он только в панели Supabase). Что туда дописать — в конце `db/36`.
   Пока не дописано, в этих колонках стоит прочерк и сказано, почему: «нет данных» и «не
   доставлено» — разные вещи, и путать их в отчёте о платной рассылке нельзя. */
const WA_REP_PAGE=1000;
let waRepDays=14;
// Коды Meta, которые реально встречаются. Текст её ответа длинный и английский, а человеку
// нужно одно: можно ли что-то сделать.
const WA_ERR_HINT=[
  [/132000/, 'не совпало число параметров шаблона'],
  [/131047/, 'окно 24 часа закрыто — нужен шаблон'],
  [/131026/, 'номер не в WhatsApp или не принимает сообщения'],
  [/131049/, 'Meta придержала доставку (слишком часто этому номеру)'],
  [/\b429\b/, 'упёрлись в лимит — повторить позже'],
  [/131053|media/i, 'Meta не приняла вложение'],
];
function waErrLabel(e){
  const t=String(e||'').trim();
  if(!t)return 'без объяснения';
  for(const [re,msg] of WA_ERR_HINT)if(re.test(t))return msg;
  return t.length>70?t.slice(0,70)+'…':t;
}
const WA_SECTION_RU={baraholka:'Барахолка',main:'Заказы заборов'};

/* ================= ПОВТОР НЕ ДОЛЖЕН СТОИТЬ ВТОРОЙ РАЗ (19.10.2026) =================
   Владелец отправил 1594, а в журнале оказался 251: рассылка оборвалась на шестой пачке.
   1594 сообщения по 700 мс — это 19 минут, и всё это время цикл живёт в ОТКРЫТОЙ вкладке;
   закрыли её, перешли в раздел с перезагрузкой, уснул ноутбук — отправка встала молча.

   Самое дорогое следствие было не в этом, а в том, что повторное нажатие слало бы всё
   заново, включая те 251: сообщения платные, а Meta на повтор не жалуется. Поэтому перед
   отправкой спрашиваем журнал, кому этот шаблон уже уходил, и таких пропускаем.

   СМОТРИМ ПО ПАРЕ «ЗАКАЗ + ШАБЛОН», а не по заказу: «Прибыл заказ» и «Курьерское
   оповещение» по одному заказу — это два разных уведомления, и второе не должно отмениться
   из-за первого. Отказавшиеся (`status='failed'`) не считаются отправленными — их как раз
   и надо повторить. */
async function waAlreadySent(ids,template){
  const done=new Set();
  for(let i=0;i<ids.length;i+=100){
    const part=ids.slice(i,i+100);
    const {data,error}=await sb.from('wa_sends').select('order_id,status')
      .eq('template',template).in('order_id',part);
    if(error)return {error:dbErrText?dbErrText(error):(error.message||'ошибка запроса')};
    (data||[]).forEach(r=>{if(r.order_id&&r.status!=='failed')done.add(r.order_id);});
  }
  return {done};
}
/* Полоса хода отправки. Тост живёт 2,2 секунды и внизу экрана — на девятнадцать минут
   работы этого мало, а человеку надо видеть, что процесс идёт и вкладку закрывать нельзя.
   Ровно по этой причине 1594 и оборвались незамеченными. */
function waProgress(txt){
  let el=$('waProg');
  if(!txt){if(el)el.remove();return;}
  if(!el){el=document.createElement('div');el.id='waProg';el.className='wa-prog';document.body.appendChild(el);}
  el.textContent=txt;
}
/* «23 минуты» понятнее, чем «1343 сообщения по 0,7 секунды». Считаем по темпу ОЧЕРЕДИ:
   планировщик берёт до 60 строк в минуту (пауза 700 мс обязательна — лимит Kelesu). */
const WA_PER_MIN=60;
function waEta(n){
  if(n<=WA_PER_MIN)return `${Math.max(5,Math.round(n*0.75))} сек`;
  const min=Math.ceil(n/WA_PER_MIN);
  return min<60?`${min} мин`:`${(min/60).toFixed(1)} ч`;
}
async function waReportLoad(days){
  const from=new Date(nowMs()-days*86400000).toISOString();
  const rows=[];
  for(let i=0;;i+=WA_REP_PAGE){
    const {data,error}=await sb.from('wa_sends')
      .select('created_at,section,button,template,status,error')
      .gte('created_at',from).order('created_at',{ascending:false})
      .range(i,i+WA_REP_PAGE-1);
    if(error)return {error:dbErrText?dbErrText(error):(error.message||'ошибка запроса')};
    rows.push(...(data||[]));
    if(!data||data.length<WA_REP_PAGE)break;
  }
  return {rows};
}
async function waReportRender(){
  const box=$('waRepBox');if(!box)return;
  box.innerHTML='<div class="panel" style="margin-top:14px"><div class="loading" style="padding:24px">Считаем по журналу рассылки…</div></div>';
  const res=await waReportLoad(waRepDays);
  if(!$('waRepBox'))return;                        // ушли с вкладки, пока считали
  const days=[7,14,30,90];
  const head=`<div class="panel-head"><h2>Что уходило — по дням</h2>
      <span class="count">${res.rows?res.rows.length:0}</span></div>
    <div class="filters" style="padding:0;margin:0 0 10px;gap:8px">
      ${days.map(d=>`<button type="button" class="btn sm ${d===waRepDays?'primary':'ghost'}" data-warepd="${d}">${d} дней</button>`).join('')}
      <button type="button" class="btn sm ghost" id="waRepReload">🔄 Обновить</button>
    </div>`;
  const wrap=inner=>{box.innerHTML=`<div class="panel" style="margin-top:14px">${head}${inner}</div>`;waReportBind();};
  if(res.error){
    wrap(`<div class="empty" style="padding:20px"><div class="big">Журнал не прочитан</div>
      <p>${esc(res.error)}</p>
      <p class="hint">Если таблицы нет — выполните <b>db/34</b>, а колонки разбивки добавляет <b>db/36</b>.</p></div>`);
    return;
  }
  const rows=res.rows;
  if(!rows.length){
    wrap(`<div class="empty" style="padding:20px"><div class="big">За этот период рассылок не было</div>
      <p class="hint">Журнал хранит каждую отправку — выберите период побольше.</p></div>`);
    return;
  }
  // Группируем по дню + разделу + кнопке: ровно та разбивка, которую просил владелец.
  const g={};
  rows.forEach(r=>{
    const day=String(r.created_at||'').slice(0,10);
    const key=day+'|'+(r.section||'?')+'|'+(r.button||'?')+'|'+(r.template||'');
    const c=g[key]||(g[key]={day,section:r.section||'',button:r.button||'',template:r.template||'',
      sent:0,deliv:0,read:0,fail:0,err:{}});
    /* «ОТПРАВЛЕНО» — ЭТО ПРИНЯТЫЕ Meta, А НЕ ВСЕ ПОПЫТКИ. Сначала считались все подряд, и
       в строке выходило «отправлено 1608 · не ушло 14» — то есть четырнадцать штук были
       посчитаны дважды. Владелец и формулировал иначе: «отправлено 1594, доставлено 1500,
       столько-то не доставлено». Теперь столбцы складываются: принято + не ушло = попыток. */
    const failed=(r.status==='failed'||!!r.error);
    if(failed){c.fail++;const k=waErrLabel(r.error);c.err[k]=(c.err[k]||0)+1;}
    else c.sent++;
    if(r.status==='read'){c.read++;c.deliv++;}
    else if(r.status==='delivered')c.deliv++;
  });
  const list=Object.values(g).sort((a,b)=>b.day.localeCompare(a.day)
    ||String(a.section).localeCompare(String(b.section))||String(a.button).localeCompare(String(b.button)));
  const tot=list.reduce((t,c)=>({sent:t.sent+c.sent,deliv:t.deliv+c.deliv,read:t.read+c.read,fail:t.fail+c.fail}),
    {sent:0,deliv:0,read:0,fail:0});
  /* ПРОЧЕРК СЧИТАЕТСЯ ПО СТРОКЕ, А НЕ ПО ПЕРИОДУ. Сначала флаг был один на весь отчёт, и
     стоило одному дню получить статусы — у всех остальных вместо прочерка вставал «0», то
     есть «ничего не доставлено». А это разные вещи: пока вебхук не дописывает статус, у
     строки его нет вовсе. День, в который и правда не доставили ничего, от дня без данных
     отличить нечем — Meta события «не доставлено» не присылает вовсе (отказ приходит сразу
     и считается в «Не ушло»), поэтому прочерк здесь честнее нуля. */
  const noData=list.some(c=>!c.deliv&&!c.read);
  const num=n=>n.toLocaleString('ru-RU');
  const cell=(n,on)=>on?`<b>${num(n)}</b>`:'<span class="wh-cat" title="Meta присылает статус доставки отдельным событием — см. примечание">—</span>';
  const body=list.map(c=>`<tr class="open">
      <td data-label="Дата">${esc(fmtDate(c.day))}</td>
      <td data-label="Раздел">${esc(WA_SECTION_RU[c.section]||'не записан')}</td>
      <td data-label="Кнопка">${esc(c.button?(typeof waBtnLabel==='function'?waBtnLabel(c.button):c.button):'не записана')}</td>
      <td data-label="Шаблон"><span class="wh-cat">${esc(c.template||'—')}</span></td>
      <td data-label="Отправлено"><b>${num(c.sent)}</b></td>
      <td data-label="Доставлено">${cell(c.deliv,c.deliv>0||c.read>0)}</td>
      <td data-label="Прочитано">${cell(c.read,c.deliv>0||c.read>0)}</td>
      <td data-label="Не ушло">${c.fail?`<b style="color:var(--rust)">${num(c.fail)}</b>`:'0'}</td>
      <td data-label="Почему не ушло">${Object.keys(c.err).length
        ? Object.entries(c.err).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`<div class="wh-cat">${esc(k)} — ${num(n)}</div>`).join('')
        : '<span class="wh-cat">—</span>'}</td>
    </tr>`).join('');
  wrap(`<div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Дата</th><th>Раздел</th><th>Кнопка</th><th>Шаблон</th><th>Отправлено</th>
      <th>Доставлено</th><th>Прочитано</th><th>Не ушло</th><th>Почему не ушло</th></tr></thead>
      <tbody>${body}<tr class="open" style="font-weight:700;background:var(--bg)">
        <td data-label="Дата">Итого</td><td data-label="Раздел">за ${waRepDays} дней</td><td></td><td></td>
        <td data-label="Отправлено">${num(tot.sent)}</td>
        <td data-label="Доставлено">${cell(tot.deliv,tot.deliv>0)}</td>
        <td data-label="Прочитано">${cell(tot.read,tot.deliv>0)}</td>
        <td data-label="Не ушло">${num(tot.fail)}</td><td></td></tr></tbody></table></div>
    ${!noData?'':`<div class="hint" style="margin-top:10px;line-height:1.6">
      <b>Про «Доставлено» и «Прочитано»:</b> прочерк означает «нет данных», а НЕ «не доставлено».
      Отправку подтвердила Meta, а статус доставки она присылает позже отдельным событием
      <b>message.status</b> — оно приходит на вебхук Kelesu, в функцию <b>kelesu-webhook</b>,
      и пока та не дописывает статус в журнал, взять его неоткуда. Что именно туда добавить —
      написано в конце <b>db/36</b>.</div>`}
    <div class="hint" style="margin-top:6px">Журнал хранит каждую отправку и не чистится — отдельного
      ежедневного сохранения не нужно, грид считает по нему за любой период.</div>`);
}
function waReportBind(){
  document.querySelectorAll('[data-warepd]').forEach(b=>{
    b.onclick=()=>{waRepDays=+b.dataset.warepd||14;waReportRender();};
  });
  if($('waRepReload'))$('waRepReload').onclick=()=>waReportRender();
}
