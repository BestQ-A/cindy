/**
 * Multi-level bot/group folder hierarchy data model, LWW multi-device merge,
 * CRUD/reordering primitives, rule-based batch organization, and smart grouping.
 *
 * Pure shared module (browser + Node + Electron main safe, zero Node builtins).
 */

export const BOT_HIERARCHY_PREFERENCE_KEY = 'companion.hierarchy.v1' as const;
export const BOT_HIERARCHY_MAX_DEPTH = 6;
export const BOT_HIERARCHY_MAX_FOLDERS = 200;

const MAX_FOLDER_NAME_LENGTH = 120;
let fallbackIdCounter = 0;

export interface BotHierarchyFolder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
  updatedByDeviceId?: string;
}

export interface BotHierarchyAssignment {
  folderId: string | null;
  order: number;
  updatedAt: number;
  updatedByDeviceId?: string;
}

export interface BotHierarchyConfigV1 {
  version: 1;
  updatedAt: number;
  updatedByDeviceId?: string;
  folders: Record<string, BotHierarchyFolder>;
  assignments: Record<string, BotHierarchyAssignment>;
  /** Ordered ungrouped item keys displayed at root level. */
  rootOrder: string[];
  /** Folder deletion tombstones keyed by folderId -> deletion timestamp (ms). */
  deletedFolderIds: Record<string, number>;
}

export interface BotRosterOrganizeEntry {
  /** Explicit hierarchy item key (defaults to botHierarchyItemKey / groupHierarchyItemKey). */
  itemKey?: string;
  kind?: 'bot' | 'group';
  botId?: string;
  groupId?: string;
  deviceId?: string | null;
  deviceName?: string | null;
  name: string;
  title?: string | null;
  role?: string | null;
  description?: string | null;
  isRemote?: boolean;
}

export type BotBatchOrganizeRule =
  | {
      type?: 'assign';
      /** Target folder path segments (e.g. ['万界', '技术研发'] or '万界/技术研发'). */
      folderPath: string[] | string;
      itemKeys?: string[];
      botIds?: string[];
      namePrefix?: string;
      keywords?: string[];
      roleCodes?: string[];
      pattern?: string;
      flags?: string;
    }
  | {
      type: 'create-folder';
      folderPath: string[] | string;
    }
  | {
      type: 'rename-folder';
      folderId: string;
      name: string;
    }
  | {
      type: 'move-folder';
      folderId: string;
      newParentId: string | null;
    }
  | {
      type: 'delete-folder';
      folderId: string;
      mode?: 'promote-children' | 'cascade';
    }
  | {
      type: 'unassign';
      itemKeys?: string[];
      botIds?: string[];
    };

export interface BotHierarchyFolderOption {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  order: number;
  path: string[];
  pathLabel: string;
  folder: BotHierarchyFolder;
}

export interface BotHierarchyFolderTreeNode {
  folder: BotHierarchyFolder;
  depth: number;
  path: string[];
  children: BotHierarchyFolderTreeNode[];
}

export interface BotOrganizeSummary {
  createdFolderIds: string[];
  updatedFolderIds: string[];
  deletedFolderIds: string[];
  assignedItemCount: number;
  matchedItemKeys: string[];
  skippedForLimits: number;
}

export interface BotOrganizeResult {
  config: BotHierarchyConfigV1;
  summary: BotOrganizeSummary;
}

export interface CreateBotFolderInput {
  id?: string;
  name: string;
  parentId?: string | null;
  order?: number;
  now?: number;
  deviceId?: string;
}

export interface CreateBotFolderResult {
  config: BotHierarchyConfigV1;
  folder: BotHierarchyFolder;
}

export interface MutationOptions {
  now?: number;
  deviceId?: string;
}

export interface DeleteBotFolderOptions extends MutationOptions {
  mode?: 'promote-children' | 'cascade';
}

export interface AssignItemsOptions extends MutationOptions {
  position?: 'start' | 'end';
}

export interface ApplyBatchOrganizeOptions extends MutationOptions {
  overwriteExistingAssignments?: boolean;
}

export interface BuildSmartBotHierarchyOptions extends MutationOptions {
  /** If true, rebuilds folders cleanly instead of preserving existing custom folders. */
  replaceExisting?: boolean;
  /** If true, also reassigns items that are already inside an existing folder. */
  overwriteExistingAssignments?: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeOptionalString(value: unknown, maxLen = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function sanitizeFolderName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  return trimmed.length > MAX_FOLDER_NAME_LENGTH
    ? trimmed.slice(0, MAX_FOLDER_NAME_LENGTH).trim()
    : trimmed;
}

function sanitizeTimestamp(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function sanitizeOrder(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function resolveMutationTimestamp(currentUpdatedAt: number, explicitNow?: number): number {
  if (typeof explicitNow === 'number' && Number.isFinite(explicitNow) && explicitNow >= 0) {
    return Math.floor(explicitNow);
  }
  return Math.max(Date.now(), currentUpdatedAt + 1);
}

function createFolderId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === 'string' && uuid.length > 0) {
    return uuid;
  }
  fallbackIdCounter = (fallbackIdCounter + 1) % 1_000_000;
  return `folder_${Date.now().toString(36)}_${fallbackIdCounter.toString(36)}`;
}

function compareFolders(a: BotHierarchyFolder, b: BotHierarchyFolder): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) return nameCmp;
  return a.id.localeCompare(b.id);
}

function compareStringArrays(a: string[], b: string[]): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i += 1) {
    if (a[i] !== b[i]) return a[i].localeCompare(b[i]);
  }
  return a.length - b.length;
}

