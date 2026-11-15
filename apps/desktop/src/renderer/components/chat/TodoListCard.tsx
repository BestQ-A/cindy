/**
 * TodoListCard
 * ---------------------------------------------------------------------------
 * 计划清单常驻胶囊(composer 上方,PinnedPlanPanel 专用)。
 *
 * 交互与形态 1:1 对齐 Codex IDE 扩展:
 *   - 收起态:居中小胶囊 `[进度 icon] Step N / M`,不占整行宽度;
 *   - 鼠标悬停时临时展开,移开即收起;点击/Enter 后固定展开,再次触发立即收起。
 *     浮层绝对定位(bottom-full),不改变 composer overlay 的实测高度,
 *     消息流不会因 hover 抖动。
 *   - 浮层行:completed 灰(check 圆圈),in_progress 高亮(「正在工作…」同款圆弧
 *     spinner,半径对齐空心圆 r=10;旋转挂 HTML wrapper、SVG 本体静态;
 *     reduced-motion 与会话空闲时静止),pending 正常前景色(空心圆圈)。
 *   - 胶囊图标使用静态灰度进度圆环表达当前步骤位置(它表达"第几步",不是
 *     loading 语义,不旋转);进度变化只通过圆环长度的短过渡反馈。
 *
 * 颜色沿用 ToolCallCard 同套 token(设计系统零阴影,浮层用 1px 边框):
 *   --msg-tool-card-text:    primary(icon、in_progress/pending 文本)
 *   --msg-tool-card-chevron: secondary(completed 置灰)
 */

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Circle,
  Clock,
  GitBranch,
  Link2,
  ListTodo,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  formatDuration,
  type MessageRenderPlanStepTimeline,
  type MessageRenderTodoItem,
} from '@cindy/maker-shared/message-render';

import { Spinner, type SpinnerIconComponent } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types — normalized agent plan/todo item
// ---------------------------------------------------------------------------

export type TodoItem = MessageRenderTodoItem;
export type PlanStepTimeline = MessageRenderPlanStepTimeline;

type InlinePlanViewMode = 'list' | 'gantt' | 'dag';
type FlyoutOpenMode = 'closed' | 'hover' | 'pinned';

function safeTranslate(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
  options?: Record<string, unknown>,
): string {
  try {
    const out = t(key, { defaultValue: fallback, ...options });
    if (!out || out === key || out.includes('undefined')) return fallback;
    return out;
  } catch {
    return fallback;
  }
}

function buildResolvedPlanSteps(
  todos: readonly TodoItem[],
  steps: readonly PlanStepTimeline[] | undefined,
  planStartedAtMs?: number,
): PlanStepTimeline[] {
  if (steps && steps.length === todos.length) {
    return [...steps];
  }
  const byContent = new Map<string, PlanStepTimeline>();
  if (steps) {
    for (const s of steps) byContent.set(s.content.trim(), s);
  }
  return todos.map((todo, index) => {
    const matched = steps?.[index] ?? byContent.get(todo.content.trim());
    return {
      stepId: matched?.stepId ?? `step-${index + 1}`,
      content: todo.content,
      status: todo.status,
      ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
      ...(todo.blockedBy ?? matched?.blockedBy
        ? { blockedBy: todo.blockedBy ?? matched?.blockedBy }
        : {}),
      ...(matched?.blocks ? { blocks: matched.blocks } : {}),
      ...(todo.owner ?? matched?.owner ? { owner: todo.owner ?? matched?.owner } : {}),
      createdAtMs: matched?.createdAtMs ?? planStartedAtMs,
      startedAtMs: matched?.startedAtMs,
      completedAtMs: matched?.completedAtMs,
      updatedAtMs: matched?.updatedAtMs,
    };
  });
}

function stepDurationLabel(step: PlanStepTimeline, nowMs: number, animated: boolean): string | null {
  const startMs = step.startedAtMs ?? step.createdAtMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return null;
  if (step.status === 'completed') {
    const endMs = step.completedAtMs ?? step.updatedAtMs;
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) return null;
    return formatDuration(Math.max(1000, endMs - startMs));
  }
  if (step.status === 'in_progress') {
    const endMs = animated ? nowMs : (step.updatedAtMs ?? nowMs);
    return formatDuration(Math.max(1000, endMs - startMs));
  }
  return null;
}

