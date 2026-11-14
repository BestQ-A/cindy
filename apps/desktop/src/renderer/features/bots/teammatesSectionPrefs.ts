import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

/**
 * 侧栏「伙伴」段的收起状态,按账号存在本机。默认展开:只有用户点过收起才写入
 * override(`collapsed`);再次展开时写回 `expanded`,不复制默认值以外的状态。
 */
const KEY = 'sidebar.teammatesSection.v1';
const COLLAPSED_FOLDERS_KEY = 'sidebar.teammatesCollapsedFolders.v1';
const COLLAPSED_COMPUTERS_KEY = 'sidebar.teammatesCollapsedComputers.v1';
const GROUP_BY_COMPUTER_KEY = 'sidebar.teammatesGroupByComputer.v1';
const COMPACT_DENSITY_KEY = 'sidebar.teammatesCompactDensity.v1';

function readOwnerFlag(key: string, ownerId: string | null): boolean {
  return readSidebarOwnerStorage(key, ownerId) === '1';
}

function writeOwnerFlag(key: string, ownerId: string | null, value: boolean): void {
  writeSidebarOwnerStorage(key, ownerId, value ? '1' : '0');
}

function readOwnerIdSet(key: string, ownerId: string | null): Set<string> {
  const raw = readSidebarOwnerStorage(key, ownerId);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0));
  } catch {
    return new Set();
  }
}

function writeOwnerIdSet(
  key: string,
  ownerId: string | null,
  ids: ReadonlySet<string> | readonly string[],
): void {
  const unique = Array.from(new Set(Array.from(ids).filter((id) => typeof id === 'string' && id.length > 0)));
  writeSidebarOwnerStorage(key, ownerId, JSON.stringify(unique));
}

export function readTeammatesSectionCollapsed(ownerId: string | null): boolean {
  return readSidebarOwnerStorage(KEY, ownerId) === 'collapsed';
}

export function writeTeammatesSectionCollapsed(ownerId: string | null, collapsed: boolean): void {
  writeSidebarOwnerStorage(KEY, ownerId, collapsed ? 'collapsed' : 'expanded');
}

/** Reads collapsed hierarchy folder IDs for the current data owner. */
export function readTeammatesCollapsedFolders(ownerId: string | null): Set<string> {
  return readOwnerIdSet(COLLAPSED_FOLDERS_KEY, ownerId);
}

/** Persists collapsed hierarchy folder IDs for the current data owner. */
export function writeTeammatesCollapsedFolders(
  ownerId: string | null,
  folderIds: ReadonlySet<string> | readonly string[],
): void {
  writeOwnerIdSet(COLLAPSED_FOLDERS_KEY, ownerId, folderIds);
}

/** Reads collapsed computer group keys for the current data owner. */
export function readTeammatesCollapsedComputers(ownerId: string | null): Set<string> {
  return readOwnerIdSet(COLLAPSED_COMPUTERS_KEY, ownerId);
}

/** Persists collapsed computer group keys for the current data owner. */
export function writeTeammatesCollapsedComputers(
  ownerId: string | null,
  computerIds: ReadonlySet<string> | readonly string[],
): void {
  writeOwnerIdSet(COLLAPSED_COMPUTERS_KEY, ownerId, computerIds);
}

/** Reads whether teammates are grouped under outer computer sections. */
export function readTeammatesGroupByComputer(ownerId: string | null): boolean {
  return readOwnerFlag(GROUP_BY_COMPUTER_KEY, ownerId);
}

/** Persists whether teammates are grouped under outer computer sections. */
export function writeTeammatesGroupByComputer(ownerId: string | null, enabled: boolean): void {
  writeOwnerFlag(GROUP_BY_COMPUTER_KEY, ownerId, enabled);
}

/** Reads whether teammate rows use single-line compact density. */
export function readTeammatesCompactDensity(ownerId: string | null): boolean {
  return readOwnerFlag(COMPACT_DENSITY_KEY, ownerId);
}

/** Persists whether teammate rows use single-line compact density. */
export function writeTeammatesCompactDensity(ownerId: string | null, compact: boolean): void {
  writeOwnerFlag(COMPACT_DENSITY_KEY, ownerId, compact);
}
