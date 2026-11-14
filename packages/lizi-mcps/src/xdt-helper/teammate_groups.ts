import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { stringArrayParam } from './_array-param.js';
import { errorPayload, okPayload } from './_payload.js';

export type TeammateGroupKindWire = 'local' | 'remote' | 'cloud' | 'group';

export interface TeammateGroupFolderWire {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  path: string;
  pathParts: string[];
  depth: number;
  directMemberCount: number;
  totalMemberCount: number;
}

export interface TeammateGroupMemberWire {
  botId: string;
  itemKey: string;
  name: string;
  title?: string;
  deviceId?: string;
  deviceName?: string;
  kind: TeammateGroupKindWire;
  roleCode?: string;
  folderId: string | null;
  breadcrumb: string;
  breadcrumbParts: string[];
  order?: number;
}

export interface TeammateGroupTreeNodeWire extends TeammateGroupFolderWire {
  members: TeammateGroupMemberWire[];
  children: TeammateGroupTreeNodeWire[];
}

export interface GetTeammateGroupsRequestWire {
  callerSessionId: string;
  query?: string;
  folderId?: string;
  path?: string;
  includeDescendants: boolean;
  deviceId?: string;
  kind?: TeammateGroupKindWire;
  ungroupedOnly: boolean;
  includeEmptyFolders: boolean;
}

export interface TeammateGroupStatsWire {
  totalFolders: number;
  totalTeammates: number;
  groupedCount: number;
  ungroupedCount: number;
  matchedTeammates: number;
  matchedFolders: number;
}

export interface GetTeammateGroupsResultWire {
  version: number;
  updatedAt: string;
  updatedByDeviceId?: string;
  maxDepth: number;
  maxFolders: number;
  stats: TeammateGroupStatsWire;
  tree: TeammateGroupTreeNodeWire[];
  folders: TeammateGroupFolderWire[];
  teammates: TeammateGroupMemberWire[];
  ungrouped: TeammateGroupMemberWire[];
}

export interface OrganizeTeammateRuleWire {
  botIds?: string[];
  prefix?: string;
  regex?: string;
  keyword?: string;
  role?: string;
  kind?: TeammateGroupKindWire;
  deviceId?: string;
  targetPath?: string;
  folderId?: string;
  unassign?: boolean;
  overwriteExisting?: boolean;
}

export type OrganizeTeammateOperationWire =
  | {
      op: 'create_folder';
      path?: string;
      name?: string;
      parentId?: string | null;
      parentPath?: string;
    }
  | {
      op: 'rename_folder';
      folderId?: string;
      path?: string;
      newName: string;
    }
  | {
      op: 'move_folder';
      folderId?: string;
      path?: string;
      targetParentId?: string | null;
      targetParentPath?: string;
      toRoot?: boolean;
    }
  | {
      op: 'delete_folder';
      folderId?: string;
      path?: string;
      reparentToParent?: boolean;
    }
  | {
      op: 'assign';
      botIds: string[];
      targetPath?: string;
      folderId?: string;
      unassign?: boolean;
    }
  | {
      op: 'unassign';
      botIds: string[];
    };

export interface OrganizeTeammateGroupsRequestWire {
  callerSessionId: string;
  smart: boolean;
  dryRun: boolean;
  replaceExisting: boolean;
  ungroupedOnly: boolean;
  botIds?: string[];
  deviceId?: string;
  kind?: TeammateGroupKindWire;
  rules?: OrganizeTeammateRuleWire[];
  operations?: OrganizeTeammateOperationWire[];
}

export interface TeammateFolderChangeWire {
  action: 'created' | 'renamed' | 'moved' | 'deleted';
  folderId: string;
  name: string;
  previousName?: string;
  path: string;
  previousPath?: string;
}

export interface TeammateAssignmentChangeWire {
  botId: string;
  itemKey: string;
  name: string;
  kind: TeammateGroupKindWire;
  fromFolderId: string | null;
  fromBreadcrumb: string;
  toFolderId: string | null;
  toBreadcrumb: string;
  reason?: string;
}

export interface OrganizeTeammateGroupsResultWire {
  dryRun: boolean;
  applied: boolean;
  mode: 'smart' | 'rules' | 'operations' | 'mixed';
  updatedAt: string;
  summary: {
    foldersCreated: number;
    foldersRenamed: number;
    foldersMoved: number;
    foldersDeleted: number;
    teammatesMoved: number;
    teammatesAssigned: number;
    teammatesUnassigned: number;
    unchangedTeammates: number;
    unmatchedRules: number;
    warnings: string[];
  };
  folderChanges: TeammateFolderChangeWire[];
  assignmentChanges: TeammateAssignmentChangeWire[];
  tree: TeammateGroupTreeNodeWire[];
  stats: TeammateGroupStatsWire;
}

