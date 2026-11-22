/* 页面内更新数据：状态、进度、取消与变更展示。抓取由本机服务 scripts/serve.py 执行。 */
(() => {
  'use strict';
  const AA = window.AA;
  const { h } = AA;
  const button = document.getElementById('update');
  const panel = document.getElementById('update-panel');
  const announcer = document.getElementById('update-live');
  // 首次取数只走命令行脚本；页面里的更新只用于刷新已有数据
  if (!AA.rows.length) {
    button.hidden = true;
    return;
  }

  const PORTS = Array.from({ length: 10 }, (_, i) => 8765 + i); // 与 serve.py 一致
  const RESUME = 'aa.afterUpdate';
  const WATCH = 'aa.updateJob';
  const CHANGES_SHOWN = 100;
  const STAGES = [['index', '读取榜单'], ['details', '读取各模型详情'], ['validate', '校验新数据'], ['save', '写入本地']];
  const FIELDS = {
    iq: '智能', cost: '价格', minutes: '耗时',
    priceIn: '输入单价', priceOut: '输出单价', priceHit: '缓存命中', priceWrite: '缓存写入',
  };
  const local = location.protocol === 'file:';

  let status = null;
  let connection = local ? 'file' : 'checking';
  let watched = null; // 由本标签页发起的任务，只有它完成时才自动载入；其他标签页只提示
  let notice = '';
  let skew = 0; // 服务端与页面的时钟差
  let requesting = false;
  let sequence = 0; // 只采纳最近一次请求的响应
  let timer;
  let painted = '';

  const job = () => status?.job || { state: 'idle' };
  const busy = () => job().state === 'running' || job().state === 'cancelling';
  const stale = () => !!status?.data?.fetchedAt && status.data.fetchedAt !== AA.meta.fetchedAt;

  function ago(iso) {
    const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(minutes)) return '时间未知';
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} 小时前`;
    return `${Math.floor(minutes / 1440)} 天前`;
  }
  const clock = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

  // ---------- 刷新数据时保留现场 ----------
  function applyData(showResult) {
    // 正在输入的值要先提交进 state，否则刷新后就没了
    const editing = document.activeElement;
    if (editing?.matches('input, textarea')) editing.blur();
    AA.flushUrl();
    const saved = {
      showResult,
      history: AA.history(),
      scroll: [document.getElementById('stage'), document.getElementById('panel-list')].map((n) => [n.scrollLeft, n.scrollTop]),
      classes: ['focus-mode', 'panel-closed', 'panel-open'].filter((name) => document.body.classList.contains(name)),
      drawer: document.getElementById('drawer').hidden ? null : document.getElementById('drawer').dataset.group,
      search: document.getElementById('panel-search').value,
      sort: document.getElementById('panel-sort').value,
    };
    try { sessionStorage.setItem(RESUME, JSON.stringify(saved)); } catch { /* 存不下时只是不恢复现场，数据照常更新 */ }
    location.reload();
  }
  function resume() {
    let saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(RESUME));
      sessionStorage.removeItem(RESUME);
    } catch {
      return;
    }
    if (!saved) return;
    AA.restoreHistory(saved.history);
    for (const name of saved.classes || []) document.body.classList.add(name);
    document.getElementById('focus').setAttribute('aria-pressed', String(document.body.classList.contains('focus-mode')));
    const search = document.getElementById('panel-search');
    const sort = document.getElementById('panel-sort');
    search.value = saved.search || '';
    sort.value = saved.sort || 'iq';
    sort.dispatchEvent(new Event('change'));
    if (AA.groups.has(saved.drawer)) AA.ui.details(saved.drawer, true);
    document.getElementById('undo').disabled = !AA.canUndo();
    document.getElementById('redo').disabled = !AA.canRedo();
    // 等 ResizeObserver 重绘完再恢复滚动位置
    setTimeout(() => {
      ['stage', 'panel-list'].forEach((id, i) => document.getElementById(id).scrollTo(...(saved.scroll?.[i] || [0, 0])));
    }, 120);
    if (saved.showResult) {
      notice = 'updated';
      panel.hidden = false;
      announcer.textContent = '数据更新完成';
    }
  }

  // ---------- 与服务通信 ----------
  async function request(path, method = 'GET') {
    const res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: method === 'POST' ? { 'X-Score-Trends': '1' } : {},
      signal: AbortSignal.timeout(5000),
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('static');
    const body = await res.json();
    if (!body.job) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }
  function watch(id) {
    watched = id;
    try {
      if (id) sessionStorage.setItem(WATCH, id);
      else sessionStorage.removeItem(WATCH);
    } catch { /* 只影响手动刷新页面后能否继续自动载入 */ }
  }
  function accept(next) {
    status = next;
    connection = 'online';
    skew = next.now - Date.now() / 1000;
    if (busy()) {
      return;
    }
    if (!watched) return;
    const mine = watched === next.job.id;
    watch(null);
    if (!mine) return;
    if (next.job.state === 'done') {
      applyData(true);
    } else {
      notice = next.job.state;
      panel.hidden = false;
      announcer.textContent = next.job.state === 'cancelled' ? '已取消更新' : '更新失败';
    }
  }
  function schedule() {
    clearTimeout(timer);
    let delay = 15000;
    if (busy() && connection === 'online') delay = 700;
    else if (connection !== 'online' && !panel.hidden) delay = 2000;
    timer = setTimeout(poll, delay);
  }
  async function poll() {
    clearTimeout(timer);
    if (local) {
      if (!panel.hidden) probe();
    } else if (!requesting) {
      const mine = ++sequence;
      try {
        const next = await request('/api/status');
        if (mine !== sequence) return;
        accept(next);
      } catch (err) {
        if (mine !== sequence) return;
        // 接口不存在说明是普通静态服务器；否则是服务没在运行
        connection = err.message === 'static' ? 'static' : 'offline';
      }
    }
    paint();
    schedule();
  }
  async function command(path) {
    if (requesting) return;
    requesting = true;
    sequence++;
    notice = '';
    paint();
    try {
      const next = await request(path, 'POST');
      requesting = false;
      // 很快失败或完成的任务也要有结果，所以先登记再处理
      watch(next.job.id);
      if (path === '/api/update') announcer.textContent = '开始更新数据';
      accept(next);
    } catch {
      requesting = false;
      connection = 'offline';
    }
    paint();
    schedule();
  }

  // file:// 页面读不了接口，只用一张图片探测服务是否已启动
  let found = null;
  let projectId;
  const projectFolder = () => decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
  async function probe() {
    if (found) return;
    if (!projectId) {
      // 带上项目标识，有多份副本时不会连到别的那一份
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(projectFolder().normalize('NFC')));
      projectId = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
    for (const port of PORTS) {
      const img = new Image();
      img.onload = () => {
        if (found || img.naturalWidth !== 7) return;
        found = port;
        paint();
        if (!panel.hidden) openServed(port);
      };
      img.src = `http://127.0.0.1:${port}/ping-${projectId}.svg?${Date.now()}`;
    }
  }
  function openServed(port) {
    AA.flushUrl();
    location.href = `http://localhost:${port}/?update=1${location.hash}`;
  }

  // ---------- 面板 ----------
  function scriptCommand() {
    if (!local) return 'python3 -I scripts/serve.py';
    return `python3 -I '${`${projectFolder()}/scripts/serve.py`.replace(/'/g, "'\\''")}'`;
  }
  function setupView() {
    const text = scriptCommand();
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(text);
        AA.ui.toast('已复制命令');
      } catch {
        AA.ui.toast('无法自动复制，请手动选中命令');
      }
    };
    return [
      h('p', { class: 'update-lead' }, {
        file: '更新需要先启动本机服务',
        static: '当前服务器不支持更新',
        offline: '本机服务没有运行',
      }[connection]),
      h('p', { class: 'muted' }, '浏览器不能直接抓取原站，需要由这台电脑上的小服务代为抓取。它只监听本机，不需要安装任何东西。'),
      h('ol', { class: 'setup' },
        h('li', {}, '在项目文件夹里双击 ', h('b', {}, '启动看板.command')),
        h('li', {}, local ? '本页检测到服务后会自动切换，并保留当前视图' : '保持那个窗口打开，本页会自动恢复连接')),
      local && h('button', { class: 'btn primary', id: 'update-open', onclick: () => openServed(found || PORTS[0]) }, '已启动，打开可更新的看板'),
      h('details', {},
        h('summary', {}, '也可以用命令启动'),
        h('code', { class: 'command' }, text),
        h('button', { class: 'btn', onclick: copy }, '复制命令')),
    ];
  }
  // 运行态只建一次，之后只改内容：按钮一旦被替换，按着它的那次点击就会丢失
  function runningView() {
    return [
      h('div', { class: 'progress', id: 'update-progress', role: 'progressbar', 'aria-label': '更新进度', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div')),
      h('ol', { class: 'stages' }, STAGES.map(([id, name]) => h('li', {},
        h('i', { 'aria-hidden': 'true' }),
        h('span', {}, name),
        id === 'details' && h('small', { id: 'update-count' })))),
      h('p', { class: 'update-current', id: 'update-model' }),
      h('div', { class: 'update-actions' },
        h('button', { class: 'btn', id: 'update-cancel', onclick: () => command('/api/cancel') }, '取消更新'),
        h('span', { class: 'muted', id: 'update-elapsed' })),
      h('p', { class: 'muted update-note' }, '更新期间可以继续看图和筛选。完成后自动载入，并保留当前视图。'),
    ];
  }
  function syncProgress() {
    const current = job();
    const at = Math.max(0, STAGES.findIndex(([id]) => id === current.stage));
    const percent = [2, 5 + (current.total ? current.done / current.total : 0) * 88, 95, 98][at];
    const bar = panel.querySelector('#update-progress');
    bar.setAttribute('aria-valuenow', Math.round(percent));
    bar.firstChild.style.width = `${percent}%`;
    panel.querySelectorAll('.stages li').forEach((item, i) => {
      item.className = i < at ? 'done' : i === at ? 'current' : '';
      item.firstChild.textContent = i < at ? '✓' : i === at ? '●' : '○';
    });
    panel.querySelector('#update-count').textContent = at >= 1 && current.total ? `${current.done} / ${current.total}` : '';
    panel.querySelector('#update-model').textContent = current.stage === 'details' ? current.label : '';
    const cancel = panel.querySelector('#update-cancel');
    cancel.disabled = requesting || current.state === 'cancelling' || current.stage === 'save';
    const text = current.state === 'cancelling' ? '正在取消…' : '取消更新';
    if (cancel.textContent !== text) cancel.textContent = text;
  }
  function value(field, v) {
    if (v === null || v === undefined) return '—';
    const metric = AA.metrics.get(field);
    return metric ? AA.show(metric, v) : String(v);
  }
  function modelButton(item) {
    if (!AA.groups.has(item.group)) return h('span', { class: 'change-gone', title: '已不在榜单中' }, item.name);
    return h('button', {
      class: 'link change-name', title: '查看模型详情',
      onclick: () => {
        panel.hidden = true;
        paint();
        AA.ui.details(item.group);
      },
    }, item.name);
  }
  function resultView() {
    const last = status?.last;
    if (!last || last.fetchedAt !== AA.meta.fetchedAt) return [];
    if (!last.previousAt) return [h('p', { class: 'muted update-note', id: 'update-result' }, '这是首次获取，下次更新时会列出变化。')];
    const { added, removed, changed } = last;
    const versionChanged = last.version[0] && last.version[1] && last.version[0] !== last.version[1];
    const none = !added.length && !removed.length && !changed.length && !versionChanged;
    const section = (title, items, body) => items.length > 0 && h('details', { open: items.length <= 12 },
      h('summary', {}, `${title} ${items.length}`),
      h('ul', { class: 'changes' }, items.slice(0, CHANGES_SHOWN).map((item) => h('li', {}, modelButton(item), body(item)))),
      items.length > CHANGES_SHOWN && h('p', { class: 'muted' }, `另有 ${items.length - CHANGES_SHOWN} 项未列出`));
    return [
      h('div', { class: 'update-result', id: 'update-result' },
        h('p', { class: 'update-lead' }, none ? '已是最新，榜单核心数据没有变化' : '最近一次更新的变化'),
        last.previousAt && h('p', { class: 'muted' }, `对比 ${clock(last.previousAt)} 的数据`),
        h('div', { class: 'change-totals' }, [['新增', added.length], ['移除', removed.length], ['数值变化', changed.length]]
          .map(([name, count]) => h('div', {}, h('b', {}, count), h('span', {}, name)))),
        versionChanged && h('p', { class: 'update-message warn' }, `智能指数从 v${last.version[0]} 换到 v${last.version[1]}，前后分数不可直接比较。`),
        section('新增', added, (r) => h('span', { class: 'change-value' }, `智能 ${value('iq', r.iq)} · ${value('cost', r.cost)}`)),
        section('移除', removed, (r) => h('span', { class: 'change-value' }, `智能 ${value('iq', r.iq)} · ${value('cost', r.cost)}`)),
        section('数值变化', changed, (r) => Object.entries(r.fields).map(([field, [from, to]]) => {
          // 精度不足以显示差异时，补足小数位
          let a = value(field, from);
          let b = value(field, to);
          if (a === b) [a, b] = [from, to].map((v) => (typeof v === 'number' ? String(Number(v.toPrecision(5))) : '—'));
          return h('span', { class: 'change-value' }, `${FIELDS[field] || field} ${a} → `, h('b', {}, b));
        })),
        last.performance > 0 && h('p', { class: 'muted update-note' }, `另有 ${last.performance} 个配置的速度或延迟随实测波动。`),
        last.stale > 0 && h('p', { class: 'update-message warn', id: 'update-carried' }, `${last.stale} 个配置这次没取到完整详情，相应字段沿用上一版，模型详情里有标注。`),
        last.incomplete > 0 && h('p', { class: 'update-message warn', id: 'update-incomplete' }, `${last.incomplete} 个配置的详情不完整，也没有可沿用的旧值。`)),
    ];
  }
  function idleView() {
    const current = job();
    const failed = current.state === 'error';
    return [
      notice === 'updated' && !stale() && h('p', { class: 'update-message ok', id: 'update-success' }, '✓ 更新完成，当前显示的是最新数据'),
      failed && h('div', { class: 'update-message error', id: 'update-error' }, h('b', {}, '更新失败，原数据未改动'), h('p', {}, current.error)),
      notice === 'cancelled' && h('p', { class: 'update-message', id: 'update-cancelled' }, '已取消，原数据未改动'),
      stale() && h('div', { class: 'update-message warn' },
        h('p', {}, `本地已有 ${clock(status.data.fetchedAt)} 的新数据`),
        h('button', { class: 'btn', id: 'update-load', onclick: () => applyData(false) }, '载入新数据')),
      h('div', { class: 'update-actions' },
        h('button', { class: 'btn primary', id: 'update-start', disabled: requesting, onclick: () => command('/api/update') },
          failed ? '重试' : '从原站更新'),
        h('span', { class: 'muted' }, '约 1 分钟，期间可继续看图')),
      resultView(),
    ];
  }
  function tickElapsed() {
    const node = document.getElementById('update-elapsed');
    if (node && busy()) node.textContent = `已用 ${Math.max(0, Math.round(Date.now() / 1000 + skew - job().startedAt))} 秒`;
  }

  function paint() {
    const current = job();
    const online = connection === 'online';
    const running = online && busy();
    let label = '更新数据';
    if (running) label = current.stage === 'details' && current.total ? `更新中 ${current.done}/${current.total}` : '更新中…';
    else if (online && current.state === 'error') label = '更新失败';
    else if (online && stale()) label = '有新数据';
    button.querySelector('span').textContent = label;
    button.dataset.state = running ? 'running' : online && current.state === 'error' ? 'error' : online && stale() ? 'stale' : 'idle';
    button.style.setProperty('--progress', `${running && current.total ? (current.done / current.total) * 100 : 0}%`);
    button.setAttribute('aria-expanded', String(!panel.hidden));
    button.title = `数据抓取于 ${ago(AA.meta.fetchedAt)}`;
    if (panel.hidden) {
      painted = '';
      return;
    }
    // 状态没变就不重建，否则轮询会打断点击、展开、滚动和焦点
    const key = running ? `running:${current.id}`
      : JSON.stringify([connection, current, status?.data, status?.last?.fetchedAt, notice, requesting, found]);
    const rebuild = key !== painted;
    painted = key;
    if (rebuild) buildPanel(running, online);
    const age = panel.querySelector('#update-age');
    const ageText = ago(AA.meta.fetchedAt);
    if (age.textContent !== ageText) age.textContent = ageText;
    if (running) syncProgress();
    tickElapsed();
  }
  function buildPanel(running, online) {
    const focused = panel.contains(document.activeElement) ? document.activeElement.id : null;
    const scroll = panel.scrollTop;
    let body;
    if (connection === 'checking') body = h('p', { class: 'muted' }, '正在连接本机服务…');
    else if (!online) body = setupView();
    else body = running ? runningView() : idleView();
    panel.replaceChildren(...[
      h('header', {},
        h('h2', {}, '数据更新'),
        h('button', { class: 'icon', id: 'update-close', 'aria-label': '关闭数据更新', onclick: close }, '×')),
      h('dl', { class: 'update-facts' },
        h('div', {}, h('dt', {}, '当前数据'), h('dd', { id: 'update-age', title: clock(AA.meta.fetchedAt) })),
        h('div', {}, h('dt', {}, '配置'), h('dd', {}, AA.meta.ranked ?? 0)),
        h('div', {}, h('dt', {}, '有价格'), h('dd', {}, AA.meta.plottable ?? 0))),
      body,
    ].flat(Infinity).filter(Boolean));
    if (focused) (document.getElementById(focused) || panel.querySelector('button')).focus({ preventScroll: true });
    panel.scrollTop = scroll;
  }

  function close() {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    paint();
    if (hadFocus) button.focus();
  }
  function open() {
    panel.hidden = false;
    paint();
    (panel.querySelector('#update-start:not(:disabled), #update-open') || panel.querySelector('#update-close')).focus({ preventScroll: true });
    poll();
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden || !panel.contains(document.activeElement)) return;
    e.stopPropagation();
    close();
  }, true);
  // 与其他弹层一致：点外面就收起，进度仍显示在按钮上
  document.addEventListener('pointerdown', (e) => {
    if (panel.hidden || e.composedPath().includes(panel) || e.composedPath().includes(button)) return;
    panel.hidden = true;
    paint();
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  addEventListener('focus', poll);
  setInterval(tickElapsed, 1000);

  resume();
  try { watched = sessionStorage.getItem(WATCH); } catch { /* 同上 */ }
  if (new URLSearchParams(location.search).has('update')) {
    // 只展开面板，不自动开始：链接不能替用户触发更新
    history.replaceState(null, '', location.pathname + location.hash);
    panel.hidden = false;
  }
  paint();
  poll();
})();
