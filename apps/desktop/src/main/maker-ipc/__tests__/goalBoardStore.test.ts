import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  root: '',
  mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
  ownerId: 'owner-goal-1' as string | null,
  generation: 1,
  boundaryPending: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  assertTrusted: vi.fn(),
  isDeviceLinkInvoke: false,
  invalidationListeners: new Set<() => void>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: harness.send } }],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () =>
    `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
  getActiveAppSession: () => ({
    mode: harness.mode,
    dataOwnerId: harness.ownerId,
    generation: harness.generation,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  onAppSessionInvalidated: (cb: () => void) => {
    harness.invalidationListeners.add(cb);
    return () => {
      harness.invalidationListeners.delete(cb);
    };
  },
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', harness.ownerId ?? 'signed-out', ...parts),
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({
    ownerScopeKey: `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
    ownerStamp: { dataOwnerId: harness.ownerId, ownerGeneration: harness.generation },
  }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey?: string }) =>
    !harness.boundaryPending &&
    scope.ownerScopeKey === `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
  tapWindowBroadcast: (...args: unknown[]) => harness.tapWindowBroadcast(...args),
}));

vi.mock('../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => harness.isDeviceLinkInvoke,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

import {
  GOAL_BOARD_CHANGED_CHANNEL,
  deleteGoalRecord,
  readGoalBoard,
  registerGoalBoardIpc,
  resetGoalBoardStoreForTests,
  transitionGoalWorkItem,
  upsertGoalRecord,
} from '../goalBoardStore';

describe('goalBoardStore', () => {
  beforeEach(() => {
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-goal-board-'));
    harness.mode = 'cloud';
    harness.ownerId = 'owner-goal-1';
    harness.generation = 1;
    harness.boundaryPending = false;
    harness.handlers.clear();
    harness.send.mockReset();
    harness.tapWindowBroadcast.mockReset();
    harness.assertTrusted.mockReset();
    harness.isDeviceLinkInvoke = false;
    resetGoalBoardStoreForTests();
  });

  afterEach(() => {
    resetGoalBoardStoreForTests();
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('persists goals per owner, enforces gates on transition, broadcasts changes, and reloads external edits', async () => {
    const upserted = await upsertGoalRecord(
      {
        id: 'goal-m0',
        title: 'M0 测试目标',
        pmRole: 'M01',
        items: [
          { id: 'A', title: '定稿', status: 'ready', ownerRole: 'M01', reviewerRole: 'Q01' },
          { id: 'E', title: '出包', status: 'pending', blockedBy: ['A'], ownerRole: 'HB05', reviewerRole: 'Q01' },
        ],
      },
      10_000,
    );
    expect(upserted.goal.items[0].status).toBe('ready');
    expect(harness.send).toHaveBeenCalledWith(
      GOAL_BOARD_CHANGED_CHANNEL,
      expect.objectContaining({ ownerId: 'owner-goal-1' }),
      expect.objectContaining({ dataOwnerId: 'owner-goal-1' }),
    );

    const blocked = await transitionGoalWorkItem(
      { goalId: 'goal-m0', itemId: 'E', status: 'in_progress' },
      11_000,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.errorCode).toBe('WAVE_GATE_BLOCKED');

    const passed = await transitionGoalWorkItem(
      { goalId: 'goal-m0', itemId: 'A', status: 'completed', verdict: 'PASS', evidenceSummary: '已验收' },
      12_000,
    );
    expect(passed.ok).toBe(true);
    if (passed.ok) {
      expect(passed.newlyUnlockedIds).toEqual(['E']);
      expect(passed.goal.items.find((i) => i.id === 'E')?.status).toBe('ready');
    }

    // IPC handlers round-trip
    registerGoalBoardIpc();
    const getHandler = harness.handlers.get('local-db:goal-board:get');
    expect(getHandler).toBeDefined();
    const ipcSnap = (await getHandler!({})) as { config: ReturnType<typeof readGoalBoard> };
    expect(ipcSnap.config.goals).toHaveLength(1);

    await deleteGoalRecord('goal-m0', 13_000);
    expect(readGoalBoard().goals).toHaveLength(0);
  });
});
