/* 通用绘图层：比例尺、坐标系、折线、前沿与标签避让。 */
(() => {
  'use strict';
  const AA = window.AA;
  const { s } = AA;
  const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  AA.FONT = FONT;

  const ruler = document.createElement('canvas').getContext('2d');
  const widths = new Map();
  AA.textWidth = (text, size = 11, weight = 400) => {
    const key = `${weight}|${size}|${text}`;
    if (!widths.has(key)) {
      ruler.font = `${weight} ${size}px ${FONT}`;
      widths.set(key, ruler.measureText(text).width);
    }
    return widths.get(key);
  };
  AA.ellipsis = (text, max, size = 11, weight = 400) => {
    if (AA.textWidth(text, size, weight) <= max) return text;
    let out = text;
    while (out.length > 1 && AA.textWidth(`${out}…`, size, weight) > max) out = out.slice(0, -1);
    return `${out}…`;
  };
  AA.text = (x, y, value, options = {}) => s('text', {
    x, y,
    fill: options.fill || AA.theme.ink2,
    'font-size': options.size || 11,
    'font-weight': options.weight,
    'text-anchor': options.anchor,
    'dominant-baseline': options.base || 'central',
    transform: options.rotate ? `rotate(${options.rotate} ${x} ${y})` : null,
    class: options.cls,
  }, value);
  AA.svg = (width, height, name) => s('svg', {
    width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': name, tabindex: 0,
    'font-family': FONT, class: 'chart',
  });

  const SYMBOLS = [
    null, // 圆
    'M-1-1H1V1H-1Z',
    'M0-1.35 1.35 0 0 1.35-1.35 0Z',
    'M0-1.3 1.2 .9H-1.2Z',
    'M0 1.3 1.2-.9H-1.2Z',
    'M-1.2 0-.6-1.05H.6L1.2 0 .6 1.05H-.6Z',
    'M-.45-1.3H.45V-.45H1.3V.45H.45V1.3H-.45V.45H-1.3V-.45H-.45Z',
  ];
  AA.mark = (shape, x, y, r, fill, options = {}) => {
    const attrs = {
      fill: options.hollow ? AA.theme.surface : fill,
      stroke: options.hollow ? fill : options.stroke || AA.theme.surface,
      'stroke-width': options.hollow ? 2 : 1.5,
    };
    if (!SYMBOLS[shape]) return s('circle', { cx: x, cy: y, r, ...attrs });
    return s('path', { d: SYMBOLS[shape], transform: `translate(${x} ${y}) scale(${r})`, 'vector-effect': 'non-scaling-stroke', ...attrs });
  };

  // ---------- 比例尺 ----------
  function niceTicks(lo, hi, count) {
    const raw = (hi - lo) / Math.max(1, count);
    const base = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((n) => n * base).find((n) => n >= raw) || raw;
    const out = [];
    for (let i = Math.ceil(lo / step); i * step <= hi + step * 1e-9 && out.length < 40; i++) out.push(Number((i * step).toPrecision(12)));
    return out;
  }
  function dayTicks(lo, hi, count, latest) {
    const day = 864e5;
    const step = [1, 2, 7, 14, 30, 60, 90, 180, 365].find((n) => n * day >= (hi - lo) / Math.max(1, count)) || 730;
    const last = Math.floor(latest / day); // 最右一条刻度落在最新发布日，不会标出未来日期
    const out = [];
    for (let d = last; d * day >= lo; d -= step) out.unshift(d * day);
    return out;
  }
  /**
   * 只有线性刻度：相同距离永远代表相同差值。
   * 比率量一律从 0 起，10 倍数值就是 10 倍距离；日期和 Elo 是等距量表，不强制含 0。
   * a→b 是像素区间，Y 轴时 a 在下、b 在上。limit 是局部图的上限，下限与全程相同。
   */
  AA.scale = ({ values, a, b, metric, reverse = false, categories = null, zero = !metric?.interval, limit = null }) => {
    if (categories) {
      const step = (b - a) / categories.length;
      const pos = (i) => a + step * (i + 0.5);
      return { categories, pos, ticks: categories.map((label, i) => ({ v: i, p: pos(i), label })) };
    }
    const finite = values.filter(Number.isFinite);
    const min = finite.length ? Math.min(...finite) : 0;
    const max = finite.length ? Math.max(...finite) : 1;
    let from;
    let to;
    if (zero) {
      from = min < 0 ? min * 1.05 : 0;
      to = max > 0 ? max * 1.05 : from < 0 ? 0 : 1;
    } else {
      const pad = (max - min || Math.abs(min) * 0.1 || 1) * 0.055;
      from = min - pad;
      to = max + pad;
    }
    if (limit !== null) to = limit;
    const [start, end] = reverse ? [b, a] : [a, b];
    const k = (end - start) / (to - from || 1);
    const pos = (v) => (Number.isFinite(v) ? start + (v - from) * k : null);
    const span = Math.abs(b - a);
    const dated = metric.id === 'released' && metric.interval;
    const gap = b < a ? 48 : dated ? 110 : span < 420 ? 56 : 80;
    const ticks = (dated ? dayTicks : niceTicks)(from, to, span / gap, max).map((v) => ({ v, p: pos(v), label: metric.tick(v) }));
    return { pos, from, to, k, start, end, zero, ticks };
  };

  /** 数据严重右偏时给出局部图的上限，从宽到窄，例如 [5, 1]。 */
  AA.focusLimits = (values, metric, maxLevels = 2) => {
    const { focus } = AA.state;
    if (focus === 'off' || metric.interval) return [];
    const all = values.filter(Number.isFinite);
    const top = Math.max(...all);
    if (all.length < 6 || !(top > 0) || Math.min(...all) < -top * 0.1) return [];
    const ceil = (v) => {
      const base = 10 ** Math.floor(Math.log10(v));
      return Number(([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => n * base >= v * 0.999999) * base).toPrecision(6));
    };
    const out = [];
    let current = top;
    for (const [quantile, shrink] of [[0.85, 2.2], [0.62, 2.5]].slice(0, focus === 'one' ? Math.min(1, maxLevels) : maxLevels)) {
      const inside = all.filter((v) => v <= current).sort((p, q) => p - q);
      if (inside.length < 6) break;
      const q = inside[Math.floor((inside.length - 1) * quantile)];
      if (!(q > 0)) break;
      const limit = ceil(q);
      if (limit > current / shrink) break;
      out.push(limit);
      current = limit;
    }
    return out;
  };

  // ---------- 标签避让 ----------
  AA.layoutLabels = (items, points, box, segments = []) => {
    const placed = [];
    const overlap = (p, q) => p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
    const out = [];
    for (const item of items) {
      const w = AA.textWidth(item.text, item.size, item.weight) + 6;
      const h = item.size + 4;
      let best = null;
      // 首选点放不下时，沿同一条线换一个点来挂标签
      (item.anchors || [item]).forEach((anchor, order) => {
        const { x, y } = anchor;
        const gapTo = (rect, q) => Math.hypot(Math.max(rect.x - q.x, 0, q.x - rect.x - w), Math.max(rect.y - q.y, 0, q.y - rect.y - h));
        for (const d of item.near ? [6, 11] : box.r - box.l < 420 ? [8, 15, 22] : [8, 15, 25, 36]) {
          if (best && best.score <= d + order * 5) break;
          const candidates = [
            [x + d, y - h / 2], [x - w / 2, y - d - h], [x - d - w, y - h / 2], [x + d * 0.7, y - d * 0.7 - h],
            [x - d * 0.7 - w, y - d * 0.7 - h], [x - w / 2, y + d], [x + d * 0.7, y + d * 0.7], [x - d * 0.7 - w, y + d * 0.7],
          ];
          for (let i = 0; i < candidates.length; i++) {
            const rect = { x: candidates[i][0], y: candidates[i][1], w, h };
            if (rect.x < box.l || rect.y < box.t || rect.x + w > box.r || rect.y + h > box.b) continue;
            if (placed.some((p) => overlap(rect, p))) continue;
            // 横向相近的两个点，标签的上下顺序不能和点相反
            if (!item.near && placed.some((p) => !p.near && Math.abs(p.ax - x) < 45 && Math.abs(p.ay - y) > 1
              && rect.x < p.x + p.w + 30 && p.x < rect.x + w + 30 && (p.ay - y) * (p.y - rect.y) < 0)) continue;
            if (points.some((p) => p.x + 4 > rect.x && p.x - 4 < rect.x + w && p.y + 4 > rect.y && p.y - 4 < rect.y + h)) continue;
            let crossings = 0;
            for (const [p, q] of segments) {
              for (let t = 0.08; t < 1; t += 0.08) {
                const sx = p.x + (q.x - p.x) * t;
                const sy = p.y + (q.y - p.y) * t;
                if (sx > rect.x && sx < rect.x + w && sy > rect.y && sy < rect.y + h) {
                  crossings++;
                  break;
                }
              }
            }
            // 离别家的点或线比离自己更近时，读者会认错归属
            const own = gapTo(rect, anchor);
            const foreign = Math.min(Infinity, ...points.filter((q) => q.row.group !== item.group).map((q) => gapTo(rect, q)));
            const closerToOther = !item.near && foreign < own - 1;
            // 多档位模型不能因此丢掉名字：实在没有空位时，拉开距离并用引线指明
            if (closerToOther && (item.weight < 600 || d < 15)) continue;
            const ambiguous = foreign < own + 3
              || (!item.near && segments.some(([p, q]) => {
                if (p.row.group === item.group) return false;
                // 取线段上离标签中心最近的一点
                const dx = q.x - p.x;
                const dy = q.y - p.y;
                const t = Math.max(0, Math.min(1, ((rect.x + w / 2 - p.x) * dx + (rect.y + h / 2 - p.y) * dy) / (dx * dx + dy * dy || 1)));
                return gapTo(rect, { x: p.x + t * dx, y: p.y + t * dy }) < own - 1;
              }));
            if (ambiguous && !item.near && d < 15) continue; // 太近时引线看不见，宁可换位置
            const score = crossings * 18 + (ambiguous ? 48 : 0) + (closerToOther ? 400 : 0) + d + i + order * 5;
            if (!best || score < best.score) best = { rect, score, d, ambiguous, x, y };
          }
        }
      });
      if (!best) continue;
      placed.push({ ...best.rect, ax: best.x, ay: best.y, near: item.near });
      out.push({ ...item, x: best.x, y: best.y, rect: best.rect, leader: best.d >= 25 || (!item.near && best.ambiguous) });
    }
    return out;
  };

  // ---------- 坐标图 ----------
  let clipId = 0;
  /**
   * 所有散点 / 折线类视图共用。
   * 返回 { hits, sx, sy, box, series }，供统一的悬停与键盘导航使用。
   */
  AA.cartesian = (parent, o) => {
    const T = AA.theme;
    const S = AA.state;
    const { box } = o;
    const { l, r, t, b } = box;
    const getX = o.getX || ((row) => AA.value(o.mx, row));
    const getY = o.getY || ((row) => AA.value(o.my, row));
    const pairs = (rows) => rows
      .map((row) => ({ row, vx: getX(row), vy: getY(row) }))
      .filter((p) => p.vx !== null && p.vy !== null && Number.isFinite(p.vx) && Number.isFinite(p.vy));
    const data = pairs(o.rows);
    const ghosts = o.context ? pairs(o.context) : [];
    const domain = o.domain ? pairs(o.domain) : data;

    const sx = AA.scale({ values: domain.map((p) => p.vx), a: l, b: r, metric: o.mx, reverse: o.xrev, limit: o.xLimit, categories: o.categories });
    const sy = AA.scale({ values: domain.map((p) => p.vy), a: b, b: t, metric: o.my, reverse: o.yrev, limit: o.yLimit });
    const cropped = (p) => (o.xLimit !== null && o.xLimit !== undefined && p.vx > o.xLimit) || (o.yLimit !== null && o.yLimit !== undefined && p.vy > o.yLimit);
    const small = !!o.mini;

    const grid = s('g', { class: 'grid' });
    const tickText = { fill: T.muted, size: small ? 10 : 11 };
    let lastX = -Infinity;
    for (const tick of [...sx.ticks].sort((p, q) => p.p - q.p)) {
      grid.append(s('line', { x1: tick.p, x2: tick.p, y1: t, y2: b, stroke: T.grid }));
      const w = AA.textWidth(tick.label, tickText.size);
      if (tick.p - w / 2 > lastX + 5) {
        grid.append(AA.text(tick.p, b + 13, tick.label, { ...tickText, anchor: 'middle' }));
        lastX = tick.p + w / 2;
      }
    }
    for (const tick of sy.ticks) {
      grid.append(s('line', { x1: l, x2: r, y1: tick.p, y2: tick.p, stroke: T.grid }));
      grid.append(AA.text(l - 7, tick.p, tick.label, { ...tickText, anchor: 'end' }));
    }
    grid.append(s('path', { d: `M${l} ${t}V${b}H${r}`, fill: 'none', stroke: T.axis }));
    if (o.xTitle) grid.append(AA.text((l + r) / 2, b + 33, o.xTitle, { anchor: 'middle', size: 12 }));
    if (o.yTitle) grid.append(AA.text(l - 46, (t + b) / 2, o.yTitle, { anchor: 'middle', size: 12, rotate: -90 }));
    parent.append(grid);

    const id = `plot-clip-${++clipId}`;
    const cutX = o.xLimit !== null && o.xLimit !== undefined;
    const cutY = o.yLimit !== null && o.yLimit !== undefined;
    const clip = {
      l: l - (cutX && o.xrev ? 0 : 7), r: r + (cutX && !o.xrev ? 0 : 7),
      t: t - (cutY && !o.yrev ? 0 : 7), b: b + (cutY && o.yrev ? 0 : 7),
    };
    parent.append(s('defs', {}, s('clipPath', { id }, s('rect', { x: clip.l, y: clip.t, width: clip.r - clip.l, height: clip.b - clip.t }))));
    const plot = s('g', { 'clip-path': `url(#${id})`, 'data-plot': '' });
    parent.append(plot);
    o.underlay?.(plot, sx, sy);

    const project = (p) => ({ ...p, x: sx.pos(p.vx), y: sy.pos(p.vy) });
    const drawable = (p) => p.x !== null && p.y !== null;
    const ordered = (points) => [...points].sort((p, q) =>
      o.connect === 'x' ? p.vx - q.vx : (p.row.rank ?? 99) - (q.row.rank ?? 99) || p.vx - q.vx);

    if (ghosts.length) {
      const back = s('g', { class: 'context', opacity: 0.3 });
      for (const group of AA.groupBy(ghosts, (p) => p.row.group).values()) {
        const pts = ordered(group.map(project).filter(drawable));
        if (pts.length > 1) back.append(s('polyline', { points: pts.map((p) => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: T.other }));
        else if (pts.length && !cropped(pts[0])) back.append(s('circle', { cx: pts[0].x, cy: pts[0].y, r: 1.5, fill: T.other }));
      }
      plot.append(back);
    }

    let frontier = [];
    if (o.frontier && data.length) {
      frontier = AA.frontier(o.rows, o.mx, o.my).map((p) => ({ ...p, px: sx.pos(p.x), py: sy.pos(p.y) }))
        .filter((p) => p.px !== null && p.py !== null);
      if (frontier.length) {
        let d = `M${frontier[0].px} ${frontier[0].py}`;
        for (const p of frontier.slice(1)) d += `H${p.px}V${p.py}`;
        const worstX = o.mx.good < 0 === !o.xrev ? r : l;
        plot.append(s('path', {
          d: `${d}H${worstX === r ? Math.max(r, frontier[frontier.length - 1].px) : Math.min(l, frontier[frontier.length - 1].px)}`, fill: 'none', stroke: T.ink2, 'stroke-width': 7, opacity: 0.13,
          'stroke-linejoin': 'round', class: 'frontier',
        }));
      }
    }

    const pins = AA.pinned();
    const mode = o.colorMode || AA.colorMode();
    const hits = [];
    const series = [];
    const segments = [];
    const groups = [...AA.groupBy(data, (p) => p.row.group)].sort((p, q) => pins.includes(p[0]) - pins.includes(q[0]));
    const sizeValues = o.size ? o.rows.map((row) => AA.value(o.size, row)).filter((v) => v > 0) : [];
    const sizeMax = Math.max(...sizeValues);
    for (const [group, list] of groups) {
      const pts = ordered(list.map(project).filter(drawable));
      if (!pts.length) continue;
      const dim = !small && pins.length > 0 && !pins.includes(group);
      const strong = pins.includes(group);
      const color = mode === 'effort' ? T.other : AA.color(pts[0].row, mode);
      const g = s('g', { class: 'series', 'data-group': group, opacity: dim ? 0.25 : null });
      if (o.connect !== 'none') {
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1];
          const q = pts[i];
          const nonReasoning = p.row.effort === 'non-reasoning' || q.row.effort === 'non-reasoning';
          if (nonReasoning && S.nr === 'detach') continue;
          g.append(s('line', {
            x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: color, 'stroke-width': strong ? 3 : 2,
            'stroke-linecap': 'round', 'stroke-dasharray': nonReasoning ? '3 4' : null,
            opacity: nonReasoning ? 0.6 : null,
          }));
          segments.push([p, q]);
          if (o.arrows && Math.hypot(q.x - p.x, q.y - p.y) > 24) {
            const angle = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;
            g.append(s('path', { d: 'M4 0-3-4V4Z', fill: color, transform: `translate(${(p.x + q.x) / 2} ${(p.y + q.y) / 2}) rotate(${angle})` }));
          }
        }
      }
      for (const p of pts) {
        if (cropped(p)) continue;
        let radius = small ? 3.5 : pts.length > 1 ? 4.7 : 4.1;
        if (o.size) {
          const v = AA.value(o.size, p.row);
          radius = v > 0 ? Math.max(1.5, 15 * Math.sqrt(v / sizeMax)) : 1.5; // 面积与数值成正比
        }
        if (o.defaults && p.row.isDefault) g.append(s('circle', { cx: p.x, cy: p.y, r: radius + 4, fill: 'none', stroke: color, 'stroke-width': 1.3 }));
        g.append(AA.mark(small ? 0 : AA.shape(group), p.x, p.y, radius, AA.color(p.row, mode), { hollow: p.row.effort === 'non-reasoning' }));
        if (p.x >= l - 1 && p.x <= r + 1 && p.y >= t - 1 && p.y <= b + 1) hits.push({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, sx, sy, box, row: p.row, group });
      }
      plot.append(g);
      series.push({ group, pts, dim, strong });
    }

    if (o.labels && o.labels !== 'none') {
      const inside = (p) => !cropped(p) && p.x >= l - 1 && p.x <= r + 1 && p.y >= t - 1 && p.y <= b + 1;
      const edgeGroups = new Set(frontier.map((p) => p.r.group));
      const candidates = [];
      for (const item of series) {
        if (o.labels === 'pins' && !item.strong) continue;
        if (o.labels === 'auto' && !item.strong && o.labelOnly && !o.labelOnly.has(item.group)) continue;
        if (o.labels === 'auto' && pins.length && !item.strong) continue;
        // 全程图只给阴影区外的点挂名字，阴影区内交给局部图
        const visible = item.pts.filter((p) => inside(p)
          && (o.labels !== 'auto' || item.strong || !o.tierOutside || o.tierOutside(p)));
        if (!visible.length) continue;
        const anchor = o.labelAtEnd ? visible[visible.length - 1] : visible.reduce((p, q) => (q.y < p.y ? q : p));
        const multi = item.pts.length > 1;
        candidates.push({
          x: anchor.x, y: anchor.y, text: anchor.row.model,
          anchors: [anchor, ...visible.filter((p) => p !== anchor).sort((p, q) => p.y - q.y)], group: item.group,
          size: small ? 10 : multi ? 12 : 10.5, weight: multi ? 600 : 400, color: multi ? T.ink : T.ink2,
          priority: (item.strong ? 1000 : 0) + (edgeGroups.has(item.group) ? 120 : 0) + (multi ? 200 : 0) + (b - anchor.y) / 10,
        });
      }
      candidates.sort((p, q) => q.priority - p.priority);
      // “自动”时只给较重要的单档点上标签，避免底部糊成一片
      const limit = o.labels === 'auto' ? Math.max(8, Math.round(((r - l) * (b - t)) / 15000)) : Infinity;
      const items = candidates.slice(0, limit);
      const showTiers = o.tiers === 'all' || (o.tiers === 'auto' && (series.length <= 8 || pins.length > 0));
      if (showTiers) {
        for (const item of series) {
          if (o.tiers === 'auto' && pins.length && !item.strong) continue;
          for (const p of item.pts) {
            if (p.row.effort && inside(p) && (!o.tierOutside || o.tierOutside(p))) items.push({ x: p.x, y: p.y, group: item.group, text: AA.effortName(p.row), size: 9.5, weight: 400, color: T.ink2, near: true });
          }
        }
      }
      const points = series.flatMap((item) => item.pts.filter(inside));
      for (const label of AA.layoutLabels(items, points, box, segments)) {
        const { rect } = label;
        const g = s('g', {
          class: 'series plot-label', 'data-group': label.group, 'pointer-events': 'none',
          'data-anchor': label.near ? null : `${label.x},${label.y}`,
        });
        if (label.leader) {
          g.append(s('line', {
            x1: label.x, y1: label.y, stroke: T.axis,
            x2: Math.max(rect.x, Math.min(rect.x + rect.w, label.x)),
            y2: Math.max(rect.y, Math.min(rect.y + rect.h, label.y)),
          }));
        }
        g.append(s('text', {
          x: rect.x + 3, y: rect.y + rect.h / 2, fill: label.color, 'font-size': label.size, 'font-weight': label.weight,
          'dominant-baseline': 'central', stroke: T.surface, 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke',
        }, label.text));
        parent.append(g);
      }
    }
    if (data.length && !hits.length && data.every(cropped)) {
      parent.append(AA.text((l + r) / 2, (t + b) / 2, '均超出此范围，见全程', { anchor: 'middle', fill: T.ink2 }));
    }
    return { sx, sy, box, hits, series, count: data.length, frontier };
  };

  // ---------- 全程 + 局部 ----------
  /**
   * 拥挤时不压缩刻度，而是把密集区另画一张同样从 0 起的线性图。
   * 所有分图画在同一个 SVG 里，悬停联动。
   */
  AA.linkedHeight = (o, width, height) => {
    const { limits, sideways } = AA.linkedPlan(o, width);
    if (!limits.length) return height;
    if (sideways) return Math.max(height, 300);
    if (width < 700) return Math.max(height, (limits.length + 1) * 310);
    return Math.max(height, o.minHeight || 430);
  };
  AA.linkedPlan = (o, width) => {
    const getX = o.getX || ((row) => AA.value(o.mx, row));
    const getY = o.getY || ((row) => AA.value(o.my, row));
    const points = (o.domain || o.rows).map((row) => [getX(row), getY(row)])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    const levels = o.levels ?? 2;
    const xs = o.categories ? [] : AA.focusLimits(points.map((p) => p[0]), o.mx, levels);
    const ys = AA.focusLimits(points.map((p) => p[1]), o.my, levels);
    const at = (list, i) => (list.length ? list[Math.min(i, list.length - 1)] : null);
    const limits = Array.from({ length: Math.max(xs.length, ys.length) }, (_, i) => ({ x: at(xs, i), y: at(ys, i) }));
    return { limits, points, getX, getY, sideways: limits.length > 0 && (o.sideways || (!xs.length && width >= 700)) };
  };
  AA.linked = (parent, o) => {
    const { L, T: top, W, H } = o.area;
    const { limits, points, getX, getY, sideways } = AA.linkedPlan(o, W);
    const views = [{ x: null, y: null }, ...limits];
    const n = views.length;
    let areas;
    if (n === 1) areas = [{ L, T: top, W, H }];
    else if (sideways) areas = views.map((_, i) => ({ L: L + (i * W) / n, T: top, W: W / n, H }));
    else if (W < 700) areas = views.map((_, i) => ({ L, T: top + (i * H) / n, W, H: H / n }));
    else {
      // 上：全程，保留真实全貌；下：密集区
      const first = H * 0.36;
      const rest = { T: top + first, H: H - first };
      areas = n === 2 ? [{ L, T: top, W, H: first }, { L, W, ...rest }]
        : [{ L, T: top, W, H: first }, { L, W: W * 0.54, ...rest }, { L: L + W * 0.54, W: W * 0.46, ...rest }];
    }

    const within = (limit, x, y) => (limit.x === null || x <= limit.x) && (limit.y === null || y <= limit.y);
    const panels = [];
    const hits = [];
    views.forEach((limit, i) => {
      const area = areas[i];
      const next = views[i + 1];
      const head = n > 1 || o.title ? 26 : 20;
      // 上方全程图不重复写横轴标题，把高度让给密集区
      const xTitle = n > 1 && i === 0 && !sideways && W >= 700 ? null : o.xTitle;
      const box = {
        l: area.L + (o.mini ? (o.yTitle && !(sideways && i > 0) ? 60 : 40) : 64), r: area.L + area.W - 18,
        t: area.T + head, b: area.T + area.H - (xTitle ? 47 : 26),
      };
      const outside = (x, y) => !next || !within(next, x, y);
      const labelOnly = next
        ? new Set(o.rows.filter((row) => outside(getX(row), getY(row))).map((row) => row.group))
        : null;
      const out = AA.cartesian(parent, {
        ...o, box, xTitle, xLimit: limit.x, yLimit: limit.y, labelOnly,
        tierOutside: (p) => outside(p.vx, p.vy),
        yTitle: sideways && i > 0 ? null : o.yTitle,
        underlay(g, sx, sy) {
          if (next) {
            // 阴影标出下一张局部图在本图中的真实大小
            const x = next.x === null ? box.r : sx.pos(next.x);
            const y = next.y === null ? box.t : sy.pos(next.y);
            const x0 = next.x === null ? box.l : sx.start;
            const y0 = next.y === null ? box.b : sy.start;
            g.append(s('rect', {
              x: Math.min(x0, x), y: Math.min(y0, y), width: Math.abs(x - x0), height: Math.abs(y - y0),
              fill: AA.theme.band, stroke: AA.theme.axis, class: 'focus-band',
            }));
          }
          o.underlay?.(g, sx, sy, box);
        },
      });
      if (n > 1) {
        const parts = [];
        const zoom = [];
        if (limit.x !== null) {
          parts.push(`${o.mx.tick(0)}–${o.mx.tick(limit.x)}`);
          zoom.push(`横向放大 ${Number(Math.abs(out.sx.k / panels[0].sx.k).toPrecision(2))}×`);
        }
        if (limit.y !== null) {
          parts.push(`${limit.x === null ? '' : '纵向 '}${o.my.tick(0)}–${o.my.tick(limit.y)}`);
          zoom.push(`纵向放大 ${Number(Math.abs(out.sy.k / panels[0].sy.k).toPrecision(2))}×`);
        }
        const name = i ? `局部 ${parts.join('，')}` : o.mini ? '全程' : '全程 · 真实全貌';
        const count = points.filter(([x, y]) => within(limit, x, y)).length;
        const note = o.mini ? '' : i ? `${count}/${points.length} 点 · ${zoom.join('，')}` : '阴影区在下一张局部图中展开';
        parent.append(AA.text(box.l, area.T + 12, name, { size: o.mini ? 10.5 : 12, weight: 600, fill: AA.theme.ink }));
        if (AA.textWidth(name, 12, 600) + AA.textWidth(note, 10.5) + 14 < box.r - box.l) {
          parent.append(AA.text(box.r, area.T + 12, note, { anchor: 'end', size: 10.5, fill: AA.theme.muted }));
        }
      }
      hits.push(...out.hits);
      panels.push({ ...out, limit });
    });
    return { hits, panels, count: panels[0].count };
  };
})();
