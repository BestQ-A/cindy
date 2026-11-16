import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { stringArrayParam } from './_array-param.js';
import { errorPayload, okPayload } from './_payload.js';

export type GoalBoardStatusWire = 'active' | 'paused' | 'completed' | 'archived';

export type GoalWorkItemStatusWire =
  | 'pending'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'completed'
  | 'blocked';

export interface GoalWorkItemWire {
  id: string;
  title: string;
  status: GoalWorkItemStatusWire;
  blockedBy: string[];
  ownerRole?: string;
  ownerBotId?: string;
  ownerSessionId?: string;
  backupOwnerRole?: string;
  backupOwnerBotId?: string;
  reviewerRole?: string;
  reviewerBotId?: string;
  reviewerSessionId?: string;
  artifactPaths: string[];
  acceptanceCriteria?: string;
  evidenceSummary?: string;
  blockerReason?: string;
  reviewVerdict?: 'PASS' | 'FAIL' | null;
  wave?: number;
  isCriticalPath?: boolean;
  startedAtMs?: number;
  submittedAtMs?: number;
  completedAtMs?: number;
  updatedAtMs: number;
}

export interface GoalRecordWire {
  id: string;
  title: string;
  objective: string;
  projectPath?: string;
  pmRole?: string;
  pmBotId?: string;
  pmSessionId?: string;
  status: GoalBoardStatusWire;
  exitCriteria: string[];
  items: GoalWorkItemWire[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface GoalNextActionsWire {
  goalId: string;
  progressPct: number;
  completedCount: number;
  totalCount: number;
  currentWave: number;
  readyToDispatch: GoalWorkItemWire[];
  awaitingReview: GoalWorkItemWire[];
  criticalBlockers: Array<{
    itemId: string;
    title: string;
    status: 'blocked' | 'in_progress';
    isCriticalPath: boolean;
    ownerRole?: string;
    backupOwnerRole?: string;
    backupOwnerBotId?: string;
    blockerReason?: string;
    stalledMs?: number;
    fallbackDirective?: string;
  }>;
  overloadedSessions: Array<{
    sessionId: string;
    queuedCount: number;
    relatedItemIds: string[];
  }>;
}

export interface GoalBoardUpsertItemInputWire {
  id: string;
  title: string;
  status?: GoalWorkItemStatusWire;
  blockedBy?: string[];
  ownerRole?: string;
  ownerBotId?: string;
  ownerSessionId?: string;
  backupOwnerRole?: string;
  backupOwnerBotId?: string;
  reviewerRole?: string;
  reviewerBotId?: string;
  reviewerSessionId?: string;
  artifactPaths?: string[];
  acceptanceCriteria?: string;
  evidenceSummary?: string;
  blockerReason?: string;
}

export interface GoalBoardUpsertRequestWire {
  callerSessionId?: string;
  id?: string;
  title: string;
  objective?: string;
  projectPath?: string;
  pmRole?: string;
  pmBotId?: string;
  pmSessionId?: string;
  status?: GoalBoardStatusWire;
  exitCriteria?: string[];
  items?: GoalBoardUpsertItemInputWire[];
}

export interface GoalBoardItemUpdateRequestWire {
  callerSessionId?: string;
  goalId: string;
  itemId: string;
  status?: GoalWorkItemStatusWire;
  evidenceSummary?: string;
  blockerReason?: string;
  ownerSessionId?: string;
  reviewerSessionId?: string;
  verdict?: 'PASS' | 'FAIL';
  force?: boolean;
}

export interface GoalBoardGetResultWire {
  ok: true;
  goals: Array<{
    goal: GoalRecordWire;
    nextActions: GoalNextActionsWire;
  }>;
}

export interface GoalBoardUpsertResultWire {
  ok: true;
  goal: GoalRecordWire;
  nextActions: GoalNextActionsWire;
}

export type GoalBoardItemUpdateResultWire =
  | {
      ok: true;
      goal: GoalRecordWire;
      item: GoalWorkItemWire;
      newlyUnlockedIds: string[];
      nextActions: GoalNextActionsWire;
    }
  | {
      ok: false;
      errorCode: 'GOAL_NOT_FOUND' | 'ITEM_NOT_FOUND' | 'WAVE_GATE_BLOCKED' | 'REVIEW_REQUIRED' | 'INTERNAL';
      message: string;
    };

export interface GoalBoardCallbacks {
  get: (input: { callerSessionId?: string; goalId?: string }) => Promise<GoalBoardGetResultWire>;
  upsert: (input: GoalBoardUpsertRequestWire) => Promise<GoalBoardUpsertResultWire>;
  updateItem: (input: GoalBoardItemUpdateRequestWire) => Promise<GoalBoardItemUpdateResultWire>;
}

const GOAL_ITEM_SCHEMA = z.object({
  id: z.string().min(1).describe('工作项短 ID（例如 "A"、"E"）。'),
  title: z.string().min(1).describe('工作项标题。'),
  status: z
    .enum(['pending', 'ready', 'in_progress', 'in_review', 'completed', 'blocked'])
    .optional()
    .describe('当前状态；若省略且已有记录则保留原状态，否则按前置依赖自动判定 pending/ready。'),
  blocked_by: stringArrayParam(z.array(z.string().min(1))).optional().describe('前置依赖的工作项 ID 列表。'),
  owner_role: z.string().optional().describe('唯一负责人角色，如 "M01"、"HB05"。'),
  owner_bot_id: z.string().optional().describe('唯一负责伙伴 botId。'),
  owner_session_id: z.string().optional().describe('唯一负责伙伴的主任务 session_id。'),
  backup_owner_role: z.string().optional().describe('关键路径阻塞时立即顶上的备用兜底角色，如 "HB01"、"P01"。'),
  backup_owner_bot_id: z.string().optional().describe('备用兜底伙伴 botId。'),
  reviewer_role: z.string().optional().describe('独立验收人角色（不可与 owner_role 相同）。'),
  reviewer_bot_id: z.string().optional().describe('独立验收伙伴 botId。'),
  reviewer_session_id: z.string().optional().describe('独立验收伙伴 session_id。'),
  artifact_paths: stringArrayParam(z.array(z.string().min(1))).optional().describe('独占产物文件路径列表。'),
  acceptance_criteria: z.string().optional().describe('量化验收口径。'),
  evidence_summary: z.string().optional().describe('简洁验收/交付证据摘要（≤300字）。'),
  blocker_reason: z.string().optional().describe('若 status=blocked，写明阻塞原因。'),
});

export function registerGoalBoardTools(
  registry: XdtHelperToolRegistry,
  getSessionContext: () => LiziMcpSessionContext,
  callbacks: GoalBoardCallbacks,
): void {
  registry.register({
    name: 'goal_board_get',
    category: 'cindy',
    description:
      '只读读取当前共享目标看板（Goal Board）与波次编排状态，返回每个目标的波次划分、关键路径、可派发任务 (ready_to_dispatch)、待验收任务 (awaiting_review)、阻塞兜底指令 (critical_blockers) 及过载队列告警 (overloaded_sessions)。派单或巡检前必读。',
    inputShape: {
      goal_id: z.string().min(1).optional().describe('可选；指定只读取某一个目标 ID。'),
    },
    handler: async (args) => {
      try {
        const ctx = getSessionContext();
        const res = await callbacks.get({
          callerSessionId: ctx.sessionId,
          ...(typeof args.goal_id === 'string' && args.goal_id.trim()
            ? { goalId: args.goal_id.trim() }
            : {}),
        });
        return okPayload({
          goals: res.goals.map((entry) => ({
            goal: entry.goal,
            next_actions: {
              goal_id: entry.nextActions.goalId,
              progress_pct: entry.nextActions.progressPct,
              completed_count: entry.nextActions.completedCount,
              total_count: entry.nextActions.totalCount,
              current_wave: entry.nextActions.currentWave,
              ready_to_dispatch: entry.nextActions.readyToDispatch,
              awaiting_review: entry.nextActions.awaitingReview,
              critical_blockers: entry.nextActions.criticalBlockers,
              overloaded_sessions: entry.nextActions.overloadedSessions,
            },
          })),
        });
      } catch (error) {
        return errorPayload('INTERNAL', error instanceof Error ? error.message : String(error));
      }
    },
  });

  registry.register({
    name: 'goal_board_upsert',
    category: 'cindy',
    description:
      '创建或更新共享目标看板与任务波次依赖图（含每项的前置 blocked_by、负责人、备用兜底人 backup_owner_role、独立验收人 reviewer_role 与退出条件）。系统会自动计算拓扑波次 wave、关键路径及可派发状态。',
    inputShape: {
      id: z.string().min(1).optional().describe('目标 ID（不传则自动生成；更新既有目标必传）。'),
      title: z.string().min(1).describe('目标或里程碑标题。'),
      objective: z.string().optional().describe('目标的一句话可验证完成定义。'),
      project_path: z.string().optional().describe('所属工程目录路径。'),
      pm_role: z.string().optional().describe('项目唯一 PM/总控角色（如 "M01"）。'),
      pm_bot_id: z.string().optional(),
      pm_session_id: z.string().optional(),
      status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
      exit_criteria: stringArrayParam(z.array(z.string().min(1))).optional().describe('目标退出条件清单。'),
      items: z.array(GOAL_ITEM_SCHEMA).optional().describe('工作包列表及依赖/负责人/兜底/验收人定义。'),
    },
    handler: async (args) => {
      try {
        const ctx = getSessionContext();
        const rawItems = Array.isArray(args.items)
          ? (args.items as Array<z.infer<typeof GOAL_ITEM_SCHEMA>>)
          : undefined;
        const mappedItems: GoalBoardUpsertItemInputWire[] | undefined = rawItems?.map((item) => ({
          id: item.id,
          title: item.title,
          ...(item.status ? { status: item.status } : {}),
          ...(item.blocked_by ? { blockedBy: item.blocked_by } : {}),
          ...(item.owner_role !== undefined ? { ownerRole: item.owner_role } : {}),
          ...(item.owner_bot_id !== undefined ? { ownerBotId: item.owner_bot_id } : {}),
          ...(item.owner_session_id !== undefined ? { ownerSessionId: item.owner_session_id } : {}),
          ...(item.backup_owner_role !== undefined ? { backupOwnerRole: item.backup_owner_role } : {}),
          ...(item.backup_owner_bot_id !== undefined ? { backupOwnerBotId: item.backup_owner_bot_id } : {}),
          ...(item.reviewer_role !== undefined ? { reviewerRole: item.reviewer_role } : {}),
          ...(item.reviewer_bot_id !== undefined ? { reviewerBotId: item.reviewer_bot_id } : {}),
          ...(item.reviewer_session_id !== undefined ? { reviewerSessionId: item.reviewer_session_id } : {}),
          ...(item.artifact_paths ? { artifactPaths: item.artifact_paths } : {}),
          ...(item.acceptance_criteria !== undefined ? { acceptanceCriteria: item.acceptance_criteria } : {}),
          ...(item.evidence_summary !== undefined ? { evidenceSummary: item.evidence_summary } : {}),
          ...(item.blocker_reason !== undefined ? { blockerReason: item.blocker_reason } : {}),
        }));
        const res = await callbacks.upsert({
          callerSessionId: ctx.sessionId,
          ...(typeof args.id === 'string' && args.id.trim() ? { id: args.id.trim() } : {}),
          title: String(args.title),
          ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
          ...(typeof args.project_path === 'string' ? { projectPath: args.project_path } : {}),
          ...(typeof args.pm_role === 'string' ? { pmRole: args.pm_role } : {}),
          ...(typeof args.pm_bot_id === 'string' ? { pmBotId: args.pm_bot_id } : {}),
          ...(typeof args.pm_session_id === 'string' ? { pmSessionId: args.pm_session_id } : {}),
          ...(typeof args.status === 'string' ? { status: args.status as GoalBoardStatusWire } : {}),
          ...(Array.isArray(args.exit_criteria) ? { exitCriteria: args.exit_criteria as string[] } : {}),
          ...(mappedItems ? { items: mappedItems } : {}),
        });
        return okPayload({
          goal: res.goal,
          next_actions: res.nextActions,
        });
      } catch (error) {
        return errorPayload('INTERNAL', error instanceof Error ? error.message : String(error));
      }
    },
  });

  registry.register({
    name: 'goal_item_update',
    category: 'cindy',
    description:
      '推进或验收目标看板中的单个工作项（受波次门禁 WAVE_GATE_BLOCKED 与独立验收门禁 REVIEW_REQUIRED 保护）。当某项通过并置为 completed 时，系统会自动解锁下游波次并返还 newly_unlocked_ids 与 next_actions。',
    inputShape: {
      goal_id: z.string().min(1).describe('目标 ID。'),
      item_id: z.string().min(1).describe('工作项 ID。'),
      status: z
        .enum(['pending', 'ready', 'in_progress', 'in_review', 'completed', 'blocked'])
        .optional()
        .describe('目标状态。'),
      verdict: z
        .enum(['PASS', 'FAIL'])
        .optional()
        .describe('独立验收结论；有独立验收人的工作项必须 verdict=PASS 才可置为 completed；FAIL 将打回 in_progress。'),
      evidence_summary: z.string().optional().describe('简短证据/产物说明（≤300字）。'),
      blocker_reason: z.string().optional().describe('阻塞原因（status=blocked 时填写）。'),
      owner_session_id: z.string().optional().describe('绑定当前负责人的真实 session_id。'),
      reviewer_session_id: z.string().optional().describe('绑定独立验收人的真实 session_id。'),
      force: z.boolean().optional().describe('仅异常纠正使用；正常流转不要传 true。'),
    },
    handler: async (args) => {
      try {
        const ctx = getSessionContext();
        const res = await callbacks.updateItem({
          callerSessionId: ctx.sessionId,
          goalId: String(args.goal_id).trim(),
          itemId: String(args.item_id).trim(),
          ...(typeof args.status === 'string' ? { status: args.status as GoalWorkItemStatusWire } : {}),
          ...(args.verdict === 'PASS' || args.verdict === 'FAIL' ? { verdict: args.verdict } : {}),
          ...(typeof args.evidence_summary === 'string' ? { evidenceSummary: args.evidence_summary } : {}),
          ...(typeof args.blocker_reason === 'string' ? { blockerReason: args.blocker_reason } : {}),
          ...(typeof args.owner_session_id === 'string' ? { ownerSessionId: args.owner_session_id } : {}),
          ...(typeof args.reviewer_session_id === 'string' ? { reviewerSessionId: args.reviewer_session_id } : {}),
          ...(args.force === true ? { force: true } : {}),
        });
        if (!res.ok) {
          return errorPayload(res.errorCode, res.message);
        }
        return okPayload({
          goal: res.goal,
          item: res.item,
          newly_unlocked_ids: res.newlyUnlockedIds,
          next_actions: res.nextActions,
        });
      } catch (error) {
        return errorPayload('INTERNAL', error instanceof Error ? error.message : String(error));
      }
    },
  });
}
