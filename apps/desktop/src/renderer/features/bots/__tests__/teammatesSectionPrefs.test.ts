// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  readTeammatesCollapsedComputers,
  readTeammatesCollapsedFolders,
  readTeammatesCompactDensity,
  readTeammatesGroupByComputer,
  readTeammatesSectionCollapsed,
  writeTeammatesCollapsedComputers,
  writeTeammatesCollapsedFolders,
  writeTeammatesCompactDensity,
  writeTeammatesGroupByComputer,
  writeTeammatesSectionCollapsed,
} from '../teammatesSectionPrefs';

beforeEach(() => localStorage.clear());

describe('teammates section collapse preference', () => {
  it('defaults to expanded and keeps each account separate', () => {
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
    writeTeammatesSectionCollapsed('owner-a', true);
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(true);
    expect(readTeammatesSectionCollapsed('owner-b')).toBe(false);
    writeTeammatesSectionCollapsed('owner-a', false);
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
  });

  it('stays expanded without an account and never persists for it', () => {
    writeTeammatesSectionCollapsed(null, true);
    expect(readTeammatesSectionCollapsed(null)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('treats unknown stored values as the expanded default', () => {
    localStorage.setItem('sidebar.teammatesSection.v1.owner.owner-a', 'sideways');
    expect(readTeammatesSectionCollapsed('owner-a')).toBe(false);
  });
});

describe('teammates hierarchy display and folder preferences', () => {
  it('persists collapsed folder and computer IDs per owner and ignores null owners', () => {
    expect(readTeammatesCollapsedFolders('owner-a').size).toBe(0);
    writeTeammatesCollapsedFolders('owner-a', new Set(['folder-1', 'folder-2', '']));
    expect(Array.from(readTeammatesCollapsedFolders('owner-a'))).toEqual(['folder-1', 'folder-2']);
    expect(readTeammatesCollapsedFolders('owner-b').size).toBe(0);

    writeTeammatesCollapsedFolders(null, ['folder-x']);
    expect(readTeammatesCollapsedFolders(null).size).toBe(0);

    writeTeammatesCollapsedComputers('owner-a', ['local', 'dev-1']);
    expect(Array.from(readTeammatesCollapsedComputers('owner-a'))).toEqual(['local', 'dev-1']);
    expect(readTeammatesCollapsedComputers('owner-b').size).toBe(0);
    writeTeammatesCollapsedComputers(null, ['local']);
    expect(readTeammatesCollapsedComputers(null).size).toBe(0);
  });

  it('falls back to empty sets on corrupted stored JSON', () => {
    localStorage.setItem('sidebar.teammatesCollapsedFolders.v1.owner.owner-a', '{not-json');
    localStorage.setItem('sidebar.teammatesCollapsedComputers.v1.owner.owner-a', '"not-an-array"');
    expect(readTeammatesCollapsedFolders('owner-a').size).toBe(0);
    expect(readTeammatesCollapsedComputers('owner-a').size).toBe(0);
  });

  it('persists groupByComputer and compactDensity per owner with false defaults', () => {
    expect(readTeammatesGroupByComputer('owner-a')).toBe(false);
    expect(readTeammatesCompactDensity('owner-a')).toBe(false);

    writeTeammatesGroupByComputer('owner-a', true);
    writeTeammatesCompactDensity('owner-a', true);
    expect(readTeammatesGroupByComputer('owner-a')).toBe(true);
    expect(readTeammatesCompactDensity('owner-a')).toBe(true);
    expect(readTeammatesGroupByComputer('owner-b')).toBe(false);
    expect(readTeammatesCompactDensity('owner-b')).toBe(false);

    writeTeammatesGroupByComputer(null, true);
    writeTeammatesCompactDensity(null, true);
    expect(readTeammatesGroupByComputer(null)).toBe(false);
    expect(readTeammatesCompactDensity(null)).toBe(false);

    localStorage.setItem('sidebar.teammatesGroupByComputer.v1.owner.owner-b', 'yes');
    localStorage.setItem('sidebar.teammatesCompactDensity.v1.owner.owner-b', 'compact');
    expect(readTeammatesGroupByComputer('owner-b')).toBe(false);
    expect(readTeammatesCompactDensity('owner-b')).toBe(false);
  });
});
