/* Взаиморасчёты. Долги партнёров и курьеров идут на сервер settlements.
   Удалённые счета Kaspi Pay по заказам показываются отдельно: вкладка «Счета»
   — все выставленные, «Оплачено» — оплаченные. Касса счёта — касса того кассира,
   который его выставил. Первый кассир — ИП Зонова Наталья. */
let settlementsTab = "summary";
let settlementsModel = null;
let stSummaryByOrder = false;
const stSummaryOpen = new Set();

function stMoney(n) {
  return Number(n || 0).toLocaleString("ru-RU") + " ₸";
}
function stEsc(s) {
  return typeof esc === "function" ? esc(s) : String(s ?? "");
}

const ST_TABS = [
  ["summary", "Сводка"],
  ["awaiting", "Ожидает стоимости"],
  ["partners", "Партнёры"],
  ["pickup", "Заборщики"],
  ["delivery", "Доставщики"],
  ["forgotten", "Забытые смены"],
  ["admins", "Администраторы"],
  ["invoices", "Счета"],
  ["paid", "Оплачено"],
  ["overdue", "Прошлые периоды"],
  ["stale", "Старше 31 дня"],
  ["errors", "Ошибки"],
];

function settlementsDemo() {
  return {
    mode: "test",
    stored_mode: "test",
    effective_from: null,
    armed: false,
    debt: 18600,
    partners: 9000,
    pickup_couriers: 2400,
    delivery_couriers: 3200,
    admins: 4000,
    ready: 14600,
    invoiced: 4000,
    paid: 0,
    awaiting_price: 2,
    forgotten: [{ courierId: "c-2", date: "2026-11-23" }],
    invoices: [
      { id: "inv-1", status: "pending", amount: 4000, test: true, launch: "manual", payer_type: "admin", payer_id: "Алия", period_start: "2026-11-23", period_end: "2026-11-23", order_ids: ["10021", "10022"], kaspi_id: "TEST-inv-1" },
    ],
    obligations: [
      { id: "ob-1", order_id: "10011", pickup_id: "ЗБ-440", amount: 9000, period_date: "2026-11-23", holder_type: "partner", holder_id: "Магазин Арман", state: "open", origin: "partner_self" },
      { id: "ob-2", order_id: "10018", pickup_id: "ЗБ-441", amount: 2400, period_date: "2026-11-23", holder_type: "pickup_courier", holder_id: "Ерлан", state: "open", origin: "pickup_gold" },
      { id: "ob-3", order_id: "10021", pickup_id: "ЗБ-442", amount: 3200, period_date: "2026-11-24", holder_type: "delivery_courier", holder_id: "Данияр", state: "open", origin: "delivery_gold" },
      { id: "ob-4", order_id: "10022", pickup_id: "ЗБ-442", amount: 4000, period_date: "2026-11-22", holder_type: "admin", holder_id: "Алия", state: "invoiced", origin: "delivery_cash", invoice_id: "inv-1" },
    ],
    awaiting: [
      { order_id: "10030", code: "10030", pickup_id: "ЗБ-450" },
      { order_id: "10031", code: "10031", pickup_id: "ЗБ-450" },
    ],
    names: { "c-2": "Данияр" },
    preview: true,
  };
}

function settlementsMarkup(m) {
  m = m || settlementsDemo();
  const tab = settlementsTab;
  const owed = (m.obligations || []).filter((o) => o.state !== "paid" && !o.unplaced);
  const older = owed.filter((o) => o.period_date < "2026-11-24");
  const errors = (m.invoices || []).filter((i) => i.status === "error" || i.status === "unknown");
  const rows = tab === "partners" ? owed.filter((o) => o.holder_type === "partner")
    : tab === "pickup" ? owed.filter((o) => o.holder_type === "pickup_courier")
    : tab === "delivery" ? owed.filter((o) => o.holder_type === "delivery_courier")
    : tab === "admins" ? owed.filter((o) => o.holder_type === "admin")
    : tab === "paid" ? (m.invoices || []).filter((i) => i.status === "paid")
    : tab === "stale" ? owed.filter((o) => m.stale_before && o.period_date < m.stale_before)
    : tab === "overdue" ? older
    : tab === "errors" ? errors
    : tab === "invoices" ? (m.invoices || [])
    : tab === "forgotten" ? (m.forgotten || [])
    : tab === "awaiting" ? (m.awaiting || [])
    : (m.obligations || []);
  const modeLabel = m.load_error ? "не удалось загрузить"
    : m.stored_mode === "live" && !m.armed ? "боевой в базе, шлюз не вооружён — счета тестовые"
    : m.mode === "off" ? "выключено" : m.mode === "live" ? "боевой" : "тест";
  const table = settlementsTable(tab, rows, m);
  return `
    <div class="page-head"><div><h1>Взаиморасчёты</h1>
      <p>Новые заказы после даты включения. Старые заказы и касса не меняются. Режим: ${stEsc(modeLabel)}. Дата включения: ${m.effective_from ? stEsc(String(m.effective_from).slice(0, 16).replace("T", " ")) : "не задана"}.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost sm" id="st_excel" type="button">Excel</button>
        ${m.preview ? "" : `<button class="btn sm" id="st_reload" type="button">Обновить</button>`}
      </div></div>
    ${m.load_error ? "" : settlementsModeForm(m)}
    <div class="stats">
      ${stCard("К выплате", stMoney(m.debt))}
      ${stCard("Готово к счёту", stMoney(m.ready))}
      ${stCard("Уже в счетах", stMoney(m.invoiced))}
      ${stCard("Оплачено", stMoney(m.paid))}
    </div>
    <div class="stats">
      ${stCard("Партнёры", stMoney(m.partners))}
      ${stCard("Заборщики", stMoney(m.pickup_couriers))}
      ${stCard("Доставщики", stMoney(m.delivery_couriers))}
      ${stCard("Администраторы", stMoney(m.admins))}
    </div>
    <div class="seg" style="margin-bottom:14px;flex-wrap:wrap">${ST_TABS.map(([k, lbl]) =>
      `<button type="button" data-sttab="${k}" class="${tab === k ? "active" : ""}">${lbl}</button>`).join("")}</div>
    ${tab === "summary" ? `<p style="color:var(--muted);font-size:13px;margin-top:0">Ожидают стоимости: ${m.awaiting_price || 0}. Забытых смен: ${(m.forgotten || []).length}. Старше 31 дня: ${m.stale_total || 0} на ${stMoney(m.stale_amount || 0)}. Эти суммы остаются в учёте и не выставляются автоматом. ${(m.missing_kaspi || []).length ? "Без номера Kaspi: " + (m.missing_kaspi || []).length + "." : ""} Статус оплаты проверяется каждые 30 секунд.${stCanIssue() ? " Сумму долга по заказу можно исправить кнопкой ✎, пока счёт не выставлен; у плательщика с несколькими заказами сначала раскройте строку." : ""}</p>` : ""}
    ${tab === "stale" ? `<p style="color:var(--muted);font-size:13px">Задолженность старше автоматического восстановления. Она не исчезает. Счёт по ней выставляет менеджер вручную.</p>` : ""}
    ${m.load_error ? `<div class="empty"><div class="big">Список не загрузился</div>${stEsc(m.load_error)} Нажмите «Обновить». Заказы на месте, режим из-за этой ошибки не менялся.</div>` : `${settlementsKaspiBlock(tab, m)}${table}`}
    ${tab === "admins" && !m.preview ? settlementsAdminForm() : ""}`;
}

function settlementsModeForm(m) {
  const mode = m.stored_mode || m.mode || "off";
  const from = m.effective_from ? String(m.effective_from).slice(0, 16) : "";
  return `<div class="panel" style="padding:14px;margin-bottom:14px"><h3 style="margin:0 0 8px">Режим взаиморасчётов</h3>
    <div class="grid2">
      <div class="field"><label>Режим</label><select id="st_mode">
        <option value="off" ${mode === "off" ? "selected" : ""}>Выключено</option>
        <option value="test" ${mode === "test" ? "selected" : ""}>Тест, без Kaspi и без уведомлений</option>
        <option value="live" ${mode === "live" ? "selected" : ""}>Боевой</option>
      </select></div>
      <div class="field"><label>Начало действия</label><input id="st_from" type="datetime-local" value="${stEsc(from)}"></div>
    </div>
    <button class="btn sm primary" type="button" id="st_mode_save">Сохранить режим</button>
    <p style="color:var(--muted);font-size:12px">По умолчанию выключено. Боевой режим в этой поставке не ходит в Kaspi и не отправляет финансовые сообщения, пока шлюз отдельно не вооружён. Действующая оплата заказов не меняется.</p></div>`;
}

function stCard(title, value) {
  return `<div class="stat"><div class="stat-body"><div class="k">${stEsc(title)}</div><div class="v">${value}</div></div></div>`;
}

const ST_KIND = {
  partner: "Партнёр",
  pickup_courier: "Заборщик",
  delivery_courier: "Доставщик",
  admin: "Администратор",
};
const ST_STATE = {
  open: "К выплате",
  invoiced: "Выставлен счёт",
  paid: "Оплачено",
  awaiting_admin: "Ждёт подтверждения",
  pending: "Ждёт оплаты",
  cancelled: "Отменён",
  error: "Ошибка",
  unknown: "Статус неясен",
  rejected: "Отклонён",
};

function stIndex(list) {
  const map = new Map();
  (list || []).forEach((row) => { if (row && row.id) map.set(row.id, row); });
  return map;
}

function stCatalog() {
  const src = typeof S !== "undefined" ? S : {};
  return {
    order: stIndex(src.orders),
    pickup: stIndex(src.pickups),
    partner: stIndex(src.partners),
    courier: stIndex(src.couriers),
    delivery: stIndex(src.order_couriers),
  };
}

function stDay(v) {
  if (!v) return "—";
  if (typeof fmtDate === "function") return fmtDate(v);
  const p = String(v).slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(v);
}

function stOrderText(id, code, cat) {
  if (code) return String(code);
  const row = cat.order.get(id);
  return (row && row.code) || "—";
}

function stPickupText(id, name, cat) {
  if (name) return String(name);
  if (!id) return "—";
  const row = cat.pickup.get(id);
  return (row && row.name) || "—";
}

function stWho(type, id, name, cat) {
  const kind = ST_KIND[type] || "Долг";
  let who = name || "";
  if (!who && type === "partner") who = (cat.partner.get(id) || {}).name || "";
  if (!who && type === "pickup_courier") who = (cat.courier.get(id) || {}).fio || "";
  if (!who && type === "delivery_courier") who = (cat.delivery.get(id) || {}).fio || "";
  return who ? `${kind}: ${who}` : kind;
}
function stHolderName(o, cat) {
  if (o.holder_name) return String(o.holder_name);
  if (o.holder_type === "partner") return (cat.partner.get(o.holder_id) || {}).name || "";
  return "";
}
function stIsFizlicoRow(o, cat) {
  return typeof isFizlicoName === "function" && isFizlicoName(stHolderName(o, cat));
}
function stPhone10(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  const ten = d.length === 11 && (d[0] === "7" || d[0] === "8") ? d.slice(1) : d;
  return /^7\d{9}$/.test(ten) ? ten : "";
}
function stFizPhoneValue(o) {
  return o && o.invoice_phone ? String(o.invoice_phone) : "";
}
function stSummaryBillPhone(o) {
  const own = stPhone10(stFizPhoneValue(o));
  if (own && own !== stPhone10(o && o.client_phone)) return own;
  return stPhone10(o && o.kaspi_phone);
}
function stRowBillPhone(tr) {
  if (!tr) return "";
  const ownEl = tr.querySelector("[data-stfizphone]");
  const own = ownEl ? stPhone10(ownEl.value) : "";
  const columnEl = tr.querySelector("[data-stkaspi]");
  const column = columnEl ? stPhone10(columnEl.value) : "";
  const recipient = ownEl ? stPhone10(ownEl.getAttribute("data-stclient") || "") : "";
  if (own && own !== recipient) return own;
  if (column) return column;
  return own;
}
function stHolderCell(o, cat, m, tab) {
  const label = stWho(o.holder_type, o.holder_id, o.holder_name, cat);
  const fiz = tab === "summary" && stIsFizlicoRow(o, cat);
  const note = !fiz && stMissingKaspi(o, m) ? " · Не указан номер Kaspi" : "";
  const who = o.holder_type === "partner" && o.holder_id
    ? `<button class="btn ghost sm" type="button" data-stpartner="${stEsc(o.holder_id)}" data-stwho="${stEsc(label)}" title="Открыть карточку партнёра">${stEsc(label)}</button>`
    : `<span data-stwho="${stEsc(label)}">${stEsc(label)}</span>`;
  const phone = fiz ? `<input class="st-fiz-phone" data-stfizphone="${stEsc(o.order_id)}" data-stclient="${stEsc(stPhone10(o.client_phone))}" data-stsaved="${stEsc(stPhone10(stFizPhoneValue(o)))}" value="${stEsc(stSummaryBillPhone(o))}" inputmode="tel" autocomplete="off" placeholder="Номер для счёта" title="Счёт уходит на этот номер" style="width:148px;margin-left:8px;padding:4px 8px">` : "";
  return who + phone + (note ? stEsc(note) : "");
}

function stState(v) {
  return ST_STATE[v] || "—";
}
function stAgo(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  let mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 0) mins = 0;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h && !m) return "только что";
  if (!h) return `${m} мин назад`;
  return `${h} ч ${m} мин назад`;
}
function stPaintAges() {
  if (typeof document === "undefined") return;
  document.querySelectorAll("[data-stago]").forEach((el) => {
    el.textContent = stAgo(el.getAttribute("data-stago"));
  });
}
function stPaidClock(iso) {
  if (!iso || typeof fmtDateTime !== "function") return "";
  const text = fmtDateTime(iso);
  if (!text) return "";
  return `<div style="margin-top:3px;font-size:12px;font-weight:600;color:#1b7a32">${stEsc(text)}</div>`;
}
function stStateMark(kind, iso) {
  if (kind === "paid") {
    return `<span style="display:inline-block;padding:2px 8px;border-radius:8px;background:#e5f6e8;color:#1b7a32;font-weight:700">${stEsc(ST_STATE.paid)}</span>${stPaidClock(iso)}`;
  }
  const age = stAgo(iso);
  const when = age ? `<div data-stago="${stEsc(iso)}" style="margin-top:3px;font-size:12px;font-weight:600;color:#9a3412">${stEsc(age)}</div>` : "";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:8px;background:#fdecea;color:#b42318;font-weight:700">${stEsc(ST_STATE.invoiced)}</span>${when}`;
}
function stInvoiceAt(id, m) {
  const inv = ((m && m.invoices) || []).find((i) => i.id === id);
  return (inv && inv.created_at) || "";
}
function stInvoicePaidAt(id, m) {
  const inv = ((m && m.invoices) || []).find((i) => i.id === id);
  return (inv && inv.paid_at) || "";
}
function stLatestPaidAt(orders, m) {
  let best = "";
  (orders || []).forEach((o) => {
    if (!o || o.state !== "paid") return;
    const at = stInvoicePaidAt(o.invoice_id, m);
    if (at && (!best || at > best)) best = at;
  });
  return best;
}
function stEarliestInvoiceAt(orders, m) {
  let best = "";
  (orders || []).forEach((o) => {
    if (!o || o.state !== "invoiced") return;
    const at = stInvoiceAt(o.invoice_id, m);
    if (at && (!best || at < best)) best = at;
  });
  return best;
}

