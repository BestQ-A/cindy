/* The view receives host-owned snapshots from the plugin logic over its private origin. */
const channel = new BroadcastChannel('wanjie-overview-v1');
const elements = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id, element]));
const STORAGE_KEY = 'wanjie-overview:view-prefs:v1';
const statuses = { running: '运行中', awaiting: '待处理', error: '异常', done: '已完成', unread: '未读', idle: '空闲', offline: '离线' };
const verificationLabels = { passed: '通过', failed: '失败', blocked: '受阻', pending: '待验证' };
const phases = { thinking: '正在思考', replying: '正在回复', 'reading-file': '正在读文件', 'saving-file': '正在保存', searching: '正在搜索', 'searching-files': '正在查找文件', 'reading-web': '正在阅读网页', testing: '正在测试', checking: '正在检查', compacting: '正在整理上下文', processing: '正在处理' };
let snapshot = { companions: [], folders: [], hierarchy: null, taskFlow: null, verification: null, devices: [], run: null, observedAt: null, error: null };
let receivedState = false;
let selectedFilter = 'all';

const TASKFLOW_WINDOWS_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  all: Infinity,
};

const TASKFLOW_STATUS_LABELS = {
  running: '进行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '异常',
  paused: '已暂停',
  idle: '空闲',
};

const TASKFLOW_EDGE_LABELS = {
  blocks: '前置阻塞',
  delegates: '委派子任务',
  cross_device: '跨电脑调度',
  handoff: '交接续作',
  subagent: '子代理',
};

let taskFlowPrefs = {
  view: 'gantt',
  lane: 'folder',
  window: '6h',
  showSteps: true,
  linkedOnly: false,
  selectedNodeId: null,
  hoveredNodeId: null,
};

let taskFlowControlsBound = false;

function tfSvgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  return el;
}

function tfStatusLabel(status) {
  return TASKFLOW_STATUS_LABELS[status] || status || '未知';
}

function tfEdgeLabel(edge) {
  if (edge?.label) return edge.label;
  return TASKFLOW_EDGE_LABELS[edge?.kind] || edge?.kind || '依赖';
}

