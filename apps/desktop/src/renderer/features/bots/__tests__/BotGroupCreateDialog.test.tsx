// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assignItemsToFolder,
  botHierarchyItemKey,
  createBotFolder,
  createEmptyBotHierarchyConfig,
} from '../../../../shared/botHierarchy';
import { mutateBotHierarchy, resetBotHierarchyStoreForTests } from '../botHierarchyClientStore';
import { BotGroupCreateDialog } from '../BotGroupCreateDialog';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  status: vi.fn(),
  ownedBots: vi.fn(),
  createBotGroup: vi.fn(),
  refreshBotGroups: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../botGroupStore', () => ({
  botGroupApi: () => ({ createBotGroup: mocks.createBotGroup, chatServer: { status: mocks.status, ownedBots: mocks.ownedBots } }),
  refreshBotGroups: mocks.refreshBotGroups,
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

function bot(id: string, createdAt: number, status = 'active') {
  return { id, name: `Bot ${id}`, avatar: '', avatarColor: 'violet', enabled: true, status, createdAt, sessions: [] };
}

async function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  render(<BotGroupCreateDialog onOpenChange={onOpenChange} onCreated={onCreated} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'bots.groupChat.create.submit' })).toHaveProperty('disabled', false));
  return { onOpenChange, onCreated };
}

function checkbox(name: string): HTMLButtonElement {
  return screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLButtonElement;
}

beforeEach(() => {
  resetBotHierarchyStoreForTests();
  mocks.status.mockResolvedValue({ enabled: false });
  mocks.ownedBots.mockReset().mockResolvedValue({ ok: true, bots: [] });
  mocks.createBotGroup.mockReset().mockResolvedValue({ ok: true, groupId: 'g-new' });
  mocks.refreshBotGroups.mockReset();
  mocks.profiles = [
    bot('c', 3),
    bot('a', 1),
    bot('b', 2),
    bot('d', 4),
    bot('e', 5),
    bot('f', 6),
    bot('g', 7),
    bot('paused', 8, 'paused'),
    bot('gone', 9, 'archived'),
  ];
});

afterEach(() => {
  cleanup();
  resetBotHierarchyStoreForTests();
});

