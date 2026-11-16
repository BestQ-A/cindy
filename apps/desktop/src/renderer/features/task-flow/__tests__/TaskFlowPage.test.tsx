// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskFlowSnapshot } from '../../../../shared/taskFlowGraph';
import { TaskFlowPage } from '../TaskFlowPage';

const mocks = vi.hoisted(() => ({
  pinSessionOrigin: vi.fn(),
  snapshotFn: vi.fn<() => Promise<TaskFlowSnapshot>>(),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    pinSessionOrigin: mocks.pinSessionOrigin,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const tpl = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? ''));
    },
  }),
}));

function LocationEcho() {
  const loc = useLocation();
  return <output data-testid="router-location">{loc.pathname}</output>;
}

const now = 1_700_000_120_000;
const sampleSnapshot: TaskFlowSnapshot = {
  selfDeviceId: 'local-pc',
  selfDeviceName: '主控电脑',
  observedAt: now,
  hiddenScheduledCount: 2,
  nodes: [
    {
      id: 'bot:local-pc:bot-cindy',
      kind: 'companion',
      title: 'Cindy',
      subtitle: '主协调官',
      status: 'running',
      deviceId: 'local-pc',
      deviceName: '主控电脑',
      botId: 'bot-cindy',
      botName: 'Cindy',
      folderId: 'f-coord',
      folderBreadcrumb: ['万界团队', '协调中枢'],
      createdAtMs: now - 100_000,
      startedAtMs: now - 100_000,
      updatedAtMs: now,
    },
    {
      id: 'session:local-pc:s-lead',
      kind: 'session',
      title: '主控调度会话',
      status: 'running',
      deviceId: 'local-pc',
      deviceName: '主控电脑',
      botId: 'bot-cindy',
      botName: 'Cindy',
      folderId: 'f-coord',
      folderBreadcrumb: ['万界团队', '协调中枢'],
      sessionId: 's-lead',
      stepCounts: { completed: 1, total: 2 },
      progressPct: 50,
      createdAtMs: now - 80_000,
      startedAtMs: now - 75_000,
      updatedAtMs: now - 5_000,
      internalSteps: [
        {
          stepId: '1',
          content: '拉取本地日志',
          status: 'completed',
          createdAtMs: now - 75_000,
          startedAtMs: now - 75_000,
          completedAtMs: now - 50_000,
        },
        {
          stepId: '2',
          content: '汇总跨机结果',
          status: 'in_progress',
          blockedBy: ['1'],
          owner: 'cindy-alpha',
          createdAtMs: now - 75_000,
          startedAtMs: now - 49_000,
        },
      ],
    },
    {
      id: 'session:mac-mini:s-remote',
      kind: 'session',
      title: '远端性能分析',
      status: 'completed',
      deviceId: 'mac-mini',
      deviceName: 'Mac Mini 节点',
      botName: '算力伙伴',
      folderBreadcrumb: ['研发群', 'Mac 节点'],
      sessionId: 's-remote',
      isCrossDevice: true,
      createdAtMs: now - 60_000,
      startedAtMs: now - 58_000,
      completedAtMs: now - 20_000,
      updatedAtMs: now - 20_000,
    },
  ],
  edges: [
    {
      id: 'e-create',
      from: 'bot:local-pc:bot-cindy',
      to: 'session:local-pc:s-lead',
      kind: 'created_task',
      timestampMs: now - 80_000,
    },
    {
      id: 'e-handoff',
      from: 'session:local-pc:s-lead',
      to: 'session:mac-mini:s-remote',
      kind: 'handoff',
      timestampMs: now - 60_000,
      isCrossDevice: true,
    },
    {
      id: 'e-report',
      from: 'session:mac-mini:s-remote',
      to: 'session:local-pc:s-lead',
      kind: 'reported',
      timestampMs: now - 20_000,
      isCrossDevice: true,
    },
  ],
};

