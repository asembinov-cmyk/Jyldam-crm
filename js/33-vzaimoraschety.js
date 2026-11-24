/* Взаиморасчёты. Касса finance_entries и действующий Kaspi Pay не используются.
   Счета уходят на сервер settlements. Пока функция не опубликована, раздел
   показывает оболочку и не ломает остальные экраны. */
let settlementsTab = "summary";
let settlementsModel = null;

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
  const older = (m.obligations || []).filter((o) => o.period_date < "2026-11-24" && o.state !== "paid");
  const errors = (m.invoices || []).filter((i) => i.status === "error" || i.status === "unknown");
  const rows = tab === "partners" ? (m.obligations || []).filter((o) => o.holder_type === "partner")
    : tab === "pickup" ? (m.obligations || []).filter((o) => o.holder_type === "pickup_courier")
    : tab === "delivery" ? (m.obligations || []).filter((o) => o.holder_type === "delivery_courier")
    : tab === "admins" ? (m.obligations || []).filter((o) => o.holder_type === "admin")
    : tab === "paid" ? (m.invoices || []).filter((i) => i.status === "paid")
    : tab === "stale" ? (m.obligations || []).filter((o) => m.stale_before && o.period_date < m.stale_before && o.state !== "paid")
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
    ${tab === "summary" ? `<p style="color:var(--muted);font-size:13px;margin-top:0">Ожидают стоимости: ${m.awaiting_price || 0}. Забытых смен: ${(m.forgotten || []).length}. Старше 31 дня: ${m.stale_total || 0} на ${stMoney(m.stale_amount || 0)}. Эти суммы остаются в учёте и не выставляются автоматом. ${(m.missing_kaspi || []).length ? "Без номера Kaspi: " + (m.missing_kaspi || []).length + "." : ""}</p>` : ""}
    ${tab === "stale" ? `<p style="color:var(--muted);font-size:13px">Задолженность старше автоматического восстановления. Она не исчезает. Счёт по ней выставляет менеджер вручную.</p>` : ""}
    ${m.load_error ? `<div class="empty"><div class="big">Список не загрузился</div>${stEsc(m.load_error)} Нажмите «Обновить». Заказы на месте, режим из-за этой ошибки не менялся.</div>` : table}
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

function stState(v) {
  return ST_STATE[v] || "—";
}

function stCanIssue() {
  if (typeof isAdmin === "function" && isAdmin()) return true;
  return typeof can === "function" && can("settlements", "edit");
}

function stMissingKaspi(o, m) {
  return (m.missing_kaspi || []).some((x) => x.holder_type === o.holder_type && x.holder_id === o.holder_id);
}

function stIssueCell(o, m) {
  if (!stCanIssue() || !o || o.state !== "open") return "";
  if (stMissingKaspi(o, m)) return `<span style="color:var(--rust);font-size:12px">Сначала номер Kaspi</span>`;
  return `<button class="btn sm primary" type="button" data-stissue="${stEsc(o.holder_type)}" data-stholder="${stEsc(o.holder_id)}" data-stday="${stEsc(o.period_date)}" data-stamount="${Number(o.amount) || 0}">Выставить счёт</button>`;
}

function stPickBox(o, m) {
  if (!stCanIssue() || !o || o.state !== "open" || stMissingKaspi(o, m)) return "";
  return `<input type="checkbox" class="stChk" data-stpick="1" data-stissue="${stEsc(o.holder_type)}" data-stholder="${stEsc(o.holder_id)}" data-stday="${stEsc(o.period_date)}" data-stamount="${Number(o.amount) || 0}">`;
}

