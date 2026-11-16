// @vitest-environment jsdom
import { useBotUnreadSync } from '../useBotUnreadSync';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => mocks.running } }));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });

vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: false }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => null,
}));

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { resolvedLanguage: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  observeSession: vi.fn(),
  profiles: [] as unknown[],
  running: new Map<string, { isRunning: boolean }>(),
  remoteBots: [] as import('../remoteBotRoster').RemoteBot[],
  devices: [] as Array<{ deviceId: string; name: string; isSelf: boolean }>,
  health: new Map<string, string>(),
  unread: {} as Record<string, number>,
  groupMessages: new Map<string, unknown[]>(),
  params: {} as { botId?: string; deviceId?: string },
  refreshBotProfiles: vi.fn(),
  setBotHidden: vi.fn(async () => undefined),
  setBotPinned: vi.fn(async () => undefined),
  duplicateBotProfile: vi.fn(async () => ({ id: 'copy' })),
  /** 灵动岛活动镜像:sessionId -> phase。侧栏据此显示「正在输入…」。 */
  islandActivity: new Map<string, { sessionId: string; phase: string; compactDetail?: string }>(),
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
}));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => mocks.cloud }));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => mocks.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivityMap: () => mocks.islandActivity,
}));
// The section must never observe session transitions: the task sidebar is the only
// notification owner (CCAgentSidebarUpper), also on /bots routes.
vi.mock('@/hooks/useSessionRunningStatus', () => ({
  useSessionRunningStatus: (sessionId: string | undefined) => {
    mocks.observeSession(sessionId);
    return ({
    runningSessionIds: new Set<string>(),
    notifications: new Set<string>(),
    clearNotification: vi.fn(),
    });
  },
}));

vi.mock('react-router-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-router-dom')>(),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: mocks.params.deviceId
    ? `/bots/remote/${mocks.params.deviceId}/${mocks.params.botId}`
    : mocks.params.botId ? `/bots/${mocks.params.botId}` : '/bots', search: '', hash: '' }),
}));
vi.mock('../botStore', () => ({
  getBotProfiles: () => mocks.profiles,
  useBotProfiles: () => mocks.profiles,
  useBotUnreadCounts: () => mocks.unread,
  refreshBotProfiles: mocks.refreshBotProfiles,
  setBotHidden: mocks.setBotHidden,
  setBotPinned: mocks.setBotPinned,
  duplicateBotProfile: mocks.duplicateBotProfile,
  canonicalBotSessionId: (bot: {
    sessions?: Array<{ id: string; role?: string; kind?: string }>;
  }) =>
    bot.sessions?.find((session) => session.role === 'canonical' || session.kind === 'chat')?.id,
}));
vi.mock('../BotDeleteDialog', () => ({
  BotDeleteDialog: ({ bot }: { bot: { name: string } | null }) =>
    bot ? <div data-testid="bot-delete-dialog">{bot.name}</div> : null,
}));

import { TeammatesSection } from '../TeammatesSection';
import { executeSmartOrganize } from '../TeammatesDisplayMenu';
import { BotConnectionStatus } from '../BotConnectionStatus';
import {
  getBotHierarchySnapshot,
  mutateBotHierarchy,
  resetBotHierarchyStoreForTests,
} from '../botHierarchyClientStore';
import { markBotRead, resetBotReadStateForTests } from '../botReadState';
import {
  readTeammatesCollapsedFolders,
  readTeammatesSectionCollapsed,
  writeTeammatesSectionCollapsed,
  writeTeammatesViewMode,
} from '../teammatesSectionPrefs';import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import {
  assignItemsToFolder,
  botHierarchyItemKey,
  createBotFolder,
  createEmptyBotHierarchyConfig,
  resolveItemFolderId,
} from '../../../../shared/botHierarchy';

interface BotFixture {
  id: string;
  name: string;
  description?: string;
  lastMessagePreview?: string | null;
  lastMessageAt?: number | null;
  needsAttention?: boolean;
}

function bot(fixture: BotFixture) {
  return {
    channel: 'local',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {},
    createdAt: 0,
    sessions: [{ id: `${fixture.id}-chat`, kind: 'chat' }],
    canonicalSessionId: `${fixture.id}-chat`,
    description: '',
    ...fixture,
  };
}

let messageListeners: Array<(payload: unknown) => void> = [];

async function renderSidebar() {
  const view = render(<TeammatesSection />);
  await waitFor(() => expect(view.container.querySelector('button')).not.toBeNull());
  return view;
}

beforeEach(() => {
  messageListeners = [];
  window.localStorage.clear();
  resetBotReadStateForTests();
  resetBotHierarchyStoreForTests();
  setDataOwnerGeneration('fixture-owner', 1);
  mocks.navigate.mockReset();
  mocks.observeSession.mockReset();
  mocks.refreshBotProfiles.mockReset();
  mocks.setBotHidden.mockReset();
  mocks.setBotPinned.mockReset();
  mocks.duplicateBotProfile.mockReset();
  mocks.setBotHidden.mockResolvedValue(undefined);
  mocks.setBotPinned.mockResolvedValue(undefined);
  mocks.duplicateBotProfile.mockResolvedValue({ id: 'copy' });
  mocks.health = new Map();
  mocks.unread = {};
  mocks.groupMessages = new Map();
  mocks.params = {};
  mocks.profiles = [];
  mocks.running = new Map();
  mocks.remoteBots = [];
  mocks.devices = [];
  mocks.islandActivity = new Map();
  mocks.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        messages: {
          list: vi.fn(async (sessionId: string) => mocks.groupMessages.get(sessionId) ?? []),
          onCreated: (cb: (payload: unknown) => void) => {
            messageListeners.push(cb);
            return () => {
              messageListeners = messageListeners.filter((entry) => entry !== cb);
            };
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('one Cindy entry across devices', () => {
  const remote = (deviceId: string, deviceName: string, extra = {}) => ({
    id: 'cindy-default', deviceId, deviceName, name: 'Cindy', avatar: '🤖', avatarColor: 'violet',
    description: '', preview: `${deviceName} preview`, activityAt: 1, sessionId: `${deviceId}-chat`, online: true, ...extra,
  });

  it('keeps the original local row and only offers switching while another Cindy exists', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    const view = await renderSidebar();
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    fireEvent.click(screen.getByText('Local preview').closest('button')!);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    view.rerender(<TeammatesSection />);
    expect(screen.getAllByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toHaveLength(1);
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByText('Local preview')).toBeTruthy();

    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(screen.getByText('Local preview')).toBeTruthy();
  });

  it('keeps the original remote row when it is the only Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud', { online: false })];
    await renderSidebar();
    expect(screen.queryByRole('combobox', { name: /bots.devicePicker.switchDevice/ })).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.getByText('bots.remote.offline · Cloud')).toBeTruthy();
    fireEvent.click(screen.getByText('Cloud preview').closest('button')!);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('defaults to local Cindy while leaving custom same-name teammates separate', async () => {
    mocks.profiles = [{ ...bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' }), templateId: 'cindy' }];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac'), { ...remote('other', 'Office'), id: 'custom', preview: 'Custom preview' }];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.getByText('Custom preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.queryByText('Mac preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');
  });

  it('follows the selected remote chat and returns to local when visiting another teammate', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Renamed Cindy', lastMessagePreview: 'Local preview' }), bot({ id: 'writer', name: 'Writer' })];
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    const trigger = screen.getByRole('combobox', { name: /bots.devicePicker.switchDevice/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const cloud = await screen.findByRole('option', { name: /Cloud/ });
    fireEvent.click(cloud);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
    mocks.params = { deviceId: 'cloud', botId: 'cindy-default' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Cloud preview')).toBeTruthy();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cindy · Cloud' }).getAttribute('aria-current')).toBe('page');
    mocks.params = { botId: 'writer' };
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    const localEntry = screen.getByRole('button', { name: 'Renamed Cindy · bots.devicePicker.local' });
    expect(localEntry.hasAttribute('aria-current')).toBe(false);
    fireEvent.click(localEntry);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/cindy-default');
  });

  it.each([
    { generation: { phase: 'processing' as const, startedAt: 1 } },
    { teammateActivity: { phase: 'running' as const } },
  ])('shows another computer working without a duplicate running dot: %j', async (running) => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', running)];
    const view = await renderSidebar();
    const row = screen.getByTestId('cindy-device-row');
    expect(row.textContent).toContain('Cloud · ');
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(row.querySelector('[data-teammate-status="running"]')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview] .session-status-breathing')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/cindy-default');

    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('ccAgent.agentStatus.processing')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview]')).toBeNull();
  });

  // The selected remote Cindy can retain only its running snapshot after refresh.
  // Other-computer coverage does not exercise this current-row fallback (unit).
  it('keeps selected remote work visible with only a running snapshot', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { teammateActivity: { phase: 'running' } })];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.getByTestId('cindy-device-row').querySelector('[data-teammate-status="running"]')).toBeNull();
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Cloud preview')).toBeTruthy();
  });

  it('shows local work while the selected remote computer is idle', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    mocks.islandActivity.set('cindy-default-chat', { sessionId: 'cindy-default-chat', phase: 'running' });
    await renderSidebar();
    expect(screen.getByTestId('cindy-device-row').textContent).toContain('bots.devicePicker.local · ');
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy · Cloud' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default');
  });

  it('keeps the current computer summary when both computers are working', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { generation: { phase: 'thinking', startedAt: 1 } })];
    mocks.islandActivity.set('cindy-default-chat', { sessionId: 'cindy-default-chat', phase: 'running' });
    await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.getByTestId('cindy-device-row').textContent).not.toContain('Cloud · ');
    expect(screen.queryByText('ccAgent.agentStatus.thinking')).toBeNull();
  });

  it('keeps remote unread discoverable without opening the chat or switching away from local', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy' })];
    mocks.remoteBots = [remote('cloud', 'Cloud', { lastReplyAt: 20, readAt: 10, online: false })];
    await renderSidebar();
    expect(screen.getByLabelText('bots.devicePicker.otherUnread')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: /bots.devicePicker.switchDevice/ }), { key: 'ArrowDown' });
    const cloud = await screen.findByRole('option', { name: /Cloud/ });
    expect(cloud.textContent).toContain('bots.remote.offline');
    expect(cloud.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByLabelText('bots.devicePicker.unread')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('prefers local Cindy when local profiles arrive after the remote roster', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    const view = await renderSidebar();
    expect(screen.getByText('Cloud preview')).toBeTruthy();

    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(screen.queryByText('Cloud preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cindy · bots.devicePicker.local' })).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('follows a remote deep link and falls back to local if that device is removed', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [remote('cloud', 'Cloud')];
    mocks.params = { botId: 'cindy-default', deviceId: 'cloud' };
    const view = await renderSidebar();
    expect(screen.getByText('Cloud preview')).toBeTruthy();
    mocks.remoteBots = [];
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Local preview')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('offers a remote-only group without recreating a deleted local Cindy', async () => {
    mocks.remoteBots = [remote('cloud', 'Cloud'), remote('mac', 'Mac')];
    await renderSidebar();
    expect(screen.getAllByTestId('cindy-device-row')).toHaveLength(1);
    expect(screen.queryByText('bots.devicePicker.local')).toBeNull();
    expect(screen.getByText('Cloud preview')).toBeTruthy();
  });
});

