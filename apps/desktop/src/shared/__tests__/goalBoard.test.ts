import { describe, expect, it } from 'vitest';
import {
  applyGoalItemTransition,
  computeGoalNextActions,
  recomputeGoalGraph,
  sanitizeGoalSummaryText,
  type GoalRecord,
} from '../goalBoard';

function makeSampleGoal(): GoalRecord {
  return {
    id: 'goal-m0',
    title: 'M0 随机秘境候选包收口',
    objective: '按波次交付可追溯微信包并通过独立验收与真机门控',
    pmRole: 'M01',
    status: 'active',
    exitCriteria: ['微信包 < 4MB', 'Q01 独立验收 PASS'],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    items: [
      {
        id: 'A',
        title: '范围基线定稿',
        status: 'completed',
        blockedBy: [],
        ownerRole: 'M01',
        reviewerRole: 'Q01',
        reviewVerdict: 'PASS',
        artifactPaths: ['design/06_production/m0-scope.md'],
        completedAtMs: 2_000,
        updatedAtMs: 2_000,
      },
      {
        id: 'B',
        title: '核心循环差距核对',
        status: 'in_review',
        blockedBy: [],
        ownerRole: 'D01',
        ownerSessionId: 'sess-d01',
        reviewerRole: 'M01',
        artifactPaths: ['design/02_gdd/slice.md'],
        updatedAtMs: 2_500,
      },
      {
        id: 'E',
        title: '固定可玩候选包',
        status: 'pending',
        blockedBy: ['A', 'B'],
        ownerRole: 'HB05',
        ownerSessionId: 'sess-hb05',
        backupOwnerRole: 'HB01',
        reviewerRole: 'Q01',
        artifactPaths: ['build-wx/m0/'],
        updatedAtMs: 1_000,
      },
      {
        id: 'F',
        title: '独立机器与真机核验',
        status: 'pending',
        blockedBy: ['E'],
        ownerRole: 'Q01',
        reviewerRole: 'M01',
        artifactPaths: ['design/08_qa/check.md'],
        updatedAtMs: 1_000,
      },
    ],
  };
}

describe('goalBoard engine', () => {
  it('computes topological waves and longest incomplete critical path safely', () => {
    const graph = recomputeGoalGraph(makeSampleGoal());
    const byId = new Map(graph.items.map((item) => [item.id, item]));

    expect(byId.get('A')?.wave).toBe(0);
    expect(byId.get('B')?.wave).toBe(0);
    expect(byId.get('E')?.wave).toBe(1);
    expect(byId.get('F')?.wave).toBe(2);

    // Critical path walks incomplete chain B -> E -> F
    expect(byId.get('A')?.isCriticalPath).toBe(false);
    expect(byId.get('B')?.isCriticalPath).toBe(true);
    expect(byId.get('E')?.isCriticalPath).toBe(true);
    expect(byId.get('F')?.isCriticalPath).toBe(true);
  });

  it('enforces WAVE_GATE_BLOCKED and REVIEW_REQUIRED before unlocking downstream items', () => {
    const base = recomputeGoalGraph(makeSampleGoal());

    // Cannot start E before B completes
    const blockedStart = applyGoalItemTransition(base, {
      itemId: 'E',
      status: 'in_progress',
    });
    expect(blockedStart.ok).toBe(false);
    if (!blockedStart.ok) {
      expect(blockedStart.errorCode).toBe('WAVE_GATE_BLOCKED');
      expect(blockedStart.message).toContain('B');
    }

    // Cannot complete B without PASS verdict from distinct reviewer
    const missingVerdict = applyGoalItemTransition(base, {
      itemId: 'B',
      status: 'completed',
    });
    expect(missingVerdict.ok).toBe(false);
    if (!missingVerdict.ok) {
      expect(missingVerdict.errorCode).toBe('REVIEW_REQUIRED');
    }

    // Passing B automatically promotes E from pending -> ready
    const passedB = applyGoalItemTransition(
      base,
      {
        itemId: 'B',
        status: 'completed',
        verdict: 'PASS',
        evidenceSummary: '已核对 ![截图](cindy-media://blobs/abc123.png) 与核心切片清单',
      },
      3_000,
    );
    expect(passedB.ok).toBe(true);
    if (passedB.ok) {
      expect(passedB.newlyUnlockedIds).toEqual(['E']);
      const eItem = passedB.goal.items.find((item) => item.id === 'E');
      expect(eItem?.status).toBe('ready');
      expect(passedB.item.evidenceSummary).toContain('[截图]');
      expect(passedB.item.evidenceSummary).not.toContain('cindy-media://');
    }
  });

  it('computes critical blockers with backup fallback directive and overloaded session warnings', () => {
    const base = recomputeGoalGraph(makeSampleGoal());
    const passedB = applyGoalItemTransition(base, {
      itemId: 'B',
      status: 'completed',
      verdict: 'PASS',
    });
    expect(passedB.ok).toBe(true);
    if (!passedB.ok) return;

    const blockedE = applyGoalItemTransition(
      passedB.goal,
      {
        itemId: 'E',
        status: 'blocked',
        blockerReason: 'HB05 模型截断，需立即切换备用执行人',
      },
      4_000,
    );
    expect(blockedE.ok).toBe(true);
    if (!blockedE.ok) return;

    const actions = computeGoalNextActions(blockedE.goal, {
      nowMs: 5_000,
      sessionQueueCounts: { 'sess-hb05': 6 },
    });

    expect(actions.completedCount).toBe(2);
    expect(actions.totalCount).toBe(4);
    expect(actions.progressPct).toBe(50);
    expect(actions.currentWave).toBe(1);
    expect(actions.criticalBlockers).toHaveLength(1);
    expect(actions.criticalBlockers[0].itemId).toBe('E');
    expect(actions.criticalBlockers[0].backupOwnerRole).toBe('HB01');
    expect(actions.criticalBlockers[0].fallbackDirective).toContain('HB01');
    expect(actions.overloadedSessions).toEqual([
      { sessionId: 'sess-hb05', queuedCount: 6, relatedItemIds: ['E'] },
    ]);
  });

  it('strips media protocol strings in summaries', () => {
    expect(sanitizeGoalSummaryText('报告 cindy-media://blobs/deadbeef.png 已生成')).toBe('报告 [图片] 已生成');
  });
});