function tfFormatDuration(startMs, endMs, status, nowMs) {
  if (!Number.isFinite(startMs) || startMs <= 0) return '待开始';
  const effectiveEnd = Number.isFinite(endMs) && endMs >= startMs
    ? endMs
    : (status === 'running' || status === 'waiting' ? Math.max(startMs, nowMs) : startMs);
  const diffSec = Math.max(0, Math.round((effectiveEnd - startMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `${hrs}h ${remM}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function tfFormatClock(ms, withDate) {
  if (!Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day} ${hh}:${mm}`;
}

function tfComputeLineage(activeId, edges) {
  if (!activeId) return null;
  const upstream = new Set();
  const downstream = new Set();
  const backAdj = new Map();
  const fwdAdj = new Map();
  for (const edge of edges) {
    if (!fwdAdj.has(edge.from)) fwdAdj.set(edge.from, []);
    fwdAdj.get(edge.from).push(edge.to);
    if (!backAdj.has(edge.to)) backAdj.set(edge.to, []);
    backAdj.get(edge.to).push(edge.from);
  }
  const walk = (start, adj, targetSet) => {
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const next of (adj.get(cur) || [])) {
        if (next !== activeId && !targetSet.has(next)) {
          targetSet.add(next);
          queue.push(next);
        }
      }
    }
  };
  walk(activeId, backAdj, upstream);
  walk(activeId, fwdAdj, downstream);
  const edgeIds = new Set();
  for (const edge of edges) {
    const inUp = (edge.from === activeId || upstream.has(edge.from)) && (edge.to === activeId || upstream.has(edge.to));
    const inDown = (edge.from === activeId || downstream.has(edge.from)) && (edge.to === activeId || downstream.has(edge.to));
    if (inUp || inDown) edgeIds.add(edge.id);
  }
  return { focusId: activeId, upstream, downstream, edgeIds };
}

function tfApplyLineageHighlight(canvasEl, edges) {
  const activeId = taskFlowPrefs.hoveredNodeId || taskFlowPrefs.selectedNodeId;
  const lineage = tfComputeLineage(activeId, edges);
  for (const el of canvasEl.querySelectorAll('[data-tf-node-id]')) {
    const id = el.dataset.tfNodeId;
    el.classList.toggle('is-selected', id === taskFlowPrefs.selectedNodeId);
    if (!lineage) {
      el.classList.remove('is-dimmed', 'is-focus', 'is-upstream', 'is-downstream');
      continue;
    }
    const isFocus = id === lineage.focusId;
    const isUp = lineage.upstream.has(id);
    const isDown = lineage.downstream.has(id);
    el.classList.toggle('is-focus', isFocus);
    el.classList.toggle('is-upstream', isUp);
    el.classList.toggle('is-downstream', isDown);
    el.classList.toggle('is-dimmed', !isFocus && !isUp && !isDown);
  }
  for (const el of canvasEl.querySelectorAll('[data-tf-edge-id]')) {
    const id = el.dataset.tfEdgeId;
    if (!lineage) {
      el.classList.remove('is-dimmed', 'is-active');
      continue;
    }
    const active = lineage.edgeIds.has(id);
    el.classList.toggle('is-active', active);
    el.classList.toggle('is-dimmed', !active);
  }
}

function tfFilterGraph(rawTaskFlow, scopedCompanionsList) {
  const allNodes = Array.isArray(rawTaskFlow?.nodes) ? rawTaskFlow.nodes : [];
  const allEdges = Array.isArray(rawTaskFlow?.edges) ? rawTaskFlow.edges : [];
  const nowMs = Math.max(Number(rawTaskFlow?.observedAt) || 0, Date.now());
  const windowMs = TASKFLOW_WINDOWS_MS[taskFlowPrefs.window] ?? Infinity;
  const isScoped = Array.isArray(snapshot.companions) && scopedCompanionsList.length < snapshot.companions.length;
  const scopedBotIds = new Set(scopedCompanionsList.map((c) => c.id));

  let nodes = allNodes.filter((n) => {
    if (!n || !n.id) return false;
    if (isScoped && n.botId && !scopedBotIds.has(n.botId)) return false;
    if (windowMs === Infinity) return true;
    if (n.status === 'running' || n.status === 'waiting') return true;
    const latest = Math.max(n.completedAtMs || 0, n.updatedAtMs || 0, n.startedAtMs || 0, n.createdAtMs || 0);
    return latest >= nowMs - windowMs;
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges = allEdges.filter((e) => e && e.from && e.to && e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to));

  if (taskFlowPrefs.linkedOnly) {
    const linkedIds = new Set();
    for (const e of edges) {
      linkedIds.add(e.from);
      linkedIds.add(e.to);
    }
    nodes = nodes.filter((n) => linkedIds.has(n.id));
    edges = edges.filter((e) => linkedIds.has(e.from) && linkedIds.has(e.to));
  }

  return { nodes, edges, nowMs };
}

function tfBuildSwimlanes(nodes, edges, folderLookup) {
  const mode = taskFlowPrefs.lane;
  if (mode === 'chain') {
    const parent = new Map(nodes.map((n) => [n.id, n.id]));
    const find = (x) => {
      let cur = x;
      while (parent.get(cur) !== cur) {
        parent.set(cur, parent.get(parent.get(cur)));
        cur = parent.get(cur);
      }
      return cur;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    for (const e of edges) {
      if (parent.has(e.from) && parent.has(e.to)) union(e.from, e.to);
    }
    const groups = new Map();
    for (const n of nodes) {
      const root = find(n.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(n);
    }
    const lanes = [];
    for (const [id, list] of groups.entries()) {
      list.sort((a, b) => (a.startedAtMs ?? a.createdAtMs ?? a.updatedAtMs) - (b.startedAtMs ?? b.createdAtMs ?? b.updatedAtMs));
      const label = list.length > 1 ? `链路: ${list[0].title}` : `独立: ${list[0].title}`;
      lanes.push({ id, label, nodes: list });
    }
    lanes.sort((a, b) => (b.nodes.length - a.nodes.length) || ((a.nodes[0]?.createdAtMs ?? 0) - (b.nodes[0]?.createdAtMs ?? 0)));
    return lanes;
  }

  const groups = new Map();
  for (const n of nodes) {
    let key = '__ungrouped__';
    let label = '未分组伙伴';
    if (mode === 'device') {
      key = n.deviceId || '__local__';
      label = n.deviceName || (key === snapshot.taskFlow?.selfDeviceId ? (snapshot.taskFlow?.selfDeviceName || '本机') : key) || '本机';
    } else {
      key = n.folderId || '__ungrouped__';
      if (Array.isArray(n.folderBreadcrumb) && n.folderBreadcrumb.length) {
        label = n.folderBreadcrumb.join(' / ');
      } else if (n.folderId && folderLookup?.get?.(n.folderId)) {
        label = folderLookup.get(n.folderId).pathLabel || folderLookup.get(n.folderId).name || n.folderId;
      }
    }
    if (!groups.has(key)) groups.set(key, { id: key, label, nodes: [] });
    groups.get(key).nodes.push(n);
  }
  const lanes = Array.from(groups.values());
  for (const lane of lanes) {
    lane.nodes.sort((a, b) => (a.startedAtMs ?? a.createdAtMs ?? a.updatedAtMs) - (b.startedAtMs ?? b.createdAtMs ?? b.updatedAtMs));
  }
  lanes.sort((a, b) => {
    if (a.id.startsWith('__') && !b.id.startsWith('__')) return 1;
    if (!a.id.startsWith('__') && b.id.startsWith('__')) return -1;
    return a.label.localeCompare(b.label, 'zh-CN');
  });
  return lanes;
}

function tfComputeDagLayout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inDeg = new Map(nodes.map((n) => [n.id, 0]));
  const fwd = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    fwd.get(e.from)?.push(e);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const remaining = new Set(nodes.map((n) => n.id));
  const topoOrder = [];
  const brokenBackEdges = new Set();

  while (remaining.size > 0) {
    const zeros = Array.from(remaining).filter((id) => (inDeg.get(id) ?? 0) === 0);
    if (zeros.length === 0) {
      const sortedRest = Array.from(remaining).sort((a, b) =>
        ((inDeg.get(a) ?? 0) - (inDeg.get(b) ?? 0))
        || ((byId.get(a)?.createdAtMs ?? 0) - (byId.get(b)?.createdAtMs ?? 0)));
      zeros.push(sortedRest[0]);
    } else {
      zeros.sort((a, b) => (byId.get(a)?.createdAtMs ?? 0) - (byId.get(b)?.createdAtMs ?? 0));
    }
    const pick = zeros[0];
    remaining.delete(pick);
    topoOrder.push(pick);
    for (const e of (fwd.get(pick) || [])) {
      if (!remaining.has(e.to)) {
        brokenBackEdges.add(e.id);
        continue;
      }
      inDeg.set(e.to, Math.max(0, (inDeg.get(e.to) ?? 1) - 1));
    }
  }

  const layer = new Map(topoOrder.map((id) => [id, 0]));
  for (const id of topoOrder) {
    const curLayer = layer.get(id) ?? 0;
    for (const e of (fwd.get(id) || [])) {
      if (brokenBackEdges.has(e.id)) continue;
      if ((layer.get(e.to) ?? 0) <= curLayer) {
        layer.set(e.to, curLayer + 1);
      }
    }
  }

  const cols = new Map();
  for (const id of topoOrder) {
    const colIdx = layer.get(id) ?? 0;
    if (!cols.has(colIdx)) cols.set(colIdx, []);
    cols.get(colIdx).push(byId.get(id));
  }
  const colIndices = Array.from(cols.keys()).sort((a, b) => a - b);
  return { colIndices, cols, brokenBackEdges };
}

function tfBindControls() {
  if (taskFlowControlsBound) return;
  const controls = document.getElementById('taskflow-controls');
  if (!controls) return;
  taskFlowControlsBound = true;
  controls.addEventListener('click', (event) => {
    const btn = event.target?.closest?.('button');
    if (!btn) return;
    if (btn.dataset.tfView) {
      taskFlowPrefs.view = btn.dataset.tfView;
    } else if (btn.dataset.tfLane) {
      taskFlowPrefs.lane = btn.dataset.tfLane;
    } else if (btn.dataset.tfWin) {
      taskFlowPrefs.window = btn.dataset.tfWin;
    } else if (btn.id === 'taskflow-toggle-steps') {
      taskFlowPrefs.showSteps = !taskFlowPrefs.showSteps;
    } else if (btn.id === 'taskflow-toggle-linked') {
      taskFlowPrefs.linkedOnly = !taskFlowPrefs.linkedOnly;
    } else {
      return;
    }
    tfSyncControlButtons();
    renderTaskFlow(scopedCompanions(), buildFolderLookup());
  });
}

function tfSyncControlButtons() {
  const controls = document.getElementById('taskflow-controls');
  if (!controls) return;
  for (const btn of controls.querySelectorAll('[data-tf-view]')) {
    btn.classList.toggle('is-active', btn.dataset.tfView === taskFlowPrefs.view);
  }
  for (const btn of controls.querySelectorAll('[data-tf-lane]')) {
    btn.classList.toggle('is-active', btn.dataset.tfLane === taskFlowPrefs.lane);
    btn.disabled = taskFlowPrefs.view === 'dag';
  }
  for (const btn of controls.querySelectorAll('[data-tf-win]')) {
    btn.classList.toggle('is-active', btn.dataset.tfWin === taskFlowPrefs.window);
  }
  const stepsBtn = document.getElementById('taskflow-toggle-steps');
  if (stepsBtn) {
    stepsBtn.classList.toggle('is-active', taskFlowPrefs.showSteps);
    stepsBtn.setAttribute('aria-pressed', String(taskFlowPrefs.showSteps));
  }
  const linkedBtn = document.getElementById('taskflow-toggle-linked');
  if (linkedBtn) {
    linkedBtn.classList.toggle('is-active', taskFlowPrefs.linkedOnly);
    linkedBtn.setAttribute('aria-pressed', String(taskFlowPrefs.linkedOnly));
  }
}

function tfFindCompanionForNode(flowNode, companionsList) {
  if (!flowNode) return null;
  const all = [
    ...(Array.isArray(companionsList) ? companionsList : []),
    ...(Array.isArray(snapshot.companions) ? snapshot.companions : []),
  ];
  return all.find((c) => c && ((flowNode.botId && c.id === flowNode.botId) || (flowNode.sessionId && c.sessionId === flowNode.sessionId))) || null;
}

function tfWireNodeInteractions(el, nodeId, canvasEl, edges) {
  el.addEventListener('mouseenter', () => {
    taskFlowPrefs.hoveredNodeId = nodeId;
    tfApplyLineageHighlight(canvasEl, edges);
  });
  el.addEventListener('mouseleave', () => {
    if (taskFlowPrefs.hoveredNodeId === nodeId) {
      taskFlowPrefs.hoveredNodeId = null;
      tfApplyLineageHighlight(canvasEl, edges);
    }
  });
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    taskFlowPrefs.selectedNodeId = taskFlowPrefs.selectedNodeId === nodeId ? null : nodeId;
    renderTaskFlow(scopedCompanions(), buildFolderLookup());
  });
}

function tfRenderInspector(container, nodes, edges, nowMs, companionsList) {
  const selected = nodes.find((n) => n.id === taskFlowPrefs.selectedNodeId);
  if (!selected) return;

  const box = node('div', 'taskflow-inspector');
  const head = node('div', 'taskflow-inspector-head');
  const titleWrap = node('div', 'taskflow-inspector-titlewrap');
  const statusPill = node('span', 'taskflow-status-pill', tfStatusLabel(selected.status));
  statusPill.dataset.status = selected.status || 'idle';
  titleWrap.append(statusPill, node('strong', '', selected.title || selected.id));
  if (selected.isCrossDevice) {
    titleWrap.append(node('span', 'taskflow-tag is-cross', '跨电脑'));
  }

  const actions = node('div', 'taskflow-inspector-actions');
  const matchedCompanion = tfFindCompanionForNode(selected, companionsList);
  if (matchedCompanion && typeof showDetails === 'function') {
    const openBtn = node('button', 'taskflow-action-btn', '查看对应伙伴');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => showDetails(matchedCompanion));
    actions.append(openBtn);
  }
  const closeBtn = node('button', 'taskflow-action-btn is-subtle', '收起详情');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => {
    taskFlowPrefs.selectedNodeId = null;
    renderTaskFlow(scopedCompanions(), buildFolderLookup());
  });
  actions.append(closeBtn);
  head.append(titleWrap, actions);
  box.append(head);

  const metaParts = [
    selected.botName ? `伙伴: ${selected.botName}` : null,
    selected.deviceName ? `电脑: ${selected.deviceName}` : null,
    Array.isArray(selected.folderBreadcrumb) && selected.folderBreadcrumb.length
      ? `分组: ${selected.folderBreadcrumb.join(' / ')}`
      : null,
    `开始: ${tfFormatClock(selected.startedAtMs ?? selected.createdAtMs, true)}`,
    `耗时: ${tfFormatDuration(selected.startedAtMs ?? selected.createdAtMs, selected.completedAtMs, selected.status, nowMs)}`,
  ].filter(Boolean);
  box.append(node('p', 'taskflow-inspector-meta', metaParts.join(' · ')));

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const upstreamEdges = edges.filter((e) => e.to === selected.id);
  const downstreamEdges = edges.filter((e) => e.from === selected.id);

  if (upstreamEdges.length || downstreamEdges.length) {
    const depsRow = node('div', 'taskflow-inspector-deps');
    const makeRelList = (title, relEdges, pickOtherId) => {
      const col = node('div', 'taskflow-dep-col');
      col.append(node('span', 'taskflow-dep-label', `${title} (${relEdges.length})`));
      const chips = node('div', 'taskflow-dep-chips');
      if (!relEdges.length) {
        chips.append(node('span', 'taskflow-empty-inline', '无'));
      } else {
        for (const e of relEdges) {
          const target = nodeMap.get(pickOtherId(e));
          if (!target) continue;
          const chip = node('button', 'taskflow-dep-chip', `${target.title} (${tfEdgeLabel(e)})`);
          chip.type = 'button';
          chip.addEventListener('click', () => {
            taskFlowPrefs.selectedNodeId = target.id;
            renderTaskFlow(scopedCompanions(), buildFolderLookup());
          });
          chips.append(chip);
        }
      }
      col.append(chips);
      return col;
    };
    depsRow.append(
      makeRelList('前置依赖', upstreamEdges, (e) => e.from),
      makeRelList('下游影响', downstreamEdges, (e) => e.to),
    );
    box.append(depsRow);
  }

  if (Array.isArray(selected.internalSteps) && selected.internalSteps.length) {
    const stepsWrap = node('div', 'taskflow-inspector-steps');
    stepsWrap.append(node('div', 'taskflow-dep-label', `内部步骤进度 (${selected.internalSteps.length})`));
    const list = node('ol', 'taskflow-step-list');
    for (const step of selected.internalSteps) {
      const li = node('li', 'taskflow-step-item');
      li.dataset.status = step.status || 'pending';
      const stepDot = node('span', 'taskflow-step-dot');
      const stepTitle = node('span', 'taskflow-step-text', step.content || step.stepId);
      const stepMeta = [];
      if (step.owner) stepMeta.push(`@${step.owner}`);
      if (Array.isArray(step.blockedBy) && step.blockedBy.length) {
        stepMeta.push(`依赖 ${step.blockedBy.join(', ')}`);
      }
      const dur = tfFormatDuration(step.startedAtMs ?? step.createdAtMs, step.completedAtMs, step.status === 'in_progress' ? 'running' : step.status, nowMs);
      if (dur && dur !== '待开始') stepMeta.push(dur);
      li.append(stepDot, stepTitle);
      if (stepMeta.length) li.append(node('span', 'taskflow-step-meta', stepMeta.join(' · ')));
      list.append(li);
    }
    stepsWrap.append(list);
    box.append(stepsWrap);
  }

  container.append(box);
}

