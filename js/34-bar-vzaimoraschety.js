/* Взаиморасчёты барахолки. Обычный модуль «Взаиморасчёты» эти заказы не берёт:
   барахолка — другая ветка, и сервер settlements их пропускает нарочно.
   Здесь только заказы с calc_group = baraholka.

   Две разные суммы, их нельзя сложить:
   • «Партнёр по счёту» — галочка «Оплачено отправителем». В заказе ноль, а в счёт
     конца месяца идёт запомненная цена из реестра (order_sum_orig), вместе с перевесом.
     Если её нет, строка всё равно видна: обнулять такой долг догадкой нельзя.
   • «Платит получатель» — сумма заказа (order_sum). Это не долг партнёра. */
let barSetFrom = "";
let barSetTo = "";
let barSetQ = "";
let barSetByOrder = false;
let barSetPage = 0;
let barSetCache = null;
let barSetGen = 0;
const BAR_SET_PAGE = 100;

function barSetEsc(s) {
  return typeof esc === "function" ? esc(s) : String(s ?? "");
}
function barSetMoney(n) {
  return (Number(n) || 0).toLocaleString("ru-RU") + " ₸";
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "—";
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
  if (linked && linked.name) return String(linked.name);
  const named = cat.byName.get(barSetKey(order && order.sender));
  if (named && named.name) return String(named.name);
  const sender = String((order && order.sender) || "").trim();
  return sender || "Партнёр не указан";
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
function barSetMatch(hay, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const raw = String(hay || "").toLowerCase();
  if (raw.includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  if (digits.length < 4) return false;
  return raw.replace(/\D/g, "").includes(digits);
}
function barSetRows(orders, partners) {
  const cat = barSetCatalog(partners);
  return (orders || []).map((o) => {
    const line = barSetLine(o);
    return {
      id: o.id,
      code: o.code || "",
      client: o.client || "",
      who: barSetWho(o, cat),
      day: barSetDay(o),
      partnerPays: line.partnerPays,
      amount: line.amount,
      missing: line.missing,
    };
  });
}
function barSetVisible(rows, query) {
  return (rows || []).filter((row) => barSetMatch([row.who, row.code, row.client].join("\n"), query));
}
function barSetGroups(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    let g = map.get(row.who);
    if (!g) {
      g = { who: row.who, orders: 0, partnerOrders: 0, partnerSum: 0, recipientOrders: 0, recipientSum: 0, missing: 0 };
      map.set(row.who, g);
    }
    g.orders += 1;
    if (row.partnerPays) {
      g.partnerOrders += 1;
      g.partnerSum += row.amount;
      if (row.missing) g.missing += 1;
    } else {
      g.recipientOrders += 1;
      g.recipientSum += row.amount;
    }
  });
  return [...map.values()].sort((a, b) => (b.partnerSum - a.partnerSum) || (b.recipientSum - a.recipientSum) || a.who.localeCompare(b.who, "ru"));
}
function barSetTotals(rows) {
  const groups = barSetGroups(rows);
  return {
    partners: groups.length,
    orders: rows.length,
    partnerSum: groups.reduce((s, g) => s + g.partnerSum, 0),
    recipientSum: groups.reduce((s, g) => s + g.recipientSum, 0),
    missing: groups.reduce((s, g) => s + g.missing, 0),
  };
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
  return `<div class="stat"><div class="stat-body"><div class="k">${barSetEsc(title)}</div><div class="v">${value}</div></div></div>`;
}
function barSetNum(i) {
  return `<td data-label="№" style="color:var(--muted);text-align:right">${i + 1}</td>`;
}

