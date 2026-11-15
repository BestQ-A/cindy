/**
 * BackgroundTasksTimelineView —— 右侧边栏「后台任务」的时间推进与依赖关系视图。
 *
 * 将当前会话内的两类任务信号统一在一条时间轴与依赖清单下呈现：
 *  1. 计划步骤依赖链（TaskCreate / TaskUpdate / TodoWrite / update_plan 抽取的 blockedBy / 耗时）
 *  2. 后台子代理 / Shell / Workflow 并发执行时段（running + completed）
 *
 * 全量使用语义 CSS token，零硬编码色值，Light/Dark 自动对齐。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  GitBranch,
  Link2,
  LoaderCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  formatDuration as formatSharedDuration,
  type ExtractedSessionPlan,
  type MessageRenderPlanStepTimeline,
} from '@cindy/maker-shared/message-render';

import { Spinner } from '@/components/ui/spinner';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { cn } from '@/lib/utils';

import { requestChatTaskFocus } from './chatTaskFocusIntent';
import type { SessionTaskItem } from './listSessionTasks';

interface TaskRunSpan {
  key: string;
  item: SessionTaskItem;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
}

interface MessageLikeRow {
  clientId?: string;
  id?: string;
  role?: string;
  toolUseId?: string;
  createdAt?: string;
}

function safeTr(
  t: (key: string, opts?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
  opts?: Record<string, unknown>,
): string {
  try {
    const res = t(key, { defaultValue: fallback, ...opts });
    if (!res || res === key || res.includes('undefined')) return fallback;
    return res;
  } catch {
    return fallback;
  }
}

function parseMs(iso: string | number | null | undefined): number | null {
  if (typeof iso === 'number') return Number.isFinite(iso) ? iso : null;
  if (typeof iso !== 'string' || !iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRunSpans(
  items: readonly SessionTaskItem[],
  messages: readonly MessageLikeRow[],
  nowMs: number,
): TaskRunSpan[] {
  const byClientId = new Map<string, number>();
  const resultByToolUseId = new Map<string, number>();

  for (const msg of messages) {
    const ms = parseMs(msg.createdAt);
    if (ms === null) continue;
    if (msg.role === 'tool_result' && msg.toolUseId) {
      const prev = resultByToolUseId.get(msg.toolUseId);
      resultByToolUseId.set(msg.toolUseId, prev !== undefined ? Math.max(prev, ms) : ms);
    } else if (msg.clientId) {
      byClientId.set(msg.clientId, ms);
    }
  }

  return items.map((item) => {
    const usageDuration =
      typeof item.update?.usage?.durationMs === 'number' &&
      Number.isFinite(item.update.usage.durationMs)
        ? Math.max(0, item.update.usage.durationMs)
        : null;
    const callMs =
      (item.toolCallClientId ? byClientId.get(item.toolCallClientId) : undefined) ??
      parseMs(item.update?.createdAt) ??
      null;
    const updateEndMs =
      item.status === 'running'
        ? nowMs
        : (parseMs(item.update?.updatedAt) ??
          (item.toolUseId ? resultByToolUseId.get(item.toolUseId) : undefined) ??
          null);

    const startMs =
      callMs ??
      (updateEndMs !== null && usageDuration !== null ? updateEndMs - usageDuration : null);
    const endMs =
      item.status === 'running'
        ? (startMs !== null ? Math.max(nowMs, startMs + 500) : nowMs)
        : (updateEndMs ??
          (startMs !== null && usageDuration !== null ? startMs + usageDuration : null));
    const durationMs =
      usageDuration ??
      (startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : null);

    return {
      key: item.key,
      item,
      startMs,
      endMs,
      durationMs,
    };
  });
}

function stepTimeRange(step: MessageRenderPlanStepTimeline, nowMs: number, isStreaming: boolean) {
  const startMs = step.startedAtMs ?? step.createdAtMs ?? null;
  if (startMs === null) return { startMs: null, endMs: null, durationMs: null };
  if (step.status === 'completed') {
    const endMs = step.completedAtMs ?? step.updatedAtMs ?? startMs;
    return { startMs, endMs, durationMs: Math.max(0, endMs - startMs) };
  }
  if (step.status === 'in_progress') {
    const endMs = isStreaming ? Math.max(nowMs, startMs) : (step.updatedAtMs ?? startMs);
    return { startMs, endMs, durationMs: Math.max(0, endMs - startMs) };
  }
  return { startMs, endMs: startMs, durationMs: null };
}

export function BackgroundTasksTimelineView({
  running,
  completed,
  plans,
  messages,
  isStreaming,
  sessionId,
  onOpenWorkflow,
}: {
  running: readonly SessionTaskItem[];
  completed: readonly SessionTaskItem[];
  plans: readonly ExtractedSessionPlan[];
  messages: readonly unknown[];
  isStreaming: boolean;
  sessionId: string | null;
  onOpenWorkflow: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  const hasLiveActivity =
    running.length > 0 ||
    (isStreaming &&
      plans.some((plan) => plan.steps.some((step) => step.status === 'in_progress')));

  useEffect(() => {
    if (!hasLiveActivity) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLiveActivity]);

  const allTasks = useMemo(() => [...running, ...completed], [running, completed]);
  const runSpans = useMemo(
    () => buildRunSpans(allTasks, messages as readonly MessageLikeRow[], nowMs),
    [allTasks, messages, nowMs],
  );
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : null;

  const bounds = useMemo(() => {
    const pts: number[] = [];
    for (const span of runSpans) {
      if (span.startMs !== null) pts.push(span.startMs);
      if (span.endMs !== null) pts.push(span.endMs);
    }
    for (const step of latestPlan?.steps ?? []) {
      const r = stepTimeRange(step, nowMs, isStreaming);
      if (r.startMs !== null) pts.push(r.startMs);
      if (r.endMs !== null) pts.push(r.endMs);
    }
    const minMs = pts.length > 0 ? Math.min(...pts) : nowMs;
    const maxMs = pts.length > 0 ? Math.max(...pts) : nowMs;
    return {
      hasAxis: pts.length >= 2 && maxMs - minMs > 500,
      minMs,
      spanMs: Math.max(1000, maxMs - minMs),
    };
  }, [runSpans, latestPlan, nowMs, isStreaming]);

  const stepTitleById = useMemo(
    () => new Map((latestPlan?.steps ?? []).map((step) => [step.stepId, step.content])),
    [latestPlan],
  );

  return (
    <div
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3 pt-2"
      data-background-tasks-timeline="true"
    >
      {bounds.hasAxis && (
        <div className="flex items-center justify-between rounded-[8px] border border-[var(--border-default)] bg-[var(--surface-chip)] px-2.5 py-1.5 text-11 text-[var(--text-secondary)]">
          <span>
            {safeTr(t, 'rightSidebar.backgroundTasks.timelineWindow', '时间跨度')}
          </span>
          <span className="font-mono tabular-nums text-[var(--text-primary)]">
            {formatSharedDuration(bounds.spanMs)}
          </span>
        </div>
      )}

      {latestPlan && latestPlan.steps.length > 0 && (
        <section className="space-y-1.5" data-background-plan-steps="true">
          <div className="flex items-center justify-between px-1 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            <span className="inline-flex items-center gap-1">
              <GitBranch size={11} aria-hidden="true" />
              {safeTr(t, 'rightSidebar.backgroundTasks.planStepsSection', '当前计划依赖步骤')}
            </span>
            <span className="font-mono tabular-nums">
              {latestPlan.steps.filter((s) => s.status === 'completed').length}/
              {latestPlan.steps.length}
            </span>
          </div>

          <div className="space-y-1">
            {latestPlan.steps.map((step, index) => {
              const range = stepTimeRange(step, nowMs, isStreaming);
              const leftPct =
                bounds.hasAxis && range.startMs !== null
                  ? Math.max(0, Math.min(92, ((range.startMs - bounds.minMs) / bounds.spanMs) * 100))
                  : (index / Math.max(1, latestPlan.steps.length)) * 84;
              const widthPct =
                bounds.hasAxis && range.startMs !== null && range.endMs !== null
                  ? Math.max(
                      8,
                      Math.min(100 - leftPct, ((range.endMs - range.startMs) / bounds.spanMs) * 100),
                    )
                  : Math.max(12, Math.min(100 - leftPct, 100 / Math.max(1, latestPlan.steps.length)));

              return (
                <div
                  key={step.stepId}
                  className="rounded-[8px] border border-[var(--border-default)] px-2 py-1.5"
                >
                  <div className="flex items-center gap-1.5">
                    {step.status === 'completed' && (
                      <CheckCircle2
                        size={13}
                        className="shrink-0 text-[var(--card-status-done)]"
                        aria-hidden="true"
                      />
                    )}
                    {step.status === 'in_progress' && (
                      <Spinner
                        icon={LoaderCircle}
                        size={13}
                        spinning={isStreaming}
                        className="shrink-0 text-[var(--warning-accent)]"
                      />
                    )}
                    {step.status === 'pending' && (
                      <Circle
                        size={13}
                        className="shrink-0 text-[var(--text-tertiary)]"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-12 leading-4',
                        step.status === 'completed'
                          ? 'text-[var(--text-secondary)]'
                          : 'text-[var(--text-primary)]',
                      )}
                      title={step.content}
                    >
                      {step.content}
                    </span>
                    {range.durationMs !== null && range.durationMs > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
                        <Clock size={10} aria-hidden="true" />
                        {formatSharedDuration(range.durationMs)}
                      </span>
                    )}
                  </div>

                  <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-chip)]">
                    <div
                      className={cn(
                        'absolute top-0 h-full rounded-full',
                        step.status === 'completed' && 'bg-[var(--card-status-done)]',
                        step.status === 'in_progress' && 'bg-[var(--warning-accent)]',
                        step.status === 'pending' &&
                          'border border-dashed border-[var(--border-default)] bg-transparent',
                      )}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    />
                  </div>

                  {(step.blockedBy?.length || step.owner) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
                      {step.blockedBy && step.blockedBy.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-[var(--surface-chip)] px-1.5 py-0.5">
                          <Link2 size={9} aria-hidden="true" />
                          {safeTr(t, 'chat.planPill.blockedByPrefix', '前置')}:{' '}
                          {step.blockedBy.map((id) => stepTitleById.get(id) ?? `#${id}`).join(', ')}
                        </span>
                      )}
                      {step.owner && (
                        <span className="rounded bg-[var(--surface-chip)] px-1.5 py-0.5">
                          {step.owner}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {runSpans.length > 0 && (
        <section className="space-y-1.5" data-background-task-spans="true">
          <div className="px-1 text-11 font-medium uppercase tracking-[0.5px] text-[var(--text-tertiary)]">
            {safeTr(t, 'rightSidebar.backgroundTasks.executionTimeline', '后台任务执行时间线')}
          </div>
          <div className="space-y-1">
            {runSpans.map((span, index) => {
              const { item } = span;
              const leftPct =
                bounds.hasAxis && span.startMs !== null
                  ? Math.max(0, Math.min(92, ((span.startMs - bounds.minMs) / bounds.spanMs) * 100))
                  : (index / Math.max(1, runSpans.length)) * 80;
              const widthPct =
                bounds.hasAxis && span.startMs !== null && span.endMs !== null
                  ? Math.max(
                      8,
                      Math.min(100 - leftPct, ((span.endMs - span.startMs) / bounds.spanMs) * 100),
                    )
                  : Math.max(16, Math.min(100 - leftPct, 100 / Math.max(1, runSpans.length)));

              const clickable =
                item.kind === 'workflow' ||
                (Boolean(sessionId) && Boolean(item.toolCallClientId) && !isSidebarWindow());

              return (
                <button
                  key={span.key}
                  type="button"
                  onClick={() => {
                    if (item.kind === 'workflow') {
                      onOpenWorkflow(item.key);
                    } else if (sessionId && item.toolCallClientId && !isSidebarWindow()) {
                      requestChatTaskFocus(sessionId, item.toolCallClientId);
                    }
                  }}
                  disabled={!clickable}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-[8px] border border-[var(--border-default)] px-2 py-1.5 text-left transition-colors',
                    clickable ? 'cursor-pointer hover:bg-[var(--surface-hover)]' : 'cursor-default',
                  )}
                >
                  <div className="flex w-full items-center gap-1.5">
                    {item.status === 'failed' ? (
                      <AlertCircle size={13} className="shrink-0 text-[var(--error-fg)]" />
                    ) : item.status === 'running' ? (
                      <Spinner
                        icon={LoaderCircle}
                        size={13}
                        spinning
                        className="shrink-0 text-[var(--warning-accent)]"
                      />
                    ) : (
                      <CheckCircle2 size={13} className="shrink-0 text-[var(--card-status-done)]" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-primary)]">
                      {item.title || safeTr(t, 'rightSidebar.backgroundTasks.untitledTask', '后台任务')}
                    </span>
                    {span.durationMs !== null && (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
                        {formatSharedDuration(Math.max(1000, span.durationMs))}
                      </span>
                    )}
                  </div>
                  <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-chip)]">
                    <div
                      className={cn(
                        'absolute top-0 h-full rounded-full',
                        item.status === 'running' && 'bg-[var(--warning-accent)]',
                        item.status === 'failed' && 'bg-[var(--error-fg)]',
                        item.status !== 'running' &&
                          item.status !== 'failed' &&
                          'bg-[var(--card-status-done)]',
                      )}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
