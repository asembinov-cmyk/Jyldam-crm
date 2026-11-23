/* ================= ПЛАТЕЖИ И ПОДПИСКИ — НАПОМИНАНИЯ В ТЕЛЕГРАМ =================
   Просьба владельца 23.11.2026: «уведомление в телеграм, что платить надо — Supabase,
   Claude, gohost, Anthropic… завтра уже оплата, такая-то сумма».

   Здесь только СПИСОК: что, сколько, когда и за сколько дней напомнить. Сообщение шлёт
   серверная функция pay-reminder раз в сутки в 10:00 по Астане — тем же ботом, что и
   ежедневный отчёт. Браузеру это доверить нельзя: напоминание должно прийти и тогда,
   когда CRM никто не открывал.

   ТОЛЬКО АДМИНИСТРАТОРУ — и в интерфейсе, и правилом базы (pay_reminders_admin):
   в списке суммы расходов компании.

   ДАТА У ПОВТОРЯЮЩЕЙСЯ ЗАПИСИ СДВИГАЕТСЯ САМА на следующий день после оплаты. Это не
   отметка «оплачено»: бот про деньги ничего не знает, он только считает дни. */

const PAY_REPEAT={none:'разово',week:'каждую неделю',month:'каждый месяц',year:'каждый год'};
const PAY_CUR=['₸','$','€','₽'];
let payRows=null;        // null — ещё не читали или не смогли
let payErr='';

function payMoney(r){
  if(r.amount==null||r.amount==='')return '—';
  const n=Number(r.amount);
  const s=(Number.isInteger(n)?String(n):n.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  return s+' '+(r.currency||'₸');
}
// сколько дней до даты — по серверному «сегодня», как всё остальное в CRM
function payDaysLeft(iso){
  if(!iso)return null;
  const t=localToday();
  const num=d=>Math.round(Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10))/86400000);
  return num(iso)-num(t);
}
function payWhen(r){
  const d=payDaysLeft(r.next_date);
  if(d==null)return '<span class="hint" style="margin:0">дата не задана — напоминаний не будет</span>';
  const dt=esc(fmtDate(r.next_date));
  if(d<0)return `<b style="color:var(--rust)">${dt} · просрочено на ${-d} дн.</b>`;
  if(d===0)return `<b style="color:var(--rust)">${dt} · сегодня</b>`;
  if(d===1)return `<b style="color:var(--rust)">${dt} · завтра</b>`;
  if(d<=7)return `<b>${dt}</b> · через ${d} дн.`;
  return `${dt} · через ${d} дн.`;
}

async function payLoad(){
  const {data,error}=await sb.from('pay_reminders').select('*').order('next_date',{ascending:true,nullsFirst:false});
  if(error){payRows=null;payErr=(typeof dbErrText==='function')?dbErrText(error):String(error.message||error);return;}
  payRows=data||[];payErr='';
}

async function renderPayReminders(){
  const box=$('dirContent');if(!box)return;
  if(!isAdmin()){
    box.innerHTML='<div class="panel"><div class="empty">Этот раздел виден только администратору: в нём расходы компании.</div></div>';
    return;
  }
  box.innerHTML='<div class="panel"><div class="empty">Загружаем…</div></div>';
  await payLoad();
  if(S.dir!=='pay'||!$('dirContent'))return;        // пока грузили, человек ушёл в другой раздел
  payDraw();
}

