/* ============================================================
   32. KASPI PAY — УДАЛЁННЫЙ СЧЁТ ИЗ КАРТОЧКИ ЗАКАЗА (24.11.2026)

   Просьба владельца: менеджер выставляет счёт на номер клиента, клиент платит в
   приложении Kaspi, заказ сам становится оплаченным.

   Всё, что ходит в Kaspi и пишет счета, делает Edge Function `kaspi-pay`; здесь только
   экран. Таблицы — kaspi_settings и kaspi_invoices, поля оплаты заказа — pay_method,
   pay_status ('invoiced' | 'paid' | пусто), paid_at (db/72).

   ГЛАВНОЕ: публичного API у Kaspi для этого нет, счёт создаёт привязанный кассир.
   Способ связи с кассиром пока НЕ подключён, поэтому вживую работает только ТЕСТОВЫЙ
   режим (фиктивный счёт и «Симулировать оплату»); боевой отвечает честным отказом.

   Имена здесь — с приставкой `kaspi`: все скрипты делят одну глобальную область.
   ============================================================ */

let kaspiCfg;               // undefined — не грузили; null — таблицы нет; иначе строка настроек
let kaspiWait=null;         // {phone,at} — счёт надо выставить сразу после сохранения карточки
let kaspiTimer=null;        // опрос открытого счёта, пока карточка на экране

const kaspiMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
const kaspiPhoneOk=v=>/^7\d{9}$/.test(v||'');
const kaspiOn=()=>!!(kaspiCfg&&kaspiCfg.enabled&&String(kaspiCfg.cashier_phone||'').trim());

async function kaspiCfgLoad(force){
  if(kaspiCfg!==undefined&&!force)return kaspiCfg;
  try{
    const {data,error}=await sb.from('kaspi_settings').select('*').eq('id',1).maybeSingle();
    if(error)throw error;
    kaspiCfg=data||null;
  }catch(e){kaspiCfg=null;}
  return kaspiCfg;
}

/* Блок встаёт под полем «Сумма заказа». Вызывается из orderModal (js/11). */
async function kaspiAttach(o,ro){
  kaspiWait=null;
  if(kaspiTimer){clearInterval(kaspiTimer);kaspiTimer=null;}
  const sum=$('o_sum'), f=sum&&sum.closest('.field');
  if(!f||!isStaff())return;
  const box=document.createElement('div');
  box.className='field kaspi-box';box.id='kaspiBox';
  f.insertAdjacentElement('afterend',box);
  box.innerHTML='<span class="hint">Kaspi Pay: проверяем…</span>';
  await kaspiCfgLoad();
  if(kaspiCfg===null){box.remove();return;}           // таблиц нет — блока нет вовсе
  let inv=null;
  if(o&&o.id){
    try{
      const {data}=await sb.from('kaspi_invoices').select('*').eq('order_id',o.id).order('created_at',{ascending:false}).limit(1);
      inv=(data||[])[0]||null;
    }catch(e){inv=null;}
  }
  if(!document.body.contains(box))return;             // карточку уже закрыли
  kaspiDraw(box,o,inv,ro);
}