function stCanIssue() {
  if (typeof isAdmin === "function" && isAdmin()) return true;
  return typeof can === "function" && can("settlements", "edit");
}

function stMissingKaspi(o, m) {
  return (m.missing_kaspi || []).some((x) => x.holder_type === o.holder_type && x.holder_id === o.holder_id);
}

function stBillable(o) {
  return !!(o && o.state === "open" && !o.unplaced && o.holder_id && Number(o.amount) > 0);
}
/* ИСПРАВЛЕНИЕ СУММЫ ДОЛГА (26.11.2026). Сумму по заказу можно поправить, пока счёт не
   выставлен: сервер меняет её только у открытого долга (действие fees_set), а у долга «в
   счёте» и «оплачено» отвечает отказом — сначала отменяют счёт. Кнопка есть у того, кто
   выставляет счета. */
function stFixable(o) {
  return !!(stCanIssue() && o && o.order_id && !o.unplaced && (o.state === "open" || o.state === "awaiting_admin"));
}
function stAmountCell(o) {
  const sum = stMoney(o.amount);
  if (!stFixable(o)) return sum;
  return `<span class="st-sum">${sum}<button class="st-fix" type="button" data-stfix="${stEsc(o.order_id)}" title="Исправить сумму" aria-label="Исправить сумму">✎</button></span>`;
}
function stCancelCell(o) {
  if (!stCanIssue() || !o || o.state !== "invoiced" || !o.invoice_id) return "";
  return `<button class="btn sm" type="button" data-stcancel="${stEsc(o.invoice_id)}">Отменить счёт</button>`;
}
function stOpenInvoiceId(orders) {
  const ids = [...new Set((orders || []).filter((o) => o && o.state === "invoiced" && o.invoice_id).map((o) => o.invoice_id))];
  return ids.length === 1 ? ids[0] : "";
}
function stIssueCell(o, m, cat) {
  if (!stCanIssue() || !stBillable(o)) return "";
  const fiz = stIsFizlicoRow(o, cat);
  if (!fiz && stMissingKaspi(o, m)) return `<span style="color:var(--rust);font-size:12px">Сначала номер Kaspi</span>`;
  const mark = fiz ? ` data-stfiz="1" data-storder="${stEsc(o.order_id)}"` : "";
  return `<button class="btn sm primary" type="button" data-stissue="${stEsc(o.holder_type)}" data-stholder="${stEsc(o.holder_id)}" data-stday="${stEsc(o.period_date)}" data-stamount="${Number(o.amount) || 0}"${mark}>Выставить счёт</button>`;
}

function stPickBox(o, m, cat) {
  const fiz = stIsFizlicoRow(o, cat);
  if (!stCanIssue() || !stBillable(o) || (!fiz && stMissingKaspi(o, m))) return "";
  const mark = fiz ? ` data-stfiz="1" data-storder="${stEsc(o.order_id)}"` : "";
  return `<input type="checkbox" class="stChk" data-stpick="1" data-stissue="${stEsc(o.holder_type)}" data-stholder="${stEsc(o.holder_id)}" data-stday="${stEsc(o.period_date)}" data-stamount="${Number(o.amount) || 0}"${mark}>`;
}

