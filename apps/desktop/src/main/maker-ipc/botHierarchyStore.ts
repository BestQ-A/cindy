import { BrowserWindow, ipcMain } from 'electron';

import {
  BOT_HIERARCHY_PREFERENCE_KEY,
  createEmptyBotHierarchyConfig,
  mergeBotHierarchyConfigs,
  normalizeBotHierarchyConfig,
  type BotHierarchyConfigV1,
} from '../../shared/botHierarchy.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  onAppSessionInvalidated,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import {
  captureDataOwnerBroadcastScope,
  getSafeDataOwnerPushStamp,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
} from '../device-link/broadcast-tap.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsFile,
} from '../maker-host/override-settings-file.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';

const log = createLogger('maker-ipc:bot-hierarchy');

export const BOT_HIERARCHY_CHANGED_CHANNEL = 'local-db:bots:hierarchy:changed' as const;
const HIERARCHY_FILE_NAME = 'bot-hierarchy.json';
const HIERARCHY_MAX_BYTES = 2 * 1024 * 1024;

export interface BotHierarchySnapshot {
  ownerId: string | null;
  config: BotHierarchyConfigV1;
}

export type BotHierarchyChangeListener = (snapshot: BotHierarchySnapshot) => void;

export interface WriteBotHierarchyOptions {
  /** Whether to merge with current disk state (`merge`) or overwrite (`replace`). Default: `'replace'`. */
  mode?: 'merge' | 'replace';
  /** Whether to push updates to the signed-in cloud account preference. Default: `true`. */
  syncCloud?: boolean;
  /** When `true`, awaits the cloud preference sync before returning. Default: `false`. */
  awaitCloudSync?: boolean;
  /** Explicit deviceId override (defaults to `authManager.getDeviceId()` when available). */
  deviceId?: string;
}

const listeners = new Set<BotHierarchyChangeListener>();
let storeFile: OverrideSettingsFile<BotHierarchyConfigV1> | null = null;
let storeFilePathCache: string | null = null;
let ipcRegistered = false;
let localWriteChain: Promise<unknown> = Promise.resolve();
let cloudSyncChain: Promise<unknown> = Promise.resolve();
let syncedScopeKey: string | null = null;
let sessionInvalidationUnsub: (() => void) | null = null;

function ensureSessionInvalidationHook(): void {
  if (sessionInvalidationUnsub) return;
  try {
    sessionInvalidationUnsub = onAppSessionInvalidated(() => {
      syncedScopeKey = null;
    });
  } catch {
    // Electron/app storage may not be initialized in minimal unit tests.
  }
}

function getSafeScopeKey(): string {
  try {
    return activeOwnerScopeKey();
  } catch {
    return 'default';
  }
}

function resolveHierarchyFilePath(): string {
  return ownerScopedUserDataPath(HIERARCHY_FILE_NAME);
}

function getStoreFile(): OverrideSettingsFile<BotHierarchyConfigV1> {
  ensureSessionInvalidationHook();
  const currentPath = resolveHierarchyFilePath();
  if (!storeFile || storeFilePathCache !== currentPath) {
    storeFilePathCache = currentPath;
    storeFile = createOverrideSettingsFile<BotHierarchyConfigV1>({
      filePath: resolveHierarchyFilePath,
      defaults: () => createEmptyBotHierarchyConfig(),
      normalize: (raw) => normalizeBotHierarchyConfig(raw),
      mergeOverrides: ({ next }) => ({ ...next }) as unknown as Record<string, unknown>,
      log,
      label: 'bot-hierarchy',
      scopeKey: getSafeScopeKey,
      maxBytes: HIERARCHY_MAX_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: true,
    });
  }
  return storeFile;
}

function getSafeOwnerId(): string | null {
  try {
    if (isAppSessionBoundaryPending()) return null;
    return getActiveAppSession().dataOwnerId;
  } catch {
    return null;
  }
}

function isCloudSyncSessionActive(): boolean {
  try {
    if (isAppSessionBoundaryPending()) return false;
    const session = getActiveAppSession();
    return session.mode === 'cloud' && session.dataOwnerId !== null;
  } catch {
    return false;
  }
}

