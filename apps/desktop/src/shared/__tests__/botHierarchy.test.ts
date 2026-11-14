import { describe, expect, it } from 'vitest';

import {
  BOT_HIERARCHY_MAX_DEPTH,
  BOT_HIERARCHY_MAX_FOLDERS,
  BOT_HIERARCHY_PREFERENCE_KEY,
  applyBotBatchOrganize,
  assignItemsToFolder,
  botHierarchyItemKey,
  buildBotFolderTree,
  buildSmartBotHierarchy,
  createBotFolder,
  createEmptyBotHierarchyConfig,
  deleteBotFolder,
  flattenFolderOptions,
  getFolderBreadcrumb,
  getItemFolderBreadcrumb,
  groupHierarchyItemKey,
  isFolderDescendantOrSelf,
  mergeBotHierarchyConfigs,
  moveBotFolder,
  normalizeBotHierarchyConfig,
  renameBotFolder,
  reorderFolderItems,
  reorderSiblings,
  resolveBotFolderId,
  resolveItemFolderId,
  type BotHierarchyConfigV1,
  type BotRosterOrganizeEntry,
} from '../botHierarchy';

describe('botHierarchy core data model & invariants', () => {
  it('exposes exact frozen constants and empty config defaults', () => {
    expect(BOT_HIERARCHY_PREFERENCE_KEY).toBe('companion.hierarchy.v1');
    expect(BOT_HIERARCHY_MAX_DEPTH).toBe(6);
    expect(BOT_HIERARCHY_MAX_FOLDERS).toBe(200);

    const empty = createEmptyBotHierarchyConfig();
    expect(empty).toEqual({
      version: 1,
      updatedAt: 0,
      folders: {},
      assignments: {},
      rootOrder: [],
      deletedFolderIds: {},
    });
  });

  it('generates and resolves local, remote-bot, and group item keys safely', () => {
    expect(botHierarchyItemKey('bot-1')).toBe('bot:bot-1');
    expect(botHierarchyItemKey(' bot-1 ', null)).toBe('bot:bot-1');
    expect(botHierarchyItemKey('bot-1', 'dev-a')).toBe('remote-bot:dev-a:bot-1');
    expect(botHierarchyItemKey('')).toBe('');
    expect(groupHierarchyItemKey('grp-1')).toBe('group:grp-1');
    expect(groupHierarchyItemKey('')).toBe('');

    let cfg = createEmptyBotHierarchyConfig(10);
    const created = createBotFolder(cfg, { id: 'f1', name: 'Core', now: 20 });
    cfg = created.config;
    // Cloud companion stored canonically as `bot:b1`; remote bot stored under `remote-bot:devA:b2`
    cfg = assignItemsToFolder(cfg, [botHierarchyItemKey('b1'), botHierarchyItemKey('b2', 'devA')], 'f1', {
      now: 30,
    });
    // Explicitly unassigned remote copy `remote-bot:devB:b1` overrides fallback to `bot:b1`
    cfg = assignItemsToFolder(cfg, [botHierarchyItemKey('b1', 'devB')], null, { now: 40 });

    expect(resolveBotFolderId(cfg, 'b1')).toBe('f1');
    // Fallback to canonical `bot:b1` when device-scoped entry doesn't exist
    expect(resolveBotFolderId(cfg, 'b1', 'devA')).toBe('f1');
    // Explicit null tombstone on `devB` is respected rather than falling back
    expect(resolveBotFolderId(cfg, 'b1', 'devB')).toBeNull();
    expect(resolveBotFolderId(cfg, 'b2', 'devA')).toBe('f1');
    expect(resolveBotFolderId(cfg, 'b2')).toBeNull();
  });

  it('prevents cycles and enforces depth <= 6 across createBotFolder and moveBotFolder', () => {
    let cfg = createEmptyBotHierarchyConfig(100);
    let parentId: string | null = null;

    for (let depth = 1; depth <= BOT_HIERARCHY_MAX_DEPTH; depth += 1) {
      const res = createBotFolder(cfg, {
        id: `d${depth}`,
        name: `Depth ${depth}`,
        parentId,
        now: 100 + depth,
      });
      cfg = res.config;
      parentId = res.folder.id;
    }

    // Creating depth 7 must throw
    expect(() =>
      createBotFolder(cfg, { id: 'd7', name: 'Too Deep', parentId: 'd6', now: 200 }),
    ).toThrow(/depth/i);

    // Moving d4 (subtree d4->d5->d6 height=3) under d4 itself / d5 / d6 throws cycle error
    expect(() => moveBotFolder(cfg, 'd4', 'd4')).toThrow(/itself|descendant/i);
    expect(() => moveBotFolder(cfg, 'd4', 'd6')).toThrow(/itself|descendant/i);
    expect(isFolderDescendantOrSelf(cfg, 'd6', 'd4')).toBe(true);
    expect(isFolderDescendantOrSelf(cfg, 'd3', 'd4')).toBe(false);

    // Moving subtree of height 3 (d4->d5->d6) under a separate branch of depth 4 -> total 7 > 6 throws
    let branch = cfg;
    branch = createBotFolder(branch, { id: 'b1', name: 'B1', now: 300 }).config;
    branch = createBotFolder(branch, { id: 'b2', name: 'B2', parentId: 'b1', now: 301 }).config;
    branch = createBotFolder(branch, { id: 'b3', name: 'B3', parentId: 'b2', now: 302 }).config;
    branch = createBotFolder(branch, { id: 'b4', name: 'B4', parentId: 'b3', now: 303 }).config;

    expect(() => moveBotFolder(branch, 'd4', 'b4', { now: 400 })).toThrow(/depth/i);
    // Moving d4 (height 3) under b3 (depth 3) results in max depth 6 -> allowed
    const moved = moveBotFolder(branch, 'd4', 'b3', { now: 401 });
    expect(getFolderBreadcrumb(moved, 'd6').map((f) => f.id)).toEqual([
      'b1',
      'b2',
      'b3',
      'd4',
      'd5',
      'd6',
    ]);
  });

  it('enforces max folder limit of 200 in createBotFolder and repairs corrupted payloads in normalizeBotHierarchyConfig', () => {
    let cfg = createEmptyBotHierarchyConfig(10);
    for (let i = 1; i <= BOT_HIERARCHY_MAX_FOLDERS; i += 1) {
      cfg = createBotFolder(cfg, { id: `f-${i}`, name: `Folder ${i}`, now: 10 + i }).config;
    }
    expect(Object.keys(cfg.folders)).toHaveLength(BOT_HIERARCHY_MAX_FOLDERS);
    expect(() =>
      createBotFolder(cfg, { id: 'f-201', name: 'Overflow', now: 500 }),
    ).toThrow(/200|limit/i);

    // Corrupted config with cycle A->B->C->A, deep chain 1..8, 220 folders, and orphaned assignment
    const corruptFolders: Record<string, unknown> = {
      cycA: { id: 'cycA', name: 'A', parentId: 'cycC', order: 0, createdAt: 1, updatedAt: 10 },
      cycB: { id: 'cycB', name: 'B', parentId: 'cycA', order: 1, createdAt: 2, updatedAt: 10 },
      cycC: { id: 'cycC', name: 'C', parentId: 'cycB', order: 2, createdAt: 3, updatedAt: 10 },
      selfLoop: { id: 'selfLoop', name: 'Self', parentId: 'selfLoop', order: 3, createdAt: 4, updatedAt: 10 },
    };
    let prev: string | null = null;
    for (let d = 1; d <= 8; d += 1) {
      const id = `chain${d}`;
      corruptFolders[id] = {
        id,
        name: `Chain ${d}`,
        parentId: prev,
        order: d + 10,
        createdAt: d + 10,
        updatedAt: 20,
      };
      prev = id;
    }
    for (let extra = 1; extra <= 215; extra += 1) {
      corruptFolders[`extra${extra}`] = {
        id: `extra${extra}`,
        name: `Extra ${extra}`,
        parentId: null,
        order: extra + 100,
        createdAt: extra + 100,
        updatedAt: 30,
      };
    }

    const normalized = normalizeBotHierarchyConfig({
      version: 1,
      updatedAt: 50,
      folders: corruptFolders,
      assignments: {
        'bot:orphan': { folderId: 'does-not-exist', order: 0, updatedAt: 5 },
      },
      rootOrder: ['bot:orphan', 'bot:orphan', 'bot:r1'],
    });

    expect(Object.keys(normalized.folders).length).toBeLessThanOrEqual(BOT_HIERARCHY_MAX_FOLDERS);
    for (const opt of flattenFolderOptions(normalized)) {
      expect(opt.depth).toBeGreaterThanOrEqual(1);
      expect(opt.depth).toBeLessThanOrEqual(BOT_HIERARCHY_MAX_DEPTH);
    }
    expect(normalized.folders.selfLoop.parentId).toBeNull();
    expect(resolveItemFolderId(normalized, 'bot:orphan')).toBeNull();
    expect(normalized.rootOrder).toEqual(['bot:orphan', 'bot:r1']);
  });

  it('renames, deletes (promote & cascade without losing items), reorders siblings and folder items', () => {
    let cfg = createEmptyBotHierarchyConfig(10);
    cfg = createBotFolder(cfg, { id: 'root1', name: 'Root 1', now: 11 }).config;
    cfg = createBotFolder(cfg, { id: 'root2', name: 'Root 2', now: 12 }).config;
    cfg = createBotFolder(cfg, { id: 'child1', name: 'Child 1', parentId: 'root1', now: 13 }).config;
    cfg = createBotFolder(cfg, { id: 'grand1', name: 'Grand 1', parentId: 'child1', now: 14 }).config;

    cfg = renameBotFolder(cfg, 'root1', '  Renamed Root  ', { now: 15 });
    expect(cfg.folders.root1.name).toBe('Renamed Root');
    expect(() => renameBotFolder(cfg, 'root1', '   ')).toThrow(/empty/i);

    cfg = assignItemsToFolder(cfg, ['bot:a', 'bot:b'], 'child1', { now: 16 });
    cfg = assignItemsToFolder(cfg, ['bot:c'], 'grand1', { now: 17 });
    cfg = reorderFolderItems(cfg, 'child1', ['bot:b', 'bot:a'], { now: 18 });
    expect(cfg.assignments['bot:b'].order).toBe(0);
    expect(cfg.assignments['bot:a'].order).toBe(1);

    cfg = reorderSiblings(cfg, null, ['root2', 'root1'], { now: 19 });
    expect(flattenFolderOptions(cfg).map((o) => o.id)).toEqual([
      'root2',
      'root1',
      'child1',
      'grand1',
    ]);

    expect(getItemFolderBreadcrumb(cfg, 'bot:c').map((f) => f.name)).toEqual([
      'Renamed Root',
      'Child 1',
      'Grand 1',
    ]);

    // Promote-children delete of child1 promotes grand1 and moves bot:a/bot:b into root1
    const promoted = deleteBotFolder(cfg, 'child1', { mode: 'promote-children', now: 20 });
    expect(promoted.folders.child1).toBeUndefined();
    expect(promoted.deletedFolderIds.child1).toBe(20);
    expect(promoted.folders.grand1.parentId).toBe('root1');
    expect(resolveItemFolderId(promoted, 'bot:a')).toBe('root1');
    expect(resolveItemFolderId(promoted, 'bot:b')).toBe('root1');

    // Cascade delete of root1 removes root1 + grand1 and moves items back to root (null), never lost
    const cascaded = deleteBotFolder(promoted, 'root1', { mode: 'cascade', now: 25 });
    expect(cascaded.folders.root1).toBeUndefined();
    expect(cascaded.folders.grand1).toBeUndefined();
    expect(cascaded.deletedFolderIds.root1).toBe(25);
    expect(cascaded.deletedFolderIds.grand1).toBe(25);
    expect(resolveItemFolderId(cascaded, 'bot:a')).toBeNull();
    expect(resolveItemFolderId(cascaded, 'bot:c')).toBeNull();
    expect(cascaded.rootOrder).toContain('bot:a');
    expect(cascaded.rootOrder).toContain('bot:c');

    // Reorder root ungrouped items
    const reorderedRoot = reorderFolderItems(cascaded, null, ['bot:c', 'bot:a'], { now: 30 });
    expect(reorderedRoot.rootOrder.slice(0, 2)).toEqual(['bot:c', 'bot:a']);
  });

  it('performs commutative multi-device LWW merge with deletion tombstones & breaks concurrent cycles', () => {
    let base = createEmptyBotHierarchyConfig(10, 'dev-a');
    base = createBotFolder(base, { id: 'f1', name: 'Team', now: 10, deviceId: 'dev-a' }).config;
    base = createBotFolder(base, { id: 'f2', name: 'Sub', parentId: null, now: 11, deviceId: 'dev-a' }).config;
    base = assignItemsToFolder(base, ['bot:1', 'bot:2'], 'f1', { now: 12, deviceId: 'dev-a' });

    // Device A renames f1 at t=100, unassigns bot:1 at t=150, moves f1 under f2 at t=160
    let devA: BotHierarchyConfigV1 = renameBotFolder(base, 'f1', 'Engineering', { now: 100, deviceId: 'dev-a' });
    devA = assignItemsToFolder(devA, ['bot:1'], null, { now: 150, deviceId: 'dev-a' });
    devA = moveBotFolder(devA, 'f1', 'f2', { now: 160, deviceId: 'dev-a' });

    // Concurrently, Device B renames f1 slightly earlier (t=90, loses), creates f3, moves f2 under f1 (t=170 -> cycle!), deletes f3 at t=180
    let devB: BotHierarchyConfigV1 = renameBotFolder(base, 'f1', 'Old Rename', { now: 90, deviceId: 'dev-b' });
    devB = createBotFolder(devB, { id: 'f3', name: 'Temp', now: 120, deviceId: 'dev-b' }).config;
    devB = assignItemsToFolder(devB, ['bot:3'], 'f3', { now: 125, deviceId: 'dev-b' });
    devB = moveBotFolder(devB, 'f2', 'f1', { now: 170, deviceId: 'dev-b' });
    devB = deleteBotFolder(devB, 'f3', { now: 180, deviceId: 'dev-b' });

    const ab = mergeBotHierarchyConfigs(devA, devB);
    const ba = mergeBotHierarchyConfigs(devB, devA);

    // Commutative!
    expect(ab).toEqual(ba);
    // Dev A rename at t=100 beats Dev B rename at t=90
    expect(ab.folders.f1.name).toBe('Engineering');
    // Unassignment tombstone at t=150 beats initial t=12 assignment
    expect(resolveItemFolderId(ab, 'bot:1')).toBeNull();
    // Deleted folder f3 stays deleted and its item moves safely to null
    expect(ab.folders.f3).toBeUndefined();
    expect(ab.deletedFolderIds.f3).toBe(180);
    expect(resolveItemFolderId(ab, 'bot:3')).toBeNull();
    // Concurrent move creating f1<->f2 must be broken cleanly into an acyclic tree
    expect(buildBotFolderTree(ab).length).toBeGreaterThanOrEqual(1);
    expect(getFolderBreadcrumb(ab, 'f1').length).toBeLessThanOrEqual(2);
    expect(getFolderBreadcrumb(ab, 'f2').length).toBeLessThanOrEqual(2);
  });
});

