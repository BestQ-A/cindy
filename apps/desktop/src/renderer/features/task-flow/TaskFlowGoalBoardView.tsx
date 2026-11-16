import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type {
  GoalItemTransitionInput,
  GoalNextActionsSummary,
  GoalRecord,
  GoalWorkItem,
} from '../../../shared/goalBoard';
import { cn } from '@/lib/utils';
import {
  formatTaskClock,
  goalItemStatusColorVar,
  goalItemStatusLabel,
  safeTaskFlowTr,
} from './taskFlowFormat';

export interface TaskFlowGoalBoardViewProps {
  goals: readonly GoalRecord[];
  activeGoal: GoalRecord | null;
  nextActions: GoalNextActionsSummary | null;
  error: string | null;
  onSelectGoal: (goalId: string) => void;
  onTransitionItem?: (
    input: { goalId: string } & GoalItemTransitionInput,
  ) => Promise<{ ok: boolean; message?: string }>;
}

export function TaskFlowGoalBoardView({
  goals,
  activeGoal,
  nextActions,
  error,
  onSelectGoal,
  onTransitionItem,
}: TaskFlowGoalBoardViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const waveGroups = useMemo(() => {
    if (!activeGoal) return [];
    const byWave = new Map<number, GoalWorkItem[]>();
    for (const item of activeGoal.items) {
      const wave = item.wave ?? 0;
      const list = byWave.get(wave) ?? [];
      list.push(item);
      byWave.set(wave, list);
    }
    return Array.from(byWave.entries()).sort((a, b) => a[0] - b[0]);
  }, [activeGoal]);

  const handleOpenSession = (sessionId: string | undefined) => {
    if (!sessionId) return;
    navigate(`/cc-agent/${encodeURIComponent(sessionId)}`);
  };

  if (!activeGoal || !nextActions) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-8 text-center"
        data-testid="task-flow-goal-board"
      >
        <Target className="h-8 w-8 text-[var(--text-tertiary)]" />
        <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">
          {safeTaskFlowTr(t, 'taskFlow.goalBoard.emptyTitle', '暂无共享目标看板')}
        </p>
        <p className="mt-1 max-w-md text-xs text-[var(--text-secondary)]">
          {safeTaskFlowTr(
            t,
            'taskFlow.goalBoard.emptyDesc',
            '当 Cindy 或团队 PM（如 M01）建立里程碑目标并通过 goal_board_upsert 写入波次与依赖后，这里会展示关键路径、波次门禁与阻塞兜底指令。',
          )}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      data-testid="task-flow-goal-board"
    >
      {/* Goal Selector + Header Summary */}
      <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        {goals.length > 1 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {goals.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onSelectGoal(g.id)}
                className={cn(
                  'rounded-full border border-[var(--border-default)] px-3 py-1 text-xs transition-colors',
                  g.id === activeGoal.id
                    ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                    : 'bg-[var(--panel-bg)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                )}
              >
                {g.title}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[var(--surface-chip)] px-2.5 py-0.5 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                Wave {nextActions.currentWave + 1}
              </span>
              <h2 className="text-sm font-medium text-[var(--text-primary)]">{activeGoal.title}</h2>
              {activeGoal.pmRole && (
                <span className="rounded-full border border-[var(--border-default)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                  PM: {activeGoal.pmRole}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{activeGoal.objective}</p>
            {activeGoal.projectPath && (
              <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
                {activeGoal.projectPath}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-base font-medium tabular-nums text-[var(--text-primary)]">
                {nextActions.progressPct}%
              </div>
              <div className="text-[11px] text-[var(--text-secondary)]">
                {nextActions.completedCount}/{nextActions.totalCount}{' '}
                {safeTaskFlowTr(t, 'taskFlow.goalBoard.itemsDone', '已完成')}
              </div>
            </div>
            {activeGoal.pmSessionId && (
              <button
                type="button"
                onClick={() => handleOpenSession(activeGoal.pmSessionId)}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--panel-bg)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
              >
                <ExternalLink className="h-3 w-3" />
                <span>{safeTaskFlowTr(t, 'taskFlow.goalBoard.openPmSession', '打开 PM 会话')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--panel-bg)]">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${nextActions.progressPct}%`,
              backgroundColor: 'var(--card-status-done)',
            }}
          />
        </div>

        {/* Action Counters + Exit Criteria */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--panel-bg)] px-2.5 py-1 text-[var(--text-secondary)]">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: 'var(--focus-ring)' }}
            />
            {safeTaskFlowTr(t, 'taskFlow.goalBoard.readyCount', '可立即派发 {{count}}', {
              count: nextActions.readyToDispatch.length,
            })}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--panel-bg)] px-2.5 py-1 text-[var(--text-secondary)]">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: 'var(--card-status-awaiting)' }}
            />
            {safeTaskFlowTr(t, 'taskFlow.goalBoard.reviewCount', '待独立验收 {{count}}', {
              count: nextActions.awaitingReview.length,
            })}
          </span>
          {activeGoal.exitCriteria.map((criterion, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] px-2 py-0.5 text-[var(--text-tertiary)]"
            >
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              <span>{criterion}</span>
            </span>
          ))}
        </div>
      </section>

      {/* Error feedback from transition */}
      {error && (
        <div className="rounded-lg border border-[var(--error-fg)] px-3 py-2 text-xs text-[var(--error-fg)]">
          {error}
        </div>
      )}

      {/* Critical-Path Blocker & Failover Alert */}
      {nextActions.criticalBlockers.length > 0 && (
        <section
          className="rounded-xl border px-4 py-3"
          style={{
            borderColor: 'var(--card-status-error)',
            backgroundColor: 'var(--surface-elevated)',
          }}
          data-testid="goal-critical-blocker-alert"
        >
          <div className="flex items-center gap-2 text-xs font-medium" style={{ color: 'var(--card-status-error)' }}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {safeTaskFlowTr(t, 'taskFlow.goalBoard.criticalAlertTitle', '关键路径阻塞 / 兜底提醒 ({{count}})', {
                count: nextActions.criticalBlockers.length,
              })}
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {nextActions.criticalBlockers.map((blocker) => (
              <div
                key={blocker.itemId}
                className="rounded-lg border border-[var(--border-default)] bg-[var(--panel-bg)] px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-medium text-[var(--text-primary)]">
                    [{blocker.itemId}] {blocker.title}
                  </span>
                  {blocker.ownerRole && (
                    <span className="text-[11px] text-[var(--text-secondary)]">
                      {safeTaskFlowTr(t, 'taskFlow.goalBoard.ownerLabel', '主责')}: {blocker.ownerRole}
                    </span>
                  )}
                  {blocker.backupOwnerRole && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--surface-chip)',
                        color: 'var(--warning-accent)',
                      }}
                    >
                      {safeTaskFlowTr(t, 'taskFlow.goalBoard.backupLabel', '兜底接手')}: {blocker.backupOwnerRole}
                    </span>
                  )}
                </div>
                {blocker.blockerReason && (
                  <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{blocker.blockerReason}</p>
                )}
                {blocker.fallbackDirective && (
                  <p className="mt-1 text-[11px] text-[var(--warning-accent)]">{blocker.fallbackDirective}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Wave Columns */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
        {waveGroups.map(([waveIndex, waveItems]) => {
          const isCurrentWave = waveIndex === nextActions.currentWave;
          return (
            <div
              key={waveIndex}
              className="flex w-80 shrink-0 flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
              data-goal-wave={waveIndex}
            >
              <div className="flex items-center justify-between border-b border-[var(--border-default)] px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium text-[var(--text-primary)]">
                    Wave {waveIndex + 1}
                  </span>
                  {isCurrentWave && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: 'var(--surface-chip)',
                        color: 'var(--focus-ring)',
                      }}
                    >
                      {safeTaskFlowTr(t, 'taskFlow.goalBoard.activeWave', '当前推进波次')}
                    </span>
                  )}
                </div>
                <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                  {waveItems.filter((i) => i.status === 'completed').length}/{waveItems.length}
                </span>
              </div>

              <div className="flex-1 space-y-2.5 overflow-y-auto p-3">
                {waveItems.map((item) => {
                  const targetSessionId = item.ownerSessionId ?? item.reviewerSessionId;
                  return (
                    <article
                      key={item.id}
                      data-goal-item-id={item.id}
                      className="rounded-lg border border-[var(--border-default)] bg-[var(--panel-bg)] p-3 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded bg-[var(--surface-chip)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--text-primary)]">
                              {item.id}
                            </span>
                            <span className="truncate font-medium text-[var(--text-primary)]">
                              {item.title}
                            </span>
                          </div>
                        </div>
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-[10px] font-medium"
                          style={{ color: goalItemStatusColorVar(item.status) }}
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: goalItemStatusColorVar(item.status) }}
                          />
                          {goalItemStatusLabel(t, item.status)}
                        </span>
                      </div>

                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {item.isCriticalPath && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: 'var(--surface-chip)',
                              color: 'var(--warning-accent)',
                            }}
                          >
                            {safeTaskFlowTr(t, 'taskFlow.goalBoard.criticalPath', '关键路径')}
                          </span>
                        )}
                        {item.blockedBy.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-[var(--surface-elevated)] px-1.5 py-0.5 font-mono text-[10px]">
                            <ArrowRight className="h-2.5 w-2.5" />
                            {safeTaskFlowTr(t, 'taskFlow.goalBoard.depsPrefix', '前置')}:{' '}
                            {item.blockedBy.join(', ')}
                          </span>
                        )}
                        {item.ownerRole && (
                          <span>
                            {safeTaskFlowTr(t, 'taskFlow.goalBoard.ownerLabel', '主责')}: {item.ownerRole}
                          </span>
                        )}
                        {item.backupOwnerRole && (
                          <span className="text-[var(--warning-accent)]">
                            {safeTaskFlowTr(t, 'taskFlow.goalBoard.backupShort', '兜底')}: {item.backupOwnerRole}
                          </span>
                        )}
                        {item.reviewerRole && (
                          <span className="inline-flex items-center gap-0.5">
                            <ShieldCheck className="h-3 w-3" />
                            {item.reviewerRole}
                            {item.reviewVerdict ? ` (${item.reviewVerdict})` : ''}
                          </span>
                        )}
                      </div>

                      {item.artifactPaths.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {item.artifactPaths.map((artifact) => (
                            <div
                              key={artifact}
                              className="flex items-center gap-1 truncate font-mono text-[10px] text-[var(--text-tertiary)]"
                              title={artifact}
                            >
                              <FileText className="h-3 w-3 shrink-0" />
                              <span className="truncate">{artifact}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.blockerReason && (
                        <p className="mt-2 rounded bg-[var(--surface-elevated)] px-2 py-1 text-[11px] text-[var(--card-status-error)]">
                          {item.blockerReason}
                        </p>
                      )}

                      {item.evidenceSummary && (
                        <p className="mt-2 rounded bg-[var(--surface-elevated)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">
                          {item.evidenceSummary}
                        </p>
                      )}

                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-[var(--border-default)] pt-2">
                        <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                          {formatTaskClock(item.updatedAtMs)}
                        </span>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {onTransitionItem && item.status === 'ready' && (
                            <button
                              type="button"
                              onClick={() =>
                                void onTransitionItem({
                                  goalId: activeGoal.id,
                                  itemId: item.id,
                                  status: 'in_progress',
                                })
                              }
                              className="rounded border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                            >
                              {safeTaskFlowTr(t, 'taskFlow.goalBoard.markStart', '标记开始')}
                            </button>
                          )}
                          {onTransitionItem && item.status === 'in_progress' && (
                            <button
                              type="button"
                              onClick={() =>
                                void onTransitionItem({
                                  goalId: activeGoal.id,
                                  itemId: item.id,
                                  status: 'in_review',
                                })
                              }
                              className="rounded border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                            >
                              {safeTaskFlowTr(t, 'taskFlow.goalBoard.submitReview', '提交验收')}
                            </button>
                          )}
                          {onTransitionItem && item.status === 'in_review' && (
                            <button
                              type="button"
                              onClick={() =>
                                void onTransitionItem({
                                  goalId: activeGoal.id,
                                  itemId: item.id,
                                  status: 'completed',
                                  verdict: 'PASS',
                                })
                              }
                              className="rounded border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-[11px] font-medium hover:bg-[var(--surface-hover)]"
                              style={{ color: 'var(--card-status-done)' }}
                            >
                              {safeTaskFlowTr(t, 'taskFlow.goalBoard.approvePass', '验收通过')}
                            </button>
                          )}
                          {targetSessionId && (
                            <button
                              type="button"
                              onClick={() => handleOpenSession(targetSessionId)}
                              className="inline-flex items-center gap-1 rounded bg-[var(--text-primary)] px-2 py-0.5 text-[11px] font-medium text-[var(--surface)] hover:opacity-90"
                            >
                              <ExternalLink className="h-3 w-3" />
                              <span>{safeTaskFlowTr(t, 'taskFlow.goalBoard.openSession', '打开会话')}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
