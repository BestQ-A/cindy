import { useRef } from 'react';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { toast } from '@/lib/toast';
import {
  type BotHierarchyConfigV1,
  type BotRosterOrganizeEntry,
  botHierarchyItemKey,
  buildSmartBotHierarchy,
  createBotFolder,
  deleteBotFolder,
  normalizeBotHierarchyConfig,
} from '../../../shared/botHierarchy';
import {
  mutateBotHierarchy,
  resolveUniqueBotFolderName,
  useBotHierarchy,
} from './botHierarchyClientStore';

const TRIGGER_BUTTON_CLASS =
  'relative flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]';

export interface SmartOrganizeOutcome {
  organizedCount: number;
  folderIds: string[];
  config: BotHierarchyConfigV1;
}

function extractRemoteBotIdFromKey(key: string): string | null {
  if (!key.startsWith('remote-bot:')) return null;
  const rest = key.slice('remote-bot:'.length);
  const sep = rest.indexOf(':');
  return sep >= 0 ? rest.slice(sep + 1) || null : null;
}

/**
 * Runs role/prefix/keyword smart organization over the given roster entries.
 * If all eligible entries are already grouped, retries with overwrite so re-running
 * applies updated taxonomy rules when assignments would change.
 */
export async function executeSmartOrganize(
  organizeEntries: BotRosterOrganizeEntry[],
  deviceId?: string,
): Promise<SmartOrganizeOutcome> {
  let organizedCount = 0;
  let folderIds: string[] = [];
  const nextConfig = await mutateBotHierarchy((curr) => {
    const foldersWithMembersBefore = new Set<string>();
    for (const assignment of Object.values(curr.assignments)) {
      let folderId = assignment.folderId;
      const visited = new Set<string>();
      while (folderId && curr.folders[folderId] && !visited.has(folderId)) {
        visited.add(folderId);
        foldersWithMembersBefore.add(folderId);
        folderId = curr.folders[folderId]?.parentId ?? null;
      }
    }

    const initial = buildSmartBotHierarchy(curr, organizeEntries, { deviceId });
    let resolved = initial;
    if (
      initial.summary.assignedItemCount === 0 &&
      initial.summary.createdFolderIds.length === 0
    ) {
      const refreshed = buildSmartBotHierarchy(curr, organizeEntries, {
        deviceId,
        overwriteExistingAssignments: true,
      });
      const assignmentsChanged =
        refreshed.summary.createdFolderIds.length > 0 ||
        Object.keys(refreshed.config.assignments).length !== Object.keys(curr.assignments).length ||
        Object.entries(refreshed.config.assignments).some(
          ([key, value]) => curr.assignments[key]?.folderId !== value.folderId,
        );
      if (assignmentsChanged) {
        resolved = refreshed;
      }
    }

    let next: BotHierarchyConfigV1 = {
      ...resolved.config,
      folders: { ...resolved.config.folders },
      assignments: { ...resolved.config.assignments },
      rootOrder: [...resolved.config.rootOrder],
      deletedFolderIds: { ...resolved.config.deletedFolderIds },
    };

    let cleanedStaleCount = 0;
    for (const key of Object.keys(next.assignments)) {
      const remoteBotId = extractRemoteBotIdFromKey(key);
      if (!remoteBotId) continue;
      const canonicalKey = botHierarchyItemKey(remoteBotId);
      const canonicalAssignment = canonicalKey ? next.assignments[canonicalKey] : undefined;
      const remoteAssignment = next.assignments[key];
      if (
        canonicalAssignment &&
        remoteAssignment &&
        canonicalAssignment.updatedAt > remoteAssignment.updatedAt
      ) {
        delete next.assignments[key];
        cleanedStaleCount += 1;
      }
    }

    let prunedCount = 0;
    let removedInPass = true;
    while (removedInPass) {
      removedInPass = false;
      for (const fid of foldersWithMembersBefore) {
        if (!next.folders[fid]) continue;
        const hasChildFolder = Object.values(next.folders).some((f) => f.parentId === fid);
        if (hasChildFolder) continue;
        const hasAssignedItem = Object.values(next.assignments).some((a) => a.folderId === fid);
        if (hasAssignedItem) continue;
        next = deleteBotFolder(next, fid, { mode: 'cascade', deviceId });
        prunedCount += 1;
        removedInPass = true;
      }
    }

    next = normalizeBotHierarchyConfig(next);
    organizedCount =
      resolved.summary.assignedItemCount +
      resolved.summary.createdFolderIds.length +
      cleanedStaleCount +
      prunedCount;
    folderIds = Array.from(
      new Set([...resolved.summary.createdFolderIds, ...resolved.summary.updatedFolderIds]),
    ).filter((id) => Boolean(next.folders[id]));
    return next;
  });

  return { organizedCount, folderIds, config: nextConfig };
}

