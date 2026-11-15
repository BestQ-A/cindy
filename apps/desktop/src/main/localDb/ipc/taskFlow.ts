import { ipcMain } from 'electron';
import { isNull, and, inArray, or, like } from 'drizzle-orm';
import {
  extractSessionPlanSteps,
  type MessageRenderSourceMessageLike,
} from '@cindy/maker-shared/message-render';

import {
  canonicalizeBotNodeId,
  canonicalizeSessionNodeId,
  parseSessionTarget,
  type TaskFlowEdge,
  type TaskFlowEdgeKind,
  type TaskFlowInternalStep,
  type TaskFlowNode,
  type TaskFlowNodeStatus,
  type TaskFlowSnapshot,
} from '../../../shared/taskFlowGraph';
import {
  getFolderBreadcrumb,
  normalizeBotHierarchyConfig,
  resolveBotFolderId,
  type BotHierarchyConfigV1,
} from '../../../shared/botHierarchy';
import { tryGetDbClient } from '../client/current';
import {
  botDelegations,
  botGroupPlans,
  botGroupPlanSteps,
  botProfiles,
  botSessionLinks,
  messages,
  orcaTeams,
  orcaWorkers,
  sessions,
  subagentRuns,
} from '../schema';
import { ownerScopedUserDataPath } from '../../appSessionState';
import { readBotHierarchyConfig } from '../../maker-ipc/botHierarchyStore';
import {
  createdSessionIds,
  readTaskResponsibilities,
} from '../../maker-ipc/botTaskResponsibility';
import { companionHomes } from '../../companion-cloud/homes';

export interface TaskFlowSnapshotRequest {
  includeScheduled?: boolean;
  includeRemote?: boolean;
  limitSessions?: number;
}

export type CrossDeviceTaskFlowReader = (
  local: TaskFlowSnapshot,
  opts?: TaskFlowSnapshotRequest,
) => Promise<TaskFlowSnapshot>;

let crossDeviceReader: CrossDeviceTaskFlowReader | null = null;

/**
 * Registers the multi-computer merger from `pluginCompanionHost` without introducing
 * a circular import or editing `maker-ipc/register.ts`.
 */
export function registerCrossDeviceTaskFlowReader(
  reader: CrossDeviceTaskFlowReader | null,
): void {
  crossDeviceReader = reader;
}

export interface TaskFlowCollectorDeps {
  db?: ReturnType<typeof tryGetDbClient> extends infer T
    ? T extends { drizzle: infer D }
      ? D
      : never
    : never;
  selfDeviceId?: string | null;
  selfDeviceName?: string | null;
  readHierarchy?: () => BotHierarchyConfigV1;
  readResponsibilities?: (botId: string) => Promise<string[]>;
  nowMs?: () => number;
}

const PLAN_AND_HANDOFF_TOOL_NEEDLES = [
  'send_to_session',
  'TodoWrite',
  'update_plan',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
] as const;

const ACTIVE_TURN_STALE_MS = 30 * 60 * 1000;

