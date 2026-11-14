import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  EllipsisVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  MonitorSmartphone,
  Pencil,
  Pin,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { aggregateTeammateStatus, type TeammateStatus } from '@cindy/maker-shared/teammate-status';

import { AttentionDot, type DotTone } from '@/components/sidebar/AttentionDot';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DeviceSectionHeader } from '@/features/cc-agent/sidebar/DeviceSectionHeader';
import { SIDEBAR_LIST_ROW_ACTIVE_CLASS } from '@/features/cc-agent/sidebar/listRowStyle';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { cn } from '@/lib/utils';
import {
  BOT_HIERARCHY_MAX_DEPTH,
  type BotHierarchyConfigV1,
  type BotHierarchyFolderTreeNode,
  assignItemsToFolder,
  botHierarchyItemKey,
  buildBotFolderTree,
  createBotFolder,
  deleteBotFolder,
  isFolderDescendantOrSelf,
  moveBotFolder,
  renameBotFolder,
  reorderFolderItems,
  reorderSiblings,
  resolveBotFolderId,
  resolveItemFolderId,
} from '../../../shared/botHierarchy';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { BotAvatar } from './BotAvatar';
import { BotGroupSidebarAvatar } from './BotGroupAvatars';
import { TeammateStatusDot } from './TeammateStatusDot';
import type { BotProfile } from './botStore';
import type { RemoteBot } from './remoteBotRoster';
import {
  mutateBotHierarchy,
  resolveUniqueBotFolderName,
  useBotHierarchy,
} from './botHierarchyClientStore';

const DRAG_DATA_MIME = 'application/x-cindy-hierarchy-drag';

type DragPayload =
  | { kind: 'item'; itemKey: string; folderId: string | null }
  | { kind: 'folder'; folderId: string; parentId: string | null };

export type TeammateTreeEntry =
  | {
      kind: 'bot';
      bot: BotProfile | RemoteBot;
      itemKey: string;
      status: TeammateStatus;
      selected: boolean;
      name: string;
      timestamp: string;
      typing: boolean;
      unread: number;
      deviceId: string | null;
      deviceName: string | null;
      online: boolean;
      pinned?: boolean;
      open: () => void;
    }
  | {
      kind: 'group';
      group: BotGroupSummary;
      itemKey: string;
      status: TeammateStatus;
      selected: boolean;
      name: string;
      unreadCount?: number;
      mentioned?: boolean;
      timestamp: string;
      typing: false;
      unread: number;
      deviceId: null;
      deviceName: null;
      online: true;
      pinned?: boolean;
      open: () => void;
    }
  | {
      kind: 'cindy';
      bot: BotProfile | RemoteBot;
      itemKey: string;
      status: TeammateStatus;
      selected: boolean;
      name: string;
      timestamp: string;
      typing: boolean;
      unread: number;
      deviceId: string | null;
      deviceName: string | null;
      online: boolean;
      pinned?: boolean;
      open: () => void;
    };

export interface TeammatesHierarchyTreeProps {
  entries: readonly TeammateTreeEntry[];
  groupByComputer: boolean;
  compactDensity: boolean;
  collapsedFolderIds: ReadonlySet<string>;
  collapsedComputerIds: ReadonlySet<string>;
  localDeviceId: string | null;
  localDeviceName: string;
  editingFolderId: string | null;
  onChangeEditingFolderId: (folderId: string | null) => void;
  onToggleFolder: (folderId: string) => void;
  onExpandFolder: (folderId: string) => void;
  onToggleComputer: (computerKey: string) => void;
  renderStandardRow: (entry: TeammateTreeEntry) => ReactNode;
  renderCompactContextMenu: (entry: TeammateTreeEntry) => ReactNode;
  onOpenEntryContextMenu: (
    entry: TeammateTreeEntry,
    origin: HTMLButtonElement,
    x: number,
    y: number,
  ) => void;
}

interface ComputerSection {
  key: string;
  deviceId: string | null;
  name: string;
  online: boolean;
  isLocal: boolean;
  entries: TeammateTreeEntry[];
}

interface SubtreeSummary {
  statuses: TeammateStatus[];
  hasRunning: boolean;
  aggregatedStatus: TeammateStatus;
  dotTone: DotTone | null;
}

function entryFolderId(config: BotHierarchyConfigV1, entry: TeammateTreeEntry): string | null {
  if (entry.kind === 'group') {
    return resolveItemFolderId(config, entry.itemKey);
  }
  return resolveBotFolderId(config, entry.bot.id, entry.deviceId);
}

