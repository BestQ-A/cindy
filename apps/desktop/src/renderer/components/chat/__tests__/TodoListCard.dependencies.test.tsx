// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlinePlanCard, TodoListCard, type PlanStepTimeline } from '../TodoListCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'chat.planPill.step' && opts) {
        return `Step ${opts.current} / ${opts.total}`;
      }
      if (typeof opts?.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
  }),
}));

afterEach(cleanup);

const STEPS: PlanStepTimeline[] = [
  {
    stepId: '1',
    content: 'Analyze schema',
    status: 'completed',
    owner: 'architect',
    blocks: ['2'],
    createdAtMs: 1_000_000,
    startedAtMs: 1_000_000,
    completedAtMs: 1_045_000,
  },
  {
    stepId: '2',
    content: 'Build graph view',
    status: 'in_progress',
    owner: 'frontend',
    blockedBy: ['1'],
    blocks: ['3'],
    createdAtMs: 1_000_000,
    startedAtMs: 1_045_000,
    updatedAtMs: 1_075_000,
  },
  {
    stepId: '3',
    content: 'Verify deployment',
    status: 'pending',
    blockedBy: ['2'],
    createdAtMs: 1_000_000,
  },
];

describe('InlinePlanCard & TodoListCard dependency and timeline views', () => {
  it('renders blocker count, step dependencies, owner tags, and switches between list, gantt, and dag views', () => {
    const todos = STEPS.map((s) => ({
      content: s.content,
      status: s.status,
      ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
      ...(s.owner ? { owner: s.owner } : {}),
    }));

    const { container } = render(
      <InlinePlanCard todos={todos} steps={STEPS} startedAtMs={1_000_000} animated={false} />,
    );

    expect(container.querySelector('[data-inline-plan-dep-count="2"]')).not.toBeNull();
    expect(container.querySelector('[data-inline-plan-blocked-by="1"]')).not.toBeNull();
    expect(screen.getByText('architect')).toBeTruthy();

    // Switch to timeline (Gantt)
    fireEvent.click(screen.getByRole('tab', { name: '时间轴' }));
    expect(container.querySelector('[data-inline-plan-gantt="true"]')).not.toBeNull();
    expect(container.querySelector('[data-plan-gantt-bar="1"]')).not.toBeNull();
    expect(container.querySelector('[data-plan-gantt-bar="2"]')).not.toBeNull();

    // Switch to dependency graph (DAG)
    fireEvent.click(screen.getByRole('tab', { name: '依赖图' }));
    expect(container.querySelector('[data-inline-plan-dag="true"]')).not.toBeNull();
    expect(container.querySelector('[data-plan-dag-node="1"]')).not.toBeNull();
    expect(container.querySelector('[data-plan-dag-node="3"]')).not.toBeNull();
  });

  it('shows blockedBy and duration pills inside TodoListCard flyout', () => {
    const todos = STEPS.map((s) => ({
      content: s.content,
      status: s.status,
    }));

    render(<TodoListCard todos={todos} steps={STEPS} startedAtMs={1_000_000} animated={false} />);

    const trigger = screen.getByRole('button', { name: 'Step 2 / 3' });
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);

    expect(screen.getByText('←1')).toBeTruthy();
    expect(screen.getByText('←2')).toBeTruthy();
    expect(screen.getByText('45s')).toBeTruthy();
    expect(screen.getByText('30s')).toBeTruthy();
  });
});
