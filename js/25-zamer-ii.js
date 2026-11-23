/* ================= ЗАМЕР ИИ: насколько точно он читает бланки =================
   Инструмент администратора в «Заполнении». Берёт заказы, которые менеджеры УЖЕ заполнили
   руками, даёт ИИ прочитать их фото заново и сравнивает с тем, что вписал человек.

   В БАЗУ НИЧЕГО НЕ ПИШЕТСЯ. Это замер, а не заполнение: по его цифрам решается, делать ли
   агента, который заполняет заказы сам, и каким полям ему можно доверять.

   ГЛАВНОЕ ЧИСЛО — НЕ «СКОЛЬКО СОВПАЛО», А «СКОЛЬКО РАЗ ИИ БЫЛ УВЕРЕН И ОШИБСЯ». Агент будет
   вписывать сам только то, в чём уверен, а сомнительное отдавать человеку. Значит опасна
   ровно одна клетка: уверен — и неправ. Её и показываем отдельно.

   ОГОВОРКА, КОТОРУЮ НЕЛЬЗЯ ПРЯТАТЬ. «Что вписал человек» — не всегда правда с бланка:
   менеджер мог нажать «Распознать с фото» и оставить как есть. Тогда тот же ИИ, читая то же
   фото, совпадёт сам с собой, и точность выйдет завышенной. Отличить такие заказы нечем —
   поэтому это написано прямо в результате.

   Адрес сравнивается НЕЧЁТКО: «г. Алматы, ул. Абая 5» и «АЛМАТЫ АБАЯ 5» — один адрес. */

const AIB_MODELS = [
  // [id модели, подпись, $ за млн входных, $ за млн выходных]
  ['claude-sonnet-5',  'как сейчас в CRM (Sonnet 5)', 2, 10],
  ['claude-opus-5-5',  'сильнее (Opus 5.5)',          4, 20],
];
const AIB_SIZES    = [30, 100, 200];
const AIB_PARALLEL = 3;        // одновременных обращений к ИИ: больше — упрёмся в лимит частоты
const AIB_IMG_MAX  = 2000;     // длинная сторона фото, px: почерку нужно разрешение
const AIB_FAIL_STOP= 4;        // столько отказов подряд — останавливаемся, дело не в заказе
const AIB_SHOW_BAD = 40;       // сколько расхождений показать на экране (все — в Excel)

let aibRun = null;             // текущий прогон {stop, rows, …}
let aibLastSample = null;      // заказы прошлого прогона — чтобы сравнить модели НА ОДНИХ И ТЕХ ЖЕ
let aibHistory = [];           // итоги прогонов, сделанных в этом окне

const AIB_SYSTEM = 'Ты читаешь фото бланка посылки (Казахстан): текст рукописный или печатный, '
  + 'на русском и казахском. Найди данные ПОЛУЧАТЕЛЯ (не отправителя). Верни СТРОГО один JSON '
  + 'без пояснений и без обрамления: {"client":"ФИО получателя","phone":"телефон получателя, '
  + 'только цифры","address":"адрес получателя одной строкой","index":"почтовый индекс, 6 цифр",'
  + '"conf":{"client":"high|low","phone":"high|low","address":"high|low","index":"high|low"}}. '
  + 'Если поля на бланке нет — пустая строка. conf "low" ставь, когда хотя бы один символ поля '
  + 'читается неуверенно. Ничего не выдумывай: неразборчивое оставь как прочиталось и отметь low.';
const AIB_PROMPT = 'Извлеки данные получателя с этого бланка. Верни только JSON.';

/* ---------- Сравнение ---------- */

function aibNorm(s){
  return String(s||'').toUpperCase().replace(/Ё/g,'Е')
    .replace(/[^0-9A-ZА-ЯӘҒҚҢӨҰҮҺІ]+/g,' ').replace(/\s+/g,' ').trim();
}
function aibLev(a,b){
  if(a===b)return 0;
  if(!a.length)return b.length; if(!b.length)return a.length;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i];
    for(let j=1;j<=b.length;j++){
      cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    prev=cur;
  }
  return prev[b.length];
}
const aibDigits=(s,n)=>{const d=String(s||'').replace(/\D/g,'');return n?d.slice(-n):d;};

