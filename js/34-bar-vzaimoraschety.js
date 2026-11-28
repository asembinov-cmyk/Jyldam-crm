/* Взаиморасчёты барахолки. Обычный модуль «Взаиморасчёты» эти заказы не берёт.
   Вид страницы тот же, что у основного блока: сводка, касса Kaspi, таблица плательщиков
   с фильтром, раскрытием и кнопкой «Выставить счёт».

   Счёт уходит только через второго кассира Kaspi (действие bar_bill). Первый кассир
   отсюда не вызывается. Оплата такого счёта не меняет статус оплаты самого заказа:
   это долг партнёра, а не оплата получателя.

   Две разные суммы, их нельзя сложить:
   • «Партнёр по счёту» — галочка «Оплачено отправителем». В счёт идёт order_sum_orig.
   • «Платит получатель» — сумма заказа. Это не долг партнёра и в счёт не входит. */
let barSetFrom = "";
let barSetTo = "";
let barSetCache = null;
let barSetGen = 0;
let barSetBusy = false;
const barSetOpen = new Set();
const barSetPhones = {};
const BAR_FIND = {
  labels: ["Партнёр", "Заказ", "Сумма"],
  text: ["who", "codes", "amount"],
  picks: [
    { key: "who", label: "Кто оплачивает долг" },
    { key: "state", label: "Состояние" },
  ],
  dates: [],
};

