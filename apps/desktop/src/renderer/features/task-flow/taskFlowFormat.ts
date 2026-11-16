import { formatDuration } from '@cindy/maker-shared/message-render';
import type { GoalWorkItemStatus } from '../../../shared/goalBoard';
import type {
  TaskFlowEdgeKind,
  TaskFlowNode,
  TaskFlowNodeKind,
  TaskFlowNodeStatus,
} from '../../../shared/taskFlowGraph';

export type TaskFlowTimeWindow = '1h' | '6h' | '24h' | '7d' | 'all';
export type TaskFlowViewMode = 'goals' | 'gantt' | 'dag';
export type TaskFlowSwimlaneMode = 'hierarchy' | 'computer' | 'chain';

export const TASK_FLOW_TIME_WINDOW_MS: Record<TaskFlowTimeWindow, number | null> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  all: null,
};

export function safeTaskFlowTr(
  t: (key: string, opts?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
  opts?: Record<string, unknown>,
): string {
  try {
    const out = t(key, { defaultValue: fallback, ...opts });
    if (!out || out === key || out.includes('undefined')) return fallback;
    return out;
  } catch {
    return fallback;
  }
}

export function formatTaskDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  return formatDuration(ms);
}

export function formatTaskClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '—';
  }
}

export function formatAxisTick(ms: number, spanMs: number): string {
  try {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (spanMs >= 36 * 3_600_000) {
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (spanMs >= 30 * 60_000) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return '';
  }
}

export function nodeElapsedMs(node: TaskFlowNode, nowMs: number): number | null {
  const start = node.startedAtMs ?? node.createdAtMs;
  if (!Number.isFinite(start) || start <= 0) return null;
  const end =
    node.status === 'running'
      ? Math.max(nowMs, node.updatedAtMs, start)
      : (node.completedAtMs ?? node.updatedAtMs ?? start);
  return Math.max(0, end - start);
}

export function statusColorVar(status: TaskFlowNodeStatus): string {
  switch (status) {
    case 'running':
      return 'var(--warning-accent)';
    case 'waiting':
      return 'var(--card-status-awaiting)';
    case 'completed':
      return 'var(--card-status-done)';
    case 'failed':
      return 'var(--card-status-error)';
    case 'paused':
    case 'idle':
    default:
      return 'var(--text-tertiary)';
  }
}

export function edgeColorVar(kind: TaskFlowEdgeKind, highlighted: boolean): string {
  if (highlighted) return 'var(--primary)';
  switch (kind) {
    case 'blocked_by':
      return 'var(--warning-accent)';
    case 'handoff':
    case 'delegated':
    case 'orca_dispatch':
      return 'var(--focus-ring)';
    case 'reported':
      return 'var(--card-status-done)';
    default:
      return 'var(--border-default)';
  }
}

export function statusLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  status: TaskFlowNodeStatus,
): string {
  const fallbacks: Record<TaskFlowNodeStatus, string> = {
    running: '进行中',
    waiting: '等待中',
    completed: '已完成',
    failed: '失败',
    paused: '已暂停',
    idle: '空闲',
  };
  return safeTaskFlowTr(t, `taskFlow.status.${status}`, fallbacks[status]);
}

export function nodeKindLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  kind: TaskFlowNodeKind,
): string {
  const fallbacks: Record<TaskFlowNodeKind, string> = {
    companion: '伙伴',
    session: '任务会话',
    subagent: '子代理',
    orca_worker: '协作执行体',
    group_step: '群聊协同步骤',
    plan_step: '计划步骤',
  };
  return safeTaskFlowTr(t, `taskFlow.nodeKind.${kind}`, fallbacks[kind]);
}

export function edgeKindLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  kind: TaskFlowEdgeKind,
): string {
  const fallbacks: Record<TaskFlowEdgeKind, string> = {
    created_task: '发起任务',
    delegated: '委派执行',
    forked: '分叉衍生',
    handoff: '跨会话交接',
    reported: '结果回传',
    orca_dispatch: '团队派发',
    subagent_spawn: '拉起子代理',
    blocked_by: '前置阻塞依赖',
  };
  return safeTaskFlowTr(t, `taskFlow.edgeKind.${kind}`, fallbacks[kind]);
}

export function goalItemStatusColorVar(status: GoalWorkItemStatus): string {
  switch (status) {
    case 'in_progress':
      return 'var(--warning-accent)';
    case 'ready':
      return 'var(--focus-ring)';
    case 'in_review':
      return 'var(--card-status-awaiting)';
    case 'completed':
      return 'var(--card-status-done)';
    case 'blocked':
      return 'var(--card-status-error)';
    case 'pending':
    default:
      return 'var(--text-tertiary)';
  }
}

export function goalItemStatusLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  status: GoalWorkItemStatus,
): string {
  const fallbacks: Record<GoalWorkItemStatus, string> = {
    pending: '待前置解锁',
    ready: '可派发',
    in_progress: '进行中',
    in_review: '待验收',
    completed: '已完成',
    blocked: '受阻',
  };
  return safeTaskFlowTr(t, `taskFlow.goalStatus.${status}`, fallbacks[status]);
}
