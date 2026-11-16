export type GoalStatus = 'active' | 'paused' | 'completed' | 'archived';

export type GoalWorkItemStatus =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'blocked';

export interface GoalWorkItem {
  id: string;
  title: string;
  status: GoalWorkItemStatus;
  blockedBy: string[];
  ownerRole?: string;
  ownerBotId?: string;
  ownerSessionId?: string;
  backupOwnerRole?: string;
  backupOwnerBotId?: string;
  reviewerRole?: string;
  reviewerBotId?: string;
  reviewerSessionId?: string;
  artifactPaths: string[];
  acceptanceCriteria?: string;
  evidenceSummary?: string;
  blockerReason?: string;
  reviewVerdict?: 'PASS' | 'FAIL' | null;
  wave?: number;
  isCriticalPath?: boolean;
  startedAtMs?: number;
  submittedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}

export interface GoalRecord {
  id: string;
  title: string;
  objective: string;
  projectPath?: string;
  pmRole?: string;
  pmBotId?: string;
  pmSessionId?: string;
  status: GoalStatus;
  exitCriteria: string[];
  items: GoalWorkItem[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GoalBoardConfigV1 {
  version: 1;
  updatedAtMs: number;
  goals: GoalRecord[];
}

export interface GoalCriticalBlockerInfo {
  itemId: string;
  title: string;
  status: 'blocked' | 'in_progress';
  isCriticalPath: boolean;
  ownerRole?: string;
  backupOwnerRole?: string;
  backupOwnerBotId?: string;
  blockerReason?: string;
  stalledMs?: number;
  fallbackDirective?: string;
}

export interface GoalOverloadedSessionInfo {
  sessionId: string;
  queuedCount: number;
  relatedItemIds: string[];
}

export interface GoalNextActionsSummary {
  goalId: string;
  progressPct: number;
  completedCount: number;
  totalCount: number;
  currentWave: number;
  readyToDispatch: GoalWorkItem[];
  awaitingReview: GoalWorkItem[];
  criticalBlockers: GoalCriticalBlockerInfo[];
  overloadedSessions: GoalOverloadedSessionInfo[];
}

export interface GoalItemTransitionInput {
  itemId: string;
  status?: GoalWorkItemStatus;
  evidenceSummary?: string;
  blockerReason?: string;
  ownerSessionId?: string;
  reviewerSessionId?: string;
  verdict?: 'PASS' | 'FAIL';
  force?: boolean;
}

export type GoalItemTransitionResult =
  | {
      ok: true;
      goal: GoalRecord;
      item: GoalWorkItem;
      newlyUnlockedIds: string[];
    }
  | {
      ok: false;
      errorCode: 'ITEM_NOT_FOUND' | 'WAVE_GATE_BLOCKED' | 'REVIEW_REQUIRED';
      message: string;
    };

const DEFAULT_STALE_IN_PROGRESS_MS = 30 * 60 * 1000;
const SUMMARY_MAX_CHARS = 300;

const VALID_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'active',
  'paused',
  'completed',
  'archived',
]);

const VALID_ITEM_STATUSES: ReadonlySet<GoalWorkItemStatus> = new Set([
  'pending',
  'ready',
  'in_progress',
  'in_review',
  'completed',
  'blocked',
]);

export function sanitizeGoalSummaryText(raw: string | null | undefined, maxChars = SUMMARY_MAX_CHARS): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\((?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/[^)]+\)/gi, (_m, alt: string) =>
      alt && alt.trim() ? `[${alt.trim()}]` : '[图片]',
    )
    .replace(/(?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/\S+/gi, (uri) =>
      /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(uri) ? '[图片]' : '[附件]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : cleaned;
}

function cleanOptionalString(raw: unknown, maxChars = 240): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return sanitizeGoalSummaryText(raw, maxChars);
}

function cleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function finiteMs(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function createEmptyGoalBoardConfig(): GoalBoardConfigV1 {
  return {
    version: 1,
    updatedAtMs: 0,
    goals: [],
  };
}

function normalizeWorkItem(raw: unknown, fallbackNowMs: number): GoalWorkItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const title = cleanOptionalString(rec.title, 180) ?? id;
  if (!id || !title) return null;

  const status: GoalWorkItemStatus =
    typeof rec.status === 'string' && VALID_ITEM_STATUSES.has(rec.status as GoalWorkItemStatus)
      ? (rec.status as GoalWorkItemStatus)
      : 'pending';

  const reviewVerdict: 'PASS' | 'FAIL' | null =
    rec.reviewVerdict === 'PASS' || rec.reviewVerdict === 'FAIL' ? rec.reviewVerdict : null;

  return {
    id,
    title,
    status,
    blockedBy: cleanStringArray(rec.blockedBy).filter((dep) => dep !== id),
    ...(cleanOptionalString(rec.ownerRole, 80) ? { ownerRole: cleanOptionalString(rec.ownerRole, 80) } : {}),
    ...(cleanOptionalString(rec.ownerBotId, 120) ? { ownerBotId: cleanOptionalString(rec.ownerBotId, 120) } : {}),
    ...(cleanOptionalString(rec.ownerSessionId, 160)
      ? { ownerSessionId: cleanOptionalString(rec.ownerSessionId, 160) }
      : {}),
    ...(cleanOptionalString(rec.backupOwnerRole, 80)
      ? { backupOwnerRole: cleanOptionalString(rec.backupOwnerRole, 80) }
      : {}),
    ...(cleanOptionalString(rec.backupOwnerBotId, 120)
      ? { backupOwnerBotId: cleanOptionalString(rec.backupOwnerBotId, 120) }
      : {}),
    ...(cleanOptionalString(rec.reviewerRole, 80) ? { reviewerRole: cleanOptionalString(rec.reviewerRole, 80) } : {}),
    ...(cleanOptionalString(rec.reviewerBotId, 120)
      ? { reviewerBotId: cleanOptionalString(rec.reviewerBotId, 120) }
      : {}),
    ...(cleanOptionalString(rec.reviewerSessionId, 160)
      ? { reviewerSessionId: cleanOptionalString(rec.reviewerSessionId, 160) }
      : {}),
    artifactPaths: cleanStringArray(rec.artifactPaths),
    ...(cleanOptionalString(rec.acceptanceCriteria, 400)
      ? { acceptanceCriteria: cleanOptionalString(rec.acceptanceCriteria, 400) }
      : {}),
    ...(cleanOptionalString(rec.evidenceSummary, SUMMARY_MAX_CHARS)
      ? { evidenceSummary: cleanOptionalString(rec.evidenceSummary, SUMMARY_MAX_CHARS) }
      : {}),
    ...(cleanOptionalString(rec.blockerReason, SUMMARY_MAX_CHARS)
      ? { blockerReason: cleanOptionalString(rec.blockerReason, SUMMARY_MAX_CHARS) }
      : {}),
    ...(reviewVerdict !== null ? { reviewVerdict } : {}),
    ...(finiteMs(rec.startedAtMs) ? { startedAtMs: finiteMs(rec.startedAtMs) } : {}),
    ...(finiteMs(rec.submittedAtMs) ? { submittedAtMs: finiteMs(rec.submittedAtMs) } : {}),
    ...(finiteMs(rec.completedAtMs) ? { completedAtMs: finiteMs(rec.completedAtMs) } : {}),
    updatedAtMs: finiteMs(rec.updatedAtMs) ?? fallbackNowMs,
  };
}