function kaspiDraw(box,o,inv,ro){
  if(kaspiTimer){clearInterval(kaspiTimer);kaspiTimer=null;}
  const sumEl=$('o_sum'), paidChk=$('o_paidorder');
  // --- оплачено ---
  if(inv&&inv.status==='paid'){
    box.innerHTML=`<label>Оплата Kaspi</label><div class="kaspi-paid">✅ Оплачено ${kaspiMoney(inv.amount)} с +7${esc(inv.phone10)}${inv.test?' <span class="hint">(тестовый счёт)</span>':''}</div>`;
    if(sumEl)sumEl.disabled=true;
    return;
  }
  // --- счёт выставлен, ждём оплату ---
  if(inv&&inv.status==='pending'){
    // пока счёт открыт, сумму менять нельзя: она должна совпасть со счётом
    if(sumEl)sumEl.disabled=true;
    if(paidChk)paidChk.disabled=true;
    box.innerHTML=`<label>Оплата Kaspi</label>
      <div class="kaspi-wait">Счёт на ${kaspiMoney(inv.amount)} отправлен на +7${esc(inv.phone10)}. Ждём оплату в Kaspi${inv.test?' <span class="hint">(тестовый счёт — в Kaspi не уходил)</span>':''}</div>
      ${ro?'':`<div class="kaspi-row">
        <button type="button" class="btn ghost" id="kaspiCheck">Проверить оплату</button>
        <button type="button" class="btn ghost" id="kaspiCancel">Отменить счёт</button>
        ${inv.test?'<button type="button" class="btn ghost" id="kaspiSim">Симулировать оплату</button>':''}
      </div>`}
      <span class="hint">Пока счёт открыт, сумму заказа менять нельзя: она должна совпасть со счётом.</span>`;
    const act=async(action,btn,okText)=>{
      if(btn)btn.disabled=true;
      const r=await callEdge('kaspi-pay',{action,invoice_id:inv.id});
      if(!document.body.contains(box))return;
      if(!r||r.error||!r.invoice){if(btn)btn.disabled=false;toast(kaspiErr(r),7000);return;}
      if(r.invoice.status!==inv.status){
        kaspiApplyToOrder(o,r.invoice);
        if(okText)toast(okText);
        if(r.invoice.status!=='paid'){if(sumEl&&!ro)sumEl.disabled=!!(paidChk&&paidChk.checked);if(paidChk&&!ro)paidChk.disabled=false;}
        kaspiDraw(box,o,r.invoice.status==='pending'||r.invoice.status==='paid'?r.invoice:null,ro);
      }else{if(btn)btn.disabled=false;if(action==='check')toast('Оплаты пока нет');}
    };
    const ck=$('kaspiCheck');if(ck)ck.onclick=()=>act('check',ck,'');
    const cn=$('kaspiCancel');if(cn)cn.onclick=()=>{if(confirm('Отменить счёт в Kaspi?'))act('cancel',cn,'Счёт отменён');};
    const sm=$('kaspiSim');if(sm)sm.onclick=()=>act('simulate',sm,'Оплата симулирована');
    // на открытой карточке статус проверяется сам каждые 15 секунд
    kaspiTimer=setInterval(()=>{
      if(!document.body.contains(box)){clearInterval(kaspiTimer);kaspiTimer=null;return;}
      act('check',null,'');
    },15000);
    return;
  }
  // --- счёта нет ---
  if(ro){box.remove();return;}
  if(!kaspiOn()){
    box.innerHTML=`<label>Оплата Kaspi</label><span class="hint">Кассир Kaspi не привязан или приём выключен.${isAdmin()?' <a href="#" id="kaspiToSet">Открыть настройки</a>':''}</span>`;
    const a=$('kaspiToSet');
    if(a)a.onclick=e=>{e.preventDefault();const x=box.closest('.overlay');if(x){const b=x.querySelector('.x');if(b)b.click();}S.tab='settings';S.dir='kaspi';render();};
    return;
  }
  const ph0=(typeof phoneStored==='function'?phoneStored(($('o_phone')||{}).value||(o&&o.phone)||''):'');
  box.innerHTML=`<label>Оплата Kaspi${kaspiCfg.test_mode?' <span class="hint">· тестовый режим</span>':''}</label>
    <div class="kaspi-ready" id="kaspiReady"></div>
    <div class="kaspi-row">
      <div class="kaspi-phone"><span>+7</span><input type="tel" inputmode="numeric" id="kaspiPhone" maxlength="10" placeholder="7XXXXXXXXX" value="${esc(ph0)}" title="Номер Kaspi клиента"></div>
      <button type="button" class="btn kaspi-btn" id="kaspiSend" disabled>Выставить счёт</button>
    </div>
    <span class="hint">Номер Kaspi клиента — 10 цифр после +7. Счёт уходит на сумму заказа. По кнопке заказ сначала сохраняется, и только потом отправляется счёт.</span>`;
  const phEl=$('kaspiPhone'), btn=$('kaspiSend'), ready=$('kaspiReady');
  const amount=()=>Math.round(parseFloat((sumEl&&sumEl.value)||'0')||0);
  const upd=()=>{
    const a=amount(), ok=kaspiPhoneOk(phEl.value);
    ready.textContent=a>0?'Всё готово: счёт можно отправить клиенту на оплату':'Укажите сумму заказа, чтобы отправить счёт на оплату';
    btn.textContent=a>0?`Выставить счёт на ${kaspiMoney(a)}`:'Выставить счёт';
    btn.disabled=!(a>0&&ok);
    phEl.style.borderColor=phEl.value&&!ok?'var(--rust)':'';
  };
  phEl.oninput=()=>{phEl.value=phEl.value.replace(/\D/g,'').slice(0,10);upd();};
  if(sumEl)sumEl.addEventListener('input',upd);
  if(paidChk)paidChk.addEventListener('change',()=>setTimeout(upd,0));
  // сумму подставляет и тариф, и размер пакета — кодом, без события ввода
  const watch=setInterval(()=>{if(!document.body.contains(box)){clearInterval(watch);return;}if(document.activeElement!==phEl)upd();},800);
  upd();
  btn.onclick=()=>{
    const a=amount(), phone=phEl.value;
    if(!(a>0)||!kaspiPhoneOk(phone))return;
    if(!confirm(`Заказ сохранится, и на номер +7${phone} уйдёт счёт Kaspi на ${kaspiMoney(a)}. Продолжить?`))return;
    const ov=box.closest('.overlay'), sv=ov&&ov.querySelector('[data-save]');
    if(!sv){toast('Не нашли кнопку сохранения карточки');return;}
    kaspiWait={phone,at:Date.now()};
    sv.click();
    // Сохранение не прошло (не хватило обязательного поля) — намерение снимаем: иначе
    // следующее обычное «Сохранить» молча отправило бы счёт.
    const t=setInterval(()=>{if(!document.body.contains(sv)||!sv.disabled){clearInterval(t);kaspiWait=null;}},300);
  };
}