async function getSafeDeviceId(): Promise<string | undefined> {
  try {
    const authMod = await import('../authManager.js');
    const id = authMod.getDeviceId?.();
    return typeof id === 'string' && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isRequestOwnerCurrent(ownerId: unknown): boolean {
  if (ownerId === undefined) {
    return getSafeOwnerId() !== null;
  }
  const current = getSafeOwnerId();
  return typeof ownerId === 'string' && !!current && ownerId === current;
}

function canonicalConfigSignature(config: BotHierarchyConfigV1): string {
  const folderEntries = Object.keys(config.folders)
    .sort()
    .map((id) => {
      const f = config.folders[id];
      return [id, f.name, f.parentId, f.order, f.createdAt, f.updatedAt, f.updatedByDeviceId ?? ''];
    });
  const assignmentEntries = Object.keys(config.assignments)
    .sort()
    .map((key) => {
      const a = config.assignments[key];
      return [key, a.folderId, a.order, a.updatedAt, a.updatedByDeviceId ?? ''];
    });
  const tombstoneEntries = Object.keys(config.deletedFolderIds)
    .sort()
    .map((id) => [id, config.deletedFolderIds[id]]);
  return JSON.stringify([
    config.version,
    config.updatedAt,
    config.updatedByDeviceId ?? '',
    folderEntries,
    assignmentEntries,
    config.rootOrder,
    tombstoneEntries,
  ]);
}

function configsEqual(a: BotHierarchyConfigV1, b: BotHierarchyConfigV1): boolean {
  return canonicalConfigSignature(a) === canonicalConfigSignature(b);
}

function withLocalWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = localWriteChain.then(task, task);
  localWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function withCloudSyncLock<T>(task: () => Promise<T>): Promise<T> {
  const run = cloudSyncChain.then(task, task);
  cloudSyncChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function emitHierarchyChanged(
  snapshot: BotHierarchySnapshot,
  ownerStamp?: DataOwnerPushStamp,
): void {
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      log.warn('bot hierarchy change listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let windows: BrowserWindow[] = [];
  try {
    windows = BrowserWindow?.getAllWindows?.() ?? [];
  } catch {
    windows = [];
  }
  for (const win of windows) {
    try {
      if (win.isDestroyed()) continue;
      if (ownerStamp === undefined) {
        win.webContents.send(BOT_HIERARCHY_CHANGED_CHANNEL, snapshot);
      } else {
        win.webContents.send(BOT_HIERARCHY_CHANGED_CHANNEL, snapshot, ownerStamp);
      }
    } catch {
      // Per-window send failure must not block other windows.
    }
  }

  try {
    tapWindowBroadcast(BOT_HIERARCHY_CHANGED_CHANNEL, snapshot, ownerStamp);
  } catch {
    // Device-link broadcast tap is optional in minimal test harnesses.
  }
}

function hasAnyHierarchyContent(config: BotHierarchyConfigV1): boolean {
  return (
    config.updatedAt > 0 ||
    Object.keys(config.folders).length > 0 ||
    Object.keys(config.assignments).length > 0 ||
    config.rootOrder.length > 0 ||
    Object.keys(config.deletedFolderIds).length > 0
  );
}

function commitLocalAtomic(
  transform: (current: BotHierarchyConfigV1) => BotHierarchyConfigV1,
): Promise<{
  previous: BotHierarchyConfigV1;
  next: BotHierarchyConfigV1;
  changed: boolean;
}> {
  return withLocalWriteLock(async () => {
    const file = getStoreFile();
    file.invalidateIfChanged();
    const previous = normalizeBotHierarchyConfig(file.read());
    const next = await file.updateAtomic(
      (state) => {
        const current = normalizeBotHierarchyConfig(state.value);
        const computed = normalizeBotHierarchyConfig(transform(current));
        return {
          version: 1,
          updatedAt: computed.updatedAt,
          updatedByDeviceId: computed.updatedByDeviceId,
          folders: computed.folders,
          assignments: computed.assignments,
          rootOrder: computed.rootOrder,
          deletedFolderIds: computed.deletedFolderIds,
        };
      },
      { preserveDefaults: true },
    );
    const normalizedNext = normalizeBotHierarchyConfig(next);
    return {
      previous,
      next: normalizedNext,
      changed: !configsEqual(previous, normalizedNext),
    };
  });
}

async function pullCloudPreferenceIntoLocal(pushLocalIfAhead = false): Promise<BotHierarchySnapshot> {
  return withCloudSyncLock(async () => {
    if (!isCloudSyncSessionActive()) {
      return readBotHierarchySnapshot();
    }
    const scope = captureDataOwnerBroadcastScope();
    try {
      const { readAccountPreference } = await import('../device-link/relayAccountPreferences.js');
      const { value } = await readAccountPreference(BOT_HIERARCHY_PREFERENCE_KEY);
      if (!isDataOwnerBroadcastScopeCurrent(scope)) {
        return readBotHierarchySnapshot();
      }
      if (value === null || value === undefined) {
        if (pushLocalIfAhead) {
          const currentLocal = readBotHierarchyConfig();
          if (hasAnyHierarchyContent(currentLocal)) {
            await pushLocalConfigToCloud(currentLocal, scope);
          }
        }
        return readBotHierarchySnapshot();
      }
      const remote = normalizeBotHierarchyConfig(value);
      const { next, changed } = await commitLocalAtomic((current) =>
        mergeBotHierarchyConfigs(current, remote),
      );
      if (!isDataOwnerBroadcastScopeCurrent(scope)) {
        return readBotHierarchySnapshot();
      }
      if (changed) {
        emitHierarchyChanged(
          { ownerId: getSafeOwnerId(), config: next },
          scope.ownerStamp,
        );
      }
      if (pushLocalIfAhead && !configsEqual(next, remote)) {
        await pushLocalConfigToCloud(next, scope);
        if (!isDataOwnerBroadcastScopeCurrent(scope)) {
          return readBotHierarchySnapshot();
        }
      }
      return readBotHierarchySnapshot();
    } catch (error) {
      log.warn('bot hierarchy cloud preference pull failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return readBotHierarchySnapshot();
    }
  });
}

async function pushLocalConfigToCloud(
  snapshotConfig: BotHierarchyConfigV1,
  capturedScope?: ReturnType<typeof captureDataOwnerBroadcastScope>,
): Promise<void> {
  if (!isCloudSyncSessionActive()) return;
  const scope = capturedScope ?? captureDataOwnerBroadcastScope();
  try {
    const { updateAccountPreference } = await import('../device-link/relayAccountPreferences.js');
    let discoveredRemoteMerge: BotHierarchyConfigV1 | null = null;

    await updateAccountPreference(BOT_HIERARCHY_PREFERENCE_KEY, (remoteRaw) => {
      if (!isDataOwnerBroadcastScopeCurrent(scope)) {
        return undefined;
      }
      const latestLocal = normalizeBotHierarchyConfig(
        mergeBotHierarchyConfigs(snapshotConfig, readBotHierarchyConfig()),
      );
      if (remoteRaw === null || remoteRaw === undefined) {
        return latestLocal;
      }
      const remote = normalizeBotHierarchyConfig(remoteRaw);
      const merged = mergeBotHierarchyConfigs(latestLocal, remote);
      if (!configsEqual(merged, latestLocal)) {
        discoveredRemoteMerge = merged;
      }
      if (configsEqual(merged, remote)) {
        return undefined;
      }
      return merged;
    });

    if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
    if (discoveredRemoteMerge) {
      const mergedFromRemote = discoveredRemoteMerge;
      const { next, changed } = await commitLocalAtomic((current) =>
        mergeBotHierarchyConfigs(current, mergedFromRemote),
      );
      if (changed && isDataOwnerBroadcastScopeCurrent(scope)) {
        emitHierarchyChanged(
          { ownerId: getSafeOwnerId(), config: next },
          scope.ownerStamp,
        );
      }
    }
  } catch (error) {
    log.warn('bot hierarchy cloud preference push failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleCloudPush(config: BotHierarchyConfigV1): Promise<void> {
  if (!isCloudSyncSessionActive()) return Promise.resolve();
  const scope = captureDataOwnerBroadcastScope();
  return withCloudSyncLock(() => pushLocalConfigToCloud(config, scope));
}

function maybeTriggerInitialCloudPull(): void {
  if (!isCloudSyncSessionActive()) return;
  const scopeKey = getSafeScopeKey();
  if (syncedScopeKey === scopeKey) return;
  syncedScopeKey = scopeKey;
  void pullCloudPreferenceIntoLocal(true);
}

/**
 * Read the owner-scoped bot folder hierarchy configuration from main storage.
 * Fails closed to an empty config when an owner boundary transition is pending.
 */
export function readBotHierarchyConfig(): BotHierarchyConfigV1 {
  try {
    if (isAppSessionBoundaryPending()) {
      return createEmptyBotHierarchyConfig();
    }
    const file = getStoreFile();
    file.invalidateIfChanged();
    return normalizeBotHierarchyConfig(file.read());
  } catch (error) {
    log.warn('bot hierarchy read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return createEmptyBotHierarchyConfig();
  }
}

/** Read current hierarchy config paired with the active ownerId for renderer IPC responses. */
export function readBotHierarchySnapshot(): BotHierarchySnapshot {
  const ownerId = getSafeOwnerId();
  if (!ownerId || isAppSessionBoundaryPending()) {
    return { ownerId: null, config: createEmptyBotHierarchyConfig() };
  }
  return {
    ownerId,
    config: readBotHierarchyConfig(),
  };
}

/** Subscribe to main-process bot hierarchy updates. Returns an unsubscribe callback. */
export function onBotHierarchyChanged(listener: BotHierarchyChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Persist a full hierarchy config atomically, broadcast changes, and schedule cloud sync. */
export async function writeBotHierarchyConfig(
  config: BotHierarchyConfigV1,
  options?: WriteBotHierarchyOptions,
): Promise<BotHierarchyConfigV1> {
  const scope = captureDataOwnerBroadcastScope();
  const mode = options?.mode ?? 'replace';
  const deviceId = options?.deviceId ?? (await getSafeDeviceId());
  const rawNormalized = normalizeBotHierarchyConfig(config);
  const incoming: BotHierarchyConfigV1 =
    deviceId && !rawNormalized.updatedByDeviceId
      ? { ...rawNormalized, updatedByDeviceId: deviceId }
      : rawNormalized;

  const { next, changed } = await commitLocalAtomic((current) =>
    mode === 'merge' ? mergeBotHierarchyConfigs(current, incoming) : incoming,
  );

  if (changed && isDataOwnerBroadcastScopeCurrent(scope)) {
    const snapshot: BotHierarchySnapshot = {
      ownerId: getSafeOwnerId(),
      config: next,
    };
    emitHierarchyChanged(snapshot, scope.ownerStamp);
  }

  if (options?.syncCloud !== false && isDataOwnerBroadcastScopeCurrent(scope)) {
    const syncPromise = scheduleCloudPush(next);
    if (options?.awaitCloudSync) {
      await syncPromise;
    }
  }

  return next;
}

/**
 * Atomically read-modify-write the owner-scoped bot hierarchy under the cross-process lock,
 * broadcast local/device-link listeners, and sync to the signed-in account preference.
 */
export async function mutateMainBotHierarchyConfig(
  mutator: (current: BotHierarchyConfigV1) => BotHierarchyConfigV1,
  options?: Omit<WriteBotHierarchyOptions, 'mode'>,
): Promise<BotHierarchyConfigV1> {
  const scope = captureDataOwnerBroadcastScope();
  const deviceId = options?.deviceId ?? (await getSafeDeviceId());

  const { next, changed } = await commitLocalAtomic((current) => {
    const mutated = normalizeBotHierarchyConfig(mutator(current));
    if (deviceId && !mutated.updatedByDeviceId) {
      return { ...mutated, updatedByDeviceId: deviceId };
    }
    return mutated;
  });

  if (changed && isDataOwnerBroadcastScopeCurrent(scope)) {
    const snapshot: BotHierarchySnapshot = {
      ownerId: getSafeOwnerId(),
      config: next,
    };
    emitHierarchyChanged(snapshot, scope.ownerStamp);
  }

  if (options?.syncCloud !== false && isDataOwnerBroadcastScopeCurrent(scope)) {
    const syncPromise = scheduleCloudPush(next);
    if (options?.awaitCloudSync) {
      await syncPromise;
    }
  }

  return next;
}

/**
 * React to `preference.changed` notifications pushed by the chat server relay.
 * Only pulls when `key` is omitted or equals `BOT_HIERARCHY_PREFERENCE_KEY`.
 */
export async function notifyBotHierarchyAccountPreferenceChanged(key?: string): Promise<void> {
  if (key !== undefined && key !== BOT_HIERARCHY_PREFERENCE_KEY) {
    return;
  }
  await pullCloudPreferenceIntoLocal(false);
}

/** Register owner-scoped IPC channels for renderer and authorized device-link controllers. */
export function registerBotHierarchyIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('local-db:bots:hierarchy:get', (event) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    maybeTriggerInitialCloudPull();
    return readBotHierarchySnapshot();
  });

  ipcMain.handle('local-db:bots:hierarchy:write', async (event, raw: unknown) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (!isDeviceLinkInvoke() && !isRequestOwnerCurrent(body.ownerId)) {
      return readBotHierarchySnapshot();
    }
    if (!getSafeOwnerId()) {
      return readBotHierarchySnapshot();
    }
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const incoming = normalizeBotHierarchyConfig(body.config ?? raw);
    const next = await writeBotHierarchyConfig(incoming, { mode });
    return {
      ownerId: getSafeOwnerId(),
      config: next,
    } satisfies BotHierarchySnapshot;
  });

  ipcMain.handle('local-db:bots:hierarchy:sync', async (event) => {
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
    }
    return pullCloudPreferenceIntoLocal(true);
  });
}

/** Reset internal singleton caches (for isolated unit tests only). */
export function resetBotHierarchyStoreForTests(): void {
  listeners.clear();
  storeFile = null;
  storeFilePathCache = null;
  ipcRegistered = false;
  syncedScopeKey = null;
  localWriteChain = Promise.resolve();
  cloudSyncChain = Promise.resolve();
}