function barSetEsc(s) {
  return typeof stEsc === "function" ? stEsc(s) : (typeof esc === "function" ? esc(s) : String(s ?? ""));
}
function barSetMoney(n) {
  return typeof stMoney === "function" ? stMoney(n) : ((Number(n) || 0).toLocaleString("ru-RU") + " ₸");
}
function barSetKey(name) {
  return String(name || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}
function barSetDay(o) {
  if (o && o.pickup_date) return String(o.pickup_date).slice(0, 10);
  const t = Date.parse(o && o.created_at);
  if (!Number.isFinite(t)) return "";
  return new Date(t + 5 * 3600 * 1000).toISOString().slice(0, 10);
}
function barSetDayLabel(ymd) {
  if (typeof stDay === "function") return stDay(ymd);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
}
function barSetPhone10(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) d = d.slice(1);
  return /^7\d{9}$/.test(d) ? d : "";
}
function barSetCatalog(partners) {
  const byId = new Map();
  const byName = new Map();
  (partners || []).forEach((p) => {
    if (!p || !p.is_baraholka) return;
    if (p.id) byId.set(p.id, p);
    const key = barSetKey(p.name);
    if (key && !byName.has(key)) byName.set(key, p);
  });
  return { byId, byName };
}
function barSetWho(order, cat) {
  const linked = order && order.partner_id && cat.byId.get(order.partner_id);
  if (linked && linked.name) return { name: String(linked.name), phone: linked.phone || "" };
  const named = cat.byName.get(barSetKey(order && order.sender));
  if (named && named.name) return { name: String(named.name), phone: named.phone || "" };
  const sender = String((order && order.sender) || "").trim();
  return { name: sender || "Партнёр не указан", phone: "" };
}
function barSetLine(order) {
  const partnerPays = !!(order && order.paid_by_sender);
  const raw = partnerPays ? order.order_sum_orig : order.order_sum;
  const amount = raw == null || raw === "" ? 0 : Number(raw);
  return {
    partnerPays,
    amount: Number.isFinite(amount) ? amount : 0,
    missing: partnerPays && !(Number(raw) > 0),
  };
}
function barSetLatest(invoices) {
  const map = new Map();
  (invoices || []).forEach((inv) => {
    if (!inv || !inv.order_id) return;
    const prev = map.get(inv.order_id);
    if (!prev || String(inv.created_at || "") > String(prev.created_at || "")) map.set(inv.order_id, inv);
  });
  return map;
}
function barSetOrderState(inv) {
  if (!inv) return "open";
  if (inv.status === "paid") return "paid";
  if (inv.status === "pending") return "invoiced";
  return "open";
}
function barSetStateLabel(row) {
  if (!row.partnerPays) return "Платит получатель";
  if (row.missing) return "Нет суммы";
  if (row.state === "paid") return "Оплачено";
  if (row.state === "invoiced") return "Выставлен счёт";
  return "К выплате";
}
function barSetRows(orders, partners, invoices) {
  const cat = barSetCatalog(partners);
  const latest = barSetLatest(invoices);
  return (orders || []).map((o) => {
    const line = barSetLine(o);
    const who = barSetWho(o, cat);
    const inv = latest.get(o.id) || null;
    const state = barSetOrderState(inv);
    return {
      id: o.id,
      code: o.code || "",
      client: o.client || "",
      who: who.name,
      phone: who.phone || "",
      day: barSetDay(o),
      partnerPays: line.partnerPays,
      amount: line.amount,
      missing: line.missing,
      state,
      invoice: inv,
    };
  });
}
function barSetGroups(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    let g = map.get(row.who);
    if (!g) {
      g = { key: row.who, who: row.who, phone: "", orders: [], days: [] };
      map.set(row.who, g);
    }
    if (!g.phone && row.phone) g.phone = row.phone;
    g.orders.push(row);
    if (row.day) g.days.push(row.day);
  });
  return [...map.values()].map((g) => {
    g.days.sort();
    const debt = g.orders.filter((o) => o.partnerPays);
    const labels = [...new Set(debt.map(barSetStateLabel))];
    const state = !debt.length ? "Платит получатель" : (labels.length === 1 ? labels[0] : "Разные");
    const open = debt.filter((o) => o.state === "open" && !o.missing);
    const pending = debt.filter((o) => o.state === "invoiced");
    const paid = debt.filter((o) => o.state === "paid");
    const amountNum = debt.reduce((s, o) => s + (o.missing ? 0 : o.amount), 0);
    const recipientSum = g.orders.filter((o) => !o.partnerPays).reduce((s, o) => s + o.amount, 0);
    return {
      raw: g,
      key: g.key,
      who: g.who,
      phone: barSetPhones[g.key] != null ? barSetPhones[g.key] : barSetPhone10(g.phone),
      codes: g.orders.map((o) => o.code).join(" "),
      count: debt.length,
      recipient: g.orders.length - debt.length,
      amount: String(amountNum),
      amountNum,
      openSum: open.reduce((s, o) => s + o.amount, 0),
      pendingSum: pending.reduce((s, o) => s + (Number(o.invoice && o.invoice.amount) || o.amount), 0),
      paidSum: paid.reduce((s, o) => s + (Number(o.invoice && o.invoice.amount) || o.amount), 0),
      recipientSum,
      state,
      day: g.days[0] || "",
      dayLabel: !g.days.length ? "—" : (g.days[0] === g.days[g.days.length - 1] ? barSetDayLabel(g.days[0]) : `${barSetDayLabel(g.days[0])} — ${barSetDayLabel(g.days[g.days.length - 1])}`),
      open,
      pendingIds: [...new Set(pending.map((o) => o.invoice && o.invoice.kaspi_id).filter(Boolean))],
      paidAt: paid.map((o) => o.invoice && o.invoice.paid_at).filter(Boolean).sort().slice(-1)[0] || "",
      invoicedAt: pending.map((o) => o.invoice && o.invoice.created_at).filter(Boolean).sort()[0] || "",
    };
  }).sort((a, b) => (b.amountNum - a.amountNum) || a.who.localeCompare(b.who, "ru"));
}
function barSetBills(invoices, kassa) {
  const map = new Map();
  (invoices || []).filter((inv) => inv && !inv.test && (inv.status === "pending" || inv.status === "paid")).forEach((inv) => {
    const id = String(inv.kaspi_id || inv.id);
    let bill = map.get(id);
    if (!bill) {
      bill = { kaspi_id: inv.kaspi_id || "", phone10: inv.phone10 || "", amount: 0, status: inv.status, created_at: inv.created_at || "", paid_at: inv.paid_at || "", codes: [], kassa };
      map.set(id, bill);
    }
    bill.amount += Number(inv.amount) || 0;
    if (inv.order_code) bill.codes.push(String(inv.order_code));
    if (inv.status === "pending") bill.status = "pending";
    if (String(inv.created_at || "") < String(bill.created_at || "9999")) bill.created_at = inv.created_at;
    if (inv.paid_at && String(inv.paid_at) > String(bill.paid_at || "")) bill.paid_at = inv.paid_at;
  });
  return [...map.values()];
}