function compareDevices(a?: string, b?: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

function isLwwNewer(
  candUpdatedAt: number,
  candDevice: string | undefined,
  candTieKey: string,
  currUpdatedAt: number,
  currDevice: string | undefined,
  currTieKey: string,
): boolean {
  if (candUpdatedAt !== currUpdatedAt) return candUpdatedAt > currUpdatedAt;
  const devCmp = compareDevices(candDevice, currDevice);
  if (devCmp !== 0) return devCmp > 0;
  return candTieKey > currTieKey;
}

function folderTieKey(folder: BotHierarchyFolder): string {
  return JSON.stringify([
    folder.id,
    folder.name,
    folder.parentId,
    folder.order,
    folder.createdAt,
  ]);
}

function assignmentTieKey(itemKey: string, assignment: BotHierarchyAssignment): string {
  return JSON.stringify([itemKey, assignment.folderId, assignment.order]);
}

function cloneConfig(config: BotHierarchyConfigV1): BotHierarchyConfigV1 {
  const folders: Record<string, BotHierarchyFolder> = {};
  for (const [id, folder] of Object.entries(config.folders)) {
    folders[id] = { ...folder };
  }
  const assignments: Record<string, BotHierarchyAssignment> = {};
  for (const [key, assignment] of Object.entries(config.assignments)) {
    assignments[key] = { ...assignment };
  }
  return {
    version: 1,
    updatedAt: config.updatedAt,
    ...(config.updatedByDeviceId ? { updatedByDeviceId: config.updatedByDeviceId } : {}),
    folders,
    assignments,
    rootOrder: [...config.rootOrder],
    deletedFolderIds: { ...config.deletedFolderIds },
  };
}

/**
 * Create an empty hierarchy config. Starts at `updatedAt: 0` unless an explicit
 * timestamp is supplied so uninitialized local state never shadows real synced folders.
 */
export function createEmptyBotHierarchyConfig(
  now = 0,
  deviceId?: string,
): BotHierarchyConfigV1 {
  const cleanDevice = sanitizeOptionalString(deviceId, 128);
  return {
    version: 1,
    updatedAt: sanitizeTimestamp(now, 0),
    ...(cleanDevice ? { updatedByDeviceId: cleanDevice } : {}),
    folders: {},
    assignments: {},
    rootOrder: [],
    deletedFolderIds: {},
  };
}

/** Build the canonical hierarchy assignment key for a local or remote bot. */
export function botHierarchyItemKey(botId: string, deviceId?: string | null): string {
  const bid = typeof botId === 'string' ? botId.trim() : '';
  if (!bid) return '';
  const did = typeof deviceId === 'string' ? deviceId.trim() : '';
  return did ? `remote-bot:${did}:${bid}` : `bot:${bid}`;
}

/** Build the canonical hierarchy assignment key for a group chat. */
export function groupHierarchyItemKey(groupId: string): string {
  const gid = typeof groupId === 'string' ? groupId.trim() : '';
  return gid ? `group:${gid}` : '';
}

function resolveEntryItemKey(entry: BotRosterOrganizeEntry): string {
  const explicit = sanitizeOptionalString(entry.itemKey, 512);
  if (explicit) return explicit;
  if (entry.kind === 'group' && entry.groupId) {
    return groupHierarchyItemKey(entry.groupId);
  }
  if (entry.botId) {
    return botHierarchyItemKey(entry.botId, entry.deviceId);
  }
  if (entry.groupId) {
    return groupHierarchyItemKey(entry.groupId);
  }
  return '';
}

/**
 * Repair, sanitize, and validate arbitrary/corrupted hierarchy payloads:
 * - Breaks all parent cycles deterministically into a valid forest.
 * - Clamps folder nesting to `BOT_HIERARCHY_MAX_DEPTH`.
 * - Caps total folder count to `BOT_HIERARCHY_MAX_FOLDERS`.
 * - Drops invalid folder references from assignments and deduplicates `rootOrder`.
 */
export function normalizeBotHierarchyConfig(raw: unknown): BotHierarchyConfigV1 {
  if (!isPlainRecord(raw)) {
    return createEmptyBotHierarchyConfig();
  }

  const rawDeleted = isPlainRecord(raw.deletedFolderIds) ? raw.deletedFolderIds : {};
  const deletedFolderIds: Record<string, number> = {};
  let maxObservedTs = sanitizeTimestamp(raw.updatedAt, 0);

  for (const [rawId, rawTs] of Object.entries(rawDeleted)) {
    const id = sanitizeOptionalString(rawId, 256);
    const ts = sanitizeTimestamp(rawTs, -1);
    if (!id || ts <= 0) continue;
    deletedFolderIds[id] = ts;
    if (ts > maxObservedTs) maxObservedTs = ts;
  }

  const rawFolders = isPlainRecord(raw.folders) ? raw.folders : {};
  let folders: Record<string, BotHierarchyFolder> = {};

  for (const [keyId, candidate] of Object.entries(rawFolders)) {
    const id = sanitizeOptionalString(keyId, 256);
    if (!id || !isPlainRecord(candidate)) continue;
    const name = sanitizeFolderName(candidate.name);
    if (!name) continue;
    const createdAt = sanitizeTimestamp(candidate.createdAt, 0);
    const updatedAt = sanitizeTimestamp(candidate.updatedAt, createdAt);
    const deletedAt = deletedFolderIds[id];
    if (deletedAt !== undefined && deletedAt >= updatedAt) {
      // Deletion tombstone is newer or equal -> keep folder deleted.
      continue;
    }
    if (deletedAt !== undefined && updatedAt > deletedAt) {
      delete deletedFolderIds[id];
    }
    const parentIdRaw = sanitizeOptionalString(candidate.parentId, 256) ?? null;
    const updatedByDeviceId = sanitizeOptionalString(candidate.updatedByDeviceId, 128);
    folders[id] = {
      id,
      name,
      parentId: parentIdRaw === id ? null : parentIdRaw,
      order: sanitizeOrder(candidate.order, 0),
      createdAt,
      updatedAt,
      ...(updatedByDeviceId ? { updatedByDeviceId } : {}),
    };
    if (updatedAt > maxObservedTs) maxObservedTs = updatedAt;
  }

  // Clear references to nonexistent parents.
  for (const folder of Object.values(folders)) {
    if (folder.parentId !== null && !folders[folder.parentId]) {
      folder.parentId = null;
    }
  }

  // Deterministic cycle breaking: walk ancestors from each node sorted canonically.
  const orderedIds = Object.values(folders)
    .sort(compareFolders)
    .map((f) => f.id);

  for (const startId of orderedIds) {
    const seen = new Set<string>();
    let currId: string | null = startId;
    let prevId: string | null = null;
    while (currId !== null) {
      if (seen.has(currId)) {
        // Break back-edge so the parent chain becomes acyclic.
        if (prevId && folders[prevId]) {
          folders[prevId].parentId = null;
        }
        break;
      }
      seen.add(currId);
      prevId = currId;
      currId = folders[currId]?.parentId ?? null;
    }
  }

  // Enforce BOT_HIERARCHY_MAX_DEPTH = 6 using BFS / topological order.
  const depthMap = new Map<string, number>();
  const getRawDepth = (id: string): number => {
    const cached = depthMap.get(id);
    if (cached !== undefined) return cached;
    const folder = folders[id];
    if (!folder || folder.parentId === null || !folders[folder.parentId]) {
      depthMap.set(id, 1);
      return 1;
    }
    const d = getRawDepth(folder.parentId) + 1;
    depthMap.set(id, d);
    return d;
  };
  for (const id of orderedIds) {
    getRawDepth(id);
  }

  const byRawDepth = [...Object.values(folders)].sort((a, b) => {
    const da = depthMap.get(a.id) ?? 1;
    const db = depthMap.get(b.id) ?? 1;
    if (da !== db) return da - db;
    return compareFolders(a, b);
  });

  for (const folder of byRawDepth) {
    if (folder.parentId === null) {
      depthMap.set(folder.id, 1);
      continue;
    }
    let parentId: string | null = folder.parentId;
    let parentDepth = parentId ? (depthMap.get(parentId) ?? 1) : 0;
    while (parentId !== null && parentDepth >= BOT_HIERARCHY_MAX_DEPTH) {
      parentId = folders[parentId]?.parentId ?? null;
      parentDepth = parentId ? (depthMap.get(parentId) ?? 1) : 0;
    }
    folder.parentId = parentId;
    depthMap.set(folder.id, parentId === null ? 1 : parentDepth + 1);
  }

  // Enforce BOT_HIERARCHY_MAX_FOLDERS = 200 (prefer shallower folders, then deterministic order).
  if (Object.keys(folders).length > BOT_HIERARCHY_MAX_FOLDERS) {
    const kept = [...Object.values(folders)]
      .sort((a, b) => {
        const da = depthMap.get(a.id) ?? 1;
        const db = depthMap.get(b.id) ?? 1;
        if (da !== db) return da - db;
        return compareFolders(a, b);
      })
      .slice(0, BOT_HIERARCHY_MAX_FOLDERS);
    const nextFolders: Record<string, BotHierarchyFolder> = {};
    for (const folder of kept) {
      nextFolders[folder.id] = folder;
    }
    for (const folder of Object.values(nextFolders)) {
      if (folder.parentId !== null && !nextFolders[folder.parentId]) {
        folder.parentId = null;
      }
    }
    folders = nextFolders;
  }

  const rawAssignments = isPlainRecord(raw.assignments) ? raw.assignments : {};
  const assignments: Record<string, BotHierarchyAssignment> = {};
  for (const [rawKey, candidate] of Object.entries(rawAssignments)) {
    const key = sanitizeOptionalString(rawKey, 512);
    if (!key || !isPlainRecord(candidate)) continue;
    const rawFolderId = sanitizeOptionalString(candidate.folderId, 256) ?? null;
    const folderId = rawFolderId && folders[rawFolderId] ? rawFolderId : null;
    const updatedAt = sanitizeTimestamp(candidate.updatedAt, 0);
    const updatedByDeviceId = sanitizeOptionalString(candidate.updatedByDeviceId, 128);
    assignments[key] = {
      folderId,
      order: sanitizeOrder(candidate.order, 0),
      updatedAt,
      ...(updatedByDeviceId ? { updatedByDeviceId } : {}),
    };
    if (updatedAt > maxObservedTs) maxObservedTs = updatedAt;
  }

  const rawRootOrder = Array.isArray(raw.rootOrder) ? raw.rootOrder : [];
  const seenRootKeys = new Set<string>();
  const rootOrder: string[] = [];
  for (const item of rawRootOrder) {
    const key = sanitizeOptionalString(item, 512);
    if (!key || seenRootKeys.has(key)) continue;
    if (assignments[key]?.folderId !== null && assignments[key]?.folderId !== undefined) {
      continue;
    }
    seenRootKeys.add(key);
    rootOrder.push(key);
  }

  const topDevice = sanitizeOptionalString(raw.updatedByDeviceId, 128);
  return {
    version: 1,
    updatedAt: maxObservedTs,
    ...(topDevice ? { updatedByDeviceId: topDevice } : {}),
    folders,
    assignments,
    rootOrder,
    deletedFolderIds,
  };
}

/**
 * Commutative multi-device Last-Write-Wins (LWW) merge with deletion tombstones.
 * Guarantees acyclic forest, depth <= BOT_HIERARCHY_MAX_DEPTH, and folders <= BOT_HIERARCHY_MAX_FOLDERS.
 */
export function mergeBotHierarchyConfigs(
  localRaw: BotHierarchyConfigV1,
  remoteRaw: BotHierarchyConfigV1,
): BotHierarchyConfigV1 {
  const local = normalizeBotHierarchyConfig(localRaw);
  const remote = normalizeBotHierarchyConfig(remoteRaw);

  const deletedFolderIds: Record<string, number> = { ...local.deletedFolderIds };
  for (const [folderId, ts] of Object.entries(remote.deletedFolderIds)) {
    const prev = deletedFolderIds[folderId] ?? 0;
    if (ts > prev) deletedFolderIds[folderId] = ts;
  }

  const allFolderIds = new Set([
    ...Object.keys(local.folders),
    ...Object.keys(remote.folders),
  ]);
  const folders: Record<string, BotHierarchyFolder> = {};
  for (const id of allFolderIds) {
    const a = local.folders[id];
    const b = remote.folders[id];
    let winner: BotHierarchyFolder;
    if (a && b) {
      winner = isLwwNewer(
        b.updatedAt,
        b.updatedByDeviceId,
        folderTieKey(b),
        a.updatedAt,
        a.updatedByDeviceId,
        folderTieKey(a),
      )
        ? { ...b }
        : { ...a };
    } else {
      winner = { ...(a ?? b) };
    }
    const deletedAt = deletedFolderIds[id];
    if (deletedAt !== undefined && deletedAt >= winner.updatedAt) {
      continue;
    }
    if (deletedAt !== undefined && winner.updatedAt > deletedAt) {
      delete deletedFolderIds[id];
    }
    folders[id] = winner;
  }

  const allAssignmentKeys = new Set([
    ...Object.keys(local.assignments),
    ...Object.keys(remote.assignments),
  ]);
  const assignments: Record<string, BotHierarchyAssignment> = {};
  for (const key of allAssignmentKeys) {
    const a = local.assignments[key];
    const b = remote.assignments[key];
    let winner: BotHierarchyAssignment;
    if (a && b) {
      winner = isLwwNewer(
        b.updatedAt,
        b.updatedByDeviceId,
        assignmentTieKey(key, b),
        a.updatedAt,
        a.updatedByDeviceId,
        assignmentTieKey(key, a),
      )
        ? { ...b }
        : { ...a };
    } else {
      winner = { ...(a ?? b) };
    }
    if (winner.folderId !== null && !folders[winner.folderId]) {
      winner.folderId = null;
    }
    assignments[key] = winner;
  }

  const remoteWinsTopLevel = isLwwNewer(
    remote.updatedAt,
    remote.updatedByDeviceId,
    compareStringArrays(remote.rootOrder, local.rootOrder) >= 0 ? '1' : '0',
    local.updatedAt,
    local.updatedByDeviceId,
    '0',
  );
  const primary = remoteWinsTopLevel ? remote : local;
  const secondary = remoteWinsTopLevel ? local : remote;

  const rootOrderSet = new Set<string>();
  const rootOrder: string[] = [];
  for (const key of [...primary.rootOrder, ...secondary.rootOrder]) {
    if (rootOrderSet.has(key)) continue;
    if (assignments[key]?.folderId !== null && assignments[key]?.folderId !== undefined) {
      continue;
    }
    rootOrderSet.add(key);
    rootOrder.push(key);
  }

  return normalizeBotHierarchyConfig({
    version: 1,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    ...(primary.updatedByDeviceId ? { updatedByDeviceId: primary.updatedByDeviceId } : {}),
    folders,
    assignments,
    rootOrder,
    deletedFolderIds,
  });
}

/** Resolve an assignment item key to an existing folderId, or null if ungrouped. */
export function resolveItemFolderId(
  config: BotHierarchyConfigV1,
  itemKey: string,
): string | null {
  const key = sanitizeOptionalString(itemKey, 512);
  if (!key) return null;
  const assignment = config.assignments?.[key];
  if (!assignment || !assignment.folderId) return null;
  return config.folders?.[assignment.folderId] ? assignment.folderId : null;
}

/**
 * Resolve a bot's folderId. When `deviceId` is provided, checks the device-scoped
 * remote key first (respecting explicit unassignments `folderId: null`), then falls
 * back to the device-agnostic canonical `bot:<botId>` key used by local/cloud companions.
 */
export function resolveBotFolderId(
  config: BotHierarchyConfigV1,
  botId: string,
  deviceId?: string | null,
): string | null {
  const did = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (did) {
    const remoteKey = botHierarchyItemKey(botId, did);
    if (remoteKey && Object.prototype.hasOwnProperty.call(config.assignments ?? {}, remoteKey)) {
      return resolveItemFolderId(config, remoteKey);
    }
  }
  const canonicalKey = botHierarchyItemKey(botId);
  return canonicalKey ? resolveItemFolderId(config, canonicalKey) : null;
}

/** Return the ancestor-to-self folder chain for `folderId` (empty if missing/null). */
export function getFolderBreadcrumb(
  config: BotHierarchyConfigV1,
  folderId: string | null | undefined,
): BotHierarchyFolder[] {
  const targetId = sanitizeOptionalString(folderId, 256);
  if (!targetId || !config.folders?.[targetId]) return [];
  const chain: BotHierarchyFolder[] = [];
  const visited = new Set<string>();
  let currId: string | null = targetId;
  while (currId !== null && !visited.has(currId)) {
    visited.add(currId);
    const folder: BotHierarchyFolder | undefined = config.folders[currId];
    if (!folder) break;
    chain.push(folder);
    currId = folder.parentId ?? null;
  }
  return chain.reverse();
}

/** Return the breadcrumb chain for an item key (bot or group), or empty if ungrouped. */
export function getItemFolderBreadcrumb(
  config: BotHierarchyConfigV1,
  itemKey: string,
): BotHierarchyFolder[] {
  const folderId = resolveItemFolderId(config, itemKey);
  return folderId ? getFolderBreadcrumb(config, folderId) : [];
}

/** True when `candidateFolderId` equals `targetAncestorId` or is nested underneath it. */
export function isFolderDescendantOrSelf(
  config: BotHierarchyConfigV1,
  candidateFolderId: string,
  targetAncestorId: string,
): boolean {
  const candidate = sanitizeOptionalString(candidateFolderId, 256);
  const ancestor = sanitizeOptionalString(targetAncestorId, 256);
  if (!candidate || !ancestor) return false;
  if (candidate === ancestor) return true;
  const visited = new Set<string>();
  let currId: string | null = candidate;
  while (currId !== null && !visited.has(currId)) {
    visited.add(currId);
    if (currId === ancestor) return true;
    currId = config.folders?.[currId]?.parentId ?? null;
  }
  return false;
}

function getChildrenMap(config: BotHierarchyConfigV1): Map<string | null, BotHierarchyFolder[]> {
  const childrenMap = new Map<string | null, BotHierarchyFolder[]>();
  for (const folder of Object.values(config.folders)) {
    const parentKey = folder.parentId && config.folders[folder.parentId] ? folder.parentId : null;
    const list = childrenMap.get(parentKey);
    if (list) list.push(folder);
    else childrenMap.set(parentKey, [folder]);
  }
  for (const list of childrenMap.values()) {
    list.sort(compareFolders);
  }
  return childrenMap;
}

/** Flatten all folders in deterministic depth-first pre-order for pickers/menus/filters. */
export function flattenFolderOptions(
  config: BotHierarchyConfigV1,
): BotHierarchyFolderOption[] {
  const normalized = normalizeBotHierarchyConfig(config);
  const childrenMap = getChildrenMap(normalized);
  const result: BotHierarchyFolderOption[] = [];

  const visit = (parentId: string | null, depth: number, ancestorNames: string[]): void => {
    const siblings = childrenMap.get(parentId) ?? [];
    for (const folder of siblings) {
      const path = [...ancestorNames, folder.name];
      result.push({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        depth,
        order: folder.order,
        path,
        pathLabel: path.join(' / '),
        folder,
      });
      visit(folder.id, depth + 1, path);
    }
  };

  visit(null, 1, []);
  return result;
}

/** Build a hierarchical folder tree sorted deterministically at every level. */
export function buildBotFolderTree(
  config: BotHierarchyConfigV1,
): BotHierarchyFolderTreeNode[] {
  const normalized = normalizeBotHierarchyConfig(config);
  const childrenMap = getChildrenMap(normalized);

  const buildNodes = (
    parentId: string | null,
    depth: number,
    ancestorNames: string[],
  ): BotHierarchyFolderTreeNode[] => {
    const siblings = childrenMap.get(parentId) ?? [];
    return siblings.map((folder) => {
      const path = [...ancestorNames, folder.name];
      return {
        folder,
        depth,
        path,
        children: buildNodes(folder.id, depth + 1, path),
      };
    });
  };

  return buildNodes(null, 1, []);
}

function getFolderDepth(config: BotHierarchyConfigV1, folderId: string): number {
  return getFolderBreadcrumb(config, folderId).length;
}

function getSubtreeMaxRelativeDepth(
  childrenMap: Map<string | null, BotHierarchyFolder[]>,
  rootId: string,
): number {
  const children = childrenMap.get(rootId) ?? [];
  if (children.length === 0) return 1;
  let maxChild = 0;
  for (const child of children) {
    const d = getSubtreeMaxRelativeDepth(childrenMap, child.id);
    if (d > maxChild) maxChild = d;
  }
  return 1 + maxChild;
}

function nextSiblingOrder(config: BotHierarchyConfigV1, parentId: string | null): number {
  let maxOrder = -1;
  for (const folder of Object.values(config.folders)) {
    if ((folder.parentId ?? null) === parentId && folder.order > maxOrder) {
      maxOrder = folder.order;
    }
  }
  return maxOrder + 1;
}

function nextFolderItemOrder(config: BotHierarchyConfigV1, folderId: string | null): number {
  let maxOrder = -1;
  for (const assignment of Object.values(config.assignments)) {
    if ((assignment.folderId ?? null) === folderId && assignment.order > maxOrder) {
      maxOrder = assignment.order;
    }
  }
  return maxOrder + 1;
}

/** Create a new folder while enforcing max depth and max folder limits. */
export function createBotFolder(
  config: BotHierarchyConfigV1,
  input: CreateBotFolderInput,
): CreateBotFolderResult {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const name = sanitizeFolderName(input.name);
  if (!name) {
    throw new Error('Folder name must not be empty');
  }
  if (Object.keys(base.folders).length >= BOT_HIERARCHY_MAX_FOLDERS) {
    throw new Error(`Folder limit (${BOT_HIERARCHY_MAX_FOLDERS}) exceeded`);
  }

  const parentId = sanitizeOptionalString(input.parentId, 256) ?? null;
  if (parentId !== null) {
    if (!base.folders[parentId]) {
      throw new Error(`Parent folder "${parentId}" not found`);
    }
    const parentDepth = getFolderDepth(base, parentId);
    if (parentDepth >= BOT_HIERARCHY_MAX_DEPTH) {
      throw new Error(`Folder depth cannot exceed ${BOT_HIERARCHY_MAX_DEPTH}`);
    }
  }

  const id = sanitizeOptionalString(input.id, 256) ?? createFolderId();
  if (base.folders[id]) {
    throw new Error(`Folder "${id}" already exists`);
  }

  const ts = resolveMutationTimestamp(base.updatedAt, input.now);
  const deviceId = sanitizeOptionalString(input.deviceId, 128);
  const order =
    typeof input.order === 'number' && Number.isFinite(input.order)
      ? input.order
      : nextSiblingOrder(base, parentId);

  const folder: BotHierarchyFolder = {
    id,
    name,
    parentId,
    order,
    createdAt: ts,
    updatedAt: ts,
    ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
  };

  base.folders[id] = folder;
  delete base.deletedFolderIds[id];
  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;

  return { config: base, folder };
}

/** Rename an existing folder. */
export function renameBotFolder(
  config: BotHierarchyConfigV1,
  folderId: string,
  newName: string,
  options?: MutationOptions,
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const id = sanitizeOptionalString(folderId, 256);
  if (!id || !base.folders[id]) {
    throw new Error(`Folder "${folderId}" not found`);
  }
  const cleanName = sanitizeFolderName(newName);
  if (!cleanName) {
    throw new Error('Folder name must not be empty');
  }
  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  const existing = base.folders[id];
  base.folders[id] = {
    ...existing,
    name: cleanName,
    updatedAt: ts,
    ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
  };
  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

/** Move a folder under a new parent (or null for root), preventing cycles and depth overflow. */
export function moveBotFolder(
  config: BotHierarchyConfigV1,
  folderId: string,
  newParentId: string | null,
  options?: MutationOptions & { order?: number },
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const id = sanitizeOptionalString(folderId, 256);
  if (!id || !base.folders[id]) {
    throw new Error(`Folder "${folderId}" not found`);
  }
  const targetParentId = sanitizeOptionalString(newParentId, 256) ?? null;
  if (targetParentId !== null) {
    if (!base.folders[targetParentId]) {
      throw new Error(`Target parent folder "${targetParentId}" not found`);
    }
    if (isFolderDescendantOrSelf(base, targetParentId, id)) {
      throw new Error('Cannot move folder into itself or one of its descendants');
    }
  }

  const childrenMap = getChildrenMap(base);
  const subtreeHeight = getSubtreeMaxRelativeDepth(childrenMap, id);
  const targetParentDepth = targetParentId ? getFolderDepth(base, targetParentId) : 0;
  if (targetParentDepth + subtreeHeight > BOT_HIERARCHY_MAX_DEPTH) {
    throw new Error(
      `Moving folder would exceed maximum depth of ${BOT_HIERARCHY_MAX_DEPTH}`,
    );
  }

  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  const existing = base.folders[id];
  const sameParent = existing.parentId === targetParentId;
  const order =
    typeof options?.order === 'number' && Number.isFinite(options.order)
      ? options.order
      : sameParent
        ? existing.order
        : nextSiblingOrder(base, targetParentId);

  base.folders[id] = {
    ...existing,
    parentId: targetParentId,
    order,
    updatedAt: ts,
    ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
  };
  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

/**
 * Delete a folder without ever losing bots:
 * - `promote-children` (default): moves child folders and member assignments to `deletedFolder.parentId`.
 * - `cascade`: deletes all descendant folders too and moves all affected member assignments to `deletedFolder.parentId`.
 */
export function deleteBotFolder(
  config: BotHierarchyConfigV1,
  folderId: string,
  options?: DeleteBotFolderOptions,
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const id = sanitizeOptionalString(folderId, 256);
  const target = id ? base.folders[id] : undefined;
  if (!id || !target) {
    return base;
  }

  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  const mode = options?.mode ?? 'promote-children';
  const fallbackParentId = target.parentId ?? null;

  const foldersToDelete = new Set<string>([id]);
  if (mode === 'cascade') {
    const queue = [id];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const folder of Object.values(base.folders)) {
        if (folder.parentId === curr && !foldersToDelete.has(folder.id)) {
          foldersToDelete.add(folder.id);
          queue.push(folder.id);
        }
      }
    }
  } else {
    // Reparent direct children to the deleted folder's parent.
    let orderCursor = nextSiblingOrder(base, fallbackParentId);
    const children = Object.values(base.folders)
      .filter((f) => f.parentId === id)
      .sort(compareFolders);
    for (const child of children) {
      base.folders[child.id] = {
        ...child,
        parentId: fallbackParentId,
        order: orderCursor++,
        updatedAt: ts,
        ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
      };
    }
  }

  for (const deadId of foldersToDelete) {
    delete base.folders[deadId];
    base.deletedFolderIds[deadId] = Math.max(base.deletedFolderIds[deadId] ?? 0, ts);
  }

  let itemOrderCursor = nextFolderItemOrder(base, fallbackParentId);
  const reassignedKeys = Object.entries(base.assignments)
    .filter(([, a]) => a.folderId !== null && foldersToDelete.has(a.folderId))
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([key]) => key);

  for (const itemKey of reassignedKeys) {
    base.assignments[itemKey] = {
      folderId: fallbackParentId,
      order: itemOrderCursor++,
      updatedAt: ts,
      ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
    };
    if (fallbackParentId === null && !base.rootOrder.includes(itemKey)) {
      base.rootOrder.push(itemKey);
    }
  }

  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

/** Assign (or unassign when `folderId === null`) items to a folder while keeping relative order clean. */
export function assignItemsToFolder(
  config: BotHierarchyConfigV1,
  itemKeys: string[],
  folderId: string | null,
  options?: AssignItemsOptions,
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const targetFolderId = sanitizeOptionalString(folderId, 256) ?? null;
  if (targetFolderId !== null && !base.folders[targetFolderId]) {
    throw new Error(`Target folder "${targetFolderId}" not found`);
  }

  const dedupedKeys: string[] = [];
  const seen = new Set<string>();
  for (const rawKey of itemKeys) {
    const key = sanitizeOptionalString(rawKey, 512);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedupedKeys.push(key);
  }
  if (dedupedKeys.length === 0) return base;

  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  const position = options?.position ?? 'end';

  if (position === 'start') {
    const existingInTarget = Object.entries(base.assignments)
      .filter(([key, a]) => a.folderId === targetFolderId && !seen.has(key))
      .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));

    dedupedKeys.forEach((key, idx) => {
      base.assignments[key] = {
        folderId: targetFolderId,
        order: idx,
        updatedAt: ts,
        ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
      };
    });
    let offset = dedupedKeys.length;
    for (const [key, assignment] of existingInTarget) {
      base.assignments[key] = {
        ...assignment,
        order: offset++,
        updatedAt: ts,
        ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
      };
    }
  } else {
    let cursor = nextFolderItemOrder(base, targetFolderId);
    for (const key of dedupedKeys) {
      base.assignments[key] = {
        folderId: targetFolderId,
        order: cursor++,
        updatedAt: ts,
        ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
      };
    }
  }

  if (targetFolderId === null) {
    const remaining = base.rootOrder.filter((key) => !seen.has(key));
    base.rootOrder = position === 'start' ? [...dedupedKeys, ...remaining] : [...remaining, ...dedupedKeys];
  } else {
    base.rootOrder = base.rootOrder.filter((key) => !seen.has(key));
  }

  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