export function normalizeGoalRecord(raw: unknown, fallbackNowMs = Date.now()): GoalRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id.trim() : '';
  const title = cleanOptionalString(rec.title, 180) ?? '';
  if (!id || !title) return null;

  const status: GoalStatus =
    typeof rec.status === 'string' && VALID_GOAL_STATUSES.has(rec.status as GoalStatus)
      ? (rec.status as GoalStatus)
      : 'active';

  const seenItems = new Set<string>();
  const items: GoalWorkItem[] = [];
  if (Array.isArray(rec.items)) {
    for (const rawItem of rec.items) {
      const parsed = normalizeWorkItem(rawItem, fallbackNowMs);
      if (!parsed || seenItems.has(parsed.id)) continue;
      seenItems.add(parsed.id);
      items.push(parsed);
    }
  }

  return recomputeGoalGraph({
    id,
    title,
    objective: cleanOptionalString(rec.objective, 600) ?? title,
    ...(cleanOptionalString(rec.projectPath, 300) ? { projectPath: cleanOptionalString(rec.projectPath, 300) } : {}),
    ...(cleanOptionalString(rec.pmRole, 80) ? { pmRole: cleanOptionalString(rec.pmRole, 80) } : {}),
    ...(cleanOptionalString(rec.pmBotId, 120) ? { pmBotId: cleanOptionalString(rec.pmBotId, 120) } : {}),
    ...(cleanOptionalString(rec.pmSessionId, 160) ? { pmSessionId: cleanOptionalString(rec.pmSessionId, 160) } : {}),
    status,
    exitCriteria: cleanStringArray(rec.exitCriteria),
    items,
    createdAtMs: finiteMs(rec.createdAtMs) ?? fallbackNowMs,
    updatedAtMs: finiteMs(rec.updatedAtMs) ?? fallbackNowMs,
  });
}

export function normalizeGoalBoardConfig(raw: unknown): GoalBoardConfigV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createEmptyGoalBoardConfig();
  }
  const rec = raw as Record<string, unknown>;
  const updatedAtMs = finiteMs(rec.updatedAtMs) ?? 0;
  const seenGoals = new Set<string>();
  const goals: GoalRecord[] = [];
  if (Array.isArray(rec.goals)) {
    for (const rawGoal of rec.goals) {
      const normalized = normalizeGoalRecord(rawGoal, updatedAtMs || Date.now());
      if (!normalized || seenGoals.has(normalized.id)) continue;
      seenGoals.add(normalized.id);
      goals.push(normalized);
    }
  }
  return {
    version: 1,
    updatedAtMs,
    goals,
  };
}

/**
 * Recomputes cycle-safe topological wave indices, automatic `pending` <-> `ready`
 * synchronization, and longest incomplete critical-path flags.
 */