describe('teammate host labels', () => {
  // PR #8714: after a resource refresh fails, the remote activity snapshot remains
  // running without generation details. The real row must still show work, then
  // restore its message after completion (unit; prior cases only cover merged Cindy).
  it('keeps standalone remote work visible when only the running snapshot remains', async () => {
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'studio', deviceName: 'Studio',
      name: 'Writer', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Previous reply',
      activityAt: 1, sessionId: 'remote-session', online: true,
      teammateActivity: { phase: 'running' } }];
    const view = await renderSidebar();
    const working = screen.getByText('ccAgent.agentStatus.processing');
    const row = working.closest('button')!;
    expect(screen.queryByText('Previous reply')).toBeNull();
    expect(row.querySelector('[data-teammate-status="running"]')).toBeNull();
    expect(row.querySelector('[data-teammate-running-preview] .session-status-breathing')).not.toBeNull();
    fireEvent.click(row);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/studio/remote-bot');
    mocks.remoteBots = mocks.remoteBots.map(bot => ({ ...bot, teammateActivity: { phase: 'idle' } }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Previous reply')).toBeTruthy();
    expect(screen.queryByText('ccAgent.agentStatus.processing')).toBeNull();
  });

  it('shows only the remote device for same-name teammates and preserves remote routing', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'MBP-M5', isSelf: true }];
    mocks.remoteBots = [{ id: 'remote-bot', deviceId: 'remote-device', deviceName: 'Mac-Studio',
      name: 'Cindy', avatar: '🤖', avatarColor: 'violet', description: '', preview: 'Remote preview',
      activityAt: 1, sessionId: 'remote-session', online: true }];
    const view = await renderSidebar();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('MBP-M5');
    expect(screen.queryByRole('img', { name: /bots.remote.online/ })).toBeNull();
    expect(screen.getByText('Mac-Studio')).toBeTruthy();
    expect(screen.getByText('Local preview')).toBeTruthy();
    const remoteRow = screen.getByText('Remote preview').closest('button')!;
    fireEvent.click(remoteRow);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/remote-device/remote-bot');

    mocks.remoteBots = mocks.remoteBots.map((bot) => ({ ...bot, online: false, deviceName: ' ' }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('bots.remote.offline · another computer')).toBeTruthy();
    expect(screen.queryByText('bots.remote.offline · bots.remote.thisDevice')).toBeNull();
  });

  it('keeps local status free of device labels before and after directory updates', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    const view = await renderSidebar();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('bots.remote.thisDevice');
    expect(view.container.textContent).not.toContain(' · ');
    mocks.devices = [{ deviceId: 'local-device', name: 'Renamed Mac', isSelf: true }];
    view.rerender(<TeammatesSection />);
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('Renamed Mac');
    expect(view.container.textContent).not.toContain(' · ');
  });

  it('disambiguates remote devices and updates their names without exposing the local host', async () => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'Shared Mac', isSelf: true }];
    mocks.remoteBots = ['host-a', 'host-b'].map((deviceId) => ({
      id: 'remote-bot', deviceId, deviceName: 'Shared Mac', name: 'Cindy',
      avatar: '🤖', avatarColor: 'violet', description: '', preview: '',
      activityAt: 1, sessionId: 'remote-session', online: true,
    }));
    const view = await renderSidebar();
    expect(screen.getByText('Shared Mac (1)')).toBeTruthy();
    expect(screen.getByText('Shared Mac (2)')).toBeTruthy();
    expect(view.container.innerHTML).not.toContain('local-device');
    mocks.remoteBots = mocks.remoteBots.map((entry) => ({ ...entry, deviceName: entry.deviceId === 'host-a' ? 'Studio' : 'Mini' }));
    view.rerender(<TeammatesSection />);
    expect(screen.getByText('Studio')).toBeTruthy();
    expect(screen.getByText('Mini')).toBeTruthy();
  });

  it.each(['Thinking', 'Generating'])('preserves %s while hiding the local host and idle status', async (compactDetail) => {
    mocks.profiles = [bot({ id: 'local-bot', name: 'Cindy', lastMessagePreview: 'Previous reply' })];
    mocks.devices = [{ deviceId: 'local-device', name: 'MBP-M5', isSelf: true }];
    mocks.islandActivity.set('local-bot-chat', { sessionId: 'local-bot-chat', phase: 'running', compactDetail });
    const view = await renderSidebar();
    expect(screen.queryByText(compactDetail)).toBeNull();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(view.container.innerHTML).not.toContain('MBP-M5');
    expect(view.container.innerHTML).not.toContain('bots.remote.thisDevice');
    expect(view.container.textContent).not.toContain(' · ');
    expect(screen.queryByText('Previous reply')).toBeNull();
    mocks.islandActivity.clear();
    view.rerender(<TeammatesSection />);
    expect(screen.queryByText(compactDetail)).toBeNull();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
    expect(screen.getByText('Previous reply')).toBeTruthy();
  });

  it('retains delegated work and the existing typing fallback when detail is absent', async () => {
    mocks.profiles = [{ ...bot({ id: 'local-bot', name: 'Cindy' }), sessions: [
      { id: 'local-bot-chat', kind: 'chat' }, { id: 'delegated', kind: 'task' },
    ] }];
    mocks.islandActivity.set('delegated', { sessionId: 'delegated', phase: 'running', compactDetail: ' ' });
    await renderSidebar();
    expect(screen.getByText('ccAgent.agentStatus.processing')).toBeTruthy();
    expect(screen.queryByText('bots.remote.online')).toBeNull();
  });

  it('keeps offline status without a device name or a dangling separator', () => {
    render(<BotConnectionStatus inline online={false} deviceName=" " />);
    expect(screen.getByText('bots.remote.offline').getAttribute('title')).toBe('bots.remote.offline');
  });

});

