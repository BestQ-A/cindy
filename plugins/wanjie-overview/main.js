const channel = new BroadcastChannel('wanjie-overview-v1');
const verificationStatuses = new Set(['passed', 'failed', 'blocked', 'pending']);
let state = { companions: [], folders: [], hierarchy: null, observedAt: null, verification: null, devices: [], run: null, error: null };
let roster = [];
let subscriptionId = null;
let refreshPromise = null;
let saveQueue = Promise.resolve();
let savedData = {};
let controller;
let controllerPromise;
let ready;

function enqueueSave(operation) {
  const pending = saveQueue.then(operation);
  saveQueue = pending.catch(() => {});
  return pending;
}

async function persist(patch) {
  const next = { ...savedData, ...patch };
  const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  if (!response.ok) throw new Error(`保存大屏状态失败（${response.status}）。`);
  savedData = next;
}

async function getController() {
  if (controller) return controller;
  if (!controllerPromise) controllerPromise = (async () => {
    const { createVerificationController } = await import('./verification-controller.js');
    const existing = new Map((savedData.verificationRun?.results || []).map(item => [item.companionId, item]));
    for (const item of state.verification?.results || []) {
      if (!existing.has(item.companionId) || item.status === 'passed') {
        existing.set(item.companionId, { ...existing.get(item.companionId), ...item });
      }
    }
    controller = createVerificationController({
      cindy, roster, existingResults: [...existing.values()],
      onProgress: run => { state = { ...state, run }; publish(); },
      saveResults: results => enqueueSave(() => persist({
        verificationRun: { ...controller.status(), results },
      })),
    });
    return controller;
  })().catch(error => { controllerPromise = null; throw error; });
  return controllerPromise;
}

async function startVerification() {
  const current = await getController();
  return current.start();
}

function publish(extra = {}) {
  channel.postMessage({ source: 'logic', type: 'state', ...state, ...extra });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildFolderTree(folders) {
  const childrenMap = new Map();
  const idSet = new Set(folders.map(item => item.id));
  for (const folder of folders) {
    const key = folder.parentId && idSet.has(folder.parentId) ? folder.parentId : null;
    const list = childrenMap.get(key) || [];
    list.push(folder);
    childrenMap.set(key, list);
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  }
  const visit = (parentId) => (childrenMap.get(parentId) || []).map(folder => ({
    ...folder,
    children: visit(folder.id),
  }));
  return visit(null);
}

function normalizeHierarchy(rawHierarchy, rawFolders) {
  const sourceFolders = Array.isArray(rawFolders)
    ? rawFolders
    : Array.isArray(rawHierarchy?.folders)
      ? rawHierarchy.folders
      : [];
  const byId = new Map();
  for (const item of sourceFolders) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!id || !name) continue;
    const parentId = typeof item.parentId === 'string' && item.parentId.trim() ? item.parentId.trim() : null;
    const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : 0;
    const depth = typeof item.depth === 'number' && Number.isFinite(item.depth) ? item.depth : 1;
    const path = Array.isArray(item.path) ? item.path.filter(seg => typeof seg === 'string' && seg) : [];
    byId.set(id, { id, name, parentId, depth, order, path });
  }
  const folders = [...byId.values()].map(folder => {
    if (folder.path.length) return folder;
    const chain = [];
    const seen = new Set();
    let curr = folder;
    while (curr && !seen.has(curr.id)) {
      seen.add(curr.id);
      chain.unshift(curr.name);
      curr = curr.parentId ? byId.get(curr.parentId) : null;
    }
    return { ...folder, depth: chain.length || 1, path: chain };
  });
  const rootOrder = Array.isArray(rawHierarchy?.rootOrder)
    ? rawHierarchy.rootOrder.filter(id => typeof id === 'string' && id)
    : [];
  const tree = Array.isArray(rawHierarchy?.tree) && rawHierarchy.tree.length
    ? rawHierarchy.tree
    : buildFolderTree(folders);
  return {
    folders,
    tree,
    rootOrder,
    ...(typeof rawHierarchy?.updatedAt === 'number' ? { updatedAt: rawHierarchy.updatedAt } : {}),
  };
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      if (typeof cindy.companions?.list !== 'function') {
        throw new Error('当前 Cindy 未提供伙伴查看接口，请使用支持此能力的版本。');
      }
      const result = await cindy.companions.list();
      const companions = Array.isArray(result?.companions) ? result.companions : [];
      const hierarchy = normalizeHierarchy(result?.hierarchy, result?.folders);
      state = {
        ...state,
        companions,
        folders: hierarchy.folders,
        hierarchy,
        observedAt: result?.observedAt ?? null,
        error: null,
      };
      if (!subscriptionId) ({ subscriptionId } = await cindy.companions.watch());
    } catch (error) {
      // The host drops watches when permission or the active account changes.
      subscriptionId = null;
      state = { ...state, error: errorText(error) };
    }
    publish();
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function findCompanion(id) {
  if (typeof id !== 'string') throw new Error('缺少伙伴编号。');
  const companion = state.companions.find(item => item.id === id);
  if (!companion) throw new Error('伙伴当前不可见，请刷新后重试。');
  return companion;
}