export function recomputeGoalGraph(goal: GoalRecord): GoalRecord {
  const itemById = new Map(goal.items.map((item) => [item.id, item]));

  // Clean blockedBy against existing items and preserve deterministic DAG adjacency
  const cloned = goal.items.map((item) => ({
    ...item,
    blockedBy: item.blockedBy.filter((depId) => depId !== item.id && itemById.has(depId)),
    artifactPaths: [...item.artifactPaths],
  }));
  const byId = new Map(cloned.map((item) => [item.id, item]));

  // 1. Cycle-safe wave computation (dep -> item)
  const waveMemo = new Map<string, number>();
  const waveVisiting = new Set<string>();
  const computeWave = (id: string): number => {
    const cached = waveMemo.get(id);
    if (cached !== undefined) return cached;
    if (waveVisiting.has(id)) return 0;
    waveVisiting.add(id);
    const item = byId.get(id);
    let wave = 0;
    if (item && item.blockedBy.length > 0) {
      let maxDepWave = -1;
      for (const depId of item.blockedBy) {
        if (!waveVisiting.has(depId)) {
          maxDepWave = Math.max(maxDepWave, computeWave(depId));
        }
      }
      wave = maxDepWave >= 0 ? maxDepWave + 1 : 0;
    }
    waveVisiting.delete(id);
    waveMemo.set(id, wave);
    return wave;
  };
  for (const item of cloned) {
    item.wave = computeWave(item.id);
  }

  // 2. Sync readiness status (`pending` <-> `ready`)
  for (const item of cloned) {
    const allDepsCompleted = item.blockedBy.every((depId) => byId.get(depId)?.status === 'completed');
    if (item.status === 'pending' && allDepsCompleted) {
      item.status = 'ready';
    } else if (item.status === 'ready' && !allDepsCompleted) {
      item.status = 'pending';
    }
  }

  // 3. Longest-remaining-path critical-path calculation over incomplete nodes
  const incompleteIds = new Set(cloned.filter((item) => item.status !== 'completed').map((item) => item.id));
  const incompleteChildren = new Map<string, string[]>();
  for (const id of incompleteIds) {
    incompleteChildren.set(id, []);
  }
  for (const item of cloned) {
    if (!incompleteIds.has(item.id)) continue;
    for (const depId of item.blockedBy) {
      if (incompleteIds.has(depId)) {
        incompleteChildren.get(depId)!.push(item.id);
      }
    }
  }

  const depthMemo = new Map<string, { depth: number; nextId: string | null }>();
  const depthVisiting = new Set<string>();
  const computeRemainingDepth = (id: string): { depth: number; nextId: string | null } => {
    const cached = depthMemo.get(id);
    if (cached) return cached;
    if (depthVisiting.has(id)) return { depth: 1, nextId: null };
    depthVisiting.add(id);
    let bestChildDepth = 0;
    let bestChildId: string | null = null;
    for (const childId of incompleteChildren.get(id) ?? []) {
      if (depthVisiting.has(childId)) continue;
      const res = computeRemainingDepth(childId);
      if (res.depth > bestChildDepth) {
        bestChildDepth = res.depth;
        bestChildId = childId;
      }
    }
    depthVisiting.delete(id);
    const out = { depth: 1 + bestChildDepth, nextId: bestChildId };
    depthMemo.set(id, out);
    return out;
  };

  const criticalIds = new Set<string>();
  if (incompleteIds.size > 0) {
    // Only consider incomplete roots whose incomplete blockedBy count is 0
    const incompleteRoots = cloned.filter(
      (item) =>
        incompleteIds.has(item.id) && !item.blockedBy.some((depId) => incompleteIds.has(depId)),
    );
    const candidates = incompleteRoots.length > 0 ? incompleteRoots : cloned.filter((item) => incompleteIds.has(item.id));
    let bestStartId: string | null = null;
    let bestDepth = -1;
    let bestBlockedTie = -1;
    for (const candidate of candidates) {
      const info = computeRemainingDepth(candidate.id);
      const blockedScore = candidate.status === 'blocked' ? 1 : 0;
      if (info.depth > bestDepth || (info.depth === bestDepth && blockedScore > bestBlockedTie)) {
        bestDepth = info.depth;
        bestBlockedTie = blockedScore;
        bestStartId = candidate.id;
      }
    }
    let cursor = bestStartId;
    while (cursor && !criticalIds.has(cursor)) {
      criticalIds.add(cursor);
      cursor = computeRemainingDepth(cursor).nextId;
    }
  }

  for (const item of cloned) {
    item.isCriticalPath = criticalIds.has(item.id);
  }

  return {
    ...goal,
    exitCriteria: [...goal.exitCriteria],
    items: cloned,
  };
}

function hasDistinctReviewer(item: GoalWorkItem): boolean {
  const hasReviewer = Boolean(item.reviewerRole || item.reviewerBotId);
  if (!hasReviewer) return false;
  if (item.reviewerBotId && item.ownerBotId) {
    return item.reviewerBotId !== item.ownerBotId;
  }
  if (item.reviewerRole && item.ownerRole) {
    return item.reviewerRole.toLowerCase() !== item.ownerRole.toLowerCase();
  }
  return true;
}