describe('TeammatesSection header', () => {
  const header = () => screen.getByRole('button', { name: 'bots.title' });

  // New collapse contract: ordinary chats disappear, unread and pending feedback survive
  // beyond the five-row preview, then disappear when resolved (real component, unit tier).
  it('collapses fully while retaining unread and pending feedback across remounts', async () => {
    mocks.profiles = [bot({ id: 'idle', name: 'Idle' }), bot({ id: 'unread', name: 'Unread' }), bot({ id: 'waiting', name: 'Waiting' })];
    mocks.unread = { unread: 1 };
    mocks.islandActivity = new Map([['waiting-chat', { sessionId: 'waiting-chat', phase: 'needs-interaction' }]]);
    const view = await renderSidebar();
    fireEvent.click(header());
    expect(screen.queryByText('Idle')).toBeNull();
    expect(screen.getByText('Unread')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(readTeammatesSectionCollapsed('fixture-owner')).toBe(true);
    mocks.unread = {};
    mocks.islandActivity = new Map();
    view.rerender(<TeammatesSection />);
    await waitFor(() => expect(screen.queryByText('Waiting')).toBeNull());
    cleanup();
    await renderSidebar();
    expect(screen.queryByText('Idle')).toBeNull();
    fireEvent.click(header());
    expect(screen.getByText('Idle')).toBeTruthy();
  });

  // Regression: reading the open chat must not remove its navigation target.
  // Existing collapse coverage only checks unselected chats. Unit: clear unread
  // while selected, then switch route; exercise both production presentations.
  it.each(['list', 'icons'] as const)('keeps the read chat until navigation leaves it in %s mode', async (mode) => {
    mocks.profiles = [bot({ id: 'reader', name: 'Reader' }), bot({ id: 'other', name: 'Other' })];
    mocks.unread = { reader: 1 };
    mocks.params = { botId: 'reader' };
    writeTeammatesViewMode('fixture-owner', mode);
    const view = await renderSidebar();
    fireEvent.click(header());
    const reader = () => mode === 'icons'
      ? screen.queryByRole('button', { name: /^Reader(?: ·|$)/ })
      : screen.queryByText('Reader');
    expect(reader()).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(reader()).not.toBeNull();
    // Explicitly expand and collapse while still selected: the read row must hide.
    fireEvent.click(header());
    fireEvent.click(header());
    await waitFor(() => expect(reader()).toBeNull());
    // A new unread event restores the row and its read-until-leaving protection.
    mocks.unread = { reader: 1 };
    view.rerender(<TeammatesSection />);
    expect(reader()).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(reader()).not.toBeNull();
    mocks.params = { botId: 'other' };
    view.rerender(<TeammatesSection />);
    expect(reader()).toBeNull();
    // Leaving a still-pending chat must not hide its request for feedback.
    mocks.params = { botId: 'reader' };
    mocks.islandActivity = new Map([['reader-chat', { sessionId: 'reader-chat', phase: 'needs-interaction' }]]);
    view.rerender(<TeammatesSection />);
    mocks.params = { botId: 'other' };
    view.rerender(<TeammatesSection />);
    expect(reader()).not.toBeNull();
  });

  it('keeps the icon row on one line and folds the rest into +N', async () => {
    const original = globalThis.ResizeObserver;
    // 5 slots: 4 avatars + the +N chip (40px target, 4px gap).
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 216 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.profiles = Array.from({ length: 6 }, (_, index) => bot({ id: `bot-${index}`, name: `Mate ${index}` }));
      mocks.unread = { 'bot-5': 1 };
      mocks.params = { botId: 'bot-4' };
      writeTeammatesViewMode('fixture-owner', 'icons');
      await renderSidebar();
      const avatars = screen.getAllByRole('button', { name: /^Mate \d$/ });
      expect(avatars).toHaveLength(4);
      // The open chat keeps a slot even when it sorts past the cut.
      expect(screen.getByRole('button', { name: 'Mate 4' }).getAttribute('aria-current')).toBe('page');
      const more = screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' });
      fireEvent.click(more);
      expect(header().getAttribute('aria-expanded')).toBe('true');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  // Unit regression: the real section must measure each newly mounted icon row.
  // Existing capacity coverage starts with a mounted row; six read buddies and an
  // initially collapsed section reproduce the missing +N entry after expansion.
  it('measures icon rows after empty states and list-mode remounts', async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 216 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.profiles = Array.from({ length: 6 }, (_, index) => bot({ id: `bot-${index}`, name: `Mate ${index}` }));
      writeTeammatesViewMode('fixture-owner', 'icons');
      writeTeammatesSectionCollapsed('fixture-owner', true);
      const view = await renderSidebar();
      expect(screen.queryByRole('button', { name: 'Mate 0' })).toBeNull();
      fireEvent.click(header());
      expect(screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' })).not.toBeNull();
      // +N replaces the icon row with the list; switching back must measure again.
      fireEvent.click(screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' }));
      fireEvent.keyDown(screen.getByRole('button', { name: 'ccAgent.sidebar.viewStyle' }), { key: 'Enter' });
      fireEvent.click(screen.getByRole('menuitem', { name: 'bots.list.viewIcons' }));
      expect(screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' })).not.toBeNull();
      // The roster can also become empty and return without changing view mode.
      mocks.profiles = [];
      view.rerender(<TeammatesSection />);
      mocks.profiles = Array.from({ length: 6 }, (_, index) => bot({ id: `bot-${index}`, name: `Mate ${index}` }));
      view.rerender(<TeammatesSection />);
      expect(screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' })).not.toBeNull();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('marks the open chat in icon mode', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' }), bot({ id: 'bot-2', name: 'Writer' })];
    mocks.unread = { 'bot-1': 2 };
    mocks.params = { botId: 'bot-1' };
    writeTeammatesViewMode('fixture-owner', 'icons');
    await renderSidebar();
    // Routing alone does not acknowledge a reply; the existing read receipt owns clearing.
    expect(screen.getByRole('button', { name: 'PR steward · bots.avatarStatus.unread' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Writer' }).hasAttribute('aria-current')).toBe(false);
  });

  it('keeps a completed unread reply green after the live snapshot is removed, then clears on read', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), lastMessageRole: 'assistant' }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }]]);
    const view = await renderSidebar();
    expect(view.container.querySelector('[data-teammate-status="done"]')).not.toBeNull();
    // Idle is represented by no activity entry, not an AgentIslandSessionPhase.
    mocks.islandActivity = new Map();
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status="done"]')).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status]')).toBeNull();
  });

  it('keeps a pending decision ahead of an error like the shared resolver, even after read acknowledgement', async () => {
    mocks.profiles = [{ ...bot({ id: 'bot-1', name: 'Writer' }), needsAttention: true }];
    mocks.unread = { 'bot-1': 1 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'needs-interaction' }]]);
    const view = await renderSidebar();
    expect(view.container.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
    mocks.unread = {};
    view.rerender(<TeammatesSection />);
    expect(view.container.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
    expect(view.container.querySelector('[data-teammate-status="error"]')).toBeNull();
  });

  it('keeps pending attention ahead of errors in the icon overflow', async () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([{ contentRect: { width: 48 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      mocks.profiles = [bot({ id: 'waiting', name: 'Waiting' }), bot({ id: 'failed', name: 'Failed', needsAttention: true })];
      mocks.islandActivity = new Map([['waiting-chat', { sessionId: 'waiting-chat', phase: 'needs-interaction' }]]);
      writeTeammatesViewMode('fixture-owner', 'icons');
      await renderSidebar();
      const overflow = screen.getByRole('button', { name: 'bots.list.sectionExpand · +2' });
      expect(overflow.querySelector('[data-teammate-status="awaiting"]')).not.toBeNull();
      expect(overflow.querySelector('[data-teammate-status="error"]')).toBeNull();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('leaves session notifications to the task sidebar', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.params = { botId: 'bot-1' };
    await renderSidebar();
    expect(mocks.observeSession).not.toHaveBeenCalled();
  });
});

describe('TeammatesSection 「正在输入…」', () => {
  it('回合进行中时第二行让位给「正在输入…」', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    const view = await renderSidebar();

    expect(view.container.textContent).toContain('ccAgent.agentStatus.processing');
    // 进行中时不再同时挂上一句说过什么 —— 这一行只回答「TA 现在怎么样」。
    expect(view.container.textContent).not.toContain('Two checks are still red');
  });

  it('回合结束后落回最新消息预览,不留痕', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: Date.now(),
      }),
    ];
    // completed 不是 running:同一份镜像里的终态不该继续显示「正在输入…」。
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'completed' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('ccAgent.agentStatus.processing');
    expect(view.container.textContent).toContain('Two checks are still red on #2829');
  });

  it('只认这个伙伴自己的主任务 —— 别人的会话在跑不该点亮这一行', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward', description: 'Delivery steward' })];
    mocks.islandActivity = new Map([
      ['someone-else', { sessionId: 'someone-else', phase: 'running' }],
    ]);
    const view = await renderSidebar();

    expect(view.container.textContent).not.toContain('ccAgent.agentStatus.processing');
    expect(view.container.textContent).toContain('Delivery steward');
  });

  it('uses the same orange breathing indicator as groups while running', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.unread = { 'bot-1': 4 };
    mocks.islandActivity = new Map([['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }]]);
    await renderSidebar();

    const line = screen.getByText('ccAgent.agentStatus.processing').closest('[data-teammate-running-preview]') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.className).toContain('text-[var(--status-bar-accent)]');
    expect(line.querySelector('.session-status-breathing svg')).not.toBeNull();
    expect(line.closest('.italic')).toBeNull();
  });
});