function tfRenderGantt(canvasEl, nodes, edges, nowMs, folderLookup) {
  const windowMs = TASKFLOW_WINDOWS_MS[taskFlowPrefs.window] ?? Infinity;
  let minMs = Infinity;
  let maxMs = -Infinity;

  if (windowMs !== Infinity) {
    maxMs = nowMs;
    minMs = nowMs - windowMs;
  } else {
    for (const n of nodes) {
      const s = n.startedAtMs ?? n.createdAtMs ?? n.updatedAtMs ?? nowMs;
      const e = (n.status === 'running' || n.status === 'waiting')
        ? nowMs
        : Math.max(s, n.completedAtMs ?? n.updatedAtMs ?? s);
      if (s < minMs) minMs = s;
      if (e > maxMs) maxMs = e;
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
      minMs = nowMs - 3600 * 1000;
      maxMs = nowMs;
    }
    const pad = Math.max(60 * 1000, Math.round((maxMs - minMs) * 0.04));
    maxMs += pad;
  }
  const spanMs = Math.max(60 * 1000, maxMs - minMs);
  const withDate = spanMs > 12 * 3600 * 1000;
  const pctFor = (ms) => Math.max(0, Math.min(100, ((ms - minMs) / spanMs) * 100));

  const ganttWrap = node('div', 'taskflow-gantt');

  // Time axis header
  const header = node('div', 'taskflow-gantt-header');
  header.append(node('div', 'taskflow-gantt-labelcol', '分组 / 任务泳道'));
  const ticksWrap = node('div', 'taskflow-gantt-ticks');
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const t = minMs + spanMs * ratio;
    const tick = node('span', 'taskflow-tick', tfFormatClock(t, withDate));
    tick.style.left = `${ratio * 100}%`;
    ticksWrap.append(tick);
  }
  if (nowMs >= minMs && nowMs <= maxMs) {
    const nowTag = node('span', 'taskflow-now-tag', '当前');
    nowTag.style.left = `${pctFor(nowMs)}%`;
    ticksWrap.append(nowTag);
  }
  header.append(ticksWrap);
  ganttWrap.append(header);

  const lanes = tfBuildSwimlanes(nodes, edges, folderLookup);
  const body = node('div', 'taskflow-gantt-body');
  const laneRowsWrap = node('div', 'taskflow-gantt-lanes');
  const trackRowPositions = new Map();
  let trackTotalY = 0;

  const LANE_HEAD_H = 26;
  const BAR_ROW_H = 42;
  const STEP_LINE_H = 18;

  for (const lane of lanes) {
    const laneEl = node('div', 'taskflow-lane');
    const laneHead = node('div', 'taskflow-lane-head');
    const activeCnt = lane.nodes.filter((n) => n.status === 'running' || n.status === 'waiting').length;
    laneHead.append(
      node('span', 'taskflow-lane-title', lane.label),
      node('span', 'taskflow-lane-count', activeCnt > 0 ? `${activeCnt} 进行中 / ${lane.nodes.length}` : `${lane.nodes.length} 项`),
    );
    laneEl.append(laneHead);
    trackTotalY += LANE_HEAD_H;

    for (const item of lane.nodes) {
      const steps = taskFlowPrefs.showSteps && Array.isArray(item.internalSteps) ? item.internalSteps.slice(0, 6) : [];
      const rowH = BAR_ROW_H + (steps.length ? steps.length * STEP_LINE_H + 6 : 0);

      const row = node('div', 'taskflow-row');
      row.style.height = `${rowH}px`;

      const rowLabel = node('div', 'taskflow-row-label');
      rowLabel.dataset.tfNodeId = item.id;
      const dot = node('span', 'taskflow-dot');
      dot.dataset.status = item.status || 'idle';
      const textWrap = node('div', 'taskflow-row-text');
      const titleSpan = node('span', 'taskflow-row-title', item.title || item.id);
      const subParts = [item.botName, item.deviceName].filter(Boolean);
      textWrap.append(titleSpan);
      if (subParts.length) textWrap.append(node('span', 'taskflow-row-sub', subParts.join(' · ')));
      rowLabel.append(dot, textWrap);
      tfWireNodeInteractions(rowLabel, item.id, canvasEl, edges);

      const track = node('div', 'taskflow-row-track');
      const rawStart = item.startedAtMs ?? item.createdAtMs ?? item.updatedAtMs ?? minMs;
      const rawEnd = (item.status === 'running' || item.status === 'waiting')
        ? nowMs
        : Math.max(rawStart, item.completedAtMs ?? item.updatedAtMs ?? rawStart);
      const leftPct = pctFor(rawStart);
      const rightPct = Math.max(leftPct + 1.8, pctFor(rawEnd));
      const widthPct = Math.min(100 - leftPct, rightPct - leftPct);

      trackRowPositions.set(item.id, {
        leftPct,
        rightPct: Math.min(100, leftPct + widthPct),
        centerY: trackTotalY + BAR_ROW_H / 2,
      });

      const bar = node('button', 'taskflow-bar');
      bar.type = 'button';
      bar.dataset.tfNodeId = item.id;
      bar.dataset.status = item.status || 'idle';
      bar.style.left = `${leftPct}%`;
      bar.style.width = `${widthPct}%`;
      const durText = tfFormatDuration(rawStart, rawEnd, item.status, nowMs);
      bar.title = `${item.title} (${tfStatusLabel(item.status)}, ${durText})`;
      bar.append(node('span', 'taskflow-bar-title', item.title));
      bar.append(node('span', 'taskflow-bar-dur', durText));
      if (item.isCrossDevice) bar.append(node('span', 'taskflow-bar-cross', '跨端'));
      tfWireNodeInteractions(bar, item.id, canvasEl, edges);
      track.append(bar);

      if (steps.length) {
        const stepsStrip = node('div', 'taskflow-bar-steps');
        for (const step of steps) {
          const stepEl = node('div', 'taskflow-mini-step');
          stepEl.dataset.status = step.status || 'pending';
          const sStart = step.startedAtMs ?? step.createdAtMs ?? rawStart;
          const sEnd = step.status === 'in_progress'
            ? nowMs
            : Math.max(sStart, step.completedAtMs ?? step.updatedAtMs ?? sStart);
          const sLeft = pctFor(sStart);
          const sWidth = Math.min(100 - sLeft, Math.max(1.2, pctFor(sEnd) - sLeft));
          const visualWidth = Math.min(100, Math.max(sWidth, 8));
          const visualLeft = Math.max(0, Math.min(sLeft, 100 - visualWidth));
          stepEl.style.left = `${visualLeft}%`;
          stepEl.style.width = `${visualWidth}%`;
          const stepLabel = step.blockedBy?.length
            ? `${step.content} (等 ${step.blockedBy.join(',')})`
            : step.content;
          stepEl.textContent = stepLabel;
          stepsStrip.append(stepEl);
        }
        track.append(stepsStrip);
      }

      row.append(rowLabel, track);
      laneEl.append(row);
      trackTotalY += rowH;
    }
    laneRowsWrap.append(laneEl);
  }

  // Right-side SVG overlay for Now line + dependency curves (aligned exactly to track column)
  if (trackTotalY > 0 && (edges.length > 0 || (nowMs >= minMs && nowMs <= maxMs))) {
    const svgOverlay = node('div', 'taskflow-gantt-svg-layer');
    const svg = tfSvgEl('svg', {
      class: 'taskflow-svg',
      viewBox: `0 0 1000 ${Math.max(1, trackTotalY)}`,
      preserveAspectRatio: 'none',
    });

    if (nowMs >= minMs && nowMs <= maxMs) {
      const nx = pctFor(nowMs) * 10;
      svg.append(tfSvgEl('line', {
        x1: nx, y1: 0, x2: nx, y2: trackTotalY,
        class: 'taskflow-now-line',
        'vector-effect': 'non-scaling-stroke',
      }));
    }

    for (const e of edges) {
      const a = trackRowPositions.get(e.from);
      const b = trackRowPositions.get(e.to);
      if (!a || !b) continue;
      const x1 = a.rightPct * 10;
      const y1 = a.centerY;
      const x2 = b.leftPct * 10;
      const y2 = b.centerY;
      const dx = Math.max(24, Math.abs(x2 - x1) * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const path = tfSvgEl('path', {
        d,
        class: `taskflow-edge${e.isCrossDevice ? ' is-cross' : ''}`,
        'data-tf-edge-id': e.id,
        'data-edge-kind': e.kind || 'blocks',
        'vector-effect': 'non-scaling-stroke',
      });
      const tip = tfSvgEl('title');
      tip.textContent = tfEdgeLabel(e);
      path.append(tip);
      svg.append(path);
    }
    svgOverlay.append(svg);
    laneRowsWrap.append(svgOverlay);
  }

  body.append(laneRowsWrap);
  ganttWrap.append(body);
  canvasEl.append(ganttWrap);
}

