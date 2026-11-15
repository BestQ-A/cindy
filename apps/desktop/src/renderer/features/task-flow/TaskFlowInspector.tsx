import { ExternalLink, Globe, Link2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { TaskFlowEdge, TaskFlowNode } from '../../../shared/taskFlowGraph';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  edgeKindLabel,
  formatTaskClock,
  formatTaskDuration,
  nodeElapsedMs,
  nodeKindLabel,
  safeTaskFlowTr,
  statusColorVar,
  statusLabel,
} from './taskFlowFormat';

export interface TaskFlowInspectorProps {
  node: TaskFlowNode | null;
  selfDeviceId: string | null;
  nodesById: ReadonlyMap<string, TaskFlowNode>;
  edges: readonly TaskFlowEdge[];
  nowMs: number;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

export function TaskFlowInspector({
  node,
  selfDeviceId,
  nodesById,
  edges,
  nowMs,
  onSelectNode,
  onClose,
}: TaskFlowInspectorProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (!node) return null;

  const incoming = edges.filter((e) => e.to === node.id);
  const outgoing = edges.filter((e) => e.from === node.id);
  const elapsed = nodeElapsedMs(node, nowMs);

  const handleOpenInCindy = () => {
    if (!node.sessionId) return;
    if (node.deviceId && node.deviceId !== selfDeviceId) {
      remoteProjectsStore.pinSessionOrigin(node.deviceId, node.sessionId);
    }
    navigate(`/cc-agent/${encodeURIComponent(node.sessionId)}`);
  };

  return (
    <aside
      className="flex w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      aria-label={safeTaskFlowTr(t, 'taskFlow.inspector.title', '任务节点详情')}
      data-testid="task-flow-inspector"
    >
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-default)] px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: statusColorVar(node.status) }}
            />
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">
              {statusLabel(t, node.status)} · {nodeKindLabel(t, node.kind)}
            </span>
          </div>
          <h2 className="mt-1 truncate text-sm font-medium text-[var(--text-primary)]">{node.title}</h2>
          {node.subtitle && (
            <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">{node.subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={safeTaskFlowTr(t, 'taskFlow.inspector.close', '关闭详情')}
          className="rounded-lg p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3.5 py-3 text-xs">
        {node.sessionId && (
          <button
            type="button"
            onClick={handleOpenInCindy}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text-primary)] px-3 py-1.5 text-xs font-medium text-[var(--surface)] transition-opacity hover:opacity-90"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{safeTaskFlowTr(t, 'taskFlow.inspector.openSession', '在 Cindy 中打开')}</span>
          </button>
        )}

        {/* Metadata & Time progression */}
        <dl className="grid grid-cols-[76px_1fr] gap-y-1.5 text-xs">
          <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.computer', '所在电脑')}</dt>
          <dd className="flex items-center gap-1 truncate text-[var(--text-primary)]">
            <Globe className="h-3 w-3 shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">
              {node.deviceName || (node.deviceId ? node.deviceId.slice(0, 8) : safeTaskFlowTr(t, 'taskFlow.localDevice', '本机电脑'))}
            </span>
          </dd>

          {node.folderBreadcrumb && node.folderBreadcrumb.length > 0 && (
            <>
              <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.folder', '伙伴分组')}</dt>
              <dd className="truncate text-[var(--text-primary)]">{node.folderBreadcrumb.join(' / ')}</dd>
            </>
          )}

          <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.createdAt', '创建时间')}</dt>
          <dd className="font-mono tabular-nums text-[var(--text-secondary)]">{formatTaskClock(node.createdAtMs)}</dd>

          {node.startedAtMs && (
            <>
              <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.startedAt', '开始执行')}</dt>
              <dd className="font-mono tabular-nums text-[var(--text-secondary)]">{formatTaskClock(node.startedAtMs)}</dd>
            </>
          )}

          {node.completedAtMs && (
            <>
              <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.completedAt', '完成时间')}</dt>
              <dd className="font-mono tabular-nums text-[var(--text-secondary)]">{formatTaskClock(node.completedAtMs)}</dd>
            </>
          )}

          <dt className="text-[var(--text-tertiary)]">{safeTaskFlowTr(t, 'taskFlow.inspector.elapsed', '累计耗时')}</dt>
          <dd className="font-mono tabular-nums text-[var(--text-primary)]">{formatTaskDuration(elapsed)}</dd>
        </dl>

        {/* Upstream */}
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            {safeTaskFlowTr(t, 'taskFlow.inspector.upstream', '上游依赖 / 来源 ({{count}})', { count: incoming.length })}
          </h3>
          {incoming.length === 0 ? (
            <p className="text-[11px] text-[var(--text-tertiary)]">
              {safeTaskFlowTr(t, 'taskFlow.inspector.noUpstream', '无上游前置任务')}
            </p>
          ) : (
            <div className="space-y-1">
              {incoming.map((edge) => {
                const peer = nodesById.get(edge.from);
                return (
                  <button
                    key={edge.id}
                    type="button"
                    onClick={() => peer && onSelectNode(peer.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                  >
                    <span className="truncate text-[var(--text-primary)]">
                      {peer?.title ?? edge.from}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                      {edgeKindLabel(t, edge.kind)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Downstream */}
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
            {safeTaskFlowTr(t, 'taskFlow.inspector.downstream', '下游推进 / 后续 ({{count}})', { count: outgoing.length })}
          </h3>
          {outgoing.length === 0 ? (
            <p className="text-[11px] text-[var(--text-tertiary)]">
              {safeTaskFlowTr(t, 'taskFlow.inspector.noDownstream', '暂无下游派生任务')}
            </p>
          ) : (
            <div className="space-y-1">
              {outgoing.map((edge) => {
                const peer = nodesById.get(edge.to);
                return (
                  <button
                    key={edge.id}
                    type="button"
                    onClick={() => peer && onSelectNode(peer.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                  >
                    <span className="truncate text-[var(--text-primary)]">
                      {peer?.title ?? edge.to}
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                      {edgeKindLabel(t, edge.kind)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Internal plan steps */}
        {node.internalSteps && node.internalSteps.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
              {safeTaskFlowTr(t, 'taskFlow.inspector.internalSteps', '内部计划步骤 ({{count}})', { count: node.internalSteps.length })}
            </h3>
            <div className="space-y-1.5">
              {node.internalSteps.map((step) => {
                const stepStart = step.startedAtMs ?? step.createdAtMs;
                const stepEnd =
                  step.status === 'completed'
                    ? (step.completedAtMs ?? step.updatedAtMs)
                    : step.status === 'in_progress'
                      ? nowMs
                      : undefined;
                const stepDur =
                  typeof stepStart === 'number' && typeof stepEnd === 'number'
                    ? Math.max(0, stepEnd - stepStart)
                    : null;
                return (
                  <div
                    key={step.stepId}
                    className="rounded-lg border border-[var(--border-default)] bg-[var(--surface)] px-2.5 py-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[var(--text-primary)]">{step.content}</span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
                        {formatTaskDuration(stepDur)}
                      </span>
                    </div>
                    {(step.blockedBy?.length || step.owner) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
                        {step.blockedBy && step.blockedBy.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-[var(--surface-chip)] px-1.5 py-0.5">
                            <Link2 className="h-2.5 w-2.5" />
                            <span>← {step.blockedBy.join(', ')}</span>
                          </span>
                        )}
                        {step.owner && <span>@{step.owner}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}
