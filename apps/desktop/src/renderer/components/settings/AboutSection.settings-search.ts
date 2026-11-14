import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const aboutSettings = defineSettings({
  about: {
    id: 'about',
    tab: 'about',
    targetId: 'settings-panel-about',
    titleKey: TAB_LABEL_KEY['about'],
    sectionKey: 'settings.sections.about',
  },
  appVersionLabel: {
    id: 'settings.about.appVersionLabel',
    isVisible: ({ region }) => region === 'cn',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-appVersionLabel',
    titleKey: 'settings.about.appVersionLabel',
    sectionKey: 'settings.tabs.about',
  },
  autoUpdateLabel: {
    id: 'settings.about.autoUpdateLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-autoUpdateLabel',
    titleKey: 'settings.about.privacyUpdateLabel',
    descriptionKey: 'settings.about.privacyUpdateDescription',
    aliases: ['自动更新', '手动更新', '应用更新', 'auto update', 'manual update'],
    sectionKey: 'settings.tabs.about',
  },
  debugLogLabel: {
    id: 'settings.about.debugLogLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-debugLogLabel',
    titleKey: 'settings.about.debugLogLabel',
    sectionKey: 'settings.tabs.about',
    descriptionKey: 'settings.about.debugLogDescription',
  },
  logsDirLabel: {
    id: 'settings.about.logsDirLabel',
    fallbackTargetId: 'settings-panel-about',
    tab: 'about',
    targetId: 'settings-search-settings-about-logsDirLabel',
    titleKey: 'settings.about.logsDirLabel',
    sectionKey: 'settings.tabs.about',
  },
});

export default {
  id: 'about',
  order: 16,
  entries: Object.values(aboutSettings),
} satisfies SettingsSearchModule;