function UnreadSync() { useBotUnreadSync(); return null; }

describe('TeammatesSection rows', () => {
  it('shows durable Hermes attention without reviving the permissions badge', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Needs help', needsAttention: true })];

    await renderSidebar();

    expect(screen.getByLabelText('bots.avatarStatus.error')).toBeTruthy();
  });
  it('does not duplicate recent Bots in a separate Active now area', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Active steward', lastMessageAt: Date.now() })];

    await renderSidebar();

    expect(screen.queryByLabelText('bots.list.activeNow')).toBeNull();
    expect(screen.getAllByText('Active steward')).toHaveLength(1);
  });

  it('keeps hidden Bots out of the list without a section search box', async () => {
    mocks.profiles = [
      bot({ id: 'visible', name: 'Visible' }),
      { ...bot({ id: 'hidden', name: 'Hidden release steward' }), hiddenAt: 2 },
      { ...bot({ id: 'other', name: 'Other hidden' }), hiddenAt: 3 },
      bot({ id: 'v2', name: 'V2' }),
      bot({ id: 'v3', name: 'V3' }),
      bot({ id: 'v4', name: 'V4' }),
      bot({ id: 'v5', name: 'V5' }),
      bot({ id: 'v6', name: 'V6' }),
    ];

    await renderSidebar();
    // Search moved to the sidebar-wide search (teammateSearchResults.test); the section
    // keeps hidden teammates out of the list and offers no search box of its own.
    expect(screen.queryByText('Hidden release steward')).toBeNull();
    expect(screen.queryByLabelText('bots.list.search')).toBeNull();
  });

  it('shows the latest message and its time instead of a channel label', async () => {
    const at = new Date(Date.now() - 5 * 60_000);
    mocks.profiles = [
      bot({
        id: 'bot-1',
        name: 'PR steward',
        description: 'Delivery steward',
        lastMessagePreview: 'Two checks are still red on #2829',
        lastMessageAt: at.getTime(),
      }),
    ];

    const view = await renderSidebar();

    expect(screen.getByText('Two checks are still red on #2829')).toBeTruthy();
    expect(screen.getByText(translate('ccAgent.time.relative.minute', { count: 5 }))).toBeTruthy();
    expect(view.container.textContent).not.toContain('Local');
    expect(screen.queryByText('Delivery steward')).toBeNull();
  });

  it('falls back to the description and then to the start-chat prompt', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'With description', description: 'Delivery steward' }),
      bot({ id: 'bot-2', name: 'Brand new' }),
    ];

    await renderSidebar();

    expect(screen.getByText('Delivery steward')).toBeTruthy();
    expect(screen.getByText('bots.list.startChat')).toBeTruthy();
  });

  it('never marks a row with the hands-on ⚠ badge', async () => {
    mocks.profiles = [
      bot({ id: 'bot-asks', name: 'Asks first' }),
      { ...bot({ id: 'bot-trusted', name: 'Hands on' }), capabilities: { permissions: 'trusted' } },
    ];

    await renderSidebar();

    // 产品裁决 2026-08-18:伙伴列表是聊天列表,不是权限看板。
    // 2026-08-19:BotTrustedBadge 与 bots.trustedBadge.* 已删除,所以改查 ⚠
    // 图标本身 —— 按已不存在的 i18n key 断言等于没有守卫。
    expect(document.querySelector('.lucide-triangle-alert')).toBeNull();
  });

  it('carries no health icon column at all — a chat row answers "any new messages", nothing else', async () => {
    mocks.profiles = [
      bot({ id: 'bot-healthy', name: 'Healthy' }),
      bot({ id: 'bot-attention', name: 'Attention' }),
    ];
    mocks.health.set('bot-attention', 'attention');

    await renderSidebar();

    // 一行右侧同时挂「未读数 + 待办点 + 状态图标」时三处右对齐元素互相抢注意力。
    // 异常态另有出口:待办点(收件箱)与 TA 的设置页「健康与历史」。
    await waitFor(() => expect(screen.getByText('Attention')).toBeTruthy());
    for (const status of ['attention', 'recovering', 'paused', 'healthy']) {
      expect(screen.queryByLabelText(`bots.lifecycle.healthStatus.${status}`)).toBeNull();
    }
  });

  it('uses a green unread point without an inverse selection color', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Busy' })];
    mocks.unread = { 'bot-1': 2 };
    const view = await renderSidebar();
    const point = view.container.querySelector('[data-teammate-status="unread"] > span') as HTMLElement;
    expect(point.style.backgroundColor).toBe('var(--card-status-done)');
    expect(point.closest('[data-teammate-row-status]')).not.toBeNull();
    expect(view.container.querySelector('[data-teammate-status]')?.textContent).toBe('');
  });

  it('keeps settings and import out of each row while the row itself opens chat', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();

    // 进设置的入口收敛到对话顶栏;导入下沉到创建面板与「设置 › 伙伴」。
    expect(screen.queryByRole('button', { name: 'bots.settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.portability.import' })).toBeNull();

    fireEvent.click(screen.getByText('PR steward'));
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-1');
  });

  it('keeps legacy stopped Bots reachable for deletion without presenting archive or restore', async () => {
    mocks.profiles = [
      { ...bot({ id: 'legacy-stopped', name: 'Legacy stopped' }), status: 'archived' },
    ];

    await renderSidebar();

    expect(screen.getByText('bots.lifecycle.stoppedBots')).toBeTruthy();
    expect(screen.queryByText('bots.lifecycle.archivedBots')).toBeNull();
    fireEvent.click(screen.getByText('Legacy stopped'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/legacy-stopped?settings=1');
  });

  it('keeps the row management menu open after a right click', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    await renderSidebar();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    fireEvent.mouseOver(screen.getByText('PR steward'));
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeNull();
    expect(screen.queryByTestId('bot-delete-dialog')).toBeNull();

    fireEvent.contextMenu(screen.getAllByText('PR steward')[0]);

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.hide' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.list.duplicate' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'bots.lifecycle.delete' }));
    expect(screen.getByTestId('bot-delete-dialog').textContent).toBe('PR steward');
  });

  it('shows a single unread point for unread Bots regardless of count', async () => {
    mocks.profiles = [
      bot({ id: 'bot-read', name: 'Read', lastMessagePreview: 'Nothing new' }),
      bot({ id: 'bot-unread', name: 'Unread', lastMessagePreview: 'Fresh reply' }),
      bot({ id: 'bot-flooded', name: 'Flooded', lastMessagePreview: 'Many replies' }),
    ];
    mocks.unread = { 'bot-unread': 3, 'bot-flooded': 100 };

    await renderSidebar();

    expect(screen.getAllByLabelText('bots.avatarStatus.unread')).toHaveLength(2);
    expect(screen.queryByText('99+')).toBeNull();
    // A read Bot carries no badge at all — zero must never render as "0".
    expect(screen.queryByLabelText('bots.list.unread:{"count":0}')).toBeNull();
    expect(screen.getByText('Nothing new').className).not.toContain('font-medium');
    expect(screen.getByText('Fresh reply').className).not.toContain('font-medium');
    expect(screen.getAllByLabelText('bots.avatarStatus.unread').every(point => point.textContent === '')).toBe(true);
    expect(screen.getByText('Read').className).not.toContain('font-medium');
    expect(screen.getByText('Unread').className).toContain('font-medium');
  });

  it.each([
    { button: 2, ctrlKey: false },
    { button: 0, ctrlKey: true },
    { button: 0, ctrlKey: false },
  ])('does not select Pin on the opening release ($button / ctrl=$ctrlKey)', async (pointer) => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    fireEvent.contextMenu(screen.getByText('PR steward'), { clientX: 120, clientY: 180 });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });

    // On macOS the context menu can open before the original button is released.
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, cancelable: true, ...pointer }));
    if (pointer.button !== 0 || pointer.ctrlKey) fireEvent.click(pin, pointer);
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();

    fireEvent(pin, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(pin, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(pin);
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
  });

  it('supports keyboard selection and restores row focus when dismissed', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    await renderSidebar();
    const row = screen.getByText('PR steward').closest('button')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const pin = await screen.findByRole('menuitem', { name: 'bots.list.pin' });
    expect(mocks.setBotPinned).not.toHaveBeenCalled();
    fireEvent.keyDown(pin, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.keyDown(row, { key: 'ContextMenu' });
    fireEvent.keyDown(await screen.findByRole('menuitem', { name: 'bots.list.pin' }), { key: 'Enter' });
    expect(mocks.setBotPinned).toHaveBeenCalledExactlyOnceWith('bot-1', true);
  });

  it('re-reads the list when a Bot conversation is marked read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<><UnreadSync /><TeammatesSection /></>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));
    mocks.refreshBotProfiles.mockClear();

    act(() => {
      markBotRead('bot-1', 1_000);
      markBotRead('bot-1', 2_000);
      vi.advanceTimersByTime(2000);
    });
    // Debounced the same way as the message feed: one refresh per burst.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  // Regression / unit: the real sync hook must publish the new preview even if
  // an older list read replaces profiles during the 120 ms refresh window.
  // The ordinary message test below never replaced the profile array mid-burst.
  it('keeps a pending message refresh when an older list response replaces profiles', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Old reply' });
    mocks.profiles = [old];
    const view = render(<><UnreadSync /><TeammatesSection /></>);
    mocks.refreshBotProfiles.mockImplementation(() => {
      mocks.profiles = [{ ...old, lastMessagePreview: 'New reply' }];
    });

    act(() => { for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' }); });
    mocks.profiles = [{ ...old }];
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('Old reply')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(120); });
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('New reply')).toBeTruthy();
    expect(screen.queryByText('Old reply')).toBeNull();
  });

  // Regression / unit: message + read receipts previously owned separate timers,
  // so one visible update caused two list reads. Internal tool rows need neither.
  it('coalesces read and message updates and ignores tool activity', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    mocks.running = new Map([['bot-1-chat', { isRunning: true }]]);
    render(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const role of ['tool_use', 'tool_result', 'thinking']) {
        for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role } });
      }
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'assistant' } });
      markBotRead('bot-1', 2_000);
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  // Unit regression: final-seal and message events previously used independent
  // refresh paths. The displayed final preview must update once for their burst.
  it('coalesces a turn stop with its final message and still accepts late tool rows', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const old = bot({ id: 'bot-1', name: 'PR steward', lastMessagePreview: 'Old reply' });
    mocks.profiles = [old];
    mocks.running = new Map([['bot-1-chat', { isRunning: true }]]);
    const view = render(<><UnreadSync /><TeammatesSection /></>);
    mocks.refreshBotProfiles.mockImplementation(() => {
      mocks.profiles = [{ ...old, lastMessagePreview: 'Sealed reply' }];
    });
    mocks.refreshBotProfiles.mockClear();
    mocks.running = new Map();
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'assistant' } });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
    view.rerender(<><UnreadSync /><TeammatesSection /></>);
    expect(screen.getByText('Sealed reply')).toBeTruthy();

    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat', message: { role: 'tool_result' } });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });

  it('uses current session membership and drops pending refreshes after an owner change or unmount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];
    const view = render(<UnreadSync />);
    mocks.profiles = [bot({ id: 'bot-2', name: "New buddy" })];
    view.rerender(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-2-chat' });
      // Owner publication precedes React's render/cleanup during account switches.
      setDataOwnerGeneration('next-owner', 2);
      vi.advanceTimersByTime(120);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    view.rerender(<UnreadSync />);
    mocks.refreshBotProfiles.mockClear();
    act(() => { for (const listener of messageListeners) listener({ sessionId: 'bot-2-chat' }); });
    view.unmount();
    act(() => { vi.advanceTimersByTime(120); });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();
    expect(messageListeners).toHaveLength(0);
  });

  it('refreshes the list when a message lands in a Bot task, and ignores other tasks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.profiles = [bot({ id: 'bot-1', name: 'PR steward' })];

    render(<><UnreadSync /><TeammatesSection /></>);
    await vi.waitFor(() => expect(messageListeners.length).toBe(1));

    mocks.refreshBotProfiles.mockClear();
    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'some-other-session' });
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.refreshBotProfiles).not.toHaveBeenCalled();

    act(() => {
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      for (const listener of messageListeners) listener({ sessionId: 'bot-1-chat' });
      vi.advanceTimersByTime(2000);
    });
    // Debounced: a burst of rows from one turn triggers a single refresh.
    expect(mocks.refreshBotProfiles).toHaveBeenCalledTimes(1);
  });
});

