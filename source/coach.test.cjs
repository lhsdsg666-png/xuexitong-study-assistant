const test=require('node:test');
const assert=require('node:assert/strict');
const c=require('./coach.js');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const now=Date.parse('2026-10-12T15:00:00+08:00');
const task=(more={})=>({courseId:1,clazzId:2,course:'操作系统',type:'作业',workId:7,title:'进程练习',status:'未交',leftTime:'剩余2小时',...more});
test('负分保留符号，未知不转为0',()=>{for(const v of ['-2分','−2分','－2 分'])assert.equal(c.score(v),-2);assert.equal(c.score('0分'),0);assert.equal(c.score('2.5分'),2.5);for(const v of ['--','','未开放','扣2分'])assert.equal(c.score(v),null);});
test('相对截止时间包括零分钟，绝对时间固定北京时间',()=>{assert.equal(c.deadline('剩余2小时30分钟',now).at,now+150*60000);assert.equal(c.deadline('剩余0分钟',now).at,now);assert.equal(c.deadline('截止2026-10-12 17:30',now).at,now+150*60000);assert.equal(c.deadline('2026-10-12 15:00 至 2026-10-12 17:30',now).at,now+150*60000);});
test('未知时间、无年份与无效日历不猜测',()=>{for(const v of ['无截止时间','10-13 08:00','2026-02-30 08:00','未设置','有30分钟视频'])assert.equal(c.deadline(v,now).at,null);assert.equal(c.deadline('剩余1小时后开始',now).phase,'start');});
test('提交待批阅不催交，待互评继续提醒',()=>{for(const status of ['已提交','待批閱','已完成','已互评'])assert.equal(c.isPending(task({status,uncommitted:true})),false);assert.equal(c.isPending(task({status:'待互评'})),true);});
test('待办去重、按截止排序，未知时间保留',()=>{const items=c.sortTasks([task(),task(),task({workId:8,leftTime:'剩余1小时'}),task({workId:9,leftTime:''}),task({workId:10,status:'已提交'})],now);assert.equal(items.length,3);assert.equal(items[0].id,'作业:1:2:8');assert.equal(items[2].deadlineMs,null);});
test('首次负分是基线，不编造一次扣分',()=>{const d=c.updateCourses(c.emptyDb(),[{courseId:1,clazzId:2,cpi:10,courseName:'操作系统',courseScore:'-2分'}],now);const s=Object.values(d.courses)[0];assert.equal(s.value,-2);assert.equal(s.history.length,1);assert.equal(s.history[0].delta,undefined);});
test('记录观察变化，未知读数保留之前数据，同名课与不同学生分开',()=>{let d=c.updateCourses(c.emptyDb(),[{courseId:1,clazzId:2,cpi:10,courseName:'操作系统',courseScore:-2}],now);d=c.updateCourses(d,[{courseId:1,clazzId:2,cpi:10,courseName:'操作系统',courseScore:-4},{courseId:1,clazzId:2,cpi:11,courseName:'操作系统',courseScore:0}],now+1);assert.equal(d.courses['1:2:10'].history[1].delta,-2);assert.equal(d.courses['1:2:10'].history[1].at,now+1);d=c.updateCourses(d,[{courseId:1,clazzId:2,cpi:10,courseName:'操作系统',courseScore:'--'}],now+2);assert.equal(d.courses['1:2:10'].value,-4);assert.equal(Object.keys(d.courses).length,2);});
test('桌面提醒分阶段去重，已到截止不报未来截止',()=>{const t=c.sortTasks([task({leftTime:'剩余10小时'})],now);const d=c.emptyDb();let a=c.dueAlerts(t,d,now);assert.equal(a.length,1);assert.equal(a[0].stage,'24h');d.notified[a[0].key]=now;assert.equal(c.dueAlerts(t,d,now+60000).length,0);a=c.dueAlerts(t,d,now+8*3600000);assert.equal(a[0].stage,'2h');assert.equal(c.dueAlerts(t,d,now+10*3600000).length,0);});
test('暂缓通知与未知时间不发虚构提醒',()=>{const d=c.emptyDb();const ts=c.sortTasks([task(),task({workId:8,leftTime:''})],now);d.snoozed[ts[0].id]=now+4*3600000;assert.equal(c.dueAlerts(ts,d,now).length,0);});
test('任务链接只允许超星 HTTPS，不能注入脚本或第三方地址',()=>{for(const v of ['javascript:alert(1)','https://chaoxing.com.evil.example/','http://i.chaoxing.com/','https://example.org/'])assert.equal(c.safeLink(v),'');assert.equal(c.safeLink('https://i.chaoxing.com/'),'https://i.chaoxing.com/');});
test('构建后的上游网页备用解析保留负号',()=>{
  const script=fs.readFileSync(path.join(__dirname,'..','学习通个人助手.user.js'),'utf8');
  const start=script.indexOf('  const extractPointFromDom = (doc) => {');
  const end=script.indexOf('\n  const ',start+50);
  const fn=vm.runInNewContext(script.slice(start,end)+';extractPointFromDom;');
  for(const value of ['-2','−2','－2','-2.5','0','6']){
    const parent={textContent:'课程积分：'+value+'分',parentElement:null};
    const leaf={textContent:'课程积分',children:[],parentElement:parent};
    const doc={querySelectorAll:selector=>selector==='*'?[leaf]:[]};
    assert.equal(fn(doc),value.replace(/[−－]/g,'-'));
  }
});