beforeEach(() => {
  mocks.pinSessionOrigin.mockReset();
  mocks.snapshotFn.mockReset();
  mocks.snapshotFn.mockResolvedValue(sampleSnapshot);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: {
        taskFlow: {
          snapshot: mocks.snapshotFn,
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('TaskFlowPage', () => {
  it('renders Gantt swimlanes, switches to DAG topology, inspects lineage & internal steps, and opens remote session', async () => {
    render(
      <MemoryRouter initialEntries={['/cc-agent/task-flow']}>
        <TaskFlowPage />
        <LocationEcho />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('主控调度会话').length).toBeGreaterThan(0);
    });

    // Gantt view active with SVG edges and internal plan step nodes expanded
    const gantt = screen.getByTestId('task-flow-gantt');
    expect(gantt).toBeTruthy();
    expect(gantt.querySelectorAll('svg path').length).toBeGreaterThan(0);
    expect(screen.getAllByText('汇总跨机结果').length).toBeGreaterThan(0);

    // Switch to DAG topology tab
    const dagTab = screen.getByRole('tab', { name: '依赖拓扑图' });
    await act(async () => {
      fireEvent.click(dagTab);
    });

    const dag = screen.getByTestId('task-flow-dag');
    expect(dag).toBeTruthy();
    expect(dag.querySelectorAll('svg path').length).toBeGreaterThan(0);

    // Select the remote session node inside DAG
    const remoteNodeBtn = dag.querySelector('[data-dag-node-id="session:mac-mini:s-remote"]') as HTMLButtonElement;
    expect(remoteNodeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(remoteNodeBtn);
    });

    const inspector = screen.getByTestId('task-flow-inspector');
    expect(inspector.textContent).toContain('Mac Mini 节点');
    expect(inspector.textContent).toContain('研发群 / Mac 节点');
    expect(inspector.textContent).toContain('主控调度会话');

    // Open remote session in Cindy -> should pin remote origin first and navigate
    const openBtn = screen.getByRole('button', { name: '在 Cindy 中打开' });
    await act(async () => {
      fireEvent.click(openBtn);
    });

    expect(mocks.pinSessionOrigin).toHaveBeenCalledWith('mac-mini', 's-remote');
    expect(screen.getByTestId('router-location').textContent).toBe('/cc-agent/s-remote');
  });

  it('shows active goal banner, switches to Goal Board tab with critical blocker fallback, and opens item session', async () => {
    const goalGetMock = vi.fn(async () => ({
      ownerId: 'owner-1',
      config: {
        version: 1 as const,
        updatedAtMs: now,
        goals: [
          {
            id: 'goal-m0',
            title: 'M0 可玩切片封板',
            objective: '完成 A–G 收口并通过 G-M0',
            pmRole: 'M01',
            pmSessionId: 's-m01',
            status: 'active' as const,
            exitCriteria: ['G-M0 PASS'],
            items: [
              {
                id: 'A',
                title: '范围基线定稿',
                status: 'completed' as const,
                blockedBy: [],
                ownerRole: 'M01',
                reviewerRole: 'Q01',
                reviewVerdict: 'PASS' as const,
                artifactPaths: ['design/06_production/m0-scope-baseline-20261116.md'],
                wave: 0,
                isCriticalPath: false,
                updatedAtMs: now - 10_000,
              },
              {
                id: 'B',
                title: '核心循环差距核对',
                status: 'in_review' as const,
                blockedBy: ['A'],
                ownerRole: 'D01',
                ownerSessionId: 's-d01',
                reviewerRole: 'M01',
                artifactPaths: ['design/02_gdd/m0-acceptance-slice-20261116.md'],
                wave: 1,
                isCriticalPath: true,
                updatedAtMs: now - 5_000,
              },
              {
                id: 'E',
                title: '固定可玩候选包',
                status: 'blocked' as const,
                blockedBy: ['A', 'B'],
                ownerRole: 'HB05',
                backupOwnerRole: 'HB01',
                reviewerRole: 'Q01',
                blockerReason: 'HB05 会话模型 token 上限报错',
                artifactPaths: ['build-wx/m0-review-20261116/'],
                wave: 2,
                isCriticalPath: true,
                updatedAtMs: now - 1_000,
              },
            ],
            createdAtMs: now - 20_000,
            updatedAtMs: now,
          },
        ],
      },
    }));

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        localDb: {
          taskFlow: {
            snapshot: mocks.snapshotFn,
          },
          goalBoard: {
            get: goalGetMock,
            transitionItem: vi.fn(),
          },
        },
      },
    });

    render(
      <MemoryRouter initialEntries={['/cc-agent/task-flow']}>
        <TaskFlowPage />
        <LocationEcho />
      </MemoryRouter>,
    );

    const strip = await screen.findByTestId('active-goal-strip');
    expect(strip.textContent).toContain('M0 可玩切片封板');
    expect(strip.textContent).toContain('Wave 2');

    const goalTab = screen.getByRole('tab', { name: /目标看板/ });
    await act(async () => {
      fireEvent.click(goalTab);
    });

    const board = await screen.findByTestId('task-flow-goal-board');
    expect(board).toBeTruthy();

    const blockerAlert = screen.getByTestId('goal-critical-blocker-alert');
    expect(blockerAlert.textContent).toContain('HB01');
    expect(blockerAlert.textContent).toContain('固定可玩候选包');

    const bCard = board.querySelector('[data-goal-item-id="B"]') as HTMLElement;
    expect(bCard).toBeTruthy();
    const openBtn = bCard.querySelector('button:last-of-type') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(openBtn);
    });
    expect(screen.getByTestId('router-location').textContent).toBe('/cc-agent/s-d01');
  });
});
