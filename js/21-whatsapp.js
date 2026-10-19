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
  const b = $('ordersWaSel'); if (!b) return;
  const n = ketSelected.size;
  b.textContent = n ? `💬 WhatsApp (${n})` : '💬 WhatsApp';
  b.disabled = !n;
  b.classList.toggle('is-armed', !!n);
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
    // Отправка клиентам — действие наружу и необратимое: отозвать сообщение нечем.
    if (!confirm(`Отправить «${t.name}» ${ok.length} получателям?\n\nСообщение уйдёт клиентам сразу, отозвать его нельзя.`)) return;

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
