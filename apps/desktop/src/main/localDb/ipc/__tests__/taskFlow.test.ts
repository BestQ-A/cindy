import { describe, expect, it } from 'vitest';

import {
  botDelegations,
  botGroupPlans,
  botGroupPlanSteps,
  botProfiles,
  botSessionLinks,
  messages,
  orcaTeams,
  orcaWorkers,
  sessions,
  subagentRuns,
} from '../../schema';
import { collectLocalTaskFlowSnapshot } from '../taskFlow';
import {
  assignItemsToFolder,
  botHierarchyItemKey,
  createBotFolder,
  createEmptyBotHierarchyConfig,
} from '../../../../shared/botHierarchy';

function createFakeDb(tables: Map<unknown, unknown[]>) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = tables.get(table) ?? [];
        const result = Promise.resolve(rows) as Promise<unknown[]> & {
          where: () => Promise<unknown[]>;
        };
        result.where = () => Promise.resolve(rows);
        return result;
      },
    }),
  };
}

describe('collectLocalTaskFlowSnapshot', () => {
  it('collects companion ownership, send_to_session cross-machine handoffs, subagents, group steps, orca dispatch, and internal plan steps', async () => {
    const t0 = 1_700_000_000_000;
    const t1 = t0 + 10_000;
    const t2 = t0 + 25_000;
    const t3 = t0 + 40_000;

    const created = createBotFolder(createEmptyBotHierarchyConfig(t3), {
      id: 'f-ops',
      name: '运维集群',
      now: t3,
    });
    const hierarchy = assignItemsToFolder(
      created.config,
      [botHierarchyItemKey('bot-cindy')],
      'f-ops',
      { now: t3 },
    );

    const tables = new Map<unknown, unknown[]>([
      [
        botProfiles,
        [
          {
            id: 'bot-cindy',
            displayName: 'Cindy',
            description: '主协调官',
            avatar: '🤖',
            status: 'active',
            canonicalSessionId: 's-main',
            createdAt: t0,
            updatedAt: t3,
          },
        ],
      ],
      [
        botSessionLinks,
        [
          {
            id: 'l1',
            botId: 'bot-cindy',
            sessionId: 's-main',
            role: 'canonical',
          },
        ],
      ],
      [
        sessions,
        [
          {
            id: 's-main',
            title: 'Cindy 主会话',
            status: 'active',
            source: 'bot',
            parentSessionId: null,
            activeTurnStartedAt: t3 - 1000,
            lastTurnEndedAt: t2,
            lastActivityAt: t3,
            userSendAt: t0,
            createdAt: t0,
            updatedAt: t3,
            agentDeviceId: null,
          },
          {
            id: 's-child',
            title: '本地排查',
            status: 'active',
            source: 'desktop',
            parentSessionId: null,
            activeTurnStartedAt: t1,
            lastTurnEndedAt: t2,
            lastActivityAt: t2,
            userSendAt: t1,
            createdAt: t1,
            updatedAt: t2,
            agentDeviceId: null,
          },
          {
            id: 's-cron',
            title: 'Nightly cleanup',
            status: 'archived',
            source: 'scheduler',
            parentSessionId: null,
            activeTurnStartedAt: null,
            lastTurnEndedAt: t1,
            lastActivityAt: t1,
            userSendAt: t0,
            createdAt: t0,
            updatedAt: t1,
            agentDeviceId: null,
          },
        ],
      ],
      [botDelegations, []],
      [
        botGroupPlans,
        [
          {
            id: 'gp-1',
            groupId: 'grp-1',
            status: 'running',
            requestText: '协同升级',
            organizerBotId: 'bot-cindy',
            organizerName: 'Cindy',
            createdAt: t1,
            updatedAt: t2,
          },
        ],
      ],
      [
        botGroupPlanSteps,
        [
          {
            planId: 'gp-1',
            position: 0,
            botId: 'bot-cindy',
            botName: 'Cindy',
            task: '确认发布说明',
            status: 'done',
            startedAt: t1,
            finishedAt: t2,
          },
        ],
      ],
      [
        orcaTeams,
        [
          { id: 'orca-t1', leadSessionId: 's-main', status: 'active', createdAt: t1, updatedAt: t2 },
        ],
      ],
      [
        orcaWorkers,
        [
          {
            id: 'ow-1',
            teamId: 'orca-t1',
            sessionId: 's-child',
            status: 'running',
            label: 'Worker A',
            role: 'developer',
            executionDeviceId: 'dev-remote',
            remoteSessionId: 'remote-s9',
            createdAt: t1,
            updatedAt: t2,
          },
        ],
      ],
      [
        subagentRuns,
        [
          {
            id: 'sub-1',
            sessionId: 's-child',
            provider: 'claude-code',
            logicalAgentId: 'a1',
            status: 'completed',
            title: '扫描仓库',
            description: null,
            startedAt: t1 + 1000,
            updatedAt: t2,
            endedAt: t2,
            rewindAt: null,
            deletedAt: null,
          },
        ],
      ],
      [
        messages,
        [
          {
            id: 'm1',
            clientId: 'm1',
            sessionId: 's-main',
            role: 'tool_use',
            toolUseId: 'tu-send-remote',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1,
            content: JSON.stringify({
              toolName: 'send_to_session',
              toolUseId: 'tu-send-remote',
              input: {
                target_session_id: 'dev-remote::remote-s1',
                wake_kind: 'created',
                target_title: 'KEMOVE 远端采集',
              },
            }),
          },
          {
            id: 'm2',
            clientId: 'm2',
            sessionId: 's-main',
            role: 'tool_result',
            toolUseId: 'tu-send-remote',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1 + 50,
            content: JSON.stringify({
              ok: true,
              target_session_id: 'dev-remote::remote-s1',
              wake_kind: 'created',
              target_title: 'KEMOVE 远端采集',
            }),
          },
          {
            id: 'm3',
            clientId: 'm3',
            sessionId: 's-child',
            role: 'tool_use',
            toolUseId: 'tu-t1',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1 + 500,
            content: JSON.stringify({
              toolName: 'TaskCreate',
              toolUseId: 'tu-t1',
              input: { subject: '读取端口状态' },
            }),
          },
          {
            id: 'm4',
            clientId: 'm4',
            sessionId: 's-child',
            role: 'tool_result',
            toolUseId: 'tu-t1',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1 + 510,
            content: 'Task #1 created successfully: 读取端口状态',
          },
          {
            id: 'm5',
            clientId: 'm5',
            sessionId: 's-child',
            role: 'tool_use',
            toolUseId: 'tu-t2',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1 + 600,
            content: JSON.stringify({
              toolName: 'TaskCreate',
              toolUseId: 'tu-t2',
              input: { subject: '输出审计报告', blockedBy: ['1'] },
            }),
          },
          {
            id: 'm6',
            clientId: 'm6',
            sessionId: 's-child',
            role: 'tool_result',
            toolUseId: 'tu-t2',
            agentMeta: null,
            rewindAt: null,
            createdAt: t1 + 610,
            content: 'Task #2 created successfully: 输出审计报告',
          },
        ],
      ],
    ]);

    const snapshot = await collectLocalTaskFlowSnapshot(
      { includeScheduled: false },
      {
        db: createFakeDb(tables) as never,
        selfDeviceId: 'dev-local',
        selfDeviceName: 'Local-PC',
        readHierarchy: () => hierarchy,
        readResponsibilities: async (botId) => (botId === 'bot-cindy' ? ['s-child'] : []),
        nowMs: () => t3,
      },
    );

    expect(snapshot.hiddenScheduledCount).toBe(1);
    expect(snapshot.nodes.some((n) => n.sessionId === 's-cron')).toBe(false);

    const botNode = snapshot.nodes.find((n) => n.id === 'bot:dev-local:bot-cindy');
    expect(botNode?.folderBreadcrumb).toEqual(['运维集群']);
    expect(botNode?.status).toBe('running');

    const childSess = snapshot.nodes.find((n) => n.sessionId === 's-child');
    expect(childSess?.internalSteps).toHaveLength(2);
    expect(childSess?.internalSteps?.[1]?.blockedBy).toEqual(['1']);

    const remotePlaceholder = snapshot.nodes.find((n) => n.sessionId === 'remote-s1');
    expect(remotePlaceholder).toMatchObject({
      deviceId: 'dev-remote',
      isCrossDevice: true,
      isPlaceholder: true,
      title: 'KEMOVE 远端采集',
    });

    expect(
      snapshot.edges.some(
        (e) =>
          e.kind === 'created_task' &&
          e.from === 'session:dev-local:s-main' &&
          e.to === 'session:dev-remote:remote-s1' &&
          e.isCrossDevice === true,
      ),
    ).toBe(true);
    expect(
      snapshot.edges.some(
        (e) => e.kind === 'orca_dispatch' && e.to === 'session:dev-remote:remote-s9',
      ),
    ).toBe(true);
    expect(
      snapshot.edges.some((e) => e.kind === 'subagent_spawn' && e.from === 'session:dev-local:s-child'),
    ).toBe(true);
  });
});
