const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../plugins/wanjie-overview/main.js'), 'utf8');
const pause = () => new Promise(resolve => setImmediate(resolve));

async function createRuntime({ available = true, taskFlow = null } = {}) {
  const messages = [];
  const toolResults = [];
  const companions = [{ id: 'one', name: '万界｜测试岗位', status: 'idle' }];
  let currentTaskFlow = taskFlow;
  let hostMessage;
  let channel;
  let stored = {};
  let failSave = false;
  let failList = false;
  let active = 0;
  let maxActive = 0;
  const calls = { list: 0, watch: 0, open: 0 };
  const context = vm.createContext({
    console,
    BroadcastChannel: class {
      constructor() { channel = this; }
      postMessage(message) { messages.push(message); }
    },
    fetch: async (url, options) => {
      if (url === '/bootstrap.json') return { ok: true, json: async () => ({ roster: companions, devices: [], verification: { results: [] } }) };
      assert.equal(url, '/kv');
      if (options) {
        await pause();
        if (failSave) return { ok: false, status: 500 };
        stored = JSON.parse(options.body);
        return { ok: true };
      }
      return { ok: true, json: async () => stored };
    },
    cindy: {
      onHostMessage(callback) { hostMessage = callback; },
      send(message) { toolResults.push(message); },
      companions: available ? {
        async list() {
          calls.list++;
          if (failList) throw new Error('permission revoked');
          active++;
          maxActive = Math.max(maxActive, active);
          await pause();
          active--;
          return {
            companions,
            ...(currentTaskFlow ? { taskFlow: currentTaskFlow } : {}),
            observedAt: Date.now(),
          };
        },
        async watch() { calls.watch++; return { subscriptionId: 'watch' }; },
        async reply() { return { reply: { text: '<script>text only</script>' } }; },
        async history() { throw new Error('history unavailable'); },
        async open() { calls.open++; return { opened: true }; },
      } : undefined,
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('ready', context);
  return {
    messages, toolResults, calls,
    get stored() { return stored; },
    get maxActive() { return maxActive; },
    set failSave(value) { failSave = value; },
    set failList(value) { failList = value; },
    async view(action, id = 'one') {
      channel.onmessage({ data: { source: 'view', requestId: action, action, companionId: id } });
      for (let i = 0; i < 5; i++) await pause();
    },
    host(message) { hostMessage(message); },
    async tool(callId, args) {
      hostMessage({ type: 'tool-call', callId, tool: 'record_verification', args });
      for (let i = 0; i < 8; i++) await pause();
      return toolResults.find(item => item.callId === callId);
    },
  };
}

(async () => {
  const runtime = await createRuntime();
  assert.equal(runtime.calls.watch, 1);
  runtime.failList = true;
  await runtime.view('refresh');
  runtime.failList = false;
  await runtime.view('refresh');
  assert.equal(runtime.calls.watch, 2, 'a recovered host must create a new subscription');
  runtime.host({ type: 'companions-changed', subscriptionId: 'watch' });
  runtime.host({ type: 'companions-changed', subscriptionId: 'watch' });
  await runtime.view('refresh');
  assert.equal(runtime.maxActive, 1, 'overlapping refreshes must share one request');
  assert.equal(runtime.calls.watch, 2);
  await runtime.view('details');
  const details = runtime.messages.find(item => item.type === 'details');
  assert.equal(details.reply.text, '<script>text only</script>');
  assert.match(details.error, /history unavailable/);
  await runtime.view('open', 'unknown');
  assert.equal(runtime.calls.open, 0, 'unknown IDs must not reach host');
  const args = { checkedAt: '2026-11-14T19:00:00+08:00', results: [{ companionId: 'one', status: 'passed', summary: 'Read a real source.' }] };
  assert.equal((await runtime.tool('save', args)).result.structuredContent.saved, 1);
  assert.equal(runtime.stored.verification.results[0].status, 'passed');
  assert.equal((await runtime.tool('stale', { ...args, checkedAt: '2026-11-13T19:00:00+08:00' })).ok, false);
  assert.equal((await runtime.tool('unknown', { ...args, results: [{ ...args.results[0], companionId: 'unknown' }] })).ok, false);
  runtime.failSave = true;
  assert.equal((await runtime.tool('failed-write', { ...args, results: [{ ...args.results[0], status: 'failed' }] })).ok, false);
  assert.equal(runtime.stored.verification.results[0].status, 'passed', 'failed persistence must preserve last saved state');
  const unavailable = await createRuntime({ available: false });
  assert.match(unavailable.messages.at(-1).error, /伙伴查看接口/);
  assert.equal(unavailable.calls.watch, 0);
  const sampleTaskFlow = {
    nodes: [
      { id: 'n1', kind: 'session', title: '策划需求', status: 'completed', botId: 'one', createdAtMs: 1000, startedAtMs: 1100, completedAtMs: 2000, updatedAtMs: 2000 },
      { id: 'n2', kind: 'subagent', title: '开发实现', status: 'running', botId: 'two', createdAtMs: 2100, startedAtMs: 2200, updatedAtMs: 3000, isCrossDevice: true },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', kind: 'cross_device', label: '跨电脑调度', isCrossDevice: true }],
    selfDeviceId: 'dev-1',
    selfDeviceName: '本机',
    observedAt: 3500,
    hiddenScheduledCount: 1,
  };
  const withFlow = await createRuntime({ taskFlow: sampleTaskFlow });
  const flowState = [...withFlow.messages].reverse().find(item => item.type === 'state' && item.taskFlow);
  assert.ok(flowState, 'state broadcast must include taskFlow when host provides it');
  assert.equal(flowState.taskFlow.nodes.length, 2);
  assert.equal(flowState.taskFlow.edges[0].kind, 'cross_device');
  assert.equal(flowState.taskFlow.hiddenScheduledCount, 1);
  console.log('PASS: subscription, refresh concurrency, partial history, ID validation, saved-state consistency, unsupported host, taskFlow broadcast');
})().catch(error => { console.error(error); process.exitCode = 1; });
