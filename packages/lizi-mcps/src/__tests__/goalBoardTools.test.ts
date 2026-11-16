import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { GoalBoardCallbacks } from '../xdt-helper/goal_board.js';

function parseToolPayload(res: Awaited<ReturnType<Client['callTool']>>) {
  const first = Array.isArray(res.content) ? res.content[0] : undefined;
  const text = first && first.type === 'text' ? first.text : '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('goalBoard MCP tools', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function setupClient(goalBoard: GoalBoardCallbacks) {
    const server = createXdtHelperMcpServer(
      {
        goalBoard,
      },
      {
        agentKind: 'claude-code',
        workingDir: '/repo/wanjie-2d',
        sessionId: 'pm-session-1',
      },
    );
    const client = new Client({ name: 'goal-board-test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    clients.push(client);
    return client;
  }

  it('registers goal_board_get, goal_board_upsert, and goal_item_update under category cindy', async () => {
    const callbacks: GoalBoardCallbacks = {
      get: vi.fn(async () => ({ ok: true as const, goals: [] })),
      upsert: vi.fn(),
      updateItem: vi.fn(),
    };
    const client = await setupClient(callbacks);

    const listRes = await client.callTool({
      name: 'list_tools',
      arguments: { category: 'cindy' },
    });
    const payload = parseToolPayload(listRes);
    const tools = Array.isArray(payload.tools)
      ? (payload.tools as Array<{ name: string }>).map((t) => t.name)
      : [];

    expect(tools).toContain('goal_board_get');
    expect(tools).toContain('goal_board_upsert');
    expect(tools).toContain('goal_item_update');
  });

  it('routes goal_board_get and maps snake_case fields for goal_board_upsert', async () => {
    const sampleGoal = {
      id: 'goal-m0',
      title: 'M0 可玩切片封板',
      objective: '产出 build-wx/m0-review 候选包并通过 G-M0 验收',
      status: 'active' as const,
      exitCriteria: ['G-M0 PASS'],
      items: [
        {
          id: 'E',
          title: '固定可玩候选包',
          status: 'ready' as const,
          blockedBy: ['A', 'B'],
          ownerRole: 'HB05',
          backupOwnerRole: 'HB01',
          reviewerRole: 'Q01',
          artifactPaths: ['build-wx/m0-review/'],
          wave: 2,
          isCriticalPath: true,
          updatedAtMs: 1000,
        },
      ],
      createdAtMs: 1000,
      updatedAtMs: 1000,
    };
    const nextActions = {
      goalId: 'goal-m0',
      progressPct: 33,
      completedCount: 1,
      totalCount: 3,
      currentWave: 2,
      readyToDispatch: [sampleGoal.items[0]],
      awaitingReview: [],
      criticalBlockers: [],
      overloadedSessions: [],
    };

    const getMock = vi.fn(async () => ({
      ok: true as const,
      goals: [{ goal: sampleGoal, nextActions }],
    }));
    const upsertMock = vi.fn(async () => ({
      ok: true as const,
      goal: sampleGoal,
      nextActions,
    }));

    const client = await setupClient({
      get: getMock,
      upsert: upsertMock,
      updateItem: vi.fn(),
    });

    const getRes = parseToolPayload(
      await client.callTool({
        name: 'call_tool',
        arguments: { name: 'goal_board_get', args: { goal_id: 'goal-m0' } },
      }),
    );
    expect(getMock).toHaveBeenCalledWith({
      callerSessionId: 'pm-session-1',
      goalId: 'goal-m0',
    });
    expect(getRes.ok).toBe(true);
    expect((getRes.goals as Array<Record<string, unknown>>)[0]?.next_actions).toMatchObject({
      goal_id: 'goal-m0',
      progress_pct: 33,
      current_wave: 2,
    });

    const upsertRes = parseToolPayload(
      await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'goal_board_upsert',
          args: {
            id: 'goal-m0',
            title: 'M0 可玩切片封板',
            pm_role: 'M01',
            exit_criteria: ['G-M0 PASS'],
            items: [
              {
                id: 'E',
                title: '固定可玩候选包',
                blocked_by: ['A', 'B'],
                owner_role: 'HB05',
                backup_owner_role: 'HB01',
                reviewer_role: 'Q01',
                artifact_paths: ['build-wx/m0-review/'],
                acceptance_criteria: '可真机进入首局战斗并回结算',
              },
            ],
          },
        },
      }),
    );
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        callerSessionId: 'pm-session-1',
        id: 'goal-m0',
        pmRole: 'M01',
        exitCriteria: ['G-M0 PASS'],
        items: [
          expect.objectContaining({
            id: 'E',
            blockedBy: ['A', 'B'],
            ownerRole: 'HB05',
            backupOwnerRole: 'HB01',
            reviewerRole: 'Q01',
            artifactPaths: ['build-wx/m0-review/'],
            acceptanceCriteria: '可真机进入首局战斗并回结算',
          }),
        ],
      }),
    );
    expect(upsertRes.ok).toBe(true);
  });

  it('forwards structured WAVE_GATE_BLOCKED / REVIEW_REQUIRED errors from goal_item_update', async () => {
    const updateItemMock = vi
      .fn<GoalBoardCallbacks['updateItem']>()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'WAVE_GATE_BLOCKED',
        message: '前置依赖 A, B 尚未完成，不能提前推进 E。',
      })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'REVIEW_REQUIRED',
        message: '工作项 E 需要独立验收人 Q01 给出 verdict=PASS 后才可完成。',
      });

    const client = await setupClient({
      get: vi.fn(),
      upsert: vi.fn(),
      updateItem: updateItemMock,
    });

    const waveErr = parseToolPayload(
      await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'goal_item_update',
          args: { goal_id: 'goal-m0', item_id: 'E', status: 'in_progress' },
        },
      }),
    );
    expect(waveErr).toMatchObject({
      ok: false,
      errorCode: 'WAVE_GATE_BLOCKED',
    });

    const reviewErr = parseToolPayload(
      await client.callTool({
        name: 'call_tool',
        arguments: {
          name: 'goal_item_update',
          args: { goal_id: 'goal-m0', item_id: 'E', status: 'completed' },
        },
      }),
    );
    expect(reviewErr).toMatchObject({
      ok: false,
      errorCode: 'REVIEW_REQUIRED',
    });
  });
});