describe('cloud companions in the roster', () => {
  it('hides demoted local copies and lists companions homed on a computer never seen here', async () => {
    mocks.profiles = [bot({ id: 'mia', name: 'Mia' }), bot({ id: 'ada', name: 'Ada' })];
    mocks.cloud = {
      enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['mia'],
      actors: [
        { id: 'a-mia', externalId: 'mia', name: 'Mia', avatar: null, homeDeviceId: 'laptop',
          homeDevice: { deviceId: 'laptop', name: 'Laptop', online: false, isSelf: false } },
        { id: 'a-ada', externalId: 'ada', name: 'Ada', avatar: null, homeDeviceId: 'desk' },
      ],
    };
    await renderSidebar();
    expect(screen.getByText('Ada')).toBeTruthy();
    const rows = screen.getAllByText('Mia');
    expect(rows).toHaveLength(1);
    const row = rows[0]!.closest('button')!;
    expect(row.textContent).not.toContain('bots.remote.offline');
    fireEvent.click(row);
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/laptop/mia');
  });

  it('does not offer a demoted local Cindy as the local option', async () => {
    mocks.profiles = [bot({ id: 'cindy-default', name: 'Cindy', lastMessagePreview: 'Local preview' })];
    mocks.remoteBots = [{ id: 'cindy-default', deviceId: 'laptop', deviceName: 'Laptop', name: 'Cindy', avatar: '🤖',
      avatarColor: 'violet', description: '', preview: 'Laptop preview', activityAt: 1, sessionId: 'laptop-chat', online: true }];
    mocks.cloud = { enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: ['cindy-default'],
      actors: [{ id: 'a-cindy', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'laptop' }] };
    await renderSidebar();
    expect(screen.queryByText('Local preview')).toBeNull();
    expect(screen.queryByTestId('cindy-device-row')).toBeNull();
    expect(screen.getByText('Laptop preview')).toBeTruthy();
  });
});