function sanitizeLabel(raw: string | null | undefined, fallback = '', max = 96): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\((?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/[^)]+\)/gi, (_m, alt: string) =>
      alt && alt.trim() ? alt.trim() : '[图片]',
    )
    .replace(/(?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/\S+/gi, (uri) =>
      /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(uri) ? '[图片]' : '[附件]',
    )
    .replace(/(?:\[(?:图片|附件)\]\s*){2,}/g, '[图片] ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned === '[图片]' && fallback) return `${fallback} (图片)`;
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : cleaned;
}

function tryJsonParse(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readStringField(
  obj: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

function deriveSessionStatus(
  row: {
    status: string;
    activeTurnStartedAt: number | null;
    lastTurnEndedAt: number | null;
    updatedAt: number;
  },
  steps: readonly TaskFlowInternalStep[],
  nowMs: number,
): TaskFlowNodeStatus {
  const activeStart = row.activeTurnStartedAt ?? 0;
  const lastEnd = row.lastTurnEndedAt ?? 0;
  if (
    activeStart > lastEnd &&
    nowMs - Math.max(activeStart, row.updatedAt) < ACTIVE_TURN_STALE_MS
  ) {
    return 'running';
  }
  if (steps.some((s) => s.status === 'in_progress')) {
    return row.status === 'archived' ? 'completed' : 'waiting';
  }
  if (steps.length > 0 && steps.every((s) => s.status === 'completed')) {
    return 'completed';
  }
  if (row.status === 'archived') return 'completed';
  if (lastEnd > 0) return 'completed';
  return 'idle';
}

function mapBotStatus(raw: string): TaskFlowNodeStatus {
  if (raw === 'paused') return 'paused';
  if (raw === 'error') return 'failed';
  if (raw === 'archived' || raw === 'deleting') return 'idle';
  return 'idle';
}

function mapSubagentStatus(raw: string): TaskFlowNodeStatus {
  if (raw === 'running') return 'running';
  if (raw === 'failed') return 'failed';
  if (raw === 'stopped') return 'paused';
  return 'completed';
}

function mapOrcaStatus(raw: string): TaskFlowNodeStatus {
  if (raw === 'running') return 'running';
  if (raw === 'error') return 'failed';
  if (raw === 'done') return 'completed';
  return 'waiting';
}

function mapGroupStepStatus(raw: string): TaskFlowNodeStatus {
  if (raw === 'running') return 'running';
  if (raw === 'failed') return 'failed';
  if (raw === 'done') return 'completed';
  return 'waiting';
}

/**
 * Collects the sanitized Task Flow snapshot for this computer from SQLite
 * (`sessions`, `bot_profiles`, `bot_session_links`, `bot_delegations`,
 * `bot_group_plans`, `orca_teams`/`orca_workers`, `subagent_runs`, `messages`)
 * plus responsibility files and bot folder hierarchy configuration.
 */
export async function collectLocalTaskFlowSnapshot(
  opts: TaskFlowSnapshotRequest = {},
  deps: TaskFlowCollectorDeps = {},
): Promise<TaskFlowSnapshot> {
  const nowMs = deps.nowMs?.() ?? Date.now();
  const db = deps.db ?? tryGetDbClient()?.drizzle;
  const selfHomeSnapshot = deps.selfDeviceId === undefined ? companionHomes.snapshot() : null;
  const selfDeviceId = deps.selfDeviceId !== undefined
    ? deps.selfDeviceId
    : (selfHomeSnapshot?.selfDeviceId ?? null);
  const selfDeviceName = deps.selfDeviceName ?? null;

  if (!db) {
    return {
      nodes: [],
      edges: [],
      selfDeviceId,
      selfDeviceName,
      observedAt: nowMs,
      hiddenScheduledCount: 0,
    };
  }

  let hierarchy: BotHierarchyConfigV1;
  try {
    hierarchy = normalizeBotHierarchyConfig((deps.readHierarchy ?? readBotHierarchyConfig)());
  } catch {
    hierarchy = normalizeBotHierarchyConfig(null);
  }

  const readResp =
    deps.readResponsibilities ??
    (async (botId: string) => {
      try {
        const root = ownerScopedUserDataPath();
        const records = await readTaskResponsibilities(root, botId);
        return createdSessionIds(records);
      } catch {
        return [];
      }
    });

  const [
    allSessions,
    allBots,
    allBotLinks,
    allDelegations,
    allGroupPlans,
    allGroupSteps,
    allOrcaTeams,
    allOrcaWorkers,
    allSubagents,
  ] = await Promise.all([
    db.select().from(sessions),
    db.select().from(botProfiles),
    db.select().from(botSessionLinks),
    db.select().from(botDelegations),
    db.select().from(botGroupPlans),
    db.select().from(botGroupPlanSteps),
    db.select().from(orcaTeams),
    db.select().from(orcaWorkers),
    db.select().from(subagentRuns),
  ]);

  const visibleSessions = allSessions.filter((s) => s.status !== 'deleted');
  const hiddenScheduledCount = visibleSessions.filter((s) => s.source === 'scheduler').length;
  const includedSessions = opts.includeScheduled
    ? visibleSessions
    : visibleSessions.filter((s) => s.source !== 'scheduler');

  const sessionLimit = opts.limitSessions ?? 240;
  const boundedSessions = [...includedSessions]
    .sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt))
    .slice(0, sessionLimit);
  const boundedSessionIds = boundedSessions.map((s) => s.id);
  const sessionById = new Map(visibleSessions.map((s) => [s.id, s]));

  // Map bot <-> session ownership and folder hierarchy breadcrumbs
  const botById = new Map(allBots.map((b) => [b.id, b]));
  const botBySessionId = new Map<string, typeof allBots[number]>();
  const canonicalSessionIds = new Set<string>();
  const folderByBotId = new Map<string, { folderId: string | null; breadcrumb: string[] }>();

  for (const bot of allBots) {
    if (bot.status === 'archived' || bot.status === 'deleting') continue;
    const folderId = resolveBotFolderId(hierarchy, bot.id, selfDeviceId);
    const breadcrumb = folderId
      ? getFolderBreadcrumb(hierarchy, folderId).map((f) => f.name)
      : [];
    folderByBotId.set(bot.id, { folderId, breadcrumb });
    if (bot.canonicalSessionId) {
      botBySessionId.set(bot.canonicalSessionId, bot);
      canonicalSessionIds.add(bot.canonicalSessionId);
    }
  }

  for (const link of allBotLinks) {
    const bot = botById.get(link.botId);
    if (!bot) continue;
    if (!botBySessionId.has(link.sessionId)) {
      botBySessionId.set(link.sessionId, bot);
    }
    if (link.role === 'canonical') {
      canonicalSessionIds.add(link.sessionId);
    }
  }

  // Targeted SQL query on relevant tool_use / tool_result messages
  const toolLikeFilters = PLAN_AND_HANDOFF_TOOL_NEEDLES.map((needle) =>
    like(messages.content, `%${needle}%`),
  );
  const relevantMessages =
    boundedSessionIds.length > 0
      ? await db
          .select()
          .from(messages)
          .where(
            and(
              inArray(messages.sessionId, boundedSessionIds),
              isNull(messages.rewindAt),
              or(
                and(inArray(messages.role, ['tool_use']), or(...toolLikeFilters)),
                inArray(messages.role, ['tool_result']),
              ),
            ),
          )
      : [];

  // Group relevant messages per session in chronological order
  const msgsBySession = new Map<string, Array<typeof relevantMessages[number]>>();
  for (const row of relevantMessages) {
    const bucket = msgsBySession.get(row.sessionId) ?? [];
    bucket.push(row);
    msgsBySession.set(row.sessionId, bucket);
  }
  for (const bucket of msgsBySession.values()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt);
  }

  const nodeMap = new Map<string, TaskFlowNode>();
  const edgeMap = new Map<string, TaskFlowEdge>();
  const addEdge = (edge: TaskFlowEdge) => {
    if (edge.from === edge.to) return;
    const dedupeKey = `${edge.from}=>${edge.to}:${edge.kind}`;
    const existing = edgeMap.get(dedupeKey);
    if (!existing) {
      edgeMap.set(dedupeKey, { ...edge, id: edge.id || dedupeKey, count: edge.count ?? 1 });
    } else {
      edgeMap.set(dedupeKey, {
        ...existing,
        count: (existing.count ?? 1) + 1,
        timestampMs: Math.max(existing.timestampMs ?? 0, edge.timestampMs ?? 0) || existing.timestampMs,
        ...(edge.label && !existing.label ? { label: edge.label } : {}),
        ...(edge.isCrossDevice ? { isCrossDevice: true } : {}),
      });
    }
  };

  // 1. Companion anchor nodes
  for (const bot of allBots) {
    if (bot.status === 'archived' || bot.status === 'deleting') continue;
    const nodeId = canonicalizeBotNodeId(selfDeviceId, bot.id);
    const meta = folderByBotId.get(bot.id);
    const canonicalSess = bot.canonicalSessionId ? sessionById.get(bot.canonicalSessionId) : undefined;
    nodeMap.set(nodeId, {
      id: nodeId,
      kind: 'companion',
      title: sanitizeLabel(bot.displayName, '伙伴'),
      subtitle: sanitizeLabel(bot.description, undefined as unknown as string) || undefined,
      status: mapBotStatus(bot.status),
      deviceId: selfDeviceId,
      ...(selfDeviceName ? { deviceName: selfDeviceName } : {}),
      botId: bot.id,
      botName: sanitizeLabel(bot.displayName, '伙伴'),
      botAvatar: bot.avatar,
      folderId: meta?.folderId ?? null,
      folderBreadcrumb: meta?.breadcrumb ?? [],
      sessionId: bot.canonicalSessionId ?? null,
      createdAtMs: bot.createdAt,
      updatedAtMs: Math.max(bot.updatedAt, canonicalSess?.updatedAt ?? 0),
    });
  }

  // 2. Session nodes + internal plan steps + fork edges
  for (const sess of boundedSessions) {
    const sessionRows = msgsBySession.get(sess.id) ?? [];
    const renderLikes: MessageRenderSourceMessageLike[] = [];
    for (const row of sessionRows) {
      const contentObj = tryJsonParse(row.content);
      const toolName = readStringField(contentObj, ['toolName', 'name']);
      if (row.role === 'tool_use' && toolName === 'send_to_session') continue;
      renderLikes.push({
        id: row.id,
        clientId: row.clientId,
        role: row.role,
        toolUseId: row.toolUseId ?? readStringField(contentObj, ['toolUseId', 'id']),
        toolName,
        toolInput: contentObj?.input ?? contentObj?.toolInput,
        content: contentObj ?? row.content,
        createdAt: new Date(row.createdAt).toISOString(),
        agentMeta: tryJsonParse(row.agentMeta),
      });
    }

    const extractedPlans = extractSessionPlanSteps(renderLikes);
    const latestPlan = extractedPlans.length > 0 ? extractedPlans[extractedPlans.length - 1] : null;
    const internalSteps: TaskFlowInternalStep[] = (latestPlan?.steps ?? []).map((step) => ({
      stepId: step.stepId,
      content: sanitizeLabel(step.content, '步骤', 90),
      status: step.status,
      ...(step.blockedBy ? { blockedBy: step.blockedBy } : {}),
      ...(step.blocks ? { blocks: step.blocks } : {}),
      ...(step.owner ? { owner: sanitizeLabel(step.owner, undefined, 40) } : {}),
      ...(step.createdAtMs !== undefined ? { createdAtMs: step.createdAtMs } : {}),
      ...(step.startedAtMs !== undefined ? { startedAtMs: step.startedAtMs } : {}),
      ...(step.completedAtMs !== undefined ? { completedAtMs: step.completedAtMs } : {}),
      ...(step.updatedAtMs !== undefined ? { updatedAtMs: step.updatedAtMs } : {}),
    }));

    const completedSteps = internalSteps.filter((s) => s.status === 'completed').length;
    const progressPct =
      internalSteps.length > 0 ? Math.round((completedSteps / internalSteps.length) * 100) : undefined;
    const ownerBot = botBySessionId.get(sess.id);
    const folderMeta = ownerBot ? folderByBotId.get(ownerBot.id) : undefined;
    const derivedStatus = deriveSessionStatus(sess, internalSteps, nowMs);

    const sessNodeId = canonicalizeSessionNodeId(selfDeviceId, sess.id);
    nodeMap.set(sessNodeId, {
      id: sessNodeId,
      kind: 'session',
      title: sanitizeLabel(sess.title, '未命名任务'),
      subtitle: ownerBot ? sanitizeLabel(ownerBot.displayName) : undefined,
      status: derivedStatus,
      source: sess.source,
      deviceId: selfDeviceId,
      ...(selfDeviceName ? { deviceName: selfDeviceName } : {}),
      botId: ownerBot?.id ?? null,
      botName: ownerBot ? sanitizeLabel(ownerBot.displayName) : null,
      botAvatar: ownerBot?.avatar ?? null,
      folderId: folderMeta?.folderId ?? null,
      folderBreadcrumb: folderMeta?.breadcrumb ?? [],
      sessionId: sess.id,
      ...(progressPct !== undefined ? { progressPct } : {}),
      ...(internalSteps.length > 0
        ? { stepCounts: { completed: completedSteps, total: internalSteps.length } }
        : {}),
      createdAtMs: sess.createdAt,
      startedAtMs: sess.userSendAt ?? sess.activeTurnStartedAt ?? sess.createdAt,
      ...(derivedStatus === 'completed'
        ? { completedAtMs: sess.lastTurnEndedAt ?? sess.updatedAt }
        : {}),
      updatedAtMs: Math.max(sess.lastActivityAt ?? 0, sess.updatedAt),
      ...(sess.agentDeviceId ? { isCrossDevice: true } : {}),
      ...(internalSteps.length > 0 ? { internalSteps } : {}),
    });

    // If session belongs to a bot and is canonical, elevate/link companion status
    if (ownerBot) {
      const botNodeId = canonicalizeBotNodeId(selfDeviceId, ownerBot.id);
      const botNode = nodeMap.get(botNodeId);
      if (botNode && derivedStatus === 'running') {
        botNode.status = 'running';
      }
      if (ownerBot.canonicalSessionId !== sess.id) {
        addEdge({
          id: `edge:bot-link:${ownerBot.id}:${sess.id}`,
          from: botNodeId,
          to: sessNodeId,
          kind: 'created_task',
          timestampMs: sess.createdAt,
        });
      }
    }

    if (sess.parentSessionId && (opts.includeScheduled || sessionById.get(sess.parentSessionId)?.source !== 'scheduler')) {
      const parentNodeId = canonicalizeSessionNodeId(selfDeviceId, sess.parentSessionId);
      if (nodeMap.has(parentNodeId) || sessionById.has(sess.parentSessionId)) {
        addEdge({
          id: `edge:fork:${sess.parentSessionId}:${sess.id}`,
          from: parentNodeId,
          to: sessNodeId,
          kind: 'forked',
          label: '分叉',
          timestampMs: sess.createdAt,
        });
      }
    }
  }

  // 3. Parse send_to_session tool calls -> created_task / handoff / reported edges
  for (const sess of boundedSessions) {
    const sessionRows = msgsBySession.get(sess.id) ?? [];
    const resultByToolUseId = new Map<string, string>();
    for (const row of sessionRows) {
      if (row.role !== 'tool_result') continue;
      const contentObj = tryJsonParse(row.content);
      const toolUseId = row.toolUseId ?? readStringField(contentObj, ['toolUseId', 'id']);
      if (!toolUseId) continue;
      const rawText =
        typeof row.content === 'string'
          ? row.content
          : readStringField(contentObj, ['content', 'result', 'text']);
      if (rawText) resultByToolUseId.set(toolUseId, rawText);
    }

    const sourceNodeId = canonicalizeSessionNodeId(selfDeviceId, sess.id);
    for (const row of sessionRows) {
      if (row.role !== 'tool_use') continue;
      const contentObj = tryJsonParse(row.content);
      const toolName = readStringField(contentObj, ['toolName', 'name']);
      if (toolName !== 'send_to_session') continue;

      const input = tryJsonParse(contentObj?.input ?? contentObj?.toolInput);
      const toolUseId = row.toolUseId ?? readStringField(contentObj, ['toolUseId', 'id']);
      const resultText = toolUseId ? resultByToolUseId.get(toolUseId) : undefined;
      const resultObj = tryJsonParse(resultText);

      const rawTarget =
        readStringField(resultObj, ['target_session_id', 'targetSessionId']) ??
        readStringField(input, ['target_session_id', 'targetSessionId', 'session_id', 'sessionId']);
      if (!rawTarget) continue;

      const parsedTarget = parseSessionTarget(rawTarget, selfDeviceId);
      const targetNodeId = canonicalizeSessionNodeId(selfDeviceId, rawTarget);
      const wakeKind =
        readStringField(resultObj, ['wake_kind', 'wakeKind']) ??
        readStringField(input, ['wake_kind', 'wakeKind']);
      const targetTitle = sanitizeLabel(
        readStringField(resultObj, ['target_title', 'targetTitle']) ??
          readStringField(input, ['target_title', 'title']),
        '',
      );
      const isCrossDevice = Boolean(parsedTarget.deviceId && parsedTarget.deviceId !== selfDeviceId);

      // Ensure a placeholder node exists if target lives on another computer or is outside local window
      if (!nodeMap.has(targetNodeId)) {
        const localTargetSess = !isCrossDevice ? sessionById.get(parsedTarget.sessionId) : undefined;
        nodeMap.set(targetNodeId, {
          id: targetNodeId,
          kind: 'session',
          title:
            sanitizeLabel(localTargetSess?.title) ||
            targetTitle ||
            (isCrossDevice ? `跨机任务 ${parsedTarget.sessionId.slice(0, 8)}` : `任务 ${parsedTarget.sessionId.slice(0, 8)}`),
          status: localTargetSess
            ? deriveSessionStatus(localTargetSess, [], nowMs)
            : 'waiting',
          source: localTargetSess?.source,
          deviceId: parsedTarget.deviceId,
          sessionId: parsedTarget.sessionId,
          createdAtMs: localTargetSess?.createdAt ?? row.createdAt,
          updatedAtMs: localTargetSess?.updatedAt ?? row.createdAt,
          isCrossDevice,
          isPlaceholder: !localTargetSess,
        });
      }

      const targetSess = !isCrossDevice ? sessionById.get(parsedTarget.sessionId) : undefined;
      const edgeKind: TaskFlowEdgeKind =
        wakeKind === 'created'
          ? 'created_task'
          : canonicalSessionIds.has(parsedTarget.sessionId) ||
              (targetSess && targetSess.createdAt < sess.createdAt)
            ? 'reported'
            : 'handoff';

      const edgeLabel =
        edgeKind === 'created_task'
          ? '新建子任务'
          : edgeKind === 'reported'
            ? '汇报结果'
            : '协同投递';

      addEdge({
        id: `edge:send:${sess.id}:${parsedTarget.sessionId}:${row.id}`,
        from: sourceNodeId,
        to: targetNodeId,
        kind: edgeKind,
        label: edgeLabel,
        timestampMs: row.createdAt,
        isCrossDevice,
      });
    }
  }

  // 4. Bot responsibility files (`created_task`)
  for (const bot of allBots) {
    if (bot.status === 'archived' || bot.status === 'deleting') continue;
    const createdIds = await readResp(bot.id).catch(() => []);
    const fromId = bot.canonicalSessionId && nodeMap.has(canonicalizeSessionNodeId(selfDeviceId, bot.canonicalSessionId))
      ? canonicalizeSessionNodeId(selfDeviceId, bot.canonicalSessionId)
      : canonicalizeBotNodeId(selfDeviceId, bot.id);
    for (const sid of createdIds) {
      const targetId = canonicalizeSessionNodeId(selfDeviceId, sid);
      if (nodeMap.has(targetId)) {
        addEdge({
          id: `edge:resp:${bot.id}:${sid}`,
          from: fromId,
          to: targetId,
          kind: 'created_task',
          label: '发起任务',
          timestampMs: nodeMap.get(targetId)?.createdAtMs ?? bot.createdAt,
        });
      }
    }
  }

  // 5. Bot delegations
  for (const del of allDelegations) {
    const fromId = del.parentSessionId
      ? canonicalizeSessionNodeId(selfDeviceId, del.parentSessionId)
      : canonicalizeBotNodeId(selfDeviceId, del.requestingBotId);
    const toId = del.childSessionId
      ? canonicalizeSessionNodeId(selfDeviceId, del.childSessionId)
      : del.targetBotId
        ? canonicalizeBotNodeId(selfDeviceId, del.targetBotId)
        : null;
    if (!toId) continue;
    if (!nodeMap.has(toId) && del.childSessionId) {
      nodeMap.set(toId, {
        id: toId,
        kind: 'session',
        title: sanitizeLabel(del.objective, '委派任务'),
        status:
          del.status === 'running' || del.status === 'queued'
            ? 'running'
            : del.status === 'waiting'
              ? 'waiting'
              : del.status === 'failed' || del.status === 'timed-out'
                ? 'failed'
                : del.status === 'cancelled'
                  ? 'paused'
                  : 'completed',
        deviceId: selfDeviceId,
        sessionId: del.childSessionId,
        botId: del.targetBotId,
        createdAtMs: del.createdAt,
        startedAtMs: del.acceptedAt ?? del.createdAt,
        ...(del.completedAt ? { completedAtMs: del.completedAt } : {}),
        updatedAtMs: del.updatedAt,
      });
    }
    if (nodeMap.has(fromId) && nodeMap.has(toId)) {
      addEdge({
        id: `edge:del:${del.id}`,
        from: fromId,
        to: toId,
        kind: 'delegated',
        label: '委派',
        timestampMs: del.createdAt,
      });
      if (del.completedAt) {
        addEdge({
          id: `edge:del-report:${del.id}`,
          from: toId,
          to: fromId,
          kind: 'reported',
          label: '完成回报',
          timestampMs: del.completedAt,
        });
      }
    }
  }

  // 6. Group collaboration plans & ordered steps
  const stepsByPlanId = new Map<string, Array<typeof allGroupSteps[number]>>();
  for (const step of allGroupSteps) {
    const bucket = stepsByPlanId.get(step.planId) ?? [];
    bucket.push(step);
    stepsByPlanId.set(step.planId, bucket);
  }
  for (const plan of allGroupPlans) {
    const steps = (stepsByPlanId.get(plan.id) ?? []).sort((a, b) => a.position - b.position);
    if (steps.length === 0) continue;
    const organizerNodeId = canonicalizeBotNodeId(selfDeviceId, plan.organizerBotId);
    let prevNodeId: string | null = nodeMap.has(organizerNodeId) ? organizerNodeId : null;
    for (const step of steps) {
      const stepNodeId = `group-step:${selfDeviceId ?? 'local'}:${plan.id}:${step.position}`;
      const meta = folderByBotId.get(step.botId);
      const status = mapGroupStepStatus(step.status);
      nodeMap.set(stepNodeId, {
        id: stepNodeId,
        kind: 'group_step',
        title: sanitizeLabel(step.task, `群聊步骤 ${step.position + 1}`),
        subtitle: `${sanitizeLabel(step.botName)} · 群协同`,
        status,
        deviceId: selfDeviceId,
        ...(selfDeviceName ? { deviceName: selfDeviceName } : {}),
        botId: step.botId,
        botName: sanitizeLabel(step.botName),
        folderId: meta?.folderId ?? null,
        folderBreadcrumb: meta?.breadcrumb ?? [],
        createdAtMs: step.startedAt ?? plan.createdAt,
        ...(step.startedAt ? { startedAtMs: step.startedAt } : {}),
        ...(step.finishedAt ? { completedAtMs: step.finishedAt } : {}),
        updatedAtMs: step.finishedAt ?? step.startedAt ?? plan.updatedAt,
      });
      if (prevNodeId) {
        addEdge({
          id: `edge:group:${plan.id}:${step.position}`,
          from: prevNodeId,
          to: stepNodeId,
          kind: prevNodeId === organizerNodeId ? 'delegated' : 'blocked_by',
          label: prevNodeId === organizerNodeId ? '组织分工' : '顺序接力',
          timestampMs: step.startedAt ?? plan.createdAt,
        });
      }
      prevNodeId = stepNodeId;
    }
  }

  // 7. Orca lead -> worker teams
  const teamById = new Map(allOrcaTeams.map((t) => [t.id, t]));
  for (const worker of allOrcaWorkers) {
    const team = teamById.get(worker.teamId);
    if (!team) continue;
    const leadNodeId = canonicalizeSessionNodeId(selfDeviceId, team.leadSessionId);
    const workerTargetDev = worker.executionDeviceId ?? selfDeviceId;
    const workerTargetSid = worker.remoteSessionId ?? worker.sessionId;
    const workerNodeId = worker.remoteSessionId
      ? canonicalizeSessionNodeId(workerTargetDev, workerTargetSid)
      : nodeMap.has(canonicalizeSessionNodeId(selfDeviceId, worker.sessionId))
        ? canonicalizeSessionNodeId(selfDeviceId, worker.sessionId)
        : `orca-worker:${selfDeviceId ?? 'local'}:${worker.id}`;

    if (!nodeMap.has(workerNodeId)) {
      nodeMap.set(workerNodeId, {
        id: workerNodeId,
        kind: worker.remoteSessionId ? 'session' : 'orca_worker',
        title: sanitizeLabel(worker.label, `Orca ${worker.role}`),
        subtitle: `Orca · ${worker.role}`,
        status: mapOrcaStatus(worker.status),
        deviceId: workerTargetDev,
        sessionId: workerTargetSid,
        createdAtMs: worker.createdAt,
        updatedAtMs: worker.updatedAt,
        isCrossDevice: Boolean(worker.executionDeviceId && worker.executionDeviceId !== selfDeviceId),
        isPlaceholder: Boolean(worker.remoteSessionId),
      });
    }
    if (nodeMap.has(leadNodeId)) {
      addEdge({
        id: `edge:orca:${worker.id}`,
        from: leadNodeId,
        to: workerNodeId,
        kind: 'orca_dispatch',
        label: `Orca · ${worker.role}`,
        timestampMs: worker.createdAt,
        isCrossDevice: Boolean(worker.executionDeviceId && worker.executionDeviceId !== selfDeviceId),
      });
    }
  }

  // 8. Durable subagent runs
  for (const run of allSubagents) {
    if (run.rewindAt !== null || run.deletedAt !== null) continue;
    const parentNodeId = canonicalizeSessionNodeId(selfDeviceId, run.sessionId);
    const parentNode = nodeMap.get(parentNodeId);
    if (!parentNode) continue;

    const subNodeId = `subagent:${selfDeviceId ?? 'local'}:${run.id}`;
    const subStatus = mapSubagentStatus(run.status);
    nodeMap.set(subNodeId, {
      id: subNodeId,
      kind: 'subagent',
      title: sanitizeLabel(run.title ?? run.description, `子代理 ${run.logicalAgentId}`),
      subtitle: `${parentNode.title} · ${run.provider}`,
      status: subStatus,
      source: parentNode.source,
      deviceId: selfDeviceId,
      ...(selfDeviceName ? { deviceName: selfDeviceName } : {}),
      botId: parentNode.botId,
      botName: parentNode.botName,
      folderId: parentNode.folderId,
      folderBreadcrumb: parentNode.folderBreadcrumb,
      sessionId: run.sessionId,
      parentNodeId,
      createdAtMs: run.startedAt,
      startedAtMs: run.startedAt,
      ...(run.endedAt ? { completedAtMs: run.endedAt } : {}),
      updatedAtMs: run.endedAt ?? run.updatedAt,
    });
    addEdge({
      id: `edge:subagent:${run.id}`,
      from: parentNodeId,
      to: subNodeId,
      kind: 'subagent_spawn',
      label: '子代理执行',
      timestampMs: run.startedAt,
    });
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    selfDeviceId,
    selfDeviceName,
    observedAt: nowMs,
    hiddenScheduledCount,
  };
}

export async function getTaskFlowSnapshot(
  opts: TaskFlowSnapshotRequest = {},
  deps?: TaskFlowCollectorDeps,
): Promise<TaskFlowSnapshot> {
  const local = await collectLocalTaskFlowSnapshot(opts, deps);
  if (opts.includeRemote !== false && crossDeviceReader && !deps?.db) {
    try {
      return await crossDeviceReader(local, opts);
    } catch {
      return local;
    }
  }
  return local;
}

export function registerTaskFlowIpc(): void {
  ipcMain.handle('local-db:task-flow:snapshot', async (_event, rawOpts?: unknown) => {
    const obj = tryJsonParse(rawOpts);
    const req: TaskFlowSnapshotRequest = {
      includeScheduled: obj?.includeScheduled === true,
      includeRemote: obj?.includeRemote !== false,
      ...(typeof obj?.limitSessions === 'number' && Number.isFinite(obj.limitSessions)
        ? { limitSessions: Math.max(10, Math.min(500, Math.trunc(obj.limitSessions))) }
        : {}),
    };
    return getTaskFlowSnapshot(req);
  });
}