export function applyGoalItemTransition(
  goal: GoalRecord,
  input: GoalItemTransitionInput,
  nowMs = Date.now(),
): GoalItemTransitionResult {
  const currentGraph = recomputeGoalGraph(goal);
  const existing = currentGraph.items.find((item) => item.id === input.itemId);
  if (!existing) {
    return {
      ok: false,
      errorCode: 'ITEM_NOT_FOUND',
      message: `工作项 ${input.itemId} 不存在，请先用 goal_board_get 核对节点 ID。`,
    };
  }

  let nextStatus: GoalWorkItemStatus = input.status ?? existing.status;
  if (!input.status) {
    if (input.verdict === 'FAIL') {
      nextStatus = 'in_progress';
    } else if (input.verdict === 'PASS' && existing.status === 'in_review') {
      nextStatus = 'completed';
    }
  }

  // Hard Wave Gate
  if (
    !input.force &&
    (nextStatus === 'in_progress' || nextStatus === 'in_review' || nextStatus === 'completed')
  ) {
    const byId = new Map(currentGraph.items.map((item) => [item.id, item]));
    const unmet = existing.blockedBy.filter((depId) => byId.get(depId)?.status !== 'completed');
    if (unmet.length > 0) {
      return {
        ok: false,
        errorCode: 'WAVE_GATE_BLOCKED',
        message: `工作项 ${existing.id} 尚有未完成的前置依赖 (${unmet.join(', ')})，禁止提前推进波次或完成。`,
      };
    }
  }

  // Independent Review Gate
  const nextVerdict: 'PASS' | 'FAIL' | null =
    input.verdict !== undefined
      ? input.verdict
      : nextStatus === 'completed'
        ? existing.reviewVerdict ?? null
        : existing.reviewVerdict ?? null;

  if (!input.force && nextStatus === 'completed' && hasDistinctReviewer(existing)) {
    if (nextVerdict !== 'PASS') {
      const reviewerLabel = existing.reviewerRole || existing.reviewerBotId || '指定验收人';
      return {
        ok: false,
        errorCode: 'REVIEW_REQUIRED',
        message: `工作项 ${existing.id} 配置了独立验收人 (${reviewerLabel})，请先流转至 in_review 并由验收人提交 verdict="PASS" 后再置为 completed。`,
      };
    }
  }

  const prevPendingIds = new Set(
    currentGraph.items.filter((item) => item.status === 'pending').map((item) => item.id),
  );

  const sanitizedEvidence =
    input.evidenceSummary !== undefined
      ? sanitizeGoalSummaryText(input.evidenceSummary, SUMMARY_MAX_CHARS)
      : existing.evidenceSummary;

  const sanitizedBlocker =
    input.blockerReason !== undefined
      ? sanitizeGoalSummaryText(input.blockerReason, SUMMARY_MAX_CHARS)
      : nextStatus === 'blocked'
        ? existing.blockerReason
        : undefined;

  const updatedItems = currentGraph.items.map((item) => {
    if (item.id !== existing.id) return item;
    const nextItem: GoalWorkItem = {
      ...item,
      status: nextStatus,
      ...(input.ownerSessionId?.trim() ? { ownerSessionId: input.ownerSessionId.trim() } : {}),
      ...(input.reviewerSessionId?.trim() ? { reviewerSessionId: input.reviewerSessionId.trim() } : {}),
      ...(sanitizedEvidence ? { evidenceSummary: sanitizedEvidence } : {}),
      ...(sanitizedBlocker ? { blockerReason: sanitizedBlocker } : {}),
      reviewVerdict: nextVerdict,
      updatedAtMs: nowMs,
    };
    if (!sanitizedEvidence) delete nextItem.evidenceSummary;
    if (!sanitizedBlocker) delete nextItem.blockerReason;
    if (nextStatus === 'in_progress' && !nextItem.startedAtMs) {
      nextItem.startedAtMs = nowMs;
    }
    if (nextStatus === 'in_review') {
      nextItem.submittedAtMs = nowMs;
    }
    if (nextStatus === 'completed') {
      nextItem.completedAtMs = nextItem.completedAtMs ?? nowMs;
    } else {
      delete nextItem.completedAtMs;
    }
    return nextItem;
  });

  const recomputed = recomputeGoalGraph({
    ...currentGraph,
    items: updatedItems,
    updatedAtMs: nowMs,
  });

  const newlyUnlockedIds = recomputed.items
    .filter((item) => prevPendingIds.has(item.id) && item.status === 'ready')
    .map((item) => item.id);

  const finalItem = recomputed.items.find((item) => item.id === existing.id)!;
  return {
    ok: true,
    goal: recomputed,
    item: finalItem,
    newlyUnlockedIds,
  };
}