// Каждое сравнение отдаёт: ok — совпало, near — почти, bad — не совпало, none — ИИ не прочитал.
function aibCmpPhone(h,a){
  const H=aibDigits(h,10), A=aibDigits(a,10);
  if(H.length<10)return null;           // у человека номера нет — сравнивать не с чем
  if(!A)return 'none';
  return H===A?'ok':'bad';              // «почти» у телефона не бывает: одна цифра — чужой номер
}
// Чем несовпавший телефон отличается от настоящего: 'close' — одной-двумя цифрами на тех же
// местах, 'other' — это другой номер. Для совпавших и непрочитанных — пусто.
function aibPhoneKind(h,a){
  const H=aibDigits(h,10), A=aibDigits(a,10);
  if(H.length<10||!A||H===A)return '';
  if(A.length!==10)return 'other';
  let diff=0; for(let i=0;i<10;i++)if(H[i]!==A[i])diff++;
  return diff<=2?'close':'other';
}
function aibCmpIndex(h,a){
  const H=aibDigits(h), A=aibDigits(a);
  if(H.length!==6)return null;
  if(!A)return 'none';
  return H===A?'ok':'bad';
}
function aibCmpName(h,a){
  const H=aibNorm(h), A=aibNorm(a);
  if(!H)return null;
  if(!A)return 'none';
  if(H===A)return 'ok';
  const ht=H.split(' ').sort(), at=A.split(' ').sort();
  if(ht.join(' ')===at.join(' '))return 'ok';                  // те же слова в другом порядке
  // «Почти»: одна-две буквы на всё ФИО. Для бланка это ещё читаемо, но вписывать самому нельзя.
  if(aibLev(H,A)<=2)return 'near';
  return 'bad';
}
/* Адрес: сравниваем наборы слов, а не строки. Служебные слова (г, ул, д, кв…) выбрасываем —
   один менеджер их пишет, другой нет. Числа важнее слов: дом и квартира должны совпасть. */
const AIB_ADDR_NOISE=new Set(['Г','ГОР','ГОРОД','УЛ','УЛИЦА','Д','ДОМ','КВ','КВАРТИРА','ОБЛ','ОБЛАСТЬ',
  'Р','РН','РАЙОН','С','СЕЛО','АУЛ','АУЫЛ','П','ПОС','ПОСЕЛОК','МКР','МИКРОРАЙОН','ПР','ПРОСПЕКТ',
  'КӨШЕСІ','КОШЕСИ','ҚАЛАСЫ','КАЛАСЫ','ОБЛЫСЫ','АУДАНЫ','ҮЙ','УЙ','ПӘТЕР','ПАТЕР','К','КОРПУС']);
function aibAddrTokens(s){return aibNorm(s).split(' ').filter(t=>t&&!AIB_ADDR_NOISE.has(t));}
function aibCmpAddr(h,a){
  const H=aibAddrTokens(h), A=aibAddrTokens(a);
  if(!H.length)return null;
  if(!A.length)return 'none';
  const hs=new Set(H), as=new Set(A);
  let common=0; hs.forEach(t=>{if(as.has(t))common++;});
  const score=common/Math.max(hs.size,as.size);
  const nums=x=>[...x].filter(t=>/\d/.test(t)).sort().join(' ');
  const numsSame=nums(hs)===nums(as);
  if(score>=0.8&&numsSame)return 'ok';
  if(score>=0.5)return 'near';
  return 'bad';
}

/* ---------- Чтение одного бланка ---------- */

// Фото уменьшаем до AIB_IMG_MAX по длинной стороне: оригинал с телефона — несколько мегабайт,
// а ИИ его всё равно уменьшит. Меньше 2000 px почерк начинает терять штрихи.
async function aibImageB64(blob){
  const url=URL.createObjectURL(blob);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('фото не открылось'));i.src=url;});
    const k=Math.min(1,AIB_IMG_MAX/Math.max(img.naturalWidth,img.naturalHeight));
    const w=Math.max(1,Math.round(img.naturalWidth*k)), h=Math.max(1,Math.round(img.naturalHeight*k));
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    return {b64:c.toDataURL('image/jpeg',0.85).split(',')[1],w,h};
  }finally{URL.revokeObjectURL(url);}
}

function aibParse(text){
  const t=String(text||'');
  const i=t.indexOf('{'), j=t.lastIndexOf('}');
  if(i<0||j<=i)return null;
  try{return JSON.parse(t.slice(i,j+1));}catch(e){return null;}
}

