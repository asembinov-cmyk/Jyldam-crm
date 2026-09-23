
/* ================= МОДУЛЬ: ПОЛЬЗОВАТЕЛИ И РОЛИ ================= */
const MODULES=[
  ['dashboard','Дашборд'],
  ['pickups','Заявки на забор'],
  ['orders','Заказы заборов'],
  ['filling','Заполнение'],
  ['ket_orders','Заказы партнёров'],
  ['courier','Курьерская доставка'],
  ['mail','Почтовая доставка'],
  ['intercity','Отправки межгород'],
  ['cash','Склад'],
  ['sorting','Сортировка'],
  ['finance','Финансы'],
  ['calc','Калькуляция'],
  ['partners','Партнёры'],
  ['history','История изменений'],
  ['notify','Центр контроля'],
  ['directories','Настройки (справочники)'],
  ['users','Сотрудники'],
];
const ACTIONS=[['view','Просмотр'],['create','Создание'],['edit','Редактирование'],['delete','Удаление']];
let usersSub='staff'; // staff | roles

function roleName(id){const r=S.roles.find(x=>x.id===id);return r?r.name:'—';}

function renderUsers(){
  if(!can('users','view')){$('main').innerHTML='<div class="empty"><div class="big">Нет доступа к этому разделу</div></div>';return;}
  $('main').innerHTML=`
    <div class="page-head"><div><h1>Пользователи</h1><p>Сотрудники и роли с правами доступа</p></div></div>
    <div class="subtabs">
      <button data-us="staff" class="${usersSub==='staff'?'active':''}">Сотрудники</button>
      <button data-us="roles" class="${usersSub==='roles'?'active':''}">Роли и права</button>
    </div>
    <div id="usersContent"></div>`;
  $('main').querySelectorAll('[data-us]').forEach(b=>b.onclick=()=>{usersSub=b.dataset.us;saveNav();renderUsers();});
  if(usersSub==='roles') renderRoles(); else renderStaff();
}