function barSetMonthStart(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd || "") ? ymd.slice(0, 8) + "01" : ymd;
}
function barSetInitPeriod() {
  if (barSetFrom && barSetTo) return;
  const today = typeof localToday === "function" ? localToday() : new Date().toISOString().slice(0, 10);
  barSetFrom = barSetMonthStart(today);
  barSetTo = today;
}
function barSetCard(title, value) {
  return typeof stCard === "function"
    ? stCard(title, value)
    : `<div class="stat"><div class="stat-body"><div class="k">${barSetEsc(title)}</div><div class="v">${value}</div></div></div>`;
}
function barSetCanIssue() {
  return typeof stCanIssue === "function" ? stCanIssue() : ((typeof isAdmin === "function" && isAdmin()) || (typeof can === "function" && can("settlements", "edit")));
}
function barSetKassaName(row) {
  const kassas = (typeof S !== "undefined" && S.finance_kassa) || [];
  if (row && row.kassa_id) {
    const named = kassas.find((k) => k.id === row.kassa_id);
    if (named && named.name) return named.name;
  }
  const title = String((row && row.title) || "").trim();
  return title || "Второй кассир";
}
function barSetIssueCell(g) {
  if (!barSetCanIssue() || !g.open.length) return "";
  return `<button class="btn sm primary" type="button" data-barissue="${barSetEsc(g.key)}">Выставить счёт</button>`;
}
function barSetStateCell(g) {
  const issue = barSetIssueCell(g);
  if (g.state === "К выплате") return issue || barSetEsc(g.state);
  if (g.state === "Оплачено" && typeof stStateMark === "function") return stStateMark("paid", g.paidAt);
  if (g.state === "Выставлен счёт" && typeof stStateMark === "function") return stStateMark("invoiced", g.invoicedAt);
  return barSetEsc(g.state) + (issue ? `<div style="margin-top:6px">${issue}</div>` : "");
}
function barSetCancelCell(g) {
  if (!barSetCanIssue()) return "";
  return g.pendingIds.map((id) => `<button class="btn sm" type="button" data-barcancel="${barSetEsc(id)}">Отменить счёт</button>`).join("");
}
function barSetOrderTable(orders) {
  const body = orders.map((row) => {
    const state = barSetStateLabel(row);
    const mark = row.state === "paid" && typeof stStateMark === "function"
      ? stStateMark("paid", row.invoice && row.invoice.paid_at)
      : row.state === "invoiced" && typeof stStateMark === "function"
        ? stStateMark("invoiced", row.invoice && row.invoice.created_at)
        : barSetEsc(state);
    return `<tr><td>${row.id ? `<button class="btn ghost sm" type="button" data-barorder="${barSetEsc(row.id)}">${barSetEsc(row.code || "Заказ")}</button>` : barSetEsc(row.code || "—")}</td><td>${barSetEsc(row.client || "—")}</td><td>${barSetEsc(barSetDayLabel(row.day))}</td><td>${row.partnerPays ? "Партнёр по счёту" : "Получатель"}</td><td>${row.missing ? "нет суммы" : barSetMoney(row.amount)}</td><td>${mark}</td></tr>`;
  }).join("");
  return `<table class="resp-table"><thead><tr><th>Заказ</th><th>Клиент</th><th>Период</th><th>Кто платит</th><th>Сумма</th><th>Состояние</th></tr></thead><tbody>${body}</tbody></table>`;
}
function barSetKaspiBlock(bills, kassaName) {
  const phone = (v) => (typeof phoneDisplay === "function" ? phoneDisplay(v) : (v ? "+7" + v : "—"));
  const when = (v) => (v && typeof fmtDateTime === "function" ? fmtDateTime(v) : barSetDayLabel(String(v || "").slice(0, 10)));
  const view = (bills || []).map((i) => ({
    raw: i,
    order: i.codes.join(" "),
    phone: phone(i.phone10),
    amount: `${i.amount} ${barSetMoney(i.amount)}`,
    amountNum: Number(i.amount) || 0,
    status: typeof stState === "function" ? stState(i.status) : (i.status === "paid" ? "Оплачено" : "Ждёт оплаты"),
    kassa: i.kassa || "Второй кассир",
    issued: String(i.created_at || "").slice(0, 10),
    paid: String(i.paid_at || "").slice(0, 10),
  }));
  const scope = "barset-kaspi";
  const spec = typeof ST_KASPI_FIND !== "undefined" ? ST_KASPI_FIND : { labels: ["Заказ"], text: ["order"], picks: [], dates: [] };
  const rows = typeof stSortRows === "function" ? stSortRows(typeof stSlice === "function" ? stSlice(view, spec, scope).shown : view, scope) : view;
  const sum = rows.reduce((s, i) => s + i.amountNum, 0);
  const find = typeof stFindBar === "function" ? stFindBar(scope, spec, view) : "";
  const note = typeof stPageNote === "function" ? stPageNote(rows.length, view.length) : "";
  const head = typeof stNumHead === "function" ? stNumHead() : "<th>№</th>";
  const th = typeof stTh === "function"
    ? `${stTh(scope, "order", "Заказ")}${stTh(scope, "phone", "Телефон")}${stTh(scope, "amountNum", "Сумма")}${stTh(scope, "status", "Статус")}${stTh(scope, "issued", "Выставлен")}${stTh(scope, "paid", "Оплачен")}`
    : "<th>Заказ</th><th>Телефон</th><th>Сумма</th><th>Статус</th><th>Выставлен</th><th>Оплачен</th>";
  const body = rows.length
    ? `<table class="resp-table"><thead><tr>${head}${th}</tr></thead><tbody>${rows.map((i, n) => `<tr>${typeof stNumCell === "function" ? stNumCell(n) : `<td>${n + 1}</td>`}<td>${barSetEsc(i.order || "—")}</td><td>${barSetEsc(i.phone)}</td><td>${barSetMoney(i.raw.amount)}</td><td>${barSetEsc(i.status)}</td><td>${barSetEsc(when(i.raw.created_at))}</td><td>${barSetEsc(i.raw.paid_at ? when(i.raw.paid_at) : "—")}</td></tr>`).join("")}</tbody></table>`
    : (typeof stMiss === "function" ? stMiss(view.length, `<div class="empty"><div class="big">Счетов ещё нет</div></div>`) : `<div class="empty"><div class="big">Счетов ещё нет</div></div>`);
  const name = (view[0] && view[0].kassa) || kassaName || "Второй кассир";
  return `<div class="panel" style="padding:14px;margin-bottom:14px"><h3 style="margin:0 0 8px">${barSetEsc("Касса " + name)}</h3>
    <p style="color:var(--muted);font-size:13px;margin-top:0">Удалённые счета Kaspi Pay. ${rows.length} на ${barSetMoney(sum)}. Счета барахолки выставляет эта касса.</p>
    ${find}${note}${body}</div>`;
}