const ST_FIND = {};
function stFindBag(scope) {
  if (!ST_FIND[scope]) ST_FIND[scope] = {};
  return ST_FIND[scope];
}
function stMatchSearch(hay, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const raw = String(hay || "").toLowerCase();
  if (raw.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length < 4) return false;
  return raw.replace(/\D/g, "").includes(digits);
}
function stMatchDay(day, from, to) {
  if (!from && !to) return true;
  const d = String(day || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
function stMatchSpan(start, end, from, to) {
  if (!from && !to) return true;
  const a = String(start || "").slice(0, 10);
  const b = String(end || start || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return false;
  const stop = /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : a;
  if (from && stop < from) return false;
  if (to && a > to) return false;
  return true;
}
function stKeep(row, spec, bag, skipKey) {
  if (!stMatchSearch(spec.text.map((k) => row[k] || "").join("\n"), bag.q)) return false;
  const picks = spec.picks || [];
  for (const p of picks) {
    if (p.key === skipKey) continue;
    const chosen = bag[p.key] || "";
    if (chosen && (row[p.key] || "") !== chosen) return false;
  }
  return spec.dates.every((d) => {
    const from = bag[d.key + "_from"] || "";
    const to = bag[d.key + "_to"] || "";
    if (d.start) return stMatchSpan(row[d.start], row[d.end], from, to);
    return stMatchDay(row[d.field], from, to);
  });
}
function stPickValues(rows, spec, bag, key) {
  return [...new Set((rows || []).filter((row) => stKeep(row, spec, bag, key)).map((row) => row[key] || "").filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"));
}
function stSlice(rows, spec, scope) {
  const bag = stFindBag(scope);
  const shown = (rows || []).filter((row) => stKeep(row, spec, bag));
  const active = !!(bag.q
    || (spec.picks || []).some((p) => bag[p.key])
    || spec.dates.some((d) => bag[d.key + "_from"] || bag[d.key + "_to"]));
  return { shown, active };
}
const ST_SORT = {};
function stSortBag(scope) {
  if (!ST_SORT[scope]) ST_SORT[scope] = { col: "", dir: 1 };
  return ST_SORT[scope];
}
function stSortRows(rows, scope) {
  const bag = stSortBag(scope);
  const filterScope = scope === "summary-payers" ? "summary" : scope;
  const byPaid = !bag.col && filterScope === "summary" && (stFindBag("summary").state || "") === "Оплачено";
  if (!bag.col && !byPaid) return rows;
  if (byPaid) {
    return rows.slice().sort((a, b) => String(b.paidAt || "").localeCompare(String(a.paidAt || "")));
  }
  const dir = bag.dir === -1 ? -1 : 1;
  const col = bag.col;
  return rows.slice().sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    if (typeof av === "number" || typeof bv === "number") return dir * ((Number(av) || 0) - (Number(bv) || 0));
    return dir * String(av || "").localeCompare(String(bv || ""), "ru", { numeric: true });
  });
}
function stTh(scope, key, label) {
  const bag = stSortBag(scope);
  const mark = bag.col === key ? (bag.dir === 1 ? " ▲" : " ▼") : "";
  return `<th class="fin-th fin-sortable" data-stsort="${stEsc(scope)}" data-stcol="${stEsc(key)}" title="Сортировать">${stEsc(label)}${mark}</th>`;
}
function stPageNote(n, total, bare) {
  const tail = bare || n === total ? "" : ` из ${total}`;
  return `<div class="st-pagecount" style="margin:0 0 8px;font-size:13px;font-weight:600">На странице: ${n}${tail}</div>`;
}
function stNumHead() {
  return `<th class="st-num" style="width:46px;color:var(--muted)">№</th>`;
}
function stNumCell(i) {
  return `<td class="st-num" data-label="№" style="color:var(--muted)">${i + 1}</td>`;
}
const ST_OB_FIND = {
  labels: ["Заказ", "Заявка", "Сумма"],
  text: ["order", "pickup", "amount"],
  picks: [
    { key: "who", label: "Кто держит долг" },
    { key: "state", label: "Состояние" },
  ],
  dates: [{ key: "period", label: "Период", field: "day" }],
};
function stObFind(tab) {
  if (tab !== "summary") return ST_OB_FIND;
  return {
    labels: ST_OB_FIND.labels,
    text: ST_OB_FIND.text,
    picks: [
      { key: "who", label: "Кто держит долг" },
      { key: "delivery", label: "Тип доставки" },
      { key: "pay", label: "Оплата" },
      { key: "state", label: "Состояние" },
    ],
    dates: ST_OB_FIND.dates,
  };
}
const ST_AWAIT_FIND = {
  labels: ["Заказ", "Заявка"],
  text: ["order", "pickup"],
  picks: [],
  dates: [],
};
const ST_SHIFT_FIND = {
  labels: ["Курьер"],
  text: ["courier"],
  picks: [],
  dates: [{ key: "day", label: "Дата", field: "day" }],
};
const ST_INV_FIND = {
  labels: ["Счёт", "Сумма", "Заказы"],
  text: ["bill", "amount", "orders"],
  picks: [
    { key: "who", label: "Кто платит" },
    { key: "status", label: "Статус" },
    { key: "kassa", label: "Касса" },
  ],
  dates: [{ key: "period", label: "Период", start: "start", end: "end" }],
};
const ST_KASPI_FIND = {
  labels: ["Заказ", "Телефон", "Сумма"],
  text: ["order", "phone", "amount"],
  picks: [
    { key: "status", label: "Статус" },
    { key: "kassa", label: "Касса" },
  ],
  dates: [
    { key: "issued", label: "Выставлен", field: "issued" },
    { key: "paid", label: "Оплачен", field: "paid" },
  ],
};
function stDayJumps(scope, key, bag) {
  if (scope !== "summary") return "";
  const today = typeof localToday === "function" ? localToday() : "";
  const days = [
    ["Сегодня", today],
    ["Завтра", typeof localDaysAgo === "function" ? localDaysAgo(-1) : ""],
    ["Вчера", typeof localDaysAgo === "function" ? localDaysAgo(1) : ""],
  ];
  const buttons = days.filter((pair) => pair[1]).map(([label, ymd]) => {
    const on = bag[key + "_from"] === ymd && bag[key + "_to"] === ymd;
    return `<button class="btn sm ${on ? "primary" : "ghost"}" type="button" data-stdayjump="${stEsc(ymd)}" data-stscope="${stEsc(scope)}" data-stkey="${stEsc(key)}">${stEsc(label)}</button>`;
  }).join("");
  return `<div style="display:flex;gap:6px;align-items:center">${buttons}</div>`;
}
function stFindBar(scope, spec, rows) {
  const bag = stFindBag(scope);
  const list = rows || [];
  (spec.picks || []).forEach((p) => {
    if (bag[p.key] && !stPickValues(list, spec, bag, p.key).includes(bag[p.key])) bag[p.key] = "";
  });
  const picks = (spec.picks || []).map((p) => {
    const vals = stPickValues(list, spec, bag, p.key);
    return `<div class="field" style="margin:0;min-width:170px"><label>${stEsc(p.label)}</label><select data-stscope="${stEsc(scope)}" data-stk="${stEsc(p.key)}"><option value="">Все</option>${vals.map((v) => `<option value="${stEsc(v)}" ${bag[p.key] === v ? "selected" : ""}>${stEsc(v)}</option>`).join("")}</select></div>`;
  }).join("");
  const dates = (spec.dates || []).map((d) => `<div class="field" style="margin:0"><label>${stEsc(d.label)} с</label><input type="date" data-stscope="${stEsc(scope)}" data-stk="${d.key}_from" value="${stEsc(bag[d.key + "_from"] || "")}"></div>
    <div class="field" style="margin:0"><label>${stEsc(d.label)} по</label><input type="date" data-stscope="${stEsc(scope)}" data-stk="${d.key}_to" value="${stEsc(bag[d.key + "_to"] || "")}"></div>${stDayJumps(scope, d.key, bag)}`).join("");
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:0 0 10px">
    <div class="field" style="margin:0;min-width:200px;flex:1"><label>Поиск</label><input data-stscope="${stEsc(scope)}" data-stk="q" value="${stEsc(bag.q || "")}" placeholder="${stEsc(spec.labels.join(", "))}"></div>
    ${picks}${dates}</div>`;
}
function stMiss(had, emptyHtml) {
  if (had) return `<div class="empty"><div class="big">Ничего не найдено</div>Измените поиск или фильтр.</div>`;
  return emptyHtml;
}
let stFindGen = 0;
async function stRedraw(focus) {
  const gen = ++stFindGen;
  const pos = focus && typeof focus.selectionStart === "number" ? focus.selectionStart : null;
  const scope = focus && focus.dataset ? focus.dataset.stscope : "";
  const key = focus && focus.dataset ? focus.dataset.stk : "";
  if (settlementsModel && settlementsModel.preview) {
    const main = $("main");
    main.innerHTML = settlementsMarkup(settlementsModel);
    settlementsBind(main);
  } else await renderSettlements();
  if (gen !== stFindGen || !scope || !key) return;
  const next = $("main") && $("main").querySelector(`[data-stscope="${scope}"][data-stk="${key}"]`);
  if (!next) return;
  next.focus();
  if (pos != null) try { next.setSelectionRange(pos, pos); } catch (e) {}
}
async function stApplyFindInput(el) {
  if (!el || !el.dataset) return;
  stFindBag(el.dataset.stscope)[el.dataset.stk] = el.value;
  await stRedraw(el);
}
function stApplySort(scope, col) {
  const bag = stSortBag(scope);
  if (bag.col === col) bag.dir = bag.dir === 1 ? -1 : 1;
  else { bag.col = col; bag.dir = 1; }
  stRedraw();
}

function settlementsKaspiRows(rows, tab) {
  const list = (rows || []).filter((i) => i && !i.test);
  if (tab === "paid") return list.filter((i) => i.status === "paid");
  if (tab === "invoices") return list;
  return [];
}

function settlementsKaspiBlock(tab, m) {
  if (!m || m.preview || (tab !== "invoices" && tab !== "paid")) return "";
  const name = m.kaspi_kassa || "ИП Зонова Наталья";
  const phone = (v) => (typeof phoneDisplay === "function" ? phoneDisplay(v) : (v ? "+7" + v : "—"));
  const when = (v) => (v && typeof fmtDateTime === "function" ? fmtDateTime(v) : stDay(v));
  const scope = tab + "-kaspi";
  const view = settlementsKaspiRows(m.kaspi_invoices, tab).map((i) => ({
    raw: i,
    order: i.order_code || "",
    phone: phone(i.phone10),
    amount: `${i.amount} ${stMoney(i.amount)}`,
    amountNum: Number(i.amount) || 0,
    status: stState(i.status),
    kassa: i.kassa_name || name,
    issued: String(i.created_at || "").slice(0, 10),
    paid: String(i.paid_at || "").slice(0, 10),
  }));
  const rows = stSortRows(stSlice(view, ST_KASPI_FIND, scope).shown, scope);
  const sum = rows.reduce((s, i) => s + i.amountNum, 0);
  const body = rows.length ? `<table class="resp-table"><thead><tr>${stNumHead()}${stTh(scope, "order", "Заказ")}${stTh(scope, "phone", "Телефон")}${stTh(scope, "amountNum", "Сумма")}${stTh(scope, "status", "Статус")}${stTh(scope, "issued", "Выставлен")}${stTh(scope, "paid", "Оплачен")}</tr></thead><tbody>${rows.map((i, n) =>
    `<tr>${stNumCell(n)}<td>${i.raw.order_id ? `<button class="btn ghost sm" type="button" data-storder="${stEsc(i.raw.order_id)}">${stEsc(i.order || "Заказ")}</button>` : stEsc(i.order || "—")}</td><td>${stEsc(i.phone)}</td><td>${stMoney(i.raw.amount)}</td><td>${stEsc(i.status)}</td><td>${stEsc(when(i.raw.created_at))}</td><td>${stEsc(i.raw.paid_at ? when(i.raw.paid_at) : "—")}</td></tr>`).join("")}</tbody></table>`
    : stMiss(view.length, `<div class="empty"><div class="big">${tab === "paid" ? "Оплат ещё нет" : "Счетов ещё нет"}</div></div>`);
  const names = [...new Set(view.map((i) => i.kassa).filter(Boolean))];
  const heading = names.length > 1 ? "Удалённые счета Kaspi Pay" : `Касса ${names[0] || name}`;
  return `<div class="panel" style="padding:14px;margin-bottom:14px"><h3 style="margin:0 0 8px">${stEsc(heading)}</h3>
    <p style="color:var(--muted);font-size:13px;margin-top:0">Удалённые счета Kaspi Pay. ${rows.length} на ${stMoney(sum)}.</p>
    ${stFindBar(scope, ST_KASPI_FIND, view)}${stPageNote(rows.length, view.length)}${body}</div>`;
}

async function settlementsLoadKaspi() {
  const fallback = "ИП Зонова Наталья";
  const kassas = (typeof S !== "undefined" && S.finance_kassa) || [];
  let settings = [];
  let invoices = [];
  if (typeof sb !== "undefined" && sb) {
    try {
      const s = await sb.from("kaspi_settings").select("id,title,kassa_id").order("id");
      if (!s.error) settings = s.data || [];
    } catch (e) { settings = []; }
    try {
      let q = await sb.from("kaspi_invoices").select("id,order_id,order_code,phone10,amount,status,test,created_at,paid_at,settings_id").order("created_at", { ascending: false }).limit(300);
      if (q.error) q = await sb.from("kaspi_invoices").select("id,order_id,order_code,phone10,amount,status,test,created_at,paid_at").order("created_at", { ascending: false }).limit(300);
      if (!q.error) invoices = q.data || [];
    } catch (e) { invoices = []; }
  }
  const nameOf = (row) => {
    if (!row) return fallback;
    const named = row.kassa_id && kassas.find((k) => k.id === row.kassa_id);
    if (named && named.name) return named.name;
    const title = String(row.title || "").trim();
    if (title) return title;
    if (Number(row.id) === 1) {
      const zonova = kassas.find((k) => k && k.kassa_type === "cashless" && /зонова/i.test(k.name || ""));
      return (zonova && zonova.name) || fallback;
    }
    return "Новый кассир";
  };
  const byId = new Map(settings.map((row) => [Number(row.id), row]));
  const first = byId.get(1);
  invoices = invoices.map((inv) => ({ ...inv, kassa_name: nameOf(byId.get(Number(inv.settings_id) || 1) || first) }));
  return { kaspi_kassa: nameOf(first), kaspi_invoices: invoices, kaspi_loaded: true };
}

function stPayerKey(o) {
  const type = encodeURIComponent(o.holder_type || "");
  if (o.holder_id) return type + "|" + encodeURIComponent(o.holder_id);
  return type + "||" + encodeURIComponent(o.holder_name || "");
}
function stSplitFiz(orders, cat) {
  const fiz = [];
  const rest = [];
  (orders || []).forEach((o) => (stIsFizlicoRow(o, cat) ? fiz : rest).push(o));
  return { fiz, rest };
}
function stDeliveryName(o) {
  if (o && o.delivery) return String(o.delivery);
  const order = (typeof S !== "undefined" ? (S.orders || []) : []).find((x) => x.id === (o && o.order_id));
  const id = order && order.delivery_id;
  const hit = ((typeof S !== "undefined" && S.delivery) || []).find((d) => d.id === id);
  return (hit && hit.name) || "";
}
function stPayLabel(o) {
  if (!o) return "—";
  if (o.holder_type === "pickup_courier" || o.holder_type === "delivery_courier") return "Каждый день";
  if (o.holder_type !== "partner" || !o.holder_id) return "—";
  return o.pay_cadence === "monthly" ? "Раз в месяц" : "Каждый день";
}
function stPartnerInput(o, kind) {
  const courierKaspi = kind === "kaspi" && o && o.holder_type === "pickup_courier" && o.holder_id;
  if (!courierKaspi && (!o || o.holder_type !== "partner" || !o.holder_id)) return "—";
  const value = kind === "wa" ? (o.whatsapp || "") : (o.kaspi_phone || "");
  if (!stCanIssue()) return stEsc(value || "—");
  const mark = kind === "wa" ? "data-stwa" : "data-stkaspi";
  const holder = courierKaspi ? ` data-stholder="pickup_courier"` : "";
  const title = kind === "wa" ? "WhatsApp" : "Номер для счёта";
  return `<input class="st-partner-field" ${mark}="1"${holder} data-stpartner="${stEsc(o.holder_id)}" data-stsaved="${stEsc(value)}" value="${stEsc(value)}" inputmode="tel" autocomplete="off" placeholder="${title}" title="${title}" style="width:132px;padding:4px 8px">`;
}
function stObView(rows, cat, m) {
  return (rows || []).map((o) => ({
    raw: o,
    order: stOrderText(o.order_id, o.order_code, cat),
    pickup: stPickupText(o.pickup_id, o.pickup_name, cat),
    delivery: stDeliveryName(o),
    who: stWho(o.holder_type, o.holder_id, o.holder_name, cat) + (stMissingKaspi(o, m) ? " Не указан номер Kaspi" : ""),
    pay: stPayLabel(o),
    amount: `${o.amount} ${stMoney(o.amount)}`,
    amountNum: Number(o.amount) || 0,
    state: stState(o.state),
    paidAt: o.state === "paid" ? stInvoicePaidAt(o.invoice_id, m) : "",
    day: String(o.period_date || "").slice(0, 10),
  }));
}
function stSummaryToggle() {
  return `<label class="pom-paid" style="margin:0 0 10px"><input type="checkbox" id="stByOrder" ${stSummaryByOrder ? "checked" : ""}> Развернуть по заказно</label>`;
}
function stPickBar(rows, m, cat) {
  if (!stCanIssue()) return "";
  const any = (rows || []).some((o) => stBillable(o) && (stIsFizlicoRow(o, cat) || !stMissingKaspi(o, m)));
  if (!any) return "";
  return `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:0 0 10px">
    <label class="pom-paid" style="margin:0"><input type="checkbox" id="stChkAll"> Выделить все</label>
    <button class="btn sm primary" type="button" id="stIssueSelected" disabled>Выставить счета отмеченным</button>
  </div>`;
}
function stSenderPhone(o) {
  const direct = o && String(o.sender_phone || "").trim();
  if (direct) return direct;
  const id = o && o.pickup_id;
  if (!id || typeof S === "undefined") return "";
  const row = (S.pickups || []).find((x) => x.id === id);
  return row && row.phone ? String(row.phone).trim() : "";
}
function stPhoneText(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (typeof phoneDisplay === "function") {
    const shown = phoneDisplay(value);
    if (shown) return shown;
  }
  return value;
}
function stWaChatBtn(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return `<button class="st-wa-logo" type="button" data-stwachat="${stEsc(phone)}" title="Открыть чат WhatsApp ИИ-агента" aria-label="Открыть чат WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#25D366" d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2z"/><path fill="#fff" d="M17.47 14.38c-.23-.12-1.36-.67-1.57-.75-.21-.08-.36-.12-.51.12-.15.23-.59.75-.72.9-.13.15-.27.17-.5.06-.23-.12-.97-.36-1.85-1.14-.68-.61-1.14-1.36-1.28-1.59-.13-.23-.01-.36.1-.47.1-.1.23-.27.34-.4.11-.14.15-.23.23-.38.08-.15.04-.29-.02-.4-.06-.12-.51-1.23-.7-1.68-.18-.44-.37-.38-.51-.39h-.43c-.15 0-.4.06-.61.29-.21.23-.8.78-.8 1.9 0 1.12.82 2.2.93 2.35.12.15 1.61 2.46 3.9 3.45.54.23.96.37 1.29.47.54.17.98.15 1.35.09.42-.06 1.36-.56 1.55-1.1.19-.53.19-.99.13-1.09-.06-.1-.21-.15-.44-.27z"/></svg></button>`;
}
function stFizWa(orders) {
  const phones = [];
  (orders || []).forEach((o) => {
    const phone = stPhoneText(stSenderPhone(o));
    if (phone && !phones.includes(phone)) phones.push(phone);
  });
  if (!phones.length) return "—";
  return phones.map((p) => stEsc(p) + stWaChatBtn(p)).join("<br>");
}
function stWaCell(o, cat, orders) {
  if (stIsFizlicoRow(o, cat)) return stFizWa(orders || [o]);
  const field = stPartnerInput(o, "wa");
  if (field === "—") return "—";
  return field + stWaChatBtn(o && o.whatsapp);
}
function stPartnerCells(o, cat) {
  return `<td data-label="Оплата">${stEsc(stPayLabel(o))}</td><td data-label="Номер для счёта">${stPartnerInput(o, "kaspi")}</td><td data-label="WhatsApp">${stWaCell(o, cat)}</td>`;
}
function stObRow(o, n, pick, cat, m, tab) {
  const delivery = tab === "summary" ? `<td data-label="Тип доставки">${stEsc(stDeliveryName(o) || "—")}</td>` : "";
  const partner = tab === "summary" ? stPartnerCells(o, cat) : "";
  const state = tab === "summary" ? stSummaryState(o, m, cat) : stEsc(stState(o.state));
  const action = pick ? (tab === "summary" ? stCancelCell(o) : (stIssueCell(o, m, cat) || "")) : "";
  return `<tr>${stNumCell(n)}${pick ? `<td>${stPickBox(o, m, cat)}</td>` : ""}<td><button class="btn ghost sm" type="button" data-storder="${stEsc(o.order_id)}" title="Открыть карточку заказа">${stEsc(stOrderText(o.order_id, o.order_code, cat))}</button></td><td><button class="btn ghost sm" type="button" data-stpickup="${stEsc(o.pickup_id || "")}">${stEsc(stPickupText(o.pickup_id, o.pickup_name, cat))}</button></td>${delivery}<td>${stHolderCell(o, cat, m, tab)}</td>${partner}<td>${stEsc(stDay(o.period_date))}</td><td data-label="Сумма">${stAmountCell(o)}</td><td>${state}</td>${pick ? `<td>${action}</td>` : ""}</tr>`;
}
function stObTable(tab, rows, m, cat, start) {
  const pick = stCanIssue();
  const from = Number(start) || 0;
  const delivery = tab === "summary" ? stTh(tab, "delivery", "Тип доставки") : "";
  const partner = tab === "summary" ? `${stTh(tab, "pay", "Оплата")}<th>Номер для счёта</th><th>WhatsApp</th>` : "";
  const sorted = stSortRows(stObView(rows, cat, m), tab).map((o) => o.raw);
  return `<table class="resp-table"><thead><tr>${stNumHead()}${pick ? "<th style=\"width:34px\"></th>" : ""}${stTh(tab, "order", "Заказ")}${stTh(tab, "pickup", "Заявка")}${delivery}${stTh(tab, "who", "Кто держит долг")}${partner}${stTh(tab, "day", "Период")}${stTh(tab, "amountNum", "Сумма")}${stTh(tab, "state", "Состояние")}${pick ? "<th></th>" : ""}</tr></thead><tbody>${sorted.map((o, n) => stObRow(o, from + n, pick, cat, m, tab)).join("")}</tbody></table>`;
}
function stGroupWho(o, cat, m) {
  const label = stWho(o.holder_type, o.holder_id, o.holder_name, cat);
  const note = !stIsFizlicoRow(o, cat) && stMissingKaspi(o, m) ? " · Не указан номер Kaspi" : "";
  const who = o.holder_type === "partner" && o.holder_id
    ? `<button class="btn ghost sm" type="button" data-stpartner="${stEsc(o.holder_id)}" data-stwho="${stEsc(label)}" title="Открыть карточку партнёра">${stEsc(label)}</button>`
    : `<span data-stwho="${stEsc(label)}">${stEsc(label)}</span>`;
  return who + (note ? stEsc(note) : "");
}
function stPayerGroups(orders, cat, m) {
  const map = new Map();
  (orders || []).forEach((o) => {
    const key = stPayerKey(o);
    let g = map.get(key);
    if (!g) g = map.set(key, { key, raw: o, orders: [], amountNum: 0, days: [], states: [], deliveries: [] }).get(key);
    g.orders.push(o);
    g.amountNum += Number(o.amount) || 0;
    const day = String(o.period_date || "").slice(0, 10);
    if (day && !g.days.includes(day)) g.days.push(day);
    const state = stState(o.state);
    if (!g.states.includes(state)) g.states.push(state);
    const delivery = stDeliveryName(o);
    if (delivery && !g.deliveries.includes(delivery)) g.deliveries.push(delivery);
  });
  return [...map.values()].map((g) => {
    const days = g.days.slice().sort();
    return {
      key: g.key,
      raw: g.raw,
      orders: g.orders,
      who: stWho(g.raw.holder_type, g.raw.holder_id, g.raw.holder_name, cat),
      pay: stPayLabel(g.raw),
      delivery: g.deliveries.length ? g.deliveries.join(", ") : "—",
      count: g.orders.length,
      amountNum: g.amountNum,
      state: g.states.length === 1 ? g.states[0] : "Разные",
      paidAt: stLatestPaidAt(g.orders, m),
      day: days[0] || "",
      dayLabel: !days.length ? "—" : days.length === 1 ? stDay(days[0]) : `${stDay(days[0])} — ${stDay(days[days.length - 1])}`,
    };
  });
}
function stGroupIssue(g, m, cat) {
  if (!stCanIssue()) return "";
  const open = (g.orders || []).filter(stBillable);
  if (!open.length) return "";
  const fiz = stIsFizlicoRow(g.raw, cat);
  if (fiz && (open.length > 1 || open.some((o) => !stSummaryBillPhone(o)))) {
    return `<button class="btn sm primary" type="button" data-stopen="${stEsc(g.key)}">Выставить счёт</button>`;
  }
  if (!fiz && stMissingKaspi(g.raw, m)) return `<span style="color:var(--rust);font-size:12px">Сначала номер Kaspi</span>`;
  const days = open.map((o) => String(o.period_date || "").slice(0, 10)).filter(Boolean).sort();
  const start = days[0] || "";
  const end = days[days.length - 1] || start;
  const amount = open.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const ids = open.map((o) => o.order_id).filter(Boolean).join(",");
  const one = fiz ? open[0] : null;
  const mark = one ? ` data-stfiz="1" data-storder="${stEsc(one.order_id)}" data-stphone="${stEsc(stSummaryBillPhone(one))}"` : "";
  return `<button class="btn sm primary" type="button" data-stissue="${stEsc(g.raw.holder_type)}" data-stholder="${stEsc(g.raw.holder_id)}" data-stday="${stEsc(start)}" data-stend="${stEsc(end)}" data-stamount="${amount}" data-storders="${stEsc(ids)}"${mark}>Выставить счёт</button>`;
}
function stGroupCancel(g) {
  if (!stCanIssue()) return "";
  const invoiceIds = [...new Set((g.orders || []).filter((o) => o && o.state === "invoiced" && o.invoice_id).map((o) => o.invoice_id))];
  return invoiceIds.map((id) => stCancelCell({ state: "invoiced", invoice_id: id })).join("");
}
function stSummaryState(o, m, cat) {
  if (o.state === "open") {
    const btn = stIssueCell(o, m, cat);
    return btn || stEsc(stState(o.state));
  }
  if (o.state === "paid") return stStateMark("paid", stInvoicePaidAt(o.invoice_id, m));
  if (o.state === "invoiced") return stStateMark("invoiced", stInvoiceAt(o.invoice_id, m));
  return stEsc(stState(o.state));
}
function stGroupStateCell(g, m, cat) {
  const issue = (g.orders || []).some(stBillable) ? stGroupIssue(g, m, cat) : "";
  if (g.state === "К выплате") return issue || stEsc(g.state);
  if (g.state === "Оплачено") return stStateMark("paid", g.paidAt || stLatestPaidAt(g.orders, m));
  if (g.state === "Выставлен счёт") return stStateMark("invoiced", stEarliestInvoiceAt(g.orders, m));
  return stEsc(g.state) + (issue ? `<div style="margin-top:6px">${issue}</div>` : "");
}
function stSummaryGrouped(view, m, cat) {
  const spec = stObFind("summary");
  const matched = stSlice(view, spec, "summary").shown.map((row) => row.raw);
  const split = stSplitFiz(matched, cat);
  const groups = stSortRows(stPayerGroups(split.rest, cat, m), "summary-payers");
  const fiz = stSortRows(stObView(split.fiz, cat, m), "summary").map((row) => row.raw);
  const allSplit = stSplitFiz(view.map((row) => row.raw), cat);
  const allGroups = stPayerGroups(allSplit.rest, cat, m).length + allSplit.fiz.length;
  const barFind = stFindBar("summary", spec, view);
  const toggle = stSummaryToggle();
  if (!groups.length && !fiz.length) {
    return barFind + toggle + stPageNote(0, allGroups, true) + stMiss(view.length, `<div class="empty"><div class="big">Записей нет</div>Долг появится после включения режима и подтверждения стоимости новых заказов.</div>`);
  }
  const openOrders = groups.filter((g) => stSummaryOpen.has(g.key)).flatMap((g) => g.orders).concat(fiz);
  const body = groups.map((g, n) => {
    const open = stSummaryOpen.has(g.key);
    const actions = stGroupCancel(g);
    const head = `<tr class="st-grow" data-stgroup="${stEsc(g.key)}" title="Показать заказы">${stNumCell(fiz.length + n)}<td data-label="Кто оплачивает долг"><span class="st-gmark">${open ? "▼" : "▶"}</span> ${stGroupWho(g.raw, cat, m)}</td><td data-label="Оплата">${stEsc(g.pay)}</td><td data-label="Номер для счёта">${stPartnerInput(g.raw, "kaspi")}</td><td data-label="WhatsApp">${stWaCell(g.raw, cat, g.orders)}</td><td data-label="Тип доставки">${stEsc(g.delivery)}</td><td data-label="Заказов">${g.count}</td><td data-label="Период">${stEsc(g.dayLabel)}</td><td data-label="Сумма">${g.orders.length === 1 ? stAmountCell(g.orders[0]) : stMoney(g.amountNum)}</td><td data-label="Состояние">${stGroupStateCell(g, m, cat)}</td><td data-label="">${actions ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${actions}</div>` : ""}</td></tr>`;
    if (!open) return head;
    return head + `<tr class="st-gbody"><td colspan="11" data-label="">${stObTable("summary", g.orders, m, cat)}</td></tr>`;
  }).join("");
  const table = groups.length ? `<table class="resp-table st-payers"><thead><tr>${stNumHead()}${stTh("summary-payers", "who", "Кто оплачивает долг")}${stTh("summary-payers", "pay", "Оплата")}<th>Номер для счёта</th><th>WhatsApp</th>${stTh("summary-payers", "delivery", "Тип доставки")}${stTh("summary-payers", "count", "Заказов")}${stTh("summary-payers", "day", "Период")}${stTh("summary-payers", "amountNum", "Сумма")}${stTh("summary-payers", "state", "Состояние")}<th></th></tr></thead><tbody>${body}</tbody></table>` : "";
  const people = fiz.length ? stObTable("summary", fiz, m, cat, 0) : "";
  return barFind + toggle + stPageNote(groups.length + fiz.length, allGroups, true) + stPickBar(openOrders, m, cat) + people + table;
}

function settlementsTable(tab, rows, m) {
  const cat = stCatalog();
  if (tab === "forgotten") {
    const view = rows.map((r) => ({
      raw: r,
      courier: (m.names && m.names[r.courierId]) || (cat.courier.get(r.courierId) || {}).fio || "Курьер",
      day: String(r.date || "").slice(0, 10),
    }));
    const shown = stSortRows(stSlice(view, ST_SHIFT_FIND, tab).shown, tab);
    const body = shown.length ? `<table class="resp-table"><thead><tr>${stNumHead()}${stTh(tab, "courier", "Курьер")}${stTh(tab, "day", "Дата")}<th></th></tr></thead><tbody>${shown.map((r, n) =>
      `<tr>${stNumCell(n)}<td>${stEsc(r.courier)}</td><td>${stEsc(stDay(r.day))}</td><td><button class="btn sm" type="button" data-stclose="${stEsc(r.raw.courierId)}" data-stdate="${stEsc(r.raw.date)}">Завершить смену</button></td></tr>`).join("")}</tbody></table>`
      : stMiss(view.length, `<div class="empty"><div class="big">Забытых смен нет</div></div>`);
    return stFindBar(tab, ST_SHIFT_FIND, view) + stPageNote(shown.length, view.length) + body;
  }
  if (tab === "awaiting") {
    const view = rows.map((r) => ({
      raw: r,
      order: stOrderText(r.order_id, r.code, cat),
      pickup: stPickupText(r.pickup_id, r.pickup_name, cat),
    }));
    const shown = stSortRows(stSlice(view, ST_AWAIT_FIND, tab).shown, tab);
    const body = shown.length ? `<table class="resp-table"><thead><tr>${stNumHead()}${stTh(tab, "order", "Заказ")}${stTh(tab, "pickup", "Заявка")}</tr></thead><tbody>${shown.map((r, n) =>
      `<tr>${stNumCell(n)}<td><button class="btn ghost sm" type="button" data-storder="${stEsc(r.raw.order_id)}">${stEsc(r.order)}</button></td><td>${stEsc(r.pickup)}</td></tr>`).join("")}</tbody></table>`
      : stMiss(view.length, `<div class="empty"><div class="big">Нет заказов без цены</div>Такие заказы не попадают в счёт.</div>`);
    return stFindBar(tab, ST_AWAIT_FIND, view) + stPageNote(shown.length, view.length) + body;
  }
  if (tab === "invoices" || tab === "paid" || tab === "errors") {
    const kassa = !m.preview && m.kaspi_kassa ? m.kaspi_kassa : "";
    const view = rows.map((i) => ({
      raw: i,
      bill: i.test ? "Тестовый счёт" : "Счёт",
      who: stWho(i.payer_type, i.payer_id, i.payer_name, cat),
      amount: `${i.amount} ${stMoney(i.amount)}`,
      amountNum: Number(i.amount) || 0,
      status: stState(i.status),
      kassa: i.test ? "" : kassa,
      orders: (i.order_ids || []).map((id, n) => stOrderText(id, (i.order_codes || [])[n], cat)).join(" "),
      start: String(i.period_start || "").slice(0, 10),
      end: String(i.period_end || i.period_start || "").slice(0, 10),
    }));
    const shown = stSortRows(stSlice(view, ST_INV_FIND, tab).shown, tab);
    const body = shown.length ? `<table class="resp-table"><thead><tr>${stNumHead()}${stTh(tab, "bill", "Счёт")}${stTh(tab, "who", "Кто платит")}${stTh(tab, "start", "Период")}${stTh(tab, "amountNum", "Сумма")}${stTh(tab, "status", "Статус")}${kassa ? stTh(tab, "kassa", "Касса") : ""}<th>Заказы</th></tr></thead><tbody>${shown.map((i, n) =>
      `<tr>${stNumCell(n)}<td>${stEsc(i.bill)}</td><td>${stEsc(i.who)}</td><td>${stEsc(stDay(i.start))} — ${stEsc(stDay(i.end))}</td><td>${stMoney(i.raw.amount)}</td><td>${stEsc(i.status)}</td>${kassa ? `<td>${i.kassa ? stEsc(i.kassa) : "—"}</td>` : ""}<td>${(i.raw.order_ids || []).map((id, k) => `<button class="btn ghost sm" type="button" data-storder="${stEsc(id)}">${stEsc(stOrderText(id, (i.raw.order_codes || [])[k], cat))}</button>`).join(" ")}</td></tr>`).join("")}</tbody></table>`
      : stMiss(view.length, `<div class="empty"><div class="big">Счетов нет</div></div>`);
    return stFindBar(tab, ST_INV_FIND, view) + stPageNote(shown.length, view.length) + body;
  }
  const spec = stObFind(tab);
  const view = stObView(rows, cat, m);
  const shown = stSortRows(stSlice(view, spec, tab).shown, tab);
  rows = shown.map((o) => o.raw);
  const barFind = stFindBar(tab, spec, view);
  const toggle = tab === "summary" ? stSummaryToggle() : "";
  if (tab === "summary" && !stSummaryByOrder) return stSummaryGrouped(view, m, cat);
  const bare = tab === "summary";
  if (!rows.length) return barFind + toggle + stPageNote(0, view.length, bare) + stMiss(view.length, `<div class="empty"><div class="big">Записей нет</div>Долг появится после включения режима и подтверждения стоимости новых заказов.</div>`);
  return barFind + toggle + stPageNote(rows.length, view.length, bare) + stPickBar(rows, m, cat) + stObTable(tab, rows, m, cat);
}

function settlementsAdminForm() {
  return `<div class="panel" style="padding:14px;margin-top:14px"><h3 style="margin:0 0 8px">Администратор города</h3>
    <div class="grid2">
      <div class="field"><label>Имя</label><input id="st_adm_name"></div>
      <div class="field"><label>Город</label><select id="st_adm_city"><option value="">—</option>${(typeof S !== "undefined" ? S.cities || [] : []).map((c) => `<option value="${c.id}">${stEsc(c.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Номер для удалённых счетов Kaspi</label><input id="st_adm_phone" inputmode="numeric" placeholder="7XXXXXXXXX"><span class="hint">Не номер входа и не WhatsApp. Изменение попадает в историю.</span></div>
    </div>
    <button class="btn sm primary" type="button" id="st_adm_save">Сохранить администратора</button>
    <p style="color:var(--muted);font-size:12px">В одном городе может быть несколько администраторов. Счёт ему выставляет менеджер вручную.</p></div>`;
}

function stWaChatId(phone) {
  if (typeof gaChatIdFromPhone === "function") return gaChatIdFromPhone(phone);
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) d = "7" + d;
  else if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length < 11 || d.length > 15) return "";
  return d + "@c.us";
}
function stCanWaSend() {
  if (typeof isAdmin === "function" && isAdmin()) return true;
  return typeof can === "function" && can("greenapi", "create");
}
function stWaBubbles(rows) {
  if (!rows || !rows.length) return `<div class="hint">Переписки с этим номером пока нет. Напишите первым — сообщение уйдёт с номера ИИ-агента.</div>`;
  return rows.map((m) => {
    const out = m.direction === "outbound";
    const who = out && m.via === "ai" ? "ИИ-ассистент" : (out ? (m.sent_by_name || "Мы") : "Клиент");
    const time = typeof fmtLogTime === "function" ? ((fmtLogTime(m.created_at) || {}).time || "") : "";
    return `<div style="display:flex;justify-content:${out ? "flex-end" : "flex-start"};margin-bottom:6px">
      <div style="max-width:80%;padding:8px 12px;border-radius:12px;background:${out ? "#dcf8c6" : "#fff"};border:1px solid var(--line);font-size:13px;white-space:pre-wrap;word-break:break-word">
        <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${stEsc(who)}</div>
        ${stEsc(m.body_text || "—")}
        <div style="font-size:10px;color:var(--muted);margin-top:2px;text-align:right">${stEsc(time)}</div>
      </div>
    </div>`;
  }).join("");
}
async function stWaMessages(chatId) {
  if (typeof sb === "undefined" || !sb) return { rows: [], error: "Нет связи с базой" };
  const q = await sb.from("green_messages").select("direction,body_text,created_at,via,sent_by_name")
    .eq("chat_id", chatId).order("created_at", { ascending: false }).limit(200);
  if (q.error) return { rows: [], error: q.error.message || "Переписка не прочиталась" };
  return { rows: (q.data || []).slice().reverse(), error: "" };
}
async function stWaPaint(chatId) {
  const box = $("stWaBox");
  if (!box) return;
  const got = await stWaMessages(chatId);
  if (!$("stWaBox")) return;
  $("stWaBox").innerHTML = got.error
    ? `<div class="hint" style="color:var(--rust)">${stEsc(got.error)}</div>`
    : stWaBubbles(got.rows);
  $("stWaBox").scrollTop = $("stWaBox").scrollHeight;
}
async function stOpenWaChat(phone) {
  const chatId = stWaChatId(phone);
  if (!chatId) {
    if (typeof toast === "function") toast("Номер не похож на телефон");
    return;
  }
  const shown = typeof phoneDisplay === "function" ? (phoneDisplay(phone) || phone) : phone;
  const send = stCanWaSend();
  const foot = send
    ? `<div style="display:flex;gap:8px;margin-top:10px;align-items:flex-end">
        <textarea id="stWaText" rows="2" placeholder="Сообщение клиенту…" style="flex:1;min-height:52px"></textarea>
        <button class="btn primary" type="button" id="stWaSend">Отправить</button>
      </div>
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px">
        <span class="hint">Сообщение уйдёт с номера ИИ-агента.</span>
        <button class="btn ghost sm" type="button" id="stWaHist">История с телефона</button>
      </div>`
    : `<div class="hint" style="margin-top:8px">Прочитать переписку можно. Написать — по праву «WhatsApp Ассистент приёма заявок → создание».</div>`;
  if (typeof showInfo !== "function") return;
  const ov = showInfo("WhatsApp ИИ-агента · " + shown, `<div id="stWaBox" style="min-height:240px;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:10px;background:#f7f7f4">Загружаем переписку…</div>${foot}`, { wide: true });
  await stWaPaint(chatId);
  if (!ov) return;
  const hist = ov.querySelector("#stWaHist");
  if (hist) hist.onclick = async () => {
    hist.disabled = true;
    const res = typeof gaCall === "function" ? await gaCall("history", { chat_id: chatId, count: 200 }) : { error: "Чат ИИ-агента недоступен" };
    hist.disabled = false;
    if (!res || res.error) {
      if (typeof toast === "function") toast("История не загрузилась: " + ((res && res.error) || "сервер не ответил"));
      return;
    }
    await stWaPaint(chatId);
  };
  const btn = ov.querySelector("#stWaSend");
  const ta = ov.querySelector("#stWaText");
  if (!btn || !ta) return;
  const sendNow = async () => {
    const text = String(ta.value || "").trim();
    if (!text) {
      if (typeof toast === "function") toast("Нечего отправлять");
      return;
    }
    btn.disabled = true;
    const res = typeof gaCall === "function" ? await gaCall("send", { chat_id: chatId, text }) : { error: "Чат ИИ-агента недоступен" };
    btn.disabled = false;
    if (!res || res.error || res.ok === false) {
      if (typeof toast === "function") toast("Не отправлено: " + ((res && res.error) || "сервер не ответил"));
      return;
    }
    ta.value = "";
    if (typeof toast === "function") toast("Отправлено");
    await stWaPaint(chatId);
  };
  btn.onclick = sendNow;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow(); }
  };
}

function settlementsBind(root) {
  if (!root) return;
  root.querySelectorAll("[data-sttab]").forEach((b) => b.onclick = () => {
    settlementsTab = b.dataset.sttab;
    if (settlementsModel && settlementsModel.preview) {
      root.innerHTML = settlementsMarkup(settlementsModel);
      settlementsBind(root);
      return;
    }
    renderSettlements();
  });
  root.querySelectorAll("button[data-storder]:not([data-stissue])").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    settlementsOpenOrder(b.dataset.storder);
  });
  root.querySelectorAll("button[data-stissue]").forEach((b) => b.onclick = () => settlementsIssueRow(b));
  root.querySelectorAll("button[data-stfix]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    settlementsFixAmount(b.dataset.stfix);
  });
  root.querySelectorAll("button[data-stopen]").forEach((b) => b.onclick = () => {
    stSummaryOpen.add(b.dataset.stopen);
    if (typeof toast === "function") toast("У физлица номер и счёт указываются в каждом заказе");
    const y = window.scrollY;
    Promise.resolve(stRedraw()).then(() => window.scrollTo(0, y));
  });
  root.querySelectorAll("[data-stcancel]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    settlementsCancelInvoice(b.dataset.stcancel);
  });
  settlementsBindPick(root);
  root.querySelectorAll("[data-stpickup]").forEach((b) => b.onclick = () => settlementsOpenPickup(b.dataset.stpickup));
  root.querySelectorAll("[data-stpartner]").forEach((b) => b.onclick = () => settlementsOpenPartner(b.dataset.stpartner));
  root.querySelectorAll("[data-stfizphone]").forEach((inp) => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } };
    inp.onchange = () => settlementsSaveFizPhone(inp);
  });
  root.querySelectorAll("[data-stkaspi],[data-stwa]").forEach((inp) => {
    inp.onclick = (e) => e.stopPropagation();
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } };
    inp.onchange = () => settlementsSavePartnerField(inp, inp.hasAttribute("data-stwa") ? "wa" : "kaspi");
  });
  root.querySelectorAll("[data-stwachat]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const cell = b.closest("td");
    const inp = cell && cell.querySelector("[data-stwa]");
    stOpenWaChat(inp ? inp.value : b.dataset.stwachat);
  });
  const excel = root.querySelector("#st_excel");
  if (excel) excel.onclick = settlementsExcel;
  const reload = root.querySelector("#st_reload");
  if (reload) reload.onclick = async () => {
    if (!settlementsModel || settlementsModel.preview || settlementsModel.load_error) { settlementsModel = null; renderSettlements(); return; }
    const label = reload.textContent;
    reload.disabled = true;
    reload.textContent = "Проверяю оплаты…";
    await stAskReconcile();
    await stRefreshQuiet();
    if (reload.isConnected) { reload.disabled = false; reload.textContent = label; }
  };
  root.querySelectorAll("[data-stclose]").forEach((b) => b.onclick = () => settlementsCloseShift(b.dataset.stclose, b.dataset.stdate));
  const modeSave = root.querySelector("#st_mode_save");
  if (modeSave) modeSave.onclick = settlementsSaveMode;
  const save = root.querySelector("#st_adm_save");
  if (save) save.onclick = settlementsSaveAdmin;
  root.querySelectorAll("[data-stdayjump]").forEach((b) => b.onclick = () => {
    const bag = stFindBag(b.dataset.stscope);
    const key = b.dataset.stkey || "period";
    const ymd = b.dataset.stdayjump || "";
    if (!ymd) return;
    if (bag[key + "_from"] === ymd && bag[key + "_to"] === ymd) {
      bag[key + "_from"] = "";
      bag[key + "_to"] = "";
    } else {
      bag[key + "_from"] = ymd;
      bag[key + "_to"] = ymd;
    }
    stRedraw();
  });
  root.querySelectorAll("[data-stscope]").forEach((el) => {
    if (el.tagName === "SELECT") el.onchange = () => stApplyFindInput(el);
    else el.oninput = () => stApplyFindInput(el);
  });
  root.querySelectorAll("[data-stsort]").forEach((th) => th.onclick = () => stApplySort(th.dataset.stsort, th.dataset.stcol));
  const byOrder = root.querySelector("#stByOrder");
  if (byOrder) byOrder.onchange = () => {
    stSummaryByOrder = byOrder.checked;
    const y = window.scrollY;
    Promise.resolve(stRedraw()).then(() => window.scrollTo(0, y));
  };
  root.querySelectorAll("[data-stgroup]").forEach((tr) => tr.onclick = (e) => {
    if (e.target.closest("button, a, input, select, textarea, label")) return;
    const key = tr.dataset.stgroup;
    if (stSummaryOpen.has(key)) stSummaryOpen.delete(key);
    else stSummaryOpen.add(key);
    const y = window.scrollY;
    Promise.resolve(stRedraw()).then(() => window.scrollTo(0, y));
  });
  root.querySelectorAll("[data-stcash]").forEach((b) => b.onclick = async () => {
    const res = await callEdge("settlements", { action: "cash_confirm", order_id: b.dataset.stcash });
    if (typeof toast === "function") toast(res && res.error ? res.error : "Долг перенесён на администратора");
    settlementsModel = null;
    renderSettlements();
  });
}