export type TeammateGroupErrorCode =
  | 'NO_SESSION_CONTEXT'
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'BUSY'
  | 'LIMIT_EXCEEDED'
  | 'OPERATION_FAILED'
  | 'HOST_NOT_READY'
  | 'INTERNAL';

export interface TeammateGroupsCallbacks {
  get(
    params: GetTeammateGroupsRequestWire,
  ): Promise<ControlResult<GetTeammateGroupsResultWire, TeammateGroupErrorCode>>;
  organize(
    params: OrganizeTeammateGroupsRequestWire,
  ): Promise<ControlResult<OrganizeTeammateGroupsResultWire, TeammateGroupErrorCode>>;
}

const TEAMMATE_KIND_SCHEMA = z.enum(['local', 'remote', 'cloud', 'group']);

const ID_LIST_SCHEMA = stringArrayParam(
  z.array(z.string().trim().min(1).max(200)).min(1).max(500),
);

const NON_EMPTY_SHORT_TEXT = z.string().trim().min(1).max(120);
const FOLDER_PATH_TEXT = z.string().trim().min(1).max(500);
const FOLDER_NAME_TEXT = z.string().trim().min(1).max(80);
const ID_TEXT = z.string().trim().min(1).max(200);

const RULE_SCHEMA = z
  .strictObject({
    bot_ids: ID_LIST_SCHEMA.optional().describe('Explicit bot IDs (or item keys) to match.'),
    prefix: NON_EMPTY_SHORT_TEXT.optional().describe('Match teammates whose name or title starts with this prefix.'),
    regex: z.string().min(1).max(200).optional().describe('JavaScript RegExp pattern matched against name, title, or botId.'),
    keyword: NON_EMPTY_SHORT_TEXT.optional().describe('Case-insensitive substring matched against name, title, or botId.'),
    role: NON_EMPTY_SHORT_TEXT.optional().describe('Role code or role keyword (e.g. SECRETARY, M, D, P, HB, 产品, 研发, 策划).'),
    kind: TEAMMATE_KIND_SCHEMA.optional().describe('Filter matched teammates by kind.'),
    device_id: ID_TEXT.optional().describe('Filter matched teammates by deviceId.'),
    target_path: FOLDER_PATH_TEXT.optional().describe('Target folder breadcrumb path such as "万界/策划组". Missing folders are created automatically.'),
    folder_id: ID_TEXT.optional().describe('Existing target folder ID.'),
    unassign: z.boolean().optional().describe('If true, remove matched teammates from any folder (move to ungrouped).'),
    overwrite_existing: z.boolean().optional().describe('Whether to move teammates already inside another folder (default true for explicit rules).'),
  })
  .superRefine((rule, ctx) => {
    const hasMatcher = Boolean(
      rule.bot_ids?.length ||
        rule.prefix ||
        rule.regex ||
        rule.keyword ||
        rule.role ||
        rule.kind ||
        rule.device_id,
    );
    if (!hasMatcher) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each rule must specify at least one matcher (bot_ids, prefix, regex, keyword, role, kind, or device_id).',
      });
    }
    if (rule.regex !== undefined) {
      try {
        // Validate syntax early so invalid patterns fail at argument validation rather than mutating state.
        new RegExp(rule.regex);
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['regex'],
          message: `Invalid regular expression: ${rule.regex}`,
        });
      }
    }
    const destinations = [
      rule.target_path !== undefined,
      rule.folder_id !== undefined,
      rule.unassign === true,
    ].filter(Boolean).length;
    if (destinations !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Each rule must specify exactly one destination: target_path, folder_id, or unassign=true.',
      });
    }
  });

