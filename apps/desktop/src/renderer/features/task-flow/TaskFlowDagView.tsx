import { useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Globe } from 'lucide-react';
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

function cleanNodeTitle(raw: string): string {
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\((?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/[^)]+\)/gi, (_m, alt: string) =>
      alt && alt.trim() ? alt.trim() : '[图片]',
    )
    .replace(/(?:cindy-media|xdt-image|xdt-file|xdt-video|xdt-audio):\/\/\S+/gi, (uri) =>
      /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i.test(uri) ? '[图片]' : '[附件]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw;
}

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
  const [showIsolated, setShowIsolated] = useState(false);

  const layout = useMemo(() => layoutTaskFlowDag(nodes, edges), [nodes, edges]);
  const activeNodeId = hoveredNodeId ?? selectedNodeId;

  const chains = layout.chains ?? [];
  const isolatedCount = layout.isolatedCount ?? 0;
  const hasChains = chains.length > 0;
  const isolatedVisible = !hasChains || showIsolated;

  const visibleNodes = useMemo(
    () => (isolatedVisible ? layout.nodes : layout.nodes.filter((item) => item.role !== 'isolated')),
    [isolatedVisible, layout.nodes],
  );

  const stageHeight = useMemo(() => {
    if (isolatedVisible) return Math.max(layout.height, 360);
    const lastChain = chains[chains.length - 1];
    const chainsBottom = lastChain ? lastChain.y + lastChain.height + 64 : 240;
    return Math.max(chainsBottom, 300);
  }, [isolatedVisible, layout.height, chains]);

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

  const stageWidth = Math.max(layout.width, 640);
  const isolatedTopY = chains.length > 0 ? chains[chains.length - 1].y + chains[chains.length - 1].height + 22 : 24;

  return (
    <div
      className="relative flex-1 overflow-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      data-testid="task-flow-dag"
    >
      <div
        className="relative"
        style={{
          width: stageWidth,
          height: stageHeight,
        }}
      >
        {/* Chain cluster containers (main spine + branches) */}
        {chains.map((chain, idx) => (
          <div
            key={chain.id}
            style={{
              left: chain.x,
              top: chain.y,
              width: chain.width,
              height: chain.height,
            }}
            className="pointer-events-none absolute rounded-xl border border-[var(--border-default)] bg-[var(--surface)]/55"
          >
            <div className="flex h-9 items-center justify-between gap-2 border-b border-[var(--border-default)]/70 px-3 text-[11px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 font-medium text-[var(--text-primary)]">
                  链路 {idx + 1}
                </span>
                <span className="truncate font-medium text-[var(--text-primary)]">
                  {cleanNodeTitle(chain.title)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
                <span className="rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[var(--primary)]">
                  主链 {chain.spineLength} 步
                </span>
                {chain.branchCount > 0 && (
                  <span className="rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5">
                    支线 {chain.branchCount} 条
                  </span>
                )}
                <span>
                  {chain.nodeCount} 节点 · {chain.edgeCount} 连线
                </span>
              </div>
            </div>
          </div>
        ))}

        {/* Directed dependency / handoff edges */}
        <svg
          width={stageWidth}
          height={stageHeight}
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
            const midX = (routed.fromX + routed.toX) / 2;
            const midY = routed.isBackEdge
              ? Math.max(routed.fromY, routed.toY) + 22
              : (routed.fromY + routed.toY) / 2 - 6;
            const label = routed.edge.label || edgeKindLabel(t, routed.edge.kind);
            return (
              <g key={routed.edge.id} opacity={dimmed ? 0.16 : 1}>
                <path
                  d={routed.path}
                  fill="none"
                  stroke={edgeColorVar(routed.edge.kind, highlighted || Boolean(routed.isMainSpine))}
                  strokeWidth={highlighted ? 2.6 : routed.isMainSpine ? 2.2 : 1.5}
                  strokeDasharray={routed.edge.isCrossDevice || routed.isBackEdge ? '5 3' : undefined}
                  opacity={highlighted ? 1 : routed.isMainSpine ? 0.85 : 0.65}
                  markerEnd={`url(#${highlighted || routed.isMainSpine ? `${markerPrefix}-dag-active` : `${markerPrefix}-dag-default`})`}
                >
                  <title>{label}</title>
                </path>
                {!dimmed && (
                  <text
                    x={midX}
                    y={midY}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--text-secondary)"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Positioned node cards */}
        {visibleNodes.map((item) => {
          const { node } = item;
          const isSelected = selectedNodeId === node.id;
          const isUpstream = Boolean(lineage?.upstreamNodeIds.has(node.id));
          const isDownstream = Boolean(lineage?.downstreamNodeIds.has(node.id));
          const isRelated = !activeNodeId || Boolean(lineage?.relatedNodeIds.has(node.id));
          const elapsed = nodeElapsedMs(node, nowMs);
          const isSpine = item.role === 'spine';
          const isBranch = item.role === 'branch';
          const borderColor = isSelected
            ? 'var(--focus-ring)'
            : isUpstream
              ? 'var(--warning-accent)'
              : isDownstream || isSpine
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
                'absolute flex flex-col justify-between overflow-hidden rounded-xl border bg-[var(--surface)] px-3 py-2 text-left transition-opacity hover:bg-[var(--surface-hover)]',
                isSpine && 'border-2',
                isSelected && 'bg-[var(--surface-chip)]',
                !isRelated && 'opacity-35',
              )}
            >
              <div className="flex w-full min-w-0 items-center justify-between gap-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: statusColorVar(node.status) }}
                  />
                  {node.botAvatar && <span className="shrink-0 text-xs">{node.botAvatar}</span>}
                  <span className="min-w-0 truncate text-xs font-medium text-[var(--text-primary)]">
                    {cleanNodeTitle(node.title)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isSpine && (
                    <span className="rounded-full bg-[var(--primary)]/12 px-1.5 py-0.5 text-[9px] font-medium text-[var(--primary)]">
                      主链
                    </span>
                  )}
                  {isBranch && (
                    <span className="rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[9px] text-[var(--text-secondary)]">
                      支线
                    </span>
                  )}
                  <span className="rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                    {statusLabel(t, node.status)}
                  </span>
                </div>
              </div>

              <div className="w-full truncate text-[11px] text-[var(--text-secondary)]">
                {node.folderBreadcrumb?.length
                  ? `${node.folderBreadcrumb.join(' / ')} · ${nodeKindLabel(t, node.kind)}`
                  : node.subtitle || nodeKindLabel(t, node.kind)}
              </div>

              <div className="flex w-full items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                  {node.deviceName && (
                    <span className="inline-flex min-w-0 items-center gap-0.5 truncate">
                      <Globe className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{node.deviceName}</span>
                    </span>
                  )}
                  {node.stepCounts && node.stepCounts.total > 0 && (
                    <span className="shrink-0">
                      · {node.stepCounts.completed}/{node.stepCounts.total}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums">{formatTaskDuration(elapsed)}</span>
              </div>
            </button>
          );
        })}

        {/* Collapsible footer toggle for isolated (no-dependency) nodes when chains exist */}
        {hasChains && isolatedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowIsolated((prev) => !prev)}
            style={{ left: 24, top: isolatedTopY }}
            className="absolute inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            {isolatedVisible ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>
              {isolatedVisible
                ? `收起无上下游依赖的独立任务 (${isolatedCount})`
                : `展开其余无上下游依赖的独立任务 (${isolatedCount})`}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