describe('botHierarchyClientStore IPC & fallback', () => {
  it('hydrates from electronAPI, persists writes, reacts to push updates, and resets cleanly', async () => {
    const pushListeners: Array<(payload: unknown, stamp?: unknown) => void> = [];
    const base = createBotFolder(createEmptyBotHierarchyConfig(), {
      id: 'f-ipc',
      name: 'Synced Team',
    }).config;
    const remote = createBotFolder(base, {
      id: 'f-push',
      name: 'Pushed Folder',
    }).config;

    const getMock = vi.fn(async () => ({ ownerId: 'fixture-owner', config: base }));
    const writeMock = vi.fn(async (body: { config: typeof base }) => ({
      ownerId: 'fixture-owner',
      config: body.config,
    }));

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI,
        localDb: {
          ...((window as unknown as { electronAPI: { localDb: Record<string, unknown> } }).electronAPI
            .localDb),
          bots: {
            hierarchy: {
              get: getMock,
              write: writeMock,
              sync: vi.fn(async () => ({ ownerId: 'fixture-owner', config: base })),
              onChanged: (cb: (payload: unknown, stamp?: unknown) => void) => {
                pushListeners.push(cb);
                return () => {};
              },
            },
          },
        },
      },
    });

    mocks.profiles = [bot({ id: 'bot-1', name: 'Alpha' })];
    await renderSidebar();

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Synced Team')).toBeTruthy();
    });

    await act(async () => {
      await mutateBotHierarchy((curr) => assignItemsToFolder(curr, ['bot:bot-1'], 'f-ipc'));
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(resolveItemFolderId(getBotHierarchySnapshot().config, 'bot:bot-1')).toBe('f-ipc');

    act(() => {
      for (const listener of pushListeners) {
        listener(
          { ownerId: 'fixture-owner', config: remote },
          { dataOwnerId: 'fixture-owner', ownerGeneration: 1 },
        );
      }
    });
    await waitFor(() => {
      expect(screen.getByText('Pushed Folder')).toBeTruthy();
      expect(getBotHierarchySnapshot().config.folders['f-push']?.name).toBe('Pushed Folder');
    });

    resetBotHierarchyStoreForTests();
    expect(Object.keys(getBotHierarchySnapshot().config.folders)).toHaveLength(0);
  });
});

