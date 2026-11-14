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
  type BotRosterOrganizeEntry,
  buildSmartBotHierarchy,
  createBotFolder,
} from '../../../shared/botHierarchy';
import {
  mutateBotHierarchy,
  resolveUniqueBotFolderName,
  useBotHierarchy,
} from './botHierarchyClientStore';

const TRIGGER_BUTTON_CLASS =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]';

export interface TeammatesDisplayMenuProps {
  /** Roster entries passed to smart organize when triggered from the menu. */
  organizeEntries: BotRosterOrganizeEntry[];
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
    let organizedCount = 0;
    let folderIds: string[] = [];
    await mutateBotHierarchy((curr) => {
      const result = buildSmartBotHierarchy(curr, organizeEntries);
      organizedCount = result.summary.assignedItemCount + result.summary.createdFolderIds.length;
      folderIds = Array.from(
        new Set([...result.summary.createdFolderIds, ...result.summary.updatedFolderIds]),
      );
      return result.config;
    });

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