const ST_PAY_MS = 30000;
let stPayTimer = 0;
let stPayBusy = false;
let stPayAway = false;
let stPayListen = false;

function stPayStamp(m) {
  if (!m) return "";
  const obs = (m.obligations || []).map((o) => [o.id, o.state, o.amount, o.invoice_id].join(":")).join("|");
  const inv = (m.invoices || []).map((i) => [i.id, i.status, i.amount, i.paid_at].join(":")).join("|");
  return [m.debt, m.ready, m.invoiced, m.paid, obs, inv].join("#");
}

function stKeepPayExtras(prev, next) {
  next.kaspi_kassa = prev.kaspi_kassa;
  next.kaspi_invoices = prev.kaspi_invoices;
  next.kaspi_loaded = prev.kaspi_loaded;
  const known = new Map((prev.obligations || []).filter((o) => o.delivery_id).map((o) => [o.order_id, o.delivery_id]));
  let missing = false;
  (next.obligations || []).forEach((o) => {
    if (known.has(o.order_id)) o.delivery_id = known.get(o.order_id);
    else if (o.order_id) missing = true;
  });
  next.delivery_loaded = !!prev.delivery_loaded && !missing;
  return missing;
}

async function stAskReconcile() {
  try { await callEdge("settlements", { action: "reconcile" }); }
  catch (e) { /* сводка откроется и со статусом, который уже записан */ }
}