describe('BotGroupCreateDialog', () => {
  it('retries a failed roster request without losing the group name', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    mocks.ownedBots.mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ ok: true, bots: [{ actorId: 'actor-linux', botId: 'linux', name: 'Linux' }] });
    render(<BotGroupCreateDialog onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my group name' } });
    fireEvent.click(await screen.findByRole('button', { name: 'commonUi.retry' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Linux' }));
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Keep my group name');
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'Keep my group name', botIds: ['linux'] }));
  });
  it('creates with an owned companion that only exists on another computer', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    mocks.ownedBots.mockResolvedValue({ ok: true, bots: [{ actorId: 'actor-linux', botId: 'linux', name: 'Linux' }] });
    await renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Linux' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cross device' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'Cross device', botIds: ['linux'] }));
  });
  it('creates from a private chat with only its teammate and no member picker', async () => {
    mocks.status.mockResolvedValue({ enabled: true });
    const onCreated = vi.fn();
    render(<BotGroupCreateDialog privateChatBotId="c" onOpenChange={vi.fn()} onCreated={onCreated} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  项目讨论  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(mocks.createBotGroup).toHaveBeenCalledExactlyOnceWith({ name: '项目讨论', botIds: ['c'] });
  });

  it('does not silently create a local-only group from a private chat', async () => {
    render(<BotGroupCreateDialog privateChatBotId="c" onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '项目讨论' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.groupChat.errors.chatUnavailable');
    expect(screen.getByRole('textbox')).toHaveProperty('value', '项目讨论');
    expect(mocks.createBotGroup).not.toHaveBeenCalled();
  });

  it('focuses the name, lists local teammates and blocks paused or archived ones', async () => {
    await renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    expect(screen.queryByRole('checkbox', { name: /Bot gone/ })).toBeNull();
    expect(checkbox('Bot paused').disabled).toBe(true);
    // No × close control on a form dialog (DESIGN.md §4).
    expect(screen.queryByRole('button', { name: 'bots.close' })).toBeNull();
  });

  it('requires a name and at least two teammates before calling main', async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByText('bots.groupChat.create.nameRequired')).toBeTruthy();
    expect(mocks.createBotGroup).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '周末出游' } });
    fireEvent.click(checkbox('Bot a'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByText('bots.groupChat.create.minMembers')).toBeTruthy();
    expect(mocks.createBotGroup).not.toHaveBeenCalled();
  });

  it('caps the selection at six and creates in picker order', async () => {
    const { onCreated } = await renderDialog();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  周末出游 ' } });
    for (const id of ['f', 'a', 'c', 'b', 'e', 'd']) fireEvent.click(checkbox(`Bot ${id}`));
    expect(checkbox('Bot g').disabled).toBe(true);
    expect(checkbox('Bot a').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(mocks.createBotGroup).toHaveBeenCalledWith({
      name: '周末出游',
      botIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(mocks.refreshBotGroups).toHaveBeenCalled();
  });

  it('keeps the form open and explains a member-limit failure from main', async () => {
    mocks.createBotGroup.mockResolvedValue({ ok: false, errorCode: 'MEMBER_LIMIT', message: 'x' });
    const { onCreated } = await renderDialog();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '读书会' } });
    fireEvent.click(checkbox('Bot a'));
    fireEvent.click(checkbox('Bot b'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bots.groupChat.errors.memberLimit');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('closes from Cancel', async () => {
    const { onOpenChange } = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'bots.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses searchbox role for member search, blocks Enter submit, and preserves selections across filtering', async () => {
    await renderDialog();
    const nameInput = screen.getByRole('textbox');
    const searchInput = screen.getByRole('searchbox');
    expect(searchInput).toBeTruthy();
    expect(nameInput).not.toBe(searchInput);

    // Pressing Enter in the searchbox must not submit the form.
    fireEvent.keyDown(searchInput, { key: 'Enter' });
    fireEvent.submit(searchInput.closest('form')!);
    expect(mocks.createBotGroup).not.toHaveBeenCalled();

    fireEvent.change(searchInput, { target: { value: 'Bot b' } });
    expect(screen.queryByRole('checkbox', { name: /Bot a/ })).toBeNull();
    fireEvent.click(checkbox('Bot b'));

    fireEvent.change(searchInput, { target: { value: '' } });
    expect(checkbox('Bot b').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot a')).toBeTruthy();
  });

  it('renders nested folder groups with indentation and breadcrumbs and filters by folder name or path', async () => {
    await mutateBotHierarchy(() => {
      let config = createEmptyBotHierarchyConfig(100);
      const rootRes = createBotFolder(config, { id: 'root-wj', name: '万界', now: 101 });
      config = rootRes.config;
      const devRes = createBotFolder(config, { id: 'sub-dev', name: '技术研发', parentId: 'root-wj', now: 102 });
      config = devRes.config;
      const prodRes = createBotFolder(config, { id: 'sub-prod', name: '产品策划', parentId: 'root-wj', now: 103 });
      config = prodRes.config;
      config = assignItemsToFolder(config, [botHierarchyItemKey('a'), botHierarchyItemKey('b')], 'sub-dev', { now: 104 });
      config = assignItemsToFolder(config, [botHierarchyItemKey('c')], 'sub-prod', { now: 105 });
      return config;
    });

    const { container } = render(<BotGroupCreateDialog onOpenChange={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'bots.groupChat.create.submit' })).toHaveProperty('disabled', false));

    expect(screen.getByText('万界')).toBeTruthy();
    expect(screen.getByText('万界 / 技术研发')).toBeTruthy();
    expect(screen.getByText('万界 / 产品策划')).toBeTruthy();
    expect(screen.getByText('bots.hierarchy.ungrouped')).toBeTruthy();

    const rootSection = document.querySelector('[data-folder-section="root-wj"]');
    const devSection = document.querySelector('[data-folder-section="sub-dev"]');
    expect(rootSection?.getAttribute('data-depth')).toBe('1');
    expect(devSection?.getAttribute('data-depth')).toBe('2');
    expect(container).toBeTruthy();

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: '技术研发' } });
    expect(checkbox('Bot a')).toBeTruthy();
    expect(checkbox('Bot b')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Bot c/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Bot d/ })).toBeNull();

    fireEvent.change(searchInput, { target: { value: '万界 / 产品策划' } });
    expect(checkbox('Bot c')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Bot a/ })).toBeNull();
  });

  it('supports selectGroupAll and deselectGroupAll while enforcing the 6-member limit', async () => {
    mocks.profiles = [
      bot('a', 1),
      bot('b', 2),
      bot('c', 3),
      bot('d', 4),
      bot('e', 5),
      bot('f', 6),
      bot('g', 7),
      bot('h', 8),
      bot('paused', 9, 'paused'),
    ];
    await mutateBotHierarchy(() => {
      let config = createEmptyBotHierarchyConfig(200);
      const smallRes = createBotFolder(config, { id: 'f-small', name: '小团队', now: 201 });
      config = smallRes.config;
      const largeRes = createBotFolder(config, { id: 'f-large', name: '大团队', now: 202 });
      config = largeRes.config;
      config = assignItemsToFolder(
        config,
        [botHierarchyItemKey('a'), botHierarchyItemKey('b'), botHierarchyItemKey('c'), botHierarchyItemKey('paused')],
        'f-small',
        { now: 203 },
      );
      config = assignItemsToFolder(
        config,
        [botHierarchyItemKey('d'), botHierarchyItemKey('e'), botHierarchyItemKey('f'), botHierarchyItemKey('g'), botHierarchyItemKey('h')],
        'f-large',
        { now: 204 },
      );
      return config;
    });

    await renderDialog();
    const smallSection = document.querySelector('[data-folder-section="f-small"]') as HTMLElement;
    const largeSection = document.querySelector('[data-folder-section="f-large"]') as HTMLElement;

    // Selecting small group picks a, b, c and skips paused.
    fireEvent.click(within(smallSection).getByRole('button', { name: 'bots.hierarchy.selectGroupAll' }));
    expect(checkbox('Bot a').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot b').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot c').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot paused').getAttribute('aria-checked')).toBe('false');
    expect(within(smallSection).getByRole('button', { name: 'bots.hierarchy.deselectGroupAll' })).toBeTruthy();

    // Selecting large group truncates at BOT_GROUP_MAX_MEMBERS = 6 (adds d, e, f only).
    fireEvent.click(within(largeSection).getByRole('button', { name: 'bots.hierarchy.selectGroupAll' }));
    expect(checkbox('Bot d').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot e').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot f').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot g').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('Bot h').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('Bot g').disabled).toBe(true);

    // Deselecting small group frees 3 slots while keeping large group selections intact.
    fireEvent.click(within(smallSection).getByRole('button', { name: 'bots.hierarchy.deselectGroupAll' }));
    expect(checkbox('Bot a').getAttribute('aria-checked')).toBe('false');
    expect(checkbox('Bot d').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Bot g').disabled).toBe(false);

    // Submitting sends selected members in picker order.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '分组测试群' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
    await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({
      name: '分组测试群',
      botIds: ['d', 'e', 'f'],
    }));
  });

  it('caps single-group selectGroupAll at six when a folder has more than six selectable bots and toggles to deselectGroupAll', async () => {
    mocks.profiles = Array.from({ length: 8 }, (_, idx) => bot(`m${idx + 1}`, idx + 1));
    await mutateBotHierarchy(() => {
      let config = createEmptyBotHierarchyConfig(300);
      const big = createBotFolder(config, { id: 'f-eight', name: '八人组', now: 301 });
      config = big.config;
      config = assignItemsToFolder(
        config,
        mocks.profiles.map((item) => botHierarchyItemKey((item as { id: string }).id)),
        'f-eight',
        { now: 302 },
      );
      return config;
    });

    await renderDialog();
    const section = document.querySelector('[data-folder-section="f-eight"]') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'bots.hierarchy.selectGroupAll' }));

    const checkedCount = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-checked') === 'true').length;
    expect(checkedCount).toBe(6);

    const deselectBtn = within(section).getByRole('button', { name: 'bots.hierarchy.deselectGroupAll' });
    fireEvent.click(deselectBtn);
    const afterDeselectCount = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-checked') === 'true').length;
    expect(afterDeselectCount).toBe(0);
  });
});


it('lets a server group start without bots so people can join by invitation', async () => {
  mocks.status.mockResolvedValue({ enabled: true });
  mocks.profiles = [];
  await renderDialog();
  await screen.findByText('bots.groupChat.server.createDescription');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'People first' } });
  fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.create.submit' }));
  await waitFor(() => expect(mocks.createBotGroup).toHaveBeenCalledWith({ name: 'People first', botIds: [] }));
});
