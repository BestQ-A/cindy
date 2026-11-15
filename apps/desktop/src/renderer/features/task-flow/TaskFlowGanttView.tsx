import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  buildTaskFlowSwimlanes,
  type TaskFlowEdge,
  type TaskFlowLineage,
  type TaskFlowNode,
} from '../../../shared/taskFlowGraph';
import { cn } from '@/lib/utils';
import {
  edgeColorVar,
  edgeKindLabel,
  formatAxisTick,
  formatTaskDuration,
  nodeElapsedMs,
  nodeKindLabel,
  safeTaskFlowTr,
  statusColorVar,
  statusLabel,
  type TaskFlowSwimlaneMode,
  type TaskFlowTimeWindow,
} from './taskFlowFormat';

export interface TaskFlowGanttViewProps {
  nodes: readonly TaskFlowNode[];
  edges: readonly TaskFlowEdge[];
  nowMs: number;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  lineage: TaskFlowLineage | null;
  groupBy: TaskFlowSwimlaneMode;
  timeWindow: TaskFlowTimeWindow;
  onGroupByChange: (mode: TaskFlowSwimlaneMode) => void;
  onTimeWindowChange: (windowKey: TaskFlowTimeWindow) => void;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
}

const LANE_HEADER_HEIGHT = 34;
const ROW_HEIGHT = 46;
const TICK_COUNT = 5;

const TIME_WINDOW_OPTIONS: readonly TaskFlowTimeWindow[] = ['1h', '6h', '24h', '7d', 'all'];
const GROUP_OPTIONS: readonly TaskFlowSwimlaneMode[] = ['hierarchy', 'computer', 'chain'];

