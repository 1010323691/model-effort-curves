/* 数据、指标、状态与筛选。不操作界面。 */
(() => {
  'use strict';
  const AA = (window.AA = {});
  const payload = window.AA_DATA || { meta: { evalNames: {} }, rows: [] };
  AA.meta = payload.meta;

  // ---------- DOM 工具：来源文本一律走 textContent，不拼 HTML ----------
  function append(node, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
    }
    return node;
  }
  AA.h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined) continue;
      if (key === 'sync') {
        // 控件只建一次，状态变化时用它同步，见 ui.js 的 syncControls
        node.syncState = value;
        node.setAttribute('data-sync', '');
      } else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'style') for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
      else if (key in node && typeof value === 'boolean') node[key] = value;
      else if (key === 'value') node.value = value;
      else if (value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    return append(node, kids);
  };
  AA.s = (tag, attrs, ...kids) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
    }
    return append(node, kids);
  };

  // ---------- 档位 ----------
  AA.EFFORTS = [
    { id: 'non-reasoning', name: '非推理', short: 'NR' },
    { id: 'minimal', name: 'Minimal', short: 'min' },
    { id: 'low', name: 'Low', short: 'L' },
    { id: 'medium', name: 'Medium', short: 'M' },
    { id: 'high', name: 'High', short: 'H' },
    { id: 'xhigh', name: 'Xhigh', short: 'XH' },
    { id: 'max', name: 'Max', short: 'Max' },
  ].filter((e) => payload.rows.some((r) => r.effort === e.id));
  const effortById = new Map(AA.EFFORTS.map((e) => [e.id, e]));
  const cellOf = (r) => `${r.group}\n${r.effort || ''}`;
  const perCell = new Map();
  for (const r of payload.rows) perCell.set(cellOf(r), (perCell.get(cellOf(r)) || 0) + 1);
  // 同档位有多个配置时，只有原始后缀和原名能区分
  const shared = (r) => perCell.get(cellOf(r)) > 1;
  AA.effortName = (r) => (shared(r) ? r.suffix || r.name : effortById.get(r.effort)?.name || r.suffix || '单档');
  const labelOf = (r) => {
    if (shared(r)) return r.name;
    return r.effort || r.suffix ? `${r.model} · ${effortById.get(r.effort)?.name || r.suffix}` : r.model;
  };
  AA.rows = payload.rows.map((r) => ({
    ...r,
    label: labelOf(r),
    date: r.released ? Date.parse(`${r.released}T00:00:00Z`) : null,
  }));
  AA.byId = new Map(AA.rows.map((r) => [r.id, r]));
  AA.groups = new Map();
  for (const r of AA.rows) {
    if (!AA.groups.has(r.group)) AA.groups.set(r.group, []);
    AA.groups.get(r.group).push(r);
  }
  for (const list of AA.groups.values()) list.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  AA.modelName = (group) => AA.groups.get(group)?.[0].model || group;
  AA.levelCount = (group) => AA.groups.get(group).filter((r) => r.cost !== null).length;
  AA.defaultUnknown = (group) => AA.levelCount(group) > 1 && !AA.groups.get(group).some((r) => r.isDefault);
  AA.groupBy = (rows, key = (r) => r.group) => {
    const map = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return map;
  };
  AA.vendors = [...AA.groupBy(AA.rows, (r) => r.vendor)]
    .map(([name, rows]) => ({ name, count: rows.filter((r) => r.cost !== null).length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // ---------- 格式化 ----------
  const trim = (n, digits) => Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
  const F = (AA.fmt = {
    money(v) {
      if (v === 0) return '$0';
      const a = Math.abs(v);
      const digits = a < 0.01 ? 4 : a < 0.1 ? 3 : a < 1000 ? 2 : 0;
      return `${v < 0 ? '-' : ''}$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    },
    num(v) {
      const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    },
    big(v) {
      const a = Math.abs(v);
      if (a >= 1e6) return `${trim(v / 1e6, 2)}M`;
      if (a >= 1e3) return `${trim(v / 1e3, a >= 1e4 ? 0 : 1)}k`;
      return trim(v, a < 10 ? 2 : 0);
    },
    pct: (v) => `${(v * 100).toFixed(1)}%`,
    date: (v) => new Date(v).toISOString().slice(0, 10),
  });

  // ---------- 指标：good 为 -1 表示越低越好，+1 表示越高越好 ----------
  const metric = (id, name, cat, good, get, fmt, options = {}) =>
    ({ id, name, cat, good, get, fmt, tick: options.tick || fmt, interval: !!options.interval, unit: options.unit || '' });
  const ratio = (a, b) => (a !== null && a !== undefined && b > 0 ? a / b : null);
  const part = (key) => (r) => r.costParts?.[key] ?? null;
  const tickMoney = { unit: 'USD', tick: (v) => `$${Number(v.toPrecision(3))}` };
  const plainTick = (v) => Number(v.toPrecision(4)).toString();

  const list = [
    metric('iq', '智能指数', '核心', 1, (r) => r.iq, (v) => v.toFixed(1), { tick: plainTick }),
    metric('cost', '单任务价格', '核心', -1, (r) => r.cost, F.money, tickMoney),
    metric('minutes', '单任务耗时', '核心', -1, (r) => r.minutes, (v) => `${F.num(v)} 分`, { unit: '分钟', tick: plainTick }),
    metric('value', '每美元智能分', '效率', 1, (r) => ratio(r.iq, r.cost), F.num, { tick: F.big }),
    metric('costPerPoint', '每智能分花费', '效率', -1, (r) => (r.cost === null ? null : ratio(r.cost, r.iq)), F.money, tickMoney),
    metric('perMinute', '每分钟智能分', '效率', 1, (r) => ratio(r.iq, r.minutes), F.num, { tick: plainTick }),
    metric('speed', '输出速度', '性能', 1, (r) => r.speed, (v) => `${F.num(v)} t/s`, { unit: 'token/秒', tick: plainTick }),
    metric('ttft', '首个答案延迟', '性能', -1, (r) => r.ttft, (v) => `${F.num(v)} 秒`, { unit: '秒', tick: plainTick }),
    metric('context', '上下文窗口', '性能', 1, (r) => r.context, F.big, { unit: 'token' }),
    metric('tokens', '单任务输出 Token', '用量', -1, (r) => r.tokens, F.big),
    metric('tokensReasoning', '单任务推理 Token', '用量', -1, (r) => r.tokensReasoning, F.big),
    metric('tokensAnswer', '单任务答案 Token', '用量', -1, (r) => r.tokensAnswer, F.big),
    metric('priceIn', '输入单价', '价格', -1, (r) => r.priceIn, F.money, { ...tickMoney, unit: 'USD / 百万 token' }),
    metric('priceOut', '输出单价', '价格', -1, (r) => r.priceOut, F.money, { ...tickMoney, unit: 'USD / 百万 token' }),
    metric('priceHit', '缓存命中单价', '价格', -1, (r) => r.priceHit, F.money, { ...tickMoney, unit: 'USD / 百万 token' }),
    metric('priceWrite', '缓存写入单价', '价格', -1, (r) => r.priceWrite, F.money, { ...tickMoney, unit: 'USD / 百万 token' }),
    metric('costInput', '单任务输入费用', '价格', -1, part('input'), F.money, tickMoney),
    metric('costOutput', '单任务输出费用', '价格', -1, part('output'), F.money, tickMoney),
    metric('released', '发布日期', '其他', -1, (r) => r.date, F.date, { interval: true, tick: F.date }),
  ];

  const EXTRA_NAMES = {
    omniscience: 'AA-Omniscience 净得分',
    'omniscience-accuracy': 'Omniscience 准确率',
    'omniscience-non-hallucination': 'Omniscience 不幻觉率',
    'critpt-v2-hard': 'CritPt v2',
    'gdpval-aa-normalized': 'GDPval-AA',
    'healthbench-professional': 'HealthBench Professional',
  };
  AA.evalName = (key) => EXTRA_NAMES[key] || AA.meta.evalNames[key] || key;
  const scoreKeys = new Set(AA.rows.flatMap((r) => Object.keys(r.scores)));
  // 参与本版智能指数的评测，即成本按评测拆分时出现的那些
  AA.indexEvals = [...new Set(AA.rows.flatMap((r) => Object.keys(r.costByEval)))];
  for (const key of [...scoreKeys].sort((a, b) => AA.indexEvals.includes(b) - AA.indexEvals.includes(a) || a.localeCompare(b))) {
    const values = AA.rows.map((r) => r.scores[key]).filter((v) => typeof v === 'number');
    const fraction = values.every((v) => Math.abs(v) <= 1.5);
    list.push(metric(`score:${key}`, AA.evalName(key), AA.indexEvals.includes(key) ? '评测（指数组成）' : '评测（其他）', 1,
      (r) => r.scores[key] ?? null, fraction ? F.pct : F.num, {
        tick: fraction ? (n) => `${trim(n * 100, 1)}%` : plainTick,
        // Elo 类分数是等距量表，0 没有含义
        interval: !fraction && Math.max(...values) > 1000,
      }));
  }
  AA.metrics = new Map(list.map((m) => [m.id, m]));
  AA.value = (m, r) => {
    const v = m.get(r);
    return Number.isFinite(v) ? v : null;
  };
  AA.show = (m, v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : m.fmt(v));

  // ---------- 状态 ----------
  AA.VIEWS = [
    ['关系', [['curve', '价格-智能曲线'], ['facet', '分面小图'], ['time', '发布趋势']]],
    ['档位', [['effort', '档位走势'], ['step', '升档收益'], ['range', '档位跨度'], ['matrix', '档位热力图']]],
    ['成本与能力', [['rank', '指标排行'], ['cost', '成本拆解'], ['bench', '评测热力图']]],
    ['决策', [['pick', '预算选型'], ['compare', '模型对比']]],
    ['数据', [['table', '数据表']]],
  ];
  AA.RANGE_FILTERS = ['iq', 'cost', 'minutes', 'ttft', 'speed', 'context', 'priceIn', 'priceOut'];

  const metricIds = [...AA.metrics.keys()];
  const ENUMS = {
    view: AA.VIEWS.flatMap((g) => g[1].map((v) => v[0])),
    x: metricIds, y: metricIds, metric: metricIds, size: ['none', ...metricIds],
    levels: ['all', 'multi', 'single'],
    free: ['all', 'paid', 'free'],
    pick: ['all', 'default', 'top', 'best', 'cheap', 'value'],
    front: ['all', 'points', 'models'],
    days: ['all', '30', '60', '90', '180', '365'],
    focus: ['auto', 'one', 'off'],
    color: ['auto', 'vendor', 'effort', 'weights', 'region'],
    connect: ['effort', 'x', 'none'],
    nr: ['dash', 'detach', 'hide'],
    labels: ['auto', 'all', 'pins', 'none'],
    tiers: ['auto', 'all', 'none'],
    facetBy: ['model', 'vendor', 'region', 'weights'],
    relative: ['value', 'times', 'delta'],
    stepMode: ['adjacent', 'total'],
    stepSort: ['model', 'gain', 'cost', 'marginal'],
    costMode: ['parts', 'share', 'evals', 'tokens'],
    order: ['iq', 'cost', 'name'],
    benchScope: ['best', 'all'],
  };
  AA.DEFAULTS = Object.freeze({
    view: 'curve',
    q: '', vendors: [], models: [], hidden: [], efforts: [], weights: [], regions: [], sizes: [], priceClasses: [],
    reasoning: [], image: [], levels: 'all', free: 'all', pick: 'all', front: 'all', days: 'all', from: '', to: '',
    top: 0, ranges: {}, pins: [],
    x: 'cost', y: 'iq', focus: 'auto', xrev: false, yrev: false,
    color: 'auto', connect: 'effort', nr: 'dash', labels: 'auto', tiers: 'auto', size: 'none',
    frontier: true, defaults: false, arrows: false, shapes: true,
    facetBy: 'model', facetContext: true, metric: 'iq', relative: 'value',
    stepMode: 'adjacent', stepSort: 'model', costMode: 'parts', order: 'iq', benchScope: 'best',
    tasks: 1000, budget: 1000, minIq: 30, maxMin: 30,
    sort: 'iq', asc: false, cols: ['iq', 'cost', 'minutes', 'value', 'ttft', 'speed', 'context', 'priceIn', 'priceOut', 'released'],
  });
  AA.FILTER_KEYS = ['q', 'vendors', 'models', 'hidden', 'efforts', 'weights', 'regions', 'sizes', 'priceClasses',
    'reasoning', 'image', 'levels', 'free', 'pick', 'front', 'days', 'from', 'to', 'top', 'ranges'];

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const finiteOrNull = (v) => v === null || Number.isFinite(v);

  // 链接与本地存储都不可信：逐项检查类型与取值
  function sanitize(input) {
    const out = clone(AA.DEFAULTS);
    if (!input || typeof input !== 'object') return out;
    for (const [key, base] of Object.entries(AA.DEFAULTS)) {
      if (!Object.hasOwn(input, key)) continue;
      const v = input[key];
      if (ENUMS[key]) {
        if (ENUMS[key].includes(v)) out[key] = v;
      } else if (key === 'ranges') {
        for (const id of AA.RANGE_FILTERS) {
          const r = v?.[id];
          if (Array.isArray(r) && r.length === 2 && r.every(finiteOrNull) && r.some((n) => n !== null)) out.ranges[id] = [...r];
        }
      } else if (key === 'from' || key === 'to') {
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[key] = v;
      } else if (Array.isArray(base)) {
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = [...new Set(v.filter(Boolean))];
        if (key === 'pins' && Array.isArray(v)) out.pins = v.slice(0, 8).map((g) => (AA.groups.has(g) ? g : ''));
        if (key === 'cols') out.cols = out.cols.filter((id) => AA.metrics.has(id));
      } else if (typeof base === 'number') {
        if (Number.isFinite(v) && v >= 0) out[key] = v;
      } else if (typeof v === typeof base) {
        out[key] = v;
      }
    }
    if (out.sort !== 'name' && out.sort !== 'vendor' && !AA.metrics.has(out.sort)) out.sort = 'iq';
    return out;
  }
  AA.diff = (state = AA.state) =>
    Object.fromEntries(Object.entries(state).filter(([key, v]) => !same(v, AA.DEFAULTS[key])));
  AA.readHash = () => {
    try {
      return sanitize(JSON.parse(decodeURIComponent(location.hash.replace(/^#s=/, '')) || '{}'));
    } catch {
      return sanitize({}); // 链接被截断或改坏时回到默认视图
    }
  };
  AA.state = AA.readHash();

  const past = [];
  const future = [];
  AA.listeners = [];
  // 浏览器会限流 replaceState（Safari 超限时抛错），所以合并连续的写入
  let urlTimer;
  AA.flushUrl = () => {
    clearTimeout(urlTimer);
    urlTimer = undefined;
    const diff = AA.diff();
    const url = Object.keys(diff).length ? `#s=${encodeURIComponent(JSON.stringify(diff))}` : location.pathname + location.search;
    history.replaceState(null, '', url);
  };
  addEventListener('pagehide', () => { if (urlTimer) AA.flushUrl(); });
  function commit(next) {
    AA.state = next;
    clearTimeout(urlTimer);
    urlTimer = setTimeout(AA.flushUrl, 300);
    for (const fn of AA.listeners) fn();
  }
  AA.set = (patch) => {
    const next = sanitize({ ...AA.state, ...patch });
    if (same(next, AA.state)) return;
    past.push(AA.state);
    if (past.length > 100) past.shift();
    future.length = 0;
    commit(next);
  };
  AA.load = (diff) => AA.set({ ...clone(AA.DEFAULTS), ...diff });
  AA.undo = () => { if (past.length) { future.push(AA.state); commit(past.pop()); } };
  AA.redo = () => { if (future.length) { past.push(AA.state); commit(future.pop()); } };
  // 更新数据需要重新载入页面，撤销历史随之带过去；新数据里已不存在的值会被 sanitize 去掉
  AA.history = () => ({ past: past.slice(-100), future: future.slice(-100) });
  AA.restoreHistory = (saved) => {
    const read = (list) => (Array.isArray(list) ? list.slice(-100).map(sanitize) : []);
    past.splice(0, past.length, ...read(saved?.past));
    future.splice(0, future.length, ...read(saved?.future));
  };
  AA.canUndo = () => past.length > 0;
  AA.canRedo = () => future.length > 0;

  AA.toggle = (key, value) => {
    const current = AA.state[key];
    AA.set({ [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] });
  };
  AA.pinned = () => AA.state.pins.filter(Boolean);
  // 取消固定时留下空位，其他模型的颜色不会跟着变
  AA.pin = (group) => {
    const pins = [...AA.state.pins];
    const at = pins.indexOf(group);
    if (at >= 0) pins[at] = '';
    else {
      const gap = pins.indexOf('');
      if (gap >= 0) pins[gap] = group;
      else if (pins.length < 8) pins.push(group);
      else return false;
    }
    while (pins.length && !pins[pins.length - 1]) pins.pop();
    AA.set({ pins });
    return true;
  };

  // ---------- 搜索：空格=且，逗号=或，-词=排除，/正则/ ----------
  /**
   * 搜索词可以来自别人发来的链接，而 JS 的正则是回溯实现且无法中断，所以只放行有界的写法：
   * 不许给分组加量词、不许反向引用；量词最多 2 个，量词越多，允许的“|”越少。
   */
  function isBoundedPattern(source) {
    if (source.length > 100) return false;
    let quantifiers = 0;
    let branches = 0;
    let inClass = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') {
        i++;
        if (!inClass && /[1-9k]/.test(source[i] || '')) return false;
      } else if (inClass) {
        if (c === ']') inClass = false;
      } else if (c === '[') inClass = true;
      else if (c === '|') branches++;
      else if (c === '(' && source[i + 1] === '?') i++; // (?: 里的 ? 不是量词
      else if ('*+?{'.includes(c)) {
        if (source[i - 1] === ')' && source[i - 2] !== '\\') return false;
        quantifiers++;
        if (c === '{') {
          const close = source.indexOf('}', i);
          if (close < 0) return false;
          i = close;
        }
        if (source[i + 1] === '?') i++; // 非贪婪标记
      }
    }
    return quantifiers <= 2 && branches <= [8, 5, 2][quantifiers];
  }
  const ALIASES = {
    Anthropic: '克劳德', OpenAI: 'chatgpt', Google: '谷歌 deepmind', Meta: '脸书', Alibaba: '阿里 通义 千问',
    DeepSeek: '深度求索', SpaceXAI: 'xai 马斯克', 'Z AI': '智谱', Tencent: '腾讯 混元', Kimi: '月之暗面 moonshot',
    Xiaomi: '小米', MiniMax: '稀宇', StepFun: '阶跃星辰', InclusionAI: '蚂蚁', NVIDIA: '英伟达',
    'China Mobile': '中国移动', 'Joy Future Academy': '京东', Upstage: '韩国',
  };
  AA.matcher = (query) => {
    const text = (r) => `${r.label} ${r.name} ${effortById.get(r.effort)?.name || ''} ${r.vendor} ${ALIASES[r.vendor] || ''}`;
    const q = query.trim();
    if (!q) return () => true;
    const regex = /^\/(.+)\/$/.exec(q);
    if (regex) {
      if (!isBoundedPattern(regex[1])) return null;
      try {
        const re = new RegExp(regex[1], 'i');
        return (r) => re.test(text(r));
      } catch {
        return null;
      }
    }
    const any = q.toLowerCase().split(/[,，|]/).map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((a) => a.length);
    const isExclude = (t) => t.length > 1 && t.startsWith('-');
    const excluded = any.flat().filter(isExclude).map((t) => t.slice(1));
    const wanted = any.map((a) => a.filter((t) => !isExclude(t))).filter((a) => a.length);
    return (r) => {
      const t = text(r).toLowerCase();
      return !excluded.some((w) => t.includes(w)) && (!wanted.length || wanted.some((a) => a.every((w) => t.includes(w))));
    };
  };

  // ---------- 前沿：按 X 从优到劣扫描，保留让 Y 创新高的点 ----------
  AA.frontier = (rows, mx, my) => {
    const items = rows
      .map((r) => ({ r, x: AA.value(mx, r), y: AA.value(my, r) }))
      .filter((p) => p.x !== null && p.y !== null)
      .sort((a, b) => (b.x - a.x) * mx.good || (b.y - a.y) * my.good);
    const out = [];
    for (const p of items) if (!out.length || (p.y - out[out.length - 1].y) * my.good > 0) out.push(p);
    return out;
  };
  AA.dominators = (row, rows) => row.cost === null ? [] : rows.filter((r) =>
    r.cost !== null && r.cost <= row.cost && r.iq >= row.iq && (r.cost < row.cost || r.iq > row.iq));

  // ---------- 筛选 ----------
  const latest = Math.max(...AA.rows.map((r) => r.date || 0));
  const has = (list_, v) => !list_.length || list_.includes(v);
  AA.filter = (S = AA.state) => {
    const match = AA.matcher(S.q) || (() => true);
    const from = S.from ? Date.parse(S.from) : null;
    const to = S.to ? Date.parse(S.to) : null;
    const cutoff = S.days === 'all' ? null : latest - Number(S.days) * 864e5;
    const ranges = Object.entries(S.ranges);

    let rows = AA.rows.filter((r) => {
      if (!match(r) || S.hidden.includes(r.group)) return false;
      if (!has(S.vendors, r.vendor) || !has(S.models, r.group) || !has(S.efforts, r.effort || 'single')) return false;
      if (!has(S.weights, r.open ? 'open' : 'closed') || !has(S.regions, r.region)) return false;
      if (!has(S.sizes, r.size) || !has(S.priceClasses, r.priceClass)) return false;
      if (!has(S.reasoning, r.reasoning ? 'yes' : 'no')) return false;
      if (!has(S.image, r.image === true ? 'yes' : r.image === false ? 'no' : 'unknown')) return false;
      if (S.levels !== 'all' && (S.levels === 'multi') !== (AA.levelCount(r.group) > 1)) return false;
      if (S.free === 'paid' && !(r.cost > 0)) return false;
      if (S.free === 'free' && r.cost !== 0) return false;
      if (cutoff !== null && !(r.date >= cutoff)) return false;
      if (from !== null && !(r.date >= from)) return false;
      if (to !== null && !(r.date <= to)) return false;
      return ranges.every(([id, [lo, hi]]) => {
        const v = AA.value(AA.metrics.get(id), r);
        return v !== null && (lo === null || v >= lo) && (hi === null || v <= hi);
      });
    });

    if (S.pick !== 'all') {
      const score = {
        top: (r) => r.rank ?? 0,
        best: (r) => r.iq,
        cheap: (r) => (r.cost === null ? -Infinity : -r.cost),
        value: (r) => (r.cost === 0 ? Infinity : r.cost === null ? -Infinity : r.iq / r.cost),
      }[S.pick];
      rows = [...AA.groupBy(rows).values()].flatMap((g) => {
        if (S.pick === 'default') {
          const { group } = g[0];
          return AA.levelCount(group) > 1 && !AA.defaultUnknown(group) ? g.filter((r) => r.isDefault) : g;
        }
        return [g.reduce((best, r) => (score(r) > score(best) ? r : best))];
      });
    }
    if (S.top > 0) {
      const keep = new Set([...AA.groupBy(rows)]
        .map(([id, g]) => [id, Math.max(...g.map((r) => r.iq))])
        .sort((a, b) => b[1] - a[1]).slice(0, S.top).map((e) => e[0]));
      rows = rows.filter((r) => keep.has(r.group));
    }
    if (S.front !== 'all') {
      const edge = AA.frontier(rows, AA.metrics.get('cost'), AA.metrics.get('iq')).map((p) => p.r);
      const ids = new Set(edge.map((r) => r.id));
      const groups = new Set(edge.map((r) => r.group));
      rows = rows.filter((r) => (S.front === 'points' ? ids.has(r.id) : groups.has(r.group)));
    }
    return rows;
  };

  // ---------- 颜色：跟着实体走，不跟着筛选结果走 ----------
  const VENDOR_SLOT = ['Google', 'Anthropic', 'OpenAI', 'DeepSeek', 'Alibaba', 'SpaceXAI', 'Meta', 'Z AI'];
  AA.THEMES = {
    light: {
      surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#77756f', grid: '#e9e8e2', axis: '#c3c2b7',
      other: '#9b9992', neutral: '#f0efec', pos: '#2a78d6', neg: '#e34948', band: '#f4f3ef',
      cat: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
      ord: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'],
      seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    },
    dark: {
      surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#96948d', grid: '#292927', axis: '#45453f',
      other: '#77756f', neutral: '#383835', pos: '#3987e5', neg: '#e66767', band: '#21211f',
      cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'],
      ord: ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'],
      seq: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    },
  };
  AA.effortColor = (id) => {
    const at = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(id);
    return at < 0 ? AA.theme.other : AA.theme.ord[at];
  };
  AA.colorMode = () => {
    const { color } = AA.state;
    if (color !== 'auto') return color;
    return AA.pinned().length ? 'pins' : 'vendor';
  };
  AA.color = (r, mode = AA.colorMode()) => {
    const T = AA.theme;
    if (mode === 'pins') return T.cat[AA.state.pins.indexOf(r.group)] || T.other;
    if (mode === 'effort') return AA.effortColor(r.effort);
    if (mode === 'weights') return r.open ? T.cat[1] : T.cat[0];
    if (mode === 'region') return { us: T.cat[0], cn: T.cat[1], other: T.cat[2] }[r.region];
    return T.cat[VENDOR_SLOT.indexOf(r.vendor)] || T.other;
  };
  AA.legend = (rows, mode = AA.colorMode()) => {
    const T = AA.theme;
    const present = (test) => rows.some(test);
    if (mode === 'pins') {
      return AA.state.pins.map((g, i) => g && [AA.modelName(g), T.cat[i]]).filter(Boolean).concat([['未固定', T.other]]);
    }
    if (mode === 'effort') {
      return AA.EFFORTS.filter((e) => present((r) => r.effort === e.id)).map((e) => [e.name, AA.effortColor(e.id)])
        .concat(present((r) => !r.effort) ? [['单档', T.other]] : []);
    }
    if (mode === 'weights') return [['闭源', T.cat[0]], ['开放权重', T.cat[1]]];
    if (mode === 'region') return [['美国', T.cat[0]], ['中国', T.cat[1]], ['其他', T.cat[2]]];
    return VENDOR_SLOT.map((v, i) => [v, T.cat[i]]).filter(([v]) => present((r) => r.vendor === v))
      .concat(present((r) => !VENDOR_SLOT.includes(r.vendor)) ? [['其他厂商', T.other]] : []);
  };
  // 同厂商内用形状区分模型
  const shapeOf = new Map();
  for (const rows of AA.groupBy(AA.rows, (r) => r.vendor).values()) {
    [...AA.groupBy(rows).keys()].forEach((g, i) => shapeOf.set(g, i % 7));
  }
  AA.shape = (group) => (AA.state.shapes ? shapeOf.get(group) : 0);
})();
