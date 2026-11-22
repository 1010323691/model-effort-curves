/* 界面、交互与导出。 */
(() => {
  'use strict';
  const AA = window.AA;
  const { h, s } = AA;
  const $ = (id) => document.getElementById(id);
  const M = (id) => AA.metrics.get(id);
  const el = Object.fromEntries(['views', 'filters', 'chips', 'title', 'hint', 'options', 'legend', 'stage', 'foot',
    'tip', 'pop', 'panel', 'panel-list', 'panel-sort', 'panel-search', 'drawer', 'dialog', 'toast', 'count', 'search', 'meta']
    .map((id) => [id, $(id)]));
  let rows = [];
  let chart = {};
  let hot = null;
  let hotIndex = -1;
  const ui = (AA.ui = {});

  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(`aa.${key}`)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`aa.${key}`, JSON.stringify(value)); } catch { toast('浏览器禁用了本地存储，无法保存'); }
    },
  };

  let toastTimer;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
  }
  ui.toast = toast;
  const pin = (group) => { if (!AA.pin(group)) toast('最多同时对比 8 个模型'); };
  ui.resetFilters = () => {
    el.search.value = '';
    AA.set(Object.fromEntries(AA.FILTER_KEYS.map((k) => [k, AA.DEFAULTS[k]])));
  };

  // ---------- 输入与重绘 ----------
  // 输入框在失焦的瞬间提交，此时用户正按着下一个目标。若立刻重建，那次点击或焦点就会落空，
  // 所以：控件节点只建一次、之后只同步值；其余区域等这次按下抬起后再重绘。
  let pressed = false;
  let deferring = false;
  let pending = false;
  function flushRender() {
    if (pending && !pressed) render();
  }
  function scheduleRender() {
    pending = true;
    setTimeout(flushRender);
  }
  function onState() {
    if (!deferring) {
      render();
      return;
    }
    // 画面稍后再换，但随后那次点击要读到新状态
    rows = AA.filter();
    $('undo').disabled = !AA.canUndo();
    $('redo').disabled = !AA.canRedo();
  }
  function settle(change) {
    deferring = true;
    try { change(); } finally { deferring = false; }
    scheduleRender();
  }
  function release() {
    pressed = false;
    setTimeout(flushRender); // 排在同一手势的 click 之后
  }
  document.addEventListener('pointerdown', (e) => {
    // 原生下拉和日期选择器会吞掉 pointerup
    pressed = !e.target.closest?.('select, input[type="date"]');
  }, true);
  // 其他丢失 pointerup 的情况（滚动条、拖出窗口）：一旦看出没在按着就解除
  document.addEventListener('pointermove', (e) => { if (pressed && !e.buttons) release(); }, true);
  document.addEventListener('keydown', () => { if (pressed) release(); }, true);
  for (const type of ['pointerup', 'pointercancel', 'contextmenu', 'dragend']) document.addEventListener(type, release, true);
  window.addEventListener('blur', release);

  function syncControls(root) {
    for (const node of root.querySelectorAll('[data-sync]')) node.syncState(node);
  }
  const typedInput = (read, commit) => ({
    value: read(),
    sync: (node) => {
      if (node.dirty && node === document.activeElement) return; // 不打断正在输入的内容
      const value = String(read());
      if (node.value !== value) node.value = value;
    },
    oninput: (e) => { e.target.dirty = true; },
    onchange: (e) => {
      e.target.dirty = false;
      settle(() => commit(e.target.value));
    },
  });

  // ---------- 主题 ----------
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  let themePref = store.get('theme', 'auto');
  function applyTheme() {
    const mode = themePref === 'auto' ? (systemDark.matches ? 'dark' : 'light') : themePref === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = mode;
    AA.theme = AA.THEMES[mode];
    $('theme').textContent = { auto: '主题：自动', light: '主题：浅色', dark: '主题：深色' }[themePref] || '主题：浅色';
  }

  // ---------- 弹层 ----------
  let pop = null;
  function placePop() {
    const box = pop.anchor.getBoundingClientRect();
    el.pop.style.maxHeight = `${Math.max(180, innerHeight - box.bottom - 14)}px`;
    el.pop.style.top = `${box.bottom + 6}px`;
    el.pop.style.left = `${Math.max(8, Math.min(innerWidth - el.pop.offsetWidth - 8, box.left))}px`;
  }
  function openPop(key, anchor, build) {
    if (pop?.key === key) { closePop(); return; }
    closePop();
    pop = { key, anchor, build };
    el.pop.hidden = false;
    el.pop.replaceChildren(...[build()].flat());
    anchor.setAttribute('aria-expanded', 'true');
    placePop();
    el.pop.querySelector('input,button,select')?.focus({ preventScroll: true });
  }
  function closePop() {
    if (!pop) return;
    const { anchor } = pop;
    pop = null;
    // 先失焦再移除，正在输入的值才会提交
    if (el.pop.contains(document.activeElement)) document.activeElement.blur();
    anchor.setAttribute('aria-expanded', 'false');
    el.pop.hidden = true;
    el.pop.replaceChildren();
  }
  function rebuildPop() {
    if (!pop) return;
    el.pop.replaceChildren(...[pop.build()].flat());
    placePop();
  }
  function refreshPop() {
    if (!pop) return;
    if (!pop.anchor.isConnected) {
      closePop();
      return;
    }
    syncControls(el.pop);
    placePop();
  }
  const popButton = (key, build, describe) => h('button', {
    class: 'btn', 'data-pop': key, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    onclick: (e) => openPop(key, e.currentTarget, build),
    sync: (node) => {
      const [text, active] = describe(AA.state);
      node.firstChild.nodeValue = text;
      node.classList.toggle('active', !!active);
    },
  }, describe(AA.state)[0], h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));

  // ---------- 表单部件 ----------
  function checks(key, items, searchable = false) {
    const list = h('div', { class: 'check-list' }, items.map(([value, name, note]) => h('div', { class: 'check', 'data-name': name.toLowerCase() },
      h('label', {},
        h('input', {
          type: 'checkbox', checked: AA.state[key].includes(value), 'data-key': `${key}:${value}`,
          sync: (node) => { node.checked = AA.state[key].includes(value); },
          onchange: () => AA.toggle(key, value),
        }),
        h('span', {}, name), note !== undefined && h('small', {}, note)),
      h('button', { class: 'only', 'data-key': `only:${key}:${value}`, onclick: () => AA.set({ [key]: [value] }) }, '仅此'))));
    // 搜索时，全选与反选只作用于看得见的项，其余保持原样
    const split = () => {
      const visible = items.filter((_, i) => !list.children[i].hidden).map((item) => item[0]);
      const untouched = items.filter((_, i) => list.children[i].hidden).map((item) => item[0]).filter((v) => AA.state[key].includes(v));
      return { visible, untouched };
    };
    const selectVisible = () => {
      const { visible, untouched } = split();
      AA.set({ [key]: [...untouched, ...visible] });
    };
    const invertVisible = () => {
      const { visible, untouched } = split();
      AA.set({ [key]: [...untouched, ...visible.filter((v) => !AA.state[key].includes(v))] });
    };
    return [
      searchable && h('input', {
        class: 'input pop-search', placeholder: '查找…', 'data-key': `search:${key}`, 'aria-label': '查找选项',
        oninput: (e) => {
          for (const item of list.children) item.hidden = !item.dataset.name.includes(e.target.value.toLowerCase());
        },
      }),
      h('div', { class: 'pop-actions' },
        h('button', { class: 'link', onclick: selectVisible }, '全选'),
        h('button', { class: 'link', onclick: invertVisible }, '反选'),
        h('button', { class: 'link', onclick: () => AA.set({ [key]: [] }) }, '不限')),
      list,
    ].filter(Boolean);
  }
  function select(key, options, name, extra) {
    const node = h('select', {
      class: 'select', 'aria-label': name, 'data-key': key,
      sync: (node) => {
        node.value = String(AA.state[key]);
        if (key === 'pick') node.classList.toggle('active', AA.state.pick !== 'all');
      },
      onchange: (e) => AA.set({ [key]: key === 'top' ? Number(e.target.value) : e.target.value, ...extra }),
    }, options.map(([value, text]) => h('option', { value }, text)));
    node.value = String(AA.state[key]);
    return node;
  }
  const field = (name, control) => h('label', { class: 'field' }, h('span', {}, name), control);
  function metricSelect(key, extra) {
    const groups = AA.groupBy([...AA.metrics.values()], (m) => m.cat);
    const node = h('select', {
      class: 'select metric', 'data-key': key, 'aria-label': key,
      sync: (control) => { control.value = AA.state[key]; },
      onchange: (e) => AA.set({ [key]: e.target.value, ...extra }),
    },
      key === 'size' && h('option', { value: 'none' }, '统一大小'),
      [...groups].map(([cat, list]) => h('optgroup', { label: cat }, list.map((m) => h('option', { value: m.id }, m.name)))));
    node.value = AA.state[key];
    return node;
  }
  const toggle = (key, name) => h('label', { class: 'switch' },
    h('input', {
      type: 'checkbox', checked: AA.state[key], 'data-key': key,
      sync: (node) => { node.checked = AA.state[key]; },
      onchange: (e) => AA.set({ [key]: e.target.checked }),
    }), name);
  const numberInput = (key, name) => field(name, h('input', {
    class: 'input number', type: 'number', min: 0, step: 'any', 'data-key': key,
    ...typedInput(() => AA.state[key], (value) => AA.set({ [key]: Math.max(0, Number(value) || 0) })),
  }));

  // ---------- 筛选 ----------
  const NAMES = {
    weights: { open: '开放权重', closed: '闭源' },
    regions: { us: '美国', cn: '中国', other: '其他地区' },
    sizes: { tiny: '微型', small: '小型', medium: '中型', large: '大型', unknown: '未知' },
    priceClasses: { low: '低价', medium: '中价', high: '高价', unknown: '未知' },
    reasoning: { yes: '推理', no: '非推理' },
    image: { yes: '支持', no: '不支持', unknown: '未知' },
    levels: { multi: '仅多档位模型', single: '仅单档模型' },
    free: { paid: '仅付费', free: '仅免费' },
    pick: { default: '官方默认档', top: '最高档', best: '最聪明档', cheap: '最便宜档', value: '性价比最高档' },
    front: { points: '仅前沿上的配置', models: '仅触及前沿的模型' },
    days: { 30: '近 30 天', 60: '近 60 天', 90: '近 90 天', 180: '近半年', 365: '近一年' },
  };
  const choices = (key, all = '不限') => [['all', all], ...Object.entries(NAMES[key])];
  const pills = (key) => h('div', { class: 'pills' }, Object.entries(NAMES[key]).map(([value, name]) => h('button', {
    class: 'pill', 'aria-pressed': String(AA.state[key].includes(value)), 'data-key': `${key}:${value}`,
    sync: (node) => node.setAttribute('aria-pressed', String(AA.state[key].includes(value))),
    onclick: () => AA.toggle(key, value),
  }, name)));

  const modelList = () => [...AA.groups]
    .sort((a, b) => Math.max(...b[1].map((r) => r.iq)) - Math.max(...a[1].map((r) => r.iq)))
    .map(([g]) => [g, AA.modelName(g), AA.levelCount(g) > 1 ? `${AA.levelCount(g)} 档` : '']);

  function rangePanel() {
    const read = (id, side, value) => {
      const next = [...(AA.state.ranges[id] || [null, null])];
      next[side] = value === '' ? null : Number(value);
      const ranges = { ...AA.state.ranges, [id]: next };
      if (next.every((v) => v === null)) delete ranges[id];
      AA.set({ ranges });
    };
    return h('div', { class: 'ranges' },
      h('p', { class: 'muted' }, '留空表示不限，回车生效。设了范围后，缺该值的配置会被排除。'),
      AA.RANGE_FILTERS.map((id) => {
        const m = M(id);
        const values = AA.rows.map((r) => AA.value(m, r)).filter((v) => v !== null);
        const input = (side, hint) => h('input', {
          class: 'input', type: 'number', step: 'any', 'data-key': `range:${id}:${side}`,
          'aria-label': `${m.name}${side ? '上限' : '下限'}`, placeholder: Number(hint.toPrecision(3)),
          ...typedInput(() => AA.state.ranges[id]?.[side] ?? '', (value) => read(id, side, value)),
        });
        return h('div', { class: 'range-row' }, h('span', {}, m.name, h('small', {}, m.unit)),
          input(0, Math.min(...values)), h('i', {}, '–'), input(1, Math.max(...values)));
      }));
  }
  function datePanel() {
    const input = (key) => h('input', {
      class: 'input', type: 'date', 'data-key': key,
      ...typedInput(() => AA.state[key], (value) => AA.set({ [key]: value, days: 'all' })),
    });
    return [
      h('div', { class: 'menu' }, choices('days', '全部时间').map(([value, name]) => h('button', {
        'data-key': `days:${value}`, 'aria-pressed': String(AA.state.days === value),
        sync: (node) => node.setAttribute('aria-pressed', String(AA.state.days === value)),
        onclick: () => AA.set({ days: value, from: '', to: '' }),
      }, name))),
      h('p', { class: 'muted' }, '预设以榜单最新发布日为终点'),
      h('div', { class: 'form' }, field('从', input('from')), field('到', input('to'))),
    ];
  }
  const morePanel = () => h('div', { class: 'form' },
    h('p', { class: 'form-title' }, '权重'), pills('weights'),
    h('p', { class: 'form-title' }, '厂商地区'), pills('regions'),
    h('p', { class: 'form-title' }, '参数规模'), pills('sizes'),
    h('p', { class: 'form-title' }, 'API 单价等级'), pills('priceClasses'),
    h('p', { class: 'form-title' }, '推理能力'), pills('reasoning'),
    h('p', { class: 'form-title' }, '图像输入'), pills('image'),
    field('档位数量', select('levels', choices('levels'), '档位数量')),
    field('免费或付费', select('free', choices('free'), '免费或付费')),
    field('最优前沿', select('front', choices('front'), '最优前沿')),
    field('智能前 N 名', select('top', [['0', '不限'], ['5', '前 5 个模型'], ['10', '前 10 个模型'], ['15', '前 15 个模型'], ['20', '前 20 个模型']], '前 N 名')));

  const PRESETS = [
    ['全部模型', '恢复默认筛选', {}],
    ['多档位模型', '只看能连成线的模型', { levels: 'multi' }],
    ['旗舰前 10', '智能最高的 10 个模型', { top: 10 }],
    ['最优前沿', '没有更便宜且更聪明的替代', { front: 'models' }],
    ['三巨头', 'OpenAI、Anthropic、Google', { vendors: ['OpenAI', 'Anthropic', 'Google'] }],
    ['中国模型', '中国厂商', { regions: ['cn'] }],
    ['开放权重', '可自行部署', { weights: ['open'] }],
    ['一美元以内', '单任务不超过 $1', { ranges: { cost: [null, 1] } }],
    ['快速响应', '单任务不超过 5 分钟', { ranges: { minutes: [null, 5] } }],
    ['近两个月发布', '最近 60 天', { days: '60' }],
    ['官方默认档', '各模型按默认设置比较', { pick: 'default' }],
  ];
  function presetPanel() {
    const saved = store.get('saved', []);
    const name = h('input', { class: 'input', placeholder: '给当前视图起个名字', maxlength: 40, 'aria-label': '视图名称' });
    const save = () => {
      if (!name.value.trim()) return name.focus();
      const value = name.value.trim();
      store.set('saved', [{ name: value, state: AA.diff() }, ...saved.filter((v) => v.name !== value)].slice(0, 30));
      toast('已保存当前视图');
      rebuildPop();
    };
    return [
      h('div', { class: 'menu presets' }, PRESETS.map(([title, note, patch]) => h('button', {
        onclick: () => {
          el.search.value = '';
          AA.set({ ...Object.fromEntries(AA.FILTER_KEYS.map((k) => [k, AA.DEFAULTS[k]])), ...patch });
          closePop();
        },
      }, title, h('small', {}, note)))),
      h('p', { class: 'form-title' }, '我保存的视图'),
      saved.length ? saved.map((v) => h('div', { class: 'saved' },
        h('button', { class: 'link', onclick: () => { AA.load(v.state); closePop(); } }, v.name),
        h('button', { class: 'icon', 'aria-label': `删除 ${v.name}`, onclick: () => { store.set('saved', saved.filter((x) => x !== v)); rebuildPop(); } }, '×')))
        : [h('p', { class: 'muted' }, '还没有保存过')],
      h('div', { class: 'save-row' }, name, h('button', { class: 'btn primary', onclick: save }, '保存')),
    ].flat();
  }

  function buildFilters() {
    const counted = (key, name) => (S) => [S[key].length ? `${name} ${S[key].length}` : name, S[key].length];
    const efforts = AA.EFFORTS.map((e) => [e.id, e.name, AA.rows.filter((r) => r.effort === e.id).length])
      .concat([['single', '单档', AA.rows.filter((r) => !r.effort).length]]);
    el.filters.replaceChildren(
      popButton('date', datePanel, (S) => [
        S.days !== 'all' ? NAMES.days[S.days] : S.from || S.to ? '自定义日期' : '发布时间',
        S.days !== 'all' || S.from || S.to,
      ]),
      popButton('vendors', () => checks('vendors', AA.vendors.map((v) => [v.name, v.name, v.count]), true), counted('vendors', '厂商')),
      popButton('models', () => checks('models', modelList(), true), counted('models', '模型')),
      popButton('efforts', () => checks('efforts', efforts), counted('efforts', '档位')),
      select('pick', choices('pick', '代表档：全部档位'), '代表档'),
      popButton('ranges', rangePanel, (S) => {
        const count = Object.keys(S.ranges).length;
        return [count ? `数值范围 ${count}` : '数值范围', count];
      }),
      popButton('more', morePanel, (S) => {
        const count = ['weights', 'regions', 'sizes', 'priceClasses', 'reasoning', 'image'].filter((k) => S[k].length).length
          + ['levels', 'free', 'front'].filter((k) => S[k] !== 'all').length + (S.top ? 1 : 0);
        return [count ? `更多筛选 ${count}` : '更多筛选', count];
      }),
      popButton('presets', presetPanel, () => ['预设']));
  }
  function renderFilters() {
    if (!el.filters.childElementCount) buildFilters();
    syncControls(el.filters);
  }

  function renderChips() {
    const S = AA.state;
    const items = [];
    // patch 传函数时在点击那一刻计算：标签画出来之后状态可能又变过
    const add = (text, change) => items.push(h('button', { class: 'chip', title: '点击移除', onclick: () => {
      const patch = typeof change === 'function' ? change() : change;
      if ('q' in patch) el.search.value = '';
      AA.set(patch);
    } }, text, h('span', { 'aria-hidden': 'true' }, '×')));
    if (S.q) add(`搜索：${S.q}`, { q: '' });
    const lists = [['vendors', '厂商'], ['models', '模型'], ['hidden', '已隐藏'], ['efforts', '档位'], ['weights', '权重'], ['regions', '地区'],
      ['sizes', '规模'], ['priceClasses', '单价'], ['reasoning', '推理'], ['image', '图像输入']];
    const display = (key, v) => {
      if (key === 'models' || key === 'hidden') return AA.modelName(v);
      if (key === 'efforts') return AA.EFFORTS.find((e) => e.id === v)?.name || '单档';
      return NAMES[key]?.[v] || v;
    };
    for (const [key, name] of lists) {
      if (S[key].length > 3) add(`${name}：${S[key].length} 项`, { [key]: [] });
      else for (const v of S[key]) add(`${name}：${display(key, v)}`, () => ({ [key]: AA.state[key].filter((x) => x !== v) }));
    }
    for (const key of ['levels', 'free', 'pick', 'front', 'days']) if (S[key] !== 'all') add(NAMES[key][S[key]], { [key]: 'all' });
    if (S.from) add(`不早于 ${S.from}`, { from: '' });
    if (S.to) add(`不晚于 ${S.to}`, { to: '' });
    if (S.top) add(`智能前 ${S.top}`, { top: 0 });
    for (const [id, [lo, hi]] of Object.entries(S.ranges)) {
      const without = () => {
        const rest = { ...AA.state.ranges };
        delete rest[id];
        return { ranges: rest };
      };
      const m = M(id);
      add(`${m.name} ${lo === null ? `≤ ${m.fmt(hi)}` : hi === null ? `≥ ${m.fmt(lo)}` : `${m.fmt(lo)}–${m.fmt(hi)}`}`, without);
    }
    if (items.length) items.push(h('button', { class: 'link', id: 'clear-filters', onclick: ui.resetFilters }, '全部清除'));
    el.chips.replaceChildren(...items);
    el.chips.hidden = !items.length;
  }

  // ---------- 图表选项 ----------
  function axisPanel() {
    return h('div', { class: 'form' },
      h('p', { class: 'form-title' }, '坐标轴：只用线性刻度'),
      toggle('xrev', '反转 X 轴'), toggle('yrev', '反转 Y 轴'),
      h('p', { class: 'form-title' }, '连线与标记'),
      field('连线顺序', select('connect', [['effort', '按档位强度'], ['x', '按 X 轴数值'], ['none', '不连线']], '连线顺序')),
      field('非推理档', select('nr', [['dash', '虚线相连'], ['detach', '显示但不连'], ['hide', '隐藏']], '非推理档')),
      field('档位文字', select('tiers', [['auto', '自动'], ['all', '尽量全部'], ['none', '不显示']], '档位文字')),
      field('点大小', metricSelect('size')),
      toggle('frontier', '显示最优前沿'), toggle('defaults', '圈出官方默认档'),
      toggle('arrows', '显示升档方向箭头'), toggle('shapes', '用形状区分同厂商模型'));
  }
  function columnPanel() {
    return checks('cols', [...AA.metrics.values()].map((m) => [m.id, m.name]), true);
  }
  const OPTIONS = {
    x: () => field('横轴', metricSelect('x')),
    y: () => field('纵轴', metricSelect('y')),
    metric: () => field('指标', metricSelect('metric')),
    swap: () => h('button', { class: 'btn', title: '交换横纵轴', id: 'swap', onclick: () => {
      const S = AA.state;
      AA.set({ x: S.y, y: S.x, xrev: S.yrev, yrev: S.xrev });
    } }, '⇄'),
    focus: () => field('拥挤区', select('focus', [['auto', '自动分级展开'], ['one', '只展开一级'], ['off', '只看全程']], '拥挤区')),
    color: () => field('着色', select('color', [['auto', '自动'], ['vendor', '厂商'], ['effort', '档位'], ['weights', '开源与闭源'], ['region', '地区']], '着色')),
    labels: () => field('标签', select('labels', [['auto', '自动'], ['all', '尽量全部'], ['pins', '仅固定的'], ['none', '不显示']], '标签')),
    display: () => popButton('display', axisPanel, () => ['显示与坐标']),
    facetBy: () => field('分面', select('facetBy', [['model', '按模型'], ['vendor', '按厂商'], ['region', '按地区'], ['weights', '按开源与闭源']], '分面')),
    facetContext: () => toggle('facetContext', '灰色背景对照'),
    relative: () => field('显示', select('relative', [['value', '实际值'], ['times', '相对最低档倍数'], ['delta', '相对最低档增减']], '显示')),
    stepMode: () => field('比较', select('stepMode', [['adjacent', '相邻两档'], ['total', '最低档到最高档']], '比较')),
    stepSort: () => field('排序', select('stepSort', [['model', '按模型'], ['gain', '增益最大'], ['cost', '涨价最多'], ['marginal', '边际花费最低']], '排序')),
    costMode: () => field('拆分', select('costMode', [['parts', '按费用类型'], ['share', '费用占比'], ['evals', '按评测项目'], ['tokens', '输出 Token']], '拆分')),
    order: () => field('排序', select('order', [['iq', '智能从高到低'], ['cost', '合计从高到低'], ['name', '按模型名']], '排序')),
    benchScope: () => field('范围', select('benchScope', [['best', '每个模型最强档'], ['all', '全部档位']], '范围')),
    tasks: () => numberInput('tasks', '每月任务数'),
    budget: () => numberInput('budget', '每月预算 $'),
    minIq: () => numberInput('minIq', '智能下限'),
    maxMin: () => numberInput('maxMin', '耗时上限（分，0 不限）'),
    compareAdd: () => [
      field('添加模型', h('select', { class: 'select', 'data-key': 'compareAdd', onchange: (e) => { if (e.target.value) pin(e.target.value); } },
        h('option', { value: '' }, '请选择…'),
        modelList().filter(([g]) => !AA.state.pins.includes(g)).map(([g, name]) => h('option', { value: g }, name)))),
      AA.pinned().length > 0 && h('button', { class: 'btn', id: 'pins-clear', onclick: () => AA.set({ pins: [] }) }, '清空对比'),
    ],
    columns: () => popButton('columns', columnPanel, () => ['选择列']),
    csv: () => h('button', { class: 'btn', id: 'table-csv', onclick: () => exporters.csv() }, '下载 CSV'),
  };
  let optionsShape = '';
  function renderOptions() {
    const { options } = AA.views[AA.state.view];
    // 只有控件的构成变了才重建
    const shape = `${AA.state.view}|${options.includes('compareAdd') ? AA.state.pins.join() : ''}`;
    if (shape !== optionsShape) {
      optionsShape = shape;
      const key = el.options.contains(document.activeElement) ? document.activeElement.dataset.key : null;
      el.options.replaceChildren(...options.flatMap((id) => OPTIONS[id]()).filter(Boolean));
      if (key) el.options.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }
    syncControls(el.options);
  }
  function legendItems() {
    const { legend } = AA.views[AA.state.view];
    if (!legend) return [];
    if (legend === 'segments') return AA.costSegments(rows, AA.state.costMode).map((p) => [p.name, p.color]);
    const items = AA.legend(rows, legend === true ? AA.colorMode() : legend);
    return legend === 'pins' ? items.slice(0, -1) : items;
  }
  function renderLegend() {
    const { view, frontier } = AA.state;
    const items = legendItems().map(([name, color]) => h('span', { class: 'key' },
      h('i', name === '非推理' ? { class: 'hollow-key' } : { class: 'swatch', style: { background: color } }), name));
    if ((view === 'curve' && frontier) || view === 'pick') items.push(h('span', { class: 'key' }, h('i', { class: 'band-key' }), '最优前沿'));
    if (view === 'curve' && rows.some((r) => r.effort === 'non-reasoning')) items.push(h('span', { class: 'key' }, h('i', { class: 'hollow-key' }), '非推理档'));
    el.legend.replaceChildren(...items);
    el.legend.hidden = !items.length;
  }

  // ---------- 左侧导航与右侧模型列表 ----------
  function buildViews() {
    el.views.replaceChildren(...AA.VIEWS.map(([group, list]) => h('div', { class: 'nav-group' },
      h('p', {}, group),
      list.map(([id, name]) => h('button', {
        'data-view': id,
        sync: (node) => {
          if (AA.state.view === id) node.setAttribute('aria-current', 'page');
          else node.removeAttribute('aria-current');
        },
        onclick: () => {
          closePop();
          el.stage.scrollTo(0, 0);
          AA.set({ view: id });
        },
      }, name)))));
  }
  function renderViews() {
    if (!el.views.childElementCount) buildViews();
    syncControls(el.views);
  }
  function renderPanel() {
    const S = AA.state;
    const query = el['panel-search'].value.trim().toLowerCase();
    const sort = el['panel-sort'].value;
    const visible = new Set(rows.map((r) => r.group));
    const shown = AA.groupBy(rows);
    const order = (group) => {
      const list = shown.get(group) || AA.groups.get(group);
      const costs = list.map((r) => r.cost).filter((v) => v !== null);
      if (sort === 'cost') return costs.length ? Math.min(...costs) : Infinity;
      return sort === 'levels' ? -list.length : -Math.max(...list.map((r) => r.iq));
    };
    const groups = [...AA.groups.keys()]
      .filter((g) => (visible.has(g) || S.hidden.includes(g) || S.pins.includes(g)) && AA.modelName(g).toLowerCase().includes(query))
      .sort((a, b) => S.pins.includes(b) - S.pins.includes(a) || S.hidden.includes(a) - S.hidden.includes(b) || order(a) - order(b));
    el['panel-list'].replaceChildren(...groups.map((group) => {
      const all = shown.get(group) || AA.groups.get(group);
      const iq = all.map((r) => r.iq);
      const costs = all.map((r) => r.cost).filter((v) => v !== null);
      const range = (list, fmt) => (Math.min(...list) === Math.max(...list) ? fmt(list[0]) : `${fmt(Math.min(...list))}–${fmt(Math.max(...list))}`);
      const pinned = S.pins.includes(group);
      const hidden = S.hidden.includes(group);
      const name = AA.modelName(group);
      const icon = AA.s('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' },
        AA.mark(AA.shape(group), 0, 0, 4.3, AA.color(all[0], AA.colorMode() === 'effort' ? 'vendor' : undefined)));
      return h('div', {
        class: `model${hidden ? ' off' : ''}${pinned ? ' pinned' : ''}`, 'data-model': group,
        onpointerenter: () => focusSeries(group), onpointerleave: () => focusSeries(null),
      },
      h('button', { class: 'model-main', title: '查看详情', onclick: () => ui.details(group) },
        icon,
        h('span', { class: 'model-name' }, name),
        h('span', { class: 'model-sub' }, `${range(iq, (v) => v.toFixed(0))} 分 · ${costs.length ? range(costs, AA.fmt.money) : '暂无价格'}`)),
      h('button', { class: 'icon pin', title: pinned ? '取消固定' : '固定对比', 'aria-label': `固定对比 ${name}`, 'aria-pressed': String(pinned), onclick: () => pin(group) },
        s('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          s('path', { d: 'M5 1.5h6l-1 4 2.5 3.5h-9L6 5.5zM8 9v5.5', fill: pinned ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linejoin': 'round' }))),
      h('button', { class: 'icon eye', title: hidden ? '显示' : '隐藏', 'aria-label': `隐藏 ${name}`, 'aria-pressed': String(hidden), onclick: () => AA.toggle('hidden', group) },
        s('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
          s('path', { d: 'M1 8q7-9 14 0-7 9-14 0z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }),
          hidden ? s('path', { d: 'M2 14 14 2', stroke: 'currentColor', 'stroke-width': 1.4 }) : s('circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' }))));
    }));
    $('panel-count').textContent = `${visible.size} 个`;
  }

  // ---------- 绘制 ----------
  function draw() {
    // 同一视图内重绘要留在原处，只有换视图才归零
    const sameView = el.stage.dataset.view === AA.state.view;
    const scroll = sameView ? [el.stage.scrollLeft, el.stage.scrollTop] : [0, 0];
    el.stage.querySelector('.chart')?.blur();
    el.stage.replaceChildren();
    el.tip.hidden = true;
    hot = null;
    hotIndex = -1;
    el.stage.dataset.view = AA.state.view;
    const view = AA.views[AA.state.view];
    // clientWidth 已扣除滚动条（scrollbar-gutter: stable）
    const W = Math.max(300, el.stage.clientWidth); // 隐藏或尚未布局时宽度会是 0
    chart = view.draw({ stage: el.stage, rows, W, H: Math.max(260, el.stage.clientHeight - 2) }) || {};
    renderCount();
    el.stage.scrollTo(...scroll);
    chart.svg = el.stage.querySelector('svg.chart');
    if (!chart.svg) return;
    chart.overlay = s('g', { class: 'overlay', 'pointer-events': 'none' });
    chart.svg.append(chart.overlay);
    bindChart(chart.svg);
  }
  function renderCount() {
    const plotted = chart.count;
    el.count.textContent = `${new Set(rows.map((r) => r.group)).size} 个模型 · ${rows.length} 个配置`
      + (plotted !== undefined && plotted !== rows.length ? ` · ${plotted} 个入图` : '');
  }
  function render() {
    pending = false;
    const S = AA.state;
    rows = AA.filter();
    renderViews();
    renderFilters();
    renderChips();
    el.title.textContent = AA.views[S.view].title();
    el.hint.textContent = AA.views[S.view].hint();
    renderOptions();
    renderLegend();
    renderCount();
    if (document.activeElement !== el.search) el.search.value = S.q;
    el.search.setAttribute('aria-invalid', String(!AA.matcher(S.q)));
    $('undo').disabled = !AA.canUndo();
    $('redo').disabled = !AA.canRedo();
    const missing = rows.filter((r) => r.cost === null).length;
    const undefaulted = S.pick === 'default' ? new Set(rows.map((r) => r.group).filter(AA.defaultUnknown)).size : 0;
    el.foot.replaceChildren(
      h('span', {}, S.view === 'curve' ? '线性刻度 · 悬停时各分图联动 · 单击详情 · ⌘/Ctrl+单击固定' : '悬停看数值 · 单击看详情'),
      undefaulted ? h('span', { class: 'notice' }, `${undefaulted} 个模型缺少默认档信息，未按默认档筛选`) : '',
      missing && S.view !== 'table'
        ? h('button', { class: 'link', id: 'missing', onclick: showMissing }, `${missing} 个配置暂无单任务价格`)
        : '');
    renderPanel();
    draw();
    refreshPop();
    if (!el.drawer.hidden && el.drawer.dataset.group) ui.details(el.drawer.dataset.group, true);
  }
  function showMissing() {
    dialog('暂无单任务价格的配置',
      h('p', { class: 'muted' }, '原站没有公布这些配置的单任务价格，因此无法放进以价格为轴的图；数据表和其他指标的图仍会展示它们。'),
      h('ul', { class: 'plain' }, rows.filter((r) => r.cost === null).map((r) => h('li', {}, r.label, h('span', {}, `智能 ${r.iq.toFixed(1)}`)))));
  }

  // ---------- 悬停 ----------
  function focusSeries(group) {
    const { svg } = chart;
    if (!svg) return;
    svg.classList.toggle('focusing', !!group && [...svg.querySelectorAll('g.series')].some((g) => g.dataset.group === group));
    for (const g of svg.querySelectorAll('g.series')) g.classList.toggle('hot', g.dataset.group === group);
  }
  function nearest(x, y) {
    let found = null;
    let best = 28;
    (chart.hits || []).forEach((hit, i) => {
      if (hit.w) {
        if (!found && x >= hit.x && x < hit.x + hit.w && y >= hit.y && y < hit.y + hit.h) found = { hit, i };
        return;
      }
      const d = Math.hypot(x - hit.x, y - hit.y);
      if (d < best) {
        best = d;
        found = { hit, i };
      }
    });
    return found;
  }
  function tipContent(hit) {
    const { row } = hit;
    const line = (name, value, color) => h('div', { class: 'tip-row' },
      color && h('i', { class: 'line-key', style: { background: color } }), h('span', {}, name), h('b', {}, value));
    const body = [h('div', { class: 'tip-head' }, h('b', {}, row.label), h('span', {}, `${row.vendor}${row.isDefault ? ' · 默认档' : ''}`))];
    if (hit.extra) body.push(line(...hit.extra));
    if (hit.parts) {
      body.push(...hit.parts.map(([name, value, color]) => line(name, value, color)));
      return body;
    }
    if (hit.step) {
      const { from, to, gain, marginal } = hit.step;
      body.push(line('从', AA.effortName(from)), line('智能', `${from.iq.toFixed(1)} → ${to.iq.toFixed(1)}（${gain >= 0 ? '+' : ''}${gain.toFixed(2)}）`),
        line('单任务价格', `${AA.fmt.money(from.cost)} → ${AA.fmt.money(to.cost)}`), line('每 +1 分多花', marginal === null ? '无增益' : hit.step.cheaper ? '反而更省' : AA.fmt.money(marginal)));
      return body;
    }
    const S = AA.state;
    const ids = new Set(['iq', 'cost', 'minutes']);
    if (S.view === 'curve' || S.view === 'facet') { ids.add(S.x); ids.add(S.y); }
    if (['time', 'effort', 'range', 'matrix', 'rank'].includes(S.view)) ids.add(S.metric);
    if (S.view === 'curve' && S.size !== 'none') ids.add(S.size);
    for (const id of ids) body.push(line(M(id).name, AA.show(M(id), AA.value(M(id), row))));

    const siblings = rows.filter((r) => r.group === row.group && r.cost !== null).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    if (siblings.length > 1) {
      body.push(h('table', { class: 'tip-tiers' },
        h('tr', {}, h('th', {}, '档位'), h('th', {}, '智能'), h('th', {}, '$/任务')),
        siblings.map((r) => h('tr', { class: r.id === row.id ? 'current' : null },
          h('td', {}, h('i', { class: 'line-key', style: { background: AA.color(r) } }), AA.effortName(r)),
          h('td', {}, r.iq.toFixed(1)), h('td', {}, AA.fmt.money(r.cost))))));
    }
    return body;
  }
  function hover(found, clientX, clientY) {
    hot = found?.hit || null;
    hotIndex = found ? found.i : -1;
    el.tip.hidden = !hot;
    focusSeries(hot?.group);
    const { overlay } = chart;
    if (!overlay) return;
    overlay.replaceChildren();
    if (!hot) return;
    const T = AA.theme;
    if (hot.w) overlay.append(s('rect', { x: hot.x + 1, y: hot.y + 1, width: hot.w - 2, height: hot.h - 2, rx: 3, fill: 'none', stroke: T.muted, 'stroke-width': 1.5 }));
    else {
      const { box } = hot;
      if (box) overlay.append(s('path', { d: `M${hot.x} ${box.t}V${box.b}M${box.l} ${hot.y}H${box.r}`, fill: 'none', stroke: T.axis }));
      // 同一配置在各分图中的位置一起圈出
      for (const p of chart.hits) {
        if (!p.w && p.row.id === hot.row.id) overlay.append(s('circle', { cx: p.x, cy: p.y, r: 9, fill: 'none', stroke: T.ink, 'stroke-width': 1.5 }));
      }
    }
    el.tip.replaceChildren(...tipContent(hot));
    const gap = 20;
    const w = el.tip.offsetWidth;
    const ht = el.tip.offsetHeight;
    const x = clientX + gap + w > innerWidth - 8 ? clientX - w - gap : clientX + gap;
    el.tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
    el.tip.style.top = `${Math.max(8, Math.min(innerHeight - ht - 8, clientY - ht / 3))}px`;
  }

  // ---------- 指针与键盘（不提供缩放，比例始终不变） ----------
  function bindChart(svg) {
    const point = (e) => {
      const r = svg.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    let down = null;
    svg.addEventListener('pointerdown', (e) => {
      closePop();
      down = point(e);
      svg.focus({ preventScroll: true });
    });
    svg.addEventListener('pointermove', (e) => hover(nearest(...point(e)), e.clientX, e.clientY));
    svg.addEventListener('pointerup', (e) => {
      const [x, y] = point(e);
      const start = down;
      down = null;
      if (!start || Math.hypot(x - start[0], y - start[1]) > 6) return;
      const found = nearest(x, y);
      if (!found) return;
      if (e.metaKey || e.ctrlKey) pin(found.hit.group);
      else ui.details(found.hit.group);
    });
    svg.addEventListener('pointercancel', () => { down = null; });
    svg.addEventListener('pointerleave', () => hover(null));
    svg.addEventListener('keydown', (e) => {
      const { hits } = chart;
      if (!hits?.length) return;
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (dir) {
        e.preventDefault();
        const i = hotIndex < 0 ? 0 : (hotIndex + dir + hits.length) % hits.length;
        const r = svg.getBoundingClientRect();
        hover({ hit: hits[i], i }, r.left + hits[i].x + (hits[i].w || 0) / 2, r.top + hits[i].y);
      } else if (e.key === 'Enter' && hot) {
        ui.details(hot.group);
      }
    });
    svg.addEventListener('blur', () => hover(null));
  }

  // ---------- 详情抽屉 ----------
  ui.details = (group, keep = false) => {
    // keep：随状态刷新已打开的抽屉，不影响弹层和悬停
    if (!keep) {
      closePop();
      hover(null);
    }
    const all = AA.groups.get(group);
    const first = all[0];
    const pinned = AA.state.pins.includes(group);
    const fact = (name, value) => h('div', {}, h('dt', {}, name), h('dd', {}, value));
    const carried = all.find((r) => r.detailFrom);
    el.drawer.dataset.group = group;
    el.drawer.hidden = false;
    el.drawer.replaceChildren(...[
      h('header', {},
        h('div', {}, h('p', { class: 'muted' }, first.vendor), h('h2', {}, first.model)),
        h('button', { class: 'icon', id: 'drawer-close', 'aria-label': '关闭详情', onclick: closeDrawer }, '×')),
      h('div', { class: 'drawer-actions' },
        h('button', { class: `btn${pinned ? ' active' : ''}`, id: 'detail-pin', onclick: () => pin(group) }, pinned ? '取消固定' : '固定对比'),
        h('button', { class: 'btn', onclick: () => AA.set({ models: [group] }) }, '只看它'),
        h('button', { class: 'btn', onclick: () => { closeDrawer(); AA.toggle('hidden', group); } }, '隐藏'),
        h('a', { class: 'btn', href: `https://artificialanalysis.ai/models/${encodeURIComponent(group)}`, target: '_blank', rel: 'noopener noreferrer' }, '原站 ↗')),
      carried && h('p', { class: 'stale-note' },
        `这次更新没取到完整详情，部分字段沿用 ${new Date(carried.detailFrom).toLocaleString('zh-CN')} 的数据。`),
      h('dl', { class: 'facts' },
        fact('发布日期', first.released || '—'), fact('权重', first.open ? '开放' : '闭源'),
        fact('上下文', AA.show(M('context'), first.context)),
        fact('图像输入', first.image === true ? '支持' : first.image === false ? '不支持' : '未知'),
        fact('输入单价 / 百万', AA.show(M('priceIn'), first.priceIn)), fact('输出单价 / 百万', AA.show(M('priceOut'), first.priceOut)),
        fact('缓存命中 / 百万', AA.show(M('priceHit'), first.priceHit)), fact('缓存写入 / 百万', AA.show(M('priceWrite'), first.priceWrite))),
      h('h3', {}, '各档位'),
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['档位', '智能', '$/任务', '分钟', '首答/秒'].map((name, i) => h('th', { class: i ? 'num' : null }, name)))),
        h('tbody', {}, all.map((r) => h('tr', {},
          h('td', {}, AA.effortName(r), r.isDefault && h('span', { class: 'badge' }, '默认')),
          h('td', { class: 'num' }, r.iq.toFixed(2)),
          h('td', { class: 'num' }, AA.show(M('cost'), r.cost)),
          h('td', { class: 'num' }, r.minutes === null ? '—' : r.minutes.toFixed(1)),
          h('td', { class: 'num' }, r.ttft === null ? '—' : r.ttft.toFixed(1)))))),
      h('h3', {}, '有没有更划算的替代'),
      h('ul', { class: 'alts' }, all.filter((r) => r.cost !== null).map((r) => {
        const better = AA.dominators(r, AA.rows).sort((a, b) => a.cost - b.cost || b.iq - a.iq)[0];
        return h('li', {}, h('b', {}, AA.effortName(r)), better
          ? h('span', {}, `${better.label} 不更贵且不更差：${better.iq.toFixed(1)} 分，${AA.fmt.money(better.cost)}`)
          : h('span', { class: 'good' }, '✓ 位于全榜最优前沿'));
      })),
    ].filter(Boolean));
    if (!keep) {
      el.drawer.scrollTop = 0;
      $('drawer-close').focus({ preventScroll: true });
    }
  };
  function closeDrawer() {
    el.drawer.hidden = true;
    el.drawer.dataset.group = '';
  }
  function dialog(title, ...body) {
    el.dialog.replaceChildren(
      h('header', {}, h('h2', {}, title), h('button', { class: 'icon', 'aria-label': '关闭', onclick: () => el.dialog.close() }, '×')),
      ...body);
    el.dialog.showModal();
  }

  // ---------- 导出 ----------
  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const fileName = (ext) => `ai-models-${AA.state.view}-${(AA.meta.fetchedAt || '').slice(0, 10)}.${ext}`;
  ui.exportSVG = () => {
    const svg = chart.svg;
    if (!svg) return null;
    const T = AA.theme;
    const width = Number(svg.getAttribute('width'));
    const height = Number(svg.getAttribute('height'));
    const legend = [];
    let x = 16;
    let y = 66;
    for (const [name, color] of legendItems()) {
      const w = AA.textWidth(name, 11) + 32;
      if (x + w > width) {
        x = 16;
        y += 18;
      }
      legend.push(s('rect', { x, y: y - 5, width: 10, height: 10, rx: 2, fill: color }), AA.text(x + 15, y, name));
      x += w;
    }
    const head = y + 18;
    const copy = svg.cloneNode(true);
    copy.querySelector('.overlay')?.remove();
    copy.removeAttribute('class');
    copy.setAttribute('y', head);
    const total = head + height + 28;
    const root = s('svg', { width, height: total, viewBox: `0 0 ${width} ${total}`, 'font-family': AA.FONT },
      s('rect', { width, height: total, fill: T.surface }),
      AA.text(16, 24, el.title.textContent, { size: 17, weight: 600, fill: T.ink }),
      AA.text(16, 45, `${el.count.textContent} · ${el.hint.textContent}`),
      ...legend, copy,
      AA.text(16, total - 14, `${AA.state.view === 'curve' ? '灰色宽带：最优前沿 · 空心点：非推理档 · ' : ''}数据来源：Artificial Analysis（artificialanalysis.ai） · 抓取于 ${(AA.meta.fetchedAt || '').slice(0, 10)}`, { fill: T.muted }));
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return { text: new XMLSerializer().serializeToString(root), width, height: total };
  };
  ui.exportPNG = async () => {
    const out = ui.exportSVG();
    if (!out) return null;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out.text)}`;
    await img.decode();
    const canvas = h('canvas');
    // 超长图受画布尺寸上限约束
    const ratio = Math.min(2, 16000 / out.height, 16000 / out.width);
    canvas.width = out.width * ratio;
    canvas.height = out.height * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.drawImage(img, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  };
  ui.exportCSV = () => {
    const ids = [...new Set([...AA.state.cols, 'iq', 'cost'])];
    const cell = (value) => {
      let text = value === null || value === undefined ? '' : String(value);
      if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = ['模型', '档位', '厂商', ...ids.map((id) => M(id).name)];
    const body = AA.tableRows(rows).map((r) => [r.model, AA.effortName(r), r.vendor,
      ...ids.map((id) => (id === 'released' ? r.released : AA.value(M(id), r)))]);
    return `﻿${[header, ...body].map((line) => line.map(cell).join(',')).join('\r\n')}`;
  };
  ui.exportJSON = () => JSON.stringify({
    source: AA.meta.source, fetchedAt: AA.meta.fetchedAt, indexVersion: AA.meta.indexVersion, view: AA.diff(), rows,
  }, null, 2);
  const noChart = () => toast('当前视图是表格，请改用 CSV 导出');
  const exporters = {
    async png() {
      try {
        const blob = await ui.exportPNG();
        if (blob) download(fileName('png'), blob);
        else noChart();
      } catch (err) {
        toast(`PNG 导出失败：${err.message || err}。可改用 SVG`);
      }
    },
    svg() {
      const out = ui.exportSVG();
      if (out) download(fileName('svg'), new Blob([out.text], { type: 'image/svg+xml' }));
      else noChart();
    },
    csv: () => download(fileName('csv'), new Blob([ui.exportCSV()], { type: 'text/csv;charset=utf-8' })),
    json: () => download(fileName('json'), new Blob([ui.exportJSON()], { type: 'application/json' })),
  };
  function exportPanel() {
    return h('div', { class: 'menu' }, [
      ['png', 'PNG 图片', '2 倍清晰度，含标题与图例'], ['svg', 'SVG 矢量图', '可继续编辑'],
      ['csv', 'CSV 表格', '当前筛选结果'], ['json', 'JSON 数据', '当前筛选结果，含全部字段'],
    ].map(([key, name, note]) => h('button', { 'data-export': key, onclick: () => { exporters[key](); closePop(); } }, name, h('small', {}, note))));
  }
  async function share() {
    AA.flushUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      toast('已复制当前视图的链接');
    } catch {
      dialog('复制这个链接', h('input', { class: 'input wide', readonly: true, value: location.href, onfocus: (e) => e.target.select() }));
    }
  }
  function help() {
    const line = (key, text) => h('li', {}, h('kbd', {}, key), h('span', {}, text));
    dialog('使用说明',
      h('h3', {}, '图表操作'),
      h('ul', { class: 'plain' }, line('悬停', '看数值与同模型各档'), line('单击', '模型详情与替代方案'), line('⌘ / Ctrl + 单击', '固定对比'),
        line('拥挤区', '选择展开几级局部图'), line('数值范围', '只看某一段时，用它筛选')),
      h('h3', {}, '更新数据'),
      h('p', { class: 'muted' }, '点右上角“更新数据”即可从原站抓取最新榜单。需要通过“启动看板.command”打开看板；直接双击 index.html 时只能查看。'),
      h('h3', {}, '快捷键'),
      h('ul', { class: 'plain' }, line('/', '搜索'), line('[ ]', '切换视图'), line('F', '专注模式'), line('← →', '聚焦图表后逐点查看'),
        line('⌘Z / ⇧⌘Z', '撤销与重做'), line('Esc', '关闭浮层')),
      h('h3', {}, '搜索语法'),
      h('ul', { class: 'plain' }, line('claude opus', '同时包含'), line('gpt,gemini', '任意一个'), line('-luna', '排除'), line('/gpt-6\\.[12]/', '正则表达式（最多 2 个量词，量词不能加在括号后）')),
      h('h3', {}, '口径'),
      h('p', { class: 'muted' }, '单任务价格是 AA 智能指数各评测任务的加权平均花费，不是每百万 Token 单价。地区按厂商总部人工归类。所有坐标都是线性刻度，价格等数值从 0 起，免费配置就在 0 处。局部图只是把靠近 0 的一段单独画大，图内比例不变；不同分图之间不能直接比距离。日期与 Elo 分数没有零点，只保证相同距离等于相同差值。'));
  }

  // 数据不随仓库分发：克隆后要先手动运行一次抓取脚本
  function noData() {
    let command = 'python3 -I scripts/update_data.py';
    if (location.protocol === 'file:') {
      const script = `${decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '')}/scripts/update_data.py`;
      command = `python3 -I '${script.replace(/'/g, "'\\''")}'`;
    }
    return h('div', { class: 'empty', id: 'no-data' },
      h('strong', {}, '本地还没有数据'),
      h('p', {}, '仓库不含榜单数据。请先在项目文件夹里手动运行一次脚本，完成后刷新本页：'),
      h('code', { class: 'command' }, command),
      h('button', { class: 'btn primary', id: 'reload', onclick: () => location.reload() }, '已拿到数据，刷新'));
  }

  // ---------- 全局绑定 ----------
  function init() {
    applyTheme();
    if (!AA.rows.length) {
      for (const id of ['undo', 'redo', 'share', 'export', 'theme', 'focus', 'panel-toggle', 'help', 'search', 'panel-search', 'panel-sort']) $(id).disabled = true;
      el.stage.replaceChildren(noData());
      return;
    }
    const date = new Date(AA.meta.fetchedAt);
    el.meta.replaceChildren(
      h('a', { href: AA.meta.source, target: '_blank', rel: 'noopener noreferrer' }, 'Artificial Analysis'),
      ` · 指数 v${AA.meta.indexVersion || '—'} · ${date.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 抓取`);
    AA.listeners.push(onState);

    let searchTimer;
    el.search.value = AA.state.q;
    const commitSearch = () => {
      clearTimeout(searchTimer);
      settle(() => AA.set({ q: el.search.value }));
    };
    el.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(commitSearch, 140);
    });
    el.search.addEventListener('change', commitSearch); // 离开搜索框时不等防抖
    el['panel-search'].addEventListener('input', renderPanel);
    el['panel-sort'].addEventListener('change', renderPanel);
    $('undo').addEventListener('click', AA.undo);
    $('redo').addEventListener('click', AA.redo);
    $('share').addEventListener('click', share);
    $('help').addEventListener('click', help);
    $('export').addEventListener('click', (e) => openPop('export', e.currentTarget, exportPanel));
    $('theme').addEventListener('click', () => {
      themePref = { auto: 'light', light: 'dark', dark: 'auto' }[themePref] || 'auto';
      store.set('theme', themePref);
      applyTheme();
      render();
    });
    const focusMode = () => {
      const on = document.body.classList.toggle('focus-mode');
      $('focus').setAttribute('aria-pressed', String(on));
    };
    $('focus').addEventListener('click', focusMode);
    $('panel-toggle').addEventListener('click', () => {
      if (innerWidth <= 1100) document.body.classList.toggle('panel-open');
      else document.body.classList.toggle('panel-closed');
    });
    $('panel-close').addEventListener('click', () => {
      document.body.classList.remove('panel-open');
      if (innerWidth > 1100) document.body.classList.add('panel-closed');
    });
    systemDark.addEventListener('change', () => { if (themePref === 'auto') { applyTheme(); render(); } });
    addEventListener('hashchange', () => AA.set(AA.readHash()));
    document.addEventListener('pointerdown', (e) => {
      if (pop && !el.pop.contains(e.target) && !e.target.closest('[data-pop], #export')) closePop();
    });
    el.stage.addEventListener('scroll', () => hover(null), { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (pop) closePop();
        else if (!el.drawer.hidden) closeDrawer();
        else if (document.body.classList.contains('panel-open')) document.body.classList.remove('panel-open');
        else if (document.body.classList.contains('focus-mode')) focusMode();
        hover(null);
        return;
      }
      if (e.target.closest?.('input, select, textarea') || el.dialog.open) return;
      const key = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (key !== 'z') return;
        e.preventDefault();
        if (e.shiftKey) AA.redo();
        else AA.undo();
      } else if (key === '/') {
        e.preventDefault();
        el.search.focus();
      } else if (key === 'f') {
        focusMode();
      } else if (key === '[' || key === ']') {
        const ids = AA.VIEWS.flatMap((g) => g[1].map((v) => v[0]));
        AA.set({ view: ids[(ids.indexOf(AA.state.view) + (key === ']' ? 1 : -1) + ids.length) % ids.length] });
      } else if (key === '?') {
        help();
      }
    });

    let size = '';
    let frame;
    new ResizeObserver(() => {
      const next = `${el.stage.clientWidth}x${el.stage.clientHeight}`;
      if (next === size) return;
      size = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    }).observe(el.stage);
    render();
  }
  ui.chart = () => chart;
  init();
})();
