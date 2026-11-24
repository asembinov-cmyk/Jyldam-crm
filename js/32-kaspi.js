/* ============================================================
   32. KASPI PAY — УДАЛЁННЫЙ СЧЁТ ИЗ КАРТОЧКИ ЗАКАЗА (24.11.2026)

   Просьба владельца: менеджер выставляет счёт на номер клиента, клиент платит в
   приложении Kaspi, заказ сам становится оплаченным.

   Всё, что ходит в Kaspi и пишет счета, делает Edge Function `kaspi-pay`; здесь только
   экран. Таблицы — kaspi_settings и kaspi_invoices, поля оплаты заказа — pay_method,
   pay_status ('invoiced' | 'paid' | пусто), paid_at (db/72).

   Боевой шлюз: привязка кассира через OTP (порт pykaspi в Edge Function). Тестовый
   режим по-прежнему создаёт фиктивный счёт и даёт «Симулировать оплату».

   Имена здесь — с приставкой `kaspi`: все скрипты делят одну глобальную область.
   ============================================================ */

let kaspiCfg;               // undefined — не грузили; null — таблицы нет; иначе строка настроек
let kaspiWait=null;         // {phone,at} — счёт надо выставить сразу после сохранения карточки
let kaspiTimer=null;        // опрос открытого счёта, пока карточка на экране

const kaspiMoney=n=>Math.round(n||0).toLocaleString('ru-RU')+' ₸';
const kaspiPhoneOk=v=>/^7\d{9}$/.test(v||'');
const kaspiOn=()=>!!(kaspiCfg&&kaspiCfg.enabled&&String(kaspiCfg.cashier_phone||'').trim());
const kaspiBound=()=>!!(kaspiCfg&&kaspiCfg.bind_state==='bound');
const kaspiLiveOk=()=>!!(kaspiCfg&&(kaspiCfg.test_mode||(kaspiBound()&&!kaspiCfg.bind_warning)));
const KASPI_COLS='id,cashier_phone,enabled,test_mode,updated_at,updated_by_name';
const KASPI_BIND='bind_state,bind_error,bind_warning,session_checked_at';

async function kaspiSettingsRow(){
  let q=await sb.from('kaspi_settings').select(KASPI_COLS+','+KASPI_BIND).eq('id',1).maybeSingle();
  if(q.error) q=await sb.from('kaspi_settings').select(KASPI_COLS).eq('id',1).maybeSingle();
  return q;
}