/* ПЕРЕРИСОВКА НА МЕСТЕ: без «Загружаем…», с прежней прокруткой и курсором. Набранное в поле,
   которое сейчас в фокусе (номер для счёта), переносится в новую разметку — иначе обновление
   стирало бы его под руками. */
function stPaintInPlace() {
  const main = $("main");
  if (!main || !settlementsModel) return;
  const y = window.scrollY;
  const active = document.activeElement;
  const inMain = active && active.tagName === "INPUT" && main.contains(active) && active.type !== "checkbox" && active.type !== "radio";
  const sel = inMain ? "input" + Object.keys(active.dataset).map((k) => `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${String(active.dataset[k]).replace(/["\\]/g, "\\$&")}"]`).join("") : "";
  const typed = inMain ? active.value : "";
  const pos = inMain && typeof active.selectionStart === "number" ? active.selectionStart : null;
  main.innerHTML = settlementsMarkup(settlementsModel);
  settlementsBind(main);
  window.scrollTo(0, y);
  if (sel && sel !== "input") {
    let next = null;
    try { next = main.querySelector(sel); } catch (e) { next = null; }
    if (next) {
      next.value = typed;
      next.focus();
      if (pos != null) try { next.setSelectionRange(pos, pos); } catch (e) {}
    }
  }
}

/* ОБНОВЛЕНИЕ БЕЗ ПЕРЕЗАГРУЗКИ ЭКРАНА (27.11.2026). Раньше после каждого счёта модель
   сбрасывалась и раздел рисовался заново с «Загружаем взаиморасчёты…»: прокрутка уезжала
   наверх, и выставить счета подряд было нельзя. Теперь сводка перечитывается в фоне. */
async function stRefreshQuiet() {
  if (typeof S === "undefined" || S.tab !== "settlements") return;
  if (!settlementsModel || settlementsModel.preview || settlementsModel.load_error) { settlementsModel = null; await renderSettlements(); return; }
  let res = null;
  try { res = await callEdge("settlements", { action: "summary" }); } catch (e) { res = null; }
  if (!res || res.error || res.success === false) return;
  if (typeof S === "undefined" || S.tab !== "settlements") return;
  if (stIssueWaiting) return;   // пока шёл запрос, в очередь поставили ещё счёт — обновим после него
  const missing = stKeepPayExtras(settlementsModel, res);
  settlementsModel = res;
  if (missing) await stAttachDelivery(settlementsModel);
  if (typeof S === "undefined" || S.tab !== "settlements") return;
  stPaintInPlace();
}

/* ОЧЕРЕДЬ СЧЕТОВ. Нажатия «Выставить счёт» не ждут друг друга на экране, но на сервер уходят
   СТРОГО ПО ОДНОМУ: сервер выдаёт номер счёта по своей копии учёта, и два одновременных
   запроса получили бы один и тот же номер. Пока очередь не пуста, фоновая проверка оплат
   стоит — она пишет тот же учёт. */
let stIssueChain = Promise.resolve();
let stIssueWaiting = 0;
function stIssueEnqueue(job) {
  stIssueWaiting += 1;
  stIssueChain = stIssueChain.then(job).catch((e) => console.error("settlements issue", e)).then(async () => {
    stIssueWaiting -= 1;
    if (!stIssueWaiting) await stRefreshQuiet();
  });
  return stIssueChain;
}
// Счёт выставлен — отмечаем это в памяти сразу, не дожидаясь перечитывания сводки.
function stMarkIssued(inv, sel) {
  const m = settlementsModel;
  if (!m) return;
  const hit = [];
  (m.obligations || []).forEach((o) => {
    if (!o || o.state !== "open" || o.holder_type !== sel.type || String(o.holder_id) !== String(sel.holder)) return;
    if (sel.orders.length ? !sel.orders.includes(String(o.order_id)) : (String(o.period_date) < sel.day || String(o.period_date) > sel.end)) return;
    o.state = "invoiced";
    o.invoice_id = inv.id || o.invoice_id || "";
    hit.push(o.order_id);
  });
  if (inv.id && !(m.invoices || []).some((i) => i.id === inv.id)) {
    m.invoices = (m.invoices || []).concat([{ id: inv.id, amount: inv.amount, status: inv.status || "pending", test: !!inv.test, order_ids: hit, created_at: new Date().toISOString(), paid_at: null }]);
  }
}

async function stPullPayment() {
  if (stPayBusy || stIssueWaiting) return;
  if (typeof S === "undefined" || S.tab !== "settlements") { stStopPayWatch(); return; }
  if (typeof document !== "undefined" && document.hidden) return;
  if (!settlementsModel || settlementsModel.preview || settlementsModel.load_error) return;
  stPayBusy = true;
  try {
    // Только чтение сводки: оплаты сверяет планировщик раз в минуту. Сверка из каждой открытой
    // вкладки раз в полминуты занимала сервер почти непрерывно и накладывалась на его записи.
    const res = await callEdge("settlements", { action: "summary" });
    if (!res || res.error || res.success === false) return;
    if (typeof S === "undefined" || S.tab !== "settlements") return;
    if (stPayStamp(res) === stPayStamp(settlementsModel)) { stPaintAges(); return; }
    if (stIssueWaiting) return;
    const missing = stKeepPayExtras(settlementsModel, res);
    settlementsModel = res;
    if (missing) await stAttachDelivery(settlementsModel);
    if (typeof S === "undefined" || S.tab !== "settlements") return;
    stPaintInPlace();
  } finally {
    stPayBusy = false;
  }
}