function settlementsTable(tab, rows, m) {
  const cat = stCatalog();
  if (tab === "forgotten") {
    if (!rows.length) return `<div class="empty"><div class="big">Забытых смен нет</div></div>`;
    return `<table class="resp-table"><thead><tr><th>Курьер</th><th>Дата</th><th></th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td>${stEsc((m.names && m.names[r.courierId]) || (cat.courier.get(r.courierId) || {}).fio || "Курьер")}</td><td>${stEsc(stDay(r.date))}</td><td><button class="btn sm" type="button" data-stclose="${stEsc(r.courierId)}" data-stdate="${stEsc(r.date)}">Завершить смену</button></td></tr>`).join("")}</tbody></table>`;
  }
  if (tab === "awaiting") {
    if (!rows.length) return `<div class="empty"><div class="big">Нет заказов без цены</div>Такие заказы не попадают в счёт.</div>`;
    return `<table class="resp-table"><thead><tr><th>Заказ</th><th>Заявка</th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td><button class="btn ghost sm" type="button" data-storder="${stEsc(r.order_id)}">${stEsc(stOrderText(r.order_id, r.code, cat))}</button></td><td>${stEsc(stPickupText(r.pickup_id, r.pickup_name, cat))}</td></tr>`).join("")}</tbody></table>`;
  }
  if (tab === "invoices" || tab === "paid" || tab === "errors") {
    if (!rows.length) return `<div class="empty"><div class="big">Счетов нет</div></div>`;
    return `<table class="resp-table"><thead><tr><th>Счёт</th><th>Кто платит</th><th>Период</th><th>Сумма</th><th>Статус</th><th>Заказы</th></tr></thead><tbody>${rows.map((i) =>
      `<tr><td>${i.test ? "Тестовый счёт" : "Счёт"}</td><td>${stEsc(stWho(i.payer_type, i.payer_id, i.payer_name, cat))}</td><td>${stEsc(stDay(i.period_start))} — ${stEsc(stDay(i.period_end))}</td><td>${stMoney(i.amount)}</td><td>${stEsc(stState(i.status))}</td><td>${(i.order_ids || []).map((id, n) => `<button class="btn ghost sm" type="button" data-storder="${stEsc(id)}">${stEsc(stOrderText(id, (i.order_codes || [])[n], cat))}</button>`).join(" ")}</td></tr>`).join("")}</tbody></table>`;
  }
  if (!rows.length) return `<div class="empty"><div class="big">Записей нет</div>Долг появится после включения режима и подтверждения стоимости новых заказов.</div>`;
  const pick = stCanIssue();
  const anyPick = pick && rows.some((o) => o.state === "open" && !stMissingKaspi(o, m));
  const bar = anyPick ? `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:0 0 10px">
    <label class="pom-paid" style="margin:0"><input type="checkbox" id="stChkAll"> Выделить все</label>
    <button class="btn sm primary" type="button" id="stIssueSelected" disabled>Выставить счета отмеченным</button>
  </div>` : "";
  return bar + `<table class="resp-table"><thead><tr>${pick ? "<th style=\"width:34px\"></th>" : ""}<th>Заказ</th><th>Заявка</th><th>Кто держит долг</th><th>Период</th><th>Сумма</th><th>Состояние</th>${pick ? "<th></th>" : ""}</tr></thead><tbody>${rows.map((o) =>
    `<tr>${pick ? `<td>${stPickBox(o, m)}</td>` : ""}<td><button class="btn ghost sm" type="button" data-storder="${stEsc(o.order_id)}">${stEsc(stOrderText(o.order_id, o.order_code, cat))}</button></td><td><button class="btn ghost sm" type="button" data-stpickup="${stEsc(o.pickup_id || "")}">${stEsc(stPickupText(o.pickup_id, o.pickup_name, cat))}</button></td><td>${stEsc(stWho(o.holder_type, o.holder_id, o.holder_name, cat))}${stMissingKaspi(o, m) ? " · Не указан номер Kaspi" : ""}</td><td>${stEsc(stDay(o.period_date))}</td><td>${stMoney(o.amount)}</td><td>${stEsc(stState(o.state))}</td>${pick ? `<td>${stIssueCell(o, m)}</td>` : ""}</tr>`).join("")}</tbody></table>`;
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
  root.querySelectorAll("[data-storder]").forEach((b) => b.onclick = () => settlementsOpenOrder(b.dataset.storder));
  root.querySelectorAll("button[data-stissue]").forEach((b) => b.onclick = () => settlementsIssueRow(b));
  settlementsBindPick(root);
  root.querySelectorAll("[data-stpickup]").forEach((b) => b.onclick = () => settlementsOpenPickup(b.dataset.stpickup));
  const excel = root.querySelector("#st_excel");
  if (excel) excel.onclick = settlementsExcel;
  const reload = root.querySelector("#st_reload");
  if (reload) reload.onclick = () => { settlementsModel = null; renderSettlements(); };
  root.querySelectorAll("[data-stclose]").forEach((b) => b.onclick = () => settlementsCloseShift(b.dataset.stclose, b.dataset.stdate));
  const modeSave = root.querySelector("#st_mode_save");
  if (modeSave) modeSave.onclick = settlementsSaveMode;
  const save = root.querySelector("#st_adm_save");
  if (save) save.onclick = settlementsSaveAdmin;
  root.querySelectorAll("[data-stcash]").forEach((b) => b.onclick = async () => {
    const res = await callEdge("settlements", { action: "cash_confirm", order_id: b.dataset.stcash });
    if (typeof toast === "function") toast(res && res.error ? res.error : "Долг перенесён на администратора");
    settlementsModel = null;
    renderSettlements();
  });
}

