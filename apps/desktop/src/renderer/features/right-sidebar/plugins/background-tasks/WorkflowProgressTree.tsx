/**
 * WorkflowProgressTree —— 后台任务详情页里的 workflow 逐 agent 进度树(纯展示)。
 *
 * 约束:
 * - 数据由上层用 buildWorkflowTreeModel 合并好后传入;本组件不拉数据、不轮询、无状态;
 * - 无列表动画(DESIGN.md §14.4:静态渲染;唯一动效是 Spinner 的 compositor-only 转圈);
 * - 颜色全走语义 token,Light/Dark 同源;
 * - 状态图标/词表覆盖两套词表:wf 文件词表 + 事件流词表(start/progress → 转圈)。
 */

import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  LoaderCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatDuration } from '@/components/chat/ThinkingCard';
import { Spinner } from '@/components/ui/spinner';
import { formatModelShortLabel } from '@/lib/modelShortLabel';
import { formatCompactTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';

import {
  workflowAgentVisualState,
  type WorkflowAgentVisualState,
  type WorkflowTreeAgentRow,
  type WorkflowTreeModel,
} from './workflowProgressModel';
import { WorkflowAgentStrip } from './WorkflowAgentStrip';

const BAR_BG: Record<WorkflowAgentVisualState, string> = {
  done: 'bg-[var(--card-status-done)]',
  running: 'bg-[var(--warning-accent)]',
  failed: 'bg-[var(--error-fg)]',
  queued: 'bg-[var(--surface-chip)]',
};

interface WorkflowProgressTreeProps {
  model: WorkflowTreeModel;
}

function agentStateIcon(state: string) {
  switch (state) {
    case 'done':
    case 'completed':
      return CheckCircle2;
    case 'failed':
    case 'error':
      return AlertCircle;
    case 'stopped':
    case 'killed':
      return CircleStop;
    case 'queued':
    case 'pending':
    case 'start':
      return CircleDashed;
    default:
      return LoaderCircle; // running / progress / 未知 → 转圈
  }
}

/** 非终态且非等待态(running/progress/未知)才转圈。'start' 对齐官方 CLI 与
 *  方块条:已入队未跑,不转圈(避免同屏「树行转圈 vs 方块灰」自相矛盾)。 */
function isSpinning(state: string): boolean {
  switch (state) {
    case 'done':
    case 'completed':
    case 'failed':
    case 'error':
    case 'stopped':
    case 'killed':
    case 'queued':
    case 'pending':
    case 'start':
      return false;
    default:
      return true;
  }
}

export function WorkflowProgressTree({ model }: WorkflowProgressTreeProps) {
  const { t } = useTranslation();
  // agent 行与 logs 都空(刚启动 / 未 spawn agent 就结束的 workflow)也照渲染:
  // 聚合行至少有 status,不能返回 null —— 上层按 model 有无选组件,这里再空手
  // 而归会让详情正文整个空白。

  const { aggregate } = model;
  const metaParts: string[] = [];
  if (typeof aggregate.agentCount === 'number') {
    metaParts.push(t('chat.workflowTree.agentsCount', { count: aggregate.agentCount }));
  }
  metaParts.push(
    t(`chat.workflowTree.state.${aggregate.status}`, { defaultValue: aggregate.status }),
  );
  if (typeof aggregate.totalTokens === 'number') {
    metaParts.push(
      t('usageDashboard.tokensOnly', { tokens: formatCompactTokens(aggregate.totalTokens) }),
    );
  }
  if (typeof aggregate.totalToolCalls === 'number') {
    metaParts.push(t('chat.agentTask.toolUses', { count: aggregate.totalToolCalls }));
  }
  if (typeof aggregate.durationMs === 'number') {
    metaParts.push(formatDuration(aggregate.durationMs, t));
  }

  const stripCells = model.groups.flatMap((group) =>
    group.agents.map((row) => ({
      ...(row.state !== undefined ? { state: row.state } : {}),
      label: row.label,
    })),
  );
  const maxDurationMs = Math.max(
    aggregate.durationMs ?? 0,
    ...model.groups.flatMap((g) =>
      g.agents.map((a) => (typeof a.durationMs === 'number' ? a.durationMs : 0)),
    ),
    1000,
  );
  const titledGroupCount = model.groups.filter((g) => Boolean(g.title)).length;

  return (
    <div className="space-y-2">
      <div className="text-12 leading-4 text-[var(--text-secondary)]">
        {metaParts.join(' · ')}
      </div>
      {/* 逐 agent 状态方块条:详情页不截断,大编队一眼总览。 */}
      {stripCells.length > 0 && <WorkflowAgentStrip cells={stripCells} />}
      {titledGroupCount > 1 && (
        <div
          className="flex flex-wrap items-center gap-1 text-11 text-[var(--text-tertiary)]"
          data-workflow-stage-chain="true"
        >
          {model.groups
            .filter((g) => Boolean(g.title))
            .map((g, idx) => (
              <span key={`${g.title}-${idx}`} className="inline-flex items-center gap-1">
                {idx > 0 && <span aria-hidden="true">→</span>}
                <span className="rounded bg-[var(--surface-chip)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                  {idx + 1}. {g.title}
                </span>
              </span>
            ))}
        </div>
      )}
      {model.logs.length > 0 && (
        <div className="space-y-0.5">
          {model.logs.map((line, index) => (
            // logs 是只读快照,快照内顺序稳定,index key 足够。
            <div key={index} className="truncate text-12 leading-4 text-[var(--text-tertiary)]">
              {line}
            </div>
          ))}
        </div>
      )}
      {model.groups.map((group, groupIndex) => (
        <div key={group.title ?? `orphan-${groupIndex}`} className="space-y-1">
          {group.title && (
            <div className="truncate text-11 font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              {groupIndex > 0 && <span className="mr-1">↳</span>}
              {group.title}
              {group.detail && <span className="normal-case"> · {group.detail}</span>}
            </div>
          )}
          {group.agents.map((row) => (
            <AgentRow key={row.key} row={row} maxDurationMs={maxDurationMs} />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentRow({
  row,
  maxDurationMs,
}: {
  row: WorkflowTreeAgentRow;
  maxDurationMs: number;
}) {
  const { t } = useTranslation();
  const Icon = agentStateIcon(row.state);
  const spinning = isSpinning(row.state);
  const modelLabel = formatModelShortLabel(row.model);
  const stateLabel = t(`chat.workflowTree.state.${row.state}`, { defaultValue: row.state });
  const isErrorState = row.state === 'failed' || row.state === 'error';
  const isDoneState = row.state === 'done' || row.state === 'completed';
  // 行尾动态文本:error/failed → error(缺失用 i18n 兜底);done → resultPreview;
  // 进行中(running/start/progress/未知)→ lastToolName · lastToolSummary。
  const trailing = isErrorState
    ? (row.error ?? t('chat.workflowTree.endedEarly'))
    : isDoneState
      ? row.resultPreview
      : spinning && row.lastToolName
        ? row.lastToolSummary
          ? `${row.lastToolName} · ${row.lastToolSummary}`
          : row.lastToolName
        : undefined;

  const visualState = workflowAgentVisualState(row.state);
  const durationPct =
    typeof row.durationMs === 'number' && maxDurationMs > 0
      ? Math.max(6, Math.min(100, (row.durationMs / maxDurationMs) * 100))
      : null;

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-2">
        <Spinner
          icon={Icon}
          size={13}
          spinning={spinning}
          aria-label={stateLabel}
          className={cn(
            'shrink-0 text-[var(--text-secondary)]',
            isErrorState && 'text-[var(--error-fg)]',
          )}
        />
        <span className="min-w-0 truncate text-13 leading-5 text-[var(--text-primary)]">
          {row.label}
        </span>
        {modelLabel && (
          <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 leading-4 text-[var(--text-tertiary)]">
            {modelLabel}
          </span>
        )}
        {typeof row.attempt === 'number' && row.attempt > 1 && (
          <span className="shrink-0 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('chat.workflowTree.attempt', { count: row.attempt })}
          </span>
        )}
        {trailing && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-12 leading-4',
              isErrorState ? 'text-[var(--error-fg)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {trailing}
          </span>
        )}
        {isDoneState && typeof row.durationMs === 'number' && (
          <span className="shrink-0 text-11 leading-4 text-[var(--text-tertiary)]">
            {formatDuration(row.durationMs, t)}
          </span>
        )}
      </div>
      {durationPct !== null && (
        <div className="ml-5 h-1 overflow-hidden rounded-full bg-[var(--surface-chip)]">
          <div
            className={`h-full rounded-full ${BAR_BG[visualState]}`}
            style={{ width: `${durationPct}%` }}
          />
        </div>
      )}
    </div>
  );
}