async function aibReadOne(o,model){
  const ph=Array.isArray(o.photos)?o.photos:[];
  const url=await signedPhotoUrl(ph[0]);
  if(!url)return {error:'нет ссылки на фото'};
  let img;
  try{const resp=await fetch(url);if(!resp.ok)return {error:'фото не скачалось ('+resp.status+')'};img=await aibImageB64(await resp.blob());}
  catch(e){return {error:String(e&&e.message||e)};}
  // max_tokens с запасом: у новых моделей размышление считается в тот же предел, и на 400
  // ответ обрывался бы посреди JSON.
  const r=await callAI({system:AIB_SYSTEM,prompt:AIB_PROMPT,image:{media_type:'image/jpeg',data:img.b64},model,max_tokens:2000});
  if(r.error)return {error:String(r.error),api:true};
  const data=aibParse(r.text);
  if(!data)return {error:'ответ ИИ не разобрался',usage:r.usage||null,img};
  return {data,usage:r.usage||null,img,url};
}

/* ---------- Выборка ---------- */

async function aibSample(n){
  // Берём с запасом и отбираем на месте: фото есть, ФИО есть, заполнял человек (не загрузка
  // из Excel), не Барахолка. Звёздочка здесь допустима — строк сотни, а не вся таблица.
  const {data,error}=await sb.from('orders').select('*').not('filled_at','is',null)
    .order('filled_at',{ascending:false}).limit(Math.min(1000,n*5));
  if(error)throw new Error(/filled_at/.test(String(error.message))?'В базе нет учёта заполнения (db/11) — брать заказы неоткуда':String(error.message||error));
  const pool=(data||[]).filter(o=>Array.isArray(o.photos)&&o.photos.length
    &&String(o.client||'').trim()&&!/из\s*excel/i.test(String(o.filled_by_name||''))
    &&!isBaraholkaOrder(o));
  // Случайные из отобранных, а не первые подряд: иначе вся выборка — один менеджер за один час.
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,n);
}

/* Повторные получатели: был ли этот телефон в БОЛЕЕ РАННИХ заказах и совпало ли там ФИО.
   Это отдельный вопрос от чтения: постоянного клиента можно не читать, а узнавать. */
async function aibRepeatCheck(sample){
  const keys=[...new Set(sample.map(o=>aibDigits(o.phone,10)).filter(k=>k.length===10))];
  const found=new Map();   // phone10 → [{id,client,created_at}]
  for(let i=0;i<keys.length;i+=25){
    const part=keys.slice(i,i+25);
    const variants=[];part.forEach(k=>variants.push(k,'7'+k,'8'+k,'+7'+k));
    const {data,error}=await sb.from('orders').select('id,phone,client,created_at').in('phone',variants).limit(2000);
    if(error)return null;
    (data||[]).forEach(r=>{const k=aibDigits(r.phone,10);if(!found.has(k))found.set(k,[]);found.get(k).push(r);});
  }
  let had=0,same=0;
  sample.forEach(o=>{
    const k=aibDigits(o.phone,10);
    const earlier=(found.get(k)||[]).filter(r=>r.id!==o.id&&String(r.client||'').trim()&&r.created_at<o.created_at);
    if(!earlier.length)return;
    had++;
    if(earlier.some(r=>{const c=aibCmpName(o.client,r.client);return c==='ok';}))same++;
  });
  return {had,same,total:sample.length};
}

/* ---------- Прогон ---------- */

