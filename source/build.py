"""Build the installable userscript from a pinned upstream source and our module."""
from pathlib import Path
import json, hashlib

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'source/upstream.user.js').read_text(encoding='utf-8')
coach = (ROOT / 'source/coach.js').read_text(encoding='utf-8')

def replace_once(before, after):
    global source
    if source.count(before) != 1:
        raise RuntimeError(f'Upstream anchor mismatch: {before[:90]!r}')
    source = source.replace(before, after, 1)

replace_once('// @name         学习通作业/考试/任务列表（优化版）', '// @name         学习通个人助手（作业提醒与积分记录）')
replace_once('// @namespace    https://github.com/Cooanyh', '// @namespace    local.cx-study-assistant')
replace_once('// @source       https://github.com/Cooanyh/chaoxing-list', '// @source       https://github.com/lhsdsg666-png/xuexitong-study-assistant\n// @homepageURL  https://github.com/lhsdsg666-png/xuexitong-study-assistant')
replace_once('// @version      2.4.9', '// @version      0.1.0')
replace_once('// @description  【优化版】支持作业、考试与课程任务快速查看；提供统一设置、任务分类筛选、按课程忽略及任务引擎模块汇总。', '// @description  基于 chaoxing-list 2.4.9；增加桌面提醒、积分变化记录及负数积分修复。')
replace_once('// @author       甜檸Cirtron (lcandy2); Modified by Coren', '// @author       lcandy2; Coren; Personal assistant modifications by Codex')

# Signed numbers, including the Unicode minus displayed by some pages.
start = source.index('  const extractPointFromDom = (doc) => {')
end = source.index('\n  const ', start + 50)
part = source[start:end]
part = part.replace("const allText = container.textContent || '';", "const allText = (container.textContent || '').replace(/[−－]/g, '-');")
part = part.replace("const text = container.textContent || '';", "const text = (container.textContent || '').replace(/[−－]/g, '-');")
part = part.replace('const text = el.textContent.trim();', "const text = el.textContent.trim().replace(/[−－]/g, '-');")
part = part.replace(r'(\d+(?:\.\d+)?)', r'([+-]?\d+(?:\.\d+)?)')
part = part.replace(r'/^\d+(?:\.\d+)?$/', r'/^[+-]?\d+(?:\.\d+)?$/')
part = part.replace(r'/积分[^\\d]*(\d+)/', r'/积分[^\d+-]*([+-]?\d+(?:\.\d+)?)/')
source = source[:start] + part + source[end:]

replace_once('      const homeworkItems = vue.ref([]);', """      const homeworkItems = vue.ref([]);
      const coachHomeworkState = vue.ref('尚未读取');
      const coachExamState = vue.ref('尚未读取');
      const coachReadAt = vue.ref(null);""")
replace_once('          homeworkItems.value = extractTasks(doc);', """          if (!res.ok || /passport2\\.chaoxing|login\\.chaoxing/.test(res.url)) throw new Error('请重新登录');
          if (!doc.querySelector('ul.nav') && !/暂无作业|没有作业|暂无数据|没有相关作业/.test(text)) throw new Error('作业结构未识别');
          homeworkItems.value = extractTasks(doc);
          coachHomeworkState.value = '已读取';
          coachReadAt.value = Date.now();""")
replace_once("        } catch (e) { console.error('[仪表盘] 获取作业失败:', e); }", "        } catch (e) { coachHomeworkState.value = '读取失败，请核对原页'; console.error('[仪表盘] 获取作业失败:', e); }")
replace_once('          examItems.value = extractExams(doc);', """          if (!res.ok || /passport2\\.chaoxing|login\\.chaoxing/.test(res.url)) throw new Error('请重新登录');
          if (!doc.querySelector('dl, .ks_pic') && !/暂无考试|没有考试|暂无数据|没有相关考试/.test(text)) throw new Error('考试结构未识别');
          examItems.value = extractExams(doc);
          coachExamState.value = '已读取';
          coachReadAt.value = Date.now();""")
replace_once("        } catch (e) { console.error('[仪表盘] 获取考试失败:', e); }", "        } catch (e) { coachExamState.value = '读取失败，请核对原页'; console.error('[仪表盘] 获取考试失败:', e); }")

hook = """
        // Added personal assistant. No new login, submission, signing or answer endpoints.
        const coachObserved = new WeakMap();
        const coachTask = item => {
          if (!coachObserved.has(item)) coachObserved.set(item, Date.now());
          return {...item, observedAt: coachObserved.get(item),
            link: item.taskLink || (item.type === '作业' ? getHomeworkLink(item) : getTodoLink(item))};
        };
        CXStudyCoach.mount({
          getSnapshot: () => ({
            items: [...filteredTodoItems.value, ...filteredHomeworkItems.value, ...filteredExamItems.value].map(coachTask),
            courses: filteredCourseProgressItems.value,
            coursesFresh: progressLoaded.value && !loadingProgress.value && !progressFromCache.value && !progressLoadFailed.value,
            sourceStatus: `作业：${coachHomeworkState.value}；考试：${coachExamState.value}；课程活动：${activitiesLoadFailed.value ? '读取失败' : activitiesLoaded.value ? '已读取' : '读取中'}${coachReadAt.value ? ' · ' + new Date(coachReadAt.value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : ''}`
          }),
          subscribe: callback => vue.watch([todoItems, homeworkItems, examItems, courseProgressItems,
            loadingProgress, progressLoaded, progressFromCache, coachHomeworkState, coachExamState,
            activitiesLoadFailed, activitiesLoaded, ignoredVersion, settingsVersion],callback,{deep:true}),
          refresh: async () => {
            await loadHomeworkData();
            await loadExamData();
            activitiesFetched.value = false;
            await loadActivitiesData();
          }
        });
"""
replace_once('        cleanupDashboardCache();\n        hydrateShortTermCache();', hook + '\n        cleanupDashboardCache();\n        hydrateShortTermCache();')

# Do not log signed URLs or full personal API responses in the browser console.
source = '\n'.join(line for line in source.split('\n') if 'console.log(' not in line or not any(x in line for x in ['响应内容', '响应数据', 'job API返回数据无效', 'point API无有效数据']))
metadata_end = source.index('// ==/UserScript==') + len('// ==/UserScript==')
source = source[:metadata_end] + '\n\n' + coach + '\n' + source[metadata_end:]
output = ROOT / '学习通个人助手.user.js'
output.write_text(source, encoding='utf-8', newline='\n')
provenance = {
    'upstream': 'https://github.com/Cooanyh/chaoxing-list',
    'commit': 'dd823449f0942f006e70721ddfc214659f406756',
    'upstreamVersion': '2.4.9', 'assistantVersion': '0.1.0',
    'reviewDate': '2026-10-12',
    'upstreamFileSha256': hashlib.sha256((ROOT/'source/upstream.user.js').read_bytes()).hexdigest(),
    'buildSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'license': 'AGPL-3.0-or-later',
}
(ROOT/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),encoding='utf-8',newline='\n')
print(json.dumps({'output':str(output),'bytes':output.stat().st_size},ensure_ascii=False))