const CREATE_FOLDER_OP_SCHEMA = z
  .strictObject({
    op: z.literal('create_folder'),
    path: FOLDER_PATH_TEXT.optional().describe('Full folder path to create recursively (e.g. "万界/策划组").'),
    name: FOLDER_NAME_TEXT.optional().describe('Single folder name to create under parent_id or parent_path.'),
    parent_id: ID_TEXT.nullable().optional().describe('Parent folder ID (null or omitted for root).'),
    parent_path: FOLDER_PATH_TEXT.optional().describe('Parent folder path (e.g. "万界"); missing parent segments are created if needed.'),
  })
  .superRefine((op, ctx) => {
    if (!op.path && !op.name) {
      ctx.addIssue({
        code: 'custom',
        message: 'create_folder requires either path or name.',
      });
    }
    if (op.path && (op.name || op.parent_id !== undefined || op.parent_path)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Use either path alone OR name (+ optional parent_id/parent_path) for create_folder.',
      });
    }
    if (op.parent_id && op.parent_path) {
      ctx.addIssue({
        code: 'custom',
        message: 'Specify at most one of parent_id or parent_path.',
      });
    }
  });

const RENAME_FOLDER_OP_SCHEMA = z
  .strictObject({
    op: z.literal('rename_folder'),
    folder_id: ID_TEXT.optional().describe('Target folder ID.'),
    path: FOLDER_PATH_TEXT.optional().describe('Target folder path (e.g. "万界/策划组").'),
    new_name: FOLDER_NAME_TEXT.describe('New folder name.'),
  })
  .superRefine((op, ctx) => {
    if (!op.folder_id && !op.path) {
      ctx.addIssue({
        code: 'custom',
        message: 'rename_folder requires folder_id or path.',
      });
    }
  });

const MOVE_FOLDER_OP_SCHEMA = z
  .strictObject({
    op: z.literal('move_folder'),
    folder_id: ID_TEXT.optional().describe('Folder ID to move.'),
    path: FOLDER_PATH_TEXT.optional().describe('Folder path to move.'),
    target_parent_id: ID_TEXT.nullable().optional().describe('Destination parent folder ID (or null for root).'),
    target_parent_path: FOLDER_PATH_TEXT.optional().describe('Destination parent folder path.'),
    to_root: z.boolean().optional().describe('Set true to move the folder to top-level root.'),
  })
  .superRefine((op, ctx) => {
    if (!op.folder_id && !op.path) {
      ctx.addIssue({
        code: 'custom',
        message: 'move_folder requires folder_id or path.',
      });
    }
    const targetModes = [
      op.target_parent_id !== undefined,
      op.target_parent_path !== undefined,
      op.to_root === true,
    ].filter(Boolean).length;
    if (targetModes !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'move_folder requires exactly one target: target_parent_id, target_parent_path, or to_root=true.',
      });
    }
  });

const DELETE_FOLDER_OP_SCHEMA = z
  .strictObject({
    op: z.literal('delete_folder'),
    folder_id: ID_TEXT.optional().describe('Folder ID to dissolve/delete.'),
    path: FOLDER_PATH_TEXT.optional().describe('Folder path to dissolve/delete.'),
    reparent_to_parent: z.boolean().optional().describe('If true (default), promote direct child folders and items to the parent folder (or root if top-level); if false, cascade-delete subfolders and ungroup items to root.'),
  })
  .superRefine((op, ctx) => {
    if (!op.folder_id && !op.path) {
      ctx.addIssue({
        code: 'custom',
        message: 'delete_folder requires folder_id or path.',
      });
    }
  });

const ASSIGN_OP_SCHEMA = z
  .strictObject({
    op: z.literal('assign'),
    bot_ids: ID_LIST_SCHEMA.describe('Teammate botIds (or item keys) to move.'),
    target_path: FOLDER_PATH_TEXT.optional().describe('Target folder path (created if missing).'),
    folder_id: ID_TEXT.optional().describe('Existing target folder ID.'),
    unassign: z.boolean().optional().describe('If true, ungroup these teammates.'),
  })
  .superRefine((op, ctx) => {
    const destinations = [
      op.target_path !== undefined,
      op.folder_id !== undefined,
      op.unassign === true,
    ].filter(Boolean).length;
    if (destinations !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'assign requires exactly one destination: target_path, folder_id, or unassign=true.',
      });
    }
  });

const UNASSIGN_OP_SCHEMA = z.strictObject({
  op: z.literal('unassign'),
  bot_ids: ID_LIST_SCHEMA.describe('Teammate botIds (or item keys) to remove from folders.'),
});

const OPERATION_SCHEMA = z.discriminatedUnion('op', [
  CREATE_FOLDER_OP_SCHEMA,
  RENAME_FOLDER_OP_SCHEMA,
  MOVE_FOLDER_OP_SCHEMA,
  DELETE_FOLDER_OP_SCHEMA,
  ASSIGN_OP_SCHEMA,
  UNASSIGN_OP_SCHEMA,
]);