async function aibStart(n,model){
  const run={stop:false,model,n,rows:[],done:0,fails:0,failStreak:0,lastErr:'',usageIn:0,usageOut:0,usageSeen:false,px:0,repeat:null,state:'sample'};
  aibRun=run;aibDraw();
  let sample;
  // «Те же заказы» — единственный честный способ сравнить две модели: тридцать случайных
  // бланков от прогона к прогону разные, и разница в почерке больше разницы в моделях.
  if(n==='same'&&aibLastSample){sample=aibLastSample;run.same=true;}
  else{
    try{sample=await aibSample(n);}
    catch(e){run.state='error';run.lastErr=String(e&&e.message||e);aibDraw();return;}
  }
  aibLastSample=sample;
  if(!sample.length){run.state='error';run.lastErr='Не нашлось заполненных вручную заказов с фото';aibDraw();return;}
  run.total=sample.length;run.state='run';aibDraw();
  aibRepeatCheck(sample).then(r=>{run.repeat=r;aibDraw();}).catch(()=>{});
  let next=0;
  const worker=async()=>{
    while(!run.stop&&next<sample.length){
      const o=sample[next++];
      const r=await aibReadOne(o,model);
      if(run.stop)return;
      run.done++;
      if(r.usage){run.usageSeen=true;run.usageIn+=(r.usage.input_tokens||0);run.usageOut+=(r.usage.output_tokens||0);}
      if(r.img)run.px+=r.img.w*r.img.h;
      if(r.error){
        run.fails++;run.lastErr=r.error;
        run.failStreak=r.api?run.failStreak+1:run.failStreak;
        // Несколько отказов ИИ подряд — это не «плохое фото», а общая причина (модель не
        // принята, кончился лимит). Гнать дальше значит платить за одни ошибки.
        if(run.failStreak>=AIB_FAIL_STOP){run.stop=true;run.state='aborted';}
      }else{
        run.failStreak=0;
        const d=r.data, cf=(d.conf&&typeof d.conf==='object')?d.conf:{};
        run.rows.push({o,ai:d,url:r.url,
          cmp:{client:aibCmpName(o.client,d.client),phone:aibCmpPhone(o.phone,d.phone),
               // У заказа с индексом в поле адреса стоит адрес ОТДЕЛЕНИЯ, подставленный CRM по
               // индексу (раздел 6f), а не то, что написано на бланке. Сравнивать с ним чтение
               // бланка — яблоки с грушами; первый же живой замер показал это на адресе
               // «с. Актобе, Алматы район…» против прочитанного с бланка. Поэтому не сравниваем.
               address:aibDigits(o.index).length===6?null:aibCmpAddr(o.address,d.address),
               index:aibCmpIndex(o.index,d.index)},
          // Несовпавший телефон бывает двух видов, и лечатся они по-разному: одна-две цифры —
          // почерк; совсем другой номер — ИИ взял не тот телефон с бланка (отправителя).
          phoneKind:aibPhoneKind(o.phone,d.phone),
          conf:{client:cf.client==='high',phone:cf.phone==='high',address:cf.address==='high',index:cf.index==='high'}});
      }
      aibDraw();
    }
  };
  await Promise.all(Array.from({length:AIB_PARALLEL},worker));
  if(aibRun===run&&run.state==='run')run.state=run.stop?'stopped':'done';
  if(run.rows.length){
    const S1=aibStats(run);
    aibHistory.push({model:run.model,n:S1.n,same:!!run.same,
      pct:AIB_FIELDS.map(([k])=>S1.st[k].n?Math.round(S1.st[k].ok/S1.st[k].n*100)+'%':'—'),
      sureOk:S1.allSureOk,sureBad:S1.allSureBad});
  }
  aibDraw();
}

/* ---------- Итоги ---------- */

const AIB_FIELDS=[['phone','Телефон'],['client','ФИО'],['address','Адрес'],['index','Индекс']];

function aibStats(run){
  const st={};
  AIB_FIELDS.forEach(([k])=>{st[k]={n:0,ok:0,near:0,bad:0,none:0,sure:0,sureOk:0,sureBad:0};});
  let allSureOk=0,allSureBad=0,someLow=0;
  run.rows.forEach(r=>{
    let sureAll=true,okAll=true,any=false;
    AIB_FIELDS.forEach(([k])=>{
      const c=r.cmp[k]; if(c===null)return;   // у человека поля нет — в счёт не идёт
      any=true;
      const s=st[k]; s.n++; s[c]++;
      if(r.conf[k]&&c!=='none'){s.sure++;if(c==='ok')s.sureOk++;else s.sureBad++;}
      if(!(r.conf[k]&&c!=='none'))sureAll=false;
      if(c!=='ok')okAll=false;
    });
    if(!any)return;
    if(sureAll&&okAll)allSureOk++;
    else if(sureAll)allSureBad++;
    else someLow++;
  });
  return {st,allSureOk,allSureBad,someLow,n:run.rows.length};
}
const aibPct=(a,b)=>b?Math.round(a/b*100)+'%':'—';