function kaspiErr(r){
  const m=String((r&&r.error)||'Kaspi не ответил');
  return m.replace(/^Unauthorized:\s*/,'Нет доступа: ');
}

/* Память вкладки: Realtime донесёт правку заказа, но грид должен показать её сразу. */
function kaspiApplyToOrder(o,inv){
  if(!o||!inv)return;
  if(inv.status==='paid'){o.pay_status='paid';o.pay_method='Kaspi, удалённый счёт';o.paid_at=inv.paid_at;}
  else if(inv.status==='pending'){o.pay_status='invoiced';o.pay_method='Kaspi, удалённый счёт';}
  else o.pay_status=null;
}

/* Зовётся из сохранения карточки (js/11) ПОСЛЕ успешной записи заказа: счёта без
   сохранённого заказа быть не должно. Отказ Kaspi заказ не трогает. */
async function kaspiAfterSave(saved){
  const w=kaspiWait;kaspiWait=null;
  if(!w||!saved||!saved.id||Date.now()-w.at>120000)return;
  const r=await callEdge('kaspi-pay',{action:'create',order_id:saved.id,phone:w.phone});
  if(r&&r.ok&&r.invoice){
    kaspiApplyToOrder(saved,r.invoice);
    toast(`Счёт Kaspi на ${kaspiMoney(r.invoice.amount)} отправлен на +7${r.invoice.phone10}`,5000);
  }else toast('Заказ сохранён, но счёт Kaspi не выставлен: '+kaspiErr(r),9000);
  // карточка после сохранения закрывается — открываем её снова, уже с экраном ожидания
  setTimeout(()=>{if(typeof orderModal==='function')orderModal(saved.id);},250);
}

/* ---------- Настройки → Kaspi Pay ---------- */
async function renderKaspiSettings(){
  const box=$('dirContent');if(!box)return;
  box.innerHTML='<div class="panel"><div class="empty">Загружаем…</div></div>';
  await kaspiCfgLoad(true);
  if(S.dir!=='kaspi'||!$('dirContent'))return;
  if(kaspiCfg===null){box.innerHTML='<div class="panel"><div class="empty">Раздел ещё не включён: в базе нет таблицы kaspi_settings (db/72).</div></div>';return;}
  const adm=isAdmin(), c=kaspiCfg, dis=adm?'':' disabled';
  box.innerHTML=`<div class="panel" style="padding:18px;max-width:640px">
    <h3 style="margin:0 0 6px">Kaspi Pay — удалённый счёт</h3>
    <p class="hint" style="margin:0 0 14px">В карточке заказа появляется кнопка «Выставить счёт»: счёт уходит на номер клиента, после оплаты заказ сам становится оплаченным.</p>
    <div class="field"><label>Номер кассира Kaspi Pay</label>
      <input type="tel" id="kaspiCashier" value="${esc(c.cashier_phone||'')}" placeholder="+7 7XX XXX XX XX"${dis}></div>
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="kaspiEnabled"${c.enabled?' checked':''}${dis}> Принимать платежи</label>
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="kaspiTest"${c.test_mode?' checked':''}${dis}> Тестовый режим <span class="hint">— в Kaspi не ходит: создаёт фиктивный счёт и даёт кнопку «Симулировать оплату»</span></label>
    <div class="hint" style="margin:10px 0;padding:10px 12px;border-radius:10px;background:#fff7ed;color:#9a3412">
      <b>Боевой режим пока не подключён.</b> У Kaspi нет открытого API для удалённых счетов: счёт создаёт привязанный кассир, и CRM нужен способ к нему обратиться (сервис-посредник или описание его запросов). Пока его нет, при выключенном тестовом режиме кнопка в заказе отвечает отказом и счёт не уходит.
    </div>
    ${adm?'<button class="btn primary" id="kaspiSave">Сохранить</button>':'<div class="hint">Менять настройки может только администратор.</div>'}
  </div>`;
  const sv=$('kaspiSave');
  if(sv)sv.onclick=async()=>{
    sv.disabled=true;
    const row={cashier_phone:String($('kaspiCashier').value||'').trim()||null,enabled:$('kaspiEnabled').checked,
      test_mode:$('kaspiTest').checked,updated_at:new Date().toISOString(),updated_by_name:(S.me&&(S.me.full_name||S.me.email))||''};
    if(row.enabled&&!row.cashier_phone){sv.disabled=false;toast('Укажите номер кассира — без него приём не включить');return;}
    if(row.enabled&&!row.test_mode&&!confirm('Выключить тестовый режим?\n\nБоевой режим пока не подключён: счёта в Kaspi уходить не будут, кнопка в заказе ответит отказом.')){sv.disabled=false;return;}
    const {data,error}=await sb.from('kaspi_settings').update(row).eq('id',1).select().maybeSingle();
    sv.disabled=false;
    if(error||!data){toast('Не сохранено: '+(error?dbErrText(error):'нет прав'));return;}
    kaspiCfg=data;toast('Сохранено');
  };
}
