import { Check, Folder, FolderInput, FolderMinus, FolderPlus, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS, MENU_ROW_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { cn } from '@/lib/utils';
import {
  assignItemsToFolder,
  createBotFolder,
  flattenFolderOptions,
  resolveItemFolderId,
} from '../../../shared/botHierarchy';
import {
  mutateBotHierarchy,
  resolveUniqueBotFolderName,
  useBotHierarchy,
} from './botHierarchyClientStore';

export interface BotMoveToFolderSubmenuProps {
  /** Canonical hierarchy item key (`bot:<id>`, `remote-bot:<device>:<id>`, or `group:<id>`). */
  itemKey: string;
  /** Optional callback after creating a new folder and moving the item into it (for expanding + inline rename). */
  onCreatedAndMoved?: (folderId: string) => void;
  /** Optional callback after moving or removing the item from its folder. */
  onMoved?: (targetFolderId: string | null) => void;
}

/**
 * Reusable context-menu submenu allowing a buddy or group chat to be moved
 * into any existing folder, ungrouped out of its current folder, or placed into
 * a newly created folder on the spot.
 */
export function BotMoveToFolderSubmenu({
  itemKey,
  onCreatedAndMoved,
  onMoved,
}: BotMoveToFolderSubmenuProps) {
  const { t } = useTranslation();
  const { config } = useBotHierarchy();
  const folderOptions = flattenFolderOptions(config);
  const currentFolderId = resolveItemFolderId(config, itemKey);

  const handleAssign = async (folderId: string | null) => {
    if (!itemKey) return;
    await mutateBotHierarchy((curr) => assignItemsToFolder(curr, [itemKey], folderId));
    onMoved?.(folderId);
  };

  const handleCreateAndMove = async () => {
    if (!itemKey) return;
    let createdFolderId = '';
    const baseName = t('bots.hierarchy.defaultFolderName');
    await mutateBotHierarchy((curr) => {
      const name = resolveUniqueBotFolderName(curr, baseName, null);
      const created = createBotFolder(curr, { name, parentId: null });
      createdFolderId = created.folder.id;
      return assignItemsToFolder(created.config, [itemKey], created.folder.id);
    });
    if (createdFolderId) {
      onCreatedAndMoved?.(createdFolderId);
      onMoved?.(createdFolderId);
    }
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={MENU_ROW_CLASS}>
        <FolderInput size={14} className="shrink-0" />
        <span className="truncate">{t('bots.hierarchy.moveToFolder')}</span>
        <ChevronRight size={14} className="ml-auto shrink-0 opacity-60" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <div className="max-h-[224px] overflow-x-hidden overflow-y-auto">
          {folderOptions.map((option) => {
            const isCurrent = option.id === currentFolderId;
            return (
              <DropdownMenuItem
                key={option.id}
                disabled={isCurrent}
                onSelect={() => void handleAssign(option.id)}
                className={cn(MENU_ITEM_CLASS, 'justify-between')}
                style={{ paddingLeft: 8 + (option.depth - 1) * 12 }}
                title={option.pathLabel}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Folder size={14} className="shrink-0 text-[var(--folder-item-icon)]" />
                  <span className="truncate">{option.name}</span>
                </span>
                {isCurrent ? <Check size={14} className="shrink-0 opacity-70" /> : null}
              </DropdownMenuItem>
            );
          })}
        </div>
        {folderOptions.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleCreateAndMove()}>
          <FolderPlus size={14} className="shrink-0 text-[var(--folder-item-icon)]" />
          <span className="truncate">{t('bots.hierarchy.createAndMove')}</span>
        </DropdownMenuItem>
        {currentFolderId !== null ? (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => void handleAssign(null)}>
            <FolderMinus size={14} className="shrink-0" />
            <span className="truncate">{t('bots.hierarchy.moveOutOfFolder')}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