function tfRenderDag(canvasEl, nodes, edges, nowMs) {
  const { colIndices, cols, brokenBackEdges } = tfComputeDagLayout(nodes, edges);
  const COL_W = 224;
  const COL_GAP = 64;
  const ROW_GAP = 14;
  const PAD = 16;

  const dagScroll = node('div', 'taskflow-dag-scroll');
  const stage = node('div', 'taskflow-dag-stage');
  const rects = new Map();

  let maxColHeight = 0;
  colIndices.forEach((colIdx, visualIdx) => {
    const colNodes = cols.get(colIdx) || [];
    let y = PAD;
    const x = PAD + visualIdx * (COL_W + COL_GAP);
    for (const item of colNodes) {
      const stepsCount = taskFlowPrefs.showSteps && Array.isArray(item.internalSteps)
        ? Math.min(4, item.internalSteps.length)
        : 0;
      const h = 76 + (stepsCount ? 12 + stepsCount * 18 : 0);
      rects.set(item.id, { x, y, w: COL_W, h });

      const card = node('button', 'taskflow-dag-node');
      card.type = 'button';
      card.dataset.tfNodeId = item.id;
      card.dataset.status = item.status || 'idle';
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.style.width = `${COL_W}px`;
      card.style.minHeight = `${h}px`;

      const topRow = node('div', 'taskflow-dag-top');
      const pill = node('span', 'taskflow-status-pill', tfStatusLabel(item.status));
      pill.dataset.status = item.status || 'idle';
      topRow.append(pill);
      if (item.isCrossDevice) topRow.append(node('span', 'taskflow-tag is-cross', '跨端'));
      const dur = node('span', 'taskflow-dag-dur', tfFormatDuration(item.startedAtMs ?? item.createdAtMs, item.completedAtMs, item.status, nowMs));
      topRow.append(dur);
      card.append(topRow);

      card.append(node('div', 'taskflow-dag-title', item.title || item.id));
      const meta = [item.botName, item.deviceName].filter(Boolean).join(' · ') || '主链路任务';
      card.append(node('div', 'taskflow-dag-sub', meta));

      if (stepsCount > 0) {
        const miniList = node('div', 'taskflow-dag-steps');
        for (const s of item.internalSteps.slice(0, 4)) {
          const line = node('div', 'taskflow-dag-step', `${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : '○'} ${s.content}`);
          line.dataset.status = s.status || 'pending';
          miniList.append(line);
        }
        card.append(miniList);
      }

      tfWireNodeInteractions(card, item.id, canvasEl, edges);
      stage.append(card);
      y += h + ROW_GAP;
    }
    if (y > maxColHeight) maxColHeight = y;
  });

  const stageW = Math.max(480, PAD * 2 + colIndices.length * COL_W + Math.max(0, colIndices.length - 1) * COL_GAP);
  const stageH = Math.max(220, maxColHeight + PAD);
  stage.style.width = `${stageW}px`;
  stage.style.height = `${stageH}px`;

  const svg = tfSvgEl('svg', {
    class: 'taskflow-dag-svg',
    width: stageW,
    height: stageH,
    viewBox: `0 0 ${stageW} ${stageH}`,
  });
  const defs = tfSvgEl('defs');
  const marker = tfSvgEl('marker', {
    id: 'tf-dag-arrow',
    viewBox: '0 0 10 10',
    refX: '9',
    refY: '5',
    markerWidth: '6',
    markerHeight: '6',
    orient: 'auto-start-reverse',
  });
  marker.append(tfSvgEl('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' }));
  defs.append(marker);
  svg.append(defs);

  for (const e of edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    const isBack = brokenBackEdges.has(e.id) || b.x <= a.x;
    let d;
    if (isBack) {
      const x1 = a.x + a.w / 2;
      const y1 = a.y;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const arch = Math.max(12, Math.min(y1, y2) - 34);
      d = `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${arch}, ${x2} ${y2}`;
    } else {
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x - 2;
      const y2 = b.y + b.h / 2;
      const dx = Math.max(24, (x2 - x1) * 0.45);
      d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }
    const path = tfSvgEl('path', {
      d,
      class: `taskflow-edge${e.isCrossDevice ? ' is-cross' : ''}${isBack ? ' is-back' : ''}`,
      'data-tf-edge-id': e.id,
      'data-edge-kind': e.kind || 'blocks',
      'marker-end': 'url(#tf-dag-arrow)',
    });
    const tip = tfSvgEl('title');
    tip.textContent = tfEdgeLabel(e);
    path.append(tip);
    svg.append(path);
  }

  stage.prepend(svg);
  dagScroll.append(stage);
  canvasEl.append(dagScroll);
}

