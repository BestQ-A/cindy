/**
 * Shared Task Flow Graph & Timeline Engine.
 *
 * Pure TypeScript (zero Electron/React imports) shared across main collector,
 * cross-computer companion host, desktop Task Flow views, and plugin UI.
 */

export type TaskFlowNodeKind =
  | 'companion'
  | 'session'
  | 'subagent'
  | 'orca_worker'
  | 'group_step'
  | 'plan_step';

export type TaskFlowNodeStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'idle';

export type TaskFlowEdgeKind =
  | 'created_task'
  | 'delegated'
  | 'forked'
  | 'handoff'
  | 'reported'
  | 'orca_dispatch'
  | 'subagent_spawn'
  | 'blocked_by';

export interface TaskFlowInternalStep {
  stepId: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy?: string[];
  blocks?: string[];
  owner?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs?: number;
}

export interface TaskFlowNode {
  id: string;
  kind: TaskFlowNodeKind;
  title: string;
  subtitle?: string;
  status: TaskFlowNodeStatus;
  source?: string;
  deviceId?: string | null;
  deviceName?: string | null;
  botId?: string | null;
  botName?: string | null;
  botAvatar?: string | null;
  folderId?: string | null;
  folderBreadcrumb?: string[];
  sessionId?: string | null;
  parentNodeId?: string | null;
  progressPct?: number;
  stepCounts?: { completed: number; total: number };
  createdAtMs: number;
  startedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
  isCrossDevice?: boolean;
  isPlaceholder?: boolean;
  internalSteps?: TaskFlowInternalStep[];
}

export interface TaskFlowEdge {
  id: string;
  from: string;
  to: string;
  kind: TaskFlowEdgeKind;
  label?: string;
  timestampMs?: number;
  count?: number;
  isCrossDevice?: boolean;
}

export interface TaskFlowSnapshot {
  nodes: TaskFlowNode[];
  edges: TaskFlowEdge[];
  selfDeviceId: string | null;
  selfDeviceName?: string | null;
  observedAt: number;
  hiddenScheduledCount: number;
}

export interface TaskFlowFilterOptions {
  timeWindowMs?: number | null;
  nowMs?: number;
  statusFilter?: TaskFlowNodeStatus | 'all';
  searchQuery?: string;
  includeScheduled?: boolean;
  onlyWithDependencies?: boolean;
  expandInternalSteps?: boolean;
  folderId?: string | null;
  deviceId?: string | null;
}

export interface TaskFlowLineage {
  upstreamNodeIds: Set<string>;
  downstreamNodeIds: Set<string>;
  relatedNodeIds: Set<string>;
  relatedEdgeIds: Set<string>;
}

export type TaskFlowDagNodeRole = 'spine' | 'branch' | 'isolated';

export interface PositionedTaskFlowDagNode {
  node: TaskFlowNode;
  layer: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  role?: TaskFlowDagNodeRole;
  chainId?: string;
}

export interface TaskFlowDagChainGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeCount: number;
  edgeCount: number;
  spineLength: number;
  branchCount: number;
  hasRunning: boolean;
}

export interface RoutedTaskFlowDagEdge {
  edge: TaskFlowEdge;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  path: string;
  isBackEdge: boolean;
  isMainSpine?: boolean;
}

export interface TaskFlowDagLayout {
  width: number;
  height: number;
  nodes: PositionedTaskFlowDagNode[];
  edges: RoutedTaskFlowDagEdge[];
  chains?: TaskFlowDagChainGroup[];
  isolatedCount?: number;
}

export interface TaskFlowSwimlane {
  id: string;
  label: string;
  deviceName?: string | null;
  nodes: TaskFlowNode[];
}

export interface TaskFlowSwimlaneLayout {
  lanes: TaskFlowSwimlane[];
  minTimeMs: number;
  maxTimeMs: number;
}

const DAG_NODE_WIDTH = 238;
const DAG_NODE_HEIGHT = 88;
const DAG_COL_GAP = 72;
const DAG_ROW_GAP = 22;
const DAG_PADDING_X = 24;
const DAG_PADDING_Y = 24;

export function parseSessionTarget(
  rawSessionOrTarget: string,
  fallbackDeviceId?: string | null,
): { deviceId: string | null; sessionId: string } {
  const trimmed = rawSessionOrTarget.trim();
  const sepIndex = trimmed.indexOf('::');
  if (sepIndex > 0) {
    const dev = trimmed.slice(0, sepIndex).trim();
    const sid = trimmed.slice(sepIndex + 2).trim();
    return {
      deviceId: dev || fallbackDeviceId || null,
      sessionId: sid || trimmed,
    };
  }
  return {
    deviceId: fallbackDeviceId ?? null,
    sessionId: trimmed,
  };
}