function computePlanStepLayers(steps: readonly PlanStepTimeline[]): Map<string, number> {
  const stepIds = new Set(steps.map((s) => s.stepId));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(steps.map((s) => [s.stepId, s]));

  const depthOf = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const step = byId.get(id);
    let maxUpstream = -1;
    for (const up of step?.blockedBy ?? []) {
      if (stepIds.has(up) && up !== id) {
        maxUpstream = Math.max(maxUpstream, depthOf(up));
      }
    }
    visiting.delete(id);
    const layer = maxUpstream + 1;
    memo.set(id, layer);
    return layer;
  };

  for (const step of steps) depthOf(step.stepId);
  return memo;
}

function InlinePlanGantt({
  steps,
  animated,
  nowMs,
  t,
}: {
  steps: readonly PlanStepTimeline[];
  animated: boolean;
  nowMs: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const layers = useMemo(() => computePlanStepLayers(steps), [steps]);
  const maxLayer = useMemo(() => Math.max(0, ...layers.values()), [layers]);

  const timeBounds = useMemo(() => {
    const pts: number[] = [];
    for (const s of steps) {
      if (typeof s.createdAtMs === 'number') pts.push(s.createdAtMs);
      if (typeof s.startedAtMs === 'number') pts.push(s.startedAtMs);
      if (typeof s.completedAtMs === 'number') pts.push(s.completedAtMs);
      if (typeof s.updatedAtMs === 'number') pts.push(s.updatedAtMs);
    }
    const minTs = pts.length > 0 ? Math.min(...pts) : 0;
    const rawMaxTs = pts.length > 0 ? Math.max(...pts, animated ? nowMs : 0) : 0;
    const hasRealSpan = pts.length >= 2 && rawMaxTs - minTs > 500;
    return {
      hasRealSpan,
      minTs,
      spanMs: Math.max(1000, rawMaxTs - minTs),
    };
  }, [steps, animated, nowMs]);

  const rowHeight = 30;
  const barGeometry = useMemo(() => {
    const denom = Math.max(1, maxLayer + 1);
    return steps.map((step, index) => {
      let leftPct = 0;
      let widthPct = 18;
      if (timeBounds.hasRealSpan) {
        const start = step.startedAtMs ?? step.createdAtMs ?? timeBounds.minTs;
        const end =
          step.status === 'completed'
            ? (step.completedAtMs ?? step.updatedAtMs ?? start + 1000)
            : step.status === 'in_progress'
              ? Math.max(start + 1000, animated ? nowMs : (step.updatedAtMs ?? nowMs))
              : start;
        leftPct = Math.max(0, Math.min(92, ((start - timeBounds.minTs) / timeBounds.spanMs) * 100));
        const rawW = ((Math.max(end, start) - start) / timeBounds.spanMs) * 100;
        widthPct = Math.max(step.status === 'pending' ? 10 : 8, Math.min(100 - leftPct, rawW));
      } else {
        const slotCount = Math.max(steps.length, denom);
        const slotIndex = maxLayer > 0 ? (layers.get(step.stepId) ?? index) : index;
        leftPct = (slotIndex / slotCount) * 86;
        widthPct = Math.max(12, Math.min(100 - leftPct, 100 / slotCount));
      }
      return {
        step,
        index,
        leftPct,
        widthPct,
        centerY: index * rowHeight + rowHeight / 2,
      };
    });
  }, [steps, timeBounds, maxLayer, layers, animated, nowMs]);

  const posById = useMemo(() => {
    const map = new Map<string, (typeof barGeometry)[number]>();
    for (const item of barGeometry) map.set(item.step.stepId, item);
    return map;
  }, [barGeometry]);

  return (
    <div className="flex flex-col gap-1.5" data-inline-plan-gantt="true">
      <div className="flex items-center justify-between text-[11px] text-[var(--msg-tool-card-chevron)]">
        <span>
          {timeBounds.hasRealSpan
            ? safeTranslate(t, 'chat.planPill.ganttTimeAxis', '按实际状态推进时间分布')
            : safeTranslate(t, 'chat.planPill.ganttStageAxis', '按阶段依赖与顺序推进')}
        </span>
        {timeBounds.hasRealSpan && (
          <span className="font-mono tabular-nums">
            {formatDuration(timeBounds.spanMs)}
          </span>
        )}
      </div>

      <div className="relative flex flex-col">
        {barGeometry.map((entry) => {
          const duration = stepDurationLabel(entry.step, nowMs, animated);
          return (
            <div
              key={entry.step.stepId}
              className="grid grid-cols-[minmax(110px,38%)_1fr_auto] items-center gap-2"
              style={{ height: rowHeight }}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {entry.step.status === 'completed' && (
                  <CircleCheck size={14} strokeWidth={1.6} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
                )}
                {entry.step.status === 'in_progress' && (
                  <PlanInProgressIcon animated={animated} variant="inline" />
                )}
                {entry.step.status === 'pending' && (
                  <Circle size={14} strokeWidth={1.5} className="shrink-0 text-[var(--msg-tool-card-text)]" />
                )}
                <span
                  className={cn(
                    'truncate text-12',
                    entry.step.status === 'completed'
                      ? 'text-[var(--msg-tool-card-chevron)]'
                      : 'text-[var(--msg-tool-card-text)]',
                  )}
                  title={entry.step.content}
                >
                  {entry.step.content}
                </span>
              </div>

              <div className="relative h-4 overflow-hidden rounded bg-[var(--todo-bar-track)]">
                <div
                  data-plan-gantt-bar={entry.step.stepId}
                  className={cn(
                    'absolute top-[3px] h-[10px] rounded-sm transition-[left,width] duration-[var(--motion-base)]',
                    entry.step.status === 'completed' && 'bg-[var(--msg-tool-card-chevron)]',
                    entry.step.status === 'in_progress' && 'bg-[var(--primary)]',
                    entry.step.status === 'pending' &&
                      'border border-dashed border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)]',
                  )}
                  style={{
                    left: `${entry.leftPct}%`,
                    width: `${entry.widthPct}%`,
                  }}
                />
              </div>

              <span className="min-w-[36px] text-right font-mono text-[11px] tabular-nums text-[var(--msg-tool-card-chevron)]">
                {duration ?? (entry.step.blockedBy?.length ? `←${entry.step.blockedBy.join(',')}` : '—')}
              </span>
            </div>
          );
        })}
        {posById.size > 0 && (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute right-[44px] top-0 h-full w-[calc(62%-56px)]"
            viewBox={`0 0 100 ${Math.max(1, barGeometry.length * rowHeight)}`}
            preserveAspectRatio="none"
          >
            {barGeometry.map((target) =>
              (target.step.blockedBy ?? []).map((srcId) => {
                const src = posById.get(srcId);
                if (!src) return null;
                const x1 = Math.min(98, src.leftPct + src.widthPct);
                const x2 = Math.max(2, target.leftPct);
                const midX = (x1 + x2) / 2;
                return (
                  <path
                    key={`${srcId}->${target.step.stepId}`}
                    d={`M ${x1} ${src.centerY} C ${midX} ${src.centerY}, ${midX} ${target.centerY}, ${x2} ${target.centerY}`}
                    fill="none"
                    stroke="var(--msg-tool-card-chevron)"
                    strokeWidth="1.2"
                    strokeDasharray="2 1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              }),
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

function InlinePlanDag({
  steps,
  animated,
  nowMs,
  t,
}: {
  steps: readonly PlanStepTimeline[];
  animated: boolean;
  nowMs: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const hasExplicitEdges = useMemo(
    () => steps.some((s) => (s.blockedBy?.length ?? 0) > 0),
    [steps],
  );
  const columns = useMemo(() => {
    const layers = computePlanStepLayers(steps);
    const grouped = new Map<number, PlanStepTimeline[]>();
    for (const step of steps) {
      const layer = layers.get(step.stepId) ?? 0;
      const bucket = grouped.get(layer) ?? [];
      bucket.push(step);
      grouped.set(layer, bucket);
    }
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [steps]);

  const titleById = useMemo(
    () => new Map(steps.map((s) => [s.stepId, s.content])),
    [steps],
  );

  return (
    <div className="flex flex-col gap-2" data-inline-plan-dag="true">
      {!hasExplicitEdges && (
        <div className="text-[11px] text-[var(--msg-tool-card-chevron)]">
          {safeTranslate(
            t,
            'chat.planPill.dagNoExplicitEdges',
            '未声明前置 blockedBy 依赖，以下步骤处于同级可执行阶段',
          )}
        </div>
      )}
      <div className="flex flex-wrap items-stretch gap-3 overflow-x-auto pb-1">
        {columns.map(([layer, layerSteps], colIdx) => (
          <div key={layer} className="flex items-start gap-2">
            {colIdx > 0 && (
              <span
                aria-hidden="true"
                className="self-center font-mono text-12 text-[var(--msg-tool-card-chevron)]"
              >
                →
              </span>
            )}
            <div className="flex min-w-[168px] max-w-[230px] flex-col gap-1.5">
              <div className="text-[11px] font-medium text-[var(--msg-tool-card-chevron)]">
                {safeTranslate(t, 'chat.planPill.dagStage', '阶段 {{index}}', { index: layer + 1 })}
              </div>
              {layerSteps.map((step) => {
                const duration = stepDurationLabel(step, nowMs, animated);
                return (
                  <div
                    key={step.stepId}
                    data-plan-dag-node={step.stepId}
                    className={cn(
                      'flex flex-col gap-1 rounded-[8px] border px-2.5 py-2',
                      step.status === 'in_progress'
                        ? 'border-[var(--focus-ring)] bg-[var(--msg-tool-card-bg)]'
                        : 'border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)]',
                    )}
                  >
                    <div className="flex items-start gap-1.5">
                      {step.status === 'completed' && (
                        <CircleCheck size={14} strokeWidth={1.6} className="mt-0.5 shrink-0 text-[var(--msg-tool-card-chevron)]" />
                      )}
                      {step.status === 'in_progress' && (
                        <PlanInProgressIcon animated={animated} variant="inline" />
                      )}
                      {step.status === 'pending' && (
                        <Circle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-[var(--msg-tool-card-text)]" />
                      )}
                      <span
                        className={cn(
                          'line-clamp-2 text-12 leading-snug',
                          step.status === 'completed'
                            ? 'text-[var(--msg-tool-card-chevron)]'
                            : 'font-medium text-[var(--msg-tool-card-text)]',
                        )}
                      >
                        {step.content}
                      </span>
                    </div>
                    {(step.blockedBy?.length || step.owner || duration) && (
                      <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--msg-tool-card-chevron)]">
                        {step.blockedBy && step.blockedBy.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded border border-[var(--msg-tool-card-border)] px-1 py-0.5">
                            <Link2 size={10} />
                            {step.blockedBy
                              .map((id) => titleById.get(id) ?? `#${id}`)
                              .join(', ')}
                          </span>
                        )}
                        {step.owner && (
                          <span className="rounded bg-[var(--todo-bar-track)] px-1 py-0.5">
                            {step.owner}
                          </span>
                        )}
                        {duration && (
                          <span className="ml-auto font-mono tabular-nums">{duration}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 静态灰度进度圆环。
 *
 * 这里没有 loading 语义:圆环表达计划当前位于第几步,而不是告诉用户“还在转”。
 * SVG 本身不挂常驻动画;步骤变化时只过渡 stroke-dashoffset,避免在聊天底部制造
 * 持续运动和额外注意力竞争。
 */
function ProgressRing({
  progress,
  size,
  strokeWidth = 1.75,
  className,
}: {
  progress: number;
  size: number;
  strokeWidth?: number;
  className?: string;
}) {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clampedProgress);

  return (
    <svg
      data-plan-progress-ring="true"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--msg-tool-card-chevron)"
        strokeWidth={strokeWidth}
        opacity={0.45}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--msg-tool-card-text)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="transition-[stroke-dashoffset] duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:transition-none"
      />
    </svg>
  );
}

/**
 * lucide LoaderCircle 是 r=9 的开口弧;计划行 Circle / CircleDot 是 r=10。
 * 不能 CSS scale(会连线宽一起放大)。保持同一 72° 缺口,把弧径收到 r=10。
 */
const PlanLoaderArc: SpinnerIconComponent = function PlanLoaderArc({
  size = 18,
  strokeWidth = 1.5,
  className,
  ...props
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-plan-loader-arc="true"
      {...props}
    >
      <path d="M22 12a10 10 0 1 1-6.91-9.51" />
    </svg>
  );
}

/**
 * 进行中步骤:「正在工作…」同款圆弧,半径对齐旁边空心圆。
 * 旋转挂 HTML wrapper,SVG 本体静态(DESIGN.md 常驻动画红线);
 * 会话空闲或 reduced-motion 时停转,不谎报还在执行。
 */
function PlanInProgressIcon({
  animated,
  variant,
}: {
  animated: boolean;
  variant: 'flyout' | 'inline';
}) {
  return (
    <Spinner
      icon={PlanLoaderArc}
      size={18}
      strokeWidth={1.5}
      spinning={animated}
      className="text-[var(--msg-tool-card-text)]"
      data-plan-step-active={variant === 'flyout' ? 'true' : undefined}
      data-inline-plan-step-active={variant === 'inline' ? 'true' : undefined}
    />
  );
}

/**
 * InlinePlanCard —— 计划在聊天时间线里的主呈现。
 *
 * 计划默认留在产生它的消息位置，用户滚回任务经过时能直接看到完整清单；
 * composer 上方的 TodoListCard 只在这张卡离开可见区域后接力。两者消费同一份
 * todos，但交互职责不同：流内卡负责阅读与历史，胶囊负责滚动后的轻量提醒。
 */
export function InlinePlanCard({
  todos,
  steps,
  startedAtMs,
  animated = false,
}: {
  todos: TodoItem[];
  steps?: PlanStepTimeline[];
  startedAtMs?: number;
  /** 只有会话确实在跑时，进行中行才慢转；失败/中断后的历史卡保持静止。 */
  animated?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [viewMode, setViewMode] = useState<InlinePlanViewMode>('list');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const resolvedSteps = useMemo(
    () => buildResolvedPlanSteps(todos, steps, startedAtMs),
    [todos, steps, startedAtMs],
  );
  const hasTimedRunningStep = useMemo(
    () =>
      animated &&
      expanded &&
      resolvedSteps.some(
        (step) =>
          step.status === 'in_progress' &&
          typeof (step.startedAtMs ?? step.createdAtMs) === 'number',
      ),
    [animated, expanded, resolvedSteps],
  );

  useEffect(() => {
    if (!hasTimedRunningStep) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasTimedRunningStep]);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const activeItem = todos.find((todo) => todo.status === 'in_progress');
  const summary = activeItem?.content ?? todos[todos.length - 1]?.content ?? '';
  const dependencyCount = resolvedSteps.reduce(
    (sum, step) => sum + (step.blockedBy?.length ?? 0),
    0,
  );
  const stepTitleById = new Map(resolvedSteps.map((s) => [s.stepId, s.content]));

  return (
    <div className="flex w-full justify-start" data-inline-plan-card="true">
      <div
        className={cn(
          'max-w-full overflow-hidden rounded-[12px] border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
        )}
      >
        <div className="flex w-full items-center gap-2 pr-[10px]">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className={cn(
              'flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 px-[14px] py-[10px]',
              'transition-opacity hover:opacity-80',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
              'focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            {expanded ? (
              <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
            ) : (
              <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
            )}
            <ListTodo size={16} className="shrink-0 text-[var(--msg-tool-card-text)]" />
            <span className="shrink-0 font-mono text-13 font-medium leading-none text-[var(--msg-tool-card-text)]">
              {completed}/{total}
            </span>
            {dependencyCount > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--msg-tool-card-border)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--msg-tool-card-chevron)]"
                data-inline-plan-dep-count={dependencyCount}
              >
                <GitBranch size={11} />
                {dependencyCount}
              </span>
            )}
            <span className="shrink-0 text-13 leading-none text-[var(--msg-tool-card-chevron)]">
              ·
            </span>
            <span className="mt-px truncate text-13 leading-none text-[var(--msg-tool-card-text)]">
              {summary}
            </span>
          </button>

          {expanded && (
            <div
              role="tablist"
              aria-label={safeTranslate(t, 'chat.planPill.viewTabs', '计划视图')}
              className="flex shrink-0 items-center gap-0.5 rounded-[8px] border border-[var(--msg-tool-card-border)] p-0.5"
            >
              {(
                [
                  ['list', safeTranslate(t, 'chat.planPill.modeList', '清单')],
                  ['gantt', safeTranslate(t, 'chat.planPill.modeGantt', '时间轴')],
                  ['dag', safeTranslate(t, 'chat.planPill.modeDag', '依赖图')],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={viewMode === mode}
                  onClick={() => setViewMode(mode)}
                  className={cn(
                    'cursor-pointer rounded px-2 py-0.5 text-[11px] leading-tight transition-colors',
                    viewMode === mode
                      ? 'bg-[var(--todo-bar-track)] font-medium text-[var(--msg-tool-card-text)]'
                      : 'text-[var(--msg-tool-card-chevron)] hover:text-[var(--msg-tool-card-text)]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {!expanded && (
          <div className="h-[2px] w-full bg-[var(--todo-bar-track)]">
            <div
              className="h-full bg-[var(--msg-tool-card-text)] transition-[width] duration-[var(--motion-base)] ease-[var(--motion-ease-move)] motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {expanded && (
          <div className="border-t border-[var(--msg-tool-card-border)] px-[14px] pb-[12px] pt-[10px]">
            {viewMode === 'list' && (
              <div className="flex flex-col gap-[4px]">
                {resolvedSteps.map((step, index) => {
                  const duration = stepDurationLabel(step, nowMs, animated);
                  return (
                    <div
                      key={`${step.stepId}:${index}`}
                      className="flex min-h-[30px] items-start gap-[10px] py-0.5"
                    >
                      <div className="mt-[2px] shrink-0">
                        {step.status === 'completed' && (
                          <CircleCheck
                            size={18}
                            strokeWidth={1.5}
                            className="shrink-0 text-[var(--msg-tool-card-chevron)]"
                          />
                        )}
                        {step.status === 'in_progress' && (
                          <PlanInProgressIcon animated={animated} variant="inline" />
                        )}
                        {step.status === 'pending' && (
                          <Circle
                            size={18}
                            strokeWidth={1.5}
                            className="shrink-0 text-[var(--msg-tool-card-text)]"
                          />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span
                            className={cn(
                              'min-w-0 break-words text-13 leading-[1.45]',
                              step.status === 'completed' &&
                                'font-normal text-[var(--msg-tool-card-chevron)]',
                              step.status === 'in_progress' &&
                                'font-medium text-[var(--msg-tool-card-text)]',
                              step.status === 'pending' && 'font-normal text-[var(--msg-tool-card-text)]',
                            )}
                          >
                            {step.content}
                          </span>
                          {duration && (
                            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums text-[var(--msg-tool-card-chevron)]">
                              <Clock size={10} />
                              {duration}
                            </span>
                          )}
                        </div>
                        {(step.blockedBy?.length || step.owner) && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--msg-tool-card-chevron)]">
                            {step.blockedBy && step.blockedBy.length > 0 && (
                              <span
                                data-inline-plan-blocked-by={step.blockedBy.join(',')}
                                className="inline-flex items-center gap-1 rounded border border-[var(--msg-tool-card-border)] px-1.5 py-0.5"
                              >
                                <Link2 size={10} />
                                {safeTranslate(t, 'chat.planPill.blockedByPrefix', '前置')}:{' '}
                                {step.blockedBy
                                  .map((id) => stepTitleById.get(id) ?? `#${id}`)
                                  .join(', ')}
                              </span>
                            )}
                            {step.owner && (
                              <span className="rounded bg-[var(--todo-bar-track)] px-1.5 py-0.5">
                                {step.owner}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {viewMode === 'gantt' && (
              <InlinePlanGantt
                steps={resolvedSteps}
                animated={animated}
                nowMs={nowMs}
                t={t as (key: string, options?: Record<string, unknown>) => string}
              />
            )}

            {viewMode === 'dag' && (
              <InlinePlanDag
                steps={resolvedSteps}
                animated={animated}
                nowMs={nowMs}
                t={t as (key: string, options?: Record<string, unknown>) => string}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TodoListCard({
  todos,
  steps,
  startedAtMs,
  animated = false,
  maxWidth,
  onDismiss,
}: {
  todos: TodoItem[];
  steps?: PlanStepTimeline[];
  startedAtMs?: number;
  /**
   * 会话是否真的在跑(调用方传 isStreaming)。只有它为真时,in_progress 行才慢转
   * ——计划因停止/失败/中断留在屏幕上时会话已空闲,继续转等于谎报"这步还在
   * 执行"。胶囊上的进度环与其它形态始终静态,不受此参数影响。
   */
  animated?: boolean;
  /** Composer/chat column width. Keeps the flyout inside clipped compact panes. */
  maxWidth?: CSSProperties['maxWidth'];
  /** Hide the current rendered snapshot without mutating the agent's plan state. */
  onDismiss?: () => void;
}) {
  const resolvedFlyoutSteps = useMemo(
    () => buildResolvedPlanSteps(todos, steps, startedAtMs),
    [todos, steps, startedAtMs],
  );
  const flyoutNowMs = Date.now();
  const { t } = useTranslation();
  const flyoutId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [openMode, setOpenMode] = useState<FlyoutOpenMode>('closed');
  const [renderFlyout, setRenderFlyout] = useState(false);
  const revealed = openMode !== 'closed';

  useEffect(() => {
    if (openMode !== 'pinned') return;

    const handlePointerDownOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) return;
      setOpenMode('closed');
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMode('closed');
    };

    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMode]);

  useEffect(() => {
    if (revealed) setRenderFlyout(true);
  }, [revealed]);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((todo) => todo.status === 'completed').length;
  const total = todos.length;
  const allDone = completed >= total;
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress');
  const pendingIndex = todos.findIndex((todo) => todo.status === 'pending');
  const currentIndex =
    activeIndex >= 0
      ? activeIndex
      : pendingIndex >= 0
        ? pendingIndex
        : Math.min(completed, total - 1);
  const currentStep = allDone ? total : currentIndex + 1;
  const stepProgress = total > 0 ? currentStep / total : 0;
  const flyoutMaxWidth =
    typeof maxWidth === 'number' && Number.isFinite(maxWidth) && maxWidth > 0
      ? `${Math.floor(maxWidth)}px`
      : typeof maxWidth === 'string' && maxWidth.length > 0
        ? maxWidth
        : null;

  return (
    <div className="pointer-events-none flex w-auto shrink-0 justify-center">
      <div
        ref={cardRef}
        className="pointer-events-auto inline-flex items-center justify-center"
        onMouseEnter={() => {
          setOpenMode((current) => (current === 'closed' ? 'hover' : current));
        }}
        onMouseLeave={() => {
          setOpenMode((current) => (current === 'hover' ? 'closed' : current));
        }}
      >
        <div
          data-plan-pill-anchor="true"
          className="pointer-events-auto relative inline-flex items-center justify-center"
        >
          {/* Collapsed pill — `[icon] Step N / M`,点击/Enter 也可切换浮层(键盘可达)。 */}
          <button
            type="button"
            onClick={() => {
              setOpenMode((current) => (current === 'pinned' ? 'closed' : 'pinned'));
            }}
            aria-controls={flyoutId}
            aria-expanded={revealed}
            className={cn(
              'flex items-center gap-2 rounded-full',
              'border border-[var(--msg-tool-card-border)]',
              'bg-[var(--msg-tool-card-bg)]',
              // 28px 紧凑高度:计划槽位仍保持 32px,上下各留约 2px,避免胶囊贴住输入框。
              'px-[14px] py-[6px]',
              'cursor-pointer select-none',
              'hover:opacity-80 transition-opacity',
            )}
          >
            {allDone ? (
              <CircleCheck
                size={14}
                strokeWidth={2}
                className="shrink-0 text-[var(--msg-tool-card-text)]"
              />
            ) : (
              <ProgressRing progress={stepProgress} size={16} strokeWidth={2} />
            )}
            <span className="text-13 leading-none tabular-nums text-[var(--msg-tool-card-text)]">
              {t('chat.planPill.step', { current: currentStep, total })}
            </span>
          </button>

          {/* 只让 hover 热区跟随胶囊；完整浮层则相对 composer 中央区域定位。 */}
          {renderFlyout && (
            <div
              className="absolute bottom-full left-1/2 h-3 min-w-full -translate-x-1/2"
              aria-hidden="true"
            />
          )}
        </div>

        {/* Hover flyout — 相对 composer 中央区域居中,被控提示把胶囊左推时也不会越界。 */}
        {renderFlyout && (
          <div
            id={flyoutId}
            data-plan-flyout-positioner="composer"
            className={cn(
              'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
              'w-max',
              flyoutMaxWidth === null && 'min-w-[220px] max-w-[min(420px,calc(100vw-32px))]',
            )}
            style={
              flyoutMaxWidth === null
                ? undefined
                : {
                    minWidth: `min(220px, ${flyoutMaxWidth})`,
                    maxWidth: `min(420px, ${flyoutMaxWidth}, calc(100vw - 32px))`,
                  }
            }
          >
            <div
              aria-hidden={!revealed}
              className={cn(
                'relative w-full origin-bottom overflow-hidden rounded-[12px]',
                'border border-[var(--msg-tool-card-border)]',
                'bg-[var(--msg-tool-card-bg)]',
                revealed ? 'animate-float-in' : 'animate-float-out',
              )}
              onAnimationEnd={() => {
                if (!revealed) setRenderFlyout(false);
              }}
            >
              {onDismiss && revealed && (
                <Tip text={t('chat.planPill.dismiss')}>
                  <button
                    type="button"
                    onClick={onDismiss}
                    aria-label={t('chat.planPill.dismiss')}
                    className={cn(
                      'absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full',
                      'text-[var(--msg-tool-card-chevron)] transition-colors',
                      'hover:bg-[var(--model-item-hover)] hover:text-[var(--msg-tool-card-text)]',
                      'active:scale-[0.98]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    )}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </Tip>
              )}
              <div
                className={cn(
                  'flex max-h-[280px] flex-col gap-[2px] overflow-y-auto py-[10px] pl-[14px]',
                  onDismiss ? 'pr-10' : 'pr-[14px]',
                )}
              >
                {resolvedFlyoutSteps.map((step, i) => {
                  const duration = stepDurationLabel(step, flyoutNowMs, animated);
                  return (
                    <div key={step.stepId ?? i} className="flex min-h-[30px] items-center gap-[10px]">
                      {/* Icon */}
                      {step.status === 'completed' && (
                        <CircleCheck
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--msg-tool-card-chevron)]"
                        />
                      )}
                      {step.status === 'in_progress' && (
                        <PlanInProgressIcon animated={animated} variant="flyout" />
                      )}
                      {step.status === 'pending' && (
                        <Circle
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-[var(--msg-tool-card-text)]"
                        />
                      )}

                      {/* Text — 对齐 Codex:completed 置灰,in_progress 高亮,pending 正常。 */}
                      <span
                        className={cn(
                          'mt-px min-w-0 flex-1 truncate text-13',
                          step.status === 'completed' &&
                            'font-normal text-[var(--msg-tool-card-chevron)]',
                          step.status === 'in_progress' &&
                            'font-semibold text-[var(--msg-tool-card-text)]',
                          step.status === 'pending' && 'font-normal text-[var(--msg-tool-card-text)]',
                        )}
                      >
                        {step.content}
                      </span>
                      {step.blockedBy && step.blockedBy.length > 0 && (
                        <span className="shrink-0 rounded border border-[var(--msg-tool-card-border)] px-1 py-0.5 text-[10px] leading-none text-[var(--msg-tool-card-chevron)]">
                          ←{step.blockedBy.join(',')}
                        </span>
                      )}
                      {duration && (
                        <span className="shrink-0 font-mono text-[10px] tabular-nums leading-none text-[var(--msg-tool-card-chevron)]">
                          {duration}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