function entryOrderScore(
  config: BotHierarchyConfigV1,
  entry: TeammateTreeEntry,
  folderId: string | null,
  rootOrderIndex: Map<string, number>,
): number | null {
  if (folderId === null) {
    const idx = rootOrderIndex.get(entry.itemKey);
    if (idx !== undefined) return idx;
    if (entry.kind !== 'group' && entry.deviceId) {
      const canonicalIdx = rootOrderIndex.get(botHierarchyItemKey(entry.bot.id));
      if (canonicalIdx !== undefined) return canonicalIdx;
    }
    const rootAssignment = config.assignments[entry.itemKey];
    if (rootAssignment && rootAssignment.folderId === null) return rootAssignment.order;
    return null;
  }

  const direct = config.assignments[entry.itemKey];
  if (direct && direct.folderId === folderId) return direct.order;
  if (entry.kind !== 'group' && entry.deviceId) {
    const canonical = config.assignments[botHierarchyItemKey(entry.bot.id)];
    if (canonical && canonical.folderId === folderId) return canonical.order;
  }
  return null;
}

function sortEntriesForContainer(
  config: BotHierarchyConfigV1,
  items: readonly TeammateTreeEntry[],
  folderId: string | null,
  originalIndex: Map<string, number>,
  rootOrderIndex: Map<string, number>,
): TeammateTreeEntry[] {
  return [...items].sort((a, b) => {
    const scoreA = entryOrderScore(config, a, folderId, rootOrderIndex);
    const scoreB = entryOrderScore(config, b, folderId, rootOrderIndex);
    if (scoreA !== null && scoreB !== null && scoreA !== scoreB) return scoreA - scoreB;
    if (scoreA !== null && scoreB === null) return -1;
    if (scoreA === null && scoreB !== null) return 1;
    return (originalIndex.get(a.itemKey) ?? 0) - (originalIndex.get(b.itemKey) ?? 0);
  });
}

function dotToneForStatus(status: TeammateStatus): DotTone | null {
  if (status === 'error') return 'error';
  if (status === 'awaiting') return 'awaiting';
  if (status === 'done' || status === 'unread') return 'done';
  return null;
}

function summarizeSubtree(
  node: BotHierarchyFolderTreeNode,
  membersByFolder: Map<string | null, TeammateTreeEntry[]>,
  out: Map<string, SubtreeSummary>,
): SubtreeSummary {
  const direct = membersByFolder.get(node.folder.id) ?? [];
  const statuses: TeammateStatus[] = direct.map((entry) => entry.status);
  for (const child of node.children) {
    const childSummary = summarizeSubtree(child, membersByFolder, out);
    statuses.push(...childSummary.statuses);
  }
  const aggregatedStatus = aggregateTeammateStatus(statuses);
  const summary: SubtreeSummary = {
    statuses,
    hasRunning: statuses.includes('running'),
    aggregatedStatus,
    dotTone: dotToneForStatus(aggregatedStatus),
  };
  out.set(node.folder.id, summary);
  return summary;
}

function filterTreeForEntries(
  nodes: readonly BotHierarchyFolderTreeNode[],
  activeFolderIds: ReadonlySet<string>,
  keepEmptyFolders: boolean,
): BotHierarchyFolderTreeNode[] {
  if (keepEmptyFolders) return [...nodes];
  const filtered: BotHierarchyFolderTreeNode[] = [];
  for (const node of nodes) {
    const children = filterTreeForEntries(node.children, activeFolderIds, false);
    if (activeFolderIds.has(node.folder.id) || children.length > 0) {
      filtered.push({ ...node, children });
    }
  }
  return filtered;
}

function reorderListWithMove(list: readonly string[], movingId: string, targetId: string, insertAfter: boolean): string[] {
  const withoutMoving = list.filter((id) => id !== movingId);
  const targetIdx = withoutMoving.indexOf(targetId);
  if (targetIdx < 0) return [...withoutMoving, movingId];
  const insertIdx = insertAfter ? targetIdx + 1 : targetIdx;
  const next = [...withoutMoving];
  next.splice(insertIdx, 0, movingId);
  return next;
}

function isDropInLowerHalf(event: DragEvent<HTMLElement>): boolean {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.height <= 0) return false;
  return event.clientY > rect.top + rect.height / 2;
}

function folderDropPlacement(event: DragEvent<HTMLElement>, sameParent: boolean): 'before' | 'after' | 'inside' {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.height <= 0) {
    return sameParent ? 'before' : 'inside';
  }
  const ratio = (event.clientY - rect.top) / rect.height;
  if (sameParent && ratio < 0.25) return 'before';
  if (sameParent && ratio > 0.75) return 'after';
  if (!sameParent && ratio < 0.2) return 'before';
  return 'inside';
}