function barSetMarkup() {
  const model = barSetCache || { orders: [], partners: [], invoices: [], kassa: "Второй кассир", error: "" };
  const groups = barSetGroups(barSetRows(model.orders, model.partners, model.invoices));
  const spec = BAR_FIND;
  const shown = typeof stSortRows === "function"
    ? stSortRows(typeof stSlice === "function" ? stSlice(groups, spec, "barset").shown : groups, "barset")
    : groups;
  const openSum = groups.reduce((s, g) => s + g.openSum, 0);
  const pendingSum = groups.reduce((s, g) => s + g.pendingSum, 0);
  const paidSum = groups.reduce((s, g) => s + g.paidSum, 0);
  const recipientSum = groups.reduce((s, g) => s + g.recipientSum, 0);
  const find = typeof stFindBar === "function" ? stFindBar("barset", spec, groups) : "";
  const note = typeof stPageNote === "function" ? stPageNote(shown.length, groups.length, true) : "";
  const head = `${typeof stNumHead === "function" ? stNumHead() : "<th>№</th>"}${typeof stTh === "function" ? stTh("barset", "who", "Кто оплачивает долг") : "<th>Кто оплачивает долг</th>"}<th>Номер для счёта</th>${typeof stTh === "function" ? `${stTh("barset", "count", "Заказов")}${stTh("barset", "day", "Период")}${stTh("barset", "amountNum", "Сумма")}${stTh("barset", "state", "Состояние")}` : "<th>Заказов</th><th>Период</th><th>Сумма</th><th>Состояние</th>"}<th></th>`;
  const body = model.error
    ? `<div class="empty"><div class="big">Список не загрузился</div>${barSetEsc(model.error)}</div>`
    : !shown.length
      ? (typeof stMiss === "function" ? stMiss(groups.length, `<div class="empty"><div class="big">За этот период заказов барахолки нет</div>Выберите другие даты.</div>`) : `<div class="empty"><div class="big">Записей нет</div></div>`)
      : `<table class="resp-table st-payers"><thead><tr>${head}</tr></thead><tbody>${shown.map((g, n) => {
          const open = barSetOpen.has(g.key);
          const phone = barSetCanIssue()
            ? `<input class="st-partner-field" data-barphone="${barSetEsc(g.key)}" value="${barSetEsc(g.phone || "")}" inputmode="tel" autocomplete="off" placeholder="Номер для счёта" title="Номер для счёта" style="width:132px;padding:4px 8px">`
            : barSetEsc(g.phone || "—");
          const actions = barSetCancelCell(g);
          const row = `<tr class="st-grow" data-bargroup="${barSetEsc(g.key)}" title="Показать заказы">${typeof stNumCell === "function" ? stNumCell(n) : `<td>${n + 1}</td>`}<td data-label="Кто оплачивает долг"><span class="st-gmark">${open ? "▼" : "▶"}</span> ${barSetEsc(g.who)}</td><td data-label="Номер для счёта">${phone}</td><td data-label="Заказов">${g.count}${g.recipient ? ` + ${g.recipient}` : ""}</td><td data-label="Период">${barSetEsc(g.dayLabel)}</td><td data-label="Сумма">${barSetMoney(g.amountNum)}</td><td data-label="Состояние">${barSetStateCell(g)}</td><td>${actions ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${actions}</div>` : ""}</td></tr>`;
          return open ? row + `<tr class="st-gbody"><td colspan="8">${barSetOrderTable(g.raw.orders)}</td></tr>` : row;
        }).join("")}</tbody></table>`;
  const bills = barSetBills(model.invoices, model.kassa);
  return `<div class="page-head"><div><h1>Взаиморасчёты</h1>
      <p>Барахолка. Эти заказы в обычные взаиморасчёты не входят. «Партнёр по счёту» — цена из реестра, счёт уходит со второй кассы Kaspi. «Платит получатель» в счёт партнёра не входит.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="barSetExcel" type="button">Excel</button><button class="btn sm" id="barSetReload" type="button">Обновить</button></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:0 0 10px">
      <div class="field" style="margin:0"><label>Период с</label><input type="date" data-bar="from" value="${barSetEsc(barSetFrom)}"></div>
      <div class="field" style="margin:0"><label>Период по</label><input type="date" data-bar="to" value="${barSetEsc(barSetTo)}"></div>
      <button class="btn sm ghost" type="button" data-barjump="today">Сегодня</button>
      <button class="btn sm ghost" type="button" data-barjump="yesterday">Вчера</button>
      <button class="btn sm ghost" type="button" data-barjump="month">Этот месяц</button>
    </div>
    <div class="stats">
      ${barSetCard("К выплате", barSetMoney(openSum))}
      ${barSetCard("Уже в счетах", barSetMoney(pendingSum))}
      ${barSetCard("Оплачено", barSetMoney(paidSum))}
      ${barSetCard("Платит получатель", barSetMoney(recipientSum))}
    </div>
    ${barSetKaspiBlock(bills, model.kassa)}
    ${find}${note}${body}`;
}

async function barSetRead(apply) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from("orders").select("id,code,client,sender,partner_id,pickup_date,created_at,order_sum,order_sum_orig,paid_by_sender").eq("calc_group", "baraholka");
    const res = await apply(q).range(from, from + 999);
    if (res.error) throw new Error(res.error.message || "Заказы барахолки не прочитались");
    const chunk = res.data || [];
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return rows;
}
async function barSetFetch(from, to) {
  if (typeof sb === "undefined" || !sb) throw new Error("Нет соединения с базой");
  const dated = await barSetRead((q) => q.gte("pickup_date", from).lte("pickup_date", to).order("pickup_date", { ascending: false }));
  const loose = await barSetRead((q) => q.is("pickup_date", null).gte("created_at", from + "T00:00:00+05:00").lte("created_at", to + "T23:59:59+05:00"));
  const seen = new Set();
  return dated.concat(loose).filter((row) => {
    if (!row || !row.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
async function barSetPartners() {
  if (typeof sb === "undefined" || !sb) return [];
  try {
    const res = await sb.from("partners").select("id,name,is_baraholka,phone").eq("is_baraholka", true);
    if (!res.error && res.data) return res.data;
    const again = await sb.from("partners").select("id,name,is_baraholka").eq("is_baraholka", true);
    if (!again.error && again.data) return again.data;
  } catch (e) { /* имя останется как в заказе */ }
  return (typeof S !== "undefined" && S.partners) || [];
}
async function barSetInvoices(ids) {
  if (typeof sb === "undefined" || !sb || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const res = await sb.from("kaspi_invoices").select("id,order_id,order_code,phone10,amount,status,kaspi_id,note,test,created_at,paid_at,settings_id").eq("note", "baraholka").in("order_id", chunk);
    if (res.error) throw new Error(res.error.message || "Счета барахолки не прочитались");
    out.push(...(res.data || []));
  }
  return out;
}
async function barSetCashier() {
  if (typeof sb === "undefined" || !sb) return null;
  try {
    const res = await sb.from("kaspi_settings").select("id,title,kassa_id").eq("id", 2).maybeSingle();
    if (!res.error) return res.data || null;
  } catch (e) { /* имя кассы останется общим */ }
  return null;
}

function barSetCsv() {
  const model = barSetCache || { orders: [], partners: [], invoices: [] };
  const groups = barSetGroups(barSetRows(model.orders, model.partners, model.invoices));
  const lines = ["кто оплачивает долг;заказов партнёра;сумма;к выплате;в счёте;оплачено;состояние"];
  groups.forEach((g) => lines.push([g.who, g.count, g.amountNum, g.openSum, g.pendingSum, g.paidSum, g.state].join(";")));
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vzaimoraschety-baraholka.csv";
  a.click();
}

function barSetPaint(focus) {
  const main = $("main");
  if (!main || (typeof S !== "undefined" && S.tab !== "barsettlements")) return;
  const pos = focus && typeof focus.selectionStart === "number" ? focus.selectionStart : null;
  const barKey = focus && focus.dataset ? focus.dataset.bar : "";
  const scope = focus && focus.dataset ? focus.dataset.stscope : "";
  const stk = focus && focus.dataset ? focus.dataset.stk : "";
  const phoneKey = focus && focus.dataset ? focus.dataset.barphone : "";
  main.innerHTML = barSetMarkup();
  barSetBind(main);
  const next = phoneKey
    ? main.querySelector(`[data-barphone="${CSS.escape(phoneKey)}"]`)
    : barKey
      ? main.querySelector(`[data-bar="${barKey}"]`)
      : (scope && stk ? main.querySelector(`[data-stscope="${scope}"][data-stk="${stk}"]`) : null);
  if (!next) return;
  next.focus();
  if (pos != null) try { next.setSelectionRange(pos, pos); } catch (e) {}
}
function barSetJump(kind) {
  const today = typeof localToday === "function" ? localToday() : new Date().toISOString().slice(0, 10);
  if (kind === "today") { barSetFrom = today; barSetTo = today; }
  else if (kind === "yesterday") {
    const y = typeof localDaysAgo === "function" ? localDaysAgo(1) : today;
    barSetFrom = y; barSetTo = y;
  } else {
    barSetFrom = barSetMonthStart(today);
    barSetTo = today;
  }
  barSetCache = null;
  renderBarSettlements();
}
function barSetFindInput(el) {
  if (typeof stFindBag !== "function") return;
  const bag = stFindBag(el.dataset.stscope || "barset");
  bag[el.dataset.stk] = el.value;
  barSetPaint(el);
}
function barSetSort(scope, col) {
  if (typeof stSortBag !== "function") return;
  const bag = stSortBag(scope);
  if (bag.col === col) bag.dir = bag.dir === 1 ? -1 : 1;
  else { bag.col = col; bag.dir = 1; }
  barSetPaint();
}
async function barSetIssue(key) {
  if (barSetBusy) return;
  const model = barSetCache || { orders: [], partners: [], invoices: [] };
  const group = barSetGroups(barSetRows(model.orders, model.partners, model.invoices)).find((g) => g.key === key);
  if (!group || !group.open.length) { if (typeof toast === "function") toast("Нет заказов для счёта"); return; }
  const input = document.querySelector(`[data-barphone="${CSS.escape(key)}"]`);
  const phone = barSetPhone10(input ? input.value : group.phone);
  if (!phone) { if (typeof toast === "function") toast("Номер для счёта: 10 цифр, начинается с 7"); return; }
  const sum = group.open.reduce((s, o) => s + o.amount, 0);
  if (!confirm(`На номер +7${phone} уйдёт счёт барахолки на ${barSetMoney(sum)} через вторую кассу Kaspi. Продолжить?`)) return;
  barSetBusy = true;
  try {
    const r = await callEdge("kaspi-pay", { action: "bar_bill", order_ids: group.open.map((o) => o.id), phone });
    const err = (r && (r.error || (r.success === false ? r.error : ""))) || "";
    if (err || !r || !r.ok) { if (typeof toast === "function") toast(err || "Kaspi не выставил счёт"); return; }
    if (typeof toast === "function") toast(`Счёт на ${barSetMoney(r.amount)} выставлен`);
    barSetCache = null;
    renderBarSettlements();
  } finally {
    barSetBusy = false;
  }
}
async function barSetCancel(kaspiId) {
  if (barSetBusy || !kaspiId) return;
  if (!confirm("Отменить неоплаченный счёт барахолки?")) return;
  barSetBusy = true;
  try {
    const r = await callEdge("kaspi-pay", { action: "bar_cancel", kaspi_id: kaspiId });
    const err = (r && r.error) || "";
    if (err || !r || !r.ok) { if (typeof toast === "function") toast(err || "Kaspi не отменил счёт"); return; }
    if (typeof toast === "function") toast("Счёт отменён");
    barSetCache = null;
    renderBarSettlements();
  } finally {
    barSetBusy = false;
  }
}
function barSetBind(root) {
  root.querySelectorAll("[data-stscope]").forEach((el) => {
    const run = () => barSetFindInput(el);
    if (el.tagName === "SELECT" || el.type === "date") el.onchange = run;
    else el.oninput = run;
  });
  root.querySelectorAll("[data-stdayjump]").forEach((btn) => {
    btn.onclick = () => {
      if (typeof stFindBag !== "function") return;
      const bag = stFindBag(btn.dataset.stscope || "barset");
      const key = btn.dataset.stkey || "";
      bag[key + "_from"] = btn.dataset.stdayjump || "";
      bag[key + "_to"] = btn.dataset.stdayjump || "";
      barSetPaint();
    };
  });
  root.querySelectorAll("[data-stsort]").forEach((th) => {
    th.onclick = () => {
      const scope = th.dataset.stsort || "";
      if (scope.indexOf("barset") !== 0) return;
      barSetSort(scope, th.dataset.stcol);
    };
  });
  root.querySelectorAll("[data-barphone]").forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
    el.oninput = () => { barSetPhones[el.dataset.barphone] = el.value; };
  });
  root.querySelectorAll("[data-bargroup]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest("button,input,a,select")) return;
      const key = tr.dataset.bargroup;
      if (barSetOpen.has(key)) barSetOpen.delete(key);
      else barSetOpen.add(key);
      barSetPaint();
    };
  });
  root.querySelectorAll("[data-barissue]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); barSetIssue(btn.dataset.barissue); };
  });
  root.querySelectorAll("[data-barcancel]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); barSetCancel(btn.dataset.barcancel); };
  });
  root.querySelectorAll("[data-barorder]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      if (typeof openOrder === "function") openOrder(btn.dataset.barorder);
    };
  });
  root.querySelectorAll('input[type="date"][data-bar]').forEach((el) => {
    el.onchange = () => {
      if (el.dataset.bar === "from") barSetFrom = el.value;
      if (el.dataset.bar === "to") barSetTo = el.value;
      if (barSetFrom && barSetTo && barSetFrom > barSetTo) {
        const swap = barSetFrom;
        barSetFrom = barSetTo;
        barSetTo = swap;
      }
      barSetCache = null;
      renderBarSettlements();
    };
  });
  root.querySelectorAll("[data-barjump]").forEach((btn) => { btn.onclick = () => barSetJump(btn.dataset.barjump); });
  const excel = root.querySelector("#barSetExcel");
  if (excel) excel.onclick = () => barSetCsv();
  const reload = root.querySelector("#barSetReload");
  if (reload) reload.onclick = () => { barSetCache = null; renderBarSettlements(); };
}

async function renderBarSettlements() {
  const main = $("main");
  if (!main) return;
  const allowed = typeof canMod !== "function" || (canMod("baraholka") && canMod("settlements")) || (typeof isAdmin === "function" && isAdmin());
  if (!allowed) {
    main.innerHTML = '<div class="empty"><div class="big">Нет доступа к взаиморасчётам барахолки</div></div>';
    return;
  }
  barSetInitPeriod();
  const gen = ++barSetGen;
  const cached = barSetCache && barSetCache.from === barSetFrom && barSetCache.to === barSetTo;
  if (!cached) {
    main.innerHTML = '<div class="empty"><div class="big">Загружаем взаиморасчёты барахолки…</div></div>';
    try {
      const orders = await barSetFetch(barSetFrom, barSetTo);
      const partners = await barSetPartners();
      const invoices = await barSetInvoices(orders.map((o) => o.id).filter(Boolean));
      const cashier = await barSetCashier();
      if (gen !== barSetGen || (typeof S !== "undefined" && S.tab !== "barsettlements")) return;
      barSetCache = { from: barSetFrom, to: barSetTo, orders, partners, invoices, kassa: barSetKassaName(cashier), error: "" };
    } catch (e) {
      if (gen !== barSetGen) return;
      barSetCache = { from: barSetFrom, to: barSetTo, orders: [], partners: [], invoices: [], kassa: "Второй кассир", error: (e && e.message) || "Список не загрузился" };
    }
  }
  if (typeof S !== "undefined" && S.tab !== "barsettlements") return;
  barSetPaint();
  const ids = ((barSetCache && barSetCache.orders) || []).map((o) => o.id).filter(Boolean);
  if (!ids.length || typeof callEdge !== "function") return;
  const synced = await callEdge("kaspi-pay", { action: "bar_sync", order_ids: ids.slice(0, 200) });
  if (gen !== barSetGen || (typeof S !== "undefined" && S.tab !== "barsettlements")) return;
  if (!synced || !synced.ok || !synced.checked) return;
  try {
    const invoices = await barSetInvoices(ids);
    if (gen !== barSetGen || !barSetCache) return;
    barSetCache.invoices = invoices;
    barSetPaint();
  } catch (e) { /* на экране остаётся уже показанный список */ }
}