/** Reorder sibling folders under `parentId` (use `null` for top-level folders). */
export function reorderSiblings(
  config: BotHierarchyConfigV1,
  parentId: string | null,
  orderedSiblingIds: string[],
  options?: MutationOptions,
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const cleanParentId = sanitizeOptionalString(parentId, 256) ?? null;
  if (cleanParentId !== null && !base.folders[cleanParentId]) {
    throw new Error(`Parent folder "${cleanParentId}" not found`);
  }

  const siblings = Object.values(base.folders)
    .filter((f) => (f.parentId ?? null) === cleanParentId)
    .sort(compareFolders);
  if (siblings.length === 0) return base;

  const siblingSet = new Set(siblings.map((f) => f.id));
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const rawId of orderedSiblingIds) {
    const id = sanitizeOptionalString(rawId, 256);
    if (!id || !siblingSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  for (const sibling of siblings) {
    if (!seen.has(sibling.id)) ordered.push(sibling.id);
  }

  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  ordered.forEach((id, idx) => {
    const existing = base.folders[id];
    base.folders[id] = {
      ...existing,
      order: idx,
      updatedAt: ts,
      ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
    };
  });

  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

/** Reorder items inside `folderId` (or ungrouped root items when `folderId === null`). */
export function reorderFolderItems(
  config: BotHierarchyConfigV1,
  folderId: string | null,
  orderedItemKeys: string[],
  options?: MutationOptions,
): BotHierarchyConfigV1 {
  const base = cloneConfig(normalizeBotHierarchyConfig(config));
  const targetFolderId = sanitizeOptionalString(folderId, 256) ?? null;
  if (targetFolderId !== null && !base.folders[targetFolderId]) {
    throw new Error(`Folder "${targetFolderId}" not found`);
  }

  const ts = resolveMutationTimestamp(base.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);
  const seen = new Set<string>();
  const cleanRequested: string[] = [];
  for (const rawKey of orderedItemKeys) {
    const key = sanitizeOptionalString(rawKey, 512);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleanRequested.push(key);
  }

  if (targetFolderId === null) {
    const nextRootOrder: string[] = [];
    const rootSeen = new Set<string>();
    for (const key of [...cleanRequested, ...base.rootOrder]) {
      if (rootSeen.has(key)) continue;
      const existingFolderId = base.assignments[key]?.folderId;
      if (existingFolderId !== null && existingFolderId !== undefined) continue;
      rootSeen.add(key);
      nextRootOrder.push(key);
    }
    base.rootOrder = nextRootOrder;
    nextRootOrder.forEach((key, idx) => {
      if (base.assignments[key]?.folderId === null) {
        base.assignments[key] = {
          ...base.assignments[key],
          order: idx,
          updatedAt: ts,
          ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
        };
      }
    });
  } else {
    const inFolder = Object.entries(base.assignments)
      .filter(([, a]) => a.folderId === targetFolderId)
      .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
      .map(([key]) => key);
    const inFolderSet = new Set(inFolder);
    const finalOrder: string[] = [];
    const placed = new Set<string>();
    for (const key of cleanRequested) {
      if (!inFolderSet.has(key) || placed.has(key)) continue;
      placed.add(key);
      finalOrder.push(key);
    }
    for (const key of inFolder) {
      if (!placed.has(key)) finalOrder.push(key);
    }
    finalOrder.forEach((key, idx) => {
      base.assignments[key] = {
        folderId: targetFolderId,
        order: idx,
        updatedAt: ts,
        ...(deviceId ? { updatedByDeviceId: deviceId } : {}),
      };
    });
  }

  base.updatedAt = Math.max(base.updatedAt, ts);
  if (deviceId) base.updatedByDeviceId = deviceId;
  return base;
}

function parseFolderPathSegments(folderPath: string[] | string): string[] {
  const rawSegments = Array.isArray(folderPath)
    ? folderPath
    : typeof folderPath === 'string'
      ? folderPath.split(/[\\/]+/)
      : [];
  const cleaned = rawSegments
    .map((seg) => sanitizeFolderName(seg))
    .filter((seg) => seg.length > 0);
  return cleaned.slice(0, BOT_HIERARCHY_MAX_DEPTH);
}

function findChildFolderByName(
  config: BotHierarchyConfigV1,
  parentId: string | null,
  name: string,
): BotHierarchyFolder | undefined {
  const lowered = name.toLowerCase();
  return Object.values(config.folders)
    .filter((f) => (f.parentId ?? null) === parentId)
    .sort(compareFolders)
    .find((f) => f.name.toLowerCase() === lowered);
}

function ensureFolderPath(
  config: BotHierarchyConfigV1,
  segments: string[],
  now: number,
  deviceId: string | undefined,
  createdFolderIds: string[],
): { config: BotHierarchyConfigV1; folderId: string | null; skippedForLimit: boolean } {
  const limitedSegments = segments.slice(0, BOT_HIERARCHY_MAX_DEPTH);
  if (limitedSegments.length === 0) {
    return { config, folderId: null, skippedForLimit: false };
  }

  let currentConfig = config;
  let parentId: string | null = null;

  for (const segment of limitedSegments) {
    const existing = findChildFolderByName(currentConfig, parentId, segment);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    if (Object.keys(currentConfig.folders).length >= BOT_HIERARCHY_MAX_FOLDERS) {
      return { config: currentConfig, folderId: parentId, skippedForLimit: true };
    }
    const created = createBotFolder(currentConfig, {
      name: segment,
      parentId,
      now,
      deviceId,
    });
    currentConfig = created.config;
    createdFolderIds.push(created.folder.id);
    parentId = created.folder.id;
  }

  return { config: currentConfig, folderId: parentId, skippedForLimit: false };
}

/** Extract canonical WanJie/Cindy style role code (e.g. SECRETARY, M01, D01, P03_IMPL, HB01, A01, AU01, Q03_BLIND, BD01..H01). */
function extractRoleCode(entry: BotRosterOrganizeEntry): string | null {
  const sources = [entry.role, entry.name, entry.title]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  for (const text of sources) {
    // 1. Explicit code in parentheses or brackets: `万界｜总协调（SECRETARY）`, `万界｜主策划（D01）`, `[P03_IMPL]`
    const bracketMatches = text.matchAll(/[（([\【]([A-Za-z0-9_-]{1,32})[）)\】]/g);
    for (const m of bracketMatches) {
      const token = m[1].trim().toUpperCase();
      if (isKnownRoleCodeToken(token, true)) return token;
    }
    // 2. Standalone word token with explicit digits or SECRETARY: e.g. `D01 主策划` or `SECRETARY`
    const wordMatches = text.matchAll(/\b([A-Za-z]{1,12}\d+(?:_[A-Za-z0-9_]+)?|SECRETARY)\b/gi);
    for (const m of wordMatches) {
      const token = m[1].trim().toUpperCase();
      if (isKnownRoleCodeToken(token, false)) return token;
    }
  }
  return null;
}

const KNOWN_ROLE_PREFIXES_ORDERED: Array<{
  regex: RegExp;
  bareRegex: RegExp;
  path: string[];
}> = [
  { regex: /^SECRETARY$/i, bareRegex: /^SECRETARY$/i, path: ['行政秘书'] },
  { regex: /^HB\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^HB$/i, path: ['美术视觉'] },
  { regex: /^AU\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^AU$/i, path: ['动画音频'] },
  { regex: /^BD\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^BD$/i, path: ['商业运营', '商务合作'] },
  { regex: /^PM\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^PM$/i, path: ['商业运营', '项目管理'] },
  { regex: /^MR\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^MR$/i, path: ['商业运营', '市场调研'] },
  { regex: /^DA\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^DA$/i, path: ['商业运营', '数据分析'] },
  { regex: /^OP\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^OP$/i, path: ['商业运营', '运营推广'] },
  { regex: /^FN\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^FN$/i, path: ['职能支持', '财务管理'] },
  { regex: /^LG\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^LG$/i, path: ['职能支持', '法务合规'] },
  { regex: /^M\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^M$/i, path: ['管理总控'] },
  { regex: /^D\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^D$/i, path: ['技术研发'] },
  { regex: /^P\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^P$/i, path: ['产品策划'] },
  { regex: /^A\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^A$/i, path: ['动画音频'] },
  { regex: /^Q\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^Q$/i, path: ['测试质检'] },
  { regex: /^H\d+(?:_[A-Z0-9_]+)?$/i, bareRegex: /^(?:H|HR)$/i, path: ['职能支持', '人力资源'] },
];

function isKnownRoleCodeToken(token: string, allowBareCode: boolean): boolean {
  return KNOWN_ROLE_PREFIXES_ORDERED.some((rule) =>
    allowBareCode
      ? rule.regex.test(token) || rule.bareRegex.test(token)
      : rule.regex.test(token),
  );
}

function getRoleCodeCategoryPath(roleCode: string): string[] | null {
  const upper = roleCode.trim().toUpperCase();
  for (const rule of KNOWN_ROLE_PREFIXES_ORDERED) {
    if (rule.regex.test(upper) || rule.bareRegex.test(upper)) {
      return rule.path;
    }
  }
  return null;
}

function matchesBatchAssignRule(
  entry: BotRosterOrganizeEntry,
  itemKey: string,
  rule: Extract<BotBatchOrganizeRule, { type?: 'assign' }>,
): boolean {
  let hasCondition = false;

  if (Array.isArray(rule.itemKeys) && rule.itemKeys.length > 0) {
    hasCondition = true;
    if (rule.itemKeys.some((k) => k.trim() === itemKey)) return true;
  }

  if (Array.isArray(rule.botIds) && rule.botIds.length > 0) {
    hasCondition = true;
    const targetId = entry.botId?.trim();
    if (targetId && rule.botIds.some((id) => id.trim() === targetId)) return true;
  }

  const haystacks = [entry.name, entry.title, entry.role, entry.description]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const combined = haystacks.join('\n');
  const combinedLower = combined.toLowerCase();

  if (typeof rule.namePrefix === 'string' && rule.namePrefix.trim().length > 0) {
    hasCondition = true;
    const prefixLower = rule.namePrefix.trim().toLowerCase();
    if (
      entry.name.trim().toLowerCase().startsWith(prefixLower) ||
      (typeof entry.title === 'string' && entry.title.trim().toLowerCase().startsWith(prefixLower))
    ) {
      return true;
    }
  }

  if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
    hasCondition = true;
    if (rule.keywords.some((kw) => kw.trim().length > 0 && combinedLower.includes(kw.trim().toLowerCase()))) {
      return true;
    }
  }

  if (Array.isArray(rule.roleCodes) && rule.roleCodes.length > 0) {
    hasCondition = true;
    const detected = extractRoleCode(entry);
    if (detected) {
      const upperDetected = detected.toUpperCase();
      if (
        rule.roleCodes.some((rc) => {
          const clean = rc.trim().toUpperCase().replace(/\*+$/, '');
          return clean.length > 0 && upperDetected.startsWith(clean);
        })
      ) {
        return true;
      }
    }
  }

  if (typeof rule.pattern === 'string' && rule.pattern.length > 0) {
    hasCondition = true;
    try {
      const re = new RegExp(rule.pattern, rule.flags ?? 'i');
      if (re.test(combined)) return true;
    } catch {
      // Invalid regex safely ignored as non-matching.
    }
  }

  return !hasCondition;
}

/**
 * Apply rule-driven folder operations and batch bot/group assignments cleanly,
 * creating missing nested folders up to `BOT_HIERARCHY_MAX_DEPTH` and respecting `BOT_HIERARCHY_MAX_FOLDERS`.
 */
export function applyBotBatchOrganize(
  config: BotHierarchyConfigV1,
  entries: BotRosterOrganizeEntry[],
  rules: BotBatchOrganizeRule[],
  options?: ApplyBatchOrganizeOptions,
): BotOrganizeResult {
  let current = cloneConfig(normalizeBotHierarchyConfig(config));
  const ts = resolveMutationTimestamp(current.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);

  const createdFolderIds: string[] = [];
  const updatedFolderIds = new Set<string>();
  const deletedFolderIds = new Set<string>();
  const matchedKeysSet = new Set<string>();
  let skippedForLimits = 0;

  const entryPairs = entries
    .map((entry) => ({ entry, itemKey: resolveEntryItemKey(entry) }))
    .filter((pair) => pair.itemKey.length > 0);

  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const stepTs = ts + i;

    if (rule.type === 'create-folder') {
      const segments = parseFolderPathSegments(rule.folderPath);
      const ensured = ensureFolderPath(current, segments, stepTs, deviceId, createdFolderIds);
      current = ensured.config;
      if (ensured.skippedForLimit) skippedForLimits += 1;
      continue;
    }

    if (rule.type === 'rename-folder') {
      if (current.folders[rule.folderId]) {
        current = renameBotFolder(current, rule.folderId, rule.name, { now: stepTs, deviceId });
        updatedFolderIds.add(rule.folderId);
      }
      continue;
    }

    if (rule.type === 'move-folder') {
      if (current.folders[rule.folderId]) {
        current = moveBotFolder(current, rule.folderId, rule.newParentId, {
          now: stepTs,
          deviceId,
        });
        updatedFolderIds.add(rule.folderId);
      }
      continue;
    }

    if (rule.type === 'delete-folder') {
      if (current.folders[rule.folderId]) {
        const beforeIds = new Set(Object.keys(current.folders));
        current = deleteBotFolder(current, rule.folderId, {
          mode: rule.mode,
          now: stepTs,
          deviceId,
        });
        for (const id of beforeIds) {
          if (!current.folders[id]) deletedFolderIds.add(id);
        }
      }
      continue;
    }

    if (rule.type === 'unassign') {
      const targetKeys = new Set<string>();
      for (const k of rule.itemKeys ?? []) {
        const clean = sanitizeOptionalString(k, 512);
        if (clean) targetKeys.add(clean);
      }
      if (rule.botIds && rule.botIds.length > 0) {
        const idSet = new Set(rule.botIds.map((id) => id.trim()).filter(Boolean));
        for (const pair of entryPairs) {
          if (pair.entry.botId && idSet.has(pair.entry.botId.trim())) {
            targetKeys.add(pair.itemKey);
          }
        }
        for (const botId of idSet) {
          targetKeys.add(botHierarchyItemKey(botId));
        }
      }
      if (targetKeys.size > 0) {
        const keysList = [...targetKeys];
        current = assignItemsToFolder(current, keysList, null, { now: stepTs, deviceId });
        for (const k of keysList) matchedKeysSet.add(k);
      }
      continue;
    }

    // Default: 'assign' rule.
    const segments = parseFolderPathSegments(rule.folderPath);
    if (segments.length === 0) continue;

    const candidateKeys: string[] = [];
    for (const pair of entryPairs) {
      if (
        options?.overwriteExistingAssignments === false &&
        resolveItemFolderId(current, pair.itemKey) !== null
      ) {
        continue;
      }
      if (matchesBatchAssignRule(pair.entry, pair.itemKey, rule)) {
        candidateKeys.push(pair.itemKey);
      }
    }

    // Also allow explicit itemKeys / botIds even if not present in `entries`.
    for (const explicitKey of rule.itemKeys ?? []) {
      const clean = sanitizeOptionalString(explicitKey, 512);
      if (clean && !candidateKeys.includes(clean)) {
        if (
          options?.overwriteExistingAssignments === false &&
          resolveItemFolderId(current, clean) !== null
        ) {
          continue;
        }
        candidateKeys.push(clean);
      }
    }
    if (entryPairs.length === 0) {
      for (const explicitBotId of rule.botIds ?? []) {
        const key = botHierarchyItemKey(explicitBotId);
        if (key && !candidateKeys.includes(key)) {
          if (
            options?.overwriteExistingAssignments === false &&
            resolveItemFolderId(current, key) !== null
          ) {
            continue;
          }
          candidateKeys.push(key);
        }
      }
    }

    if (candidateKeys.length === 0) continue;

    const ensured = ensureFolderPath(current, segments, stepTs, deviceId, createdFolderIds);
    current = ensured.config;
    if (ensured.skippedForLimit) skippedForLimits += 1;
    if (!ensured.folderId) continue;

    current = assignItemsToFolder(current, candidateKeys, ensured.folderId, {
      now: stepTs,
      deviceId,
    });
    for (const k of candidateKeys) matchedKeysSet.add(k);
  }

  return {
    config: normalizeBotHierarchyConfig(current),
    summary: {
      createdFolderIds,
      updatedFolderIds: [...updatedFolderIds],
      deletedFolderIds: [...deletedFolderIds],
      assignedItemCount: matchedKeysSet.size,
      matchedItemKeys: [...matchedKeysSet],
      skippedForLimits,
    },
  };
}

function extractNamespacePrefix(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Support `万界｜...`, `万界 | ...`, `团队 / ...`, `Proj: ...`, `Team - Member`.
  const match = trimmed.match(/^([^\s｜|/:\\-][^｜|/:\\]{0,31}?)\s*(?:[｜|/：:]|\s+-\s+)\s*\S/);
  if (!match) return null;
  const prefix = sanitizeFolderName(match[1]);
  return prefix.length >= 1 ? prefix : null;
}

const KEYWORD_CATEGORY_RULES: Array<{ keywords: string[]; path: string[] }> = [
  {
    keywords: ['secretary', '秘书', '行政', '助理', '总助', 'executive assistant'],
    path: ['行政秘书'],
  },
  {
    keywords: ['制作人', '总控', '总监', 'coordinator', 'producer', 'director', 'ceo'],
    path: ['管理总控'],
  },
  {
    keywords: [
      '研发',
      '开发',
      '主程',
      '后端',
      '前端',
      '全栈',
      '架构',
      '工程',
      'devops',
      'sre',
      'engineer',
      'developer',
      'backend',
      'frontend',
      'fullstack',
      'tech',
      'coder',
    ],
    path: ['技术研发'],
  },
  {
    keywords: ['策划', '产品', '玩法', '需求', '文案', 'product', 'planner', 'prd', 'story', 'design doc'],
    path: ['产品策划'],
  },
  {
    keywords: ['美术', '视觉', '主美', '原画', '插画', 'ui', 'ux', 'design', 'artist', 'visual'],
    path: ['美术视觉'],
  },
  {
    keywords: ['动画', '音频', '音效', '配音', '动作', 'animation', 'audio', 'sound', 'music', 'sfx'],
    path: ['动画音频'],
  },
  {
    keywords: ['测试', '质检', 'qa', '盲测', '验收', 'test', 'quality', 'qc'],
    path: ['测试质检'],
  },
  {
    keywords: ['商务', '发行', 'bd', 'business', 'partner'],
    path: ['商业运营', '商务合作'],
  },
  {
    keywords: ['项目经理', 'pm', 'project manager', 'scrum'],
    path: ['商业运营', '项目管理'],
  },
  {
    keywords: ['市场', '调研', '营销', 'marketing', 'research', 'brand'],
    path: ['商业运营', '市场调研'],
  },
  {
    keywords: ['数据', '分析', 'bi', 'analytics', 'analyst', 'data'],
    path: ['商业运营', '数据分析'],
  },
  {
    keywords: ['运营', '增长', '社区', '推广', 'operation', 'growth', 'community'],
    path: ['商业运营', '运营推广'],
  },
  {
    keywords: ['财务', '会计', '税务', 'finance', 'accounting'],
    path: ['职能支持', '财务管理'],
  },
  {
    keywords: ['法务', '合规', '法律', 'legal', 'compliance'],
    path: ['职能支持', '法务合规'],
  },
  {
    keywords: ['人力', '人事', '招聘', 'hr', 'recruit', 'talent'],
    path: ['职能支持', '人力资源'],
  },
];

function classifyByKeywords(entry: BotRosterOrganizeEntry): string[] | null {
  const combined = [entry.name, entry.title, entry.role, entry.description]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ')
    .toLowerCase();
  if (!combined) return null;

  for (const rule of KEYWORD_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return rule.path;
    }
  }
  return null;
}

