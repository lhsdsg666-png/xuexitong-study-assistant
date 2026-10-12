/* 学习通个人助手附加模块，AGPL-3.0-or-later。规则与网页 UI 共用此源码。 */
var CXStudyCoach = (function () {
  'use strict';
  const VERSION = '0.1.0';
  const PREFIX = 'cx_study_coach_v1';
  const clean = value => String(value ?? '').trim();
  const escape = value => clean(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function score(value) {
    const text = clean(value).replace(/[−－]/g, '-');
    const match = text.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:分|积分)?$/);
    return match ? Number(match[1]) : null;
  }
  function safeLink(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.hostname === 'chaoxing.com' || u.hostname.endsWith('.chaoxing.com')) ? u.href : '';
    } catch { return ''; }
  }
  function deadline(text, observedAt) {
    text = clean(text);
    if (!text || /无截止|不限时|未设置/.test(text)) return {at:null, phase:'unknown'};
    if (/已过期|已结束/.test(text)) return {at:null, phase:'expired'};
    const phase = /开始/.test(text) && !/截止|结束|至|到/.test(text) ? 'start' : 'end';
    const dates = [...text.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/g)];
    if (dates.length) {
      const m = dates[dates.length - 1];
      const pad = x => String(x || '00').padStart(2, '0');
      const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${pad(m[6])}+08:00`;
      const at = Date.parse(iso);
      // Invalid calendar dates must not silently roll into the next month.
      if (!Number.isFinite(at) || new Date(at + 8*3600000).toISOString().slice(0,10) !== iso.slice(0,10)) return {at:null, phase:'unknown'};
      return {at, phase};
    }
    const parts = [...text.matchAll(/(\d+)\s*(天|小时|分钟|分)(?!钟?后发布)/g)];
    if (!parts.length || !/剩余|还有|后/.test(text)) return {at:null, phase:'unknown'};
    const minutes = parts.reduce((n,m) => n + Number(m[1]) * (m[2] === '天' ? 1440 : m[2] === '小时' ? 60 : 1), 0);
    return {at: observedAt + minutes*60000, phase};
  }
  function isPending(item) {
    if (item.finished === true) return false;
    const status = clean(item.status);
    if (/待互评|待互評/.test(status)) return true;
    if (/已提交|已交|待批阅|待批閱|待批改|已完成|已批改|已互评|已互評/.test(status)) return false;
    if (/未交|未提交|未完成|进行中|未开始|待提交/.test(status)) return true;
    return item.uncommitted === true || item.pending === true;
  }
  function normalizeTask(item, now) {
    const title = clean(item.title) || '未命名任务';
    const course = clean(item.courseName || item.course) || '课程未提供';
    const type = clean(item.type) || '任务';
    const text = clean(item.leftTime || item.timeLeft || item.info);
    const parsed = Number.isFinite(item.deadlineMs) ? {at:item.deadlineMs,phase:item.phase || 'end'} : deadline(text, item.observedAt || now);
    return {
      id: [type,item.courseId || course,item.clazzId || item.classId || '',item.workId || item.examId || item.activeId || item.id || title].join(':'),
      title,course,type,status:clean(item.status) || '状态未提供',deadlineMs:parsed.at,
      phase:parsed.phase,deadlineText:text,link:safeLink(item.link || item.taskLink || item.raw),pending:isPending(item)
    };
  }
  function sortTasks(items, now) {
    const unique = new Map();
    for (const raw of items) {
      const task = normalizeTask(raw, now);
      if (!task.pending) continue;
      const old = unique.get(task.id);
      if (!old || old.deadlineMs === null && task.deadlineMs !== null) unique.set(task.id, task);
    }
    return [...unique.values()].sort((a,b) => (a.deadlineMs ?? Infinity)-(b.deadlineMs ?? Infinity) || a.course.localeCompare(b.course,'zh-CN'));
  }
  function emptyDb() { return {version:1,courses:{},manual:[],notified:{},snoozed:{}}; }
  function courseKey(course) { return [course.courseId || course.courseName,course.clazzId || course.classId || '',course.cpi || ''].join(':'); }
  function updateCourses(db, courses, now) {
    const result = JSON.parse(JSON.stringify(db));
    for (const course of courses) {
      const value = score(course.courseScore);
      if (value === null) continue;
      const key = courseKey(course);
      const previous = result.courses[key];
      const observation = {at:now,value};
      const history = previous ? [...previous.history] : [observation];
      if (previous && value !== previous.value) history.push({...observation,previous:previous.value,delta:Number((value-previous.value).toFixed(6))});
      result.courses[key] = {key,name:clean(course.courseName) || '未知课程',type:'课程积分',value,seenAt:now,history:history.slice(-150)};
    }
    return result;
  }
  function dueAlerts(tasks, db, now) {
    return tasks.flatMap(task => {
      if (task.deadlineMs === null || task.deadlineMs <= now || (db.snoozed[task.id] || 0) > now) return [];
      const minutes = (task.deadlineMs-now)/60000;
      const stage = minutes <= 120 ? '2h' : minutes <= 1440 ? '24h' : '';
      if (!stage) return [];
      const day = new Date(task.deadlineMs + 8*3600000).toISOString().slice(0,10);
      const key = `${task.id}:${day}:${stage}`;
      return db.notified[key] ? [] : [{key,task,stage}];
    });
  }
  function dateText(ms) { return new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
  function remaining(task, now) {
    if (task.deadlineMs === null) return task.phase === 'expired' ? '已结束／过期，核对能否补交' : '截止时间未读取到';
    const n = Math.ceil((task.deadlineMs-now)/60000);
    if (n <= 0) return task.phase === 'start' ? '已到开始时间，打开原页核对' : '已到截止时间，核对能否补交';
    const days = Math.floor(n/1440), hours = Math.floor(n%1440/60), minutes = n%60;
    const time = `${days ? days+'天' : ''}${hours ? hours+'小时' : ''}${minutes || !days && !hours ? minutes+'分钟' : ''}`;
    return `${time}后${task.phase === 'start' ? '开始' : '截止'}`;
  }
  function mount(options) {
    if (document.querySelector('#cx-study-coach-host')) return;
    const storage = options.storage || localStorage;
    const profileKey = `${PREFIX}_profile`;
    let profile = storage.getItem(profileKey) || '我的账号';
    let db,settings;
    function dbKey() { return `${PREFIX}_${profile}`; }
    function readDb() {
      try { const saved=JSON.parse(storage.getItem(dbKey()) || '{}'); db={...emptyDb(),...saved}; } catch { db=emptyDb(); }
      try { settings={notifications:false,autoRefresh:true,...JSON.parse(storage.getItem(`${dbKey()}_settings`) || '{}')}; } catch { settings={notifications:false,autoRefresh:true}; }
    }
    readDb();
    let storageFailed=false,tab='todo',open=Boolean(options.demo),tasks=[],snapshot={},notice='',refreshing=false;
    const host=document.createElement('div'); host.id='cx-study-coach-host'; document.body.appendChild(host);
    const shadow=host.attachShadow({mode:'open'});
    function save() { try { storage.setItem(dbKey(),JSON.stringify(db)); storage.setItem(`${dbKey()}_settings`,JSON.stringify(settings)); storageFailed=false; } catch { storageFailed=true; } }
    function notify(now) {
      if (!settings.notifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      // Re-read shared notification marks to deduplicate multiple open tabs.
      try { const other=JSON.parse(storage.getItem(dbKey()) || '{}'); db.notified={...db.notified,...other.notified}; } catch {}
      const alerts=dueAlerts(tasks,db,now);
      if (!alerts.length) return;
      for (const alert of alerts) db.notified[alert.key]=now;
      save();
      try {
        const notification=new Notification(`学习助手：${alerts.length}项任务临近时间`,{body:alerts.slice(0,3).map(a=>`${a.task.course} · ${a.task.title} · ${remaining(a.task,now)}`).join('\n'),tag:'cx-study-reminder'});
        notification.onclick=()=>{open=true;tab='todo';window.focus();render();notification.close();};
      } catch { notice='桌面提醒发送失败，请检查浏览器通知设置。'; }
    }
    function update() {
      const now=Date.now(); snapshot=options.getSnapshot(); tasks=sortTasks(snapshot.items || [],now);
      if (snapshot.coursesFresh) { db=updateCourses(db,snapshot.courses || [],now);save(); }
      notify(now);render();
    }
    const css=`
      :host{all:initial;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#192e32;font-size:14px;line-height:1.65}
      *{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{outline-offset:4px}button{cursor:pointer}button:disabled{cursor:wait;opacity:.6}
      .launcher{position:fixed;right:26px;bottom:26px;z-index:2147483646;border:0;border-radius:14px;background:#163d3f;color:#fff;padding:13px 21px;box-shadow:0 8px 30px #182c3540;font-weight:700}
      .panel{position:fixed;right:24px;bottom:86px;width:540px;max-width:calc(100vw - 32px);max-height:calc(100vh - 110px);z-index:2147483647;background:#faf7ef;border:1px solid #dcd4c4;border-radius:20px;box-shadow:0 24px 80px #102b3540;overflow:auto;scrollbar-width:thin}
      header{padding:26px 28px 18px;border-bottom:1px solid #e5dece;background:#f3eedf}.eyebrow{font-size:11px;letter-spacing:3px;color:#766d56;font-weight:700}h1{font-family:"SimSun","Songti SC",serif;font-size:30px;font-weight:700;margin:4px 0 6px;line-height:1.3}.intro{color:#726d60;font-size:12px;margin:0}.close{float:right;background:none;border:0;font-size:25px;color:#716b5a}
      .demo,.warning{margin:14px 24px 0;padding:10px 13px;background:#fff1d4;color:#765221;border-left:3px solid #c88238;font-size:12px}.warning{background:#f9e9e3;color:#8c4130}.status{padding:14px 26px 4px;font-size:12px;color:#736d61}.status b{color:#405e5c}
      nav{display:flex;gap:20px;margin:0 26px;border-bottom:1px solid #dcd4c4}nav button{padding:13px 0 10px;border:0;border-bottom:3px solid transparent;background:none;color:#777064;font-weight:700}nav button.active{border-bottom-color:#1c6961;color:#1c6961}
      main{padding:18px 26px 22px}.count{display:flex;align-items:baseline;gap:9px;margin-bottom:16px}.count strong{font-family:Georgia,"SimSun",serif;font-size:38px;line-height:1}.count span{color:#736d61;font-size:12px}.task{border-top:1px solid #e4dccb;padding:16px 0;display:grid;grid-template-columns:29px 1fr;gap:10px}.no{font-family:Georgia,serif;color:#9b967f;font-size:20px}.title{font-size:15px;font-weight:700;overflow-wrap:anywhere}.meta{color:#7d7668;font-size:12px}.due{display:inline-block;margin:7px 0;color:#1a685f;font-size:12px;font-weight:700}.urgent{color:#ad492d}.actions{display:flex;gap:12px;align-items:center}.actions a{color:#1a685f;font-size:12px;text-decoration:underline}.textbtn{border:0;background:none;color:#7c725d;font-size:12px;padding:0}.card{border:1px solid #e0d8c6;padding:15px;margin-bottom:12px;border-radius:12px;background:#fffdf7}.score{float:right;font-family:Georgia,serif;font-size:30px;line-height:1.2}.negative{color:#ad492d}.label{font-size:11px;color:#7b735d}.history{font-size:12px;color:#635f53;margin-top:10px;border-top:1px solid #ebe4d4;padding-top:9px}.history div{margin:4px 0}.empty{padding:24px 0;color:#756f60;font-size:13px}.tools{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0 5px}.btn{border:1px solid #cac1ad;background:#fffdf7;border-radius:8px;padding:7px 10px;font-size:12px;color:#2b4948}.btn.primary{background:#1b625a;color:white;border-color:#1b625a}footer{padding:15px 26px;border-top:1px solid #e0d8c6;font-size:12px;color:#746e60;background:#f4eedf}.toggle{display:inline-flex;align-items:center;gap:5px;margin:7px 13px 7px 0}input[type=checkbox]{accent-color:#1b625a}.profile{width:112px;border:1px solid #d9cfba;border-radius:5px;padding:3px 5px;background:white;font-size:12px}.notice{font-size:12px;color:#865135;margin-top:8px}.fine{font-size:11px;color:#8a806b;margin-top:10px}details{margin-top:14px;border-top:1px solid #dfd6c3;padding-top:10px}summary{cursor:pointer;color:#486961;font-size:12px}.form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.form label{font-size:12px;display:grid;gap:3px}.form input,.form select{min-width:0;width:100%;padding:7px;border:1px solid #d9cfba;border-radius:6px;background:#fff}.wide{grid-column:1/-1}
      @media(max-width:600px){.panel{right:12px;bottom:78px}.launcher{right:16px;bottom:18px}header{padding:20px}.status,main,footer{padding-left:20px;padding-right:20px}nav{margin:0 20px}}
    `;
    function taskHtml(task,index,now) {
      const near=task.deadlineMs !== null && task.deadlineMs-now<=24*3600000;
      const snoozed=(db.snoozed[task.id] || 0)>now;
      return `<div class="task"><div class="no">${String(index+1).padStart(2,'0')}</div><div><div class="meta">${escape(task.course)} · ${escape(task.type)} · ${escape(task.status)}</div><div class="title">${escape(task.title)}</div><div class="due ${near?'urgent':''}">${escape(remaining(task,now))}</div>${task.deadlineMs ? `<div class="meta">${dateText(task.deadlineMs)}（北京时间${/剩余|还有|后/.test(task.deadlineText)?'，根据剩余时间估算':''}）</div>`:''}<div class="actions">${task.link?`<a href="${escape(task.link)}" target="_blank" rel="noopener noreferrer">打开原任务 ↗</a>`:'<span class="meta">直达链接未读取到</span>'}<button class="textbtn" data-snooze="${index}">${snoozed?'已暂缓提醒':'4小时内不提醒'}</button></div></div></div>`;
    }
    function courseHtml(course) {
      return `<div class="card"><span class="score ${course.value<0?'negative':''}">${course.value}</span><div class="title">${escape(course.name)}</div><div class="label">${escape(course.type)} · 最近读取 ${dateText(course.seenAt)}</div><div class="history">${course.history.slice(-5).reverse().map(h=>h.delta===undefined?`<div>${dateText(h.at)} 首次读取：${h.value}分，之前扣过几次未知</div>`:`<div>${dateText(h.at)} 观察到 ${h.previous} → ${h.value}分（${h.delta>0?'+':''}${h.delta}）</div>`).join('')}</div></div>`;
    }
    function render() {
      const now=Date.now();
      const previousForm=shadow.querySelector('#manual');
      const draft=previousForm ? Object.fromEntries(new FormData(previousForm).entries()) : null;
      const formWasOpen=Boolean(previousForm && previousForm.parentElement.open);
      const activeName=shadow.activeElement && shadow.activeElement.name;
      const scrollTop=shadow.querySelector('.panel')?.scrollTop || 0;
      const courses=Object.values(db.courses).sort((a,b)=>a.value-b.value);
      const pending=tasks.filter(t=>(db.snoozed[t.id] || 0)<=now).length;
      const source=snapshot.sourceStatus || '尚未读取';
      let body='';
      if (tab==='todo') body=`<div class="count"><strong>${tasks.length}</strong><span>项已读取的待办 · ${pending}项未暂缓提醒</span></div>${tasks.length ? tasks.map((t,i)=>taskHtml(t,i,now)).join('') : '<div class="empty">当前读取结果中没有待办。请核对数据状态与课程原页，读取失败时不能据此认定作业都交齐。</div>'}`;
      else body=`<div class="intro">这里记录分数项目和网页可见数值，供你自己判断。</div><div class="fine">积分变化是两次读取之间的差值；原因和老师操作时间未读取到。课程积分不能直接换算成期末成绩。</div><div style="height:16px"></div>${courses.map(courseHtml).join('') || '<div class="empty">尚未读取到课程积分。打开底座的“课程进度”，确认查询已开启。</div>'}${db.manual.length?'<div class="label">你补充的记录（不计入上方网页数值）</div>'+db.manual.slice().reverse().map(m=>`<div class="card"><div class="title">${escape(m.course)} · ${escape(m.type)} ${m.change>0?'+':''}${m.change}分</div><div class="meta">${escape(m.date || '日期未知')} · ${escape(m.reason || '原因未填写')} · 你填写的记录</div></div>`).join(''):''}<details><summary>补充老师另行记录的扣分／加分</summary><form class="form" id="manual"><label>课程<input name="course" required maxlength="80" placeholder="例如：操作系统"></label><label>分数项目<select name="type"><option>课堂积分</option><option>平时成绩</option><option>签到分</option><option>其他分数</option></select></label><label>变化分值<input name="change" type="number" step="0.01" required placeholder="扣2分填 -2"></label><label>实际日期（可留空）<input name="date" type="date"></label><label class="wide">原因（可留空）<input name="reason" maxlength="200" placeholder="例如：点名未到，老师口头说明"></label><button class="btn primary wide" type="submit">保存到本地记录</button></form></details><div class="tools"><button class="btn" id="export">导出我的积分记录</button></div>`;
      shadow.innerHTML=`<style>${css}</style><button class="launcher" id="launch">学习助手${tasks.length?' · '+tasks.length:''}</button>${open?`<section class="panel" aria-label="学习助手"><header><button class="close" id="close" aria-label="收起">×</button><div class="eyebrow">本学期 · 个人记录</div><h1>把该做的事看清楚</h1><p class="intro">作业、考试和积分，放在一个地方。</p></header>${options.demo?'<div class="demo">演示数据 · 此预览没有连接你的学习通账号</div>':''}${storageFailed?'<div class="warning">浏览器未能保存记录，关闭页面后可能丢失。</div>':''}<div class="status"><b>数据状态</b>　${escape(source)}</div><nav><button class="${tab==='todo'?'active':''}" data-tab="todo">待办 ${tasks.length}</button><button class="${tab==='scores'?'active':''}" data-tab="scores">积分记录 ${courses.length}</button></nav><main>${body}</main><footer><div class="tools"><button class="btn primary" id="refresh" ${refreshing?'disabled':''}>${refreshing?'正在读取…':'刷新作业和考试'}</button><button class="btn" id="notify">${settings.notifications?'关闭桌面提醒':'开启桌面提醒'}</button></div><label class="toggle"><input type="checkbox" id="auto" ${settings.autoRefresh?'checked':''}>页面打开时每15分钟更新待办</label><div>记录档案 <input class="profile" id="profile" value="${escape(profile)}" aria-label="记录档案"><button class="textbtn" id="switch" style="margin-left:7px">切换</button></div><div class="fine">提醒在24小时、2小时内各发一次。浏览器关闭、电脑休眠或登录失效时，无法持续检测。切换学习通账号时，请使用新的记录档案。</div>${notice?`<div class="notice" role="status">${escape(notice)}</div>`:''}</footer></section>`:''}`;
      shadow.querySelector('#launch').onclick=()=>{open=!open;render();};
      if (!open) return;
      shadow.querySelector('#close').onclick=()=>{open=false;render();};
      shadow.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{tab=el.dataset.tab;render();});
      shadow.querySelectorAll('[data-snooze]').forEach(el=>el.onclick=()=>{db.snoozed[tasks[Number(el.dataset.snooze)].id]=Date.now()+4*3600000;save();render();});
      shadow.querySelector('#auto').onchange=e=>{settings.autoRefresh=e.target.checked;save();};
      shadow.querySelector('#switch').onclick=()=>{const value=clean(shadow.querySelector('#profile').value);if(!value)return;profile=value.slice(0,60);storage.setItem(profileKey,profile);readDb();notice='已切换本地档案。请确认学习通登录账号也已切换。';update();};
      shadow.querySelector('#refresh').onclick=refresh;
      shadow.querySelector('#notify').onclick=async()=>{
        if(settings.notifications){settings.notifications=false;notice='桌面提醒已关闭。';}
        else if(typeof Notification==='undefined')notice='当前浏览器不支持桌面通知。';
        else {try{const permission=await Notification.requestPermission();settings.notifications=permission==='granted';notice=settings.notifications?'已开启桌面提醒。请保持学习通助手页面打开。':'浏览器尚未允许通知，请在网站权限中设置。';}catch{notice='无法申请通知权限，请在浏览器设置中检查。';}}
        save();notify(Date.now());render();
      };
      const manual=shadow.querySelector('#manual');
      if(manual){
        if(draft){for(const [name,value] of Object.entries(draft)){const input=manual.elements.namedItem(name);if(input)input.value=value;}manual.parentElement.open=formWasOpen;}
        if(activeName)manual.elements.namedItem(activeName)?.focus();
        manual.onsubmit=e=>{e.preventDefault();const data=new FormData(manual);const change=Number(data.get('change'));if(!Number.isFinite(change)||change===0){notice='请填写非零的变化分值，扣分填写负数。';render();return;}db.manual.push({course:clean(data.get('course')),type:clean(data.get('type')),change,date:clean(data.get('date')),reason:clean(data.get('reason')),recordedAt:Date.now()});save();notice='已保存你填写的记录。';manual.reset();manual.parentElement.open=false;render();};
      }
      shadow.querySelector('.panel').scrollTop=scrollTop;
      const exportButton=shadow.querySelector('#export');
      if(exportButton)exportButton.onclick=()=>{const blob=new Blob([JSON.stringify({version:VERSION,exportedAt:new Date().toISOString(),courses:db.courses,manual:db.manual},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='学习通积分记录.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    }
    async function refresh() {if(refreshing)return;refreshing=true;notice='';render();try{await options.refresh();update();}catch{notice='刷新失败，保留之前读取的数据。请检查登录状态与原课程页面。';}finally{refreshing=false;render();}}
    const unsubscribe=options.subscribe ? options.subscribe(update) : null;
    update();
    const ticker=setInterval(()=>{notify(Date.now());if(open && !shadow.querySelector('#manual :focus'))render();},60000);
    const refreshTimer=setInterval(()=>{if(settings.autoRefresh)refresh();},15*60000);
    // Background tabs may be throttled; resuming refreshes the last known reminders.
    const onVisible=()=>{if(document.visibilityState==='visible'){notify(Date.now());render();}};
    document.addEventListener('visibilitychange',onVisible);
    return {update,refresh,open:()=>{open=true;render();},destroy:()=>{clearInterval(ticker);clearInterval(refreshTimer);if(unsubscribe)unsubscribe();document.removeEventListener('visibilitychange',onVisible);host.remove();}};
  }
  return {VERSION,score,deadline,safeLink,isPending,normalizeTask,sortTasks,emptyDb,updateCourses,dueAlerts,mount};
})();
if (typeof module !== 'undefined' && module.exports) module.exports=CXStudyCoach;