export interface TeammatesDisplayMenuProps {
  /** Roster entries passed to smart organize when triggered from the menu. */
  organizeEntries: BotRosterOrganizeEntry[];
  deviceId?: string;
  groupByComputer: boolean;
  compactDensity: boolean;
  onGroupByComputerChange: (enabled: boolean) => void;
  onCompactDensityChange: (compact: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Called after creating or smart-organizing folders so the tree opens and focuses rename if appropriate. */
  onCreatedFolder?: (folderId: string) => void;
  onSmartOrganized?: (folderIds: string[]) => void;
}

/**
 * Header display & organization menu for the sidebar Teammates section:
 * folder creation, smart organization, computer grouping, density toggle, and expand/collapse all.
 */
export function TeammatesDisplayMenu({
  organizeEntries,
  deviceId,
  groupByComputer,
  compactDensity,
  onGroupByComputerChange,
  onCompactDensityChange,
  onExpandAll,
  onCollapseAll,
  onCreatedFolder,
  onSmartOrganized,
}: TeammatesDisplayMenuProps) {
  const { t } = useTranslation();
  const { config } = useBotHierarchy();
  const skipAutoFocusRef = useRef(false);
  const folderCount = Object.keys(config.folders).length;
  const canToggleFold = folderCount > 0 || groupByComputer;

  const handleCreateRootFolder = async () => {
    skipAutoFocusRef.current = true;
    let createdFolderId = '';
    const baseName = t('bots.hierarchy.defaultFolderName');
    await mutateBotHierarchy((curr) => {
      const name = resolveUniqueBotFolderName(curr, baseName, null);
      const result = createBotFolder(curr, { name, parentId: null });
      createdFolderId = result.folder.id;
      return result.config;
    });
    if (createdFolderId) {
      onCreatedFolder?.(createdFolderId);
    }
  };

  const handleSmartOrganize = async () => {
    const { organizedCount, folderIds } = await executeSmartOrganize(organizeEntries, deviceId);

    if (organizedCount === 0) {
      toast.info(t('bots.hierarchy.smartOrganizeEmpty'));
      return;
    }
    onSmartOrganized?.(folderIds);
    toast.success(t('bots.hierarchy.smartOrganizeDone'));
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Tip text={t('bots.hierarchy.menuTrigger')} side="bottom">
          <button
            type="button"
            className={TRIGGER_BUTTON_CLASS}
            aria-label={t('bots.hierarchy.menuTrigger')}
          >
            <SlidersHorizontal size={13} strokeWidth={2} />
            {(groupByComputer || compactDensity) ? (
              <span
                aria-hidden="true"
                className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-[var(--status-bar-accent)]"
              />
            ) : null}
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        onCloseAutoFocus={(event) => {
          if (!skipAutoFocusRef.current) return;
          skipAutoFocusRef.current = false;
          event.preventDefault();
        }}
      >
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleCreateRootFolder()}>
          <FolderPlus size={14} className="shrink-0 text-[var(--folder-item-icon)]" />
          <span className="truncate">{t('bots.hierarchy.newFolder')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleSmartOrganize()}>
          <Sparkles size={14} className="shrink-0 text-[var(--status-bar-accent)]" />
          <span className="truncate">{t('bots.hierarchy.smartOrganize')}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={groupByComputer}
          onCheckedChange={(checked) => onGroupByComputerChange(checked === true)}
          className={MENU_ITEM_CLASS}
        >
          <span className="truncate">{t('bots.hierarchy.groupByComputer')}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={compactDensity}
          onCheckedChange={(checked) => onCompactDensityChange(checked === true)}
          className={MENU_ITEM_CLASS}
        >
          <span className="truncate">{t('bots.hierarchy.compactDensity')}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canToggleFold}
          className={MENU_ITEM_CLASS}
          onSelect={onExpandAll}
        >
          <ChevronsUpDown size={14} className="shrink-0" />
          <span className="truncate">{t('bots.hierarchy.expandAll')}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canToggleFold}
          className={MENU_ITEM_CLASS}
          onSelect={onCollapseAll}
        >
          <ChevronsDownUp size={14} className="shrink-0" />
          <span className="truncate">{t('bots.hierarchy.collapseAll')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