export function canonicalizeSessionNodeId(
  deviceId: string | null | undefined,
  rawSessionOrTarget: string,
): string {
  const parsed = parseSessionTarget(rawSessionOrTarget, deviceId);
  return `session:${parsed.deviceId ?? 'local'}:${parsed.sessionId}`;
}

export function canonicalizeBotNodeId(
  deviceId: string | null | undefined,
  botId: string,
): string {
  return `bot:${deviceId ?? 'local'}:${botId}`;
}

function chooseRicherNode(existing: TaskFlowNode, incoming: TaskFlowNode): TaskFlowNode {
  const existingReal = existing.isPlaceholder !== true;
  const incomingReal = incoming.isPlaceholder !== true;
  if (!existingReal && incomingReal) {
    return {
      ...existing,
      ...incoming,
      isPlaceholder: false,
      isCrossDevice: existing.isCrossDevice || incoming.isCrossDevice,
    };
  }
  if (existingReal && !incomingReal) {
    return {
      ...existing,
      isCrossDevice: existing.isCrossDevice || incoming.isCrossDevice,
    };
  }
  return incoming.updatedAtMs >= existing.updatedAtMs
    ? {
        ...existing,
        ...incoming,
        folderId: incoming.folderId ?? existing.folderId,
        folderBreadcrumb: incoming.folderBreadcrumb?.length
          ? incoming.folderBreadcrumb
          : existing.folderBreadcrumb,
        internalSteps: incoming.internalSteps?.length
          ? incoming.internalSteps
          : existing.internalSteps,
      }
    : existing;
}

/**
 * Merges local snapshot with remote-home snapshots. Cross-device placeholder nodes
 * created by local `send_to_session` calls are seamlessly replaced by the remote
 * home's authoritative session/companion nodes when reachable.
 */
export function mergeTaskFlowSnapshots(
  local: TaskFlowSnapshot,
  remotes: ReadonlyArray<{
    deviceId: string;
    deviceName?: string | null;
    snapshot: TaskFlowSnapshot;
  }>,
): TaskFlowSnapshot {
  const nodeMap = new Map<string, TaskFlowNode>();
  const rawIdToCanonical = new Map<string, string>();
  const localDev = local.selfDeviceId ?? null;

  const normalizeNode = (
    node: TaskFlowNode,
    homeDeviceId: string | null,
    homeDeviceName?: string | null,
  ): TaskFlowNode => {
    const dev = node.deviceId !== undefined ? node.deviceId : homeDeviceId;
    const devName = node.deviceName ?? (dev === homeDeviceId ? (homeDeviceName ?? null) : null);
    let canonicalId = node.id;
    if (node.kind === 'session' && node.sessionId) {
      canonicalId = canonicalizeSessionNodeId(dev, node.sessionId);
    } else if (node.kind === 'companion' && node.botId) {
      canonicalId = canonicalizeBotNodeId(dev, node.botId);
    }
    rawIdToCanonical.set(node.id, canonicalId);
    return {
      ...node,
      id: canonicalId,
      deviceId: dev,
      ...(devName ? { deviceName: devName } : {}),
    };
  };

  for (const node of local.nodes) {
    const normalized = normalizeNode(node, localDev, local.selfDeviceName);
    const prev = nodeMap.get(normalized.id);
    nodeMap.set(normalized.id, prev ? chooseRicherNode(prev, normalized) : normalized);
  }

  let hiddenScheduledCount = local.hiddenScheduledCount;
  let observedAt = local.observedAt;

  for (const remote of remotes) {
    observedAt = Math.max(observedAt, remote.snapshot.observedAt ?? 0);
    hiddenScheduledCount += remote.snapshot.hiddenScheduledCount ?? 0;
    for (const node of remote.snapshot.nodes) {
      const normalized = normalizeNode(
        node,
        remote.deviceId,
        remote.deviceName ?? remote.snapshot.selfDeviceName,
      );
      const prev = nodeMap.get(normalized.id);
      nodeMap.set(normalized.id, prev ? chooseRicherNode(prev, normalized) : normalized);
    }
  }

  const edgeMap = new Map<string, TaskFlowEdge>();
  const addEdge = (edge: TaskFlowEdge) => {
    const from = rawIdToCanonical.get(edge.from) ?? edge.from;
    const to = rawIdToCanonical.get(edge.to) ?? edge.to;
    if (from === to) return;
    const fromNode = nodeMap.get(from);
    const toNode = nodeMap.get(to);
    const cross =
      edge.isCrossDevice === true ||
      Boolean(
        fromNode?.deviceId &&
          toNode?.deviceId &&
          fromNode.deviceId !== toNode.deviceId,
      );
    const dedupeKey = `${from}=>${to}:${edge.kind}`;
    const prev = edgeMap.get(dedupeKey);
    if (!prev) {
      edgeMap.set(dedupeKey, {
        ...edge,
        id: edge.id || dedupeKey,
        from,
        to,
        ...(cross ? { isCrossDevice: true } : {}),
      });
    } else {
      edgeMap.set(dedupeKey, {
        ...prev,
        count: (prev.count ?? 1) + (edge.count ?? 1) - 1,
        timestampMs: Math.max(prev.timestampMs ?? 0, edge.timestampMs ?? 0) || prev.timestampMs,
        ...(cross ? { isCrossDevice: true } : {}),
      });
    }
  };

  for (const edge of local.edges) addEdge(edge);
  for (const remote of remotes) {
    for (const edge of remote.snapshot.edges) addEdge(edge);
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    selfDeviceId: local.selfDeviceId,
    selfDeviceName: local.selfDeviceName,
    observedAt,
    hiddenScheduledCount,
  };
}