async function renderSettlements() {
  const main = $("main");
  if (typeof canMod === "function" && !canMod("settlements") && !(typeof isAdmin === "function" && isAdmin())) {
    main.innerHTML = '<div class="empty"><div class="big">Нет доступа к взаиморасчётам</div></div>';
    return;
  }
  if (!settlementsModel) {
    main.innerHTML = '<div class="empty"><div class="big">Загружаем взаиморасчёты…</div></div>';
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
  }
  main.innerHTML = settlementsMarkup(settlementsModel);
  settlementsBind(main);
}

function settlementsExcel() {
  const rows = (settlementsModel && settlementsModel.obligations) || [];
  const cat = stCatalog();
  const lines = ["заказ;заявка;кто держит долг;период;сумма;состояние"].concat(rows.map((o) =>
    [stOrderText(o.order_id, o.order_code, cat), stPickupText(o.pickup_id, o.pickup_name, cat), stWho(o.holder_type, o.holder_id, o.holder_name, cat), stDay(o.period_date), o.amount, stState(o.state)].join(";")));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vzaimoraschety.csv";
  a.click();
}

function settlementsOpenOrder(id) {
  const o = (typeof S !== "undefined" ? (S.orders || []) : []).find((x) => x.id === id || String(x.code) === String(id));
  if (o && typeof openOrder === "function") { openOrder(o.id); return; }
  if (typeof toast === "function") toast("Заказ " + id + " откроется из списка заказов");
}
function settlementsOpenPickup(id) {
  if (!id) return;
  const p = (typeof S !== "undefined" ? (S.pickups || []) : []).find((x) => x.id === id || String(x.code) === String(id));
  if (p && typeof pickupOrdersModal === "function") { pickupOrdersModal(p.id); return; }
  if (typeof toast === "function") toast("Заявка " + id);
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
  picked.forEach((c) => {
    const key = `${c.dataset.stissue}|${c.dataset.stholder}|${c.dataset.stday}`;
    const cur = groups.get(key) || { type: c.dataset.stissue, holder: c.dataset.stholder, day: c.dataset.stday, amount: 0, count: 0 };
    cur.amount += Number(c.dataset.stamount) || 0;
    cur.count += 1;
    groups.set(key, cur);
  });
  const list = [...groups.values()];
  if (!list.length) return;
  const sum = list.reduce((s, g) => s + g.amount, 0);
  const word = list.length % 10 === 1 && list.length % 100 !== 11 ? "счёт" : (list.length % 10 >= 2 && list.length % 10 <= 4 && (list.length % 100 < 12 || list.length % 100 > 14) ? "счета" : "счетов");
  if (!confirm(`Выставить ${list.length} ${word} по ${picked.length} проводкам на ${stMoney(sum)}?\nОдин плательщик за один день получает один счёт.`)) return;
  const go = root.querySelector("#stIssueSelected");
  if (go) go.disabled = true;
  let ok = 0;
  const fails = [];
  for (const g of list) {
    const res = await callEdge("settlements", {
      action: "issue",
      logical_key: `${g.type}:${g.holder}:${g.day}`,
      holder_type: g.type,
      holder_id: g.holder,
      period_start: g.day,
      period_end: g.day,
      launch: "manual",
    });
    if (!res || res.error || res.success === false) fails.push((res && (res.error || res.message)) || "Счёт не выставлен");
    else ok += 1;
  }
  if (typeof toast === "function") toast(fails.length ? `Выставлено ${ok}. Не вышло: ${fails[0]}` : `Выставлено счетов: ${ok}`);
  settlementsModel = null;
  renderSettlements();
}