async function handleView(message) {
  if (message?.source !== 'view') return;
  await ready;
  const { requestId, action, companionId } = message;
  try {
    if (action === 'refresh') {
      await refresh();
    } else if (action === 'verify') {
      await startVerification();
      publish();
    } else if (action === 'details') {
      findCompanion(companionId);
      const results = await Promise.allSettled([
        cindy.companions.reply({ companionId }),
        cindy.companions.history({ companionId, limit: 20 }),
      ]);
      const [reply, history] = results;
      channel.postMessage({
        source: 'logic', type: 'details', requestId, companionId,
        reply: reply.status === 'fulfilled' ? reply.value.reply : null,
        history: history.status === 'fulfilled' ? history.value.history : null,
        replyError: reply.status === 'rejected' ? errorText(reply.reason) : null,
        historyError: history.status === 'rejected' ? errorText(history.reason) : null,
        error: results.filter(item => item.status === 'rejected').map(item => errorText(item.reason)).join('；') || null,
      });
    } else if (action === 'open') {
      findCompanion(companionId);
      await cindy.companions.open({ companionId });
      channel.postMessage({ source: 'logic', type: 'opened', requestId, error: null });
    }
  } catch (error) {
    if (action === 'verify') {
      state = { ...state, run: { ...state.run, running: false, error: errorText(error) } };
      publish();
      return;
    }
    channel.postMessage({
      source: 'logic', type: action === 'details' ? 'details' : 'opened',
      requestId, companionId, error: errorText(error),
    });
  }
}

function validateVerification(args) {
  if (!args || typeof args.checkedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T/.test(args.checkedAt) || !Number.isFinite(Date.parse(args.checkedAt))) {
    throw new Error('checkedAt 必须是有效的 ISO 8601 时间。');
  }
  if (!Array.isArray(args.results) || !args.results.length || args.results.length > 100) {
    throw new Error('results 需要包含 1 至 100 个岗位结果。');
  }
  const known = new Map([...roster, ...state.companions].map(item => [item.id, item.name]));
  const seen = new Set();
  return args.results.map(item => {
    if (!item || !known.has(item.companionId)) throw new Error('结果包含未知伙伴编号。');
    if (seen.has(item.companionId)) throw new Error('同一次提交包含重复伙伴。');
    if (!verificationStatuses.has(item.status)) throw new Error('验收状态不正确。');
    if (typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 1000) {
      throw new Error('每个岗位需要 1 至 1000 字的验收摘要。');
    }
    seen.add(item.companionId);
    return {
      companionId: item.companionId, name: known.get(item.companionId),
      status: item.status, summary: item.summary.trim(), checkedAt: args.checkedAt,
    };
  });
}

async function recordVerification(args) {
  const incoming = validateVerification(args);
  const records = new Map((state.verification?.results || []).map(item => [item.companionId, item]));
  for (const item of incoming) {
    const previous = records.get(item.companionId);
    if (previous && Date.parse(previous.checkedAt) > Date.parse(item.checkedAt)) {
      throw new Error('验收时间早于已保存结果，请检查来源。');
    }
    records.set(item.companionId, item);
  }
  const checkedAt = Date.parse(state.verification?.checkedAt) > Date.parse(args.checkedAt)
    ? state.verification.checkedAt : args.checkedAt;
  const verification = { checkedAt, results: [...records.values()] };
  await persist({ verification });
  state = { ...state, verification };
  controller?.acceptResults(incoming);
  publish();
  return { saved: incoming.length, total: verification.results.length };
}

function toolResult(callId, result, error) {
  if (error) {
    cindy.send({
      type: 'tool-result', callId, ok: false, errorCode: 'DASHBOARD_OPERATION_FAILED',
      message: `${error} 请检查参数或伙伴状态后重试。`,
    });
    return;
  }
  cindy.send({
    type: 'tool-result', callId, ok: true,
    result: {
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    },
  });
}

async function handleTool(message) {
  await ready;
  try {
    if (message.tool === 'get_status') {
      await refresh();
      toolResult(message.callId, state);
    } else if (message.tool === 'start_verification') {
      toolResult(message.callId, await startVerification());
    } else if (message.tool === 'retry_verification') {
      const companionId = message.args?.companionId;
      const evidence = state.verification?.results.find(item => item.companionId === companionId);
      const current = await getController();
      toolResult(message.callId, await current.retry(companionId, evidence));
    } else if (message.tool === 'record_verification') {
      const operation = enqueueSave(() => recordVerification(message.args));
      toolResult(message.callId, await operation);
    }
  } catch (error) {
    toolResult(message.callId, null, errorText(error));
  }
}

channel.onmessage = event => { void handleView(event.data); };
cindy.onHostMessage(message => {
  if (message.type === 'companions-changed' && message.subscriptionId === subscriptionId) void refresh();
  if (message.type === 'tool-call') void handleTool(message);
});

ready = (async () => {
  try {
    const [bootstrapResponse, savedResponse] = await Promise.all([fetch('/bootstrap.json'), fetch('/kv')]);
    if (!bootstrapResponse.ok || !savedResponse.ok) throw new Error('团队大屏配置读取失败。');
    const bootstrap = await bootstrapResponse.json();
    const saved = await savedResponse.json();
    savedData = saved;
    roster = bootstrap.roster;
    state = {
      ...state, devices: bootstrap.devices, verification: saved.verification || bootstrap.verification,
      run: saved.verificationRun ? { ...saved.verificationRun, running: false } : null,
    };
    await refresh();
  } catch (error) {
    state = { ...state, error: errorText(error) };
    publish();
  }
})();
