// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportsBetaUpdateChannel } from '../../../../shared/updateChannelCapability';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/hooks/useAutoUpdateSettings', () => ({
  useAutoUpdateSettings: () => ({
    state: {
      autoRelaunchOnIdle: true,
      isCustomized: false,
      defaultAutoRelaunchOnIdle: true,
      loading: false,
    },
    setAutoRelaunchOnIdle: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('@/hooks/useExperimentalFeatures', () => ({
  EXPERIMENTAL_FEATURES: [],
  useExperimentalFlag: () => ({ enabled: false, setEnabled: vi.fn() }),
}));

vi.mock('../LspBetaCell', () => ({
  LspBetaCell: () => <div>lsp-beta-cell</div>,
}));

vi.mock('../BetaChannelCell', () => ({
  BetaChannelCell: () => <div>beta-channel-cell</div>,
}));

import { AppUpdateRow } from '../AboutSection';
import { ExperimentalSection } from '../ExperimentalSection';
import { HelpSection } from '../HelpSection';

describe('Linux update settings', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = {
      platform: 'linux',
      supportsBetaUpdateChannel: true,
    };
  });

  it.each(['win32', 'darwin', 'linux'])('offers manual privacy updates on %s', (platform) => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform,
    };
    render(<AppUpdateRow />);

    expect(screen.getByRole('button', { name: 'settings.about.privacyUpdateSource' })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('settings.about.linuxUpdateDescription')).toBeNull();
  });

  it('opens the maintained privacy branch from the update action', () => {
    const openExternal = vi.fn(async () => ({ success: true }));
    Object.assign(window.electronAPI, { openExternal });
    render(<AppUpdateRow />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.about.privacyUpdateSource' }));

    expect(openExternal).toHaveBeenCalledWith('https://github.com/BestQ-A/cindy/tree/privacy/no-telemetry');
  });

  // Exercise the shared capability consumed by preload and the real settings
  // section: ARM64 used to hide this row. In-memory renderer mocks; tier: unit.
  it.each(['x64', 'arm64'])('shows the beta channel card on Linux %s', (arch) => {
    window.electronAPI.supportsBetaUpdateChannel = supportsBetaUpdateChannel('linux', arch);
    render(<ExperimentalSection />);

    expect(screen.getByText('lsp-beta-cell')).toBeTruthy();
    expect(screen.getByText('beta-channel-cell')).toBeTruthy();
  });

  it('hides the beta channel card on unsupported Linux architectures', () => {
    (
      window as unknown as {
        electronAPI: { platform: string; supportsBetaUpdateChannel?: boolean };
      }
    ).electronAPI = {
      platform: 'linux',
      supportsBetaUpdateChannel: supportsBetaUpdateChannel('linux', 'ia32'),
    };
    render(<ExperimentalSection />);

    expect(screen.getByText('lsp-beta-cell')).toBeTruthy();
    expect(screen.queryByText('beta-channel-cell')).toBeNull();
  });

  it('keeps the beta channel card on Windows', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'win32',
    };
    render(<ExperimentalSection />);

    expect(screen.getByText('beta-channel-cell')).toBeTruthy();
  });

  it('shows Linux install and update help on Linux', () => {
    render(<HelpSection onAskHelp={() => undefined} />);

    expect(screen.getByText('settings.help.linuxUpdates.title')).toBeTruthy();
    expect(screen.getByText('settings.help.linuxUpdates.item1')).toBeTruthy();
  });

  it('hides Linux install and update help on macOS', () => {
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
      platform: 'darwin',
    };
    render(<HelpSection onAskHelp={() => undefined} />);

    expect(screen.queryByText('settings.help.linuxUpdates.title')).toBeNull();
  });
});
