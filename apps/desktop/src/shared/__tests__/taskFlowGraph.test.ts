import { describe, expect, it } from 'vitest';
import {
  buildTaskFlowSwimlanes,
  canonicalizeSessionNodeId,
  computeLineage,
  filterTaskFlowGraph,
  layoutTaskFlowDag,
  mergeTaskFlowSnapshots,
  type TaskFlowSnapshot,
} from '../taskFlowGraph';

describe('taskFlowGraph engine', () => {
  it('merges cross-device snapshots and replaces placeholder target nodes with authoritative remote nodes', () => {
    const localSnapshot: TaskFlowSnapshot = {
      selfDeviceId: 'dev-local',
      selfDeviceName: 'Local-PC',
      observedAt: 1_000,
      hiddenScheduledCount: 3,
      nodes: [
        {
          id: canonicalizeSessionNodeId('dev-local', 's1'),
          kind: 'session',
          title: 'Cindy coordinator',
          status: 'running',
          deviceId: 'dev-local',
          deviceName: 'Local-PC',
          sessionId: 's1',
          createdAtMs: 100,
          updatedAtMs: 900,
        },
        {
          id: canonicalizeSessionNodeId('dev-remote', 'dev-remote::s2'),
          kind: 'session',
          title: 'Remote placeholder',
          status: 'waiting',
          deviceId: 'dev-remote',
          sessionId: 's2',
          isCrossDevice: true,
          isPlaceholder: true,
          createdAtMs: 200,
          updatedAtMs: 200,
        },
      ],
      edges: [
        {
          id: 'e1',
          from: canonicalizeSessionNodeId('dev-local', 's1'),
          to: canonicalizeSessionNodeId('dev-remote', 's2'),
          kind: 'handoff',
          timestampMs: 200,
        },
      ],
    };

    const remoteSnapshot: TaskFlowSnapshot = {
      selfDeviceId: 'dev-remote',
      selfDeviceName: 'optix-display',
      observedAt: 1_100,
      hiddenScheduledCount: 1,
      nodes: [
        {
          id: 'raw-s2',
          kind: 'session',
          title: 'KEMOVE migration worker',
          status: 'completed',
          deviceId: 'dev-remote',
          deviceName: 'optix-display',
          sessionId: 's2',
          folderId: 'f-infra',
          folderBreadcrumb: ['运维组', '网络'],
          createdAtMs: 190,
          completedAtMs: 850,
          updatedAtMs: 850,
        },
      ],
      edges: [],
    };

    const merged = mergeTaskFlowSnapshots(localSnapshot, [
      { deviceId: 'dev-remote', deviceName: 'optix-display', snapshot: remoteSnapshot },
    ]);

    expect(merged.hiddenScheduledCount).toBe(4);
    expect(merged.nodes).toHaveLength(2);
    const remoteNode = merged.nodes.find((n) => n.sessionId === 's2');
    expect(remoteNode?.title).toBe('KEMOVE migration worker');
    expect(remoteNode?.status).toBe('completed');
    expect(remoteNode?.isPlaceholder).toBe(false);
    expect(remoteNode?.folderBreadcrumb).toEqual(['运维组', '网络']);
    expect(merged.edges[0]?.isCrossDevice).toBe(true);
    expect(merged.edges[0]?.to).toBe(canonicalizeSessionNodeId('dev-remote', 's2'));
  });

  it('expands internal steps into plan_step nodes, blocked_by edges, and handles cycles safely in DAG layout', () => {
    const snapshot: TaskFlowSnapshot = {
      selfDeviceId: 'dev-local',
      observedAt: 5_000,
      hiddenScheduledCount: 1,
      nodes: [
        {
          id: 'session:dev-local:s1',
          kind: 'session',
          title: 'Main task',
          status: 'running',
          deviceId: 'dev-local',
          deviceName: 'Local-PC',
          sessionId: 's1',
          createdAtMs: 1_000,
          updatedAtMs: 4_000,
          internalSteps: [
            { stepId: '1', content: 'Fetch config', status: 'completed', createdAtMs: 1_100, completedAtMs: 2_000 },
            { stepId: '2', content: 'Apply config', status: 'in_progress', blockedBy: ['1'], createdAtMs: 1_100, startedAtMs: 2_000 },
          ],
        },
        {
          id: 'session:dev-local:s2',
          kind: 'session',
          title: 'Scheduled sweep',
          status: 'completed',
          source: 'scheduler',
          deviceId: 'dev-local',
          sessionId: 's2',
          createdAtMs: 500,
          updatedAtMs: 600,
        },
      ],
      edges: [
        // Intentional reverse/cycle pair when testing cycle breaker
        { id: 'c1', from: 'session:dev-local:s1', to: 'plan-step:session:dev-local:s1:1', kind: 'delegated' },
      ],
    };

    const filtered = filterTaskFlowGraph(snapshot, {
      expandInternalSteps: true,
      includeScheduled: false,
      nowMs: 5_000,
    });

    // Scheduler node s2 is excluded; s1 + 2 plan_step nodes remain
    expect(filtered.nodes).toHaveLength(3);
    expect(filtered.edges.some((e) => e.kind === 'blocked_by')).toBe(true);

    // Add explicit cycle edge to verify layoutTaskFlowDag does not loop or fail
    const cyclicEdges = [
      ...filtered.edges,
      {
        id: 'cycle-back',
        from: 'plan-step:session:dev-local:s1:2',
        to: 'session:dev-local:s1',
        kind: 'reported' as const,
      },
    ];
    const layout = layoutTaskFlowDag(filtered.nodes, cyclicEdges);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges.some((e) => e.isBackEdge)).toBe(true);

    const lineage = computeLineage('plan-step:session:dev-local:s1:1', filtered.edges);
    expect(lineage.upstreamNodeIds.has('session:dev-local:s1')).toBe(true);
    expect(lineage.downstreamNodeIds.has('plan-step:session:dev-local:s1:2')).toBe(true);

    const swim = buildTaskFlowSwimlanes(filtered.nodes, filtered.edges, 'chain', 5_000);
    expect(swim.lanes).toHaveLength(1);
    expect(swim.lanes[0].nodes).toHaveLength(3);
  });
});