describe('TeammatesSection hierarchy, display menu, and tree interactions', () => {
  async function openDisplayMenu() {
    const trigger = screen.getByRole('button', { name: 'bots.hierarchy.menuTrigger' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    return screen.findByRole('menuitem', { name: 'bots.hierarchy.newFolder' });
  }

  it('creates root folder from display menu and supports inline rename commit and escape cancel', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Alpha' })];
    await renderSidebar();

    const newFolderItem = await openDisplayMenu();
    fireEvent.click(newFolderItem);

    const renameInput = (await screen.findByLabelText(
      'bots.hierarchy.renameInputLabel',
    )) as HTMLInputElement;
    expect(renameInput.value).toBe('bots.hierarchy.defaultFolderName');

    fireEvent.change(renameInput, { target: { value: 'Core Ops' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByLabelText('bots.hierarchy.renameInputLabel')).toBeNull();
      expect(screen.getByText('Core Ops')).toBeTruthy();
    });

    const folderButton = screen.getByText('Core Ops').closest('button')!;
    fireEvent.doubleClick(folderButton);
    const editAgain = (await screen.findByLabelText(
      'bots.hierarchy.renameInputLabel',
    )) as HTMLInputElement;
    fireEvent.change(editAgain, { target: { value: 'Discarded Name' } });
    fireEvent.keyDown(editAgain, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByLabelText('bots.hierarchy.renameInputLabel')).toBeNull();
      expect(screen.getByText('Core Ops')).toBeTruthy();
      expect(screen.queryByText('Discarded Name')).toBeNull();
    });
  });

  it('creates nested subfolder, moves to root, and dissolves folder without losing buddies', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'Alpha' }),
      bot({ id: 'bot-2', name: 'Beta' }),
    ];

    await act(async () => {
      await mutateBotHierarchy((curr) => {
        const parent = createBotFolder(curr, { id: 'f-parent', name: 'Engineering' });
        const child = createBotFolder(parent.config, {
          id: 'f-child',
          name: 'Frontend',
          parentId: 'f-parent',
        });
        return assignItemsToFolder(child.config, ['bot:bot-1'], 'f-child');
      });
    });

    await renderSidebar();
    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Frontend')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('bots.hierarchy.ungrouped')).toBeTruthy();

    // Open folder context menu for Frontend -> move to root.
    const frontendBtn = screen.getByText('Frontend').closest('button')!;
    fireEvent.contextMenu(frontendBtn, { clientX: 60, clientY: 60 });
    const moveToRoot = await screen.findByRole('menuitem', { name: 'bots.hierarchy.moveToRoot' });
    fireEvent.click(moveToRoot);

    await waitFor(() => {
      expect(getBotHierarchySnapshot().config.folders['f-child']?.parentId).toBeNull();
    });

    // Dissolve Frontend folder -> Alpha stays in visible list without data loss.
    fireEvent.contextMenu(screen.getByText('Frontend').closest('button')!, {
      clientX: 60,
      clientY: 60,
    });
    const deleteFolder = await screen.findByRole('menuitem', {
      name: 'bots.hierarchy.deleteFolder',
    });
    fireEvent.click(deleteFolder);

    await waitFor(() => {
      expect(screen.queryByText('Frontend')).toBeNull();
      expect(getBotHierarchySnapshot().config.folders['f-child']).toBeUndefined();
      expect(screen.getByText('Alpha')).toBeTruthy();
      expect(screen.getByText('Beta')).toBeTruthy();
    });

    // Add a subfolder via Engineering hover action button.
    const engRow = screen.getByText('Engineering').closest('[data-hierarchy-folder-id="f-parent"]')!;
    const addSubBtn = engRow.querySelector(
      'button[aria-label="bots.hierarchy.newSubfolder"]',
    ) as HTMLButtonElement;
    fireEvent.click(addSubBtn);

    const subInput = (await screen.findByLabelText(
      'bots.hierarchy.renameInputLabel',
    )) as HTMLInputElement;
    fireEvent.change(subInput, { target: { value: 'Platform' } });
    fireEvent.keyDown(subInput, { key: 'Enter' });

    await waitFor(() => {
      const folders = Object.values(getBotHierarchySnapshot().config.folders);
      const platform = folders.find((folder) => folder.name === 'Platform');
      expect(platform?.parentId).toBe('f-parent');
    });
  });

  it('shows orange breathing icon and aggregated status dot on collapsed folder with running buddy', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Worker Bot' })];
    mocks.islandActivity = new Map([
      ['bot-1-chat', { sessionId: 'bot-1-chat', phase: 'running' }],
    ]);

    await act(async () => {
      await mutateBotHierarchy((curr) => {
        const created = createBotFolder(curr, { id: 'f-work', name: 'Active Ops' });
        return assignItemsToFolder(created.config, ['bot:bot-1'], 'f-work');
      });
    });

    const view = await renderSidebar();
    const folderRow = view.container.querySelector('[data-hierarchy-folder-id="f-work"]')!;
    const folderBtn = screen.getByText('Active Ops').closest('button')!;

    // Expanded initially: icon wrapper should not breathe.
    expect(folderBtn.getAttribute('aria-expanded')).toBe('true');
    const iconWrapperBefore = folderRow.querySelector('[data-folder-icon-wrapper="f-work"]')!;
    expect(iconWrapperBefore.className).not.toContain('session-status-breathing');
    expect(folderRow.querySelector('[data-folder-status-dot]')).toBeNull();

    // Collapse folder -> icon wrapper breathes accent & right-side aggregated dot renders.
    fireEvent.click(folderBtn);
    await waitFor(() => {
      expect(folderBtn.getAttribute('aria-expanded')).toBe('false');
      const iconWrapper = folderRow.querySelector('[data-folder-icon-wrapper="f-work"]')!;
      expect(iconWrapper.className).toContain('text-[var(--status-bar-accent)]');
      expect(iconWrapper.className).toContain('session-status-breathing');
      expect(folderRow.querySelector('[data-folder-status-dot="running"]')).not.toBeNull();
    });

    // Expand all restores expanded state.
    await openDisplayMenu();
    const expandAll = await screen.findByRole('menuitem', { name: 'bots.hierarchy.expandAll' });
    fireEvent.click(expandAll);
    await waitFor(() => expect(folderBtn.getAttribute('aria-expanded')).toBe('true'));

    await openDisplayMenu();
    const collapseAll = await screen.findByRole('menuitem', { name: 'bots.hierarchy.collapseAll' });
    fireEvent.click(collapseAll);
    await waitFor(() => expect(folderBtn.getAttribute('aria-expanded')).toBe('false'));
  });

  it('runs smart organize via display menu and notifies empty vs organized result', async () => {
    const infoSpy = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-info');
    const successSpy = vi.spyOn(toast, 'success').mockImplementation(() => 'toast-success');

    try {
      // Single non-prefixed bot -> nothing to smart-organize yet.
      mocks.profiles = [bot({ id: 'bot-solo', name: 'Solo' })];
      const view = await renderSidebar();

      await openDisplayMenu();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.hierarchy.smartOrganize' }));
      await waitFor(() => {
        expect(infoSpy).toHaveBeenCalledWith('bots.hierarchy.smartOrganizeEmpty');
      });

      // Prefixed buddies (`万界｜...`) -> grouped automatically.
      mocks.profiles = [
        bot({ id: 'bot-a', name: '万界｜Research' }),
        bot({ id: 'bot-b', name: '万界｜Builder' }),
      ];
      view.rerender(<TeammatesSection />);

      await openDisplayMenu();
      fireEvent.click(await screen.findByRole('menuitem', { name: 'bots.hierarchy.smartOrganize' }));

      await waitFor(() => {
        expect(successSpy).toHaveBeenCalledWith('bots.hierarchy.smartOrganizeDone');
        expect(screen.getByText('万界')).toBeTruthy();
        expect(screen.getByText('万界｜Research')).toBeTruthy();
        expect(screen.getByText('万界｜Builder')).toBeTruthy();
      });
    } finally {
      infoSpy.mockRestore();
      successSpy.mockRestore();
    }
  });

  it('toggles group-by-computer and compact single-line density while preserving context menus', async () => {
    mocks.profiles = [
      bot({
        id: 'bot-local',
        name: 'Local Pal',
        lastMessagePreview: 'Detailed two-line preview text',
      }),
    ];
    mocks.devices = [
      { deviceId: 'self-1', name: 'Workstation', isSelf: true },
      { deviceId: 'mac-2', name: 'MacBook Pro', isSelf: false },
    ];
    mocks.remoteBots = [
      {
        id: 'bot-remote',
        deviceId: 'mac-2',
        deviceName: 'MacBook Pro',
        name: 'Remote Pal',
        avatar: '🛰️',
        avatarColor: 'blue',
        description: '',
        preview: 'Remote preview line',
        activityAt: 1,
        sessionId: 'mac-2-chat',
        online: false,
      },
    ];

    const view = await renderSidebar();
    expect(screen.getByText('Detailed two-line preview text')).toBeTruthy();

    // Toggle groupByComputer ON.
    await openDisplayMenu();
    const groupCheckbox = await screen.findByRole('menuitemcheckbox', {
      name: 'bots.hierarchy.groupByComputer',
    });
    fireEvent.click(groupCheckbox);

    await waitFor(() => {
      expect(view.container.querySelector('[data-computer-section="local"]')).not.toBeNull();
      expect(view.container.querySelector('[data-computer-section="device:mac-2"]')).not.toBeNull();
      expect(screen.getByText('Workstation')).toBeTruthy();
      expect(screen.getByText('MacBook Pro')).toBeTruthy();
      expect(screen.getByText('ccAgent.sidebar.deviceGroup.offline')).toBeTruthy();
    });

    // Toggle compact single-line density ON -> preview lines hidden, h-8 rows keep context menu.
    await openDisplayMenu();
    const compactCheckbox = await screen.findByRole('menuitemcheckbox', {
      name: 'bots.hierarchy.compactDensity',
    });
    fireEvent.click(compactCheckbox);

    await waitFor(() => {
      expect(screen.queryByText('Detailed two-line preview text')).toBeNull();
      expect(screen.getByText('Local Pal').closest('button')?.className).toContain('h-8');
    });

    // Right-clicking compact row still opens context menu with Move to folder submenu.
    const compactBtn = screen.getByText('Local Pal').closest('button')!;
    fireEvent.contextMenu(compactBtn, { clientX: 80, clientY: 90 });
    expect(await screen.findByRole('menuitem', { name: 'bots.list.pin' })).toBeTruthy();
    expect(await screen.findByRole('menuitem', { name: 'bots.hierarchy.moveToFolder' })).toBeTruthy();
  });

  it('moves buddy via BotMoveToFolderSubmenu including createAndMove and moveOutOfFolder', async () => {
    mocks.profiles = [bot({ id: 'bot-1', name: 'Movable Bot' })];
    await renderSidebar();

    // Context menu -> Move to folder -> Create and move.
    fireEvent.contextMenu(screen.getByText('Movable Bot').closest('button')!, {
      clientX: 100,
      clientY: 120,
    });
    const moveTrigger = await screen.findByRole('menuitem', {
      name: 'bots.hierarchy.moveToFolder',
    });
    fireEvent.keyDown(moveTrigger, { key: 'ArrowRight' });
    const createAndMove = await screen.findByRole('menuitem', {
      name: 'bots.hierarchy.createAndMove',
    });
    fireEvent.click(createAndMove);

    const renameInput = (await screen.findByLabelText(
      'bots.hierarchy.renameInputLabel',
    )) as HTMLInputElement;
    fireEvent.change(renameInput, { target: { value: 'Squad X' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    await waitFor(() => {
      const snap = getBotHierarchySnapshot().config;
      const folderId = resolveItemFolderId(snap, 'bot:bot-1');
      expect(folderId).toBeTruthy();
      expect(snap.folders[folderId!]?.name).toBe('Squad X');
    });

    // Move back out of folder via submenu.
    fireEvent.contextMenu(screen.getByText('Movable Bot').closest('button')!, {
      clientX: 100,
      clientY: 120,
    });
    const moveAgain = await screen.findByRole('menuitem', {
      name: 'bots.hierarchy.moveToFolder',
    });
    fireEvent.keyDown(moveAgain, { key: 'ArrowRight' });
    const moveOut = await screen.findByRole('menuitem', {
      name: 'bots.hierarchy.moveOutOfFolder',
    });
    fireEvent.click(moveOut);

    await waitFor(() => {
      expect(resolveItemFolderId(getBotHierarchySnapshot().config, 'bot:bot-1')).toBeNull();
    });
  });

  it('supports drag-and-drop into folder, sibling reordering, and ungrouping to root', async () => {
    mocks.profiles = [
      bot({ id: 'bot-1', name: 'First Buddy', lastMessageAt: 300 }),
      bot({ id: 'bot-2', name: 'Second Buddy', lastMessageAt: 200 }),
      bot({ id: 'bot-3', name: 'Third Buddy', lastMessageAt: 100 }),
    ];

    await act(async () => {
      await mutateBotHierarchy((curr) => {
        const created = createBotFolder(curr, { id: 'f-target', name: 'Drop Target' });
        return assignItemsToFolder(created.config, ['bot:bot-1'], 'f-target');
      });
    });

    const view = await renderSidebar();
    const folderEl = view.container.querySelector('[data-hierarchy-folder-id="f-target"]')!;
    const bot2El = view.container.querySelector('[data-hierarchy-item-key="bot:bot-2"]')!;

    // Drag Second Buddy onto folder Drop Target.
    fireEvent.dragStart(bot2El);
    fireEvent.dragOver(folderEl);
    fireEvent.drop(folderEl);
    fireEvent.dragEnd(bot2El);

    await waitFor(() => {
      expect(resolveItemFolderId(getBotHierarchySnapshot().config, 'bot:bot-2')).toBe('f-target');
    });

    // Reorder Second Buddy above First Buddy inside Drop Target.
    const bot1El = view.container.querySelector('[data-hierarchy-item-key="bot:bot-1"]')!;
    const draggedBot2El = view.container.querySelector('[data-hierarchy-item-key="bot:bot-2"]')!;
    fireEvent.dragStart(draggedBot2El);
    fireEvent.dragOver(bot1El);
    fireEvent.drop(bot1El);
    fireEvent.dragEnd(draggedBot2El);

    await waitFor(() => {
      const snap = getBotHierarchySnapshot().config;
      expect(snap.assignments['bot:bot-2']?.order).toBe(0);
      expect(snap.assignments['bot:bot-1']?.order).toBe(1);
      const renderedKeys = Array.from(
        view.container.querySelectorAll('[data-hierarchy-item-key]'),
      ).map((el) => el.getAttribute('data-hierarchy-item-key'));
      expect(renderedKeys.slice(0, 2)).toEqual(['bot:bot-2', 'bot:bot-1']);
    });

    // Drag Second Buddy onto ungrouped drop heading to remove from folder.
    const ungroupedZone = view.container.querySelector('[data-hierarchy-ungrouped-drop="true"]')!;
    const bot2InFolder = view.container.querySelector('[data-hierarchy-item-key="bot:bot-2"]')!;
    fireEvent.dragStart(bot2InFolder);
    fireEvent.dragOver(ungroupedZone);
    fireEvent.drop(ungroupedZone);
    fireEvent.dragEnd(bot2InFolder);

    await waitFor(() => {
      expect(resolveItemFolderId(getBotHierarchySnapshot().config, 'bot:bot-2')).toBeNull();
    });
  });

  it('auto-seeds multi-level hierarchy for untouched large structured rosters and surfaces quick grouping controls + empty peer computers', async () => {
    let persistedConfig = createEmptyBotHierarchyConfig();
    const empty = createEmptyBotHierarchyConfig();
    const getMock = vi.fn(async () => ({ ownerId: 'fixture-owner', config: persistedConfig }));
    const writeMock = vi.fn(async (body: { config: typeof empty }) => {
      persistedConfig = body.config;
      return { ownerId: 'fixture-owner', config: persistedConfig };
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI,
        localDb: {
          ...((window as unknown as { electronAPI: { localDb: Record<string, unknown> } }).electronAPI
            .localDb),
          bots: {
            hierarchy: {
              get: getMock,
              write: writeMock,
              sync: vi.fn(async () => ({ ownerId: 'fixture-owner', config: persistedConfig })),
            },
          },
        },
      },
    });

    mocks.devices = [
      { deviceId: 'self-1', name: 'Workstation', isSelf: true },
      { deviceId: 'peer-2', name: 'optix-display', isSelf: false },
    ];
    mocks.profiles = [
      bot({ id: 'cindy-default', name: 'Cindy' }),
      bot({ id: 'sec', name: '万界｜总协调（SECRETARY）' }),
      bot({ id: 'm01', name: '万界｜制作人（M01）' }),
      bot({ id: 'd01', name: '万界｜主策划（D01）' }),
      bot({ id: 'd02', name: '万界｜文案（D02）' }),
      bot({ id: 'p01', name: '万界｜主程（P01）' }),
      bot({ id: 'p02', name: '万界｜渲染（P02）' }),
      bot({ id: 'hb01', name: '万界｜工程效能（HB01）' }),
      bot({ id: 'a01', name: '万界｜主美（A01）' }),
      bot({ id: 'a02', name: '万界｜角色（A02）' }),
      bot({ id: 'au01', name: '万界｜音频（AU01）' }),
      bot({ id: 'q01', name: '万界｜QA（Q01）' }),
      bot({ id: 'bd01', name: '万界｜发行（BD01）' }),
      bot({ id: 'fn01', name: '万界｜财务（FN01）' }),
    ];

    const view = await renderSidebar();

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalled();
      expect(screen.getByText('核心助手')).toBeTruthy();
      expect(screen.getByText('万界')).toBeTruthy();
      expect(screen.getByText('技术研发')).toBeTruthy();
      expect(screen.getByText('产品策划')).toBeTruthy();
      expect(screen.getByText('美术视觉')).toBeTruthy();
    });

    // Total companion count badge & folder count badges are visible.
    expect(screen.getByTestId('teammates-total-count').textContent).toBe('14');
    expect(view.container.querySelector('[data-folder-count="3"]')).not.toBeNull();

    // Depth >= 2 subfolders start collapsed for >12 rosters so long lists don't overflow the sidebar.
    expect(readTeammatesCollapsedFolders('fixture-owner').size).toBeGreaterThan(0);

    // Quick Grouping Bar toggles By Computer -> shows even an empty linked peer computer section.
    const groupingBar = screen.getByTestId('teammates-grouping-bar');
    expect(groupingBar).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.hierarchy.quickByComputer' }));

    await waitFor(() => {
      expect(view.container.querySelector('[data-computer-section="local"]')).not.toBeNull();
      expect(view.container.querySelector('[data-computer-section="device:peer-2"]')).not.toBeNull();
      expect(screen.getByText('optix-display')).toBeTruthy();
    });
  });

  it('uses canonical keys for cloud remote companions, falls back for local self-remote keys, and prunes obsolete folders', async () => {
    mocks.devices = [
      { deviceId: 'dev-self', name: 'Workstation', isSelf: true },
      { deviceId: 'dev-home', name: 'HomePC', isSelf: false },
    ];
    mocks.cloud = {
      enabled: true,
      selfDeviceId: 'dev-self',
      humanActorId: 'human-1',
      actors: [
        { id: 'actor-cloud-dev', externalId: 'cloud-dev', name: '万界｜主程（P01）', avatar: null, homeDeviceId: 'dev-home' },
      ],
      demotedBotIds: [],
    };
    mocks.remoteBots = [
      {
        id: 'cloud-dev',
        deviceId: 'dev-home',
        deviceName: 'HomePC',
        name: '万界｜主程（P01）',
        avatar: '🤖',
        avatarColor: 'violet',
        description: '',
        preview: 'Remote cloud chat',
        activityAt: 100,
        sessionId: 'cloud-dev-chat',
        online: true,
      },
    ];
    mocks.profiles = [
      bot({ id: 'local-peer-grouped', name: '本地研发', lastMessagePreview: 'Local preview' }),
    ];

    await mutateBotHierarchy((curr) => {
      let next = createBotFolder(curr, { id: 'f-legacy', name: '旧分组', now: 10 }).config;
      next = createBotFolder(next, { id: 'f-manual-empty', name: '手动空文件夹', now: 11 }).config;
      // Legacy peer-created remote-bot key targeting our local companion should resolve for local display.
      next = assignItemsToFolder(next, [botHierarchyItemKey('local-peer-grouped', 'dev-self')], 'f-legacy', {
        now: 12,
      });
      // Legacy peer-created remote-bot key for cloud companion before canonical key exists.
      next = assignItemsToFolder(next, [botHierarchyItemKey('cloud-dev', 'dev-home')], 'f-legacy', {
        now: 12,
      });
      return next;
    });

    const view = await renderSidebar();

    // Both local fallback (`remote-bot:dev-self:...`) and cloud remote (`remote-bot:dev-home:...`) render inside `f-legacy`
    // while using canonical `bot:cloud-dev` as the tree entry key for cloud remote companions.
    expect(view.container.querySelector('[data-hierarchy-folder-id="f-legacy"]')).not.toBeNull();
    expect(view.container.querySelector('[data-hierarchy-item-key="bot:cloud-dev"]')).not.toBeNull();
    expect(view.container.querySelector('[data-hierarchy-item-key="bot:local-peer-grouped"]')).not.toBeNull();

    // Triggering smart organize from quick grouping bar writes canonical keys, deletes stale `remote-bot:` entries,
    // tombstones emptied legacy folders (`f-legacy`), and preserves manually created empty folders (`f-manual-empty`).
    fireEvent.click(screen.getByRole('button', { name: 'bots.hierarchy.quickSmartOrganize' }));

    await waitFor(() => {
      const snap = getBotHierarchySnapshot().config;
      expect(snap.assignments['bot:cloud-dev']?.folderId).toBeTruthy();
      expect(snap.assignments['remote-bot:dev-home:cloud-dev']).toBeUndefined();
      expect(snap.folders['f-legacy']).toBeUndefined();
      expect(snap.deletedFolderIds['f-legacy']).toBeGreaterThan(0);
      expect(snap.folders['f-manual-empty']).toBeTruthy();
    });

    // Direct executeSmartOrganize call cleanly reports organized entries when re-organizing.
    const repeat = await executeSmartOrganize(
      [{ kind: 'bot', itemKey: 'bot:cloud-dev', botId: 'cloud-dev', deviceId: 'dev-home', name: '万界｜主程（P01）', isRemote: true }],
      'dev-self',
    );
    expect(repeat.config.folders['f-manual-empty']).toBeTruthy();
  });
});