function internalStepToNodeStatus(status: TaskFlowInternalStep['status']): TaskFlowNodeStatus {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'running';
  return 'waiting';
}

export function computeLineage(
  nodeId: string,
  edges: readonly TaskFlowEdge[],
): TaskFlowLineage {
  const upstreamNodeIds = new Set<string>();
  const downstreamNodeIds = new Set<string>();
  const relatedEdgeIds = new Set<string>();

  const upQueue = [nodeId];
  while (upQueue.length > 0) {
    const current = upQueue.shift()!;
    for (const edge of edges) {
      if (edge.to === current) {
        relatedEdgeIds.add(edge.id);
        if (!upstreamNodeIds.has(edge.from) && edge.from !== nodeId) {
          upstreamNodeIds.add(edge.from);
          upQueue.push(edge.from);
        }
      }
    }
  }

  const downQueue = [nodeId];
  while (downQueue.length > 0) {
    const current = downQueue.shift()!;
    for (const edge of edges) {
      if (edge.from === current) {
        relatedEdgeIds.add(edge.id);
        if (!downstreamNodeIds.has(edge.to) && edge.to !== nodeId) {
          downstreamNodeIds.add(edge.to);
          downQueue.push(edge.to);
        }
      }
    }
  }

  const relatedNodeIds = new Set<string>([nodeId, ...upstreamNodeIds, ...downstreamNodeIds]);
  return { upstreamNodeIds, downstreamNodeIds, relatedNodeIds, relatedEdgeIds };
}