function renderTaskFlow(companionsList, folderLookup) {
  tfBindControls();
  tfSyncControlButtons();
  const canvas = document.getElementById('taskflow-canvas');
  const meta = document.getElementById('taskflow-meta');
  if (!canvas) return;
  canvas.textContent = '';

  const raw = snapshot.taskFlow;
  if (!raw && !receivedState) {
    canvas.append(node('p', 'empty', '正在汇总任务依赖与时间推进数据…'));
    return;
  }

  const { nodes, edges, nowMs } = tfFilterGraph(raw, companionsList);
  const runningCount = nodes.filter((n) => n.status === 'running' || n.status === 'waiting').length;
  const crossCount = nodes.filter((n) => n.isCrossDevice).length + edges.filter((e) => e.isCrossDevice).length;
  if (meta) {
    const parts = [
      `任务节点 ${nodes.length}`,
      `依赖边 ${edges.length}`,
      `活跃 ${runningCount}`,
    ];
    if (crossCount > 0) parts.push(`跨电脑交互 ${crossCount}`);
    if (raw?.hiddenScheduledCount > 0) parts.push(`已折叠 ${raw.hiddenScheduledCount} 项空闲定时任务`);
    meta.textContent = parts.join(' · ');
  }

  if (taskFlowPrefs.selectedNodeId && !nodes.some((n) => n.id === taskFlowPrefs.selectedNodeId)) {
    taskFlowPrefs.selectedNodeId = null;
  }

  if (!nodes.length) {
    canvas.append(node('p', 'empty', '当前筛选条件下暂无任务依赖或时间推进记录。可在助手中启动多伙伴委派、跨电脑协作或拆解子任务后再查看。'));
    return;
  }

  if (taskFlowPrefs.view === 'dag') {
    tfRenderDag(canvas, nodes, edges, nowMs);
  } else {
    tfRenderGantt(canvas, nodes, edges, nowMs, folderLookup);
  }

  tfRenderInspector(canvas, nodes, edges, nowMs, companionsList);
  tfApplyLineageHighlight(canvas, edges);
}
let selectedCompanion = null;
let pendingDetailId = null;
let pendingOpenId = null;
let refreshTimer = null;
let detailTimer = null;
let openTimer = null;
let requestSequence = 0;
const expandedVerifications = new Set();
const viewPrefs = loadViewPrefs();
const temporaryGroupOverrides = new Map();
let renderedGroupKeys = [];

function loadViewPrefs() {
  const fallback = { groupByComputer: false, compactMode: false, collapsed: new Set() };
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      groupByComputer: parsed?.groupByComputer === true,
      compactMode: parsed?.compactMode === true,
      collapsed: new Set(Array.isArray(parsed?.collapsed) ? parsed.collapsed.filter(item => typeof item === 'string' && item) : []),
    };
  } catch {
    return fallback;
  }
}

function saveViewPrefs() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      groupByComputer: viewPrefs.groupByComputer,
      compactMode: viewPrefs.compactMode,
      collapsed: [...viewPrefs.collapsed],
    }));
  } catch {}
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function request(action, companionId) {
  const requestId = `view-${Date.now()}-${++requestSequence}`;
  channel.postMessage({ source: 'view', requestId, action, companionId });
  return requestId;
}

function dateLabel(value, withDate = false) {
  if (!value) return '时间未知';
  const timestamp = typeof value === 'number' && value < 100000000000 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', withDate ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusOf(companion) {
  return companion.home?.online === false ? 'offline' : companion.status || 'idle';
}

function statusLabel(companion) {
  const result = node('span', 'status', statuses[statusOf(companion)] || '状态未知');
  result.dataset.state = statusOf(companion);
  return result;
}

function deviceName(companion) {
  return companion.home?.deviceName || companion.deviceLabel || companion.computerName || (companion.home?.isSelf ? '本机' : '电脑未知');
}

function buildFolderLookup() {
  const map = new Map();
  const register = (item) => {
    if (!item || typeof item !== 'object') return;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id || !name || map.has(id)) return;
    const parentId = typeof item.parentId === 'string' && item.parentId.trim() ? item.parentId.trim() : null;
    const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0;
    const depth = typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : 1;
    const path = Array.isArray(item.path) ? item.path.filter(seg => typeof seg === 'string' && seg.trim()).map(seg => seg.trim()) : [];
    map.set(id, { id, name, parentId, order, depth, path });
  };
  for (const folder of snapshot.folders || []) register(folder);
  const visitTree = (nodes) => {
    for (const entry of nodes || []) {
      register(entry);
      if (Array.isArray(entry?.children)) visitTree(entry.children);
    }
  };
  visitTree(snapshot.hierarchy?.tree);
  for (const folder of map.values()) {
    if (folder.path.length) continue;
    const chain = [];
    const seen = new Set();
    let curr = folder;
    while (curr && !seen.has(curr.id)) {
      seen.add(curr.id);
      chain.unshift(curr.name);
      curr = curr.parentId ? map.get(curr.parentId) : null;
    }
    folder.path = chain;
    folder.depth = chain.length || 1;
  }
  return map;
}

function companionPathSegments(companion, folderLookup) {
  if (Array.isArray(companion?.groupPath) && companion.groupPath.length) {
    return companion.groupPath.filter(seg => typeof seg === 'string' && seg.trim()).map(seg => seg.trim());
  }
  if (companion?.groupId && folderLookup?.has(companion.groupId)) {
    const folder = folderLookup.get(companion.groupId);
    return folder.path?.length ? folder.path : [folder.name];
  }
  return [];
}

function companionPathLabel(companion, folderLookup) {
  return companionPathSegments(companion, folderLookup).join(' / ');
}

function formatDetailMeta(companion, folderLookup) {
  const parts = [deviceName(companion)];
  const pathLabel = companionPathLabel(companion, folderLookup);
  if (pathLabel) parts.push(pathLabel);
  parts.push(statuses[statusOf(companion)] || '状态未知');
  return parts.join(' · ');
}

function hasRosterFilter() {
  return elements.search.value.trim().length > 0 || selectedFilter !== 'all' || elements.device.value !== 'all';
}

function scopedCompanions() {
  return snapshot.companions.filter(companion => elements.scope.value === 'all' || companion.name?.includes('万界'));
}

function showNotice(message) {
  elements.notice.textContent = message || '';
  elements.notice.hidden = !message;
}

function renderSummary(companions) {
  const counts = [
    ['伙伴总数', companions.length],
    ['运行中', companions.filter(item => statusOf(item) === 'running').length],
    ['待处理', companions.filter(item => statusOf(item) === 'awaiting').length],
    ['异常', companions.filter(item => statusOf(item) === 'error').length],
    ['离线', companions.filter(item => statusOf(item) === 'offline').length],
  ];
  elements.summary.replaceChildren(...counts.map(([label, count]) => {
    const metric = node('div', 'metric');
    metric.append(node('span', 'metric-value', receivedState ? count : '—'), node('span', 'metric-label', label));
    return metric;
  }));
}

function renderFilters(companions) {
  const options = [['all', '全部'], ['running', '运行中'], ['awaiting', '待处理'], ['error', '异常'], ['offline', '离线']];
  elements.filters.replaceChildren(...options.map(([value, label]) => {
    const count = value === 'all' ? companions.length : companions.filter(item => statusOf(item) === value).length;
    const button = node('button', 'filter', `${label} ${receivedState ? count : '—'}`);
    button.type = 'button';
    button.dataset.filter = value;
    button.setAttribute('aria-pressed', String(value === selectedFilter));
    button.addEventListener('click', () => { selectedFilter = value; temporaryGroupOverrides.clear(); render(); });
    return button;
  }));
}