export function computeGoalNextActions(
  goal: GoalRecord,
  opts: {
    nowMs?: number;
    sessionQueueCounts?: Record<string, number>;
    staleInProgressMs?: number;
  } = {},
): GoalNextActionsSummary {
  const graph = recomputeGoalGraph(goal);
  const nowMs = opts.nowMs ?? Date.now();
  const staleThresholdMs = opts.staleInProgressMs ?? DEFAULT_STALE_IN_PROGRESS_MS;
  const queueCounts = opts.sessionQueueCounts ?? {};

  const totalCount = graph.items.length;
  const completedCount = graph.items.filter((item) => item.status === 'completed').length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const incompleteItems = graph.items.filter((item) => item.status !== 'completed');
  const currentWave =
    incompleteItems.length > 0
      ? Math.min(...incompleteItems.map((item) => item.wave ?? 0))
      : graph.items.length > 0
        ? Math.max(...graph.items.map((item) => item.wave ?? 0))
        : 0;

  const readyToDispatch = graph.items.filter((item) => item.status === 'ready');
  const awaitingReview = graph.items.filter((item) => item.status === 'in_review');

  const criticalBlockers: GoalCriticalBlockerInfo[] = [];
  for (const item of incompleteItems) {
    const stalledMs =
      item.status === 'in_progress'
        ? Math.max(0, nowMs - (item.startedAtMs ?? item.updatedAtMs))
        : undefined;
    const isStale = item.status === 'in_progress' && stalledMs !== undefined && stalledMs >= staleThresholdMs;
    if (item.status === 'blocked' || isStale) {
      const backupLabel = item.backupOwnerRole || item.backupOwnerBotId;
      const fallbackDirective = backupLabel
        ? `建议由 PM 立即启用备用兜底角色 ${backupLabel} 接手或改派干净会话，避免整条里程碑停滞。`
        : '建议由 PM 立即介入排查或改派备用执行人，避免阻塞下游波次。';
      criticalBlockers.push({
        itemId: item.id,
        title: item.title,
        status: item.status === 'blocked' ? 'blocked' : 'in_progress',
        isCriticalPath: Boolean(item.isCriticalPath),
        ...(item.ownerRole ? { ownerRole: item.ownerRole } : {}),
        ...(item.backupOwnerRole ? { backupOwnerRole: item.backupOwnerRole } : {}),
        ...(item.backupOwnerBotId ? { backupOwnerBotId: item.backupOwnerBotId } : {}),
        ...(item.blockerReason ? { blockerReason: item.blockerReason } : {}),
        ...(stalledMs !== undefined ? { stalledMs } : {}),
        fallbackDirective,
      });
    }
  }
  criticalBlockers.sort((a, b) => Number(b.isCriticalPath) - Number(a.isCriticalPath));

  const sessionMap = new Map<string, Set<string>>();
  for (const item of incompleteItems) {
    if (item.ownerSessionId) {
      const set = sessionMap.get(item.ownerSessionId) ?? new Set<string>();
      set.add(item.id);
      sessionMap.set(item.ownerSessionId, set);
    }
    if (item.reviewerSessionId) {
      const set = sessionMap.get(item.reviewerSessionId) ?? new Set<string>();
      set.add(item.id);
      sessionMap.set(item.reviewerSessionId, set);
    }
  }

  const overloadedSessions: GoalOverloadedSessionInfo[] = [];
  for (const [sessionId, itemSet] of sessionMap.entries()) {
    const count = queueCounts[sessionId] ?? 0;
    if (count >= 4) {
      overloadedSessions.push({
        sessionId,
        queuedCount: count,
        relatedItemIds: Array.from(itemSet),
      });
    }
  }
  overloadedSessions.sort((a, b) => b.queuedCount - a.queuedCount);

  return {
    goalId: graph.id,
    progressPct,
    completedCount,
    totalCount,
    currentWave,
    readyToDispatch,
    awaitingReview,
    criticalBlockers,
    overloadedSessions,
  };
}