/* ---- СОТРУДНИКИ ---- */
let staffFilters={name:'',login:'',city:'',position:'',role:''};
function renderStaff(){
  const f=staffFilters;
  const all=[...S.profiles].sort((a,b)=>(a.full_name||a.email||'').localeCompare(b.full_name||b.email||''));
  // текстовые представления граф для фильтрации
  const rowText=u=>({
    name:u.full_name||'',
    login:u.phone?phoneDisplay(u.phone):((u.email&&!u.email.endsWith('@jyldam.local'))?u.email:''),
    city:u.city_id?cityName(u.city_id):'',
    position:u.position||'',
    role:u.role_id?roleName(u.role_id):(ROLE_LABEL[u.role]||u.role||''),
  });
  const rows=all.filter(u=>{
    const t=rowText(u);
    if(f.name&&!t.name.toLowerCase().includes(f.name.toLowerCase()))return false;
    if(f.login&&!t.login.toLowerCase().includes(f.login.toLowerCase()))return false;
    if(f.city&&t.city!==f.city)return false;
    if(f.position&&!t.position.toLowerCase().includes(f.position.toLowerCase()))return false;
    if(f.role&&t.role!==f.role)return false;
    return true;
  });
  // опции для select-фильтров (город, роль) — из всех строк
  const cityVals=[...new Set(all.map(u=>u.city_id?cityName(u.city_id):'').filter(Boolean))].sort();
  const roleVals=[...new Set(all.map(u=>u.role_id?roleName(u.role_id):(ROLE_LABEL[u.role]||u.role||'')).filter(Boolean))].sort();
  const anyF=f.name||f.login||f.city||f.position||f.role;
  $('usersContent').innerHTML=`<div class="panel">
    <div class="panel-head"><h2>Сотрудники</h2><span class="count">${anyF?rows.length+' / '+all.length:all.length}</span>
      ${can('users','create')?`<button class="btn primary sm" id="addStaff" style="margin-left:auto">＋ Добавить сотрудника</button>`:''}</div>
    <div class="filters" style="background:var(--card);border-bottom:1px solid var(--line)">
      <span style="font-size:13px;color:var(--muted)">«Добавить сотрудника» создаёт аккаунт с логином и паролем — сотрудник сразу сможет войти.</span>
    </div>
    <div class="table-scroll" id="staffTable"><table><thead>
      <tr><th>ФИО</th><th>Логин (телефон)</th><th>Город</th><th>Должность</th><th>Роль</th><th></th></tr>
      <tr class="filter-row staff-fr">
        <th><input class="staff-filter" data-sf="name" placeholder="фильтр…" value="${esc(f.name)}"></th>
        <th><input class="staff-filter" data-sf="login" placeholder="фильтр…" value="${esc(f.login)}"></th>
        <th><select class="staff-filter" data-sf="city"><option value="">Все</option>${cityVals.map(v=>`<option value="${esc(v)}" ${f.city===v?'selected':''}>${esc(v)}</option>`).join('')}</select></th>
        <th><input class="staff-filter" data-sf="position" placeholder="фильтр…" value="${esc(f.position)}"></th>
        <th><select class="staff-filter" data-sf="role"><option value="">Все</option>${roleVals.map(v=>`<option value="${esc(v)}" ${f.role===v?'selected':''}>${esc(v)}</option>`).join('')}</select></th>
        <th></th></tr>
    </thead>
    <tbody>${rows.length?rows.map(u=>`<tr>
      <td><strong>${esc(u.full_name||'—')}</strong></td>
      <td>${u.phone?phoneLink(u.phone):(u.email&&!u.email.endsWith('@jyldam.local')?esc(u.email):'—')}</td>
      <td>${u.city_id?esc(cityName(u.city_id)):'—'}</td>
      <td>${esc(u.position)||'—'}</td>
      <td><span class="pill ${(S.roles.find(r=>r.id===u.role_id)||{}).base_type==='admin'?'gold':'moss'}">${esc(u.role_id?roleName(u.role_id):(ROLE_LABEL[u.role]||u.role||'—'))}</span></td>
      <td><div class="row-actions">
        ${can('users','edit')?`<button class="btn sm ghost" data-uedit="${u.id}">Изменить</button>`:''}
        ${can('users','edit')&&(isAdmin()||(S.roles.find(r=>r.id===u.role_id)||{}).base_type==='courier')?`<button class="btn sm ghost" data-upass="${u.id}">Пароль</button>`:''}
        ${can('users','delete')&&u.id!==S.me.id?`<button class="btn sm danger" data-udel="${u.id}">Удалить</button>`:''}
      </div></td></tr>`).join(''):`<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Ничего не найдено</td></tr>`}</tbody></table></div></div>`;
  $('usersContent').querySelectorAll('[data-uedit]').forEach(b=>b.onclick=()=>staffModal(b.dataset.uedit));
  $('usersContent').querySelectorAll('[data-upass]').forEach(b=>b.onclick=()=>changePassModal(b.dataset.upass));
  $('usersContent').querySelectorAll('[data-udel]').forEach(b=>b.onclick=()=>delStaff(b.dataset.udel));
  if($('addStaff'))$('addStaff').onclick=()=>createStaffModal();
  // фильтры
  $('usersContent').querySelectorAll('.staff-filter').forEach(el=>{
    const ev=el.tagName==='SELECT'?'onchange':'oninput';
    el[ev]=()=>{staffFilters[el.dataset.sf]=el.value;
      const act=document.activeElement;const sf=act&&act.dataset?act.dataset.sf:null;const pos=act&&act.selectionStart;
      renderStaff();
      if(sf){const e2=$('usersContent').querySelector(`.staff-filter[data-sf="${sf}"]`);if(e2){e2.focus();try{e2.setSelectionRange(pos,pos);}catch(e){}}}
    };
  });
}
function createStaffModal(){
  // не-админ с правом «Сотрудники» может создавать только курьеров — на выбор только курьерские роли
  const roleOptions=isAdmin()?S.roles:S.roles.filter(r=>r.base_type==='courier');
  if(!isAdmin()&&!roleOptions.length){toast('Нет ни одной роли с типом «Курьер» — создайте её в Роли и права');return;}
  showModal('Новый сотрудник',`
    <div class="grid2">
      <div class="field"><label>ФИО</label><input id="n_name" placeholder="Фамилия Имя"></div>
      <div class="field"><label>Должность</label><input id="n_pos" placeholder="Напр. Оператор"></div>
      <div class="field"><label>Телефон (логин)</label><input id="n_phone" inputmode="numeric"></div>
      <div class="field"><label>Пароль</label><input id="n_pass" type="text" autocomplete="off" placeholder="мин. 6 символов"></div>
      <div class="field"><label>Роль</label><select id="n_role">${isAdmin()?'<option value="">— не назначена —</option>':''}${roleOptions.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>
        ${!isAdmin()?'<span class="hint">Доступны только курьерские роли</span>':''}</div>
      <div class="field" id="n_kind_field" style="display:none"><label>Тип курьера</label><select id="n_kind">
        <option value="pickup">Курьер заборщик</option>
        <option value="order">Курьер по заказам</option></select>
        <span class="hint">Определяет, в каком справочнике курьеров появится этот аккаунт для привязки.</span></div>
      <div class="field full"><span class="hint">Сотрудник входит по номеру телефона и паролю. Пароль задаёте вы и передаёте ему.</span></div>
    </div>`,
    async()=>{
      const phone=phoneVal('n_phone'),pass=val('n_pass'),name=val('n_name').trim();
      if(phone.length!==10){toast('Телефон: ровно 10 цифр');return false;}
      if(!pass||pass.length<6){toast('Пароль минимум 6 символов');return false;}
      const roleId=val('n_role');
      const baseType=(S.roles.find(r=>r.id===roleId)||{}).base_type||'';
      if(!isAdmin()&&baseType!=='courier'){toast('Можно создавать только курьеров');return false;}
      const legacy=baseType==='admin'?'admin':baseType==='courier'?'courier':'manager';
      const courier_kind=baseType==='courier'?val('n_kind'):null;
      toast('Создаём сотрудника…');
      const out=await callCreateUser({phone,password:pass,full_name:name,
        position:val('n_pos').trim(),role_id:roleId||null,role:legacy,courier_kind});
      if(out.error){toast('Ошибка: '+out.error);return false;}
      await logAction('create','profiles',{entity_label:name||phone,meta:{phone}});
      S.profiles=await dbList('profiles',{order:'created_at',asc:true});
      toast('Сотрудник создан');renderUsers();return true;
    });
  attachPhone('n_phone','');
  // показываем «Тип курьера» только когда выбрана роль с базовым типом «Курьер»
  const nr=$('n_role');const toggleKind=()=>{const bt=(S.roles.find(r=>r.id===nr.value)||{}).base_type;
    $('n_kind_field').style.display=bt==='courier'?'':'none';};
  nr.onchange=toggleKind;toggleKind();
}
// модалка смены пароля сотрудника
function changePassModal(id){
  const u=S.profiles.find(x=>x.id===id);if(!u)return;
  const targetIsCourier=(S.roles.find(r=>r.id===u.role_id)||{}).base_type==='courier';
  if(!isAdmin()&&!targetIsCourier){toast('Менять пароль можно только курьерам');return;}
  const login=u.phone?phoneDisplay(u.phone):((u.email&&!u.email.endsWith('@jyldam.local'))?u.email:'(нет)');
  showModal(`Пароль · ${esc(u.full_name||login)}`,`
    <div class="grid2">
      <div class="field full"><label>Логин (телефон)</label><input value="${esc(login)}" readonly></div>
      <div class="field full"><label>Новый пароль</label><input id="cp_pass" type="text" autocomplete="off" placeholder="мин. 6 символов"></div>
      <div class="field full"><span class="hint">Пароль нельзя «посмотреть» — он хранится в зашифрованном виде. Здесь можно задать новый и передать его сотруднику. Старый перестанет действовать.</span></div>
    </div>`,
    async()=>{
      const pass=val('cp_pass');
      if(!pass||pass.length<6){toast('Пароль минимум 6 символов');return false;}
      toast('Меняем пароль…');
      const out=await callSetPassword({user_id:u.id,password:pass});
      if(out.error){alert('Не удалось сменить пароль:\n\n'+out.error);return false;}
      await logAction('update','profiles',{entity_id:u.id,entity_label:u.full_name||login,changes:[{field:'password',label:'Пароль',old:'•••',new:'изменён'}]});
      toast('Пароль изменён');return true;
    });
}
async function delStaff(id){
  const u=S.profiles.find(x=>x.id===id);
  if(!confirm(`Удалить сотрудника «${u?.full_name||u?.email||''}»?\n\nБудут удалены и карточка, и учётная запись входа — номер телефона/email после этого можно будет использовать заново.`))return;
  toast('Удаляем сотрудника…');
  const out=await callDeleteUser({user_id:id});
  if(out.error){
    // если сама учётная запись входа уже не существовала (например, была создана без auth) —
    // не блокируем удаление карточки из-за этого, просто предупреждаем
    console.error('delete-user',out.error);
    if(!confirm(`Не удалось удалить учётную запись входа (${out.error}).\n\nВсё равно удалить карточку сотрудника? (номер телефона может остаться «занятым»)`))return;
  }
  if(await dbDelete('profiles',id)){S.profiles=S.profiles.filter(x=>x.id!==id);toast('Сотрудник удалён полностью');renderUsers();}
}
function staffModal(id){
  const u=S.profiles.find(x=>x.id===id);if(!u)return;
  showModal('Карточка сотрудника',`
    <div class="grid2">
      <div class="field full"><label>Email (логин)</label><input id="u_email" value="${esc(u.email||'')}"><span class="hint">Для входа по email. Если задан телефон — вход также по телефону.</span></div>
      <div class="field"><label>ФИО</label><input id="u_name" value="${esc(u.full_name||'')}"></div>
      <div class="field"><label>Телефон</label><input id="u_phone" inputmode="numeric"></div>
      <div class="field"><label>Город</label><select id="u_city"><option value="">—</option>${S.cities.map(c=>`<option value="${c.id}" ${u.city_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Должность</label><input id="u_pos" value="${esc(u.position||'')}"></div>
      <div class="field full"><label>Роль</label><select id="u_role">
        <option value="">— не назначена —</option>
        ${S.roles.map(r=>`<option value="${r.id}" ${u.role_id===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select>
        <span class="hint">Для курьеров: назначьте роль с базовым типом «Курьер», затем привяжите этот аккаунт в справочнике курьеров.</span></div>
      <div class="field full" id="u_kind_field" style="display:none"><label>Тип курьера</label><select id="u_kind">
        <option value="pickup" ${u.courier_kind==='pickup'?'selected':''}>Курьер заборщик</option>
        <option value="order" ${u.courier_kind==='order'||!u.courier_kind?'selected':''}>Курьер по заказам</option></select>
        <span class="hint">Определяет, в каком справочнике курьеров появится этот аккаунт для привязки.</span></div>
    </div>`,
    async()=>{
      const roleId=val('u_role');
      const baseType=(S.roles.find(r=>r.id===roleId)||{}).base_type||'';
      // синхронизируем старое текстовое поле role для серверного RLS (current_role_name)
      const legacy=baseType==='admin'?'admin':baseType==='courier'?'courier':'manager';
      const courier_kind=baseType==='courier'?val('u_kind'):null;
      const newPhone=phoneVal('u_phone');
      const newEmail=val('u_email').trim();
      // изменился ли логин (телефон или email)?
      const phoneChanged=newPhone!==(u.phone||'');
      const emailChanged=newEmail!==(u.email||'')&&newEmail!=='';
      if(phoneChanged||emailChanged){
        if(!isAdmin()){toast('Менять логин может только администратор');return false;}
        toast('Обновляем данные входа…');
        const payload={user_id:id};
        if(phoneChanged&&newPhone)payload.phone=newPhone;
        if(emailChanged)payload.email=newEmail;
        const out=await callUpdateUser(payload);
        if(out.error){alert('Не удалось изменить логин:\n\n'+out.error);return false;}
        // подхватываем новый email из ответа
        if(out.email)u.email=out.email;
      }
      const row={full_name:val('u_name').trim(),phone:newPhone,city_id:val('u_city')||null,
        position:val('u_pos').trim(),role_id:roleId||null,role:legacy,courier_kind};
      const u2=await dbUpdate('profiles',id,row);if(!u2)return false;Object.assign(u,u2);
      if(id===S.me.id){await loadMe({user:{id:S.me.id,email:S.me.email}});buildNav();}
      toast('Сохранено');renderUsers();return true;});
  attachPhone('u_phone',u.phone);
  const ur=$('u_role');const toggleUKind=()=>{const bt=(S.roles.find(r=>r.id===ur.value)||{}).base_type;
    $('u_kind_field').style.display=bt==='courier'?'':'none';};
  ur.onchange=toggleUKind;toggleUKind();
}

/* ---- РОЛИ И ПРАВА ---- */
function renderRoles(){
  const rows=[...S.roles].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const baseLabel={admin:'Админ',staff:'Персонал',courier:'Курьер'};
  $('usersContent').innerHTML=`<div class="panel">
    <div class="panel-head"><h2>Роли</h2><span class="count">${rows.length}</span>
      ${can('users','create')?`<button class="btn primary sm" id="addRole" style="margin-left:auto">＋ Добавить роль</button>`:''}</div>
    <div class="table-scroll"><table><thead><tr><th>Роль</th><th>Тип</th>${MODULES.map(([m,lbl])=>`<th style="font-size:11px">${esc(lbl)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td><span class="pill ${r.base_type==='admin'?'gold':r.base_type==='courier'?'':'moss'}">${baseLabel[r.base_type]||r.base_type}</span></td>
      ${MODULES.map(([m])=>`<td>${permSummary(r.perms&&r.perms[m])}</td>`).join('')}
      <td><div class="row-actions">
        ${can('users','edit')?`<button class="btn sm ghost" data-redit="${r.id}">Изменить</button>`:''}
        ${can('users','delete')?`<button class="btn sm danger" data-rdel="${r.id}">Удалить</button>`:''}
      </div></td></tr>`).join('')}</tbody></table></div></div>`;
  if($('addRole'))$('addRole').onclick=()=>roleModal();
  $('usersContent').querySelectorAll('[data-redit]').forEach(b=>b.onclick=()=>roleModal(b.dataset.redit));
  $('usersContent').querySelectorAll('[data-rdel]').forEach(b=>b.onclick=()=>delRole(b.dataset.rdel));
}
function permSummary(p){
  if(!p||!p.view)return '<span style="color:var(--muted)">нет</span>';
  const parts=[];if(p.create)parts.push('С');if(p.edit)parts.push('Р');if(p.delete)parts.push('У');
  return parts.length?`<span class="pill moss">просмотр +${parts.join('')}</span>`:'<span class="pill">просмотр</span>';
}
async function delRole(id){
  const r=S.roles.find(x=>x.id===id);
  const used=S.profiles.filter(p=>p.role_id===id).length;
  if(used){toast(`Роль используется у ${used} польз. Сначала смените им роль.`);return;}
  if(!confirm(`Удалить роль «${r?.name||''}»?`))return;
  if(await dbDelete('roles',id)){S.roles=S.roles.filter(x=>x.id!==id);toast('Роль удалена');renderUsers();}
}
function roleModal(id){
  const r=id?S.roles.find(x=>x.id===id):{name:'',base_type:'staff',perms:{}};
  const p=r.perms||{};
  const matrix=MODULES.map(([m,mlabel])=>{
    const mp=p[m]||{};
    return `<tr><td style="font-weight:600">${mlabel}</td>${ACTIONS.map(([a])=>`<td style="text-align:center"><input type="checkbox" data-perm="${m}.${a}" ${mp[a]?'checked':''}></td>`).join('')}</tr>`;
  }).join('');
  showModal(id?'Роль':'Новая роль',`
    <div class="field"><label>Название роли</label><input id="r_name" value="${esc(r.name)}" placeholder="Напр. Оператор склада"></div>
    <div class="field"><label>Базовый тип (для безопасности)</label>
      <select id="r_base">
        <option value="admin" ${r.base_type==='admin'?'selected':''}>Админ — полный доступ + управление</option>
        <option value="staff" ${r.base_type==='staff'?'selected':''}>Персонал — видит все данные в разрешённых модулях</option>
        <option value="courier" ${r.base_type==='courier'?'selected':''}>Курьер — видит только свои заявки/заказы</option>
      </select>
      <span class="hint">Базовый тип задаёт серверную защиту. «Курьер» автоматически ограничивает видимость только своими записями.</span></div>
    <div class="field"><label>Права по модулям</label>
      <table style="font-size:13px;width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left"></th>${ACTIONS.map(([,al])=>`<th style="text-align:center;font-size:11px;text-transform:uppercase;color:var(--muted);padding:6px 4px">${al}</th>`).join('')}</tr></thead>
      <tbody>${matrix}</tbody></table></div>`,
    async()=>{
      const name=val('r_name').trim();if(!name){toast('Укажите название');return false;}
      const perms={};
      MODULES.forEach(([m])=>{perms[m]={};ACTIONS.forEach(([a])=>{const el=document.querySelector(`[data-perm="${m}.${a}"]`);perms[m][a]=!!(el&&el.checked);});});
      const row={name,base_type:val('r_base'),perms};
      if(id){const u=await dbUpdate('roles',id,row);if(!u)return false;Object.assign(S.roles.find(x=>x.id===id),u);}
      else{const u=await dbInsert('roles',row);if(!u)return false;S.roles.push(u);}
      // если изменили свою роль — пересчитать права
      if(id&&S.me.role_id===id)computeMyPerms();
      toast('Сохранено');renderUsers();return true;},{mid:true});
}