async function kaspiCfgLoad(force){
  if(kaspiCfg!==undefined&&!force)return kaspiCfg;
  try{
    const q=await kaspiSettingsRow();
    if(q.error)throw q.error;
    kaspiCfg=q.data||null;
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
  if(kaspiCfg===null){box.remove();return;}
  let inv=null;
  if(o&&o.id){
    try{
      const {data}=await sb.from('kaspi_invoices').select('*').eq('order_id',o.id).order('created_at',{ascending:false}).limit(1);
      inv=(data||[])[0]||null;
    }catch(e){inv=null;}
  }
  if(!document.body.contains(box))return;
  kaspiDraw(box,o,inv,ro);
}

function kaspiDraw(box,o,inv,ro){
  if(kaspiTimer){clearInterval(kaspiTimer);kaspiTimer=null;}
  const sumEl=$('o_sum'), paidChk=$('o_paidorder');
  if(inv&&inv.status==='paid'){
    box.innerHTML=`<label>Оплата Kaspi</label><div class="kaspi-paid">✅ Оплачено ${kaspiMoney(inv.amount)} с +7${esc(inv.phone10)}${inv.test?' <span class="hint">(тестовый счёт)</span>':''}</div>`;
    if(sumEl)sumEl.disabled=true;
    return;
  }
  if(inv&&inv.status==='pending'){
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
    kaspiTimer=setInterval(()=>{
      if(!document.body.contains(box)){clearInterval(kaspiTimer);kaspiTimer=null;return;}
      act('check',null,'');
    },15000);
    return;
  }
  if(ro){box.remove();return;}
  if(!kaspiOn()||(!kaspiCfg.test_mode&&!kaspiLiveOk())){
    const why=!kaspiOn()?'Кассир Kaspi не привязан или приём выключен.':
      (kaspiCfg.bind_warning?('Сессия Kaspi неактивна: '+kaspiCfg.bind_warning):'Боевой режим: сначала привяжите кассира через OTP.');
    box.innerHTML=`<label>Оплата Kaspi</label><span class="hint">${esc(why)}${isAdmin()?' <a href="#" id="kaspiToSet">Открыть настройки</a>':''}</span>`;
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
    const t=setInterval(()=>{if(!document.body.contains(sv)||!sv.disabled){clearInterval(t);kaspiWait=null;}},300);
  };
}

function kaspiErr(r){
  const m=String((r&&r.error)||'Kaspi не ответил');
  return m.replace(/^Unauthorized:\s*/,'Нет доступа: ');
}

function kaspiApplyToOrder(o,inv){
  if(!o||!inv)return;
  if(inv.status==='paid'){o.pay_status='paid';o.pay_method='Kaspi, удалённый счёт';o.paid_at=inv.paid_at;}
  else if(inv.status==='pending'){o.pay_status='invoiced';o.pay_method='Kaspi, удалённый счёт';}
  else o.pay_status=null;
}

async function kaspiAfterSave(saved){
  const w=kaspiWait;kaspiWait=null;
  if(!w||!saved||!saved.id||Date.now()-w.at>120000)return;
  const r=await callEdge('kaspi-pay',{action:'create',order_id:saved.id,phone:w.phone});
  if(r&&r.ok&&r.invoice){
    kaspiApplyToOrder(saved,r.invoice);
    toast(`Счёт Kaspi на ${kaspiMoney(r.invoice.amount)} отправлен на +7${r.invoice.phone10}`,5000);
  }else toast('Заказ сохранён, но счёт Kaspi не выставлен: '+kaspiErr(r),9000);
  setTimeout(()=>{if(typeof orderModal==='function')orderModal(saved.id);},250);
}

function kaspiBindLabel(c){
  const st=c.bind_state||'not_bound';
  if(st==='bound')return 'Привязан';
  if(st==='otp_pending')return 'Ожидает OTP';
  if(st==='error')return 'Ошибка';
  return 'Не привязан';
}

/* ---------- Настройки → Kaspi Pay ---------- */
async function renderKaspiSettings(){
  const box=$('dirContent');if(!box)return;
  box.innerHTML='<div class="panel"><div class="empty">Загружаем…</div></div>';
  await kaspiCfgLoad(true);
  if(S.dir!=='kaspi'||!$('dirContent'))return;
  if(kaspiCfg===null){box.innerHTML='<div class="panel"><div class="empty">Раздел ещё не включён: в базе нет таблицы kaspi_settings (db/72).</div></div>';return;}
  const adm=isAdmin(), c=kaspiCfg, dis=adm?'':' disabled';
  const st=c.bind_state||'not_bound';
  const warn=String(c.bind_warning||'').trim();
  const err=String(c.bind_error||'').trim();
  const banner=warn
    ?`<div class="hint" style="margin:10px 0;padding:10px 12px;border-radius:10px;background:#fef2f2;color:#991b1b"><b>Сессия неактивна.</b> ${esc(warn)}</div>`
    :(st==='bound'
      ?`<div class="hint" style="margin:10px 0;padding:10px 12px;border-radius:10px;background:#f0fdf4;color:#166534"><b>Кассир привязан.</b> ${c.session_checked_at?'Последняя проверка: '+esc(String(c.session_checked_at).replace('T',' ').slice(0,19)):'Сессию можно проверить кнопкой «Тест».'}</div>`
      :'');
  box.innerHTML=`<div class="panel" style="padding:18px;max-width:640px" id="partner-kaspi-gateway">
    <h3 style="margin:0 0 6px">Kaspi Pay — удалённый счёт</h3>
    <p class="hint" style="margin:0 0 14px">В карточке заказа появляется кнопка «Выставить счёт»: счёт уходит на номер клиента, после оплаты заказ сам становится оплаченным.</p>
    ${banner}
    ${err&&st!=='bound'?`<div class="hint" style="margin:0 0 10px;color:#9a3412">${esc(err)}</div>`:''}
    <div class="field"><label>Номер кассира Kaspi Pay</label>
      <input type="tel" id="kaspiCashier" value="${esc(c.cashier_phone||'')}" placeholder="+7 7XX XXX XX XX"${dis}></div>
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="kaspiEnabled"${c.enabled?' checked':''}${dis}> Принимать платежи</label>
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input type="checkbox" id="kaspiTest"${c.test_mode?' checked':''}${dis}> Тестовый режим <span class="hint">— в Kaspi не ходит: создаёт фиктивный счёт и даёт кнопку «Симулировать оплату»</span></label>
    <div class="field" style="margin-top:14px"><label>Статус привязки</label>
      <div><b>${esc(kaspiBindLabel(c))}</b> <span class="hint">(${esc(st)})</span></div></div>
    ${adm?`<div class="kaspi-row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
      <button class="btn primary" id="kaspiSave">Сохранить</button>
      <button class="btn ghost" id="kaspiOtpStart">Отправить OTP</button>
      <input type="text" id="kaspiOtpCode" placeholder="код из SMS" maxlength="8" style="width:110px;padding:8px 10px;border:1px solid #ddd;border-radius:8px">
      <button class="btn ghost" id="kaspiOtpConfirm">Подтвердить OTP</button>
      <button class="btn ghost" id="kaspiTestBtn">Тест подключения</button>
      <button class="btn ghost" id="kaspiUnbind">Отвязать</button>
    </div>
    <p class="hint" style="margin:12px 0 0">Для боя: кассир в Kaspi Business на <b>отдельном</b> номере (не полный аккаунт Kaspi), снять тестовый режим, привязать OTP. Секрет <code>KASPI_SESSION_KEY</code> должен быть задан в Edge Functions.</p>`
    :'<div class="hint">Менять настройки может только администратор.</div>'}
  </div>`;
  const sv=$('kaspiSave');
  if(sv)sv.onclick=async()=>{
    sv.disabled=true;
    const row={cashier_phone:String($('kaspiCashier').value||'').trim()||null,enabled:$('kaspiEnabled').checked,
      test_mode:$('kaspiTest').checked,updated_at:new Date().toISOString(),updated_by_name:(S.me&&(S.me.full_name||S.me.email))||''};
    if(row.enabled&&!row.cashier_phone){sv.disabled=false;toast('Укажите номер кассира — без него приём не включить');return;}
    if(row.enabled&&!row.test_mode&&st!=='bound'&&!confirm('Выключить тестовый режим без привязанного кассира?\n\nСначала лучше пройти OTP.')){sv.disabled=false;return;}
    const {error}=await sb.from('kaspi_settings').update(row).eq('id',1);
    sv.disabled=false;
    if(error){toast('Не сохранено: '+dbErrText(error));return;}
    const q=await kaspiSettingsRow();
    if(q.error||!q.data){toast('Сохранено, но статус не прочитался');return;}
    kaspiCfg=q.data;toast('Сохранено');renderKaspiSettings();
  };
  const otpStart=$('kaspiOtpStart');
  if(otpStart)otpStart.onclick=async()=>{
    otpStart.disabled=true;
    const phone=String(($('kaspiCashier')||{}).value||c.cashier_phone||'');
    const r=await callEdge('kaspi-pay',{action:'bind_start',phone});
    otpStart.disabled=false;
    if(!r||r.error){toast(kaspiErr(r),8000);await kaspiCfgLoad(true);renderKaspiSettings();return;}
    toast(r.description||'Код отправлен в SMS',5000);
    await kaspiCfgLoad(true);renderKaspiSettings();
  };
  const otpConfirm=$('kaspiOtpConfirm');
  if(otpConfirm)otpConfirm.onclick=async()=>{
    const otp=String(($('kaspiOtpCode')||{}).value||'').trim();
    if(!otp){toast('Введите код из SMS');return;}
    otpConfirm.disabled=true;
    const r=await callEdge('kaspi-pay',{action:'bind_confirm',otp});
    otpConfirm.disabled=false;
    if(!r||r.error){toast(kaspiErr(r),8000);await kaspiCfgLoad(true);renderKaspiSettings();return;}
    toast('Кассир привязан'+(r.org_name?': '+r.org_name:''),5000);
    await kaspiCfgLoad(true);renderKaspiSettings();
  };
  const testBtn=$('kaspiTestBtn');
  if(testBtn)testBtn.onclick=async()=>{
    testBtn.disabled=true;
    const r=await callEdge('kaspi-pay',{action:'test'});
    testBtn.disabled=false;
    if(!r||r.error){toast(kaspiErr(r),8000);await kaspiCfgLoad(true);renderKaspiSettings();return;}
    toast(r.message||'Сессия Kaspi активна',5000);
    await kaspiCfgLoad(true);renderKaspiSettings();
  };
  const ub=$('kaspiUnbind');
  if(ub)ub.onclick=async()=>{
    if(!confirm('Сбросить сессию кассира? Для боя понадобится новый OTP.'))return;
    ub.disabled=true;
    const r=await callEdge('kaspi-pay',{action:'unbind'});
    ub.disabled=false;
    if(!r||r.error){toast(kaspiErr(r),8000);return;}
    toast('Сессия сброшена');
    await kaspiCfgLoad(true);renderKaspiSettings();
  };
}
