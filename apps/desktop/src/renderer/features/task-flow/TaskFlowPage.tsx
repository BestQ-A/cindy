import { useMemo, useState } from 'react';
import { GitBranch, Layers, RefreshCw, Search, Target, Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  computeLineage,
  filterTaskFlowGraph,
  type TaskFlowNode,
  type TaskFlowNodeStatus,
} from '../../../shared/taskFlowGraph';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import { TaskFlowDagView } from './TaskFlowDagView';
import { TaskFlowGanttView } from './TaskFlowGanttView';
import { TaskFlowGoalBoardView } from './TaskFlowGoalBoardView';
import { TaskFlowInspector } from './TaskFlowInspector';
import {
  TASK_FLOW_TIME_WINDOW_MS,
  safeTaskFlowTr,
  type TaskFlowSwimlaneMode,
  type TaskFlowTimeWindow,
  type TaskFlowViewMode,
} from './taskFlowFormat';
import { useGoalBoard } from './useGoalBoard';
import { useTaskFlowSnapshot } from './useTaskFlowSnapshot';

export function TaskFlowPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<TaskFlowViewMode>('gantt');
  const [groupBy, setGroupBy] = useState<TaskFlowSwimlaneMode>('hierarchy');
  const [timeWindow, setTimeWindow] = useState<TaskFlowTimeWindow>('all');
  const [statusFilter, setStatusFilter] = useState<TaskFlowNodeStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [includeScheduled, setIncludeScheduled] = useState(false);
  const [onlyWithDependencies, setOnlyWithDependencies] = useState(false);
  const [expandInternalSteps, setExpandInternalSteps] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const { snapshot, loading, error, nowMs, refresh } = useTaskFlowSnapshot(includeScheduled);
  const goalBoard = useGoalBoard();

  const filtered = useMemo(() => {
    if (!snapshot) {
      return { nodes: [], edges: [], hiddenScheduledCount: 0 };
    }
    return filterTaskFlowGraph(snapshot, {
      timeWindowMs: TASK_FLOW_TIME_WINDOW_MS[timeWindow],
      nowMs,
      statusFilter,
      searchQuery,
      includeScheduled,
      onlyWithDependencies,
      expandInternalSteps,
    });
  }, [
    snapshot,
    timeWindow,
    nowMs,
    statusFilter,
    searchQuery,
    includeScheduled,
    onlyWithDependencies,
    expandInternalSteps,
  ]);

  const nodesById = useMemo(() => {
    const map = new Map<string, TaskFlowNode>();
    for (const node of filtered.nodes) map.set(node.id, node);
    return map;
  }, [filtered.nodes]);

  const activeNodeId = hoveredNodeId ?? selectedNodeId;
  const lineage = useMemo(
    () => (activeNodeId && nodesById.has(activeNodeId) ? computeLineage(activeNodeId, filtered.edges) : null),
    [activeNodeId, nodesById, filtered.edges],
  );

  const selectedNode = selectedNodeId ? (nodesById.get(selectedNodeId) ?? null) : null;

  const stats = useMemo(() => {
    const runningNodes = filtered.nodes.filter((n) => n.status === 'running').length;
    const crossDeviceEdges = filtered.edges.filter((e) => e.isCrossDevice).length;
    return {
      totalNodes: filtered.nodes.length,
      runningNodes,
      totalEdges: filtered.edges.length,
      crossDeviceEdges,
    };
  }, [filtered.nodes, filtered.edges]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--panel-bg)] text-[var(--text-primary)]">
      {/* Header */}
      <header
        className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] px-6 py-4"
        style={WINDOW_DRAG_STYLE}
      >
        <div style={WINDOW_NO_DRAG_STYLE}>
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-[var(--text-primary)]" />
            <h1 className="text-lg font-medium">{safeTaskFlowTr(t, 'taskFlow.title', '任务脉络')}</h1>
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {safeTaskFlowTr(
              t,
              'taskFlow.subtitle',
              '全局查看伙伴、跨电脑会话与任务步骤之间的依赖流向和实时时间推进',
            )}
          </p>
        </div>

        <div className="flex items-center gap-2" style={WINDOW_NO_DRAG_STYLE}>
          <div
            role="tablist"
            aria-label={safeTaskFlowTr(t, 'taskFlow.viewSwitcher', '任务脉络视图切换')}
            className="inline-flex rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'gantt'}
              onClick={() => setViewMode('gantt')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
                viewMode === 'gantt'
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <Timer className="h-3.5 w-3.5" />
              <span>{safeTaskFlowTr(t, 'taskFlow.views.gantt', '甘特时间轴')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'goals'}
              onClick={() => setViewMode('goals')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
                viewMode === 'goals'
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <Target className="h-3.5 w-3.5" />
              <span>{safeTaskFlowTr(t, 'taskFlow.views.goals', '目标看板')}</span>
              {goalBoard.nextActions && (
                <span className="rounded-full bg-[var(--panel-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                  {goalBoard.nextActions.progressPct}%
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'dag'}
              onClick={() => setViewMode('dag')}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
                viewMode === 'dag'
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <GitBranch className="h-3.5 w-3.5" />
              <span>{safeTaskFlowTr(t, 'taskFlow.views.dag', '依赖拓扑图')}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => void Promise.all([refresh(), goalBoard.refreshGoalBoard()])}
            disabled={loading || goalBoard.loading}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (loading || goalBoard.loading) && 'animate-spin')} />
            <span>{safeTaskFlowTr(t, 'taskFlow.refresh', '刷新')}</span>
          </button>
        </div>
      </header>

      {/* KPI Summary + Filters (hidden inside Goal Board tab to keep Wave columns roomy) */}
      {viewMode !== 'goals' && (
        <div className="space-y-3 border-b border-[var(--border-default)] px-6 py-3">
          {goalBoard.activeGoal && goalBoard.nextActions && (
            <button
              type="button"
              onClick={() => setViewMode('goals')}
              data-testid="active-goal-strip"
              className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Target className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--focus-ring)' }} />
                <span className="truncate font-medium text-[var(--text-primary)]">
                  {goalBoard.activeGoal.title}
                </span>
                <span className="rounded-full bg-[var(--panel-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
                  Wave {goalBoard.nextActions.currentWave + 1} · {goalBoard.nextActions.progressPct}% (
                  {goalBoard.nextActions.completedCount}/{goalBoard.nextActions.totalCount})
                </span>
                {goalBoard.nextActions.criticalBlockers.length > 0 && (
                  <span
                    className="rounded-full bg-[var(--panel-bg)] px-2 py-0.5 text-[11px] font-medium"
                    style={{ color: 'var(--card-status-error)' }}
                  >
                    {safeTaskFlowTr(t, 'taskFlow.goalBoard.blockerStripBadge', '关键路径阻塞 {{count}}', {
                      count: goalBoard.nextActions.criticalBlockers.length,
                    })}
                  </span>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">
                {safeTaskFlowTr(t, 'taskFlow.goalBoard.viewWavesAction', '查看目标波次 →')}
              </span>
            </button>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5">
            <div className="text-lg font-medium font-mono tabular-nums">{stats.totalNodes}</div>
            <div className="text-xs text-[var(--text-secondary)]">
              {safeTaskFlowTr(t, 'taskFlow.kpi.totalNodes', '总任务节点')}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5">
            <div className="text-lg font-medium font-mono tabular-nums" style={{ color: 'var(--warning-accent)' }}>
              {stats.runningNodes}
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {safeTaskFlowTr(t, 'taskFlow.kpi.runningNodes', '进行中')}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5">
            <div className="text-lg font-medium font-mono tabular-nums">{stats.totalEdges}</div>
            <div className="text-xs text-[var(--text-secondary)]">
              {safeTaskFlowTr(t, 'taskFlow.kpi.totalEdges', '依赖与交接连线')}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5">
            <div className="text-lg font-medium font-mono tabular-nums" style={{ color: 'var(--focus-ring)' }}>
              {stats.crossDeviceEdges}
            </div>
            <div className="text-xs text-[var(--text-secondary)]">
              {safeTaskFlowTr(t, 'taskFlow.kpi.crossDeviceEdges', '跨电脑协同')}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={safeTaskFlowTr(t, 'taskFlow.searchPlaceholder', '搜索任务、伙伴、电脑或分组…')}
              className="w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] py-1.5 pl-8 pr-3 text-xs outline-none focus:border-[var(--focus-ring)]"
            />
          </label>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TaskFlowNodeStatus | 'all')}
            aria-label={safeTaskFlowTr(t, 'taskFlow.filterStatusLabel', '按状态筛选')}
            className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-xs outline-none focus:border-[var(--focus-ring)]"
          >
            <option value="all">{safeTaskFlowTr(t, 'taskFlow.statusFilter.all', '全部状态')}</option>
            <option value="running">{safeTaskFlowTr(t, 'taskFlow.status.running', '进行中')}</option>
            <option value="waiting">{safeTaskFlowTr(t, 'taskFlow.status.waiting', '等待中')}</option>
            <option value="completed">{safeTaskFlowTr(t, 'taskFlow.status.completed', '已完成')}</option>
            <option value="failed">{safeTaskFlowTr(t, 'taskFlow.status.failed', '失败')}</option>
          </select>

          <button
            type="button"
            aria-pressed={expandInternalSteps}
            onClick={() => setExpandInternalSteps((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-xs transition-colors',
              expandInternalSteps
                ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
            )}
          >
            <Layers className="h-3 w-3" />
            <span>{safeTaskFlowTr(t, 'taskFlow.toggles.expandSteps', '展开内部步骤')}</span>
          </button>

          <button
            type="button"
            aria-pressed={onlyWithDependencies}
            onClick={() => setOnlyWithDependencies((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-xs transition-colors',
              onlyWithDependencies
                ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
            )}
          >
            <span>{safeTaskFlowTr(t, 'taskFlow.toggles.onlyDependencies', '仅看有依赖链路')}</span>
          </button>

          <button
            type="button"
            aria-pressed={includeScheduled}
            onClick={() => setIncludeScheduled((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-xs transition-colors',
              includeScheduled
                ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
            )}
          >
            <span>
              {safeTaskFlowTr(t, 'taskFlow.toggles.includeScheduled', '包含定时巡检 ({{count}})', {
                count: snapshot?.hiddenScheduledCount ?? filtered.hiddenScheduledCount ?? 0,
              })}
            </span>
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-[var(--error-fg)] px-3 py-1.5 text-xs text-[var(--error-fg)]">
            {error}
          </div>
        )}
        </div>
      )}

      {/* Main Canvas + Inspector */}
      <div className="flex min-h-0 flex-1 gap-4 p-4 px-6">
        {viewMode === 'goals' ? (
          <TaskFlowGoalBoardView
            goals={goalBoard.config.goals}
            activeGoal={goalBoard.activeGoal}
            nextActions={goalBoard.nextActions}
            error={goalBoard.error}
            onSelectGoal={goalBoard.selectGoalId}
            onTransitionItem={goalBoard.transitionItem}
          />
        ) : viewMode === 'gantt' ? (
          <TaskFlowGanttView
            nodes={filtered.nodes}
            edges={filtered.edges}
            nowMs={nowMs}
            selectedNodeId={selectedNodeId}
            hoveredNodeId={hoveredNodeId}
            lineage={lineage}
            groupBy={groupBy}
            timeWindow={timeWindow}
            onGroupByChange={setGroupBy}
            onTimeWindowChange={setTimeWindow}
            onSelectNode={setSelectedNodeId}
            onHoverNode={setHoveredNodeId}
          />
        ) : (
          <TaskFlowDagView
            nodes={filtered.nodes}
            edges={filtered.edges}
            nowMs={nowMs}
            selectedNodeId={selectedNodeId}
            hoveredNodeId={hoveredNodeId}
            lineage={lineage}
            onSelectNode={setSelectedNodeId}
            onHoverNode={setHoveredNodeId}
          />
        )}

        {viewMode !== 'goals' && (
          <TaskFlowInspector
            node={selectedNode}
            selfDeviceId={snapshot?.selfDeviceId ?? null}
            nodesById={nodesById}
            edges={filtered.edges}
            nowMs={nowMs}
            onSelectNode={setSelectedNodeId}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}