/**
 * Automatically build a clean multi-level hierarchy for both WanJie/Cindy role-coded rosters
 * (SECRETARY, M*, D*, P*, HB*, A* / AU*, Q*, BD*, PM*, MR*, DA*, OP*, FN*, LG*, H*)
 * and ordinary bots organized by namespace prefix or domain keywords.
 *
 * Strictly enforces `BOT_HIERARCHY_MAX_DEPTH` and `BOT_HIERARCHY_MAX_FOLDERS` without cycles.
 */
export function buildSmartBotHierarchy(
  config: BotHierarchyConfigV1,
  entries: BotRosterOrganizeEntry[],
  options?: BuildSmartBotHierarchyOptions,
): BotOrganizeResult {
  const normalizedInput = normalizeBotHierarchyConfig(config);
  const ts = resolveMutationTimestamp(normalizedInput.updatedAt, options?.now);
  const deviceId = sanitizeOptionalString(options?.deviceId, 128);

  let working: BotHierarchyConfigV1;
  const deletedFolderIds: string[] = [];

  if (options?.replaceExisting) {
    const nextDeleted = { ...normalizedInput.deletedFolderIds };
    for (const id of Object.keys(normalizedInput.folders)) {
      nextDeleted[id] = Math.max(nextDeleted[id] ?? 0, ts);
      deletedFolderIds.push(id);
    }
    working = createEmptyBotHierarchyConfig(ts, deviceId);
    working.deletedFolderIds = nextDeleted;
  } else {
    working = cloneConfig(normalizedInput);
  }

  const resolvedEntries = entries
    .map((entry) => ({ entry, itemKey: resolveEntryItemKey(entry) }))
    .filter((item) => item.itemKey.length > 0);

  if (resolvedEntries.length === 0) {
    return {
      config: normalizeBotHierarchyConfig(working),
      summary: {
        createdFolderIds: [],
        updatedFolderIds: [],
        deletedFolderIds,
        assignedItemCount: 0,
        matchedItemKeys: [],
        skippedForLimits: 0,
      },
    };
  }

  // Count how many bots share each namespace prefix.
  const prefixCounts = new Map<string, number>();
  const prefixPerEntry = new Map<string, string | null>();
  for (const { entry, itemKey } of resolvedEntries) {
    const prefix = extractNamespacePrefix(entry.name);
    prefixPerEntry.set(itemKey, prefix);
    if (prefix) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  const createdFolderIds: string[] = [];
  const matchedItemKeys: string[] = [];
  let skippedForLimits = 0;

  // Group item keys by resolved target path (preserving order of first appearance).
  const groupedPaths = new Map<string, { segments: string[]; keys: string[] }>();

  const hasAnyRoleCodedEntries = resolvedEntries.some(({ entry }) => extractRoleCode(entry) !== null);

  for (const { entry, itemKey } of resolvedEntries) {
    if (
      !options?.replaceExisting &&
      !options?.overwriteExistingAssignments &&
      resolveItemFolderId(working, itemKey) !== null
    ) {
      continue;
    }

    const prefix = prefixPerEntry.get(itemKey) ?? null;
    const roleCode = extractRoleCode(entry);
    const roleCategoryPath = roleCode ? getRoleCodeCategoryPath(roleCode) : null;
    const keywordPath = roleCategoryPath ? null : classifyByKeywords(entry);

    let targetPath: string[] | null = null;
    const hasExplicitNsSeparator = /[｜|]/.test(entry.name);
    const useNamespace =
      prefix !== null &&
      ((prefixCounts.get(prefix) ?? 0) >= 2 || (hasExplicitNsSeparator && roleCategoryPath !== null));

    if (useNamespace && prefix) {
      if (roleCategoryPath) {
        targetPath = [prefix, ...roleCategoryPath];
      } else if (keywordPath) {
        targetPath = [prefix, ...keywordPath];
      } else {
        targetPath = [prefix];
      }
    } else if (roleCategoryPath) {
      targetPath = roleCategoryPath;
    } else if (/^cindy(?:\b|[\s｜|_-]|$)/i.test(entry.name.trim()) && (resolvedEntries.length >= 2 || hasAnyRoleCodedEntries)) {
      targetPath = ['核心助手'];
    } else if (keywordPath) {
      targetPath = keywordPath;
    }

    if (!targetPath || targetPath.length === 0) continue;
    const boundedPath = targetPath
      .map((seg) => sanitizeFolderName(seg))
      .filter(Boolean)
      .slice(0, BOT_HIERARCHY_MAX_DEPTH);
    if (boundedPath.length === 0) continue;

    const mapKey = boundedPath.join('\u0000');
    const bucket = groupedPaths.get(mapKey);
    if (bucket) {
      bucket.keys.push(itemKey);
    } else {
      groupedPaths.set(mapKey, { segments: boundedPath, keys: [itemKey] });
    }
  }

  let stepOffset = 0;
  for (const { segments, keys } of groupedPaths.values()) {
    const stepTs = ts + stepOffset++;
    let ensured = ensureFolderPath(working, segments, stepTs, deviceId, createdFolderIds);
    working = ensured.config;
    if (ensured.skippedForLimit) {
      skippedForLimits += 1;
      // Graceful degradation when 200-folder cap is reached: fall back to parent prefix folder if available.
      if (!ensured.folderId && segments.length > 1) {
        const parentExisting = findChildFolderByName(working, null, segments[0]);
        if (parentExisting) {
          ensured = { config: working, folderId: parentExisting.id, skippedForLimit: true };
        }
      }
    }
    if (!ensured.folderId) continue;

    working = assignItemsToFolder(working, keys, ensured.folderId, {
      now: stepTs,
      deviceId,
    });
    for (const key of keys) {
      matchedItemKeys.push(key);
    }
  }

  return {
    config: normalizeBotHierarchyConfig(working),
    summary: {
      createdFolderIds,
      updatedFolderIds: [],
      deletedFolderIds,
      assignedItemCount: matchedItemKeys.length,
      matchedItemKeys,
      skippedForLimits,
    },
  };
}