function mapRuleWire(rule: z.infer<typeof RULE_SCHEMA>): OrganizeTeammateRuleWire {
  return {
    ...(rule.bot_ids ? { botIds: rule.bot_ids } : {}),
    ...(rule.prefix !== undefined ? { prefix: rule.prefix } : {}),
    ...(rule.regex !== undefined ? { regex: rule.regex } : {}),
    ...(rule.keyword !== undefined ? { keyword: rule.keyword } : {}),
    ...(rule.role !== undefined ? { role: rule.role } : {}),
    ...(rule.kind !== undefined ? { kind: rule.kind } : {}),
    ...(rule.device_id !== undefined ? { deviceId: rule.device_id } : {}),
    ...(rule.target_path !== undefined ? { targetPath: rule.target_path } : {}),
    ...(rule.folder_id !== undefined ? { folderId: rule.folder_id } : {}),
    ...(rule.unassign !== undefined ? { unassign: rule.unassign } : {}),
    ...(rule.overwrite_existing !== undefined ? { overwriteExisting: rule.overwrite_existing } : {}),
  };
}

function mapOperationWire(op: z.infer<typeof OPERATION_SCHEMA>): OrganizeTeammateOperationWire {
  switch (op.op) {
    case 'create_folder':
      return {
        op: 'create_folder',
        ...(op.path !== undefined ? { path: op.path } : {}),
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.parent_id !== undefined ? { parentId: op.parent_id } : {}),
        ...(op.parent_path !== undefined ? { parentPath: op.parent_path } : {}),
      };
    case 'rename_folder':
      return {
        op: 'rename_folder',
        ...(op.folder_id !== undefined ? { folderId: op.folder_id } : {}),
        ...(op.path !== undefined ? { path: op.path } : {}),
        newName: op.new_name,
      };
    case 'move_folder':
      return {
        op: 'move_folder',
        ...(op.folder_id !== undefined ? { folderId: op.folder_id } : {}),
        ...(op.path !== undefined ? { path: op.path } : {}),
        ...(op.target_parent_id !== undefined ? { targetParentId: op.target_parent_id } : {}),
        ...(op.target_parent_path !== undefined ? { targetParentPath: op.target_parent_path } : {}),
        ...(op.to_root !== undefined ? { toRoot: op.to_root } : {}),
      };
    case 'delete_folder':
      return {
        op: 'delete_folder',
        ...(op.folder_id !== undefined ? { folderId: op.folder_id } : {}),
        ...(op.path !== undefined ? { path: op.path } : {}),
        ...(op.reparent_to_parent !== undefined ? { reparentToParent: op.reparent_to_parent } : {}),
      };
    case 'assign':
      return {
        op: 'assign',
        botIds: op.bot_ids,
        ...(op.target_path !== undefined ? { targetPath: op.target_path } : {}),
        ...(op.folder_id !== undefined ? { folderId: op.folder_id } : {}),
        ...(op.unassign !== undefined ? { unassign: op.unassign } : {}),
      };
    case 'unassign':
      return {
        op: 'unassign',
        botIds: op.bot_ids,
      };
  }
}