describe('applyBotBatchOrganize & buildSmartBotHierarchy', () => {
  it('supports rule-based batch organization and preserves existing custom assignments when requested', () => {
    let cfg = createEmptyBotHierarchyConfig(10);
    const custom = createBotFolder(cfg, { id: 'custom-pin', name: 'Pinned', now: 20 });
    cfg = assignItemsToFolder(custom.config, ['bot:pinned'], 'custom-pin', { now: 25 });

    const roster: BotRosterOrganizeEntry[] = [
      { botId: 'pinned', name: '万界｜核心（D09）' },
      { botId: 'dev1', name: '万界｜核心架构（D01）' },
      { botId: 'pm1', name: 'Alice PM Helper', title: 'Growth PM' },
      { botId: 'ops1', name: 'Ops Monitor', description: 'Tracks alerts & incidents' },
    ];

    const res = applyBotBatchOrganize(
      cfg,
      roster,
      [
        { folderPath: '万界/研发中心', roleCodes: ['D'] },
        { folderPath: ['增长与运营', '项目管理'], namePrefix: 'Alice' },
        { folderPath: '运维值守', pattern: 'alerts\\s*&\\s*incidents' },
        { type: 'create-folder', folderPath: '归档/历史' },
      ],
      { now: 100, overwriteExistingAssignments: false },
    );

    // Pinned item stayed untouched because overwriteExistingAssignments: false
    expect(resolveBotFolderId(res.config, 'pinned')).toBe('custom-pin');
    expect(getItemFolderBreadcrumb(res.config, 'bot:dev1').map((f) => f.name)).toEqual([
      '万界',
      '研发中心',
    ]);
    expect(getItemFolderBreadcrumb(res.config, 'bot:pm1').map((f) => f.name)).toEqual([
      '增长与运营',
      '项目管理',
    ]);
    expect(getItemFolderBreadcrumb(res.config, 'bot:ops1').map((f) => f.name)).toEqual(['运维值守']);
    expect(flattenFolderOptions(res.config).some((o) => o.pathLabel === '归档 / 历史')).toBe(true);
    expect(res.summary.assignedItemCount).toBe(3);
  });

  it('classifies Cindy + full WanJie role-coded roster accurately without prefix collisions', () => {
    const wanjieRoster: BotRosterOrganizeEntry[] = [
      { botId: 'cindy', name: 'Cindy' },
      { botId: 'sec', name: '万界｜总协调（SECRETARY）' },
      { botId: 'm01', name: '万界｜制作人（M01）' },
      { botId: 'd01', name: '万界｜核心研发（D01）' },
      { botId: 'p01', name: '万界｜产品策划（P01）' },
      { botId: 'p03', name: '万界｜章节玩法（P03_IMPL）' },
      { botId: 'hb01', name: '万界｜主视觉（HB01）' },
      { botId: 'a01', name: '万界｜动作美术（A01）' },
      { botId: 'au01', name: '万界｜音频音效（AU01）' },
      { botId: 'q01', name: '万界｜QA 组长（Q01）' },
      { botId: 'q03', name: '万界｜盲测验收（Q03_BLIND）' },
      { botId: 'bd01', name: '万界｜商务发行（BD01）' },
      { botId: 'pm01', name: '万界｜项目协调（PM01）' },
      { botId: 'mr01', name: '万界｜市场调研（MR01）' },
      { botId: 'da01', name: '万界｜数据分析（DA01）' },
      { botId: 'op01', name: '万界｜产品运营（OP01）' },
      { botId: 'fn01', name: '万界｜财务管理（FN01）' },
      { botId: 'lg01', name: '万界｜法务合规（LG01）' },
      { botId: 'h01', name: '万界｜人力资源（H01）' },
    ];

    const result = buildSmartBotHierarchy(createEmptyBotHierarchyConfig(), wanjieRoster, {
      now: 1000,
      deviceId: 'dev-main',
    });

    expect(result.summary.assignedItemCount).toBe(wanjieRoster.length);
    const pathOf = (botId: string) =>
      getItemFolderBreadcrumb(result.config, botHierarchyItemKey(botId)).map((f) => f.name);

    expect(pathOf('cindy')).toEqual(['核心助手']);
    expect(pathOf('sec')).toEqual(['万界', '行政秘书']);
    expect(pathOf('m01')).toEqual(['万界', '管理总控']);
    expect(pathOf('d01')).toEqual(['万界', '技术研发']);
    expect(pathOf('p01')).toEqual(['万界', '产品策划']);
    expect(pathOf('p03')).toEqual(['万界', '产品策划']);
    // Critical anti-collision checks: HB != H, PM != P, MR != M, DA != D
    expect(pathOf('hb01')).toEqual(['万界', '美术视觉']);
    expect(pathOf('h01')).toEqual(['万界', '职能支持', '人力资源']);
    expect(pathOf('pm01')).toEqual(['万界', '商业运营', '项目管理']);
    expect(pathOf('mr01')).toEqual(['万界', '商业运营', '市场调研']);
    expect(pathOf('da01')).toEqual(['万界', '商业运营', '数据分析']);
    expect(pathOf('a01')).toEqual(['万界', '动画音频']);
    expect(pathOf('au01')).toEqual(['万界', '动画音频']);
    expect(pathOf('q01')).toEqual(['万界', '测试质检']);
    expect(pathOf('q03')).toEqual(['万界', '测试质检']);
    expect(pathOf('bd01')).toEqual(['万界', '商业运营', '商务合作']);
    expect(pathOf('op01')).toEqual(['万界', '商业运营', '运营推广']);
    expect(pathOf('fn01')).toEqual(['万界', '职能支持', '财务管理']);
    expect(pathOf('lg01')).toEqual(['万界', '职能支持', '法务合规']);
  });

  it('handles ordinary bots by prefix/keywords, replaceExisting mode, and 250+ namespace saturation within caps', () => {
    const plainRoster: BotRosterOrganizeEntry[] = [
      { botId: 'b1', name: 'Alpha - Backend API' },
      { botId: 'b2', name: 'Alpha - QA Runner' },
      { botId: 'b3', name: '独立前端开发助手' },
      { botId: 'b4', name: 'Random Companion' },
    ];

    const res = buildSmartBotHierarchy(createEmptyBotHierarchyConfig(), plainRoster, { now: 500 });
    expect(getItemFolderBreadcrumb(res.config, 'bot:b1').map((f) => f.name)).toEqual([
      'Alpha',
      '技术研发',
    ]);
    expect(getItemFolderBreadcrumb(res.config, 'bot:b2').map((f) => f.name)).toEqual([
      'Alpha',
      '测试质检',
    ]);
    expect(getItemFolderBreadcrumb(res.config, 'bot:b3').map((f) => f.name)).toEqual(['技术研发']);
    // Unrelated plain bot stays ungrouped
    expect(resolveBotFolderId(res.config, 'b4')).toBeNull();

    // replaceExisting tombstones previous folders cleanly
    const rebuilt = buildSmartBotHierarchy(
      res.config,
      [{ botId: 'solo', name: '后端架构师' }],
      { now: 600, replaceExisting: true },
    );
    expect(rebuilt.summary.deletedFolderIds.length).toBeGreaterThan(0);
    for (const oldId of rebuilt.summary.deletedFolderIds) {
      expect(rebuilt.config.folders[oldId]).toBeUndefined();
      expect(rebuilt.config.deletedFolderIds[oldId]).toBe(600);
    }

    // 250 distinct namespaces (500 bots) never overflow 200 folders or 6 depth
    const hugeRoster: BotRosterOrganizeEntry[] = [];
    for (let i = 1; i <= 250; i += 1) {
      hugeRoster.push({ botId: `x-${i}-1`, name: `Team${i}｜研发一` });
      hugeRoster.push({ botId: `x-${i}-2`, name: `Team${i}｜测试二` });
    }
    const hugeResult = buildSmartBotHierarchy(createEmptyBotHierarchyConfig(), hugeRoster, {
      now: 1000,
    });
    expect(Object.keys(hugeResult.config.folders).length).toBeLessThanOrEqual(
      BOT_HIERARCHY_MAX_FOLDERS,
    );
    expect(hugeResult.summary.skippedForLimits).toBeGreaterThan(0);
    for (const opt of flattenFolderOptions(hugeResult.config)) {
      expect(opt.depth).toBeLessThanOrEqual(BOT_HIERARCHY_MAX_DEPTH);
    }
  });
});