function barSetMarkup() {
  const model = barSetCache || { orders: [], partners: [], error: "" };
  const rows = barSetVisible(barSetRows(model.orders, model.partners), barSetQ);
  const totals = barSetTotals(rows);
  const groups = barSetGroups(rows);
  const pages = Math.max(1, Math.ceil((barSetByOrder ? rows.length : groups.length) / BAR_SET_PAGE));
  if (barSetPage >= pages) barSetPage = pages - 1;
  if (barSetPage < 0) barSetPage = 0;
  const start = barSetPage * BAR_SET_PAGE;
  const orderRows = barSetByOrder
    ? rows.slice().sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(a.code).localeCompare(String(b.code), "ru", { numeric: true })).slice(start, start + BAR_SET_PAGE)
    : [];
  const groupRows = barSetByOrder ? [] : groups.slice(start, start + BAR_SET_PAGE);
  const body = model.error
    ? `<div class="empty"><div class="big">Список не загрузился</div>${barSetEsc(model.error)}</div>`
    : !rows.length
      ? `<div class="empty"><div class="big">${model.orders.length ? "Ничего не найдено" : "За этот период заказов барахолки нет"}</div>${model.orders.length ? "Измените поиск." : "Выберите другие даты."}</div>`
      : barSetByOrder
        ? `<table class="resp-table"><thead><tr><th style="width:46px;color:var(--muted)">№</th><th>Заказ</th><th>Клиент</th><th>Кто держит долг</th><th>Период</th><th>Кто платит</th><th>Сумма</th></tr></thead><tbody>${orderRows.map((row, i) => `<tr>${barSetNum(start + i)}<td>${barSetEsc(row.code || "—")}</td><td>${barSetEsc(row.client || "—")}</td><td>${barSetEsc(row.who)}</td><td>${barSetEsc(barSetDayLabel(row.day))}</td><td>${row.partnerPays ? "Партнёр по счёту" : "Получатель"}</td><td>${row.missing ? "нет суммы" : barSetMoney(row.amount)}</td></tr>`).join("")}</tbody></table>`
        : `<table class="resp-table"><thead><tr><th style="width:46px;color:var(--muted)">№</th><th>Кто держит долг</th><th>Заказов</th><th>Партнёр по счёту</th><th>Платит получатель</th><th>Без суммы</th></tr></thead><tbody>${groupRows.map((g, i) => `<tr>${barSetNum(start + i)}<td>${barSetEsc(g.who)}</td><td>${g.orders}</td><td>${g.partnerOrders ? `${g.partnerOrders} · ${barSetMoney(g.partnerSum)}` : "—"}</td><td>${g.recipientOrders ? `${g.recipientOrders} · ${barSetMoney(g.recipientSum)}` : "—"}</td><td>${g.missing || "—"}</td></tr>`).join("")}</tbody></table>`;
  const pageNote = rows.length ? `<div style="margin:0 0 8px;font-size:13px;font-weight:600">На странице: ${barSetByOrder ? orderRows.length : groupRows.length}${pages === 1 ? "" : ` из ${barSetByOrder ? rows.length : groups.length}`}</div>` : "";
  const pager = pages > 1 ? `<div style="display:flex;gap:8px;align-items:center;margin-top:10px"><button class="btn sm" type="button" data-barpage="-1" ${barSetPage ? "" : "disabled"}>Назад</button><span style="color:var(--muted);font-size:13px">${barSetPage + 1} / ${pages}</span><button class="btn sm" type="button" data-barpage="1" ${barSetPage + 1 < pages ? "" : "disabled"}>Дальше</button></div>` : "";
  return `<div class="page-head"><div><h1>Взаиморасчёты барахолки</h1>
      <p>Заказы, которые пришли от партнёров барахолки. В обычные взаиморасчёты они не входят. «Партнёр по счёту» — запомненная цена из реестра. «Платит получатель» — сумма заказа, это не долг партнёра.</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" id="barSetExcel" type="button">Excel</button><button class="btn sm" id="barSetReload" type="button">Обновить</button></div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:0 0 10px">
      <div class="field" style="margin:0"><label>Период с</label><input type="date" data-bar="from" value="${barSetEsc(barSetFrom)}"></div>
      <div class="field" style="margin:0"><label>Период по</label><input type="date" data-bar="to" value="${barSetEsc(barSetTo)}"></div>
      <button class="btn sm ghost" type="button" data-barjump="today">Сегодня</button>
      <button class="btn sm ghost" type="button" data-barjump="yesterday">Вчера</button>
      <button class="btn sm ghost" type="button" data-barjump="month">Этот месяц</button>
      <div class="field" style="margin:0;min-width:220px;flex:1"><label>Поиск</label><input data-bar="q" value="${barSetEsc(barSetQ)}" placeholder="Партнёр, заказ, клиент"></div>
    </div>
    <label class="pom-paid" style="margin:0 0 10px"><input type="checkbox" id="barSetByOrder" ${barSetByOrder ? "checked" : ""}> Развернуть по заказам</label>
    <div class="stats">
      ${barSetCard("Партнёров", String(totals.partners))}
      ${barSetCard("Заказов", String(totals.orders))}
      ${barSetCard("Партнёр по счёту", barSetMoney(totals.partnerSum))}
      ${barSetCard("Платит получатель", barSetMoney(totals.recipientSum))}
      ${barSetCard("Без суммы", String(totals.missing))}
    </div>
    ${pageNote}${body}${pager}`;
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
    const res = await sb.from("partners").select("id,name,is_baraholka").eq("is_baraholka", true);
    if (!res.error && res.data) return res.data;
  } catch (e) { /* имя останется как в заказе */ }
  return (typeof S !== "undefined" && S.partners) || [];
}