export function TaskFlowGanttView({
  nodes,
  edges,
  nowMs,
  selectedNodeId,
  hoveredNodeId,
  lineage,
  groupBy,
  timeWindow,
  onGroupByChange,
  onTimeWindowChange,
  onSelectNode,
  onHoverNode,
}: TaskFlowGanttViewProps) {
  const { t } = useTranslation();
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => new Set());
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [trackWidth, setTrackWidth] = useState(760);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateWidth = () => {
      const next = el.clientWidth;
      if (next > 120) setTrackWidth(next);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => buildTaskFlowSwimlanes(nodes, edges, groupBy, nowMs),
    [nodes, edges, groupBy, nowMs],
  );

  const timeBounds = useMemo(() => {
    const min = layout.minTimeMs;
    const hasRunning = nodes.some((n) => n.status === 'running');
    const max = Math.max(layout.maxTimeMs, hasRunning ? nowMs : layout.maxTimeMs);
    const span = Math.max(1000, max - min);
    const nowPct = nowMs >= min && nowMs <= max ? ((nowMs - min) / span) * 100 : null;
    const ticks = Array.from({ length: TICK_COUNT }, (_, idx) => {
      const ratio = idx / (TICK_COUNT - 1);
      const ts = min + span * ratio;
      return { ratio, label: formatAxisTick(ts, span) };
    });
    return { min, max, span, nowPct, ticks };
  }, [layout.minTimeMs, layout.maxTimeMs, nodes, nowMs]);

  const geometry = useMemo(() => {
    type RowItem =
      | { type: 'lane'; laneId: string; label: string; deviceName?: string | null; count: number; hasRunning: boolean; top: number }
      | { type: 'node'; laneId: string; node: TaskFlowNode; top: number; leftPct: number; widthPct: number };

    const rows: RowItem[] = [];
    const barCenterById = new Map<string, { startX: number; endX: number; centerY: number }>();
    let cursorY = 0;

    for (const lane of layout.lanes) {
      const isCollapsed = collapsedLanes.has(lane.id);
      rows.push({
        type: 'lane',
        laneId: lane.id,
        label: lane.label,
        deviceName: lane.deviceName,
        count: lane.nodes.length,
        hasRunning: lane.nodes.some((n) => n.status === 'running'),
        top: cursorY,
      });
      cursorY += LANE_HEADER_HEIGHT;
      if (isCollapsed) continue;

      for (const node of lane.nodes) {
        const start = node.startedAtMs ?? node.createdAtMs;
        const end =
          node.status === 'running'
            ? Math.max(nowMs, node.updatedAtMs, start)
            : (node.completedAtMs ?? node.updatedAtMs ?? start);
        const leftPct = Math.max(
          0,
          Math.min(97, ((start - timeBounds.min) / timeBounds.span) * 100),
        );
        const rawWidthPct = ((Math.max(end, start) - start) / timeBounds.span) * 100;
        const widthPct = Math.max(
          node.status === 'waiting' || node.status === 'idle' ? 2.5 : 3.5,
          Math.min(100 - leftPct, rawWidthPct),
        );
        const centerY = cursorY + ROW_HEIGHT / 2;
        rows.push({
          type: 'node',
          laneId: lane.id,
          node,
          top: cursorY,
          leftPct,
          widthPct,
        });
        barCenterById.set(node.id, {
          startX: (leftPct / 100) * trackWidth,
          endX: ((leftPct + widthPct) / 100) * trackWidth,
          centerY,
        });
        cursorY += ROW_HEIGHT;
      }
    }

    return {
      rows,
      totalHeight: Math.max(120, cursorY),
      barCenterById,
    };
  }, [layout.lanes, collapsedLanes, timeBounds, nowMs, trackWidth]);

  const arrowPaths = useMemo(() => {
    return edges.flatMap((edge) => {
      const fromBar = geometry.barCenterById.get(edge.from);
      const toBar = geometry.barCenterById.get(edge.to);
      if (!fromBar || !toBar) return [];
      const fromX = Math.max(4, Math.min(trackWidth - 4, fromBar.endX));
      const toX = Math.max(4, Math.min(trackWidth - 4, toBar.startX));
      const fromY = fromBar.centerY;
      const toY = toBar.centerY;
      const dx = Math.abs(toX - fromX);
      const bend = Math.max(24, dx * 0.45);
      const c1x = Math.min(trackWidth - 2, fromX + bend);
      const c2x = Math.max(2, toX - bend);
      const path = `M ${fromX} ${fromY} C ${c1x} ${fromY}, ${c2x} ${toY}, ${toX} ${toY}`;
      return [{ edge, path }];
    });
  }, [edges, geometry.barCenterById, trackWidth]);

  const activeNodeId = hoveredNodeId ?? selectedNodeId;
  const toggleLane = (laneId: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  };

  const groupLabels: Record<TaskFlowSwimlaneMode, string> = {
    hierarchy: safeTaskFlowTr(t, 'taskFlow.groupBy.hierarchy', '按分组层级'),
    computer: safeTaskFlowTr(t, 'taskFlow.groupBy.computer', '按电脑'),
    chain: safeTaskFlowTr(t, 'taskFlow.groupBy.chain', '按任务链路'),
  };

  const windowLabels: Record<TaskFlowTimeWindow, string> = {
    '1h': safeTaskFlowTr(t, 'taskFlow.window.1h', '1 小时'),
    '6h': safeTaskFlowTr(t, 'taskFlow.window.6h', '6 小时'),
    '24h': safeTaskFlowTr(t, 'taskFlow.window.24h', '24 小时'),
    '7d': safeTaskFlowTr(t, 'taskFlow.window.7d', '7 天'),
    all: safeTaskFlowTr(t, 'taskFlow.window.all', '全部'),
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      data-testid="task-flow-gantt"
    >
      {/* Controls strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-default)] px-3 py-2">
        <div className="flex items-center gap-1" role="group" aria-label={safeTaskFlowTr(t, 'taskFlow.groupBy.label', '泳道分组')}>
          <span className="mr-1 text-xs text-[var(--text-secondary)]">
            {safeTaskFlowTr(t, 'taskFlow.groupBy.label', '泳道分组')}:
          </span>
          {GROUP_OPTIONS.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={groupBy === mode}
              onClick={() => onGroupByChange(mode)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                groupBy === mode
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              )}
            >
              {groupLabels[mode]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label={safeTaskFlowTr(t, 'taskFlow.window.label', '时间范围')}>
          <span className="mr-1 text-xs text-[var(--text-secondary)]">
            {safeTaskFlowTr(t, 'taskFlow.window.label', '时间范围')}:
          </span>
          {TIME_WINDOW_OPTIONS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={timeWindow === w}
              onClick={() => onTimeWindowChange(w)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                timeWindow === w
                  ? 'bg-[var(--surface-chip)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              )}
            >
              {windowLabels[w]}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {layout.lanes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-10 text-sm text-[var(--text-secondary)]">
          {safeTaskFlowTr(t, 'taskFlow.empty', '当前筛选条件下暂无任务轨迹。')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {/* Sticky time axis header */}
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(220px,30%)_1fr] border-b border-[var(--border-default)] bg-[var(--surface-elevated)]">
            <div className="flex items-center justify-between border-r border-[var(--border-default)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)]">
              <span>{safeTaskFlowTr(t, 'taskFlow.columns.taskItem', '任务项 / 伙伴')}</span>
              <span>{safeTaskFlowTr(t, 'taskFlow.columns.count', '{{count}} 项', { count: nodes.length })}</span>
            </div>
            <div className="relative flex items-center justify-between px-3 py-2 text-[11px] font-mono tabular-nums text-[var(--text-tertiary)]">
              {timeBounds.ticks.map((tick, idx) => (
                <span key={idx}>{tick.label}</span>
              ))}
              {timeBounds.nowPct !== null && (
                <span
                  className="pointer-events-none absolute bottom-0 top-0 border-l border-dashed border-[var(--warning-accent)] pl-1 text-[10px] font-sans font-medium text-[var(--warning-accent)]"
                  style={{ left: `${timeBounds.nowPct}%` }}
                >
                  Now
                </span>
              )}
            </div>
          </div>

          {/* Synchronized Left + Right Gantt Body */}
          <div className="grid grid-cols-[minmax(220px,30%)_1fr]" style={{ minHeight: geometry.totalHeight }}>
            {/* Left Label Column */}
            <div className="relative border-r border-[var(--border-default)]">
              {geometry.rows.map((row) => {
                if (row.type === 'lane') {
                  const collapsed = collapsedLanes.has(row.laneId);
                  return (
                    <button
                      key={`left-lane:${row.laneId}`}
                      type="button"
                      onClick={() => toggleLane(row.laneId)}
                      aria-expanded={!collapsed}
                      style={{ height: LANE_HEADER_HEIGHT }}
                      className="flex w-full items-center justify-between gap-2 border-b border-[var(--border-default)] bg-[var(--surface)] px-3 text-left text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate">{row.label}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {row.hasRunning && (
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: 'var(--warning-accent)' }}
                          />
                        )}
                        <span>{row.count}</span>
                      </span>
                    </button>
                  );
                }

                const { node } = row;
                const isSelected = selectedNodeId === node.id;
                const isRelated = !activeNodeId || Boolean(lineage?.relatedNodeIds.has(node.id));
                const breadcrumb = node.folderBreadcrumb?.join(' / ');
                return (
                  <button
                    key={`left-node:${node.id}`}
                    type="button"
                    onClick={() => onSelectNode(node.id)}
                    onMouseEnter={() => onHoverNode(node.id)}
                    onMouseLeave={() => onHoverNode(null)}
                    style={{ height: ROW_HEIGHT }}
                    className={cn(
                      'flex w-full items-center gap-2 border-b border-[var(--border-default)] px-3 text-left transition-opacity hover:bg-[var(--surface-hover)]',
                      isSelected && 'bg-[var(--surface-chip)]',
                      !isRelated && 'opacity-40',
                    )}
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: statusColorVar(node.status) }}
                      aria-label={statusLabel(t, node.status)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {node.botAvatar && <span className="shrink-0 text-xs">{node.botAvatar}</span>}
                        <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                          {node.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
                        <span>{nodeKindLabel(t, node.kind)}</span>
                        {node.deviceName && (
                          <span className="inline-flex items-center gap-0.5 truncate">
                            <Globe className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">{node.deviceName}</span>
                          </span>
                        )}
                        {breadcrumb && <span className="truncate">· {breadcrumb}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right Timeline Canvas + SVG Dependency Connectors */}
            <div ref={timelineRef} className="relative overflow-hidden" style={{ height: geometry.totalHeight }}>
              {/* Live Now vertical reference line */}
              {timeBounds.nowPct !== null && (
                <div
                  className="pointer-events-none absolute bottom-0 top-0 z-10 border-l border-dashed border-[var(--warning-accent)]"
                  style={{ left: `${timeBounds.nowPct}%` }}
                />
              )}

              {/* Dependency / Handoff SVG Overlay */}
              <svg
                width={trackWidth}
                height={geometry.totalHeight}
                viewBox={`0 0 ${trackWidth} ${geometry.totalHeight}`}
                className="pointer-events-none absolute inset-0 z-10"
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id={`${markerPrefix}-arrow-default`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--text-tertiary)" />
                  </marker>
                  <marker
                    id={`${markerPrefix}-arrow-active`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--primary)" />
                  </marker>
                </defs>
                {arrowPaths.map(({ edge, path }) => {
                  const highlighted = Boolean(lineage?.relatedEdgeIds.has(edge.id));
                  const dimmed = Boolean(activeNodeId && !highlighted);
                  return (
                    <path
                      key={edge.id}
                      d={path}
                      fill="none"
                      stroke={edgeColorVar(edge.kind, highlighted)}
                      strokeWidth={highlighted ? 2 : 1.25}
                      strokeDasharray={edge.isCrossDevice ? '4 3' : undefined}
                      opacity={dimmed ? 0.18 : highlighted ? 0.95 : 0.65}
                      markerEnd={`url(#${highlighted ? `${markerPrefix}-arrow-active` : `${markerPrefix}-arrow-default`})`}
                    >
                      <title>{edgeKindLabel(t, edge.kind)}</title>
                    </path>
                  );
                })}
              </svg>

              {/* Row Bars */}
              {geometry.rows.map((row) => {
                if (row.type === 'lane') {
                  return (
                    <div
                      key={`right-lane:${row.laneId}`}
                      style={{ top: row.top, height: LANE_HEADER_HEIGHT }}
                      className="absolute left-0 right-0 border-b border-[var(--border-default)] bg-[var(--surface)]"
                    />
                  );
                }

                const { node, leftPct, widthPct } = row;
                const isSelected = selectedNodeId === node.id;
                const isRelated = !activeNodeId || Boolean(lineage?.relatedNodeIds.has(node.id));
                const elapsed = nodeElapsedMs(node, nowMs);
                const progressPct =
                  typeof node.progressPct === 'number'
                    ? Math.max(0, Math.min(100, node.progressPct))
                    : node.stepCounts && node.stepCounts.total > 0
                      ? Math.round((node.stepCounts.completed / node.stepCounts.total) * 100)
                      : node.status === 'completed'
                        ? 100
                        : 0;

                return (
                  <div
                    key={`right-node:${node.id}`}
                    style={{ top: row.top, height: ROW_HEIGHT }}
                    className="absolute left-0 right-0 border-b border-[var(--border-default)]"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectNode(node.id)}
                      onMouseEnter={() => onHoverNode(node.id)}
                      onMouseLeave={() => onHoverNode(null)}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        top: 9,
                        height: ROW_HEIGHT - 18,
                        borderColor: isSelected ? 'var(--focus-ring)' : statusColorVar(node.status),
                      }}
                      className={cn(
                        'absolute z-20 flex items-center justify-between overflow-hidden rounded border bg-[var(--surface-elevated)] px-2 text-left text-[11px] transition-opacity',
                        !isRelated && 'opacity-35',
                      )}
                      title={`${node.title} · ${statusLabel(t, node.status)}`}
                    >
                      <span
                        className="pointer-events-none absolute inset-y-0 left-0 opacity-20"
                        style={{
                          width: `${progressPct}%`,
                          backgroundColor: statusColorVar(node.status),
                        }}
                      />
                      <span className="relative z-10 truncate font-medium text-[var(--text-primary)]">
                        {node.stepCounts && node.stepCounts.total > 0
                          ? `${node.stepCounts.completed}/${node.stepCounts.total} · ${node.title}`
                          : node.title}
                      </span>
                      <span className="relative z-10 ml-1.5 shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-secondary)]">
                        {formatTaskDuration(elapsed)}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
