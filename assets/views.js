/* 十三个视图。每个视图声明标题、选项与绘制函数。 */
(() => {
  'use strict';
  const AA = window.AA;
  const { h, s } = AA;
  const M = (id) => AA.metrics.get(id);
  const V = (AA.views = {});
  const axisTitle = (m) => (m.unit ? `${m.name}（${m.unit}）` : m.name);
  const arrow = (m) => (m.good > 0 ? '越高越好' : '越低越好');
  const bestIq = (rows) => Math.max(...rows.map((r) => r.iq));
  const modelsByIq = (rows) => [...AA.groupBy(rows)].sort((a, b) => bestIq(b[1]) - bestIq(a[1]));
  const label = (svg, row, x, y, max, options = {}) =>
    svg.append(AA.text(x, y, AA.ellipsis(options.text || row.label, max, 11.5), { anchor: 'end', size: 11.5, fill: AA.theme.ink }));

  function empty(stage, title = '当前条件下没有可展示的数据', hint = '试试放宽筛选，或更换指标。') {
    stage.append(h('div', { class: 'empty' }, h('strong', {}, title), h('p', {}, hint),
      h('button', { class: 'btn primary', onclick: () => AA.ui.resetFilters() }, '清空筛选')));
    return {};
  }
  function canvas(stage, width, height, name) {
    const svg = AA.svg(width, height, name);
    stage.append(svg);
    return svg;
  }
  function shade(value, lo, hi) {
    const t = hi === lo ? 0.5 : (value - lo) / (hi - lo);
    return Math.max(0, Math.min(6, Math.round(t * 6)));
  }
  const colorFloor = (values, m) => (m.interval ? Math.min(...values) : Math.min(0, ...values));
  // 横向条形 / 跨度图的分栏：全程在左，局部在右
  function rowColumns(svg, o) {
    const T = AA.theme;
    const list = [null, ...o.limits];
    const gap = o.gap ?? 62;
    const width = (o.right - o.left - gap * (list.length - 1)) / list.length;
    return list.map((limit, i) => {
      const left = o.left + i * (width + gap);
      const right = left + width;
      const scale = AA.scale({ values: o.values, a: left, b: right, metric: o.metric, limit, zero: o.zero });
      if (o.limits.length) {
        svg.append(AA.text(left, 13, limit === null ? '全程' : `局部 ${o.metric.tick(0)}–${o.metric.tick(limit)}`, { weight: 600, size: 12, fill: T.ink }));
      }
      let last = -Infinity;
      for (const tick of scale.ticks) {
        svg.append(s('line', { x1: tick.p, x2: tick.p, y1: 40, y2: o.bottom, stroke: T.grid }));
        const w = AA.textWidth(tick.label, 11);
        if (tick.p - w / 2 <= last + 5) continue;
        svg.append(AA.text(tick.p, 31, tick.label, { anchor: 'middle', fill: T.muted }));
        last = tick.p + w / 2;
      }
      return { left, right, limit, sx: scale };
    });
  }
  function fitLevels(width, left, values, metric) {
    const room = width - left;
    return AA.focusLimits(values, metric, room >= 600 ? 2 : 1).slice(0, room >= 420 ? 2 : 0);
  }
  function drawLinked(stage, W, H, name, options) {
    const height = AA.linkedHeight(options, W, H);
    const svg = canvas(stage, W, height, name);
    return { ...AA.linked(svg, { ...options, area: { L: 0, T: 0, W, H: height } }), svg };
  }
  const cellInk = (step) => {
    const dark = document.documentElement.dataset.theme === 'dark';
    return (dark ? step < 3 : step >= 3) ? '#ffffff' : '#0b0b0b';
  };

  // ---------- 价格-智能曲线 ----------
  V.curve = {
    title: () => (AA.state.x === 'cost' && AA.state.y === 'iq' ? '单任务价格 × 智能指数' : `${M(AA.state.x).name} × ${M(AA.state.y).name}`),
    hint: () => '线性刻度、从 0 起：相同距离就是相同差值；拥挤区在局部图中展开',
    options: ['x', 'swap', 'y', 'focus', 'color', 'labels', 'display'],
    legend: true,
    draw({ stage, rows, W, H }) {
      const S = AA.state;
      const mx = M(S.x);
      const my = M(S.y);
      const shown = S.nr === 'hide' ? rows.filter((r) => r.effort !== 'non-reasoning') : rows;
      if (!shown.some((r) => AA.value(mx, r) !== null && AA.value(my, r) !== null)) return empty(stage);
      return drawLinked(stage, W, H, V.curve.title(), {
        rows: shown, mx, my, xrev: S.xrev, yrev: S.yrev,
        xTitle: `${axisTitle(mx)} · ${arrow(mx)}`, yTitle: axisTitle(my),
        connect: S.connect, frontier: S.frontier, labels: S.labels, tiers: S.tiers,
        defaults: S.defaults, arrows: S.arrows, size: S.size === 'none' ? null : M(S.size),
      });
    },
  };

  // ---------- 分面小图 ----------
  V.facet = {
    title: () => `分面小图：${M(AA.state.x).name} × ${M(AA.state.y).name}`,
    hint: () => '所有小图共用坐标，灰线是其余模型',
    options: ['facetBy', 'x', 'swap', 'y', 'focus', 'facetContext', 'color'],
    legend: true,
    draw({ stage, rows, W, H }) {
      const S = AA.state;
      const mx = M(S.x);
      const my = M(S.y);
      const shown = rows.filter((r) => AA.value(mx, r) !== null && AA.value(my, r) !== null);
      if (!shown.length) return empty(stage);
      const key = {
        model: (r) => r.group,
        vendor: (r) => r.vendor,
        region: (r) => ({ us: '美国', cn: '中国', other: '其他地区' })[r.region],
        weights: (r) => (r.open ? '开放权重' : '闭源'),
      }[S.facetBy];
      let facets = [...AA.groupBy(shown, key)].sort((a, b) => bestIq(b[1]) - bestIq(a[1]));
      if (S.facetBy === 'model') facets = facets.sort((a, b) => (b[1].length > 1) - (a[1].length > 1));
      const split = W >= 420 && AA.linkedPlan({ rows: shown, mx, my, levels: 1 }, W).limits.length > 0;
      const cols = Math.max(1, Math.min(facets.length, Math.floor(W / (split ? 420 : 265))));
      const cw = W / cols;
      const lines = Math.ceil(facets.length / cols);
      const ch = Math.max(split ? 245 : 215, Math.min(400, H / lines));
      const svg = canvas(stage, W, lines * ch, '分面小图');
      const hits = [];
      const panels = [];
      facets.forEach(([name, list], i) => {
        const x = (i % cols) * cw;
        const y = Math.floor(i / cols) * ch;
        const g = s('g');
        const title = S.facetBy === 'model' ? AA.modelName(name) : name;
        g.append(AA.text(x + 42, y + 14, AA.ellipsis(title, cw - 120, 12, 600), { size: 12, weight: 600, fill: AA.theme.ink }));
        g.append(AA.text(x + cw - 12, y + 14, `${list.length} 点 · 最高 ${bestIq(list).toFixed(1)}`, { anchor: 'end', size: 10, fill: AA.theme.muted }));
        const out = AA.linked(g, {
          rows: list, context: S.facetContext ? shown : null, domain: shown, mx, my, mini: true,
          area: { L: x, T: y + 22, W: cw, H: ch - 28 }, levels: split ? 1 : 0, sideways: true,
          connect: 'effort', labels: S.facetBy === 'model' ? 'none' : 'auto', tiers: 'none',
        });
        svg.append(g);
        hits.push(...out.hits);
        panels.push(...out.panels);
      });
      return { hits, panels };
    },
  };

  // ---------- 发布趋势 ----------
  V.time = {
    title: () => `发布趋势：${M(AA.state.metric).name}`,
    hint: () => '灰色阶梯是截至当日的最好成绩；仅含仍在榜的模型',
    options: ['metric', 'focus', 'color', 'labels'],
    legend: true,
    draw({ stage, rows, W, H }) {
      const S = AA.state;
      const my = M(S.metric);
      const mx = M('released');
      const shown = rows.filter((r) => AA.value(my, r) !== null && r.date);
      if (!shown.length) return empty(stage);
      return drawLinked(stage, W, H, V.time.title(), {
        rows: shown, mx, my,
        xTitle: '发布日期', yTitle: axisTitle(my), connect: 'effort', frontier: true,
        labels: S.labels, tiers: 'none',
      });
    },
  };

  // ---------- 档位走势 ----------
  V.effort = {
    title: () => `档位走势：${M(AA.state.metric).name}`,
    hint: () => ({ value: '各档位的实际值', times: '以各模型可见的最低推理档为 1 倍', delta: '相对各模型可见的最低推理档的增减' })[AA.state.relative],
    options: ['metric', 'relative', 'focus', 'color', 'labels'],
    legend: true,
    draw({ stage, rows, W, H }) {
      const S = AA.state;
      const source = M(S.metric);
      const shown = rows.filter((r) => r.effort && AA.value(source, r) !== null && !(S.nr === 'hide' && r.effort === 'non-reasoning'));
      if (!shown.length) return empty(stage, '当前结果里没有带档位的数据');
      const base = new Map([...AA.groupBy(shown)].map(([g, list]) => {
        const ordered = list.sort((a, b) => a.rank - b.rank);
        return [g, AA.value(source, ordered.find((r) => r.effort !== 'non-reasoning') || ordered[0])];
      }));
      const getY = (r) => {
        const v = AA.value(source, r);
        if (v === null || S.relative === 'value') return v;
        if (S.relative === 'delta') return v - base.get(r.group);
        return base.get(r.group) > 0 ? v / base.get(r.group) : null;
      };
      const my = {
        value: source,
        times: { ...source, name: `${source.name}倍数`, unit: '×', interval: false, tick: (v) => `${Number(v.toPrecision(3))}×` },
        delta: { ...source, name: `${source.name}增减`, interval: false, tick: source.id === 'released' ? (v) => `${Math.round(v / 864e5)} 天` : source.tick },
      }[S.relative];
      const efforts = AA.EFFORTS.filter((e) => shown.some((r) => r.effort === e.id));
      return drawLinked(stage, W, H, V.effort.title(), {
        rows: shown, mx: source, my, getY, getX: (r) => efforts.findIndex((e) => e.id === r.effort),
        categories: efforts.map((e) => e.name),
        xTitle: '推理档位', yTitle: axisTitle(my), connect: 'effort',
        labels: S.labels, labelAtEnd: true, tiers: 'none',
      });
    },
  };

  // ---------- 升档收益 ----------
  AA.steps = (rows, mode) => {
    const out = [];
    for (const [group, all] of AA.groupBy(rows)) {
      const list = all.filter((r) => r.cost !== null && r.rank !== null && r.effort !== 'non-reasoning').sort((a, b) => a.rank - b.rank);
      if (list.length < 2) continue;
      const pairs = mode === 'total' ? [[list[0], list[list.length - 1]]] : list.slice(1).map((r, i) => [list[i], r]);
      for (const [from, to] of pairs) {
        const gain = to.iq - from.iq;
        out.push({
          group, from, to, gain,
          cost: from.cost > 0 && to.cost > 0 ? to.cost / from.cost : null,
          time: from.minutes > 0 && to.minutes > 0 ? to.minutes / from.minutes : null,
          // 升档反而降价时边际花费记 0，避免出现没有意义的负单价
          marginal: gain > 0 ? Math.max(0, to.cost - from.cost) / gain : null,
          cheaper: to.cost < from.cost,
        });
      }
    }
    return out;
  };
  V.step = {
    title: () => '升档收益：多花的钱换来多少智能',
    hint: () => '蓝色有利、红色不利；条长与数值成正比，倍数列的竖线是 1×',
    options: ['stepMode', 'stepSort'],
    draw({ stage, rows, W }) {
      const S = AA.state;
      const T = AA.theme;
      const items = AA.steps(rows, S.stepMode);
      if (!items.length) return empty(stage, '没有可比较的相邻档位', '需要同一模型至少两个可见档位。');
      const sorters = {
        gain: (a, b) => b.gain - a.gain,
        cost: (a, b) => (b.cost ?? -1) - (a.cost ?? -1),
        marginal: (a, b) => (a.marginal ?? Infinity) - (b.marginal ?? Infinity),
      };
      const rank = new Map(modelsByIq(rows).map(([g], i) => [g, i]));
      items.sort(sorters[S.stepSort] || ((a, b) => rank.get(a.group) - rank.get(b.group) || a.from.rank - b.from.rank));
      const defs = [
        { key: 'gain', name: '智能增量', fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`, base: 0, good: 1 },
        { key: 'cost', name: '价格倍数', fmt: (v) => `${v.toFixed(2)}×`, base: 1, good: -1 },
        { key: 'time', name: '耗时倍数', fmt: (v) => `${v.toFixed(2)}×`, base: 1, good: -1 },
        { key: 'marginal', name: '每 +1 分多花', fmt: AA.fmt.money, base: 0, good: -1 },
      ];
      const local = AA.focusLimits(items.map((it) => it.marginal).filter((v) => v !== null), M('cost'), 1)[0];
      if (local) defs.push({ ...defs[3], name: `同左 · 局部 0–${AA.fmt.money(local)}`, limit: local });
      const width = Math.max(W, 285 + defs.length * 135);
      const left = 285;
      const col = (width - left - 10) / defs.length;
      const rh = 27;
      const svg = canvas(stage, width, 54 + items.length * rh, '升档收益');
      defs.forEach((def, i) => {
        const x0 = left + i * col;
        svg.append(AA.text(x0 + col / 2, 18, def.name, { anchor: 'middle', weight: 600, size: 11.5, fill: T.ink }));
        const values = items.map((it) => it[def.key]).filter((v) => v !== null);
        const min = Math.min(0, ...values);
        const max = def.limit || Math.max(def.base, 0, ...values);
        const room = col - 68 - (min < 0 ? 44 : 0);
        const k = room / (max - min || 1);
        const zero = x0 + 8 + (min < 0 ? 44 : 0) - min * k;
        svg.append(s('line', { x1: zero, x2: zero, y1: 38, y2: 42 + items.length * rh, stroke: T.axis }));
        items.forEach((it, j) => {
          const y = 48 + j * rh + rh / 2;
          const v = it[def.key];
          if (v === null) {
            // 只有边际花费的 null 表示没有增益，倍数列的 null 是缺数据
            svg.append(AA.text(zero + 5, y, def.key === 'marginal' ? '无增益' : '—', { fill: T.muted }));
            return;
          }
          if (def.limit && v > def.limit) {
            svg.append(AA.text(zero + 5, y, '超出，见左列', { fill: T.muted }));
            return;
          }
          const d = v * k;
          svg.append(s('rect', { x: Math.min(zero, zero + d), y: y - 6, width: Math.abs(d), height: 12, fill: (v - def.base) * def.good >= 0 ? T.pos : T.neg }));
          const text = def.key === 'marginal' && it.cheaper ? '反而更省' : def.fmt(v);
          svg.append(AA.text(zero + d + (d < 0 ? -5 : 5), y, text, { anchor: d < 0 ? 'end' : 'start' }));
        });
        if (def.base) {
          const x = zero + k;
          svg.append(s('line', { x1: x, x2: x, y1: 38, y2: 42 + items.length * rh, stroke: T.muted }));
          svg.append(AA.text(x, 32, '1×', { anchor: 'middle', fill: T.muted, size: 9.5 }));
        }
      });
      const hits = items.map((it, j) => {
        const y = 48 + j * rh + rh / 2;
        label(svg, it.to, left - 10, y, left - 18, { text: `${it.to.model}  ${AA.effortName(it.from)} → ${AA.effortName(it.to)}` });
        return { x: 0, y: y - rh / 2, w: width, h: rh, row: it.to, group: it.group, step: it };
      });
      return { hits };
    },
  };

  // ---------- 档位跨度 ----------
  V.range = {
    title: () => `档位跨度：${M(AA.state.metric).name}`,
    hint: () => '每行一个模型，线段两端是可见档位中的最小值与最大值',
    options: ['metric', 'focus'],
    legend: 'effort',
    draw({ stage, rows, W }) {
      const S = AA.state;
      const T = AA.theme;
      const m = M(S.metric);
      const valued = rows.filter((r) => AA.value(m, r) !== null);
      if (!valued.length) return empty(stage);
      const of = (list) => list.map((r) => AA.value(m, r));
      const top = (list) => (m.good > 0 ? Math.max(...of(list)) : -Math.min(...of(list)));
      const models = [...AA.groupBy(valued)].sort((a, b) => (b[1].length > 1) - (a[1].length > 1) || top(b[1]) - top(a[1]));
      const width = Math.max(W, 620);
      const left = Math.min(225, width * 0.32);
      const rh = 30;
      const bottom = 44 + models.length * rh;
      const svg = canvas(stage, width, bottom + 12, V.range.title());
      const values = of(valued);
      const panels = rowColumns(svg, {
        values, metric: m, bottom, left: left + 12, right: width - 118, gap: 30, zero: !m.interval,
        limits: fitLevels(width - 118, left + 12, values, m),
      });
      const hits = [];
      models.forEach(([group, list], i) => {
        const y = 44 + i * rh + rh / 2;
        label(svg, list[0], left, y, left - 8, { text: list[0].model });
        const pts = list.map((r) => ({ r, v: AA.value(m, r) })).sort((a, b) => a.v - b.v);
        const min = pts[0].v;
        const max = pts[pts.length - 1].v;
        for (const { sx, limit, left: x0, right } of panels) {
          if (limit === null || min <= limit) {
            const end = limit === null ? max : Math.min(max, limit);
            svg.append(s('line', { x1: sx.pos(min), x2: sx.pos(end), y1: y, y2: y, stroke: T.axis, 'stroke-width': 3 }));
          }
          if (limit !== null && max > limit) {
            svg.append(min > limit
              ? AA.text(x0 + 5, y, '超出，见全程', { fill: T.muted })
              : AA.text(right + 5, y, '→', { fill: T.muted }));
          }
          for (const p of pts) {
            if (limit !== null && p.v > limit) continue;
            const x = sx.pos(p.v);
            svg.append(AA.mark(0, x, y, 5.5, AA.effortColor(p.r.effort), { hollow: p.r.effort === 'non-reasoning' }));
            hits.push({ x, y, row: p.r, group });
          }
        }
        const text = min === max ? m.fmt(min) : `${m.fmt(min)}–${m.fmt(max)}`;
        svg.append(AA.text(width - 4, y, text, { anchor: 'end' }));
      });
      return { hits, panels };
    },
  };

  // ---------- 档位热力图 ----------
  V.matrix = {
    title: () => `档位热力图：${M(AA.state.metric).name}`,
    hint: () => '颜色强度与数值成线性关系；空格表示未测试或被筛除',
    options: ['metric'],
    draw({ stage, rows, W }) {
      const S = AA.state;
      const T = AA.theme;
      const m = M(S.metric);
      const valued = rows.filter((r) => AA.value(m, r) !== null);
      if (!valued.length) return empty(stage);
      const cols = AA.EFFORTS.filter((e) => valued.some((r) => r.effort === e.id)).map((e) => ({ id: e.id, name: e.name }));
      if (valued.some((r) => !r.effort)) cols.push({ id: null, name: '单档' });
      // 同一档位有多个配置时拆成多行，一个都不丢
      const models = modelsByIq(valued).sort((a, b) => (b[1].length > 1) - (a[1].length > 1)).flatMap(([group, list]) => {
        const byEffort = [...AA.groupBy(list, (r) => r.effort || null).values()];
        const count = Math.max(...byEffort.map((same) => same.length));
        return Array.from({ length: count }, (_, k) => ({
          group,
          list: byEffort.flatMap((same) => same.slice(k, k + 1)),
          tag: count > 1 ? `（${k + 1}/${count}）` : '',
        }));
      });
      const width = Math.max(W, 660);
      const left = 220;
      const cw = (width - left - 8) / cols.length;
      const rh = 29;
      const svg = canvas(stage, width, 42 + models.length * rh, V.matrix.title());
      const values = valued.map((r) => AA.value(m, r));
      const lo = colorFloor(values, m);
      const hi = Math.max(...values);
      cols.forEach((c, i) => svg.append(AA.text(left + (i + 0.5) * cw, 18, c.name, { anchor: 'middle', weight: 600, fill: T.ink })));
      const hits = [];
      models.forEach(({ group, list, tag }, j) => {
        const y = 36 + j * rh;
        // 只截短模型名，序号留着
        const text = AA.ellipsis(list[0].model, left - 16 - AA.textWidth(tag, 11.5), 11.5) + tag;
        label(svg, list[0], left - 9, y + rh / 2, left - 15, { text });
        cols.forEach((c, i) => {
          const x = left + i * cw;
          const row = list.find((r) => (r.effort || null) === c.id);
          const step = row ? shade(AA.value(m, row), lo, hi) : 0;
          svg.append(s('rect', { x: x + 1, y: y + 1, width: cw - 2, height: rh - 2, rx: 3, fill: row ? T.seq[step] : T.band }));
          if (!row) return;
          svg.append(AA.text(x + cw / 2, y + rh / 2, m.fmt(AA.value(m, row)), { anchor: 'middle', fill: cellInk(step), size: 11.5 }));
          hits.push({ x, y, w: cw, h: rh, row, group });
        });
      });
      return { hits };
    },
  };

  // ---------- 指标排行 ----------
  V.rank = {
    title: () => `指标排行：${M(AA.state.metric).name}`,
    hint: () => `${arrow(M(AA.state.metric))}，最优在上；每个模型只看一档可在“代表档”筛选中切换`,
    options: ['metric', 'focus', 'color'],
    legend: true,
    draw({ stage, rows, W }) {
      const S = AA.state;
      const T = AA.theme;
      const m = M(S.metric);
      const list = rows.filter((r) => AA.value(m, r) !== null).sort((a, b) => (AA.value(m, b) - AA.value(m, a)) * m.good);
      if (!list.length) return empty(stage);
      const width = Math.max(W, 520);
      const left = Math.min(290, width * 0.42);
      const rh = 24;
      const bottom = 42 + list.length * rh;
      const svg = canvas(stage, width, bottom + 10, V.rank.title());
      const values = list.map((r) => AA.value(m, r));
      const dots = m.interval; // 日期和 Elo 没有零点，只画点不画条
      const panels = rowColumns(svg, {
        values, metric: m, bottom, left, right: width - 72, zero: !dots,
        limits: dots ? [] : fitLevels(width - 72, left, values, m),
      });
      const pins = AA.pinned();
      const hits = list.map((row, i) => {
        const y = 42 + i * rh;
        const v = values[i];
        label(svg, row, left - 8, y + rh / 2, left - 42);
        svg.append(AA.text(2, y + rh / 2, i + 1, { fill: T.muted, size: 10 }));
        const opacity = pins.length && !pins.includes(row.group) ? 0.3 : null;
        for (const { sx, limit, left: x0 } of panels) {
          if (limit !== null && v > limit) {
            // 不画截断的条，否则会被读成恰好等于上限
            svg.append(AA.text(x0 + 5, y + rh / 2, '超出，见全程', { fill: T.muted }));
            continue;
          }
          const x = sx.pos(v);
          const base = dots ? x : sx.pos(0);
          svg.append(dots
            ? s('circle', { cx: x, cy: y + rh / 2, r: 4.5, fill: AA.color(row), opacity })
            : s('rect', { x: Math.min(base, x), y: y + 4, width: Math.abs(x - base), height: rh - 8, fill: AA.color(row), opacity, 'data-bar': v }));
          svg.append(AA.text(Math.max(base, x) + 6, y + rh / 2, m.fmt(v)));
        }
        return { x: 0, y, w: width, h: rh, row, group: row.group };
      });
      return { hits, panels };
    },
  };

  // ---------- 成本拆解 ----------
  AA.costSegments = (rows, mode) => {
    const T = AA.theme;
    if (mode === 'tokens') {
      return [
        { name: '推理 Token', color: T.cat[0], get: (r) => r.tokensReasoning || 0 },
        { name: '答案 Token', color: T.cat[1], get: (r) => r.tokensAnswer || 0 },
      ];
    }
    if (mode === 'evals') {
      const sum = (key) => AA.rows.reduce((n, r) => n + (r.costByEval[key] || 0), 0);
      const keys = [...AA.indexEvals].sort((a, b) => sum(b) - sum(a));
      const rest = keys.slice(7);
      const top = keys.slice(0, 7).map((key, i) => ({ name: AA.evalName(key), color: T.cat[i], get: (r) => r.costByEval[key] || 0 }));
      return rest.length ? [...top, { name: '其他评测', color: T.other, get: (r) => rest.reduce((n, key) => n + (r.costByEval[key] || 0), 0) }] : top;
    }
    return [['nonCacheInput', '未缓存输入'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['reasoning', '推理输出'], ['answer', '答案输出']]
      .map(([key, name], i) => ({ name, color: T.cat[i], get: (r) => r.costParts?.[key] || 0 }));
  };
  V.cost = {
    title: () => '成本拆解：钱花在哪里',
    hint: () => (AA.state.costMode === 'tokens' ? '单任务输出 Token 的构成' : '单任务价格的构成'),
    options: ['costMode', 'order', 'focus'],
    legend: 'segments',
    draw({ stage, rows, W }) {
      const S = AA.state;
      const T = AA.theme;
      const parts = AA.costSegments(rows, S.costMode);
      const total = (r) => parts.reduce((n, p) => n + p.get(r), 0);
      const list = rows.filter((r) => total(r) > 0);
      if (!list.length) return empty(stage, '当前结果没有成本构成数据');
      list.sort({ iq: (a, b) => b.iq - a.iq, cost: (a, b) => total(b) - total(a), name: (a, b) => a.model.localeCompare(b.model) || a.rank - b.rank }[S.order]);
      const width = Math.max(W, 600);
      const left = Math.min(280, width * 0.4);
      const right = width - 76;
      const share = S.costMode === 'share';
      const fmt = S.costMode === 'tokens' ? AA.fmt.big : AA.fmt.money;
      const rh = 25;
      const svg = canvas(stage, width, 54 + list.length * rh, '成本拆解');
      const totals = list.map(total);
      const axis = share
        ? { ...M('cost'), tick: (v) => `${Math.round(v * 100)}%` }
        : { ...M('cost'), tick: S.costMode === 'tokens' ? AA.fmt.big : M('cost').tick };
      const panels = rowColumns(svg, {
        values: share ? [1 / 1.05] : totals, metric: axis, bottom: 46 + list.length * rh, left, right, zero: true,
        limits: share ? [] : fitLevels(right, left, totals, axis),
      });
      const hits = list.map((row, i) => {
        const y = 44 + i * rh;
        const sum = totals[i];
        label(svg, row, left - 8, y + rh / 2, left - 12);
        for (const { sx, limit, left: x0 } of panels) {
          if (limit !== null && sum > limit) {
            svg.append(AA.text(x0 + 5, y + rh / 2, '超出，见全程', { fill: T.muted }));
            continue;
          }
          let x = sx.pos(0);
          for (const p of parts) {
            const w = (p.get(row) / (share ? sum : 1)) * sx.k;
            if (w > 0) svg.append(s('rect', { x, y: y + 4, width: w > 4 ? w - 1 : w, height: rh - 8, fill: p.color }));
            if (share && w > 42) svg.append(AA.text(x + w / 2, y + rh / 2, `${Math.round((p.get(row) / sum) * 100)}%`, { anchor: 'middle', fill: [T.cat[2], T.cat[3], T.cat[4]].includes(p.color) ? '#0b0b0b' : '#ffffff', size: 10 }));
            x += w;
          }
          svg.append(AA.text(x + 6, y + rh / 2, fmt(sum)));
        }
        return { x: 0, y, w: width, h: rh, row, group: row.group, parts: parts.map((p) => [p.name, fmt(p.get(row)), p.color]) };
      });
      return { hits, panels };
    },
  };

  // ---------- 评测热力图 ----------
  V.bench = {
    title: () => '评测热力图：智能分由什么组成',
    hint: () => '每列独立着色，只能纵向比较深浅',
    options: ['benchScope'],
    draw({ stage, rows, W }) {
      const T = AA.theme;
      let keys = AA.indexEvals.filter((k) => rows.some((r) => r.scores[k] !== undefined));
      let list = [...rows].sort((a, b) => b.iq - a.iq);
      if (AA.state.benchScope === 'best') {
        const seen = new Set();
        list = list.filter((r) => !seen.has(r.group) && seen.add(r.group));
      }
      if (!list.length || !keys.length) return empty(stage);
      keys = [null, ...keys];
      const metrics = keys.map((k) => (k ? M(`score:${k}`) : M('iq')));
      const width = Math.max(W, 340 + keys.length * 74);
      const left = 245;
      const cw = (width - left - 112) / keys.length;
      const head = 118;
      const rh = 27;
      const svg = canvas(stage, width, head + list.length * rh + 6, '评测热力图');
      const bounds = metrics.map((m) => {
        const values = list.map((r) => AA.value(m, r)).filter((v) => v !== null);
        return [colorFloor(values, m), Math.max(...values)];
      });
      metrics.forEach((m, i) => svg.append(AA.text(left + (i + 0.3) * cw, head - 9, AA.ellipsis(m.name, 158, 10.5), { rotate: -38, size: 10.5, fill: T.ink })));
      const hits = [];
      list.forEach((row, j) => {
        const y = head + j * rh;
        label(svg, row, left - 8, y + rh / 2, left - 12);
        metrics.forEach((m, i) => {
          const x = left + i * cw;
          const v = AA.value(m, row);
          const step = v === null ? 0 : shade(v, ...bounds[i]);
          svg.append(s('rect', { x: x + 1, y: y + 1, width: cw - 2, height: rh - 2, rx: 3, fill: v === null ? T.band : T.seq[step] }));
          if (v === null) return;
          svg.append(AA.text(x + cw / 2, y + rh / 2, m.fmt(v), { anchor: 'middle', size: 10.5, fill: cellInk(step) }));
          hits.push({ x, y, w: cw, h: rh, row, group: row.group, extra: [m.name, m.fmt(v)] });
        });
      });
      return { hits };
    },
  };

  // ---------- 预算选型 ----------
  AA.recommend = (rows) => {
    const S = AA.state;
    const cap = S.tasks > 0 ? S.budget / S.tasks : Infinity;
    const ok = rows.filter((r) => r.cost !== null && r.cost <= cap && r.iq >= S.minIq && (S.maxMin === 0 || (r.minutes !== null && r.minutes <= S.maxMin)));
    const best = (list, better) => list.reduce((a, b) => (!a || better(b, a) ? b : a), null);
    return {
      cap, ok,
      smart: best(ok, (b, a) => b.iq > a.iq || (b.iq === a.iq && b.cost < a.cost)),
      cheap: best(ok, (b, a) => b.cost < a.cost || (b.cost === a.cost && b.iq > a.iq)),
      fast: best(ok.filter((r) => r.minutes !== null), (b, a) => b.minutes < a.minutes),
    };
  };
  V.pick = {
    title: () => '预算选型',
    hint: () => '高亮区域是同时满足预算与智能下限的范围',
    options: ['tasks', 'budget', 'minIq', 'maxMin', 'focus'],
    legend: true,
    draw({ stage, rows, W, H }) {
      const S = AA.state;
      const T = AA.theme;
      const result = AA.recommend(rows);
      const card = (name, row) => h('button', { class: 'pick-card', disabled: !row, 'data-pick': name, onclick: () => row && AA.ui.details(row.group) },
        h('span', { class: 'muted' }, name),
        h('strong', {}, row ? row.label : '没有满足条件的配置'),
        row && h('span', {}, `智能 ${row.iq.toFixed(1)} · ${AA.fmt.money(row.cost)}/任务 · ${AA.show(M('minutes'), row.minutes)}`),
        row && S.tasks > 0 && h('span', { class: 'muted' }, `每月约 ${AA.fmt.money(row.cost * S.tasks)}`));
      const cards = h('div', { class: 'pick-cards' }, card('最聪明', result.smart), card('最省钱', result.cheap), card('最快', result.fast));
      const note = h('p', { class: 'pick-note' },
        `单任务预算上限 ${Number.isFinite(result.cap) ? AA.fmt.money(result.cap) : '不限'}，${result.ok.length} 个配置满足全部条件。任务用量以 AA 智能指数评测中的平均任务为准。`);
      stage.append(cards, note);

      const wrap = h('div', { class: 'pick-plot' });
      stage.append(wrap);
      const costed = rows.filter((r) => r.cost !== null);
      if (!costed.length) return empty(wrap);
      const chosen = new Set([result.smart, result.cheap, result.fast].filter(Boolean).map((r) => r.id));
      const ok = new Set(result.ok.map((r) => r.id));
      const out = drawLinked(wrap, W, Math.max(340, H - cards.offsetHeight - note.offsetHeight - 14), '预算选型', {
        rows: costed, mx: M('cost'), my: M('iq'), minHeight: 470,
        xTitle: '单任务价格（USD）', yTitle: '智能指数', connect: 'effort', frontier: true, labels: 'auto', tiers: 'none',
        underlay(g, sx, sy, box) {
          if (!(result.cap > 0)) return;
          const right = Number.isFinite(result.cap) ? Math.min(box.r, sx.pos(result.cap)) : box.r;
          const bottom = Math.min(box.b, sy.pos(S.minIq));
          if (right > box.l && bottom > box.t) g.append(s('rect', { x: box.l, y: box.t, width: right - box.l, height: bottom - box.t, fill: T.pos, opacity: 0.08 }));
        },
      });
      const { svg } = out;
      for (const hit of out.hits) {
        if (chosen.has(hit.row.id)) svg.append(s('circle', { cx: hit.x, cy: hit.y, r: 11, fill: 'none', stroke: T.ink, 'stroke-width': 2, 'pointer-events': 'none' }));
        else if (!ok.has(hit.row.id)) svg.append(s('circle', { cx: hit.x, cy: hit.y, r: 5.5, fill: T.surface, opacity: 0.62, 'pointer-events': 'none' }));
      }
      return out;
    },
  };

  // ---------- 模型对比 ----------
  V.compare = {
    title: () => '模型对比',
    hint: () => '最多 8 个；在右侧列表点图钉即可加入',
    options: ['compareAdd', 'focus'],
    legend: 'pins',
    draw({ stage, rows, W, H }) {
      const pins = AA.pinned();
      if (!pins.length) {
        const top = modelsByIq(rows.filter((r) => r.cost !== null)).slice(0, 4).map(([g]) => g);
        stage.append(h('div', { class: 'empty' }, h('strong', {}, '还没有选择要对比的模型'),
          h('p', {}, '在右侧列表点图钉，或从上方下拉框添加。'),
          top.length > 0 && h('button', { class: 'btn primary', onclick: () => AA.set({ pins: top }) }, '对比当前最强的几个模型')));
        return {};
      }
      const list = rows.filter((r) => pins.includes(r.group));
      if (!list.length) return empty(stage, '固定的模型都被筛选条件排除了');
      const panels = [
        ['cost', 'iq', '价格 → 智能'], [null, 'cost', '各档位价格'],
        ['minutes', 'iq', '耗时 → 智能'], [null, 'minutes', '各档位耗时'],
      ];
      const efforts = AA.EFFORTS.filter((e) => list.some((r) => r.effort === e.id));
      const categories = [...efforts.map((e) => e.name), ...(list.some((r) => !r.effort) ? ['单档'] : [])];
      const specs = panels.map(([x, y, title]) => {
        const options = {
          rows: list, mx: M(x || y), my: M(y), mini: true, colorMode: 'pins',
          categories: x ? null : categories,
          getX: x ? null : (r) => (r.effort ? efforts.findIndex((e) => e.id === r.effort) : categories.length - 1),
          xTitle: x ? axisTitle(M(x)) : '推理档位', yTitle: axisTitle(M(y)),
          connect: 'effort', labels: 'auto', labelAtEnd: !x, tiers: 'none', sideways: W >= 600,
        };
        const split = AA.linkedPlan(options, W).limits.length;
        return { title, options, split, height: split ? (W >= 600 ? 330 : (split + 1) * 280) : 290 };
      });
      // 需要分级的图独占一行，其余两两并排
      let top = 0;
      let column = 0;
      for (const spec of specs) {
        const half = !spec.split && W >= 620;
        if (column && !half) {
          top += 290;
          column = 0;
        }
        spec.area = { L: column * (W / 2), T: top + 22, W: half ? W / 2 : W, H: spec.height - 26 };
        if (half && !column) column = 1;
        else {
          top += spec.height;
          column = 0;
        }
      }
      if (column) top += 290;
      const svg = canvas(stage, W, Math.max(top, 290), '模型对比');
      const hits = [];
      const drawn = [];
      for (const { title, options, area } of specs) {
        svg.append(AA.text(area.L + 12, area.T - 9, title, { weight: 600, size: 12.5, fill: AA.theme.ink }));
        const out = AA.linked(svg, { ...options, area });
        hits.push(...out.hits);
        drawn.push(...out.panels);
      }

      const ids = ['iq', 'cost', 'minutes', 'ttft', 'speed', 'value'];
      const ordered = [...list].sort((a, b) => pins.indexOf(a.group) - pins.indexOf(b.group) || (a.rank ?? 0) - (b.rank ?? 0));
      const winners = ids.map((id) => {
        const values = list.map((r) => AA.value(M(id), r)).filter((v) => v !== null);
        return M(id).good > 0 ? Math.max(...values) : Math.min(...values);
      });
      stage.append(h('table', { class: 'data compare-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '配置'), ids.map((id) => h('th', { class: 'num' }, M(id).name)))),
        h('tbody', {}, ordered.map((row) => h('tr', {},
          h('td', {}, h('i', { class: 'swatch', style: { background: AA.color(row, 'pins') } }), row.label),
          ids.map((id, i) => {
            const v = AA.value(M(id), row);
            return h('td', { class: `num${v !== null && v === winners[i] ? ' best' : ''}` }, AA.show(M(id), v));
          }))))));
      return { hits, panels: drawn };
    },
  };

  // ---------- 数据表 ----------
  AA.tableRows = (rows) => {
    const { sort, asc } = AA.state;
    const get = sort === 'name' ? (r) => r.label : sort === 'vendor' ? (r) => r.vendor : (r) => AA.value(M(sort), r);
    return [...rows].sort((a, b) => {
      const p = get(a);
      const q = get(b);
      if (p === null || q === null) return (p === null) - (q === null);
      return (typeof p === 'string' ? p.localeCompare(q) : p - q) * (asc ? 1 : -1);
    });
  };
  V.table = {
    title: () => '完整数据表',
    hint: () => '含缺少价格、未能入图的配置；点表头排序，点行看详情',
    options: ['columns', 'csv'],
    draw({ stage, rows }) {
      if (!rows.length) return empty(stage);
      const S = AA.state;
      const th = (key, name, cls) => h('th', { class: cls, 'aria-sort': S.sort === key ? (S.asc ? 'ascending' : 'descending') : null },
        h('button', { 'data-sort': key, onclick: () => AA.set({ sort: key, asc: S.sort === key ? !S.asc : key === 'name' || key === 'vendor' }) },
          name, S.sort === key ? (S.asc ? ' ↑' : ' ↓') : ''));
      stage.append(h('table', { class: 'data full-table' },
        h('thead', {}, h('tr', {}, th('name', '模型与档位', 'sticky'), th('vendor', '厂商'), S.cols.map((id) => th(id, M(id).name, 'num')))),
        h('tbody', {}, AA.tableRows(rows).map((row) => h('tr', {
          tabindex: 0,
          onclick: () => AA.ui.details(row.group),
          onkeydown: (e) => { if (e.key === 'Enter') AA.ui.details(row.group); },
        },
        h('td', { class: 'sticky' }, h('i', { class: 'swatch', style: { background: AA.color(row, 'vendor') } }), row.label),
        h('td', {}, row.vendor),
        S.cols.map((id) => h('td', { class: 'num' }, AA.show(M(id), AA.value(M(id), row)))))))));
      return {};
    },
  };
})();