async function settlementsIssueRow(b) {
  const cells = b.closest("tr") ? [...b.closest("tr").children] : [];
  const who = (cells[3] && cells[3].textContent || "плательщику").replace(/\s+/g, " ").trim();
  const day = b.dataset.stday || "";
  const amount = Number(b.dataset.stamount) || 0;
  if (!confirm(`Выставить счёт «${who}» за ${stDay(day)} на ${stMoney(amount)}?\nПовторное нажатие второй счёт не создаёт.`)) return;
  b.disabled = true;
  const res = await callEdge("settlements", {
    action: "issue",
    logical_key: `${b.dataset.stissue}:${b.dataset.stholder}:${day}`,
    holder_type: b.dataset.stissue,
    holder_id: b.dataset.stholder,
    period_start: day,
    period_end: day,
    launch: "manual",
  });
  if (!res || res.error || res.success === false) {
    b.disabled = false;
    if (typeof toast === "function") toast((res && (res.error || res.message)) || "Счёт не выставлен");
    return;
  }
  const inv = res.invoice || {};
  if (typeof toast === "function") toast(inv.test ? "Тестовый счёт записан, в Kaspi не уходил" : `Счёт выставлен · ${stMoney(inv.amount || amount)}`);
  settlementsModel = null;
  renderSettlements();
}

async function settlementsSaveKaspi(holderType, holderId, phone) {
  if (!phone) return { ok: true, skipped: true };
  return await callEdge("settlements", { action: "phone_set", holder_type: holderType, holder_id: holderId, kaspi_phone: phone });
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
    <small style="color:var(--muted)">Галочка «Оплачено отправителем» больше не прячет эту сумму. Пока цена пустая, заказ в реестре «Ожидает определения стоимости» и в счёт не входит.</small>
    <div data-st-payer="${stEsc(o.id)}" style="margin-top:8px">
      <label class="pom-paid"><input type="radio" name="stpay-${stEsc(o.id)}" value="partner_self" ${(o.sender_pay_via || o._payChoice) === "partner_self" ? "checked" : ""}> Платит партнёр по своим условиям</label>
      <label class="pom-paid"><input type="radio" name="stpay-${stEsc(o.id)}" value="pickup_gold" ${(o.sender_pay_via || o._payChoice) === "pickup_gold" ? "checked" : ""}> Курьер получил на свой Kaspi Gold</label>
    </div></div>`;
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
        const fee = inp.value === "" ? null : Number(inp.value);
        if (fee != null && Number.isFinite(fee)) {
          const mine = typeof myPickupCourierIds === "function" ? myPickupCourierIds()[0] : "";
          const res = await callEdge("settlements", {
            action: "choose", order_id: order.id, fee, choice: radio.value, subject_id: mine || order.courier_id || "",
          });
          if (res && res.error && typeof toast === "function" && !/стар|effective|нет права/i.test(res.error)) toast(res.error);
        }
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
  return `<div class="panel" style="padding:12px;margin-top:12px"><h3 style="margin:0 0 8px">Взаиморасчёты партнёра</h3>
    <div class="grid2">
      <div class="field"><label>Период</label><select id="st_p_cadence"><option value="daily">Каждый день, счёт за вчера</option><option value="monthly">Раз в месяц, вручную</option></select></div>
      <div class="field"><label>Время автосчёта, Алматы</label><input id="st_p_time" value="10:00"></div>
      <div class="field"><label>Kaspi для счёта</label><input id="st_p_kaspi" inputmode="numeric"></div>
      <div class="field"><label>WhatsApp</label><input id="st_p_wa" inputmode="numeric"></div>
    </div>
    <label class="pom-paid"><input type="checkbox" id="st_p_auto"> Автосчёт включён <span class="pom-paidhint">(по умолчанию выключен)</span></label>
    <label class="pom-paid"><input type="checkbox" id="st_p_rem"> Напоминание, если счёт не оплачен</label>
    <button class="btn sm" type="button" id="st_p_save">Сохранить условия</button>
    <p style="color:var(--muted);font-size:12px">Ежемесячному партнёру счёт выставляет менеджер. Автоматика его не трогает.</p></div>`;
}

function settlementsBindPartner(p) {
  const btn = $("st_p_save");
  if (!btn || !p || !p.id) return;
  btn.onclick = async () => {
    const res = await callEdge("settlements", {
      action: "terms_set", partner_id: p.id,
      cadence: $("st_p_cadence").value, auto_time: $("st_p_time").value,
      kaspi_phone: $("st_p_kaspi").value, whatsapp: $("st_p_wa").value,
      auto: $("st_p_auto").checked, reminders: $("st_p_rem").checked,
    });
    if (typeof toast === "function") toast(res && res.error ? res.error : "Условия записаны");
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