function stStopPayWatch() {
  if (!stPayTimer) return;
  clearInterval(stPayTimer);
  stPayTimer = 0;
  stPayAway = true;
}

function stWatchPayments() {
  if (!stPayListen && typeof document !== "undefined") {
    stPayListen = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && typeof S !== "undefined" && S.tab === "settlements") stPullPayment();
    });
  }
  const away = stPayAway;
  stPayAway = false;
  if (!stPayTimer) stPayTimer = setInterval(stPullPayment, ST_PAY_MS);
  if (away) stPullPayment();
}

async function renderSettlements() {
  const main = $("main");
  if (typeof canMod === "function" && !canMod("settlements") && !(typeof isAdmin === "function" && isAdmin())) {
    stStopPayWatch();
    main.innerHTML = '<div class="empty"><div class="big">Нет доступа к взаиморасчётам</div></div>';
    return;
  }
  if (!settlementsModel) {
    main.innerHTML = '<div class="empty"><div class="big">Загружаем взаиморасчёты…</div></div>';
    /* Сверку оплат (reconcile) при открытии НЕ ждём. Сервер после неё записывает весь учёт
       построчно — это 13–17 секунд, а сама сводка читается за секунду. Оплаты и без того
       сверяет планировщик каждую минуту (задание settlement-reconcile); немедленная проверка —
       кнопкой «Обновить». */
    const res = await callEdge("settlements", { action: "summary" });
    if (!res || res.error || res.success === false) {
      const why = (res && (res.error || res.message)) || "Функция взаиморасчётов ещё не опубликована";
      settlementsModel = {
        mode: "off", stored_mode: "off", effective_from: null, armed: false,
        debt: 0, partners: 0, pickup_couriers: 0, delivery_couriers: 0, admins: 0,
        ready: 0, invoiced: 0, paid: 0, awaiting_price: 0, forgotten: [], invoices: [], obligations: [], awaiting: [],
        load_error: why,
      };
    } else settlementsModel = res;
    if (settlementsModel && !settlementsModel.preview && !settlementsModel.kaspi_loaded) {
      Object.assign(settlementsModel, await settlementsLoadKaspi());
    }
    if (settlementsModel && !settlementsModel.preview) await stAttachDelivery(settlementsModel);
    // Суммы сверяем уже ПОСЛЕ показа экрана: исправление на сервере идёт долго, и ждать его
    // с пустым экраном незачем. Нашлось что править — сводка перечитается на месте.
    if (settlementsModel && !settlementsModel.preview && !settlementsModel.load_error) {
      const loaded = settlementsModel;
      setTimeout(async () => {
        if (settlementsModel !== loaded || stIssueWaiting) return;
        const fixed = await stSyncFees(loaded);
        if (!fixed) return;
        if (typeof toast === "function") toast(`Суммы долга приведены к цене из заказа: ${fixed}`, 6000);
        await stRefreshQuiet();
      }, 0);
    }
  }
  main.innerHTML = settlementsMarkup(settlementsModel);
  settlementsBind(main);
  if (settlementsModel && !settlementsModel.preview && !settlementsModel.load_error) stWatchPayments();
}

async function stAttachDelivery(model) {
  if (!model || model.delivery_loaded) return;
  const ids = [...new Set((model.obligations || []).map((o) => o.order_id).filter(Boolean))];
  const byOrder = new Map();
  if (typeof sb !== "undefined" && sb && ids.length) {
    for (let i = 0; i < ids.length; i += 80) {
      try {
        const q = await sb.from("orders").select("id,delivery_id").in("id", ids.slice(i, i + 80));
        if (!q.error) (q.data || []).forEach((row) => byOrder.set(row.id, row.delivery_id || ""));
      } catch (e) { /* тип останется пустым, сводка всё равно откроется */ }
    }
  }
  const types = (typeof S !== "undefined" && Array.isArray(S.delivery)) ? S.delivery : [];
  const known = new Set(types.map((d) => d.id));
  const missing = [...byOrder.values()].some((id) => id && !known.has(id));
  if (missing && typeof sb !== "undefined" && sb) {
    try {
      const q = await sb.from("delivery_types").select("id,name");
      if (!q.error) (q.data || []).forEach((d) => { if (d && d.id && !known.has(d.id)) types.push(d); });
    } catch (e) { /* имя типа не подставится */ }
  }
  const nameOf = (id) => {
    const hit = types.find((d) => d.id === id);
    return (hit && hit.name) || "";
  };
  (model.obligations || []).forEach((o) => {
    if (o.delivery) return;
    const id = byOrder.has(o.order_id) ? byOrder.get(o.order_id) : (((typeof S !== "undefined" ? (S.orders || []) : []).find((x) => x.id === o.order_id) || {}).delivery_id);
    o.delivery = nameOf(id);
  });
  model.delivery_loaded = true;
}

/* СУММА ДОЛГА ДОГОНЯЕТ ЦЕНУ ИЗ ЗАКАЗА (27.11.2026). Долг открывает заборщик галочкой
   «Оплачено отправителем» в карточке заявки — в этот момент заказ ещё заготовка с курьерским
   типом доставки, и в долг уходит курьерский тариф. Потом менеджер заказов выбирает
   «Почтовая»: карточка пересчитывает запомненную цену заказа (order_sum_orig), но сервер
   взаиморасчётов менять сумму долга менеджеру заказов не даёт (нет права «Взаиморасчёты»),
   и отказ молча проглатывается. Итог: тип «Почтовая», а сумма курьерская.
   Поэтому тот, кто выставляет счета, при открытии сводки сверяет открытые долги с ценой в
   заказе и поправляет расхождения тем же действием fees_set, что и кнопка ✎.
   Не трогаем: пакеты M и L (их сумму сервер считает сам), долги «в счёте» и «оплачено»,
   и заказы с нулевой запомненной ценой — обнулять долг автоматом нельзя, это решает человек. */
async function stSyncFees(model) {
  if (!stCanIssue() || typeof sb === "undefined" || !sb) return 0;
  const open = (model.obligations || []).filter((o) => o && o.order_id && !o.unplaced && (o.state === "open" || o.state === "awaiting_admin"));
  if (!open.length) return 0;
  const ids = [...new Set(open.map((o) => o.order_id))];
  const orders = new Map();
  try {
    for (let i = 0; i < ids.length; i += 80) {
      const q = await sb.from("orders").select("id,size,paid_by_sender,order_sum_orig").in("id", ids.slice(i, i + 80));
      if (q.error) return 0;
      (q.data || []).forEach((row) => orders.set(row.id, row));
    }
  } catch (e) { return 0; }
  const list = [];
  const changes = [];
  for (const ob of open) {
    const order = orders.get(ob.order_id);
    if (!order || !order.paid_by_sender) continue;
    const size = String(order.size || "S").toUpperCase();
    if (size === "M" || size === "L") continue;
    if (order.order_sum_orig == null || order.order_sum_orig === "") continue;
    const fee = Number(order.order_sum_orig);
    if (!Number.isFinite(fee) || fee <= 0 || fee === Number(ob.amount)) continue;
    list.push({ order_id: ob.order_id, fee });
    changes.push({ order: ob.order_code || ob.order_id, old: Number(ob.amount) || 0, new: fee });
  }
  if (!list.length) return 0;
  let res = null;
  try { res = await callEdge("settlements", { action: "fees_set", orders: list }); } catch (e) { res = null; }
  if (!res || res.error || res.success === false || !res.updated) return 0;
  if (typeof logAction === "function") {
    logAction("update", "orders", {
      entity_label: `взаиморасчёты: сумма долга приведена к цене из заказа — ${res.updated}`,
      meta: { source: "settlements-sync", count: res.updated, orders: changes.slice(0, 100) },
    });
  }
  return res.updated;
}

function settlementsExcel() {
  const rows = (settlementsModel && settlementsModel.obligations) || [];
  const cat = stCatalog();
  const lines = ["заказ;заявка;тип доставки;кто держит долг;оплата;номер для счёта;whatsapp;период;сумма;состояние"].concat(rows.map((o) =>
    [stOrderText(o.order_id, o.order_code, cat), stPickupText(o.pickup_id, o.pickup_name, cat), stDeliveryName(o), stWho(o.holder_type, o.holder_id, o.holder_name, cat), stPayLabel(o), o.holder_type === "partner" ? (o.kaspi_phone || "") : "", stIsFizlicoRow(o, cat) ? stSenderPhone(o) : (o.holder_type === "partner" ? (o.whatsapp || "") : ""), stDay(o.period_date), o.amount, stState(o.state)].join(";")));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vzaimoraschety.csv";
  a.click();
}

function settlementsOpenOrder(id) {
  if (!id) return;
  if (typeof orderModal === "function") { orderModal(id); return; }
  if (typeof toast === "function") toast("Карточка заказа недоступна");
}
function settlementsOpenPickup(id) {
  if (!id) return;
  const p = (typeof S !== "undefined" ? (S.pickups || []) : []).find((x) => x.id === id || String(x.code) === String(id));
  if (p && typeof pickupOrdersModal === "function") { pickupOrdersModal(p.id); return; }
  if (typeof toast === "function") toast("Заявка " + id);
}
function settlementsOpenPartner(id) {
  if (!id) return;
  const p = (typeof S !== "undefined" ? (S.partners || []) : []).find((x) => x.id === id);
  if (p && typeof partnerModal === "function") { partnerModal(p.id); return; }
  if (typeof toast === "function") toast("Карточка партнёра не найдена");
}

function settlementsBindPick(root) {
  const all = root.querySelector("#stChkAll");
  const boxes = () => [...root.querySelectorAll(".stChk")];
  const sync = () => {
    const list = boxes();
    const n = list.filter((c) => c.checked).length;
    if (all) all.checked = list.length > 0 && n === list.length;
    const btn = root.querySelector("#stIssueSelected");
    if (btn) {
      btn.disabled = n === 0;
      btn.textContent = n ? `Выставить счета отмеченным (${n})` : "Выставить счета отмеченным";
    }
  };
  if (all) all.onchange = () => { boxes().forEach((c) => { c.checked = all.checked; }); sync(); };
  boxes().forEach((c) => c.onchange = sync);
  const go = root.querySelector("#stIssueSelected");
  if (go) go.onclick = () => settlementsIssueSelected(root);
}

async function settlementsIssueSelected(root) {
  const picked = [...root.querySelectorAll(".stChk:checked")];
  const groups = new Map();
  const bare = [];
  picked.forEach((c) => {
    if (c.dataset.stfiz === "1") {
      const phone = stRowBillPhone(c.closest("tr"));
      if (!phone) { bare.push(c.dataset.storder || ""); return; }
      groups.set(`fiz|${c.dataset.storder}`, {
        type: c.dataset.stissue, holder: c.dataset.stholder, day: c.dataset.stday,
        amount: Number(c.dataset.stamount) || 0, count: 1, order: c.dataset.storder, phone,
      });
      return;
    }
    const key = `${c.dataset.stissue}|${c.dataset.stholder}|${c.dataset.stday}`;
    const cur = groups.get(key) || { type: c.dataset.stissue, holder: c.dataset.stholder, day: c.dataset.stday, amount: 0, count: 0 };
    cur.amount += Number(c.dataset.stamount) || 0;
    cur.count += 1;
    groups.set(key, cur);
  });
  if (bare.length) {
    if (typeof toast === "function") toast("У физлица сначала укажите номер для удалённого счёта");
    return;
  }
  const list = [...groups.values()];
  if (!list.length) return;
  const sum = list.reduce((s, g) => s + g.amount, 0);
  const word = list.length % 10 === 1 && list.length % 100 !== 11 ? "счёт" : (list.length % 10 >= 2 && list.length % 10 <= 4 && (list.length % 100 < 12 || list.length % 100 > 14) ? "счета" : "счетов");
  const fizNote = list.some((g) => g.order) ? "\nУ физлица каждый заказ получает свой счёт на номер из строки." : "\nОдин плательщик за один день получает один счёт.";
  if (!confirm(`Выставить ${list.length} ${word} по ${picked.length} проводкам на ${stMoney(sum)}?${fizNote}`)) return;
  const go = root.querySelector("#stIssueSelected");
  if (go) go.disabled = true;
  picked.forEach((c) => { c.disabled = true; });
  await stIssueEnqueue(async () => {
  let ok = 0;
  const fails = [];
  for (const g of list) {
    if (go && go.isConnected) go.textContent = `Выставляю ${ok + fails.length + 1} из ${list.length}…`;
    const res = await callEdge("settlements", {
      action: "issue",
      logical_key: g.order ? `${g.type}:${g.holder}:${g.day}:${g.order}` : `${g.type}:${g.holder}:${g.day}`,
      holder_type: g.type,
      holder_id: g.holder,
      period_start: g.day,
      period_end: g.day,
      launch: "manual",
      ...(g.order ? { phone: g.phone, order_ids: [g.order] } : {}),
    });
    if (!res || res.error || res.success === false) fails.push((res && (res.error || res.message)) || "Счёт не выставлен");
    else {
      ok += 1;
      stMarkIssued(res.invoice || {}, { type: g.type, holder: g.holder, day: g.day, end: g.day, orders: g.order ? [String(g.order)] : [] });
    }
  }
  if (typeof toast === "function") toast(fails.length ? `Выставлено ${ok}. Не вышло: ${fails[0]}` : `Выставлено счетов: ${ok}`, 6000);
  });
}

async function settlementsCancelInvoice(id) {
  if (!id) return;
  const inv = ((settlementsModel && settlementsModel.invoices) || []).find((i) => i.id === id) || {};
  const sum = inv.amount != null ? ` на ${stMoney(inv.amount)}` : "";
  if (!confirm(`Отменить выставленный счёт${sum}? Долг снова станет к выплате. Оплаченный счёт не отменяется.`)) return;
  const res = await callEdge("settlements", { action: "cancel", invoice_id: id });
  if (!res || res.error || res.success === false) {
    if (typeof toast === "function") toast((res && (res.error || res.message)) || "Счёт не отменён");
    return;
  }
  const ids = inv.order_ids || [];
  if (ids.length && typeof sb !== "undefined" && sb) {
    try {
      const q = await sb.from("orders").select("id,order_sum_orig,paid_by_sender").in("id", ids);
      const fees = (q.data || []).filter((o) => o.paid_by_sender && o.order_sum_orig != null && o.order_sum_orig !== "")
        .map((o) => ({ order_id: o.id, fee: Number(o.order_sum_orig) }))
        .filter((o) => Number.isFinite(o.fee) && o.fee >= 0);
      if (fees.length) await callEdge("settlements", { action: "fees_set", orders: fees });
    } catch (e) { /* долг уже открыт, цену можно поправить сохранением заказа */ }
  }
  if (typeof toast === "function") toast("Счёт отменён");
  await stRefreshQuiet();
}

