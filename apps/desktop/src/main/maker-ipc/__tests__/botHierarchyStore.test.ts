import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOT_HIERARCHY_PREFERENCE_KEY,
  assignItemsToFolder,
  botHierarchyItemKey,
  createBotFolder,
  createEmptyBotHierarchyConfig,
  deleteBotFolder,
  renameBotFolder,
  type BotHierarchyConfigV1,
} from '../../../shared/botHierarchy';

const harness = vi.hoisted(() => ({
  root: '',
  mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
  ownerId: 'owner-a' as string | null,
  generation: 1,
  boundaryPending: false,
  deviceId: 'device-local-1',
  accessToken: 'token-123',
  chatApiBaseUrl: 'https://chat.example.test',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  assertTrusted: vi.fn(),
  isDeviceLinkInvoke: false,
  outboundFetch: vi.fn(),
  invalidationListeners: new Set<() => void>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.root },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: harness.send } },
    ],
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
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.ownerId,
    ownerGeneration: harness.generation,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  onAppSessionInvalidated: (cb: () => void) => {
    harness.invalidationListeners.add(cb);
    return () => {
      harness.invalidationListeners.delete(cb);
    };
  },
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(
      harness.root,
      'owners',
      harness.ownerId ?? 'signed-out',
      ...parts,
    ),
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: () =>
    harness.ownerId === null && harness.generation === 0
      ? undefined
      : { dataOwnerId: harness.ownerId, ownerGeneration: harness.generation },
  captureDataOwnerBroadcastScope: () => ({
    ownerScopeKey: `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
    ownerStamp: { dataOwnerId: harness.ownerId, ownerGeneration: harness.generation },
  }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey?: string }) =>
    !harness.boundaryPending &&
    scope.ownerScopeKey ===
      `${harness.mode}:${harness.ownerId ?? 'none'}:${harness.generation}`,
  tapWindowBroadcast: (...args: unknown[]) => harness.tapWindowBroadcast(...args),
}));

vi.mock('../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => harness.isDeviceLinkInvoke,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../authManager.js', () => ({
  getDeviceId: () => harness.deviceId,
  getAccessToken: () => harness.accessToken,
  refresh: vi.fn(async () => false),
}));

vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: (key: string) =>
    key === 'chatApiBaseUrl' ? harness.chatApiBaseUrl : null,
}));

vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({
  outboundFetch: (...args: unknown[]) => harness.outboundFetch(...args),
}));

import {
  BOT_HIERARCHY_CHANGED_CHANNEL,
  mutateMainBotHierarchyConfig,
  notifyBotHierarchyAccountPreferenceChanged,
  onBotHierarchyChanged,
  readBotHierarchyConfig,
  registerBotHierarchyIpc,
  resetBotHierarchyStoreForTests,
  writeBotHierarchyConfig,
} from '../botHierarchyStore';

describe('botHierarchyStore main persistence, IPC & cloud preference sync', () => {
  beforeEach(() => {
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-hierarchy-store-'));
    harness.mode = 'cloud';
    harness.ownerId = 'owner-a';
    harness.generation = 1;
    harness.boundaryPending = false;
    harness.deviceId = 'device-local-1';
    harness.accessToken = 'token-123';
    harness.isDeviceLinkInvoke = false;
    harness.handlers.clear();
    harness.send.mockClear();
    harness.tapWindowBroadcast.mockClear();
    harness.assertTrusted.mockClear();
    harness.outboundFetch.mockReset();
    harness.invalidationListeners.clear();
    resetBotHierarchyStoreForTests();
  });

  afterEach(() => {
    resetBotHierarchyStoreForTests();
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('persists owner-scoped configs independently across owners and fails closed on boundary transitions', async () => {
    // Default empty on first read
    expect(readBotHierarchyConfig().folders).toEqual({});

    // Write under owner-a
    harness.mode = 'local';
    await mutateMainBotHierarchyConfig(
      (cfg) => createBotFolder(cfg, { id: 'fa', name: 'Owner A Folder', now: 100 }).config,
      { syncCloud: false },
    );
    expect(readBotHierarchyConfig().folders.fa.name).toBe('Owner A Folder');

    // Switch to owner-b -> clean isolation
    harness.ownerId = 'owner-b';
    harness.generation = 2;
    expect(readBotHierarchyConfig().folders).toEqual({});

    await mutateMainBotHierarchyConfig(
      (cfg) => createBotFolder(cfg, { id: 'fb', name: 'Owner B Folder', now: 200 }).config,
      { syncCloud: false },
    );
    expect(readBotHierarchyConfig().folders.fb.name).toBe('Owner B Folder');

    // Switch back to owner-a -> owner-a data intact
    harness.ownerId = 'owner-a';
    harness.generation = 3;
    expect(Object.keys(readBotHierarchyConfig().folders)).toEqual(['fa']);

    // Pending owner boundary fails closed to empty
    harness.boundaryPending = true;
    expect(readBotHierarchyConfig().folders).toEqual({});
  });

  it('registers IPC handlers under local-db:bots:*, enforces trust/owner guards, and broadcasts changes', async () => {
    registerBotHierarchyIpc();
    expect(harness.handlers.has('local-db:bots:hierarchy:get')).toBe(true);
    expect(harness.handlers.has('local-db:bots:hierarchy:write')).toBe(true);
    expect(harness.handlers.has('local-db:bots:hierarchy:sync')).toBe(true);

    const listener = vi.fn();
    const unsub = onBotHierarchyChanged(listener);

    // Local mode (no cloud fetch)
    harness.mode = 'local';
    const getHandler = harness.handlers.get('local-db:bots:hierarchy:get')!;
    const writeHandler = harness.handlers.get('local-db:bots:hierarchy:write')!;

    const initial = await getHandler({ sender: {} });
    expect(harness.assertTrusted).toHaveBeenCalledTimes(1);
    expect(initial).toEqual({
      ownerId: 'owner-a',
      config: createEmptyBotHierarchyConfig(),
    });

    const nextCfg = createBotFolder(createEmptyBotHierarchyConfig(), {
      id: 'ipc-folder',
      name: 'Via IPC',
      now: 500,
    }).config;

    // Stale ownerId must NOT overwrite owner-a storage
    await writeHandler({ sender: {} }, { ownerId: 'wrong-owner', config: nextCfg });
    expect(readBotHierarchyConfig().folders).toEqual({});

    // Matching ownerId succeeds, broadcasts to BrowserWindow & tapWindowBroadcast, notifies listeners
    const saved = await writeHandler({ sender: {} }, { ownerId: 'owner-a', config: nextCfg });
    expect((saved as { config: BotHierarchyConfigV1 }).config.folders['ipc-folder'].name).toBe(
      'Via IPC',
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledWith(
      BOT_HIERARCHY_CHANGED_CHANNEL,
      expect.objectContaining({
        ownerId: 'owner-a',
      }),
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );
    expect(harness.tapWindowBroadcast).toHaveBeenCalledWith(
      BOT_HIERARCHY_CHANGED_CHANNEL,
      expect.objectContaining({ ownerId: 'owner-a' }),
      { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    );

    // Device-link invoke bypasses assertTrustedAppRendererEvent while still serving active owner
    harness.isDeviceLinkInvoke = true;
    const countBefore = harness.assertTrusted.mock.calls.length;
    const remoteRes = await getHandler({ sender: {} });
    expect(harness.assertTrusted).toHaveBeenCalledTimes(countBefore);
    expect((remoteRes as { config: BotHierarchyConfigV1 }).config.folders['ipc-folder'].name).toBe(
      'Via IPC',
    );

    unsub();
  });

  it('syncs with relayAccountPreferences, retries on REVISION_CONFLICT while LWW-merging, and handles preference.changed pushes', async () => {
    // Simulated remote server state
    let serverRevision = 3;
    let serverConfig = createBotFolder(createEmptyBotHierarchyConfig(), {
      id: 'remote-folder',
      name: 'From Computer B',
      now: 100,
      deviceId: 'device-remote-b',
    }).config;

    let postCount = 0;
    harness.outboundFetch.mockImplementation(
      async (
        url: string,
        init?: { method?: string; body?: string; headers?: Record<string, string> },
      ) => {
        expect(init?.headers).not.toHaveProperty('X-Chat-Actor');
      if (init?.method === 'GET' && url.includes(encodeURIComponent(BOT_HIERARCHY_PREFERENCE_KEY))) {
        return new Response(
          JSON.stringify([
            {
              key: BOT_HIERARCHY_PREFERENCE_KEY,
              revision: serverRevision,
              value: serverConfig,
            },
          ]),
          { status: 200 },
        );
      }
      if (init?.method === 'POST') {
        postCount += 1;
        const parsed = JSON.parse(init.body ?? '{}') as {
          expectedRevision: number;
          value: BotHierarchyConfigV1;
        };
        if (postCount === 1) {
          // Concurrent update from Computer B bumped server revision & added another folder!
          serverRevision = 4;
          serverConfig = assignItemsToFolder(
            renameBotFolder(serverConfig, 'remote-folder', 'Renamed By B', {
              now: 250,
              deviceId: 'device-remote-b',
            }),
            [botHierarchyItemKey('bot-b')],
            'remote-folder',
            { now: 260, deviceId: 'device-remote-b' },
          );
          return new Response(
            JSON.stringify({ error: { code: 'REVISION_CONFLICT' } }),
            { status: 409 },
          );
        }
        expect(parsed.expectedRevision).toBe(serverRevision);
        serverRevision += 1;
        serverConfig = parsed.value;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const localCreated = createBotFolder(createEmptyBotHierarchyConfig(), {
      id: 'local-folder',
      name: 'Created On A',
      now: 200,
      deviceId: 'device-local-1',
    }).config;

    await writeBotHierarchyConfig(localCreated, { awaitCloudSync: true });

    expect(postCount).toBe(2);
    // Server now contains BOTH Computer A's folder AND Computer B's concurrent rename & assignment
    expect(serverConfig.folders['local-folder'].name).toBe('Created On A');
    expect(serverConfig.folders['remote-folder'].name).toBe('Renamed By B');
    expect(serverConfig.assignments['bot:bot-b'].folderId).toBe('remote-folder');

    // Local store also received Computer B's merged state during conflict resolution!
    const storedLocal = readBotHierarchyConfig();
    expect(storedLocal.folders['remote-folder'].name).toBe('Renamed By B');
    expect(storedLocal.assignments['bot:bot-b'].folderId).toBe('remote-folder');

    // Unrelated preference key is ignored cleanly without making network calls
    const fetchCallsBefore = harness.outboundFetch.mock.calls.length;
    await notifyBotHierarchyAccountPreferenceChanged('other.preference.key');
    expect(harness.outboundFetch).toHaveBeenCalledTimes(fetchCallsBefore);

    // Real preference.changed push pulls remote tombstone deletion and broadcasts update
    serverConfig = deleteBotFolder(serverConfig, 'local-folder', {
      now: 400,
      deviceId: 'device-remote-b',
    });
    serverRevision += 1;
    const listener = vi.fn();
    onBotHierarchyChanged(listener);

    await notifyBotHierarchyAccountPreferenceChanged(BOT_HIERARCHY_PREFERENCE_KEY);
    expect(readBotHierarchyConfig().folders['local-folder']).toBeUndefined();
    expect(readBotHierarchyConfig().deletedFolderIds['local-folder']).toBe(400);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