/** Registers teammate folder hierarchy inspection and batch/smart organization tools under `bots`. */
export function registerTeammateGroupTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    callbacks: TeammateGroupsCallbacks;
  },
): void {
  async function invoke<T extends object>(
    run: (callerSessionId: string) => Promise<ControlResult<T, TeammateGroupErrorCode>>,
  ) {
    const context = deps.getSessionContext();
    if (!context.sessionId) {
      return errorPayload('NO_SESSION_CONTEXT', 'No Cindy task is bound to this call.');
    }
    try {
      const result = await run(context.sessionId);
      if (!result.ok) {
        return errorPayload(result.errorCode, result.message);
      }
      const { ok: _ok, ...rest } = result;
      return okPayload(rest);
    } catch (error) {
      return errorPayload(
        'INTERNAL',
        error instanceof Error ? error.message : 'Teammate group operation failed.',
      );
    }
  }

  registry.register({
    name: 'get_teammate_groups',
    category: 'bots',
    description:
      'Read the teammate hierarchy folder tree, flattened folders (with breadcrumb path and depth), every teammate (botId, name, title, deviceId, kind) with current folderId/breadcrumb, and ungrouped teammates. Supports optional filtering by query, folder_id, path, device_id, kind, and ungrouped_only.',
    inputShape: {
      query: z.string().trim().max(200).optional().describe('Filter teammates or folders by keyword matching name, title, botId, or folder path.'),
      folder_id: ID_TEXT.optional().describe('Restrict results to a specific folder ID.'),
      path: FOLDER_PATH_TEXT.optional().describe('Restrict results to a folder matching this breadcrumb path (e.g. "万界/策划组").'),
      include_descendants: z.boolean().default(true).describe('When filtering by folder_id or path, include child folders and their teammates (default true).'),
      device_id: ID_TEXT.optional().describe('Filter teammates by deviceId.'),
      kind: TEAMMATE_KIND_SCHEMA.optional().describe('Filter teammates by kind: local, remote, cloud, or group.'),
      ungrouped_only: z.boolean().default(false).describe('If true, list only teammates not currently assigned to any folder.'),
      include_empty_folders: z.boolean().default(true).describe('Whether to include empty folders in tree and folders (default true).'),
    },
    handler: (input) =>
      invoke((callerSessionId) =>
        deps.callbacks.get({
          callerSessionId,
          ...(input.query ? { query: input.query } : {}),
          ...(input.folder_id ? { folderId: input.folder_id } : {}),
          ...(input.path ? { path: input.path } : {}),
          includeDescendants: input.include_descendants,
          ...(input.device_id ? { deviceId: input.device_id } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ungroupedOnly: input.ungrouped_only,
          includeEmptyFolders: input.include_empty_folders,
        }),
      ),
  });

  registry.register({
    name: 'organize_teammate_groups',
    category: 'bots',
    description:
      'Organize the multi-level teammate hierarchy folder tree in one call and return a structured diff summary. Supports two modes (usable separately or together): (1) smart=true auto-builds a smart hierarchy for all or scoped teammates (supports dry_run preview and preserves existing custom folders/assignments unless replace_existing=true); (2) rules (batch assign by prefix, regex, keyword, role, kind, device_id, or explicit bot_ids into multi-level target_path like "万界/策划组" or folder_id) and operations (create_folder, rename_folder, move_folder, delete_folder, assign, unassign). Respects max depth (6) and folder cap (200) and syncs across the account.',
    inputShape: {
      smart: z.boolean().default(false).describe('Run smart auto-grouping across all or filtered teammates.'),
      dry_run: z.boolean().default(false).describe('Preview folder and assignment changes without persisting.'),
      replace_existing: z.boolean().default(false).describe('When smart=true, replace existing hierarchy instead of preserving untouched custom folders and assignments.'),
      ungrouped_only: z.boolean().default(false).describe('When smart=true, only classify teammates that are currently ungrouped.'),
      bot_ids: ID_LIST_SCHEMA.optional().describe('Optional bot IDs to scope smart auto-grouping.'),
      device_id: ID_TEXT.optional().describe('Optional deviceId filter when scoping smart auto-grouping.'),
      kind: TEAMMATE_KIND_SCHEMA.optional().describe('Optional kind filter when scoping smart auto-grouping.'),
      rules: z.array(RULE_SCHEMA).max(100).optional().describe('Batch classification rules matching by bot_ids, prefix, regex, keyword, role, kind, or device_id.'),
      operations: z.array(OPERATION_SCHEMA).max(200).optional().describe('Explicit folder tree and assignment operations (create_folder, rename_folder, move_folder, delete_folder, assign, unassign).'),
    },
    handler: (input) => {
      const hasSmart = input.smart === true;
      const hasRules = Boolean(input.rules && input.rules.length > 0);
      const hasOperations = Boolean(input.operations && input.operations.length > 0);
      if (!hasSmart && !hasRules && !hasOperations) {
        return Promise.resolve(
          errorPayload(
            'INVALID_ARGS',
            'Specify smart=true, non-empty rules, and/or non-empty operations.',
          ),
        );
      }
      return invoke((callerSessionId) =>
        deps.callbacks.organize({
          callerSessionId,
          smart: hasSmart,
          dryRun: input.dry_run,
          replaceExisting: input.replace_existing,
          ungroupedOnly: input.ungrouped_only,
          ...(input.bot_ids ? { botIds: input.bot_ids } : {}),
          ...(input.device_id ? { deviceId: input.device_id } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.rules ? { rules: input.rules.map(mapRuleWire) } : {}),
          ...(input.operations ? { operations: input.operations.map(mapOperationWire) } : {}),
        }),
      );
    },
  });
}