/* Окно исправления суммы. Что оно делает и чего не делает:
   • меняет сумму открытого долга на сервере (fees_set) — в счёт пойдёт новая;
   • у заказа «оплачено отправителем» та же сумма лежит в заказе как «реальная стоимость
     доставки» (order_sum_orig, её же читает Калькуляция) — пишем и туда, иначе первое же
     сохранение карточки заказа вернуло бы долгу прежнюю сумму;
   • у заказа с пакетом M или L НЕ даёт сохранить: сервер при каждом обновлении сводки сам
     ставит таким заказам тариф размера, и исправление молча откатилось бы;
   • кто, когда, с какой суммы на какую и почему — в «Истории изменений». */
async function settlementsFixAmount(orderId) {
  const m = settlementsModel || {};
  const ob = (m.obligations || []).find((o) => o.order_id === orderId && (o.state === "open" || o.state === "awaiting_admin"));
  if (!ob || !stFixable(ob)) {
    if (typeof toast === "function") toast("Сумму можно менять только у долга «к выплате». Если счёт уже выставлен — сначала отмените его.");
    return;
  }
  if (m.preview) { if (typeof toast === "function") toast("Это пример: настоящие суммы появятся после загрузки списка"); return; }
  const cat = stCatalog();
  let order = (typeof S !== "undefined" ? (S.orders || []) : []).find((x) => x.id === orderId) || null;
  if (!order && typeof sb !== "undefined" && sb) {
    try {
      const q = await sb.from("orders").select("id,code,size,paid_by_sender,order_sum_orig").eq("id", orderId).limit(1);
      order = (q.data || [])[0] || null;
    } catch (e) { order = null; }
  }
  const size = String((order && order.size) || "S").toUpperCase();
  const sized = size === "M" || size === "L";
  const old = Number(ob.amount) || 0;
  const title = stOrderText(ob.order_id, ob.order_code, cat);
  const who = stWho(ob.holder_type, ob.holder_id, ob.holder_name, cat);
  const body = `<div style="font-size:14px;margin-bottom:12px"><b>${stEsc(title)}</b> · ${stEsc(who)}<br><span style="color:var(--muted)">Сейчас: ${stMoney(old)}</span></div>
    ${sized ? `<div class="hint" style="color:var(--rust);margin-bottom:10px">У заказа размер пакета ${stEsc(size)}. Сумма по таким заказам считается по тарифу размера и при каждом обновлении сводки ставится заново — исправление здесь не удержится. Поменяйте размер пакета в карточке заказа или цену размера в карточке партнёра.</div>` : `
    <div class="field"><label>Новая сумма (₸)</label><input id="st_fix_sum" type="number" inputmode="numeric" min="0" step="1" value="${old}" autocomplete="off"></div>
    <div class="field"><label>Причина (необязательно)</label><input id="st_fix_why" maxlength="200" autocomplete="off" placeholder="например: договорились о скидке"></div>
    <div class="hint">Новая сумма пойдёт в счёт.${order && order.paid_by_sender ? " Она же запишется в заказ как реальная стоимость доставки — её считает Калькуляция." : ""} Кто и когда исправил, видно в «Истории изменений».</div>`}`;
  if (sized) { showInfo("Исправить сумму", body); return; }
  showModal("Исправить сумму", body, async () => {
    const raw = String(($("st_fix_sum") || {}).value || "").replace(",", ".").trim();
    const fee = Math.round(Number(raw));
    if (raw === "" || !Number.isFinite(fee) || fee < 0) { toast("Введите сумму — число от нуля"); return false; }
    if (fee === old) { toast("Сумма не изменилась"); return; }
    if (fee === 0 && !confirm("Поставить сумму 0 ₸? Долг останется в списке, но в счёт не попадёт.")) return false;
    const why = String(($("st_fix_why") || {}).value || "").trim().slice(0, 200);
    const res = await callEdge("settlements", { action: "fees_set", orders: [{ order_id: orderId, fee }] });
    if (!res || res.error || res.success === false) { toast((res && (res.error || res.message)) || "Сумма не сохранена"); return false; }
    if (res.locked) { toast("По заказу уже выставлен счёт — сначала отмените его"); return false; }
    if (!res.updated) { toast("Долг по этому заказу не найден — нажмите «Обновить»"); return false; }
    if (order && order.paid_by_sender) {
      try {
        const q = await sb.from("orders").update({ order_sum_orig: fee }).eq("id", orderId);
        if (q.error) throw q.error;
        const cached = (S.orders || []).find((x) => x.id === orderId);
        if (cached) cached.order_sum_orig = fee;
      } catch (e) {
        console.error("settlements fix", e);
        toast("Долг исправлен, но в заказ сумма не записалась — откройте заказ и поправьте «Реальную стоимость доставки»");
      }
    }
    if (typeof logAction === "function") {
      logAction("update", "orders", {
        entity_id: orderId,
        entity_label: `${title} · взаиморасчёты: сумма долга`,
        changes: [{ field: "settlement_amount", label: "Сумма долга", old: stMoney(old), new: stMoney(fee) }],
        meta: { source: "settlements", holder: who, reason: why || null },
      });
    }
    toast(`Сумма исправлена: ${stMoney(old)} → ${stMoney(fee)}`);
    stRefreshQuiet();
  });
}

async function settlementsIssueRow(b) {
  const tr = b.closest("tr");
  const whoEl = tr && tr.querySelector("[data-stwho]");
  const who = ((whoEl && whoEl.textContent) || "плательщику").replace(/\s+/g, " ").trim();
  const day = b.dataset.stday || "";
  const end = b.dataset.stend || day;
  const amount = Number(b.dataset.stamount) || 0;
  const phoneInp = tr && tr.querySelector("[data-stfizphone]");
  let phone = stRowBillPhone(tr);
  if (!phone && b.dataset.stfiz === "1") phone = stPhone10(b.dataset.stphone || "");
  if ((phoneInp || b.dataset.stfiz === "1") && !phone) {
    if (typeof toast === "function") toast("Сначала укажите номер в поле «Номер для счёта»");
    return;
  }
  const period = end && end !== day ? `${stDay(day)} — ${stDay(end)}` : stDay(day);
  if (!confirm(`Выставить счёт «${who}» за ${period} на ${stMoney(amount)}?${phone ? "\nУдалённый счёт уйдёт на " + phone + "." : ""}\nПовторное нажатие второй счёт не создаёт.`)) return;
  b.disabled = true;
  const label = b.textContent;
  b.textContent = stIssueWaiting ? "В очереди…" : "Выставляется…";
  const fizOrder = phoneInp ? phoneInp.dataset.stfizphone : "";
  const orderId = b.dataset.storder || fizOrder || "";
  const listed = (b.dataset.storders || "").split(",").map((id) => id.trim()).filter(Boolean);
  const ids = listed.length ? listed : (phone && orderId ? [orderId] : []);
  const sel = { type: b.dataset.stissue, holder: b.dataset.stholder, day, end, orders: ids.map(String) };
  const body = {
    action: "issue",
    logical_key: listed.length ? `${b.dataset.stissue}:${b.dataset.stholder}:${day}:${end}:${listed.length}` : (orderId && phone ? `${b.dataset.stissue}:${b.dataset.stholder}:${day}:${orderId}` : `${b.dataset.stissue}:${b.dataset.stholder}:${day}`),
    holder_type: b.dataset.stissue,
    holder_id: b.dataset.stholder,
    period_start: day,
    period_end: end,
    launch: "manual",
    ...(phone ? { phone } : {}),
    ...(ids.length ? { order_ids: ids } : {}),
  };
  // Страница не перезагружается: счёт уходит в очередь, строка помечается на месте, и можно
  // сразу нажимать следующую. Сводка перечитается в фоне, когда очередь опустеет.
  stIssueEnqueue(async () => {
    if (b.isConnected) b.textContent = "Выставляется…";
    if (fizOrder) {
      try { await settlementsSaveKaspi("order", fizOrder, phone); }
      catch (e) { /* номер всё равно уходит вместе со счётом */ }
    }
    let res = null;
    try { res = await callEdge("settlements", body); } catch (e) { res = { error: "нет связи с сервером" }; }
    if (!res || res.error || res.success === false) {
      if (b.isConnected) { b.disabled = false; b.textContent = label; }
      if (typeof toast === "function") toast(`${who}: ${(res && (res.error || res.message)) || "счёт не выставлен"}`, 6000);
      return;
    }
    const inv = res.invoice || {};
    stMarkIssued(inv, sel);
    if (b.isConnected) {
      const cell = b.closest("td");
      const row = b.closest("tr");
      const stateCell = cell && cell.previousElementSibling;
      if (stateCell) stateCell.innerHTML = stStateMark("invoiced", new Date().toISOString());
      if (row) row.querySelectorAll(".stChk").forEach((c) => { c.checked = false; c.disabled = true; });
      b.remove();
    }
    if (typeof toast === "function") toast(inv.test ? `${who}: тестовый счёт записан, в Kaspi не уходил` : `${who}: счёт выставлен · ${stMoney(inv.amount || amount)}`);
  });
}

async function settlementsKaspiPhone(holderType, holderId) {
  if (!holderId) return "";
  const res = await callEdge("settlements", { action: "phone_get", holder_type: holderType, holder_id: holderId });
  return (res && res.kaspi_phone) || "";
}

async function settlementsSavePartnerField(inp, kind) {
  if (!inp || !inp.dataset.stpartner) return;
  if (settlementsModel && settlementsModel.preview) {
    if (typeof toast === "function") toast("Это просмотр интерфейса, номер не записывается");
    return;
  }
  const raw = String(inp.value || "").trim();
  const phone = raw ? stPhone10(inp.value) : "";
  if (raw && !phone) {
    inp.value = inp.dataset.stsaved || "";
    if (typeof toast === "function") toast("Нужен номер Казахстана: 7XXXXXXXXX");
    return;
  }
  const prev = inp.dataset.stsaved ? (stPhone10(inp.dataset.stsaved) || inp.dataset.stsaved) : "";
  if (phone === prev) { inp.value = phone; return; }
  const holder = inp.dataset.stholder || "partner";
  const id = inp.dataset.stpartner;
  let res;
  if (holder === "pickup_courier") res = await settlementsSaveKaspi("pickup_courier", id, phone);
  else {
    const body = { action: "terms_fields", partner_id: id };
    if (kind === "wa") body.whatsapp = phone;
    else body.kaspi_phone = phone;
    res = await callEdge("settlements", body);
  }
  if (!res || res.error || res.success === false) {
    inp.value = inp.dataset.stsaved || "";
    if (typeof toast === "function") toast((res && (res.error || res.message)) || "Номер не записался");
    return;
  }
  const savedKaspi = kind === "kaspi" ? (res.kaspi_phone || phone) : null;
  const savedWa = kind === "wa" ? (res.whatsapp || phone) : null;
  ((settlementsModel && settlementsModel.obligations) || []).forEach((o) => {
    if (o.holder_type !== holder || o.holder_id !== id) return;
    if (savedKaspi != null) o.kaspi_phone = savedKaspi;
    if (savedWa != null) o.whatsapp = savedWa;
  });
  if (kind === "kaspi" && settlementsModel) {
    const rest = (settlementsModel.missing_kaspi || []).filter((x) => !(x.holder_type === holder && x.holder_id === id));
    settlementsModel.missing_kaspi = savedKaspi ? rest : rest.concat([{ holder_type: holder, holder_id: id }]);
  }
  document.querySelectorAll(`[data-stpartner="${CSS.escape(id)}"]`).forEach((el) => {
    if (kind === "wa" && el.hasAttribute("data-stwa")) { el.value = savedWa || ""; el.dataset.stsaved = savedWa || ""; }
    if (kind === "kaspi" && el.hasAttribute("data-stkaspi")) { el.value = savedKaspi || ""; el.dataset.stsaved = savedKaspi || ""; }
  });
  if (typeof toast === "function") toast(kind === "wa" ? "WhatsApp записан" : "Номер для счёта записан");
  const y = window.scrollY;
  Promise.resolve(stRedraw()).then(() => window.scrollTo(0, y));
}
async function settlementsSaveKaspi(holderType, holderId, phone) {
  return await callEdge("settlements", { action: "phone_set", holder_type: holderType, holder_id: holderId, kaspi_phone: phone });
}
async function settlementsSaveFizPhone(inp) {
  if (!inp) return;
  const phone = stPhone10(inp.value);
  if (String(inp.value || "").trim() && !phone) {
    if (typeof toast === "function") toast("Нужен номер Казахстана: 7XXXXXXXXX");
    return;
  }
  const prev = inp.dataset.stsaved || "";
  if (phone === prev) return;
  const res = await settlementsSaveKaspi("order", inp.dataset.stfizphone, phone);
  if (!res || res.error || res.success === false) {
    if (typeof toast === "function") toast((res && (res.error || res.message)) || "Номер не записался");
    return;
  }
  inp.dataset.stsaved = phone;
  const row = ((settlementsModel && settlementsModel.obligations) || []).find((o) => o.order_id === inp.dataset.stfizphone);
  if (row) row.invoice_phone = phone;
  if (typeof toast === "function") toast(phone ? "Номер для счёта записан" : "Номер для счёта очищен");
}
async function settlementsCloseShift(courierId, date, already) {
  if (!already && !confirm("Завершить смену " + date + " и выставить один счёт, если есть долг по Kaspi Gold?")) return;
  const res = await callEdge("settlements", { action: "shift_close", courier_id: courierId, date });
  if (typeof toast === "function") toast(res && res.error ? res.error : "Смена закрыта");
  settlementsModel = null;
  renderSettlements();
}
async function settlementsSaveMode() {
  if (settlementsModel && settlementsModel.preview) {
    if (typeof toast === "function") toast("Это просмотр интерфейса, режим не записывается");
    return;
  }
  const res = await callEdge("settlements", {
    action: "settings_set",
    mode: $("st_mode").value,
    effective_from: $("st_from").value ? new Date($("st_from").value).toISOString() : null,
  });
  if (typeof toast === "function") toast(res && res.error ? res.error : "Режим записан");
  settlementsModel = null;
  renderSettlements();
}
async function settlementsSaveAdmin() {
  const res = await callEdge("settlements", {
    action: "admin_save",
    name: $("st_adm_name").value.trim(),
    city_id: $("st_adm_city").value,
    kaspi_phone: $("st_adm_phone").value.trim(),
  });
  if (typeof toast === "function") toast(res && res.error ? res.error : "Администратор записан");
}