function barSetCsv() {
  const model = barSetCache || { orders: [], partners: [] };
  const rows = barSetVisible(barSetRows(model.orders, model.partners), barSetQ);
  const lines = ["кто держит долг;заказов;партнёр по счёту;заказов партнёра;платит получатель;заказов получателя;без суммы"];
  barSetGroups(rows).forEach((g) => lines.push([g.who, g.orders, g.partnerSum, g.partnerOrders, g.recipientSum, g.recipientOrders, g.missing].join(";")));
  if (barSetByOrder) {
    lines.push("");
    lines.push("заказ;клиент;кто держит долг;период;кто платит;сумма");
    rows.forEach((row) => lines.push([row.code, row.client, row.who, barSetDayLabel(row.day), row.partnerPays ? "партнёр по счёту" : "получатель", row.missing ? "" : row.amount].join(";")));
  }
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
  const key = focus && focus.dataset ? focus.dataset.bar : "";
  main.innerHTML = barSetMarkup();
  barSetBind(main);
  if (!key) return;
  const next = main.querySelector(`[data-bar="${key}"]`);
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
  barSetPage = 0;
  barSetCache = null;
  renderBarSettlements();
}
function barSetBind(root) {
  const search = root.querySelector('[data-bar="q"]');
  if (search) search.oninput = () => {
    barSetQ = search.value;
    barSetPage = 0;
    barSetPaint(search);
  };
  root.querySelectorAll('input[type="date"][data-bar]').forEach((el) => {
    el.onchange = () => {
      if (el.dataset.bar === "from") barSetFrom = el.value;
      if (el.dataset.bar === "to") barSetTo = el.value;
      if (barSetFrom && barSetTo && barSetFrom > barSetTo) {
        const swap = barSetFrom;
        barSetFrom = barSetTo;
        barSetTo = swap;
      }
      barSetPage = 0;
      barSetCache = null;
      renderBarSettlements();
    };
  });
  root.querySelectorAll("[data-barjump]").forEach((btn) => { btn.onclick = () => barSetJump(btn.dataset.barjump); });
  const byOrder = root.querySelector("#barSetByOrder");
  if (byOrder) byOrder.onchange = () => { barSetByOrder = byOrder.checked; barSetPage = 0; barSetPaint(); };
  root.querySelectorAll("[data-barpage]").forEach((btn) => {
    btn.onclick = () => { barSetPage += Number(btn.dataset.barpage) || 0; barSetPaint(); };
  });
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
      if (gen !== barSetGen || (typeof S !== "undefined" && S.tab !== "barsettlements")) return;
      barSetCache = { from: barSetFrom, to: barSetTo, orders, partners, error: "" };
    } catch (e) {
      if (gen !== barSetGen) return;
      barSetCache = { from: barSetFrom, to: barSetTo, orders: [], partners: [], error: (e && e.message) || "Список не загрузился" };
    }
  }
  if (typeof S !== "undefined" && S.tab !== "barsettlements") return;
  barSetPaint();
}
