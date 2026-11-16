import { Folder, Users } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  botHierarchyItemKey,
  getItemFolderBreadcrumb,
  groupHierarchyItemKey,
} from '../../../shared/botHierarchy';
import { BotAvatar } from './BotAvatar';
import { useBotHierarchy } from './botHierarchyClientStore';
import { useBotGroupList } from './botGroupStore';
import { sortBotRoster } from './botRosterDisplay';
import { useBotProfiles } from './botStore';
import { useCompanionCloud } from './companionCloudStore';
import { cloudRemoteBots, withoutShadowedBots } from './companionCloudPresentation';
import { useRemoteBots } from './useRemoteBots';

export interface TeammateSearchMatch {
  key: string;
  kind: 'bot' | 'group';
  name: string;
  /** 已归档的群:段内不再列出,只能从这里找回。 */
  archived?: boolean;
  detail: string;
  /** 所在文件夹路径（从根到当前文件夹名），未分组为空或省略。 */
  breadcrumb?: readonly string[];
  route: string;
  avatar: Parameters<typeof BotAvatar>[0]['bot'] | null;
}

/**
 * 侧栏总搜索里的伙伴 / 群聊命中(2026-10-13:伙伴段不再有独立搜索框)。
 * 本机伙伴按名字、简介、技能与所在文件夹路径匹配,含已隐藏、不含已停止;
 * 远程伙伴按名字、简介、电脑名与所在文件夹路径;
 * 群聊按群名、成员名与所在文件夹路径,含已归档的群(段内不列出,在这里找回)。
 * 只读已有的名册投影,不发起额外查询。
 * 锁定任务分组时不搜索名册，避免组内搜索混入伙伴或群聊。
 */
export function useTeammateSearchMatches(
  rawQuery: string,
  lockedSessionGroupName: string | null,
): TeammateSearchMatch[] {
  const cloud = useCompanionCloud();
  const allBots = useBotProfiles();
  const rosterRemoteBots = useRemoteBots();
  const { config: hierarchyConfig } = useBotHierarchy();
  // 与伙伴段同一份名册:隐藏已交给别的电脑的本机副本,每个云端伙伴只在主力电脑上列一行。
  const bots = useMemo(() => withoutShadowedBots(allBots, cloud), [allBots, cloud]);
  const remoteBots = useMemo(() => cloudRemoteBots(cloud, rosterRemoteBots), [rosterRemoteBots, cloud]);
  const { groups } = useBotGroupList();
  const { t } = useTranslation();
  return useMemo(() => {
    const query = rawQuery.trim().toLocaleLowerCase();
    if (!query || lockedSessionGroupName !== null) return [];
    const includes = (...values: Array<string | null | undefined>) =>
      values.some((value) => Boolean(value) && value!.toLocaleLowerCase().includes(query));
    const breadcrumbNames = (itemKey: string): string[] =>
      getItemFolderBreadcrumb(hierarchyConfig, itemKey).map((folder) => folder.name);
    const breadcrumbTokens = (names: readonly string[]): string[] =>
      names.length > 0 ? [names.join(' / '), names.join('/'), ...names] : [];

    const local = sortBotRoster(bots.filter((bot) => bot.status !== 'archived'))
      .flatMap((bot): TeammateSearchMatch[] => {
        const breadcrumb = breadcrumbNames(botHierarchyItemKey(bot.id));
        if (!includes(bot.name, bot.description, ...(bot.skills ?? []), ...breadcrumbTokens(breadcrumb))) {
          return [];
        }
        return [{
          key: `bot:${bot.id}`,
          kind: 'bot',
          name: bot.name,
          detail: bot.description,
          ...(breadcrumb.length > 0 ? { breadcrumb } : {}),
          route: `/bots/${bot.id}`,
          avatar: bot,
        }];
      });

    const remote = remoteBots.flatMap((bot): TeammateSearchMatch[] => {
      const remoteKey = botHierarchyItemKey(bot.id, bot.deviceId);
      const hasRemoteAssignment = Boolean(
        remoteKey && Object.prototype.hasOwnProperty.call(hierarchyConfig.assignments ?? {}, remoteKey),
      );
      const breadcrumb = breadcrumbNames(
        hasRemoteAssignment ? remoteKey : botHierarchyItemKey(bot.id),
      );
      if (!includes(bot.name, bot.description, bot.deviceName, ...breadcrumbTokens(breadcrumb))) {
        return [];
      }
      return [{
        key: `remote:${bot.deviceId}:${bot.id}`,
        kind: 'bot',
        name: bot.name,
        detail: bot.deviceName,
        ...(breadcrumb.length > 0 ? { breadcrumb } : {}),
        route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
        avatar: bot,
      }];
    });

    const groupMatches = groups.flatMap((group): TeammateSearchMatch[] => {
      const breadcrumb = breadcrumbNames(groupHierarchyItemKey(group.id));
      if (!includes(group.name, ...group.members.map((member) => member.name), ...breadcrumbTokens(breadcrumb))) {
        return [];
      }
      return [{
        key: `group:${group.id}`,
        kind: 'group',
        name: group.name,
        archived: Boolean(group.archived),
        detail: group.members.map((member) => member.name).join(t('commonUi.listSeparator')),
        ...(breadcrumb.length > 0 ? { breadcrumb } : {}),
        route: `/bots/groups/${encodeURIComponent(group.id)}`,
        avatar: group.members[0] ?? null,
      }];
    });

    return [...local, ...remote, ...groupMatches];
  }, [bots, remoteBots, groups, hierarchyConfig, rawQuery, lockedSessionGroupName, t]);
}

/** 与会话结果行同几何(rounded-lg、px-3 py-2.5、20px 标记、13 号标题、类型小标签)。 */
export function TeammateSearchResults({
  matches,
  onSelected,
}: {
  matches: readonly TeammateSearchMatch[];
  /** 选中后的附加动作;内联展开态默认保留查询,便于连续点开。 */
  onSelected?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (matches.length === 0) return null;
  return (
    <div data-teammate-search-results>
      {matches.map((match) => {
        const breadcrumbText = match.breadcrumb && match.breadcrumb.length > 0
          ? match.breadcrumb.join(' / ')
          : '';
        return (
          <button
            key={match.key}
            type="button"
            onClick={() => {
              navigate(match.route);
              onSelected?.();
            }}
            className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[var(--cmd-palette-item-hover)]"
          >
            {match.avatar ? (
              <BotAvatar bot={match.avatar} size="xs" className="mt-0.5" />
            ) : (
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--cmd-palette-item-icon)]">
                <Users size={13} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">{match.name}</span>
                {match.archived ? (
                  <span className="shrink-0 text-10 leading-none text-[var(--text-tertiary)]">{t('bots.archived')}</span>
                ) : null}
                <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-10 leading-none text-[var(--text-tertiary)]">
                  {match.kind === 'group' ? t('bots.groupChat.sidebar.title') : t('bots.title')}
                </span>
              </span>
              {breadcrumbText ? (
                <span
                  data-teammate-breadcrumb
                  className="mt-1 flex min-w-0 items-center gap-1 text-11 leading-none text-[var(--text-tertiary)]"
                >
                  <Folder size={11} aria-hidden className="shrink-0" />
                  <span className="truncate">{breadcrumbText}</span>
                </span>
              ) : null}
              {match.detail ? (
                <span className="mt-1 block truncate text-11 leading-none text-[var(--text-tertiary)]">{match.detail}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