function settlementsPickupExtra(o) {
  if (typeof isStaff === "function" && !isStaff() && typeof isCourier === "function" && !isCourier()) return "";
  const fee = o.order_sum_orig != null ? o.order_sum_orig : (o.order_sum || "");
  return `<div class="panel" style="padding:10px;margin-top:8px" data-stfee="${stEsc(o.id)}">
    <div class="pom-sumrow"><span>Реальная стоимость доставки (₸)</span>
      <input type="number" min="0" class="pom-sum" data-st-fee="${stEsc(o.id)}" value="${fee === "" ? "" : stEsc(fee)}" placeholder="ещё не определена"></div>
    <small style="color:var(--muted)">Галочка «Оплачено отправителем» и выбор, кто платит, сразу ставят заказ в сводку. Сумма берётся из запомненной стоимости доставки.</small>
    <div data-st-payer="${stEsc(o.id)}" style="margin-top:8px">
      <label class="pom-paid"><input type="radio" name="stpay-${stEsc(o.id)}" value="partner_self" ${(o.sender_pay_via || o._payChoice) === "partner_self" ? "checked" : ""}> Платит партнёр по своим условиям</label>
      <label class="pom-paid"><input type="radio" name="stpay-${stEsc(o.id)}" value="pickup_gold" ${(o.sender_pay_via || o._payChoice) === "pickup_gold" ? "checked" : ""}> Курьер получил на свой Kaspi Gold</label>
    </div></div>`;
}

async function settlementsNoteSenderPay(order) {
  if (!order || !order.id || !order.paid_by_sender) return null;
  if (typeof isBaraholkaOrder === "function" && isBaraholkaOrder(order)) return null;
  const choice = order.sender_pay_via || order._payChoice || "";
  if (choice !== "partner_self" && choice !== "pickup_gold") return null;
  const fee = Number(order.order_sum_orig);
  const mine = typeof myPickupCourierIds === "function" ? myPickupCourierIds()[0] : "";
  const res = await callEdge("settlements", {
    action: "choose",
    order_id: order.id,
    choice,
    fee: Number.isFinite(fee) && fee >= 0 ? fee : 0,
    subject_id: mine || order.courier_id || "",
  });
  if (res && res.error && typeof toast === "function" && !/стар|effective|нет права|уже есть счёт/i.test(res.error)) toast(res.error);
  return res;
}

function settlementsBindPickup(wrap) {
  wrap.querySelectorAll("[data-st-fee]").forEach((inp) => {
    const box = wrap.querySelector(`[data-pompaid="${inp.dataset.stFee}"]`);
    const payer = wrap.querySelector(`[data-st-payer="${inp.dataset.stFee}"]`);
    const sync = () => { if (payer) payer.style.display = box && box.checked ? "" : "none"; };
    if (box) { box.addEventListener("change", sync); sync(); }
    wrap.querySelectorAll(`input[name="stpay-${inp.dataset.stFee}"]`).forEach((radio) => {
      radio.addEventListener("change", async () => {
        const order = (typeof S !== "undefined" && S.orders || []).find((x) => x.id === inp.dataset.stFee);
        if (!order) return;
        order._payChoice = radio.value;
        const card = radio.closest(".pom-order");
        if (card) card.classList.remove("pom-needpay");
        const saved = await dbUpdate("orders", order.id, { sender_pay_via: radio.value });
        if (!saved) { if (typeof toast === "function") toast("Не удалось сохранить, кто платит"); return; }
        Object.assign(order, saved);
        const typed = inp.value === "" ? null : Number(inp.value);
        if (typed != null && Number.isFinite(typed) && typed >= 0) order.order_sum_orig = typed;
        if (order.paid_by_sender) await settlementsNoteSenderPay(order);
      });
    });
    inp.onchange = async () => {
      const choiceEl = wrap.querySelector(`input[name="stpay-${inp.dataset.stFee}"]:checked`);
      if (!box || !box.checked || !choiceEl || inp.value === "") return;
      const res = await callEdge("settlements", { action: "choose", order_id: inp.dataset.stFee, fee: Number(inp.value), choice: choiceEl.value });
      if (res && res.error && typeof toast === "function") toast(res.error);
    };
  });
}

function settlementsPartnerExtra(p) {
  if (!p || !p.id) return "";
  if (typeof isAdmin === "function" && !isAdmin() && typeof can === "function" && !can("settlements", "edit")) return "";
  return `<div class="panel" style="padding:12px;margin-top:12px"><h3 style="margin:0 0 8px">Счёт и WhatsApp</h3>
    <div class="grid2">
      <div class="field"><label>Оплата</label><select id="st_p_cadence"><option value="daily">Каждый день</option><option value="monthly">Раз в месяц</option></select></div>
      <div class="field"><label>Время автосчёта, Алматы</label><input id="st_p_time" value="10:00"></div>
      <div class="field"><label>Номер для счёта</label><input id="st_p_kaspi" inputmode="numeric" placeholder="Kaspi"></div>
      <div class="field"><label>WhatsApp</label><input id="st_p_wa" inputmode="numeric"></div>
    </div>
    <label class="pom-paid"><input type="checkbox" id="st_p_auto"> Автосчёт включён <span class="pom-paidhint">(по умолчанию выключен)</span></label>
    <label class="pom-paid"><input type="checkbox" id="st_p_rem"> Напоминание, если счёт не оплачен</label>
    <button class="btn sm" type="button" id="st_p_save">Сохранить условия</button>
    <p style="color:var(--muted);font-size:12px">Ежемесячному партнёру счёт выставляет менеджер. Автоматика его не трогает.</p></div>`;
}

let settlementsTermsLoad = null;
function settlementsMarkTermsTouched(el) {
  if (el) el.dataset.sttouched = "1";
}
function settlementsApplyPartnerTerms(t) {
  const row = t || {};
  const kaspi = $("st_p_kaspi");
  const wa = $("st_p_wa");
  const cadence = $("st_p_cadence");
  const time = $("st_p_time");
  const auto = $("st_p_auto");
  const rem = $("st_p_rem");
  if (kaspi && kaspi.dataset.sttouched !== "1") kaspi.value = row.kaspi_phone || "";
  if (wa && wa.dataset.sttouched !== "1") wa.value = row.whatsapp || "";
  if (cadence && cadence.dataset.sttouched !== "1" && row.cadence) cadence.value = row.cadence;
  if (time && time.dataset.sttouched !== "1" && row.auto_time) time.value = row.auto_time;
  if (auto && auto.dataset.sttouched !== "1") auto.checked = !!row.auto;
  if (rem && rem.dataset.sttouched !== "1") rem.checked = !!row.reminders;
  if (kaspi) kaspi.dataset.stloaded = "1";
}
async function settlementsFillPartnerTerms(partnerId) {
  const kaspi = $("st_p_kaspi");
  if (!kaspi || !partnerId) return;
  const res = await callEdge("settlements", { action: "terms_get", partner_id: partnerId });
  if (!res || res.error) return;
  settlementsApplyPartnerTerms(res.terms || {});
}
async function settlementsSavePartnerTerms(partnerId) {
  const kaspi = $("st_p_kaspi");
  if (!kaspi || !partnerId) return null;
  if (settlementsTermsLoad) await settlementsTermsLoad;
  const touched = [kaspi, $("st_p_wa"), $("st_p_cadence"), $("st_p_time"), $("st_p_auto"), $("st_p_rem")]
    .some((el) => el && el.dataset.sttouched === "1");
  if (kaspi.dataset.stloaded !== "1" && !touched) return { ok: true, skipped: true };
  const res = await callEdge("settlements", {
    action: "terms_set", partner_id: partnerId,
    cadence: $("st_p_cadence").value, auto_time: $("st_p_time").value,
    kaspi_phone: kaspi.value, whatsapp: $("st_p_wa").value,
    auto: $("st_p_auto").checked, reminders: $("st_p_rem").checked,
  });
  if (res && !res.error && typeof S !== "undefined" && S.tab === "settlements") settlementsModel = null;
  return res;
}
function settlementsBindPartner(p) {
  const btn = $("st_p_save");
  const kaspi = $("st_p_kaspi");
  if (!kaspi || !p || !p.id) return;
  [kaspi, $("st_p_wa"), $("st_p_cadence"), $("st_p_time"), $("st_p_auto"), $("st_p_rem")].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", () => settlementsMarkTermsTouched(el));
    el.addEventListener("change", () => settlementsMarkTermsTouched(el));
  });
  settlementsTermsLoad = settlementsFillPartnerTerms(p.id);
  if (!btn) return;
  btn.onclick = async () => {
    const res = await settlementsSavePartnerTerms(p.id);
    if (typeof toast === "function") toast(res && res.error ? res.error : "Условия записаны");
    if (res && !res.error && typeof S !== "undefined" && S.tab === "settlements" && typeof renderSettlements === "function") renderSettlements();
  };
}

function settlementsShiftBar() {
  if (typeof isCourierBase === "function" && !isCourierBase()) return "";
  if (typeof myOrderCourierIds === "function" && !myOrderCourierIds().length) return "";
  return `<div class="panel" style="padding:12px;margin-bottom:12px"><button class="btn primary" type="button" id="st_shift">Завершить смену</button>
    <p style="color:var(--muted);font-size:12px;margin:8px 0 0">Сначала сводка. Повторное нажатие не создаёт второй счёт. Если долг нулевой, счёт не выставляется.</p></div>`;
}

function settlementsShiftMarkup(preview) {
  const s = preview.sums || {};
  return `<div class="panel" style="padding:14px"><h3 style="margin:0 0 8px">Сводка смены</h3>
    <p>Доставлено: ${preview.delivered}</p>
    <p>Оплачено отправителями: ${preview.senderPaid} · ${stMoney(s.sender)}</p>
    <p>Удалённый счёт получателю: ${preview.recipientInvoice} · ${stMoney(s.invoice)}</p>
    <p>Kaspi Gold курьера: ${preview.courierGold} · ${stMoney(s.gold)}</p>
    <p>Наличные: ${preview.cashCount} · ${stMoney(s.cash)}</p>
    <p>Долг курьера перед компанией: ${stMoney(preview.debt)}</p>
    <p>Наличные администратору: ${stMoney(preview.cashToAdmin)}</p>
    <p style="color:var(--muted)">${preview.closed ? "Смена уже закрыта" : (preview.debt > 0 ? "После подтверждения выставится один счёт на Kaspi Gold." : "Долг нулевой, счёт не выставится.")}</p></div>`;
}

function settlementsInvoiceCard(inv, lines) {
  const list = (lines || []).map((o) => `<tr><td><button class="btn ghost sm" type="button" data-storder="${stEsc(o.order_id)}">${stEsc(o.order_id)}</button></td><td>${stEsc(o.pickup_id || "—")}</td><td>${stMoney(o.amount)}</td><td>${stEsc(o.state)}</td></tr>`).join("");
  return `<div class="panel" style="padding:14px"><h3 style="margin:0 0 8px">Счёт ${stEsc(inv.id)}</h3>
    <p>Плательщик: ${stEsc(inv.payer_type)} · ${stEsc(inv.payer_id)}</p>
    <p>Период: ${stEsc(inv.period_start)} — ${stEsc(inv.period_end)}</p>
    <p>Сумма: ${stMoney(inv.amount)} · ${stEsc(inv.status)}${inv.test ? " · тест" : ""}</p>
    <p style="color:var(--muted)">Отмена неоплаченного счёта возвращает долг. Оплата части суммы не принимается.</p>
    <table class="resp-table"><thead><tr><th>Заказ</th><th>Заявка</th><th>Сумма</th><th>Состояние</th></tr></thead><tbody>${list}</tbody></table></div>`;
}

function settlementsDeliveryPay(o) {
  return `<div class="panel" style="padding:10px;margin-top:8px">
    <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Оплата доставки ${stEsc(o.code || o.id)}</div>
    <label class="pom-paid"><input type="radio" name="stdel-${stEsc(o.id)}" value="delivery_invoice"> Удалённый счёт получателю</label>
    <label class="pom-paid"><input type="radio" name="stdel-${stEsc(o.id)}" value="delivery_gold"> На Kaspi Gold курьера</label>
    <label class="pom-paid"><input type="radio" name="stdel-${stEsc(o.id)}" value="delivery_cash"> Наличные администратору</label>
  </div>`;
}

function settlementsAdminConfirm(rows) {
  const body = (rows || []).map((o) => `<tr><td>${stEsc(o.order_id)}</td><td>${stMoney(o.amount)}</td><td>${stEsc(o.holder_id)}</td><td><button class="btn sm" type="button" data-stcash="${stEsc(o.order_id)}">Деньги получены</button></td></tr>`).join("");
  return `<div class="panel" style="padding:14px"><h3 style="margin:0 0 8px">Наличные у курьера</h3>
    <p style="color:var(--muted)">Подтверждается каждый заказ отдельно. Неподтверждённые остаются долгом курьера.</p>
    <table class="resp-table"><thead><tr><th>Заказ</th><th>Сумма</th><th>Сейчас держит</th><th></th></tr></thead><tbody>${body}</tbody></table></div>`;
}

document.addEventListener("click", (ev) => {
  const btn = ev.target && ev.target.closest && ev.target.closest("#st_shift");
  if (!btn || typeof myOrderCourierIds !== "function") return;
  const id = myOrderCourierIds()[0];
  const date = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
  callEdge("settlements", { action: "shift_preview", courier_id: id, date }).then((res) => {
    const preview = res && res.preview ? res.preview : { delivered: 0, senderPaid: 0, recipientInvoice: 0, courierGold: 0, cashCount: 0, sums: {}, debt: 0, cashToAdmin: 0, closed: false };
    const s = preview.sums || {};
    const text = [
      "Доставлено: " + preview.delivered,
      "Оплачено отправителями: " + preview.senderPaid + " · " + stMoney(s.sender),
      "Удалённый счёт получателю: " + preview.recipientInvoice + " · " + stMoney(s.invoice),
      "Kaspi Gold курьера: " + preview.courierGold + " · " + stMoney(s.gold),
      "Наличные: " + preview.cashCount + " · " + stMoney(s.cash),
      "Долг перед компанией: " + stMoney(preview.debt),
      "Наличные администратору: " + stMoney(preview.cashToAdmin),
      preview.debt > 0 ? "Будет один счёт на Kaspi Gold." : "Долг нулевой, счёт не выставится.",
      "Завершить смену?",
    ].join("\n");
    if (preview.closed) { if (typeof toast === "function") toast("Смена уже закрыта"); return; }
    if (!confirm(text)) return;
    settlementsCloseShift(id, date, true);
  });
});