export function filterTaskFlowGraph(
  snapshot: TaskFlowSnapshot,
  opts: TaskFlowFilterOptions = {},
): { nodes: TaskFlowNode[]; edges: TaskFlowEdge[]; hiddenScheduledCount: number } {
  const nowMs = opts.nowMs ?? Date.now();
  const query = opts.searchQuery?.trim().toLowerCase() ?? '';
  let hiddenScheduledCount = snapshot.hiddenScheduledCount;

  // Step 1: optionally materialize internal plan steps
  let workingNodes: TaskFlowNode[] = [...snapshot.nodes];
  let workingEdges: TaskFlowEdge[] = [...snapshot.edges];

  if (opts.expandInternalSteps) {
    const existingIds = new Set(workingNodes.map((n) => n.id));
    const addedNodes: TaskFlowNode[] = [];
    const addedEdges: TaskFlowEdge[] = [];

    for (const parent of workingNodes) {
      if (!parent.internalSteps || parent.internalSteps.length === 0) continue;
      const stepIdToNodeId = new Map<string, string>();
      for (const step of parent.internalSteps) {
        const nodeId = `plan-step:${parent.id}:${step.stepId}`;
        stepIdToNodeId.set(step.stepId, nodeId);
      }

      for (const step of parent.internalSteps) {
        const nodeId = stepIdToNodeId.get(step.stepId)!;
        if (existingIds.has(nodeId)) continue;
        existingIds.add(nodeId);

        const created = step.createdAtMs ?? parent.createdAtMs;
        const started = step.startedAtMs ?? (step.status === 'completed' ? created : undefined);
        const completed = step.completedAtMs;
        const updated = step.updatedAtMs ?? completed ?? started ?? created;

        addedNodes.push({
          id: nodeId,
          kind: 'plan_step',
          title: step.content,
          subtitle: step.owner ? `${parent.title} · ${step.owner}` : parent.title,
          status: internalStepToNodeStatus(step.status),
          source: parent.source,
          deviceId: parent.deviceId,
          deviceName: parent.deviceName,
          botId: parent.botId,
          botName: parent.botName,
          folderId: parent.folderId,
          folderBreadcrumb: parent.folderBreadcrumb,
          sessionId: parent.sessionId,
          parentNodeId: parent.id,
          createdAtMs: created,
          ...(started !== undefined ? { startedAtMs: started } : {}),
          ...(completed !== undefined ? { completedAtMs: completed } : {}),
          updatedAtMs: updated,
        });

        let hasParentStepEdge = false;
        for (const upstreamStepId of step.blockedBy ?? []) {
          const upstreamNodeId = stepIdToNodeId.get(upstreamStepId);
          if (upstreamNodeId && upstreamNodeId !== nodeId) {
            hasParentStepEdge = true;
            addedEdges.push({
              id: `edge:${upstreamNodeId}=>${nodeId}:blocked_by`,
              from: upstreamNodeId,
              to: nodeId,
              kind: 'blocked_by',
              timestampMs: created,
            });
          }
        }
        if (!hasParentStepEdge) {
          addedEdges.push({
            id: `edge:${parent.id}=>${nodeId}:delegated`,
            from: parent.id,
            to: nodeId,
            kind: 'delegated',
            timestampMs: created,
          });
        }
      }
    }
    workingNodes = [...workingNodes, ...addedNodes];
    workingEdges = [...workingEdges, ...addedEdges];
  }

  // Step 2: filter nodes by attributes
  let filteredNodes = workingNodes.filter((node) => {
    if (!opts.includeScheduled && node.source === 'scheduler') {
      return false;
    }
    if (opts.statusFilter && opts.statusFilter !== 'all' && node.status !== opts.statusFilter) {
      return false;
    }
    if (opts.deviceId && (node.deviceId ?? 'local') !== opts.deviceId) {
      return false;
    }
    if (opts.folderId && node.folderId !== opts.folderId) {
      return false;
    }
    if (typeof opts.timeWindowMs === 'number' && opts.timeWindowMs > 0) {
      const latestMs = Math.max(
        node.updatedAtMs,
        node.completedAtMs ?? 0,
        node.startedAtMs ?? 0,
        node.createdAtMs,
      );
      if (node.status !== 'running' && latestMs < nowMs - opts.timeWindowMs) {
        return false;
      }
    }
    if (query) {
      const haystack = [
        node.title,
        node.subtitle,
        node.botName,
        node.deviceName,
        ...(node.folderBreadcrumb ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  if (!opts.includeScheduled && snapshot.hiddenScheduledCount === 0) {
    hiddenScheduledCount = workingNodes.filter((n) => n.source === 'scheduler').length;
  }

  const allowedIds = new Set(filteredNodes.map((n) => n.id));
  let filteredEdges = workingEdges.filter(
    (edge) => allowedIds.has(edge.from) && allowedIds.has(edge.to),
  );

  if (opts.onlyWithDependencies) {
    const connectedIds = new Set<string>();
    for (const edge of filteredEdges) {
      connectedIds.add(edge.from);
      connectedIds.add(edge.to);
    }
    filteredNodes = filteredNodes.filter((node) => connectedIds.has(node.id));
    const finalIds = new Set(filteredNodes.map((n) => n.id));
    filteredEdges = filteredEdges.filter((e) => finalIds.has(e.from) && finalIds.has(e.to));
  }

  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    hiddenScheduledCount,
  };
}

/**
 * Cycle-safe clustered DAG layout:
 * 1. Partitions connected task chains separately from isolated nodes so isolated
 *    sessions never form a tall column that hides dependency chains.
 * 2. Inside each chain, extracts the longest directed critical path as the
 *    top horizontal "main spine" (row 0) and places branching sub-tasks underneath.
 */
export function layoutTaskFlowDag(
  nodes: readonly TaskFlowNode[],
  edges: readonly TaskFlowEdge[],
): TaskFlowDagLayout {
  if (nodes.length === 0) {
    return { width: 0, height: 0, nodes: [], edges: [], chains: [], isolatedCount: 0 };
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const validEdges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to);
  const orderedNodes = [...nodes].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));

  // Union-Find to group nodes into connected task chains vs isolated nodes
  const ufParent = new Map<string, string>(orderedNodes.map((n) => [n.id, n.id]));
  const ufFind = (id: string): string => {
    let cur = id;
    while (ufParent.get(cur) !== cur) {
      const p = ufParent.get(cur)!;
      ufParent.set(cur, ufParent.get(p)!);
      cur = p;
    }
    return cur;
  };
  const ufUnion = (a: string, b: string) => {
    const ra = ufFind(a);
    const rb = ufFind(b);
    if (ra !== rb) ufParent.set(rb, ra);
  };
  for (const edge of validEdges) {
    ufUnion(edge.from, edge.to);
  }

  const compNodesMap = new Map<string, TaskFlowNode[]>();
  for (const node of orderedNodes) {
    const root = ufFind(node.id);
    const list = compNodesMap.get(root) ?? [];
    list.push(node);
    compNodesMap.set(root, list);
  }

  const compEdgesMap = new Map<string, TaskFlowEdge[]>();
  for (const edge of validEdges) {
    const root = ufFind(edge.from);
    const list = compEdgesMap.get(root) ?? [];
    list.push(edge);
    compEdgesMap.set(root, list);
  }

  const multiNodeChains: Array<{ id: string; nodes: TaskFlowNode[]; edges: TaskFlowEdge[] }> = [];
  const isolatedNodes: TaskFlowNode[] = [];

  for (const [compId, compNodes] of compNodesMap.entries()) {
    const compEdges = compEdgesMap.get(compId) ?? [];
    if (compNodes.length <= 1 && compEdges.length === 0) {
      isolatedNodes.push(...compNodes);
    } else {
      multiNodeChains.push({ id: compId, nodes: compNodes, edges: compEdges });
    }
  }

  // Sort multi-node chains: active/running first, then richer chains, then most recently updated
  multiNodeChains.sort((a, b) => {
    const aActive = a.nodes.some((n) => n.status === 'running' || n.status === 'waiting') ? 0 : 1;
    const bActive = b.nodes.some((n) => n.status === 'running' || n.status === 'waiting') ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (b.edges.length !== a.edges.length) return b.edges.length - a.edges.length;
    if (b.nodes.length !== a.nodes.length) return b.nodes.length - a.nodes.length;
    const aMaxUpd = Math.max(...a.nodes.map((n) => n.updatedAtMs));
    const bMaxUpd = Math.max(...b.nodes.map((n) => n.updatedAtMs));
    return bMaxUpd - aMaxUpd;
  });

  isolatedNodes.sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'waiting' ? 0 : 1;
    const bActive = b.status === 'running' || b.status === 'waiting' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.updatedAtMs - a.updatedAtMs;
  });

  const CHAIN_HEADER_H = 40;
  const CHAIN_PAD_X = 20;
  const CHAIN_PAD_BOTTOM = 20;
  const CHAIN_GAP = 22;
  const ISOLATED_COLS = 4;

  const positioned: PositionedTaskFlowDagNode[] = [];
  const posById = new Map<string, PositionedTaskFlowDagNode>();
  const backEdgeIds = new Set<string>();
  const spineNodeIds = new Set<string>();
  const chains: TaskFlowDagChainGroup[] = [];

  let cursorY = DAG_PADDING_Y;
  let maxStageWidth = DAG_PADDING_X * 2 + DAG_NODE_WIDTH;

  for (let chainIdx = 0; chainIdx < multiNodeChains.length; chainIdx++) {
    const chain = multiNodeChains[chainIdx];
    const chainOrdered = [...chain.nodes].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id),
    );
    const outgoingAll = new Map<string, TaskFlowEdge[]>();
    for (const edge of chain.edges) {
      const list = outgoingAll.get(edge.from) ?? [];
      list.push(edge);
      outgoingAll.set(edge.from, list);
    }

    // Cycle detection within chain
    const visitState = new Map<string, 1 | 2>();
    const chainBackEdges = new Set<string>();
    const dfsCycle = (id: string) => {
      visitState.set(id, 1);
      for (const edge of outgoingAll.get(id) ?? []) {
        const st = visitState.get(edge.to);
        if (st === 1) {
          chainBackEdges.add(edge.id);
          backEdgeIds.add(edge.id);
        } else if (!st) {
          dfsCycle(edge.to);
        }
      }
      visitState.set(id, 2);
    };
    for (const n of chainOrdered) {
      if (!visitState.has(n.id)) dfsCycle(n.id);
    }

    const dagEdges = chain.edges.filter((e) => !chainBackEdges.has(e.id));
    const inDeg = new Map<string, number>();
    const incomingDag = new Map<string, string[]>();
    const outgoingDag = new Map<string, string[]>();
    for (const n of chainOrdered) {
      inDeg.set(n.id, 0);
      incomingDag.set(n.id, []);
      outgoingDag.set(n.id, []);
    }
    for (const e of dagEdges) {
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
      incomingDag.get(e.to)!.push(e.from);
      outgoingDag.get(e.from)!.push(e.to);
    }

    // Longest-path layer assignment from roots
    const layerOf = new Map<string, number>();
    const queue = chainOrdered.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
    const topo: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      topo.push(cur);
      const curLayer = layerOf.get(cur) ?? 0;
      for (const nxt of outgoingDag.get(cur) ?? []) {
        layerOf.set(nxt, Math.max(layerOf.get(nxt) ?? 0, curLayer + 1));
        const nd = (inDeg.get(nxt) ?? 0) - 1;
        inDeg.set(nxt, nd);
        if (nd === 0) queue.push(nxt);
      }
    }
    for (const n of chainOrdered) {
      if (!layerOf.has(n.id)) layerOf.set(n.id, 0);
    }

    // Compute longest downstream chain depth per node to identify the main spine
    const depthMemo = new Map<string, number>();
    const getDownstreamDepth = (id: string): number => {
      if (depthMemo.has(id)) return depthMemo.get(id)!;
      const children = outgoingDag.get(id) ?? [];
      let best = 1;
      for (const child of children) {
        best = Math.max(best, 1 + getDownstreamDepth(child));
      }
      depthMemo.set(id, best);
      return best;
    };
    for (const n of chainOrdered) getDownstreamDepth(n.id);

    const minLayer = Math.min(...chainOrdered.map((n) => layerOf.get(n.id) ?? 0));
    const roots = chainOrdered.filter((n) => (layerOf.get(n.id) ?? 0) === minLayer);
    roots.sort((a, b) => {
      const diff = getDownstreamDepth(b.id) - getDownstreamDepth(a.id);
      if (diff !== 0) return diff;
      const aAct = a.status === 'running' || a.status === 'waiting' ? 0 : 1;
      const bAct = b.status === 'running' || b.status === 'waiting' ? 0 : 1;
      return aAct - bAct || a.createdAtMs - b.createdAtMs;
    });

    const chainSpineSet = new Set<string>();
    const chainSpineOrdered: TaskFlowNode[] = [];
    let curSpine: TaskFlowNode | undefined = roots[0];
    while (curSpine && !chainSpineSet.has(curSpine.id)) {
      chainSpineSet.add(curSpine.id);
      spineNodeIds.add(curSpine.id);
      chainSpineOrdered.push(curSpine);
      const children: TaskFlowNode[] = (outgoingDag.get(curSpine.id) ?? [])
        .map((id) => nodeById.get(id))
        .filter((n): n is TaskFlowNode => Boolean(n));
      children.sort((a, b) => {
        const diff = getDownstreamDepth(b.id) - getDownstreamDepth(a.id);
        if (diff !== 0) return diff;
        const aAct = a.status === 'running' || a.status === 'waiting' ? 0 : 1;
        const bAct = b.status === 'running' || b.status === 'waiting' ? 0 : 1;
        return aAct - bAct || a.createdAtMs - b.createdAtMs;
      });
      curSpine = children[0];
    }

    // Place spine at row 0, and branches directly below their branching parents without collisions
    const occupied = new Set<string>();
    const localRowOf = new Map<string, number>();
    for (const sp of chainSpineOrdered) {
      const l = layerOf.get(sp.id) ?? 0;
      localRowOf.set(sp.id, 0);
      occupied.add(`${l}:0`);
    }

    const branchNodes = chainOrdered
      .filter((n) => !chainSpineSet.has(n.id))
      .sort(
        (a, b) =>
          (layerOf.get(a.id) ?? 0) - (layerOf.get(b.id) ?? 0) || a.createdAtMs - b.createdAtMs,
      );

    for (const bn of branchNodes) {
      const l = layerOf.get(bn.id) ?? 0;
      const parents = incomingDag.get(bn.id) ?? [];
      let preferredRow = 1;
      const placedParentRows = parents
        .filter((p) => localRowOf.has(p))
        .map((p) => (localRowOf.get(p)! === 0 ? 1 : localRowOf.get(p)!));
      if (placedParentRows.length > 0) {
        preferredRow = Math.max(1, Math.min(...placedParentRows));
      }
      let r = preferredRow;
      while (occupied.has(`${l}:${r}`)) {
        r++;
      }
      occupied.add(`${l}:${r}`);
      localRowOf.set(bn.id, r);
    }

    const maxLocalLayer = Math.max(0, ...chainOrdered.map((n) => layerOf.get(n.id) ?? 0));
    const maxLocalRow = Math.max(0, ...chainOrdered.map((n) => localRowOf.get(n.id) ?? 0));
    const chainRows = maxLocalRow + 1;
    const chainW =
      CHAIN_PAD_X * 2 + (maxLocalLayer + 1) * DAG_NODE_WIDTH + maxLocalLayer * DAG_COL_GAP;
    const chainH =
      CHAIN_HEADER_H +
      chainRows * DAG_NODE_HEIGHT +
      Math.max(0, chainRows - 1) * DAG_ROW_GAP +
      CHAIN_PAD_BOTTOM;

    const chainId = `chain-${chainIdx + 1}`;
    const rootTitle = chainSpineOrdered[0]?.title || chainOrdered[0]?.title || chainId;
    chains.push({
      id: chainId,
      title: rootTitle,
      x: DAG_PADDING_X,
      y: cursorY,
      width: chainW,
      height: chainH,
      nodeCount: chainOrdered.length,
      edgeCount: chain.edges.length,
      spineLength: chainSpineOrdered.length,
      branchCount: Math.max(0, chainRows - 1),
      hasRunning: chainOrdered.some((n) => n.status === 'running' || n.status === 'waiting'),
    });

    for (const n of chainOrdered) {
      const l = layerOf.get(n.id) ?? 0;
      const r = localRowOf.get(n.id) ?? 0;
      const item: PositionedTaskFlowDagNode = {
        node: n,
        layer: l,
        row: r,
        x: DAG_PADDING_X + CHAIN_PAD_X + l * (DAG_NODE_WIDTH + DAG_COL_GAP),
        y: cursorY + CHAIN_HEADER_H + r * (DAG_NODE_HEIGHT + DAG_ROW_GAP),
        width: DAG_NODE_WIDTH,
        height: DAG_NODE_HEIGHT,
        role: chainSpineSet.has(n.id) ? 'spine' : 'branch',
        chainId,
      };
      positioned.push(item);
      posById.set(n.id, item);
    }

    maxStageWidth = Math.max(maxStageWidth, DAG_PADDING_X * 2 + chainW);
    cursorY += chainH + CHAIN_GAP;
  }

  // Place isolated (no-dependency) nodes in a compact grid below all dependency chains
  if (isolatedNodes.length > 0) {
    const isoHeaderY = cursorY;
    const isoStartY = isoHeaderY + 34;
    const isoGapX = 20;
    const isoGapY = 16;
    isolatedNodes.forEach((n, idx) => {
      const col = idx % ISOLATED_COLS;
      const row = Math.floor(idx / ISOLATED_COLS);
      const item: PositionedTaskFlowDagNode = {
        node: n,
        layer: col,
        row,
        x: DAG_PADDING_X + col * (DAG_NODE_WIDTH + isoGapX),
        y: isoStartY + row * (DAG_NODE_HEIGHT + isoGapY),
        width: DAG_NODE_WIDTH,
        height: DAG_NODE_HEIGHT,
        role: 'isolated',
        chainId: 'isolated',
      };
      positioned.push(item);
      posById.set(n.id, item);
    });
    const isoRows = Math.ceil(isolatedNodes.length / ISOLATED_COLS);
    const isoGridW =
      DAG_PADDING_X * 2 +
      Math.min(isolatedNodes.length, ISOLATED_COLS) * DAG_NODE_WIDTH +
      Math.max(0, Math.min(isolatedNodes.length, ISOLATED_COLS) - 1) * isoGapX;
    maxStageWidth = Math.max(maxStageWidth, isoGridW);
    cursorY = isoStartY + isoRows * DAG_NODE_HEIGHT + Math.max(0, isoRows - 1) * isoGapY + DAG_PADDING_Y;
  }

  const routedEdges: RoutedTaskFlowDagEdge[] = validEdges.flatMap((edge): RoutedTaskFlowDagEdge[] => {
    const src = posById.get(edge.from);
    const dst = posById.get(edge.to);
    if (!src || !dst) return [];
    const isMainSpine = spineNodeIds.has(edge.from) && spineNodeIds.has(edge.to);
    const isBack = backEdgeIds.has(edge.id) || src.layer >= dst.layer;
    if (isBack) {
      const fromX = src.x + src.width / 2;
      const fromY = src.y + src.height;
      const toX = dst.x + dst.width / 2;
      const toY = dst.y + dst.height;
      const dropY = Math.max(fromY, toY) + 28;
      const path = `M ${fromX} ${fromY} C ${fromX} ${dropY}, ${toX} ${dropY}, ${toX} ${toY}`;
      return [{ edge, fromX, fromY, toX, toY, path, isBackEdge: true, isMainSpine }];
    }
    const fromX = src.x + src.width;
    const fromY = src.y + src.height / 2;
    const toX = dst.x;
    const toY = dst.y + dst.height / 2;
    const midX = (fromX + toX) / 2;
    const path = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
    return [{ edge, fromX, fromY, toX, toY, path, isBackEdge: false, isMainSpine }];
  });

  return {
    width: maxStageWidth,
    height: Math.max(240, cursorY + 12),
    nodes: positioned,
    edges: routedEdges,
    chains,
    isolatedCount: isolatedNodes.length,
  };
}

