import { afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, complete: () => {} };
});

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('../../../shared/brandRegion', () => ({ CURRENT_CINDY_REGION: 'cn' }));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: () => registry.complete(),
    warn: () => registry.complete(),
  }),
}));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const key = args[1];
    const nameIndex = args.indexOf('/v');
    const name = nameIndex < 0 ? '' : args[nameIndex + 1];
    const entry = `${key}|${name}`;
    if (args[0] === 'add') {
      const dataIndex = args.indexOf('/d');
      registry.values.set(entry, dataIndex < 0 ? '' : args[dataIndex + 1] ?? '');
      callback(null, '', '');
    } else if (registry.values.has(entry)) {
      callback(null, `    ${name || '(Default)'}    REG_SZ    ${registry.values.get(entry)}\n`, '');
    } else {
      callback(new Error('Registry value missing'), '', '');
    }
  },
}));

import { registerCindyFileAssociation } from '../fileAssociation';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  registry.values.clear();
});

describe('privacy file association', () => {
  it('adds an Open With handler while preserving the existing default application', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const extension = 'HKCU\\Software\\Classes\\.cindy';
    const program = 'CindyPrivacyCN.CindyGhost';
    registry.values.set(`${extension}|`, 'Cindy.CindyGhost');
    const finished = new Promise<void>((resolve) => { registry.complete = resolve; });

    registerCindyFileAssociation();
    await finished;

    expect(registry.values.get(`${extension}|`)).toBe('Cindy.CindyGhost');
    expect(registry.values.get(`${extension}\\OpenWithProgids|${program}`)).toBe('');
    expect(registry.values.get(`HKCU\\Software\\Classes\\${program}\\shell\\open\\command|`))
      .toBe(`"${process.execPath}" "%1"`);
  });
});
