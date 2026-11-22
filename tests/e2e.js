/* 图表端到端检查：由 tests/browser.mjs 在装有虚构数据的副本里运行，无第三方依赖。 */
(async () => {
  'use strict';
  const frame = document.getElementById('app');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const errors = [];
  const ok = (name, pass, info = '') => results.push({ name, pass: !!pass, info: pass ? '' : String(info).slice(0, 400) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const savedStorage = ['aa.saved', 'aa.theme'].map((k) => [k, localStorage.getItem(k)]);
  let w; let d; let A;

  async function open(hash = '', width = 1920, height = 1080) {
    // 取消待写入的 URL，避免它与本次导航竞争
    if (A) A.flushUrl();
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    const loaded = new Promise((r) => { frame.onload = r; });
    frame.src = `../index.html?t=${Math.random()}${hash}`;
    await loaded;
    w = frame.contentWindow; d = w.document; A = w.AA;
    w.addEventListener('error', (e) => errors.push(e.message));
    w.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
    await sleep(120);
  }
  const $ = (q) => d.querySelector(q);
  const $$ = (q) => [...d.querySelectorAll(q)];
  const reset = (patch = {}) => A.load(patch);
  const change = (node, value) => {
    if (node.type === 'checkbox') node.checked = value; else node.value = value;
    node.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  const pointer = (type, node, x, y, more = {}) => {
    const r = node.getBoundingClientRect();
    node.dispatchEvent(new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: r.left + x, clientY: r.top + y, ...more }));
  };
  const badGeometry = () => {
    for (const node of $$('#stage svg *')) {
      for (const a of node.attributes) {
        if (/NaN|Infinity|undefined/.test(a.value)) return `${node.tagName} ${a.name}=${a.value}`;
        if (['width', 'height', 'r'].includes(a.name) && Number(a.value) < 0) return `${node.tagName} ${a.name}=${a.value}`;
      }
    }
    return /NaN|Infinity|undefined/.test($('#stage').textContent) ? '文本中有无效值' : '';
  };
  // 所有视图、所有指标都必须满足：等距 = 等差；从 0 起时 10 倍数值 = 10 倍距离
  const badScale = () => {
    for (const panel of A.ui.chart().panels || []) {
      for (const scale of [panel.sx, panel.sy]) {
        if (!scale || scale.categories) continue;
        const { from, to, pos, ticks } = scale;
        const near = (p, q) => Math.abs(p - q) < 1e-5;
        const length = pos(to) - pos(from);
        for (const f of [0.1, 0.25, 0.5, 0.75]) {
          if (!near(pos(from + (to - from) * f) - pos(from), f * length)) return '刻度不是线性';
        }
        for (let i = 2; i < ticks.length; i++) {
          if (!near(ticks[i].p - ticks[i - 1].p, ticks[1].p - ticks[0].p)) return '刻度线间距不相等';
        }
        if (scale.zero) {
          if (from > 0) return '比率轴没有从 0 起';
          if (from === 0 && !near(length, 10 * (pos(to / 10) - pos(0)))) return '10 倍数值不等于 10 倍距离';
        }
      }
    }
    return '';
  };
  const safely = (name, run) => {
    try { run(); const bad = badGeometry() || badScale(); ok(name, !bad, bad); } catch (e) { ok(name, false, e.stack); }
  };

  try {
    await open();
    reset();
    // 数据与主图几何
    const costed = A.rows.filter((r) => r.cost !== null);
    const groups = A.groupBy(costed);
    ok('数据：ID 唯一', new Set(A.rows.map((r) => r.id)).size === A.rows.length);
    ok('数据：条数与元信息一致', A.rows.length === A.meta.ranked && costed.length === A.meta.plottable);
    for (const r of costed) {
      const p = r.costParts;
      ok(`成本构成合计：${r.label}`, p && Math.abs(p.nonCacheInput + p.cacheRead + p.cacheWrite + p.reasoning + p.answer - r.cost) < 1e-6, JSON.stringify(p));
    }
    let chart = A.ui.chart();
    const { panels } = chart;
    ok('主图：全程图含所有有价格的配置', panels[0].hits.length === costed.length, panels[0].hits.length);
    ok('主图：拥挤时展开局部图', panels.length >= 2);
    ok('主图：每张分图连线段数 = 点数 - 模型数', $$('#stage g.series:not(.plot-label) > line').length === (costed.length - groups.size) * panels.length);
    // 不借用页面的比例尺，用公式独立计算每个点应在的像素位置
    const maxCost = Math.max(...costed.map((r) => r.cost));
    const maxIq = Math.max(...costed.map((r) => r.iq));
    panels.forEach((panel, i) => {
      const top = panel.limit.x ?? maxCost * 1.05;
      const { l, r, t, b } = panel.box;
      ok(`分图 ${i}：点数等于范围内的配置数`, panel.hits.length === costed.filter((row) => row.cost <= top).length);
      for (const p of panel.hits) {
        const x = l + (p.row.cost / top) * (r - l);
        const y = b - (p.row.iq / (maxIq * 1.05)) * (b - t);
        ok(`线性坐标 ${i}：${p.row.label}`, Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6);
      }
    });
    // 再从真正画出来的 SVG 圆点反查一次
    reset({ shapes: false, frontier: false });
    const drawn = $$('#stage g.series > circle').map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
    ok('实际绘制的点与计算位置一致', A.ui.chart().hits.every((p) => drawn.some((c) => Math.abs(c[0] - p.x) < 0.01 && Math.abs(c[1] - p.y) < 0.01)));
    reset();
    chart = A.ui.chart();
    for (const s of chart.panels[0].series) ok(`连线顺序：${s.group}`, s.pts.every((p, i) => !i || (s.pts[i - 1].row.rank ?? 99) <= (p.row.rank ?? 99)));

    // 前沿与暴力算法对照
    const ids = [...A.metrics.keys()];
    const core = ['iq', 'cost', 'minutes', 'speed', 'ttft', 'value', 'released', 'context'];
    for (const x of core) for (const y of core) {
      if (x === y) continue;
      const mx = A.metrics.get(x); const my = A.metrics.get(y);
      const pts = A.rows.map((r) => [A.value(mx, r), A.value(my, r)]).filter((p) => p[0] !== null && p[1] !== null);
      const brute = new Set(pts.filter((p) => !pts.some((q) => (q[0] - p[0]) * mx.good >= 0 && (q[1] - p[1]) * my.good >= 0 && (q[0] !== p[0] || q[1] !== p[1]))).map(String));
      const fast = new Set(A.frontier(A.rows, mx, my).map((p) => String([p.x, p.y])));
      ok(`前沿：${x}/${y}`, brute.size === fast.size && [...brute].every((p) => fast.has(p)));
    }

    // 视图 × 主题 × 宽度
    const views = A.VIEWS.flatMap((g) => g[1].map((v) => v[0]));
    for (const theme of ['light', 'dark']) {
      A.theme = A.THEMES[theme];
      d.documentElement.dataset.theme = theme;
      for (const view of views) for (const pins of [[], ['test-atlas-prime', 'test-nova'].filter((g) => A.groups.has(g))]) {
        safely(`视图：${view}/${theme}/${pins.length}`, () => reset({ view, pins }));
      }
    }
    // 所有指标
    for (const id of ids) {
      safely(`横轴：${id}`, () => reset({ x: id }));
      safely(`纵轴：${id}`, () => reset({ y: id }));
      safely(`点大小：${id}`, () => reset({ size: id }));
      for (const view of ['time', 'effort', 'range', 'matrix', 'rank']) safely(`${view} 指标：${id}`, () => reset({ view, metric: id }));
    }
    // 所有下拉选项，通过真实控件触发
    for (const view of views) {
      reset({ view, pins: ['test-atlas-prime'].filter((g) => A.groups.has(g)) });
      for (const key of $$('#options select').map((n) => n.dataset.key).filter((k2) => !['x', 'y', 'metric', 'compareAdd'].includes(k2))) {
        for (const value of [...$(`#options [data-key="${key}"]`).options].map((o) => o.value)) {
          safely(`选项：${view}/${key}=${value}`, () => change($(`#options [data-key="${key}"]`), value));
          ok(`选项生效：${view}/${key}=${value}`, A.state[key] === value);
        }
      }
    }
    reset();
    $('[data-pop="display"]').click();
    for (const key of [...d.querySelectorAll('#pop select')].map((n) => n.dataset.key)) {
      for (const value of [...$(`#pop [data-key="${key}"]`).options].map((o) => o.value)) {
        safely(`显示设置：${key}=${value}`, () => change($(`#pop [data-key="${key}"]`), value));
        ok(`显示设置生效：${key}=${value}`, A.state[key] === value);
      }
      A.set({ [key]: A.DEFAULTS[key] });
    }
    for (const key of $$('#pop input[type=checkbox]').map((n) => n.dataset.key)) {
      for (let i = 0; i < 2; i++) {
        const before = A.state[key];
        safely(`开关：${key}`, () => change($(`#pop [data-key="${key}"]`), !before));
        ok(`开关生效：${key}`, A.state[key] === !before);
      }
    }
    $('[data-pop="display"]').click();

    // 筛选：与独立判断逐项对照
    const set = (list) => list.map((r) => r.id).sort();
    const check = (name, patch, predicate) => {
      safely(`筛选渲染：${name}`, () => reset(patch));
      ok(`筛选结果：${name}`, same(set(A.filter()), set(A.rows.filter(predicate))));
    };
    for (const v of A.vendors) check(`厂商 ${v.name}`, { vendors: [v.name] }, (r) => r.vendor === v.name);
    for (const g of A.groups.keys()) check(`模型 ${g}`, { models: [g] }, (r) => r.group === g);
    for (const e of A.EFFORTS) check(`档位 ${e.id}`, { efforts: [e.id] }, (r) => r.effort === e.id);
    check('单档', { efforts: ['single'] }, (r) => !r.effort);
    check('开放权重', { weights: ['open'] }, (r) => r.open);
    check('闭源', { weights: ['closed'] }, (r) => !r.open);
    for (const v of ['us', 'cn', 'other']) check(`地区 ${v}`, { regions: [v] }, (r) => r.region === v);
    for (const v of ['tiny', 'small', 'medium', 'large', 'unknown']) check(`规模 ${v}`, { sizes: [v] }, (r) => r.size === v);
    for (const v of ['low', 'medium', 'high', 'unknown']) check(`单价 ${v}`, { priceClasses: [v] }, (r) => r.priceClass === v);
    check('推理', { reasoning: ['yes'] }, (r) => r.reasoning);
    check('非推理', { reasoning: ['no'] }, (r) => !r.reasoning);
    check('图像', { image: ['yes'] }, (r) => r.image === true);
    check('多档位', { levels: 'multi' }, (r) => A.levelCount(r.group) > 1);
    check('单档位', { levels: 'single' }, (r) => A.levelCount(r.group) <= 1);
    check('免费', { free: 'free' }, (r) => r.cost === 0);
    check('付费', { free: 'paid' }, (r) => r.cost > 0);
    check('日期', { from: '2026-10-01', to: '2026-10-31' }, (r) => r.released >= '2026-10-01' && r.released <= '2026-10-31');
    for (const days of [30, 60, 90, 180, 365]) {
      const end = Math.max(...A.rows.map((r) => r.date));
      check(`近 ${days} 天`, { days: String(days) }, (r) => r.date >= end - days * 864e5);
    }
    for (const id of A.RANGE_FILTERS) {
      const m = A.metrics.get(id); const vals = A.rows.map((r) => A.value(m, r)).filter((v) => v !== null).sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length / 4)]; const hi = vals[Math.floor(vals.length * 0.75)];
      check(`范围 ${id}`, { ranges: { [id]: [lo, hi] } }, (r) => A.value(m, r) !== null && A.value(m, r) >= lo && A.value(m, r) <= hi);
    }
    check('搜索：与', { q: 'atlas prime' }, (r) => /atlas prime/i.test(r.name));
    check('搜索：或', { q: 'atlas,luna' }, (r) => /atlas|luna/i.test(r.label));
    check('搜索：排除', { q: '-atlas' }, (r) => !/atlas/i.test(r.label));
    check('搜索：中文别名', { q: '智谱' }, (r) => r.vendor === 'Z AI');
    check('搜索：正则', { q: '/model [12]\\d/' }, (r) => /model [12]\d/i.test(r.name));
    check('组合', { vendors: ['OpenAI', 'Google'], efforts: ['high'], ranges: { cost: [null, 3] } },
      (r) => ['OpenAI', 'Google'].includes(r.vendor) && r.effort === 'high' && r.cost !== null && r.cost <= 3);
    for (const pick of ['default', 'top', 'best', 'cheap', 'value']) {
      reset({ pick });
      const g = A.groupBy(A.filter());
      ok(`代表档唯一：${pick}`, [...g.values()].every((x) => x.length === 1));
      for (const [id, [got]] of g) {
        const all = A.groups.get(id); const c = all.filter((r) => r.cost !== null);
        if (pick === 'best') ok(`最聪明档：${id}`, got.iq === Math.max(...all.map((r) => r.iq)));
        if (pick === 'cheap' && c.length) ok(`最便宜档：${id}`, got.cost === Math.min(...c.map((r) => r.cost)));
      }
    }
    for (const n of [5, 10, 15, 20]) { reset({ top: n }); ok(`前 ${n}`, A.groupBy(A.filter()).size === n); }
    for (const view of views) safely(`空结果：${view}`, () => reset({ view, q: '不存在的模型zzz' }));
    for (const view of views) safely(`单条结果：${view}`, () => reset({ view, models: [costed[0].group], pick: 'best' }));

    // 弹层与标签
    reset();
    for (const key of ['date', 'vendors', 'models', 'efforts', 'ranges', 'more', 'presets']) {
      $(`[data-pop="${key}"]`).click();
      ok(`弹层打开：${key}`, !$('#pop').hidden && $('#pop').children.length > 0);
      const r = $('#pop').getBoundingClientRect();
      ok(`弹层在屏内：${key}`, r.right <= w.innerWidth && r.bottom <= w.innerHeight);
      $(`[data-pop="${key}"]`).click();
    }
    $('[data-pop="vendors"]').click();
    change($('[data-key="vendors:OpenAI"]'), true);
    ok('勾选厂商并保持弹层', same(A.state.vendors, ['OpenAI']) && !$('#pop').hidden);
    $('[data-key="only:vendors:Google"]').click();
    ok('仅此', same(A.state.vendors, ['Google']));
    $('#chips .chip').click();
    ok('移除筛选标签', !A.state.vendors.length && $('#chips').hidden);
    reset();
    $('[data-pop="ranges"]').click();
    change($('[data-key="range:cost:1"]'), '1');
    ok('范围输入', same(A.state.ranges.cost, [null, 1]));
    await sleep(30); // 输入框提交后，画面在当前事件结束时才重绘
    $('#clear-filters').click();
    ok('全部清除', !Object.keys(A.state.ranges).length);
    $('[data-pop="ranges"]').click();
    $('[data-pop="presets"]').click();
    const presets = $$('#pop .presets button').length;
    $('[data-pop="presets"]').click();
    for (let i = 0; i < presets; i++) {
      $('[data-pop="presets"]').click();
      safely(`预设 ${i}`, () => $$('#pop .presets button')[i].click());
      ok(`预设有结果 ${i}`, A.filter().length > 0);
    }
    reset();
    $('#search').value = 'comet'; $('#search').dispatchEvent(new w.Event('input'));
    await sleep(200);
    ok('搜索框', A.state.q === 'comet' && A.filter().length > 0 && A.filter().every((r) => /comet/i.test(r.label)));
    $('#search').value = '/[/'; $('#search').dispatchEvent(new w.Event('input'));
    await sleep(200);
    ok('无效正则有提示', $('#search').getAttribute('aria-invalid') === 'true');

    // 指针交互
    reset(); await sleep(60);
    chart = A.ui.chart();
    for (const p of chart.hits) {
      pointer('pointermove', chart.svg, p.x, p.y);
      const shown = $('#tip .tip-head b')?.textContent;
      ok(`悬停：${p.row.label}`, !$('#tip').hidden && chart.hits.some((q) => q.row.label === shown && Math.hypot(q.x - p.x, q.y - p.y) < 1e-6), shown);
      const r = $('#tip').getBoundingClientRect();
      ok(`提示不出屏：${p.row.label}`, r.left >= 0 && r.top >= 0 && r.right <= w.innerWidth && r.bottom <= w.innerHeight);
    }
    let p = chart.hits.find((h) => h.row.effort === 'max') || chart.hits[0];
    pointer('pointerdown', chart.svg, p.x, p.y); pointer('pointerup', chart.svg, p.x, p.y);
    ok('单击打开详情', !$('#drawer').hidden);
    $('#drawer-close').click();
    ok('关闭详情', $('#drawer').hidden);
    pointer('pointerdown', chart.svg, p.x, p.y, { metaKey: true }); pointer('pointerup', chart.svg, p.x, p.y, { metaKey: true });
    ok('修饰键单击固定', A.pinned().length === 1);

    reset({ pins: [...groups.keys()].slice(0, 3) });
    const third = A.state.pins[2]; const color = A.color(A.groups.get(third)[0]);
    A.pin(A.state.pins[0]);
    ok('取消固定不改其他颜色', A.color(A.groups.get(third)[0]) === color);
    reset({ pins: [...groups.keys()].slice(0, 8) });
    ok('最多固定 8 个', A.pin([...groups.keys()][8]) === false);

    // 不允许缩放
    reset(); await sleep(60);
    chart = A.ui.chart();
    const positions = () => JSON.stringify(A.ui.chart().hits.map((h) => [h.x, h.y]));
    const before = positions();
    pointer('pointerdown', chart.svg, 300, 120); pointer('pointermove', chart.svg, 420, 200); pointer('pointerup', chart.svg, 420, 200);
    ok('拖动不改变比例', positions() === before);
    ok('拖动不会误开详情', $('#drawer').hidden);
    chart.svg.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    chart.svg.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    await sleep(80);
    ok('滚轮与双击不改变比例', positions() === before);
    ok('没有缩放与刻度切换控件', !$('#zoom-in') && !$('[data-key="xscale"]') && !$('[data-key="yscale"]'));
    reset({ xscale: 'log', yscale: 'log', xr: [1, 2] });
    ok('旧链接中的对数与缩放参数被忽略', !('xscale' in A.state) && !('xr' in A.state) && !badScale());
    reset();
    chart = A.ui.chart();
    const shared = chart.hits.find((h) => chart.hits.filter((q) => q.row.id === h.row.id).length > 1);
    pointer('pointermove', chart.svg, shared.x, shared.y);
    ok('分图联动高亮', $$('#stage .overlay circle').length >= 2);
    // 条形长度与数值成正比
    for (const metric of ['cost', 'minutes', 'iq', 'value']) {
      reset({ view: 'rank', metric });
      const columns = new Map();
      for (const bar of $$('[data-bar]')) {
        const v = Number(bar.dataset.bar);
        if (!(v > 0)) continue;
        const x = bar.getAttribute('x');
        if (!columns.has(x)) columns.set(x, []);
        columns.get(x).push(Number(bar.getAttribute('width')) / v);
      }
      ok(`条长成正比：${metric}`, columns.size > 0 && [...columns.values()].every((list) => list.every((v) => Math.abs(v / list[0] - 1) < 1e-6)));
    }
    reset(); $('#swap').click();
    ok('交换横纵轴', A.state.x === 'iq' && A.state.y === 'cost');
    reset(); chart = A.ui.chart(); chart.svg.focus();
    chart.svg.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    ok('键盘读点', !$('#tip').hidden);
    d.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: ']', bubbles: true }));
    ok('切换视图快捷键', A.state.view === 'facet');
    reset(); A.set({ vendors: ['OpenAI'] }); $('#undo').click();
    ok('撤销', !A.state.vendors.length);
    $('#redo').click();
    ok('重做', same(A.state.vendors, ['OpenAI']));
    reset(); $('[data-model] .eye').click();
    ok('隐藏模型', A.state.hidden.length === 1);
    reset();
    for (const button of $$('[data-view]').map((b) => b.dataset.view)) {
      $(`[data-view="${button}"]`).click();
      ok(`导航：${button}`, A.state.view === button && $('#stage').children.length > 0);
    }
    for (const g of A.groups.keys()) safely(`详情：${g}`, () => A.ui.details(g));
    $('#drawer-close').click();

    // 表格排序与选型
    for (const id of A.DEFAULTS.cols) for (const asc of [false, true]) {
      reset({ view: 'table', sort: id, asc });
      const vals = A.tableRows(A.filter()).map((r) => A.value(A.metrics.get(id), r)).filter((v) => v !== null);
      ok(`排序：${id}/${asc}`, vals.every((v, i) => !i || (asc ? vals[i - 1] <= v : vals[i - 1] >= v)));
    }
    reset({ view: 'table' }); $('[data-sort="cost"]').click();
    ok('表头排序', A.state.sort === 'cost');
    for (const [tasks, budget, minIq, maxMin] of [[1000, 1000, 30, 30], [100, 500, 50, 0], [0, 0, 0, 0], [10000, 100, 0, 5]]) {
      safely(`选型渲染 ${tasks}/${budget}`, () => reset({ view: 'pick', tasks, budget, minIq, maxMin }));
      const good = A.rows.filter((r) => r.cost !== null && (!tasks || r.cost <= budget / tasks) && r.iq >= minIq && (!maxMin || (r.minutes !== null && r.minutes <= maxMin)));
      const got = A.recommend(A.filter());
      ok(`选型最聪明 ${tasks}/${budget}`, !good.length || got.smart.iq === Math.max(...good.map((r) => r.iq)));
      ok(`选型最省 ${tasks}/${budget}`, !good.length || got.cheap.cost === Math.min(...good.map((r) => r.cost)));
    }

    // 导出：只生成内容，不触发下载
    for (const view of views.filter((v) => v !== 'table')) {
      reset({ view, pins: ['test-atlas-prime'].filter((g) => A.groups.has(g)) });
      const svg = A.ui.exportSVG();
      ok(`SVG：${view}`, svg && !new DOMParser().parseFromString(svg.text, 'image/svg+xml').querySelector('parsererror'));
      const png = await A.ui.exportPNG();
      ok(`PNG：${view}`, png && png.size > 5000);
    }
    reset({ vendors: ['OpenAI'] });
    ok('CSV 行数', A.ui.exportCSV().split('\r\n').length === A.filter().length + 1);
    ok('JSON 行数', JSON.parse(A.ui.exportJSON()).rows.length === A.filter().length);

    // 链接
    const state = { view: 'rank', metric: 'minutes', vendors: ['Google'], ranges: { iq: [20, null] }, pins: ['', 'test-nova'] };
    reset(state);
    A.flushUrl();
    const expected = JSON.stringify(A.state); const hash = w.location.hash;
    await open(hash);
    ok('链接完整恢复', JSON.stringify(A.state) === expected);
    for (const bad of ['#s=%', '#s=null', '#s=[]', '#s={"view":"x","top":-1,"pins":[5],"xr":["a",1]}', '#s={"__proto__":{"polluted":1}}',
      `#s=${encodeURIComponent(JSON.stringify({ q: '<img src=x onerror=alert(1)>', cols: ['bad'], models: ['nope'], ranges: { iq: 'x' }, sort: 'bad' }))}`]) {
      await open(bad);
      ok(`恶意或损坏链接：${bad.slice(0, 40)}`, $('#stage').children.length > 0 && !$('img') && !({}).polluted);
    }

    // 响应式：不横向溢出、标签不重叠
    for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [1024, 768], [800, 600], [768, 1024], [390, 844], [360, 640]]) {
      for (const view of views) {
        await open(`#s=${encodeURIComponent(JSON.stringify({ view }))}`, width, height);
        ok(`无横向溢出：${view}@${width}`, d.documentElement.scrollWidth <= w.innerWidth && d.body.scrollWidth <= w.innerWidth, d.body.scrollWidth);
        ok(`图区可见：${view}@${width}`, $('#stage').clientHeight >= 200, $('#stage').clientHeight);
        ok(`几何：${view}@${width}`, !badGeometry(), badGeometry());
        ok(`线性：${view}@${width}`, !badScale(), badScale());
        const svg = $('#stage svg.chart');
        if (svg) {
          const full = svg.getBoundingClientRect();
          const cut = [...svg.querySelectorAll('text')].find((node) => {
            const r = node.getBoundingClientRect();
            return r.left < full.left - 3 || r.right > full.right + 3;
          });
          ok(`文字不被裁切：${view}@${width}`, !cut, cut?.textContent);
        }
        if (['curve', 'effort', 'time', 'pick'].includes(view)) {
          const boxes = $$('.plot-label text').map((t) => [t.textContent, t.getBoundingClientRect()]);
          let clash = '';
          boxes.forEach(([a, p1], i) => boxes.slice(i + 1).forEach(([b, p2]) => {
            if (p1.left < p2.right - 2 && p1.right > p2.left + 2 && p1.top < p2.bottom - 3 && p1.bottom > p2.top + 3) clash = `${a} / ${b}`;
          }));
          ok(`标签不重叠：${view}@${width}`, !clash, clash);
          const named = $$('.plot-label[data-anchor]').map((g) => {
            const text = g.querySelector('text');
            const [ax, ay] = g.dataset.anchor.split(',').map(Number);
            return { ax, ay, name: text.textContent, x: Number(text.getAttribute('x')) - 3, y: Number(text.getAttribute('y')), w: A.textWidth(text.textContent, Number(text.getAttribute('font-size')), Number(text.getAttribute('font-weight'))) + 6, size: text.getAttribute('font-size') };
          });
          let swapped = '';
          named.forEach((a, i) => named.slice(i + 1).forEach((b) => {
            if (a.size === b.size && Math.abs(a.ax - b.ax) < 45 && Math.abs(a.ay - b.ay) > 1
              && a.x < b.x + b.w + 30 && b.x < a.x + a.w + 30 && (a.ay - b.ay) * (a.y - b.y) < 0) swapped = `${a.name} / ${b.name}`;
          }));
          ok(`标签顺序不颠倒：${view}@${width}`, !swapped, swapped);
        }
      }
    }
  } catch (e) {
    ok('测试中断', false, e.stack);
  }

  for (const [key, value] of savedStorage) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
  for (const e of errors) ok('页面错误', false, e);
  const failed = results.filter((r) => !r.pass);
  window.E2E = { total: results.length, failed };
  document.getElementById('summary').textContent = `${results.length - failed.length} / ${results.length} 通过`;
  document.getElementById('log').textContent = failed.map((r) => `失败  ${r.name}  ${r.info}`).join('\n');
})();
