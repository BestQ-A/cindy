import { useId, useMemo } from 'react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  layoutTaskFlowDag,
  type TaskFlowEdge,
  type TaskFlowLineage,
  type TaskFlowNode,
} from '../../../shared/taskFlowGraph';
import { cn } from '@/lib/utils';
import {
  edgeColorVar,
  edgeKindLabel,
  formatTaskDuration,
  nodeElapsedMs,
  nodeKindLabel,
  safeTaskFlowTr,
  statusColorVar,
  statusLabel,
} from './taskFlowFormat';

export interface TaskFlowDagViewProps {
  nodes: readonly TaskFlowNode[];
  edges: readonly TaskFlowEdge[];
  nowMs: number;
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
  lineage: TaskFlowLineage | null;
  onSelectNode: (nodeId: string) => void;
  onHoverNode: (nodeId: string | null) => void;
}

export function TaskFlowDagView({
  nodes,
  edges,
  nowMs,
  selectedNodeId,
  hoveredNodeId,
  lineage,
  onSelectNode,
  onHoverNode,
}: TaskFlowDagViewProps) {
  const { t } = useTranslation();
  const markerPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const layout = useMemo(() => layoutTaskFlowDag(nodes, edges), [nodes, edges]);
  const activeNodeId = hoveredNodeId ?? selectedNodeId;

  if (layout.nodes.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-10 text-sm text-[var(--text-secondary)]"
        data-testid="task-flow-dag"
      >
        {safeTaskFlowTr(t, 'taskFlow.empty', '当前筛选条件下暂无任务依赖图。')}
      </div>
    );
  }

  return (
    <div
      className="relative flex-1 overflow-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      data-testid="task-flow-dag"
    >
      <div
        className="relative"
        style={{
          width: Math.max(layout.width, 640),
          height: Math.max(layout.height, 360),
        }}
      >
        {/* Directed dependency / handoff edges */}
        <svg
          width={Math.max(layout.width, 640)}
          height={Math.max(layout.height, 360)}
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <defs>
            <marker
              id={`${markerPrefix}-dag-default`}
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
              id={`${markerPrefix}-dag-active`}
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
          {layout.edges.map((routed) => {
            const highlighted = Boolean(lineage?.relatedEdgeIds.has(routed.edge.id));
            const dimmed = Boolean(activeNodeId && !highlighted);
            return (
              <path
                key={routed.edge.id}
                d={routed.path}
                fill="none"
                stroke={edgeColorVar(routed.edge.kind, highlighted)}
                strokeWidth={highlighted ? 2.2 : 1.5}
                strokeDasharray={routed.edge.isCrossDevice || routed.isBackEdge ? '5 3' : undefined}
                opacity={dimmed ? 0.18 : highlighted ? 1 : 0.7}
                markerEnd={`url(#${highlighted ? `${markerPrefix}-dag-active` : `${markerPrefix}-dag-default`})`}
              >
                <title>{edgeKindLabel(t, routed.edge.kind)}</title>
              </path>
            );
          })}
        </svg>

        {/* Positioned node cards */}
        {layout.nodes.map((item) => {
          const { node } = item;
          const isSelected = selectedNodeId === node.id;
          const isUpstream = Boolean(lineage?.upstreamNodeIds.has(node.id));
          const isDownstream = Boolean(lineage?.downstreamNodeIds.has(node.id));
          const isRelated = !activeNodeId || Boolean(lineage?.relatedNodeIds.has(node.id));
          const elapsed = nodeElapsedMs(node, nowMs);
          const borderColor = isSelected
            ? 'var(--focus-ring)'
            : isUpstream
              ? 'var(--warning-accent)'
              : isDownstream
                ? 'var(--primary)'
                : 'var(--border-default)';

          return (
            <button
              key={node.id}
              type="button"
              data-dag-node-id={node.id}
              onClick={() => onSelectNode(node.id)}
              onMouseEnter={() => onHoverNode(node.id)}
              onMouseLeave={() => onHoverNode(null)}
              style={{
                left: item.x,
                top: item.y,
                width: item.width,
                height: item.height,
                borderColor,
              }}
              className={cn(
                'absolute flex flex-col justify-between rounded-xl border bg-[var(--surface)] px-3 py-2 text-left transition-opacity hover:bg-[var(--surface-hover)]',
                isSelected && 'bg-[var(--surface-chip)]',
                !isRelated && 'opacity-35',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: statusColorVar(node.status) }}
                  />
                  {node.botAvatar && <span className="shrink-0 text-xs">{node.botAvatar}</span>}
                  <span className="truncate text-xs font-medium text-[var(--text-primary)]">
                    {node.title}
                  </span>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                  {statusLabel(t, node.status)}
                </span>
              </div>

              <div className="truncate text-[11px] text-[var(--text-secondary)]">
                {node.folderBreadcrumb?.length
                  ? `${node.folderBreadcrumb.join(' / ')} · ${nodeKindLabel(t, node.kind)}`
                  : node.subtitle || nodeKindLabel(t, node.kind)}
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
                <span className="flex min-w-0 items-center gap-1 truncate">
                  {node.deviceName && (
                    <span className="inline-flex items-center gap-0.5 truncate">
                      <Globe className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{node.deviceName}</span>
                    </span>
                  )}
                  {node.stepCounts && node.stepCounts.total > 0 && (
                    <span>
                      · {node.stepCounts.completed}/{node.stepCounts.total}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums">{formatTaskDuration(elapsed)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