function readDragPayload(event: DragEvent<HTMLElement>, fallback: DragPayload | null): DragPayload | null {
  try {
    const raw = event.dataTransfer?.getData(DRAG_DATA_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DragPayload>;
      if (parsed.kind === 'item' && typeof parsed.itemKey === 'string') {
        return {
          kind: 'item',
          itemKey: parsed.itemKey,
          folderId: typeof parsed.folderId === 'string' ? parsed.folderId : null,
        };
      }
      if (parsed.kind === 'folder' && typeof parsed.folderId === 'string') {
        return {
          kind: 'folder',
          folderId: parsed.folderId,
          parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
        };
      }
    }
  } catch {
    // Ignore malformed drag payloads from external drop sources.
  }
  return fallback;
}

/** Multi-level folder tree, optional computer grouping, inline rename, context actions, and DnD. */
export function TeammatesHierarchyTree({
  entries,
  groupByComputer,
  compactDensity,
  collapsedFolderIds,
  collapsedComputerIds,
  localDeviceId,
  localDeviceName,
  editingFolderId,
  onChangeEditingFolderId,
  onToggleFolder,
  onExpandFolder,
  onToggleComputer,
  renderStandardRow,
  renderCompactContextMenu,
  onOpenEntryContextMenu,
}: TeammatesHierarchyTreeProps) {
  const { t } = useTranslation();
  const { config } = useBotHierarchy();
  const folderTree = useMemo(() => buildBotFolderTree(config), [config]);

  const [editValue, setEditValue] = useState('');
  const committedRenameRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const folderMenuOriginRef = useRef<HTMLButtonElement | null>(null);
  const folderMenuPointerDownRef = useRef(false);
  const folderMenuRestoreFocusRef = useRef(true);
  const folderMenuSkipAutoFocusRef = useRef(false);

  const [activeDrag, setActiveDrag] = useState<DragPayload | null>(null);
  const activeDragRef = useRef<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!editingFolderId) return;
    const folder = config.folders[editingFolderId];
    if (!folder) {
      onChangeEditingFolderId(null);
      return;
    }
    setEditValue(folder.name);
    committedRenameRef.current = false;
    const timer = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editingFolderId, config.folders, onChangeEditingFolderId]);

  const beginInlineRename = useCallback(
    (folderId: string) => {
      folderMenuSkipAutoFocusRef.current = true;
      folderMenuRestoreFocusRef.current = false;
      const folder = config.folders[folderId];
      if (!folder) return;
      setEditValue(folder.name);
      committedRenameRef.current = false;
      onChangeEditingFolderId(folderId);
    },
    [config.folders, onChangeEditingFolderId],
  );

  const commitInlineRename = useCallback(
    async (folderId: string) => {
      if (committedRenameRef.current) return;
      committedRenameRef.current = true;
      const nextName = editValue.trim();
      const existingName = config.folders[folderId]?.name ?? '';
      onChangeEditingFolderId(null);
      if (!nextName || nextName === existingName) return;
      await mutateBotHierarchy((curr) => renameBotFolder(curr, folderId, nextName));
    },
    [config.folders, editValue, onChangeEditingFolderId],
  );

  const cancelInlineRename = useCallback(() => {
    committedRenameRef.current = true;
    onChangeEditingFolderId(null);
  }, [onChangeEditingFolderId]);

  const handleCreateSubfolder = useCallback(
    async (parentId: string) => {
      folderMenuSkipAutoFocusRef.current = true;
      folderMenuRestoreFocusRef.current = false;
      onExpandFolder(parentId);
      let createdId = '';
      const baseName = t('bots.hierarchy.defaultFolderName');
      await mutateBotHierarchy((curr) => {
        const name = resolveUniqueBotFolderName(curr, baseName, parentId);
        const result = createBotFolder(curr, { name, parentId });
        createdId = result.folder.id;
        return result.config;
      });
      if (createdId) {
        onChangeEditingFolderId(createdId);
      }
    },
    [onChangeEditingFolderId, onExpandFolder, t],
  );

  const openFolderContextMenu = (
    folderId: string,
    origin: HTMLButtonElement,
    x: number,
    y: number,
  ) => {
    folderMenuOriginRef.current = origin;
    folderMenuPointerDownRef.current = false;
    folderMenuRestoreFocusRef.current = true;
    folderMenuSkipAutoFocusRef.current = false;
    setFolderMenu({ folderId, x, y });
  };

  const clearDragState = useCallback(() => {
    activeDragRef.current = null;
    setActiveDrag(null);
    setDropTarget(null);
  }, []);

  const handleDragStart = (payload: DragPayload, event: DragEvent<HTMLElement>) => {
    event.stopPropagation();
    activeDragRef.current = payload;
    setActiveDrag(payload);
    try {
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(DRAG_DATA_MIME, JSON.stringify(payload));
        event.dataTransfer.setData(
          'text/plain',
          payload.kind === 'folder' ? payload.folderId : payload.itemKey,
        );
      }
    } catch {
      // jsdom or restricted drag events may omit dataTransfer methods.
    }
  };

  const handleDropOnFolder = async (
    event: DragEvent<HTMLElement>,
    targetFolderId: string,
    siblingFolderIds: readonly string[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const drag = readDragPayload(event, activeDragRef.current);
    clearDragState();
    if (!drag) return;

    if (drag.kind === 'item') {
      if (drag.folderId === targetFolderId) return;
      onExpandFolder(targetFolderId);
      await mutateBotHierarchy((curr) => assignItemsToFolder(curr, [drag.itemKey], targetFolderId));
      return;
    }

    if (drag.folderId === targetFolderId) return;
    if (isFolderDescendantOrSelf(config, targetFolderId, drag.folderId)) return;

    const targetFolder = config.folders[targetFolderId];
    const targetParentId = targetFolder?.parentId ?? null;
    const sameParent = (drag.parentId ?? null) === targetParentId;
    const placement = folderDropPlacement(event, sameParent);

    if (sameParent && placement !== 'inside') {
      const reordered = reorderListWithMove(
        siblingFolderIds,
        drag.folderId,
        targetFolderId,
        placement === 'after',
      );
      await mutateBotHierarchy((curr) => reorderSiblings(curr, targetParentId, reordered));
      return;
    }

    onExpandFolder(targetFolderId);
    await mutateBotHierarchy((curr) => moveBotFolder(curr, drag.folderId, targetFolderId));
  };

  const handleDropOnItem = async (
    event: DragEvent<HTMLElement>,
    targetEntry: TeammateTreeEntry,
    targetFolderId: string | null,
    containerItemKeys: readonly string[],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const drag = readDragPayload(event, activeDragRef.current);
    clearDragState();
    if (!drag || drag.kind !== 'item' || drag.itemKey === targetEntry.itemKey) return;

    const insertAfter = isDropInLowerHalf(event);
    const nextOrder = reorderListWithMove(
      containerItemKeys,
      drag.itemKey,
      targetEntry.itemKey,
      insertAfter,
    );

    if (targetFolderId !== null) {
      onExpandFolder(targetFolderId);
    }

    await mutateBotHierarchy((curr) => {
      const assigned =
        drag.folderId === targetFolderId
          ? curr
          : assignItemsToFolder(curr, [drag.itemKey], targetFolderId);
      return reorderFolderItems(assigned, targetFolderId, nextOrder);
    });
  };

  const handleDropToRoot = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const drag = readDragPayload(event, activeDragRef.current);
    clearDragState();
    if (!drag) return;
    if (drag.kind === 'item') {
      if (drag.folderId === null) return;
      await mutateBotHierarchy((curr) => assignItemsToFolder(curr, [drag.itemKey], null));
      return;
    }
    if (drag.parentId !== null) {
      await mutateBotHierarchy((curr) => moveBotFolder(curr, drag.folderId, null));
    }
  };

  const renderCompactRow = (entry: TeammateTreeEntry) => {
    const mutedClass = entry.selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
    const openContext = (origin: HTMLButtonElement, x: number, y: number) => {
      onOpenEntryContextMenu(entry, origin, x, y);
    };

    return (
      <div
        className={cn(
          'group relative flex w-full items-center rounded-lg transition-colors',
          entry.selected
            ? SIDEBAR_LIST_ROW_ACTIVE_CLASS
            : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
        )}
      >
        <button
          type="button"
          onClick={entry.open}
          aria-current={entry.selected ? 'page' : undefined}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openContext(event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
              return;
            }
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openContext(event.currentTarget, rect.left + 10, rect.bottom);
          }}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            {entry.kind === 'group' ? (
              entry.group.members.length > 0 ? (
                <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full">
                  <span className="flex scale-[0.55] items-center justify-center">
                    <BotGroupSidebarAvatar
                      members={entry.group.members}
                      compact
                      selected={entry.selected}
                    />
                  </span>
                </span>
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--sidebar-list-muted)]">
                  <Users size={11} aria-hidden />
                </span>
              )
            ) : (
              <BotAvatar bot={entry.bot} size="xs" />
            )}
          </span>
          {entry.pinned ? (
            <Pin
              size={10}
              aria-label={t('bots.list.pinned')}
              className="shrink-0 text-[var(--sidebar-list-muted)]"
            />
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-13 leading-5',
              entry.unread > 0 ? 'font-medium' : 'font-normal',
            )}
            title={entry.name}
          >
            {entry.name}
          </span>
          {entry.typing && entry.status !== 'awaiting' ? (
            <span
              role="img"
              aria-label={t('bots.avatarStatus.running')}
              title={t('bots.avatarStatus.running')}
              className="size-2 shrink-0 rounded-full bg-[var(--status-bar-accent)] session-status-breathing"
            />
          ) : entry.status !== 'idle' ? (
            <TeammateStatusDot
              status={entry.status}
              mentioned={entry.kind === 'group' ? entry.mentioned : false}
              group={entry.kind === 'group'}
              inline
            />
          ) : null}
          {entry.timestamp ? (
            <span className={cn('shrink-0 text-11 tabular-nums', mutedClass)}>
              {entry.timestamp}
            </span>
          ) : null}
        </button>
        {renderCompactContextMenu(entry)}
      </div>
    );
  };

  const renderSectionContent = (
    sectionEntries: readonly TeammateTreeEntry[],
    includeEmptyFolders: boolean,
  ) => {
    const originalIndex = new Map(sectionEntries.map((entry, idx) => [entry.itemKey, idx]));
    const rootOrderIndex = new Map(config.rootOrder.map((key, idx) => [key, idx]));

    const membersByFolder = new Map<string | null, TeammateTreeEntry[]>();
    const activeFolderIds = new Set<string>();
    for (const entry of sectionEntries) {
      const folderId = entryFolderId(config, entry);
      if (folderId) activeFolderIds.add(folderId);
      const bucket = membersByFolder.get(folderId);
      if (bucket) bucket.push(entry);
      else membersByFolder.set(folderId, [entry]);
    }

    for (const [folderId, bucket] of membersByFolder.entries()) {
      membersByFolder.set(
        folderId,
        sortEntriesForContainer(config, bucket, folderId, originalIndex, rootOrderIndex),
      );
    }

    const visibleTree = filterTreeForEntries(folderTree, activeFolderIds, includeEmptyFolders);
    const subtreeSummaries = new Map<string, SubtreeSummary>();
    for (const rootNode of visibleTree) {
      summarizeSubtree(rootNode, membersByFolder, subtreeSummaries);
    }

    const ungroupedEntries = membersByFolder.get(null) ?? [];
    const ungroupedKeys = ungroupedEntries.map((entry) => entry.itemKey);

    const renderEntryNode = (
      entry: TeammateTreeEntry,
      folderId: string | null,
      siblingKeys: readonly string[],
      depth: number,
    ) => {
      const targetId = `item:${entry.itemKey}`;
      return (
        <div
          key={entry.itemKey}
          data-hierarchy-item-key={entry.itemKey}
          draggable
          onDragStart={(e) =>
            handleDragStart({ kind: 'item', itemKey: entry.itemKey, folderId }, e)
          }
          onDragEnd={clearDragState}
          onDragOver={(e) => {
            if (!activeDragRef.current || activeDragRef.current.kind !== 'item') return;
            if (activeDragRef.current.itemKey === entry.itemKey) return;
            e.preventDefault();
            e.stopPropagation();
            if (dropTarget !== targetId) setDropTarget(targetId);
          }}
          onDragLeave={() => {
            if (dropTarget === targetId) setDropTarget(null);
          }}
          onDrop={(e) => void handleDropOnItem(e, entry, folderId, siblingKeys)}
          style={depth > 0 ? { paddingLeft: depth * 12 } : undefined}
          className={cn(
            'rounded-lg transition-colors',
            dropTarget === targetId && 'ring-1 ring-[var(--focus-ring)] bg-sidebar-item-hover',
          )}
        >
          {compactDensity ? renderCompactRow(entry) : renderStandardRow(entry)}
        </div>
      );
    };

    const renderFolderNode = (
      node: BotHierarchyFolderTreeNode,
      siblingFolderIds: readonly string[],
    ): ReactNode => {
      const { folder, depth, children } = node;
      const isCollapsed = collapsedFolderIds.has(folder.id);
      const isEditing = editingFolderId === folder.id;
      const summary = subtreeSummaries.get(folder.id);
      const directEntries = membersByFolder.get(folder.id) ?? [];
      const directKeys = directEntries.map((entry) => entry.itemKey);
      const childSiblingIds = children.map((child) => child.folder.id);
      const FolderIcon = isCollapsed ? Folder : FolderOpen;
      const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
      const dropKey = `folder:${folder.id}`;
      const isMenuOpen = folderMenu?.folderId === folder.id;
      const canAddSubfolder = depth < BOT_HIERARCHY_MAX_DEPTH;

      return (
        <div key={folder.id} className="flex flex-col gap-0.5">
          <div
            data-hierarchy-folder-id={folder.id}
            draggable={!isEditing}
            onDragStart={(e) =>
              handleDragStart(
                { kind: 'folder', folderId: folder.id, parentId: folder.parentId ?? null },
                e,
              )
            }
            onDragEnd={clearDragState}
            onDragOver={(e) => {
              const drag = activeDragRef.current;
              if (drag && drag.kind === 'folder' && drag.folderId === folder.id) return;
              e.preventDefault();
              e.stopPropagation();
              if (dropTarget !== dropKey) setDropTarget(dropKey);
            }}
            onDragLeave={() => {
              if (dropTarget === dropKey) setDropTarget(null);
            }}
            onDrop={(e) => void handleDropOnFolder(e, folder.id, siblingFolderIds)}
            style={{ paddingLeft: 8 + (depth - 1) * 14 }}
            className={cn(
              'group relative flex h-8 w-full items-center gap-1 rounded-full pr-1.5 transition-colors',
              !isEditing && 'hover:bg-sidebar-item-hover',
              dropTarget === dropKey && 'ring-1 ring-[var(--focus-ring)] bg-sidebar-item-hover',
            )}
          >
            {isEditing ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="inline-flex shrink-0 text-[var(--sidebar-list-muted)]">
                  <FolderIcon size={15} strokeWidth={1.8} aria-hidden />
                </span>
                <input
                  ref={renameInputRef}
                  type="text"
                  autoFocus
                  value={editValue}
                  aria-label={t('bots.hierarchy.renameInputLabel')}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => void commitInlineRename(folder.id)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void commitInlineRename(folder.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelInlineRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()}
                  className="h-6 min-w-0 flex-1 rounded border-[1.5px] border-[var(--focus-ring)] bg-transparent px-1.5 text-sm font-normal text-foreground outline-none"
                />
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => onToggleFolder(folder.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  beginInlineRename(folder.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openFolderContextMenu(folder.id, e.currentTarget, e.clientX, e.clientY);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  openFolderContextMenu(folder.id, e.currentTarget, rect.left + 10, rect.bottom);
                }}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-full text-left text-sm font-normal text-[var(--sidebar-list-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <span
                  data-folder-icon-wrapper={folder.id}
                  className={cn(
                    'inline-flex shrink-0',
                    isCollapsed && summary?.hasRunning
                      ? 'text-[var(--status-bar-accent)] session-status-breathing'
                      : 'text-[var(--sidebar-list-muted)]',
                  )}
                >
                  <FolderIcon size={15} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="min-w-0 shrink truncate" title={folder.name}>
                  {folder.name}
                </span>
                <ChevronIcon
                  size={13}
                  strokeWidth={2}
                  aria-hidden
                  className="shrink-0 text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100"
                />
              </button>
            )}

            {!isEditing ? (
              <div className="ml-auto flex shrink-0 items-center justify-end">
                {isCollapsed && (summary?.dotTone || summary?.hasRunning) ? (
                  <span
                    data-folder-status-dot={summary?.aggregatedStatus}
                    className={cn(
                      'flex items-center px-1',
                      isMenuOpen
                        ? 'hidden'
                        : 'group-hover:hidden group-focus-within:hidden',
                    )}
                  >
                    {summary?.dotTone ? (
                      <AttentionDot size={6} tone={summary.dotTone} />
                    ) : (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-[var(--status-bar-accent)] session-status-breathing"
                      />
                    )}
                  </span>
                ) : null}
                <div
                  className={cn(
                    'items-center gap-0.5',
                    isMenuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
                  )}
                >
                  {canAddSubfolder ? (
                    <Tip text={t('bots.hierarchy.newSubfolder')} side="bottom">
                      <button
                        type="button"
                        aria-label={t('bots.hierarchy.newSubfolder')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleCreateSubfolder(folder.id);
                        }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--sidebar-nav-text)]"
                      >
                        <FolderPlus size={13} strokeWidth={2} />
                      </button>
                    </Tip>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t('bots.list.moreActions', { name: folder.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      openFolderContextMenu(folder.id, e.currentTarget, rect.left, rect.bottom + 2);
                    }}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--sidebar-nav-text)]"
                  >
                    <EllipsisVertical size={13} strokeWidth={2} />
                  </button>
                </div>
              </div>
            ) : null}

            <DropdownMenu
              open={isMenuOpen}
              onOpenChange={(open) => {
                if (!open) setFolderMenu(null);
              }}
            >
              <DropdownMenuTrigger asChild>
                <span
                  aria-hidden="true"
                  className="pointer-events-none fixed h-0 w-0"
                  style={{ left: folderMenu?.x ?? 0, top: folderMenu?.y ?? 0 }}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-44"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (folderMenuSkipAutoFocusRef.current) {
                    folderMenuSkipAutoFocusRef.current = false;
                    return;
                  }
                  if (folderMenuRestoreFocusRef.current) {
                    folderMenuOriginRef.current?.focus({ preventScroll: true });
                  }
                }}
                onInteractOutside={() => {
                  folderMenuRestoreFocusRef.current = false;
                }}
                onPointerDownCapture={(event) => {
                  folderMenuPointerDownRef.current = event.button === 0 && !event.ctrlKey;
                }}
                onPointerUpCapture={(event) => {
                  if (!folderMenuPointerDownRef.current || event.button !== 0 || event.ctrlKey) {
                    event.preventDefault();
                  }
                  folderMenuPointerDownRef.current = false;
                }}
              >
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  disabled={!canAddSubfolder}
                  onSelect={() => void handleCreateSubfolder(folder.id)}
                >
                  <FolderPlus size={14} className="shrink-0" />
                  <span>{t('bots.hierarchy.newSubfolder')}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={MENU_ITEM_CLASS}
                  onSelect={() => beginInlineRename(folder.id)}
                >
                  <Pencil size={14} className="shrink-0" />
                  <span>{t('bots.hierarchy.renameFolder')}</span>
                </DropdownMenuItem>
                {folder.parentId !== null ? (
                  <DropdownMenuItem
                    className={MENU_ITEM_CLASS}
                    onSelect={() =>
                      void mutateBotHierarchy((curr) => moveBotFolder(curr, folder.id, null))
                    }
                  >
                    <CornerLeftUp size={14} className="shrink-0" />
                    <span>{t('bots.hierarchy.moveToRoot')}</span>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="danger"
                  className={MENU_ITEM_CLASS}
                  onSelect={() =>
                    void mutateBotHierarchy((curr) =>
                      deleteBotFolder(curr, folder.id, { mode: 'promote-children' }),
                    )
                  }
                >
                  <Trash2 size={14} className="shrink-0" />
                  <span>{t('bots.hierarchy.deleteFolder')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <SectionCollapse collapsed={isCollapsed}>
            <div className="flex flex-col gap-0.5">
              {children.map((child) => renderFolderNode(child, childSiblingIds))}
              {directEntries.map((entry) =>
                renderEntryNode(entry, folder.id, directKeys, depth),
              )}
            </div>
          </SectionCollapse>
        </div>
      );
    };

    const rootSiblingIds = visibleTree.map((node) => node.folder.id);
    const showUngroupedHeading = visibleTree.length > 0 && ungroupedEntries.length > 0;
    const showDragRootZone =
      visibleTree.length > 0 &&
      ungroupedEntries.length === 0 &&
      ((activeDrag?.kind === 'item' && activeDrag.folderId !== null) ||
        (activeDrag?.kind === 'folder' && activeDrag.parentId !== null));

    return (
      <div className="flex flex-col gap-0.5">
        {visibleTree.map((node) => renderFolderNode(node, rootSiblingIds))}

        {showUngroupedHeading ? (
          <div
            data-hierarchy-ungrouped-drop="true"
            onDragOver={(e) => {
              if (!activeDragRef.current) return;
              e.preventDefault();
              e.stopPropagation();
              if (dropTarget !== 'ungrouped') setDropTarget('ungrouped');
            }}
            onDragLeave={() => {
              if (dropTarget === 'ungrouped') setDropTarget(null);
            }}
            onDrop={(e) => void handleDropToRoot(e)}
            className={cn(
              'mt-1.5 mb-0.5 flex items-center gap-2 rounded-lg px-2.5 py-0.5 text-11 font-medium text-[var(--sidebar-list-muted)]',
              dropTarget === 'ungrouped' && 'ring-1 ring-[var(--focus-ring)] bg-sidebar-item-hover',
            )}
          >
            <span>{t('bots.hierarchy.ungrouped')}</span>
          </div>
        ) : null}

        {showDragRootZone ? (
          <div
            data-hierarchy-ungrouped-drop="true"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dropTarget !== 'ungrouped') setDropTarget('ungrouped');
            }}
            onDragLeave={() => {
              if (dropTarget === 'ungrouped') setDropTarget(null);
            }}
            onDrop={(e) => void handleDropToRoot(e)}
            className={cn(
              'mt-1 flex h-8 items-center rounded-lg border border-dashed border-[var(--border-default)] px-2.5 text-11 text-[var(--sidebar-list-muted)]',
              dropTarget === 'ungrouped' && 'border-[var(--focus-ring)] bg-sidebar-item-hover',
            )}
          >
            <span>{t('bots.hierarchy.ungrouped')}</span>
          </div>
        ) : null}

        {ungroupedEntries.map((entry) => renderEntryNode(entry, null, ungroupedKeys, 0))}
      </div>
    );
  };

  if (!groupByComputer) {
    return (
      <div
        className="flex flex-col gap-0.5"
        data-hierarchy-root-drop="true"
        onDragOver={(e) => {
          if (!activeDragRef.current) return;
          e.preventDefault();
        }}
        onDrop={(e) => void handleDropToRoot(e)}
      >
        {renderSectionContent(entries, true)}
      </div>
    );
  }

  const computerSections: ComputerSection[] = [];
  const sectionByKey = new Map<string, ComputerSection>();

  const ensureSection = (
    key: string,
    deviceId: string | null,
    name: string,
    online: boolean,
    isLocal: boolean,
  ): ComputerSection => {
    const existing = sectionByKey.get(key);
    if (existing) {
      if (online) existing.online = true;
      return existing;
    }
    const created: ComputerSection = { key, deviceId, name, online, isLocal, entries: [] };
    sectionByKey.set(key, created);
    computerSections.push(created);
    return created;
  };

  const localKey = 'local';
  const hasAnyLocalOrGroup = entries.some((entry) => !entry.deviceId);
  if (hasAnyLocalOrGroup || folderTree.length > 0) {
    ensureSection(localKey, localDeviceId, localDeviceName, true, true);
  }

  for (const entry of entries) {
    if (entry.deviceId) {
      const remoteKey = `device:${entry.deviceId}`;
      const section = ensureSection(
        remoteKey,
        entry.deviceId,
        entry.deviceName || entry.deviceId,
        entry.online,
        false,
      );
      section.entries.push(entry);
    } else {
      const localSection = ensureSection(localKey, localDeviceId, localDeviceName, true, true);
      localSection.entries.push(entry);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {computerSections.map((section) => {
        const isCollapsed = collapsedComputerIds.has(section.key);
        const statuses = section.entries.map((entry) => entry.status);
        const hasRunning = statuses.includes('running');
        const aggregated = aggregateTeammateStatus(statuses);
        const dotTone = dotToneForStatus(aggregated);

        return (
          <div key={section.key} className="flex flex-col" data-computer-section={section.key}>
            <DeviceSectionHeader deviceId={section.isLocal ? null : section.deviceId} name={section.name}>
              <button
                type="button"
                onClick={() => onToggleComputer(section.key)}
                aria-expanded={!isCollapsed}
                aria-label={section.name}
                className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
              >
                <span
                  className={cn(
                    'inline-flex shrink-0',
                    isCollapsed && hasRunning && 'text-[var(--status-bar-accent)] session-status-breathing',
                  )}
                >
                  <MonitorSmartphone size={13} strokeWidth={2} aria-hidden />
                </span>
                <span className="min-w-0 truncate text-xs font-medium">{section.name}</span>
                {isCollapsed ? (
                  <ChevronRight size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                ) : (
                  <ChevronDown size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                )}
                {!section.online ? (
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-[var(--text-tertiary)]"
                  />
                ) : null}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {isCollapsed && dotTone ? <AttentionDot size={6} tone={dotTone} /> : null}
                  {!section.online ? (
                    <span className="shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">
                      {t('ccAgent.sidebar.deviceGroup.offline')}
                    </span>
                  ) : null}
                </span>
              </button>
            </DeviceSectionHeader>
            <SectionCollapse collapsed={isCollapsed}>
              <div className={cn('flex flex-col gap-0.5 pl-2', (section.entries.length > 0 || section.isLocal) && 'pt-1')}>
                {renderSectionContent(section.entries, section.isLocal)}
              </div>
            </SectionCollapse>
          </div>
        );
      })}
    </div>
  );
}
