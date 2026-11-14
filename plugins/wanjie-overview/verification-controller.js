const SOURCE_FILE = 'E:/02_Skylar/000_learning_space/6_wechat_game/wanjie-2d/design/06_production/team_m0.md';
const APPROVAL_ERRORS = new Set(['PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY', 'TARGET_UNAVAILABLE']);
const RECORD_FIELDS = [
  'companionId', 'name', 'status', 'summary', 'checkedAt', 'requestKey', 'attempt',
  'executionId', 'taskId', 'deliveryStatus', 'settled', 'outcome', 'outputMessageId',
  'instanceId', 'generation', 'awaitingEvidence', 'errorCode', 'source',
  'priorRequestKey', 'priorOutputMessageId', 'retryReason',
];

function recordMetadata(result) {
  return Object.fromEntries(RECORD_FIELDS.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}

export function createVerificationController({
  cindy, roster, existingResults = [], onProgress = () => {}, saveResults = async () => {},
  pollIntervalMs = 3000, timeoutMs = 300000, runId = 'role-smoke-20261114-plugin-v1',
}) {
  if (!Array.isArray(roster) || !roster.length || roster.length > 100
      || !roster.every(item => typeof item.id === 'string' && item.id && typeof item.name === 'string')
      || new Set(roster.map(item => item.id)).size !== roster.length) {
    throw new Error('验收名单必须包含互不重复的伙伴编号和名称。');
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId) || roster.some(item => item.id.length > 80)) {
    throw new Error('验收批次或伙伴编号格式不正确。');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('验收轮询时间不正确。');

  const records = new Map(existingResults.map(item => [item.companionId, recordMetadata(item)]));
  let running = false;
  let lastError = null;
  let startedAt = null;
  let completedAt = null;
  let startPromise = null;
  let batchPromise = Promise.resolve();
  let saveQueue = Promise.resolve();
  let stopDispatch = false;
  const sleep = () => new Promise(resolve => setTimeout(resolve, pollIntervalMs));

  function status() {
    const results = roster.map(item => ({
      companionId: item.id, name: item.name, status: 'pending', summary: '等待派发。',
      ...records.get(item.id),
    }));
    return { runId, running, startedAt, completedAt, error: lastError, results };
  }

  function publish() { onProgress(status()); }

  async function record(companion, fields) {
    if (records.get(companion.id)?.status === 'passed' && fields.status !== 'passed') return;
    records.set(companion.id, {
      ...records.get(companion.id), companionId: companion.id, name: companion.name,
      source: 'cindy-plugin-delegation', ...fields, checkedAt: new Date().toISOString(),
    });
    const snapshot = status();
    const saving = saveQueue.then(() => saveResults(snapshot.results));
    saveQueue = saving.catch(() => {});
    await saving;
    publish();
  }

  function message(companion, requestKey) {
    return [
      `请对你当前岗位「${companion.name}」完成一次只读运行验收。验收标记：${requestKey}。`,
      '先读取本岗位已有身份资料，确认你自己的 profile 与职责。',
      `再用只读文件工具实际读取 ${SOURCE_FILE} 中与你的岗位对应的原文行。`,
      '回复验收标记、岗位名、profile、该行职责、评审人、文件行号，以及一小段原文。',
      '如没有对应行或读取失败，明确报告原因。请勿仅根据聊天内容推测文件内容。',
      '仅使用现有模型、目录与权限。不要修改文件、配置、模型或权限，不要联网，不要启动旧 Hermes，不要发送飞书或其他外部消息。',
    ].join('\n');
  }

  function receiptFields(receipt) {
    return {
      executionId: receipt.executionId, taskId: receipt.taskId,
      deliveryStatus: receipt.status, settled: receipt.settled === true,
      outcome: receipt.result?.outcome, outputMessageId: receipt.result?.outputMessageId,
      instanceId: receipt.result?.instanceId, generation: receipt.result?.generation,
    };
  }

  function validateReceipt(receipt, companion, requestKey) {
    if (!receipt.found) return;
    if (receipt.requestKey !== requestKey || receipt.target?.kind !== 'bot'
        || receipt.target.id !== companion.id) throw new Error('宿主回执与本次伙伴验收不匹配。');
  }

  async function poll(companion, requestKey) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await cindy.targets.get({ requestKey });
      validateReceipt(receipt, companion, requestKey);
      if (receipt.found && receipt.settled === true) return receipt;
      await sleep();
    }
    return null;
  }

  async function execute(companion) {
    const previous = records.get(companion.id);
    if (previous?.status === 'passed' || previous?.awaitingEvidence) return;
    let attempt = previous?.attempt === 2 ? 2 : 1;
    while (attempt <= 2 && !stopDispatch) {
      if (records.get(companion.id)?.status === 'passed') return;
      const requestKey = previous?.requestKey && previous.attempt === attempt
        ? previous.requestKey : `${runId}:${companion.id}:attempt-${attempt}`;
      const task = message(companion, requestKey);
      await record(companion, { status: 'pending', summary: '正在核对派发回执。', requestKey, attempt });
      try {
        let receipt = await cindy.targets.get({ requestKey });
        validateReceipt(receipt, companion, requestKey);
        if (stopDispatch || records.get(companion.id)?.status === 'passed') return;
        if (!receipt.found) {
          const accepted = await cindy.targets.send({
            requestKey, target: { kind: 'bot', id: companion.id },
            text: task, delivery: 'queue', delegation: { task },
          });
          await record(companion, {
            status: 'pending', summary: '已派发，等待原输入执行完成。',
            executionId: accepted.executionId, taskId: accepted.taskId,
          });
          receipt = await poll(companion, requestKey);
        } else if (!receipt.settled) receipt = await poll(companion, requestKey);

        if (!receipt) {
          stopDispatch = true;
          lastError = '原派发尚未确认结束，已暂停新增派发；再次启动先查询原回执。';
          await record(companion, { status: 'blocked', summary: '等待超时，原派发结果尚未确认；再次启动会查询同一回执。' });
          return;
        }
        if (records.get(companion.id)?.status === 'passed') return;
        const fields = receiptFields(receipt);
        if (fields.outcome === 'completed') {
          await record(companion, {
            ...fields, status: 'pending', awaitingEvidence: true,
            summary: '宿主确认原输入已执行完成，等待核对真实文件工具与岗位回复。',
          });
          return;
        }
        if (fields.outcome === 'failed' && attempt === 1) {
          await record(companion, { ...fields, status: 'pending', summary: '原输入已确认失败，准备一次只读重试。' });
          attempt++;
          continue;
        }
        const summary = fields.outcome === 'failed' ? '两次执行均失败，需核查模型或工具错误。'
          : fields.outcome === 'cancelled' ? '该输入已取消，保持停止。'
          : fields.outcome === 'interrupted' ? '该输入已中断，保持停止。' : '回执缺少可判定的执行终态。';
        await record(companion, { ...fields, status: fields.outcome === 'failed' ? 'failed' : 'blocked', summary });
        return;
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : null;
        if (code === 'PERMISSION_DENIED' || code === 'UNSUPPORTED_CAPABILITY') {
          stopDispatch = true;
          lastError = '伙伴委派权限或能力不可用，已停止继续派发。';
        } else if (!APPROVAL_ERRORS.has(code)) {
          stopDispatch = true;
          lastError = '派发或查询结果未确认，已暂停新增派发；再次启动先查询原回执。';
        }
        const summary = APPROVAL_ERRORS.has(code)
          ? '伙伴委派权限或目标当前不可用，需在 Cindy 中核查。'
          : '本次派发或回执查询失败；保留请求编号，再次启动先核对原回执。';
        await record(companion, { status: 'blocked', summary, errorCode: code });
        return;
      }
    }
  }

  async function run(selectedRoster = roster) {
    let next = 0;
    async function worker() {
      while (next < selectedRoster.length && !stopDispatch) {
        const companion = selectedRoster[next++];
        try {
          await execute(companion);
        } catch (error) {
          stopDispatch = true;
          throw error;
        }
      }
    }
    const workers = await Promise.allSettled([worker(), worker()]);
    if (workers.some(result => result.status === 'rejected')) {
      lastError = '验收进度保存失败，已停止继续派发。请恢复存储后查询原回执。';
    }
    running = false;
    completedAt = new Date().toISOString();
    publish();
  }

  async function start() {
    if (running) return status();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      if (typeof cindy.targets?.capabilities !== 'function') throw new Error('当前 Cindy 不支持伙伴委派。');
      const { delegation } = await cindy.targets.capabilities({});
      if (!delegation?.execution || !delegation.receiptQuery || !delegation.settled) {
        throw new Error('当前 Cindy 缺少完整的伙伴委派及执行回执能力。');
      }
      running = true;
      stopDispatch = false;
      lastError = null;
      startedAt = new Date().toISOString();
      completedAt = null;
      publish();
      batchPromise = run();
      return status();
    })();
    try { return await startPromise; } finally { startPromise = null; }
  }

  async function retry(companionId, evidence) {
    if (running || startPromise) throw new Error('当前验收仍在运行，请等待本轮结束。');
    const companion = roster.find(item => item.id === companionId);
    const previous = records.get(companionId);
    if (!companion || !previous?.requestKey || previous.attempt !== 1 || previous.status === 'passed') {
      throw new Error('仅允许对有首轮回执且尚未通过的岗位重试一次。');
    }
    if (!evidence || !['failed', 'blocked'].includes(evidence.status)
        || typeof evidence.summary !== 'string' || !evidence.summary.trim()) {
      throw new Error('需要先保存该岗位的实证失败结论。');
    }
    startPromise = (async () => {
      const { delegation } = await cindy.targets.capabilities({});
      if (!delegation?.execution || !delegation.receiptQuery || !delegation.settled) {
        throw new Error('当前 Cindy 缺少完整的伙伴委派及执行回执能力。');
      }
      const receipt = await cindy.targets.get({ requestKey: previous.requestKey });
      validateReceipt(receipt, companion, previous.requestKey);
      if (!receipt.found || receipt.settled !== true || receipt.result?.outcome !== 'completed') {
        throw new Error('原输入尚未确认完成，保持原请求编号并停止重试。');
      }
      await record(companion, {
        status: 'pending', awaitingEvidence: false, attempt: 2,
        requestKey: `${runId}:${companion.id}:attempt-2`,
        priorRequestKey: previous.requestKey, priorOutputMessageId: receipt.result.outputMessageId,
        retryReason: evidence.summary.slice(0, 1000),
        executionId: null, taskId: null, deliveryStatus: null, settled: false,
        outcome: null, outputMessageId: null, instanceId: null, generation: null, errorCode: null,
        summary: '原回执已终结且实证未通过，准备唯一一次只读重试。',
      });
      running = true;
      stopDispatch = false;
      lastError = null;
      startedAt = new Date().toISOString();
      completedAt = null;
      publish();
      batchPromise = run([companion]);
      return status();
    })();
    try { return await startPromise; } finally { startPromise = null; }
  }

  function acceptResults(results) {
    for (const result of results) {
      if (result.status === 'passed' && roster.some(item => item.id === result.companionId)) {
        records.set(result.companionId, {
          ...records.get(result.companionId), ...recordMetadata(result), awaitingEvidence: false,
        });
      }
    }
    publish();
  }

  return { start, retry, status, acceptResults, finished: () => batchPromise };
}