function renderDeviceFilter() {
  const previous = elements.device.value;
  const names = [...new Set(scopedCompanions().map(deviceName))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  elements.device.replaceChildren(new Option('全部电脑', 'all'), ...names.map(name => new Option(name, name)));
  elements.device.value = names.includes(previous) ? previous : 'all';
}

function isGroupCollapsed(collapseKey, activeFilter) {
  if (temporaryGroupOverrides.has(collapseKey)) return temporaryGroupOverrides.get(collapseKey);
  if (activeFilter) return false;
  return viewPrefs.collapsed.has(collapseKey);
}

function toggleGroup(collapseKey, activeFilter) {
  const nextCollapsed = !isGroupCollapsed(collapseKey, activeFilter);
  if (activeFilter) {
    temporaryGroupOverrides.set(collapseKey, nextCollapsed);
  } else {
    temporaryGroupOverrides.delete(collapseKey);
    if (nextCollapsed) viewPrefs.collapsed.add(collapseKey);
    else viewPrefs.collapsed.delete(collapseKey);
    saveViewPrefs();
  }
  render();
}

function buildVisibleFolderTree(companions, baseLookup) {
  const nodes = new Map();
  for (const [id, folder] of baseLookup.entries()) {
    nodes.set(id, { ...folder, children: [], companions: [], subtreeCompanions: [] });
  }
  const ensureSyntheticPath = (segments, leafId) => {
    let prevId = null;
    for (let i = 0; i < segments.length; i += 1) {
      const isLeaf = i === segments.length - 1;
      const candidateId = isLeaf && leafId ? leafId : `__path__:${segments.slice(0, i + 1).join('/')}`;
      if (!nodes.has(candidateId)) {
        nodes.set(candidateId, {
          id: candidateId,
          name: segments[i],
          parentId: prevId,
          order: nodes.size,
          depth: i + 1,
          path: segments.slice(0, i + 1),
          children: [],
          companions: [],
          subtreeCompanions: [],
        });
      }
      prevId = candidateId;
    }
    return prevId;
  };
  const indexMap = new Map(companions.map((companion, idx) => [companion.id, idx]));
  const rootOrderMap = new Map((snapshot.hierarchy?.rootOrder || []).map((id, idx) => [id, idx]));
  const ungrouped = [];
  for (const companion of companions) {
    const explicitId = typeof companion.groupId === 'string' ? companion.groupId.trim() : '';
    if (explicitId && nodes.has(explicitId)) {
      nodes.get(explicitId).companions.push(companion);
      continue;
    }
    const segments = companionPathSegments(companion, baseLookup);
    if (segments.length) {
      const targetId = ensureSyntheticPath(segments, explicitId || null);
      if (targetId && nodes.has(targetId)) {
        nodes.get(targetId).companions.push(companion);
        continue;
      }
    }
    if (explicitId) {
      const targetId = ensureSyntheticPath([explicitId], explicitId);
      nodes.get(targetId).companions.push(companion);
      continue;
    }
    ungrouped.push(companion);
  }
  const roots = [];
  for (const entry of nodes.values()) entry.children = [];
  for (const entry of nodes.values()) {
    if (entry.parentId && entry.parentId !== entry.id && nodes.has(entry.parentId)) {
      nodes.get(entry.parentId).children.push(entry);
    } else {
      roots.push(entry);
    }
  }
  const orderOf = (companion) => (typeof companion.groupOrder === 'number' && Number.isFinite(companion.groupOrder)
    ? companion.groupOrder
    : Number.MAX_SAFE_INTEGER);
  const sortCompanionsInFolder = (list) => list.sort((a, b) =>
    (orderOf(a) - orderOf(b)) || ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)));
  const sortUngrouped = (list) => list.sort((a, b) => {
    const rootA = rootOrderMap.has(a.id) ? rootOrderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rootB = rootOrderMap.has(b.id) ? rootOrderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
    return (rootA - rootB) || (orderOf(a) - orderOf(b)) || ((indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));
  });
  const sortFolders = (list) => list.sort((a, b) =>
    ((a.order ?? 0) - (b.order ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const visiting = new Set();
  const prune = (folderNode) => {
    if (visiting.has(folderNode.id)) return null;
    visiting.add(folderNode.id);
    sortCompanionsInFolder(folderNode.companions);
    sortFolders(folderNode.children);
    const keptChildren = [];
    for (const child of folderNode.children) {
      const prunedChild = prune(child);
      if (prunedChild) keptChildren.push(prunedChild);
    }
    visiting.delete(folderNode.id);
    const subtreeCompanions = [
      ...folderNode.companions,
      ...keptChildren.flatMap(child => child.subtreeCompanions),
    ];
    if (!subtreeCompanions.length) return null;
    return { ...folderNode, children: keptChildren, subtreeCompanions };
  };
  sortFolders(roots);
  const prunedRoots = [];
  for (const root of roots) {
    const pruned = prune(root);
    if (pruned) prunedRoots.push(pruned);
  }
  sortUngrouped(ungrouped);
  if (
    elements.scope?.value === 'wanjie' &&
    prunedRoots.length === 1 &&
    prunedRoots[0].name === '万界' &&
    prunedRoots[0].companions.length === 0 &&
    prunedRoots[0].children.length > 0 &&
    ungrouped.length === 0
  ) {
    return { roots: prunedRoots[0].children, ungrouped };
  }
  return { roots: prunedRoots, ungrouped };
}

function groupStatusBadges(companionsList) {
  const counts = [
    ['running', '运行中'],
    ['awaiting', '待处理'],
    ['error', '异常'],
    ['offline', '离线'],
  ];
  const badges = [];
  for (const [state, label] of counts) {
    const count = companionsList.filter(item => statusOf(item) === state).length;
    if (!count) continue;
    const badge = node('span', 'group-badge', `${label} ${count}`);
    badge.dataset.state = state;
    badges.push(badge);
  }
  return badges;
}

function renderCompanionCard(companion, folderLookup) {
  const card = node('button', 'companion');
  card.type = 'button';
  card.dataset.companionId = companion.id;
  card.setAttribute('aria-label', `${companion.name}，${statuses[statusOf(companion)] || '状态未知'}，查看详情`);
  const top = node('div', 'companion-top');
  top.append(node('h3', '', companion.name), statusLabel(companion));
  const pathText = companionPathLabel(companion, folderLookup);
  const activity = statusOf(companion) === 'offline' ? '主力电脑当前不可访问' : companion.activity?.summary || phases[companion.activity?.workingPhase] || (companion.interactions?.length ? `${companion.interactions.length} 项待处理` : '暂无正在执行的任务');
  const bottom = node('div', 'companion-bottom');
  bottom.append(node('span', '', deviceName(companion)), node('span', '', companion.lastReplyAt ? `回复 ${dateLabel(companion.lastReplyAt)}` : '暂无回复'));
  card.append(top);
  if (pathText) card.append(node('p', 'companion-path', pathText));
  card.append(node('p', 'companion-description', companion.description || '暂无职责说明'), node('p', 'companion-activity', activity), bottom);
  card.addEventListener('click', () => showDetails(companion));
  return card;
}

function renderGroupHeader(title, count, companionsList, collapseKey, activeFilter, extraClass = '', prefixBadge = null) {
  const collapsed = isGroupCollapsed(collapseKey, activeFilter);
  const header = node('button', `group-header${extraClass ? ` ${extraClass}` : ''}`);
  header.type = 'button';
  header.dataset.groupToggle = collapseKey;
  header.setAttribute('aria-expanded', String(!collapsed));
  const left = node('span', 'group-heading');
  const chevron = node('span', 'group-chevron', '▾');
  chevron.setAttribute('aria-hidden', 'true');
  left.append(chevron);
  if (prefixBadge) left.append(prefixBadge);
  left.append(node('span', 'group-title', title), node('span', 'group-count', `${count}`));
  const right = node('span', 'group-badges');
  right.append(...groupStatusBadges(companionsList));
  header.append(left, right);
  header.addEventListener('click', () => toggleGroup(collapseKey, activeFilter));
  return { header, collapsed };
}

function renderFolderNodeList(tree, keyPrefix, depth, activeFilter, folderLookup) {
  const container = node('div', depth === 0 ? 'folder-tree' : 'folder-children');
  const appendFolderSection = (folderNode, isUngrouped = false) => {
    const collapseKey = isUngrouped ? `${keyPrefix}ungrouped` : `${keyPrefix}folder:${folderNode.id}`;
    renderedGroupKeys.push(collapseKey);
    const items = isUngrouped ? folderNode.companions : folderNode.subtreeCompanions;
    const section = node('section', `folder-node${isUngrouped ? ' is-ungrouped' : ''}`);
    section.dataset.depth = String(depth);
    if (!isUngrouped) section.dataset.folderId = folderNode.id;
    const { header, collapsed } = renderGroupHeader(folderNode.name, items.length, items, collapseKey, activeFilter);
    section.append(header);
    if (!collapsed) {
      const body = node('div', 'folder-body');
      if (folderNode.companions.length) {
        const grid = node('div', 'roster-grid');
        grid.append(...folderNode.companions.map(item => renderCompanionCard(item, folderLookup)));
        body.append(grid);
      }
      if (!isUngrouped && folderNode.children.length) {
        body.append(renderFolderNodeList({ roots: folderNode.children, ungrouped: [] }, keyPrefix, depth + 1, activeFilter, folderLookup));
      }
      section.append(body);
    }
    container.append(section);
  };
  for (const root of tree.roots) appendFolderSection(root, false);
  if (tree.ungrouped.length) {
    appendFolderSection({ id: '__ungrouped__', name: '未分组', companions: tree.ungrouped, children: [], subtreeCompanions: tree.ungrouped }, true);
  }
  return container;
}

function renderComputerGroups(visible, hasAnyFolder, activeFilter, folderLookup) {
  const byDevice = new Map();
  for (const companion of visible) {
    const name = deviceName(companion);
    if (!byDevice.has(name)) {
      byDevice.set(name, { name, isSelf: false, online: false, items: [] });
    }
    const bucket = byDevice.get(name);
    if (companion.home?.isSelf) bucket.isSelf = true;
    if (companion.home?.online !== false) bucket.online = true;
    bucket.items.push(companion);
  }
  const buckets = [...byDevice.values()].sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    if ((a.name === '电脑未知') !== (b.name === '电脑未知')) return a.name === '电脑未知' ? 1 : -1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const container = node('div', 'device-groups');
  for (const bucket of buckets) {
    const deviceKey = `device:${bucket.name}`;
    renderedGroupKeys.push(deviceKey);
    const badgeText = bucket.isSelf ? '本机' : bucket.online ? '在线' : '离线';
    const badge = node('span', 'device-badge', badgeText);
    badge.dataset.state = bucket.isSelf ? 'self' : bucket.online ? 'online' : 'offline';
    const section = node('section', 'device-group');
    section.dataset.deviceName = bucket.name;
    const { header, collapsed } = renderGroupHeader(bucket.name, bucket.items.length, bucket.items, deviceKey, activeFilter, 'is-device', badge);
    section.append(header);
    if (!collapsed) {
      const body = node('div', 'device-group-body');
      if (hasAnyFolder) {
        const tree = buildVisibleFolderTree(bucket.items, folderLookup);
        body.append(renderFolderNodeList(tree, `${deviceKey}::`, 0, activeFilter, folderLookup));
      } else {
        const grid = node('div', 'roster-grid');
        grid.append(...bucket.items.map(item => renderCompanionCard(item, folderLookup)));
        body.append(grid);
      }
      section.append(body);
    }
    container.append(section);
  }
  return container;
}

function renderRoster(companions, folderLookup) {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const activeFilter = hasRosterFilter();
  const visible = companions.filter(companion =>
    (selectedFilter === 'all' || statusOf(companion) === selectedFilter)
    && (elements.device.value === 'all' || deviceName(companion) === elements.device.value)
    && `${companion.name} ${companion.description || ''} ${companionPathLabel(companion, folderLookup)} ${deviceName(companion)}`.toLocaleLowerCase().includes(query));
  elements['roster-count'].textContent = receivedState ? `${visible.length} / ${companions.length}` : '';
  elements['group-by-computer'].setAttribute('aria-pressed', String(viewPrefs.groupByComputer));
  elements['compact-mode'].setAttribute('aria-pressed', String(viewPrefs.compactMode));
  elements.roster.classList.toggle('is-compact', viewPrefs.compactMode);
  renderedGroupKeys = [];
  if (!visible.length) {
    elements['expand-all'].disabled = true;
    elements['collapse-all'].disabled = true;
    elements.roster.replaceChildren(node('p', 'empty', receivedState ? '没有符合筛选条件的伙伴。' : '正在读取伙伴状态…'));
    return;
  }
  const hasAnyFolder = folderLookup.size > 0 || companions.some(item => Boolean(item.groupId) || (Array.isArray(item.groupPath) && item.groupPath.length > 0));
  if (viewPrefs.groupByComputer) {
    elements.roster.replaceChildren(renderComputerGroups(visible, hasAnyFolder, activeFilter, folderLookup));
  } else if (hasAnyFolder) {
    const tree = buildVisibleFolderTree(visible, folderLookup);
    elements.roster.replaceChildren(renderFolderNodeList(tree, '', 0, activeFilter, folderLookup));
  } else {
    const grid = node('div', 'roster-grid');
    grid.append(...visible.map(companion => renderCompanionCard(companion, folderLookup)));
    elements.roster.replaceChildren(grid);
  }
  const hasCollapsible = renderedGroupKeys.length > 0;
  const anyCollapsed = renderedGroupKeys.some(key => isGroupCollapsed(key, activeFilter));
  const anyExpanded = renderedGroupKeys.some(key => !isGroupCollapsed(key, activeFilter));
  elements['expand-all'].disabled = !hasCollapsible || !anyCollapsed;
  elements['collapse-all'].disabled = !hasCollapsible || !anyExpanded;
}

function renderVerification() {
  const verification = snapshot.verification;
  const merged = new Map((snapshot.run?.results || []).map(item => [item.companionId, item]));
  for (const result of verification?.results || []) {
    const current = merged.get(result.companionId);
    if (!current || result.status === 'passed'
        || Date.parse(result.checkedAt) >= Date.parse(current.checkedAt)) merged.set(result.companionId, result);
  }
  const results = [...merged.values()];
  elements.verify.disabled = !receivedState || Boolean(snapshot.run?.running);
  elements.verify.textContent = snapshot.run?.running ? '逐岗验证中' : '接续逐岗验证';
  const awaitingEvidence = (snapshot.run?.results || []).filter(item => item.awaitingEvidence).length;
  elements['verification-run'].textContent = snapshot.run?.error || (snapshot.run?.running
    ? `正在经 Cindy 委派验证，${awaitingEvidence} 岗等待核对执行证据。`
    : snapshot.run?.completedAt ? '本轮委派已结束，最终结论以文件读取与岗位回复核验为准。' : '');
  elements['verification-time'].textContent = verification?.checkedAt ? `更新于 ${dateLabel(verification.checkedAt, true)}` : '';
  if (!results.length) {
    elements['verification-summary'].textContent = '尚未收到本轮逐岗验证结果。';
    elements['verification-results'].replaceChildren();
    return;
  }
  const counts = Object.keys(verificationLabels).map(status => `${verificationLabels[status]} ${results.filter(item => item.status === status).length}`);
  elements['verification-summary'].textContent = counts.join(' · ');
  elements['verification-results'].replaceChildren(...results.map(result => {
    const row = node('div', 'verification-row');
    const detail = node('details', 'verification-text');
    const identity = result.companionId || result.name;
    detail.open = expandedVerifications.has(identity);
    detail.addEventListener('toggle', () => {
      if (detail.open) expandedVerifications.add(identity);
      else expandedVerifications.delete(identity);
    });
    detail.append(node('summary', '', result.name || '未命名伙伴'), node('p', '', result.summary || '尚无验证说明'));
    row.append(detail, node('span', 'verification-label', verificationLabels[result.status] || '待验证'));
    return row;
  }));
}

function renderDevices() {
  if (!Array.isArray(snapshot.devices) || !snapshot.devices.length) {
    elements.devices.replaceChildren(node('p', 'empty', '尚未载入电脑配置。'));
    return;
  }
  elements.devices.replaceChildren(...snapshot.devices.map(device => {
    const card = node('article', 'device');
    const top = node('div', 'device-top');
    top.append(node('h3', '', device.name || '未命名电脑'), node('span', 'secondary', device.role || ''));
    const specification = node('dl');
    for (const [label, value] of [['CPU', device.cpu], ['内存', device.memoryGiB ? `${device.memoryGiB} GiB` : null], ['GPU', device.gpu], ['地址', device.ip]]) {
      specification.append(node('dt', '', label), node('dd', '', value || '尚未采集'));
    }
    card.append(top, specification, node('p', 'device-note', `采集时间 ${dateLabel(device.checkedAt, true)}`));
    return card;
  }));
}

function render() {
  const focused = document.activeElement;
  const focusFilter = focused?.dataset.filter;
  const focusCompanion = focused?.dataset.companionId;
  const focusGroupToggle = focused?.dataset.groupToggle;
  const companions = scopedCompanions();
  const folderLookup = buildFolderLookup();
  renderSummary(companions);
  renderFilters(companions);
  renderRoster(companions, folderLookup);
  renderTaskFlow(companions, folderLookup);
  renderVerification();
  renderDevices();
  if (focusFilter) elements.filters.querySelector(`[data-filter="${CSS.escape(focusFilter)}"]`)?.focus({ preventScroll: true });
  if (focusCompanion) elements.roster.querySelector(`[data-companion-id="${CSS.escape(focusCompanion)}"]`)?.focus({ preventScroll: true });
  if (focusGroupToggle) elements.roster.querySelector(`[data-group-toggle="${CSS.escape(focusGroupToggle)}"]`)?.focus({ preventScroll: true });
}

function showDetails(companion) {
  selectedCompanion = companion;
  elements['detail-title'].textContent = companion.name;
  elements['detail-meta'].textContent = formatDetailMeta(companion, buildFolderLookup());
  elements['detail-content'].replaceChildren(node('p', 'secondary', '正在读取最近回复与消息…'));
  elements['open-status'].textContent = '';
  elements['open-companion'].disabled = statusOf(companion) === 'offline';
  if (!elements.details.open) elements.details.showModal();
  clearTimeout(detailTimer);
  pendingDetailId = request('details', companion.id);
  detailTimer = setTimeout(() => {
    elements['detail-content'].replaceChildren(node('p', '', '读取超时，请关闭详情后重试。'));
    pendingDetailId = null;
  }, 15000);
}

function renderDetails(message) {
  if (message.requestId !== pendingDetailId || message.companionId !== selectedCompanion?.id) return;
  clearTimeout(detailTimer);
  pendingDetailId = null;
  const content = elements['detail-content'];
  content.replaceChildren();
  if (message.error) content.append(node('p', '', message.error));
  const reply = message.reply?.reply === undefined ? message.reply : message.reply.reply;
  const history = message.history?.history === undefined ? message.history : message.history.history;
  const latest = node('section');
  latest.append(node('h3', '', '最近回复'), node('p', 'reply-text', reply?.text || (message.replyError ? '最近回复暂时无法读取。' : '暂无已完成的回复。')));
  if (reply?.createdAt) latest.append(node('p', 'secondary', `${dateLabel(reply.createdAt, true)}${reply.truncated ? ' · 内容已截取，完整回复可在 Cindy 中查看' : ''}`));
  const messages = node('section');
  messages.append(node('h3', '', '最近消息'));
  for (const item of history?.messages || []) {
    const entry = node('article', 'history-message');
    entry.append(node('p', 'history-meta', `${item.role === 'user' ? '主人' : selectedCompanion.name} · ${dateLabel(item.createdAt, true)}`), node('p', 'history-text', item.text || ''));
    if (item.truncated) entry.append(node('p', 'secondary', '内容已截取'));
    messages.append(entry);
  }
  if (!history?.messages?.length) messages.append(node('p', 'secondary', message.historyError ? '最近消息暂时无法读取。' : '暂无可读取的消息。'));
  if (history?.more) messages.append(node('p', 'secondary', '更早的消息可在 Cindy 中查看。'));
  content.append(latest, messages);
}

channel.addEventListener('message', ({ data }) => {
  if (!data || data.source !== 'logic') return;
  if (data.type === 'state') {
    clearTimeout(refreshTimer);
    receivedState = true;
    snapshot = {
      companions: Array.isArray(data.companions) ? data.companions : [],
      folders: Array.isArray(data.folders) ? data.folders : (Array.isArray(data.hierarchy?.folders) ? data.hierarchy.folders : []),
      hierarchy: data.hierarchy || null,
      taskFlow: data.taskFlow && typeof data.taskFlow === 'object' ? data.taskFlow : null,
      verification: data.verification,
      devices: data.devices,
      run: data.run,
      observedAt: data.observedAt,
      error: data.error,
    };
    elements.refresh.disabled = false;
    elements['updated-at'].textContent = data.observedAt ? `状态更新于 ${dateLabel(data.observedAt)} · Cindy 实时状态` : 'Cindy 状态尚未就绪';
    showNotice(data.error);
    renderDeviceFilter();
    render();
    if (selectedCompanion && elements.details.open) {
      selectedCompanion = snapshot.companions.find(item => item.id === selectedCompanion.id) || selectedCompanion;
      elements['detail-meta'].textContent = formatDetailMeta(selectedCompanion, buildFolderLookup());
      elements['open-companion'].disabled = Boolean(pendingOpenId) || statusOf(selectedCompanion) === 'offline';
    }
  } else if (data.type === 'details') renderDetails(data);
  else if (data.type === 'opened' && data.requestId === pendingOpenId) {
    clearTimeout(openTimer);
    pendingOpenId = null;
    elements['open-companion'].disabled = statusOf(selectedCompanion) === 'offline';
    elements['open-status'].textContent = data.error || '已在 Cindy 中打开';
    if (!data.error) elements.details.close();
  }
});

async function refresh() {
  clearTimeout(refreshTimer);
  elements.refresh.disabled = true;
  try {
    const response = await fetch('/wake');
    if (!response.ok) throw new Error('插件尚未唤醒，请在 Cindy 插件设置中检查状态。');
    request('refresh');
    let attempts = 0;
    refreshTimer = setInterval(() => {
      attempts += 1;
      if (attempts >= 12) {
        clearInterval(refreshTimer);
        elements.refresh.disabled = false;
        showNotice('暂未收到 Cindy 状态，请稍后刷新或检查插件权限。');
        return;
      }
      request('refresh');
    }, 700);
  } catch (error) {
    elements.refresh.disabled = false;
    showNotice(error.message || '连接 Cindy 失败，请重试。');
  }
}

elements.refresh.addEventListener('click', refresh);
elements.verify.addEventListener('click', () => {
  elements.verify.disabled = true;
  elements['verification-run'].textContent = '正在准备伙伴委派…';
  request('verify');
});
elements.search.addEventListener('input', () => { temporaryGroupOverrides.clear(); render(); });
elements.scope.addEventListener('change', () => { selectedFilter = 'all'; temporaryGroupOverrides.clear(); renderDeviceFilter(); render(); });
elements.device.addEventListener('change', () => { temporaryGroupOverrides.clear(); render(); });
elements['group-by-computer'].addEventListener('click', () => {
  viewPrefs.groupByComputer = !viewPrefs.groupByComputer;
  saveViewPrefs();
  render();
});
elements['compact-mode'].addEventListener('click', () => {
  viewPrefs.compactMode = !viewPrefs.compactMode;
  saveViewPrefs();
  render();
});
elements['expand-all'].addEventListener('click', () => {
  const activeFilter = hasRosterFilter();
  for (const key of renderedGroupKeys) {
    if (activeFilter) temporaryGroupOverrides.set(key, false);
    else viewPrefs.collapsed.delete(key);
  }
  if (!activeFilter) saveViewPrefs();
  render();
});
elements['collapse-all'].addEventListener('click', () => {
  const activeFilter = hasRosterFilter();
  for (const key of renderedGroupKeys) {
    if (activeFilter) temporaryGroupOverrides.set(key, true);
    else viewPrefs.collapsed.add(key);
  }
  if (!activeFilter) saveViewPrefs();
  render();
});
elements['close-details'].addEventListener('click', () => elements.details.close());
elements.details.addEventListener('close', () => { clearTimeout(detailTimer); pendingDetailId = null; });
elements['open-companion'].addEventListener('click', () => {
  if (!selectedCompanion || pendingOpenId) return;
  elements['open-companion'].disabled = true;
  elements['open-status'].textContent = '正在打开…';
  pendingOpenId = request('open', selectedCompanion.id);
  openTimer = setTimeout(() => {
    pendingOpenId = null;
    elements['open-companion'].disabled = false;
    elements['open-status'].textContent = '打开超时，请重试。';
  }, 15000);
});
let scrollTimer;
document.addEventListener('scroll', () => {
  document.documentElement.classList.add('is-scrolling');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => document.documentElement.classList.remove('is-scrolling'), 2000);
}, true);
window.addEventListener('pagehide', () => {
  clearInterval(refreshTimer);
  clearTimeout(detailTimer);
  clearTimeout(openTimer);
  clearTimeout(scrollTimer);
  channel.close();
});
render();
refresh();
