/* 浏览器回归：首次使用（无数据）、真实输入事件的交互，以及 e2e.js 的图表全量检查。
 *
 * 用法：node tests/browser.mjs [项目目录]
 * 需要 Node 22+ 和任一 Chromium 系浏览器（可用环境变量 BROWSER 指定）。
 * 在临时副本里运行，数据由 fixture.py 虚构，更新脚本是假的：不访问外网，也不读写项目里的 data/。
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const browser = [process.env.BROWSER,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!browser) {
  console.error('找不到 Chromium 系浏览器，请用 BROWSER 指定');
  process.exit(2);
}

const work = realpathSync(mkdtempSync(join(tmpdir(), 'score-trends-')));
const copy = join(work, 'project');
const LOCAL_ONLY = ['.git', '.claude', 'data', 'docs'];
cpSync(project, copy, { recursive: true, filter: (src) => !LOCAL_ONLY.includes(relative(project, src)) && basename(src) !== '__pycache__' });
// 夹具要走真实的写入流程，所以先备好；测试中途才放进项目副本
const seeded = join(work, 'seeded');
execFileSync('python3', ['-I', join(project, 'tests', 'fixture.py'), (mkdirSync(seeded), seeded)], { stdio: ['ignore', 'ignore', 'inherit'] });
writeFileSync(join(copy, 'scripts', 'update_data.py'), `import json, pathlib, signal, sys, time
finish = pathlib.Path(__file__).resolve().parent / 'finish'
def emit(**e): print(json.dumps(e), flush=True)
def stop(*_):
    emit(event='cancelled'); sys.exit(130)
signal.signal(signal.SIGTERM, stop)
for i in range(1, 400):
    emit(event='progress', stage='details', done=i, total=400, label='model-%d' % i)
    time.sleep(0.12)
    if finish.exists():
        finish.rename(finish.with_name('finished'))
        emit(event='done')
        sys.exit(0)
emit(event='error', message='测试脚本不会成功')
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (issue, name, pass, info = '') => {
  results.push(!!pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} [${issue}] ${name}${pass ? '' : ` :: ${JSON.stringify(info)}`}`);
};

const server = spawn('python3', ['-I', join(copy, 'scripts', 'serve.py'), '--no-open', '--port', '8772'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { const m = /http:\/\/localhost:\d+\//.exec(String(d)); if (m) resolve(m[0]); });
  server.once('exit', () => reject(new Error('服务没有启动')));
});
const profile = join(work, 'profile');
const child = spawn(browser, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--disable-extensions', '--disable-sync', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });

try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  await sleep(300);
  const debug = readFileSync(portFile, 'utf8').split('\n')[0];
  const target = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });

  let seq = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
  };
  const send = (method, params = {}) => new Promise((r) => { waiting.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.exceptionDetails ? null : r.result?.result?.value;
  };
  const viewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
  };
  const open = async (state) => {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${base}${state ? `#s=${encodeURIComponent(JSON.stringify(state))}` : ''}` });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (await run('!!window.AA?.ui?.chart')) break;
    }
    await sleep(350);
  };
  const where = (selector) => run(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);
  const mouse = (type, [x, y], count = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: count });
  const click = async (selector, hold = 90, count = 1) => {
    const at = await where(selector);
    if (!at) return false;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
    for (let i = 1; i <= count; i++) {
      await mouse('mousePressed', at, i);
      await sleep(i === count ? hold : 20);
      await mouse('mouseReleased', at, i);
    }
    await sleep(160);
    return true;
  };
  const key = async (name, code, modifiers = 0) => {
    const common = { key: name, code: name, windowsVirtualKeyCode: code, modifiers };
    // 回车要带上字符，浏览器才会把它当作提交
    await send('Input.dispatchKeyEvent', name === 'Enter' ? { type: 'keyDown', text: '\r', ...common } : { type: 'rawKeyDown', ...common });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(160);
  };
  const type = async (text) => {
    for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await sleep(80);
  };
  const fill = async (selector, text) => {
    await click(selector, 60, 3);
    await type(text);
  };
  const state = async () => JSON.parse(await run('JSON.stringify(AA.state)'));
  const focused = () => run('document.activeElement?.dataset?.key || document.activeElement?.id || document.activeElement?.tagName');
  const $ = (k) => `[data-key="${k}"]`;

  // 上一轮取消的结果会在页面载入时自动展开面板，此时不能再点一次按钮
  const openUpdates = async () => {
    if (await run('document.querySelector("#update-panel").hidden')) await click('#update');
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await viewport(1920, 1080);

  // 0 首次使用：没有数据时只给出取数命令
  await open();
  ok(0, '无数据时显示取数命令', await run('document.querySelector("#no-data")?.textContent.includes("python3 -I scripts/update_data.py")'));
  ok(0, '无数据时不提供页面内抓取', await run('getComputedStyle(document.querySelector("#update")).display === "none"'));
  ok(0, '打开页面不会触发抓取', await run('fetch("/api/status").then((r) => r.json()).then((s) => s.job.state === "idle")'));
  await send('Page.navigate', { url: pathToFileURL(join(copy, 'index.html')).href });
  await sleep(900);
  ok(0, '双击打开时命令带完整路径', await run(`document.querySelector('#no-data code')?.textContent.includes(${JSON.stringify(join(copy, 'scripts', 'update_data.py'))})`));
  await open();
  cpSync(join(seeded, 'data'), join(copy, 'data'), { recursive: true });
  await click('#reload');
  await sleep(700);
  ok(0, '拿到数据后刷新即可使用', await run('AA.rows.length > 50 && !document.querySelector("#update").hidden'));

  // 3 取消按钮
  for (const hold of [120, 450, 800, 1200, 1700]) {
    await open();
    await openUpdates();
    await click('#update-start');
    await sleep(1000);
    await click('#update-cancel', hold);
    let cancelled = false;
    for (let i = 0; i < 20 && !cancelled; i++) {
      await sleep(150);
      cancelled = await run('fetch("/api/status").then((r) => r.json()).then((s) => s.job.state === "cancelled")');
    }
    ok(3, `按住 ${hold}ms 再抬起也能取消`, cancelled);
    if (!cancelled) {
      await run('fetch("/api/cancel", { method: "POST", headers: { "X-Score-Trends": "1" } }).then(() => 1)');
      await sleep(700);
    }
  }
  await open();
  await openUpdates();
  await click('#update-start');
  await sleep(900);
  await run('window.__cancel = document.querySelector("#update-cancel"); 1');
  const count = await run('document.querySelector("#update-count").textContent');
  await sleep(2200);
  const later = await run('document.querySelector("#update-count")?.textContent');
  ok(3, '进度在走', !!count && count !== later, {
    count, later,
    button: await run('document.querySelector("#update").innerText'),
    panel: await run('document.querySelector("#update-panel").innerText'),
    job: await run('fetch("/api/status").then((r) => r.json()).then((s) => s.job)'),
  });
  ok(3, '按钮节点保持不变', await run('!!window.__cancel && window.__cancel === document.querySelector("#update-cancel")'));
  await click('#update-cancel');
  await sleep(800);

  // 4 连续填写
  await open({ view: 'pick' });
  await fill($('tasks'), '500');
  await fill($('budget'), '200');
  ok(4, '点进下一个框后仍有焦点', await focused() === 'budget', await focused());
  await key('Enter', 13);
  let s = await state();
  ok(4, '两个框的值都生效', s.tasks === 500 && s.budget === 200, [s.tasks, s.budget]);

  await open({ view: 'pick' });
  await fill($('tasks'), '700');
  await key('Tab', 9);
  ok(4, 'Tab 进入下一个框', await focused() === 'budget', await focused());
  await type('300');
  await key('Tab', 9);
  s = await state();
  ok(4, 'Tab 选中的原值被替换而不是追加', s.tasks === 700 && s.budget === 300, [s.tasks, s.budget]);
  await key('Tab', 9, 8);
  ok(4, 'Shift+Tab 可返回', await focused() === 'budget', await focused());

  for (const [name, selector, check] of [
    ['左侧导航', '[data-view="table"]', (x) => x.view === 'table'],
    ['右侧图钉', '[data-model="test-terra"] .pin', (x) => x.pins.includes('test-terra')],
    ['右侧隐藏', '[data-model="test-terra"] .eye', (x) => x.hidden.includes('test-terra')],
  ]) {
    await open({ view: 'pick' });
    await fill($('tasks'), '640');
    await click(selector, 350);
    s = await state();
    ok(4, `填完直接点${name}，两者都生效`, s.tasks === 640 && check(s), s.tasks);
  }

  await open({ view: 'pick', tasks: 1000 });
  await fill($('tasks'), '2000');
  await click('[data-pick="最聪明"]');
  ok(4, '填完直接点推荐卡片', await run('!document.querySelector("#drawer").hidden') && (await state()).tasks === 2000);

  await open();
  await click('[data-pop="ranges"]');
  await fill($('range:iq:0'), '20');
  await fill($('range:iq:1'), '55');
  ok(4, '下限点到上限仍有焦点', await focused() === 'range:iq:1', await focused());
  await key('Enter', 13);
  s = await state();
  ok(4, '上下限都生效', JSON.stringify(s.ranges.iq) === '[20,55]', s.ranges);

  await open();
  await click('[data-pop="ranges"]');
  await fill($('range:iq:0'), '20');
  await key('Tab', 9);
  ok(4, '范围内 Tab 到上限', await focused() === 'range:iq:1', await focused());

  await open();
  await click('[data-pop="ranges"]');
  await fill($('range:iq:0'), '25');
  await click('[data-model="test-atlas-prime"] .pin', 350);
  s = await state();
  ok(4, '填完范围点弹层外按钮，两者都生效', s.ranges.iq?.[0] === 25 && s.pins.includes('test-atlas-prime'), [s.ranges, s.pins]);

  await open();
  await click('[data-pop="ranges"]');
  await fill($('range:iq:0'), '25');
  await key('Escape', 27);
  ok(4, 'Esc 关闭时不丢已输入的值', (await state()).ranges.iq?.[0] === 25);

  await open({ ranges: { cost: [null, 5] } });
  await click('[data-pop="ranges"]');
  await fill($('range:iq:0'), '30');
  await click('#chips .chip');
  s = await state();
  ok(4, '填完再删别的筛选，不覆盖刚填的值', s.ranges.iq?.[0] === 30 && !s.ranges.cost, s.ranges);

  await open({ view: 'pick' });
  await fill($('tasks'), '777');
  await click('#undo');
  ok(4, '填完直接点撤销', (await state()).tasks === 1000);

  await open({ vendors: ['OpenAI'] });
  await click('#search');
  await type('test');
  await click('#chips .chip', 350);
  s = await state();
  ok(4, '搜索防抖期间点标签不丢点击', s.q === 'test' && !s.vendors.length, [s.q, s.vendors]);

  await open();
  await click('[data-pop="models"]');
  await click('#pop .pop-search');
  await type('nova');
  await click('[data-key="models:test-nova"]');
  ok(4, '勾选后弹层搜索词仍在', await run('document.querySelector("#pop .pop-search").value === "nova"'));
  await run('AA.load({}); 1');
  await sleep(150);
  ok(4, '外部改状态时控件同步', await run('!document.querySelector(\'[data-key="models:test-nova"]\').checked'));

  // 浏览器吞掉 pointerup 时（日期选择器、滚动条、拖出窗口）不能卡住重绘
  const lostRelease = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 1`);
  await open({ view: 'pick' });
  await fill($('tasks'), '4321');
  await lostRelease('#options');
  await key('Enter', 13);
  ok(4, '丢失 pointerup 后回车仍会刷新', await run('document.querySelector(".pick-note").textContent.includes("$0.23")'));

  await open();
  await click('[data-pop="date"]');
  await lostRelease($('from'));
  await run(`(() => { const e = document.querySelector('[data-key="from"]'); e.value = '2026-11-10'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  ok(4, '日期选择器选完立即刷新', await run('document.querySelector("#chips").textContent.includes("2026-11-10")'));

  await open({ view: 'pick' });
  await fill($('tasks'), '4321');
  await lostRelease('#options');
  await run(`document.querySelector('[data-key="tasks"]').blur(); 1`);
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 500, buttons: 0 });
  await sleep(150);
  ok(4, '未按键的鼠标移动会解除等待', await run('document.querySelector(".pick-note").textContent.includes("$0.23")'));

  await open();
  await run('document.querySelector("#panel-list").scrollTop = 700; 1');
  await run('AA.set({ vendors: AA.vendors.map((v) => v.name) }); 1');
  await sleep(120);
  ok(7, '右侧模型列表重绘不跳顶', await run('document.querySelector("#panel-list").scrollTop > 600'));

  // 9 搜索后的全选与反选
  await open();
  await click('[data-pop="models"]');
  await click('#pop .pop-search');
  await type('model 1');
  const shown = await run('[...document.querySelectorAll("#pop .check")].filter((e) => !e.hidden).length');
  await click('#pop .pop-actions button:nth-child(1)');
  ok(9, '搜索后全选只选可见项', shown > 1 && (await state()).models.length === shown, (await state()).models.length);
  await click('#pop .pop-actions button:nth-child(2)');
  ok(9, '搜索后反选只翻转可见项', (await state()).models.length === 0);
  await open({ models: ['test-nova'] });
  await click('[data-pop="models"]');
  await click('#pop .pop-search');
  await type('model 1');
  await click('#pop .pop-actions button:nth-child(1)');
  ok(9, '全选保留不可见项原来的选择', (await state()).models.includes('test-nova'));

  // 10 缺值不能说成“无增益”
  await open({ view: 'step', models: ['test-nova'] });
  await run(`(() => { AA.groups.get('test-nova').forEach((r, i) => { r.minutes = null; r.iq = 30 + 5 * i; }); AA.set({ stepSort: 'gain' }); })()`);
  await sleep(150);
  ok(10, '缺少耗时显示“—”', await run('(() => { const t = document.querySelector("#stage svg").textContent; return !t.includes("无增益") && t.includes("—"); })()'));
  await open({ view: 'pick', tasks: 0 });
  ok(10, '任务数为 0 时不显示每月花费', await run('!document.querySelector(".pick-cards").textContent.includes("每月约")'));

  // 11 链接里的正则
  for (const q of ['/([A-Za-z0-9 ._-]+)+$x/', '/(.*)*$x/', '/.*.*.*.*.*$x/', `/${'(?:.|.)'.repeat(26)}$x/`, '/(.)\\1+$x/']) {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: `${base}#s=${encodeURIComponent(JSON.stringify({ q }))}` });
    await sleep(1800);
    const reply = await Promise.race([run('document.querySelector("#search")?.getAttribute("aria-invalid")'), sleep(2500).then(() => 'frozen')]);
    ok(11, `拒绝高回溯正则 ${q.slice(0, 26)}`, reply === 'true', reply);
    if (reply === 'frozen') {
      await send('Runtime.terminateExecution');
      await send('Page.navigate', { url: 'about:blank' });
    }
  }
  for (const q of ['/model [12]\\d/', '/^test.*max/', '/(atlas|nova).*high/', '/nova|luna|comet/', '/atlas.+xhigh?/']) {
    await open({ q });
    ok(11, `常用正则仍可用 ${q}`, await run('document.querySelector("#search").getAttribute("aria-invalid") === "false" && AA.filter().length > 0'));
  }

  // 12 自动载入不丢正在输入的内容
  for (const [label, selector, text, check] of [
    ['数值框', $('tasks'), '2500', (x) => x.tasks === 2500],
    ['搜索框', '#search', 'nova', (x) => x.q === 'nova'],
  ]) {
    await open({ view: 'pick' });
    await openUpdates();
    await click('#update-start');
    await sleep(800);
    await fill(selector, '');
    await run('window.__beforeReload = true; 1');
    writeFileSync(join(copy, 'scripts', 'finish'), '');
    await type(text);
    let reloaded = false;
    for (let i = 0; i < 40 && !reloaded; i++) {
      await sleep(150);
      reloaded = await run('!window.__beforeReload && !!window.AA?.ui?.chart');
    }
    await sleep(200);
    ok(12, `更新完成时保留${label}里正在输入的值`, reloaded && check(await state()));
  }

  // 6 抽屉与弹层并存
  await open();
  await run('AA.ui.details("test-nova"); 1');
  await click('[data-pop="vendors"]');
  await click($('vendors:OpenAI'));
  ok(6, '勾选一项后弹层仍开着', await run('!document.querySelector("#pop").hidden'));
  await click($('vendors:Google'));
  s = await state();
  ok(6, '可以连续多选', s.vendors.length === 2, s.vendors);
  ok(6, '抽屉也仍开着', await run('!document.querySelector("#drawer").hidden'));
  await click('#detail-pin');
  ok(6, '抽屉内容随状态刷新', (await run('document.querySelector("#detail-pin").textContent')) === '取消固定');

  // 7 滚动
  await open({ view: 'table' });
  await run('document.querySelector("#stage").scrollTop = 1500; 1');
  await sleep(100);
  let top = await run('document.querySelector("#stage").scrollTop');
  await click('[data-model] .pin');
  ok(7, '固定模型后表格不跳顶', top > 500 && Math.abs(top - await run('document.querySelector("#stage").scrollTop')) < 3, top);
  await viewport(1700, 1000);
  ok(7, '改窗口大小后不跳顶', Math.abs(top - await run('document.querySelector("#stage").scrollTop')) < 3);
  await viewport(1920, 1080);

  await run('AA.set({ cols: [...AA.metrics.keys()].slice(0, 30) }); 1');
  await sleep(150);
  await run('document.querySelector("#stage").scrollLeft = 1400; 1');
  await sleep(100);
  const left = await run('document.querySelector("#stage").scrollLeft');
  const column = await run(`(() => { const r = document.querySelector('#stage').getBoundingClientRect();
    return [...document.querySelectorAll('.full-table th.num button')].find((b) => { const x = b.getBoundingClientRect(); return x.left > r.left + 420 && x.right < r.right - 20; })?.dataset.sort; })()`);
  await click(`[data-sort="${column}"]`);
  ok(7, '右侧列排序后不跳回最左', left > 500 && Math.abs(left - await run('document.querySelector("#stage").scrollLeft')) < 3, left);

  for (const view of ['range', 'rank', 'cost', 'facet']) {
    await open({ view, metric: 'cost' });
    await run('document.querySelector("#stage").scrollTop = 600; 1');
    top = await run('document.querySelector("#stage").scrollTop');
    await run('AA.set({ pins: ["test-nova"] }); 1');
    await sleep(120);
    ok(7, `${view} 长图不跳顶`, top > 100 && Math.abs(top - await run('document.querySelector("#stage").scrollTop')) < 3, top);
  }
  await run('AA.set({ view: "table" }); 1');
  await sleep(120);
  ok(7, '切换视图时归零', await run('document.querySelector("#stage").scrollTop === 0'));

  // 8 窄屏
  await open();
  await click('#panel-close');
  for (const [width, height] of [[1101, 700], [1100, 700], [900, 700], [761, 700], [760, 700], [390, 844], [360, 640]]) {
    await viewport(width, height);
    const r = await run(`(() => { const main = document.querySelector('.main').getBoundingClientRect(), nav = document.querySelector('.views').getBoundingClientRect();
      return { left: main.left, width: main.width, bottom: main.bottom, navBottom: nav.bottom, top: main.top, stage: document.querySelector('#stage').clientHeight }; })()`);
    const good = width <= 760
      ? r.left < 12 && r.width > width - 24 && r.top >= r.navBottom - 1 && r.bottom > height - 16 && r.stage >= 200
      : r.left >= 110 && r.width > width - 170;
    ok(8, `收起列表后 ${width}px 布局正确`, good, r);
  }
  await click('#focus');
  for (const [width, height] of [[390, 844], [360, 640]]) {
    await viewport(width, height);
    const r = await run("(() => { const m = document.querySelector('.main').getBoundingClientRect(); return { width: m.width, bottom: m.bottom, stage: document.querySelector('#stage').clientHeight }; })()");
    ok(8, `专注模式 ${width}px 占满`, r.width > width - 24 && r.bottom > height - 16 && r.stage >= 250, r);
  }
  await click('#focus');
  await click('#panel-toggle');
  ok(8, '窄屏仍能再打开列表', await run('getComputedStyle(document.querySelector("#panel")).display !== "none"'));

  // 图表全量检查
  await viewport(1920, 1080);
  await send('Page.navigate', { url: `${base}tests/index.html` });
  let report = null;
  for (let i = 0; i < 420 && !report; i++) {
    await sleep(1000);
    report = await run('window.E2E ? { total: E2E.total, failed: E2E.failed.slice(0, 20), count: E2E.failed.length } : null');
  }
  ok('e2e', `图表全量检查 ${report?.total ?? 0} 项`, report?.total > 2000 && !report.count, report || '超时');

  ok('-', '没有脚本错误', !errors.length, errors);
  ws.close();
} catch (err) {
  ok('-', '测试未中断', false, err.stack);
} finally {
  const exited = (p) => (p.exitCode !== null ? null : new Promise((r) => p.once('exit', r)));
  const waits = [exited(child), exited(server)];
  child.kill();
  server.kill();
  await Promise.all(waits); // 临时目录留给系统清理
}
console.log(`TOTAL ${results.filter(Boolean).length}/${results.length}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
