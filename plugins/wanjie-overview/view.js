/* The view receives host-owned snapshots from the plugin logic over its private origin. */
const channel = new BroadcastChannel('wanjie-overview-v1');
const elements = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id, element]));
const STORAGE_KEY = 'wanjie-overview:view-prefs:v1';
const statuses = { running: '运行中', awaiting: '待处理', error: '异常', done: '已完成', unread: '未读', idle: '空闲', offline: '离线' };
const verificationLabels = { passed: '通过', failed: '失败', blocked: '受阻', pending: '待验证' };
const phases = { thinking: '正在思考', replying: '正在回复', 'reading-file': '正在读文件', 'saving-file': '正在保存', searching: '正在搜索', 'searching-files': '正在查找文件', 'reading-web': '正在阅读网页', testing: '正在测试', checking: '正在检查', compacting: '正在整理上下文', processing: '正在处理' };
let snapshot = { companions: [], folders: [], hierarchy: null, verification: null, devices: [], run: null, observedAt: null, error: null };
let receivedState = false;
let selectedFilter = 'all';
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