export function buildTaskFlowSwimlanes(
  nodes: readonly TaskFlowNode[],
  edges: readonly TaskFlowEdge[],
  groupBy: 'hierarchy' | 'computer' | 'chain',
  nowMs = Date.now(),
): TaskFlowSwimlaneLayout {
  if (nodes.length === 0) {
    return {
      lanes: [],
      minTimeMs: nowMs - 3_600_000,
      maxTimeMs: nowMs,
    };
  }

  let minTimeMs = Number.POSITIVE_INFINITY;
  let maxTimeMs = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const start = node.startedAtMs ?? node.createdAtMs;
    const end =
      node.status === 'running'
        ? Math.max(nowMs, node.updatedAtMs, start)
        : (node.completedAtMs ?? node.updatedAtMs ?? start);
    minTimeMs = Math.min(minTimeMs, start);
    maxTimeMs = Math.max(maxTimeMs, end);
  }
  if (!Number.isFinite(minTimeMs)) minTimeMs = nowMs - 3_600_000;
  if (!Number.isFinite(maxTimeMs) || maxTimeMs <= minTimeMs) maxTimeMs = minTimeMs + 60_000;

  if (groupBy === 'chain') {
    const parent = new Map(nodes.map((n) => [n.id, n.id]));
    const find = (x: string): string => {
      let cur = x;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur)!;
        parent.set(cur, parent.get(next)!);
        cur = next;
      }
      return cur;
    };
    const unite = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    for (const edge of edges) {
      if (parent.has(edge.from) && parent.has(edge.to)) {
        unite(edge.from, edge.to);
      }
    }
    const groups = new Map<string, TaskFlowNode[]>();
    for (const node of nodes) {
      const root = find(node.id);
      const bucket = groups.get(root) ?? [];
      bucket.push(node);
      groups.set(root, bucket);
    }
    const lanes: TaskFlowSwimlane[] = [...groups.entries()]
      .map(([rootId, laneNodes], idx) => {
        const sorted = [...laneNodes].sort((a, b) => a.createdAtMs - b.createdAtMs);
        const lead = sorted[0];
        const label =
          sorted.length > 1
            ? `${lead.title}（${sorted.length} 项协作链路）`
            : lead.title;
        return {
          id: `chain:${rootId}:${idx}`,
          label,
          deviceName: lead.deviceName ?? null,
          nodes: sorted,
        };
      })
      .sort((a, b) => {
        const maxA = Math.max(...a.nodes.map((n) => n.updatedAtMs));
        const maxB = Math.max(...b.nodes.map((n) => n.updatedAtMs));
        return maxB - maxA;
      });
    return { lanes, minTimeMs, maxTimeMs };
  }

  const laneBuckets = new Map<string, { label: string; deviceName?: string | null; nodes: TaskFlowNode[] }>();
  for (const node of nodes) {
    const key =
      groupBy === 'computer'
        ? `computer:${node.deviceId ?? 'local'}`
        : `hierarchy:${node.folderBreadcrumb?.join(' / ') || node.botName || '未分组'}`;
    const label =
      groupBy === 'computer'
        ? (node.deviceName || (node.deviceId ? node.deviceId.slice(0, 8) : '本机电脑'))
        : (node.folderBreadcrumb?.join(' / ') || node.botName || '未分组任务');
    const bucket = laneBuckets.get(key) ?? {
      label,
      deviceName: groupBy === 'computer' ? label : null,
      nodes: [],
    };
    bucket.nodes.push(node);
    laneBuckets.set(key, bucket);
  }

  const lanes: TaskFlowSwimlane[] = [...laneBuckets.entries()]
    .map(([id, b]) => ({
      id,
      label: b.label,
      deviceName: b.deviceName,
      nodes: [...b.nodes].sort((a, bNode) => a.createdAtMs - bNode.createdAtMs),
    }))
    .sort((a, b) => {
      const aRun = a.nodes.some((n) => n.status === 'running') ? 1 : 0;
      const bRun = b.nodes.some((n) => n.status === 'running') ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      const maxA = Math.max(...a.nodes.map((n) => n.updatedAtMs));
      const maxB = Math.max(...b.nodes.map((n) => n.updatedAtMs));
      return maxB - maxA;
    });

  return { lanes, minTimeMs, maxTimeMs };
}
