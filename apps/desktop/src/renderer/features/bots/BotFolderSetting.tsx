/**
 * Folder / hierarchy membership setting row for a companion's settings home page.
 * Allows viewing the current folder path and moving the companion across folders or out to root.
 */
import { Check, ChevronRight, Folder, FolderMinus, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { cn } from '@/lib/utils';
import {
  assignItemsToFolder,
  type BotHierarchyConfigV1,
  botHierarchyItemKey,
  createBotFolder,
  flattenFolderOptions,
  getFolderBreadcrumb,
  resolveBotFolderId,
} from '../../../shared/botHierarchy';
import {
  mutateBotHierarchy,
  resolveUniqueBotFolderName,
  useBotHierarchy,
} from './botHierarchyClientStore';

export interface BotFolderSettingProps {
  bot: { id: string; name: string };
  remoteDeviceId?: string | null;
  isCloudCompanion?: boolean;
  className?: string;
}

function resolveTargetKeys(
  curr: BotHierarchyConfigV1,
  botId: string,
  remoteDeviceId?: string | null,
  isCloudCompanion?: boolean,
): string[] {
  const did = typeof remoteDeviceId === 'string' ? remoteDeviceId.trim() : '';
  if (!did) {
    const canonical = botHierarchyItemKey(botId);
    return canonical ? [canonical] : [];
  }
  const remoteKey = botHierarchyItemKey(botId, did);
  if (isCloudCompanion === false) {
    return remoteKey ? [remoteKey] : [];
  }
  const canonical = botHierarchyItemKey(botId);
  const keys: string[] = [];
  if (canonical) keys.push(canonical);
  if (remoteKey && Object.prototype.hasOwnProperty.call(curr.assignments ?? {}, remoteKey)) {
    keys.push(remoteKey);
  }
  return keys;
}

/** Companion settings row displaying and editing the buddy's folder group membership. */
export function BotFolderSetting({
  bot,
  remoteDeviceId = null,
  isCloudCompanion,
  className = 'mt-3',
}: BotFolderSettingProps) {
  const { t } = useTranslation();
  const { config } = useBotHierarchy();
  const folderOptions = flattenFolderOptions(config);
  const currentFolderId = resolveBotFolderId(config, bot.id, remoteDeviceId);
  const breadcrumb = currentFolderId ? getFolderBreadcrumb(config, currentFolderId) : [];
  const currentLabel =
    breadcrumb.length > 0
      ? breadcrumb.map((folder) => folder.name).join(' / ')
      : t('bots.hierarchy.ungrouped');

  const handleAssign = async (folderId: string | null) => {
    await mutateBotHierarchy((curr) => {
      const targetKeys = resolveTargetKeys(curr, bot.id, remoteDeviceId, isCloudCompanion);
      if (targetKeys.length === 0) return curr;
      return assignItemsToFolder(curr, targetKeys, folderId);
    });
  };

  const handleCreateAndMove = async () => {
    const baseName = t('bots.hierarchy.defaultFolderName');
    await mutateBotHierarchy((curr) => {
      const targetKeys = resolveTargetKeys(curr, bot.id, remoteDeviceId, isCloudCompanion);
      if (targetKeys.length === 0) return curr;
      const name = resolveUniqueBotFolderName(curr, baseName, null);
      const created = createBotFolder(curr, { name, parentId: null });
      return assignItemsToFolder(created.config, targetKeys, created.folder.id);
    });
  };

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="bot-folder-setting-row"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
            >
              <Folder size={18} className="shrink-0 text-[var(--text-secondary)]" />
              <span className="min-w-0 flex-1">{t('bots.hierarchy.folderSettingLabel')}</span>
              <span
                className="min-w-0 max-w-48 truncate text-13 text-[var(--text-secondary)]"
                title={currentLabel}
              >
                {currentLabel}
              </span>
              <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56 max-w-80">
            {folderOptions.length > 0 ? (
              <>
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
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onSelect={() => void handleCreateAndMove()}
            >
              <FolderPlus size={14} className="shrink-0 text-[var(--folder-item-icon)]" />
              <span className="truncate">{t('bots.hierarchy.createAndMove')}</span>
            </DropdownMenuItem>
            {currentFolderId !== null ? (
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => void handleAssign(null)}
              >
                <FolderMinus size={14} className="shrink-0" />
                <span className="truncate">{t('bots.hierarchy.moveOutOfFolder')}</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