function payDraw(){
  const box=$('dirContent');if(!box)return;
  if(payRows===null){
    box.innerHTML=`<div class="panel"><div class="empty">Не удалось прочитать список: ${esc(payErr||'неизвестная ошибка')}</div></div>`;
    return;
  }
  // итог за месяц считаем отдельно по каждой валюте: складывать тенге с долларами нельзя
  const monthly={};
  payRows.filter(r=>r.active&&r.amount!=null).forEach(r=>{
    const k=r.repeat==='month'?1:r.repeat==='year'?1/12:r.repeat==='week'?52/12:0;
    if(k)monthly[r.currency||'₸']=(monthly[r.currency||'₸']||0)+Number(r.amount)*k;
  });
  const total=Object.keys(monthly).map(c=>Math.round(monthly[c]).toLocaleString('ru-RU')+' '+c).join(' + ');
  const rows=payRows.map(r=>`<tr class="${r.active?'':'pay-off'}" data-payid="${r.id}">
      <td data-label="Что"><strong>${esc(r.name)}</strong>${r.note?`<div class="hint" style="margin:2px 0 0">${esc(r.note)}</div>`:''}</td>
      <td data-label="Сумма" style="white-space:nowrap">${esc(payMoney(r))}</td>
      <td data-label="Когда">${payWhen(r)}</td>
      <td data-label="Повтор">${esc(PAY_REPEAT[r.repeat]||r.repeat)}</td>
      <td data-label="Напомнить">за ${r.remind_days} дн., за день и в день оплаты</td>
      <td data-label="Статус">${r.active?'включено':'<span class="hint" style="margin:0">выключено</span>'}</td>
    </tr>`).join('');
  box.innerHTML=`
    <div class="panel">
      <div class="panel-head" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <h3 style="margin:0;flex:1">Платежи и подписки</h3>
        <button class="btn ghost sm" id="payTest">Прислать список в Телеграм</button>
        <button class="btn primary sm" id="payAdd">＋ Добавить</button>
      </div>
      <p class="hint" style="margin:8px 0 12px">Бот пишет в Телеграм каждый день в 10:00, если до оплаты осталось столько дней,
        сколько задано в «напомнить за», один день или оплата сегодня. После даты повторяющаяся оплата сама
        переносится на следующий период.${total?` В месяц по включённым записям выходит примерно <b>${esc(total)}</b>.`:''}</p>
      <div class="table-scroll"><table class="resp-table">
        <thead><tr><th>Что</th><th>Сумма</th><th>Когда</th><th>Повтор</th><th>Напомнить</th><th>Статус</th></tr></thead>
        <tbody>${rows||'<tr><td colspan="6"><div class="empty">Пока пусто. Нажмите «Добавить» и впишите первую оплату.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
  $('payAdd').onclick=()=>payModal(null);
  $('payTest').onclick=payTestSend;
  box.querySelectorAll('[data-payid]').forEach(tr=>{tr.style.cursor='pointer';tr.onclick=()=>payModal(tr.dataset.payid);});
}

async function payTestSend(){
  const b=$('payTest');if(b)b.disabled=true;
  const r=await callEdge('pay-reminder',{list:true});
  if(b)b.disabled=false;
  if(r&&r.error){toast('Не отправилось: '+r.error,6000);return;}
  if(r&&r.sent)toast('Список отправлен в Телеграм');
  else toast((r&&r.reason)?('Не отправлено: '+r.reason):'Не отправлено',5000);
}

function payModal(id){
  const r=id?(payRows||[]).find(x=>x.id===id):null;
  const c=r||{name:'',amount:'',currency:'₸',next_date:'',repeat:'month',remind_days:3,note:'',active:true};
  const ov=showModal(r?'Оплата':'Новая оплата',`
    <div class="field"><label>Что оплачиваем <span style="color:var(--rust)">*</span></label>
      <input id="pay_name" value="${esc(c.name||'')}" placeholder="например: Supabase, подписка Pro"></div>
    <div style="display:grid;grid-template-columns:1fr 110px;gap:10px;margin-top:10px">
      <div class="field"><label>Сумма</label>
        <input id="pay_amount" inputmode="decimal" value="${c.amount==null?'':esc(String(c.amount))}" placeholder="можно не заполнять"></div>
      <div class="field"><label>Валюта</label>
        <select id="pay_cur">${PAY_CUR.map(v=>`<option ${v===(c.currency||'₸')?'selected':''}>${v}</option>`).join('')}</select></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
      <div class="field"><label>Дата ближайшей оплаты</label>
        <input id="pay_date" type="date" value="${esc(c.next_date||'')}"></div>
      <div class="field"><label>Повтор</label>
        <select id="pay_repeat">${Object.keys(PAY_REPEAT).map(k=>`<option value="${k}" ${k===c.repeat?'selected':''}>${PAY_REPEAT[k]}</option>`).join('')}</select></div>
    </div>
    <div class="field" style="margin-top:10px"><label>Напомнить за сколько дней</label>
      <input id="pay_days" inputmode="numeric" value="${esc(String(c.remind_days==null?3:c.remind_days))}">
      <span class="hint" style="font-size:12px">Кроме этого бот всегда пишет за день до оплаты и в сам день.</span></div>
    <div class="field" style="margin-top:10px"><label>Заметка</label>
      <input id="pay_note" value="${esc(c.note||'')}" placeholder="где платить, с какой карты, номер договора"></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="pay_active" ${c.active!==false?'checked':''}> Напоминать</label>
    ${r?'<button type="button" class="btn ghost sm" id="pay_del" style="margin-top:14px;color:var(--rust)">Удалить запись</button>':''}`,
    async()=>{
      const name=val('pay_name').trim();
      if(!name){toast('Напишите, что оплачиваем');return false;}
      const rawAmt=val('pay_amount').replace(/\s/g,'').replace(',','.');
      const amount=rawAmt===''?null:Number(rawAmt);
      if(amount!==null&&(!isFinite(amount)||amount<0)){toast('Сумма должна быть числом');return false;}
      const days=parseInt(val('pay_days'),10);
      if(!(days>=0&&days<=60)){toast('«Напомнить за» — от 0 до 60 дней');return false;}
      const row={name,amount,currency:val('pay_cur')||'₸',next_date:val('pay_date')||null,
        repeat:val('pay_repeat')||'month',remind_days:days,note:val('pay_note').trim()||null,
        active:$('pay_active').checked,updated_at:new Date(nowMs()).toISOString()};
      const q=r?sb.from('pay_reminders').update(row).eq('id',r.id):sb.from('pay_reminders').insert(row);
      const {error}=await q;
      if(error){toast('Не сохранилось: '+(typeof dbErrText==='function'?dbErrText(error):error.message),6000);return false;}
      await payLoad();payDraw();
      toast('Сохранено');
    },{mid:true});
  const del=ov.querySelector('#pay_del');
  if(del)del.onclick=async()=>{
    if(!confirm(`Удалить «${r.name}» из списка оплат? Напоминания по ней приходить перестанут.`))return;
    const {error}=await sb.from('pay_reminders').delete().eq('id',r.id);
    if(error){toast('Не удалилось: '+error.message,6000);return;}
    ov.remove();if(typeof syncModalOpenClass==='function')syncModalOpenClass();
    await payLoad();payDraw();toast('Удалено');
  };
}