function aibCostText(run){
  const m=AIB_MODELS.find(x=>x[0]===run.model)||AIB_MODELS[0];
  if(run.usageSeen){
    const usd=run.usageIn/1e6*m[2]+run.usageOut/1e6*m[3];
    return `Расход на этот прогон: $${usd.toFixed(2)} (${run.usageIn.toLocaleString('ru-RU')} входных и ${run.usageOut.toLocaleString('ru-RU')} выходных токенов).`;
  }
  // Прокси не вернул расход — считаем грубо: картинка ≈ пиксели/750 токенов плюс запрос и ответ.
  const tin=run.px/750+run.done*400, tout=run.done*250;
  const usd=tin/1e6*m[2]+tout/1e6*m[3];
  return `Расход — ОЦЕНКА, сервер ИИ точных цифр не вернул: около $${usd.toFixed(2)} за этот прогон. Точно — в кабинете Anthropic.`;
}

function aibResultHtml(run){
  const S0=aibStats(run);
  if(!S0.n)return '';
  const rows=AIB_FIELDS.map(([k,l])=>{
    const s=S0.st[k];
    return `<tr><td data-label="Поле"><b>${l}</b></td><td data-label="Сравнили">${s.n}</td>
      <td data-label="Совпало" style="color:#16a34a"><b>${s.ok}</b> · ${aibPct(s.ok,s.n)}</td>
      <td data-label="Почти">${s.near||'—'}</td>
      <td data-label="Не совпало" style="color:#dc2626">${s.bad||'—'}</td>
      <td data-label="ИИ не прочитал">${s.none||'—'}</td>
      <td data-label="Уверен и верно">${s.sure?`${s.sureOk} из ${s.sure} · ${aibPct(s.sureOk,s.sure)}`:'—'}</td>
      <td data-label="Уверен и ошибся" style="color:${s.sureBad?'#dc2626':'inherit'}"><b>${s.sureBad}</b></td></tr>`;
  }).join('');
  const rep=run.repeat;
  const pClose=run.rows.filter(r=>r.phoneKind==='close').length, pOther=run.rows.filter(r=>r.phoneKind==='other').length;
  const phoneNote=(pClose+pOther)?`<b>Несовпавшие телефоны (${pClose+pOther}):</b> отличаются одной-двумя цифрами — ${pClose}
      (это почерк), совсем другой номер — ${pOther} (ИИ взял с бланка не тот телефон, например отправителя).<br>`:'';
  const hist=aibHistory.length>1?`<h3 style="margin:16px 0 6px;font-size:15px">Прогоны в этом окне</h3>
    <div class="table-scroll"><table class="resp-table"><thead><tr><th>Модель</th><th>Заказов</th>${AIB_FIELDS.map(f=>`<th>${f[1]}</th>`).join('')}
      <th>Уверен и верно</th><th>Уверен и ошибся</th></tr></thead><tbody>${aibHistory.map(h=>`<tr>
      <td data-label="Модель">${esc((AIB_MODELS.find(m=>m[0]===h.model)||[h.model,h.model])[1])}</td>
      <td data-label="Заказов">${h.n}${h.same?' · те же':''}</td>
      ${h.pct.map((p,i)=>`<td data-label="${AIB_FIELDS[i][1]}">${p}</td>`).join('')}
      <td data-label="Уверен и верно">${h.sureOk}</td><td data-label="Уверен и ошибся">${h.sureBad}</td></tr>`).join('')}</tbody></table></div>
    <div class="hint" style="margin:6px 0 0">Сравнивать модели можно только по строкам «те же»: случайные заказы каждый раз разные.</div>`:'';
  const bad=run.rows.filter(r=>AIB_FIELDS.some(([k])=>r.cmp[k]==='bad'||r.cmp[k]==='near'||r.cmp[k]==='none'));
  const cell=(r,k,h,a)=>{
    const c=r.cmp[k]; if(c===null||c==='ok')return '';
    const col=c==='bad'?'#dc2626':(c==='near'?'#b45309':'#6b7280');
    return `<div style="margin:2px 0"><span class="hint" style="margin:0">${AIB_FIELDS.find(x=>x[0]===k)[1]}${r.conf[k]?' · ИИ уверен':''}:</span>
      человек <b>${esc(String(h||'—'))}</b> · ИИ <b style="color:${col}">${esc(String(a||'не прочитал'))}</b></div>`;
  };
  return `
    <div class="wam-stats" style="padding:6px 0 10px">
      <div class="wam-st"><b style="color:#16a34a">${S0.allSureOk}</b><span>ИИ уверен во всём и всё верно — ${aibPct(S0.allSureOk,S0.n)}</span></div>
      <div class="wam-st"><b style="color:#dc2626">${S0.allSureBad}</b><span>уверен во всём, но ошибся — ${aibPct(S0.allSureBad,S0.n)}</span></div>
      <div class="wam-st"><b style="color:#b45309">${S0.someLow}</b><span>в чём-то не уверен — отдал бы человеку</span></div>
    </div>
    <div class="hint" style="margin:0 0 10px">Первое число — заказы, которые агент заполнил бы сам и правильно. Второе — самое
      важное: столько ошибок ушло бы в заказы незамеченными. Третье — работа, которая осталась бы менеджерам.</div>
    <div class="table-scroll"><table class="resp-table"><thead><tr>
      <th>Поле</th><th>Сравнили</th><th>Совпало</th><th>Почти</th><th>Не совпало</th><th>ИИ не прочитал</th>
      <th>Уверен и верно</th><th>Уверен и ошибся</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="hint" style="margin:10px 0 0">
      ${phoneNote}${rep?`<b>Повторные получатели:</b> у ${rep.had} из ${rep.total} заказов этот телефон уже был в более ранних заказах
        (${aibPct(rep.had,rep.total)}), и у ${rep.same} из них ФИО там совпало с тем, что вписал менеджер. Таких можно не читать, а узнавать по номеру.<br>`:''}
      <b>Оговорка.</b> «Человек» здесь — то, что стоит в заказе. Если менеджер нажал «Распознать с фото» и ничего не поправил,
      ИИ совпадает сам с собой, и точность получается завышенной. Адрес сравнивается нечётко, по словам и числам, и
      только у заказов БЕЗ индекса: у почтовых CRM подставляет в адрес адрес отделения, а не написанное на бланке.<br>
      ${esc(aibCostText(run))}
    </div>
    ${hist}
    ${bad.length?`<h3 style="margin:16px 0 6px;font-size:15px">Расхождения — ${bad.length}${bad.length>AIB_SHOW_BAD?` (показаны первые ${AIB_SHOW_BAD}, все — в Excel)`:''}</h3>
      <div class="table-scroll"><table class="resp-table"><thead><tr><th>Заказ</th><th>Что разошлось</th><th></th></tr></thead><tbody>
      ${bad.slice(0,AIB_SHOW_BAD).map(r=>`<tr>
        <td data-label="Заказ">${esc(r.o.code||'')}<div class="hint" style="margin:2px 0 0">${esc(r.o.filled_by_name||'')}</div></td>
        <td data-label="Что разошлось">${cell(r,'phone',phoneDisplay(r.o.phone),r.ai.phone)}${cell(r,'client',r.o.client,r.ai.client)}${cell(r,'address',r.o.address,r.ai.address)}${cell(r,'index',r.o.index,r.ai.index)}</td>
        <td data-label="">${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">фото</a>`:''}</td>
      </tr>`).join('')}</tbody></table></div>`:''}`;
}

function aibExport(run){
  if(typeof XLSX==='undefined'){toast('Выгрузка недоступна: не загрузилась библиотека Excel');return;}
  const RU={ok:'совпало',near:'почти',bad:'НЕ совпало',none:'ИИ не прочитал'};
  const head=['Заказ','Заполнил','Телефон (человек)','Телефон (ИИ)','Телефон: итог','ИИ уверен',
    'ФИО (человек)','ФИО (ИИ)','ФИО: итог','ИИ уверен','Адрес (человек)','Адрес (ИИ)','Адрес: итог','ИИ уверен',
    'Индекс (человек)','Индекс (ИИ)','Индекс: итог','ИИ уверен'];
  const f=(r,k,h,a)=>[String(h||''),String(a||''),r.cmp[k]===null?'у человека пусто':(RU[r.cmp[k]]||''),r.conf[k]?'да':'нет'];
  const body=run.rows.map(r=>[r.o.code||'',r.o.filled_by_name||'']
    .concat(f(r,'phone',aibDigits(r.o.phone,10),aibDigits(r.ai.phone,10)),f(r,'client',r.o.client,r.ai.client),
            f(r,'address',r.o.address,r.ai.address),f(r,'index',r.o.index,r.ai.index)));
  const ws=XLSX.utils.aoa_to_sheet([head].concat(body));
  if(typeof xlsxAutoCols==='function')xlsxAutoCols(ws);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Замер ИИ');
  XLSX.writeFile(wb,`Замер ИИ ${localToday()} ${run.model}.xlsx`);
}

/* ---------- Окно ---------- */

function aibDraw(){
  const box=document.getElementById('aibBox');
  if(!box)return;
  const run=aibRun;
  const busy=run&&(run.state==='sample'||run.state==='run');
  const sel=(id,opts,cur)=>`<select id="${id}" ${busy?'disabled':''}>${opts.map(([v,l])=>`<option value="${esc(String(v))}"${String(cur)===String(v)?' selected':''}>${esc(l)}</option>`).join('')}</select>`;
  const curN=aibLastSample?'same':(run?run.n:AIB_SIZES[0]), curM=run?run.model:AIB_MODELS[0][0];
  let status='';
  if(run){
    if(run.state==='sample')status='Подбираю заполненные заказы…';
    else if(run.state==='error')status=`<span style="color:#dc2626">${esc(run.lastErr)}</span>`;
    else{
      const tail=run.fails?` · не удалось прочитать: ${run.fails}${run.lastErr?` (последняя причина: ${esc(run.lastErr)})`:''}`:'';
      if(run.state==='run')status=`Прочитано ${run.done} из ${run.total}${tail}`;
      else if(run.state==='done')status=`Готово: ${run.done} из ${run.total}${tail}`;
      else if(run.state==='stopped')status=`Остановлено на ${run.done} из ${run.total}${tail}`;
      else if(run.state==='aborted')status=`<span style="color:#dc2626">Остановлено: ИИ отказал ${AIB_FAIL_STOP} раза подряд — ${esc(run.lastErr)}. Если выбрана модель «сильнее», сервер ИИ её, возможно, не принимает.</span>`;
    }
  }
  box.innerHTML=`
    <div class="hint" style="margin:0 0 12px">ИИ заново читает фото заказов, которые менеджеры уже заполнили, и результат сравнивается
      с тем, что вписал человек. <b>В заказы ничего не записывается.</b> Обращения к ИИ платные — начните с ${AIB_SIZES[0]} заказов.</div>
    <div class="filters" style="margin:0 0 12px">
      ${sel('aibN',(aibLastSample?[['same','те же '+aibLastSample.length+' заказов']]:[]).concat(AIB_SIZES.map(n=>[n,n+' новых заказов'])),curN)}
      ${sel('aibModel',AIB_MODELS.map(m=>[m[0],'Модель: '+m[1]]),curM)}
      ${busy?'<button class="btn ghost" id="aibStop" type="button">Остановить</button>'
            :'<button class="btn primary" id="aibGo" type="button">Запустить замер</button>'}
      ${run&&run.rows.length&&!busy?'<button class="btn ghost" id="aibXls" type="button">⬇ Excel</button>':''}
    </div>
    ${status?`<div class="hint" style="margin:0 0 12px">${status}</div>`:''}
    ${run?aibResultHtml(run):''}`;
  const go=document.getElementById('aibGo');
  if(go)go.onclick=()=>{
    const raw=document.getElementById('aibN').value;
    const n=raw==='same'?'same':(parseInt(raw,10)||AIB_SIZES[0]);
    const model=document.getElementById('aibModel').value;
    const cnt=n==='same'?(aibLastSample||[]).length:n;
    if(cnt>AIB_SIZES[0]&&!confirm(`Прочитать ${cnt} бланков? Каждое обращение к ИИ платное.`))return;
    aibStart(n,model);
  };
  const stop=document.getElementById('aibStop');
  if(stop)stop.onclick=()=>{if(aibRun){aibRun.stop=true;aibRun.state='stopped';aibDraw();}};
  const xls=document.getElementById('aibXls');
  if(xls)xls.onclick=()=>aibExport(aibRun);
}

function aiBenchModal(){
  if(!isAdmin()){toast('Замер доступен только администратору');return;}
  const ov=showInfo('Замер ИИ: как он читает бланки','<div id="aibBox"></div>',{wide:true});
  aibDraw();
  // Закрыли окно — прогон останавливается: иначе он дочитывал бы бланки за деньги, а смотреть
  // на результат уже некому. Следим за самим узлом: способов закрыть окно несколько.
  const mo=new MutationObserver(()=>{
    if(!document.body.contains(ov)){mo.disconnect();if(aibRun&&aibRun.state==='run'){aibRun.stop=true;aibRun.state='stopped';}}
  });
  mo.observe(document.body,{childList:true});
}
