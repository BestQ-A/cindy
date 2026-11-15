import { describe, expect, it } from 'vitest';
import {
  buildMessageRenderItems,
  extractSessionPlanSteps,
  findLatestMessageTodoInsertion,
  findMessageTodoInsertions,
  type MessageRenderNormalizedMessage,
  type MessageRenderSourceMessageLike,
} from '../messageRender.js';

function toNormalized(source: MessageRenderSourceMessageLike): MessageRenderNormalizedMessage {
  return {
    key: source.clientId ?? source.id ?? 'msg',
    source,
    kind: 'tool',
    label: source.toolName ?? 'tool',
    body: '',
    createdAt: source.createdAt ?? '',
  };
}

function toolCall(
  id: string,
  toolName: string,
  toolInput: unknown,
  createdAt: string,
): MessageRenderSourceMessageLike {
  return {
    id,
    clientId: id,
    role: 'tool_use',
    toolUseId: id,
    toolName,
    toolInput,
    createdAt,
    content: '',
  };
}

function toolResult(
  id: string,
  toolUseId: string,
  content: string,
  createdAt: string,
): MessageRenderSourceMessageLike {
  return {
    id,
    clientId: id,
    role: 'tool_result',
    toolUseId,
    content,
    createdAt,
  };
}

describe('messageRender task dependencies and timeline steps', () => {
  it('tracks blockedBy, blocks, owner, and step lifecycle timestamps across TaskCreate and TaskUpdate', () => {
    const t1 = '2026-11-15T10:00:00.000Z';
    const t2 = '2026-11-15T10:01:00.000Z';
    const t3 = '2026-11-15T10:02:00.000Z';
    const t4 = '2026-11-15T10:05:00.000Z';
    const t5 = '2026-11-15T10:06:00.000Z';

    const messages: MessageRenderSourceMessageLike[] = [
      toolCall('c1', 'TaskCreate', { subject: 'Design API', owner: 'architect' }, t1),
      toolResult('r1', 'c1', 'Task #1 created successfully: Design API', t1),
      toolCall('c2', 'TaskCreate', { subject: 'Build UI', blockedBy: ['1'] }, t2),
      toolResult('r2', 'c2', 'Task #2 created successfully: Build UI', t2),
      toolCall('c3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, t3),
      toolResult('r3', 'c3', JSON.stringify({ task: { id: '1', status: 'in_progress' } }), t3),
      toolCall('c4', 'TaskUpdate', { taskId: '1', status: 'completed' }, t4),
      toolResult('r4', 'c4', JSON.stringify({ task: { id: '1', status: 'completed' } }), t4),
      toolCall(
        'c5',
        'TaskUpdate',
        { taskId: '2', status: 'in_progress', owner: 'frontend', addBlocks: ['3'] },
        t5,
      ),
      toolResult('r5', 'c5', JSON.stringify({ task: { id: '2', status: 'in_progress' } }), t5),
      toolCall('c6', 'TaskCreate', { id: '3', subject: 'Run E2E tests' }, t5),
      toolResult('r6', 'c6', 'Task #3 created successfully: Run E2E tests', t5),
    ];

    const latest = findLatestMessageTodoInsertion(messages);
    expect(latest).not.toBeNull();
    expect(latest?.startedAtMs).toBe(Date.parse(t1));
    expect(latest?.steps).toHaveLength(3);

    const [step1, step2, step3] = latest!.steps!;
    expect(step1).toMatchObject({
      stepId: '1',
      content: 'Design API',
      status: 'completed',
      owner: 'architect',
      blocks: ['2'],
      createdAtMs: Date.parse(t1),
      startedAtMs: Date.parse(t3),
      completedAtMs: Date.parse(t4),
      updatedAtMs: Date.parse(t4),
    });
    expect(step2).toMatchObject({
      stepId: '2',
      content: 'Build UI',
      status: 'in_progress',
      owner: 'frontend',
      blockedBy: ['1'],
      blocks: ['3'],
      createdAtMs: Date.parse(t2),
      startedAtMs: Date.parse(t5),
      updatedAtMs: Date.parse(t5),
    });
    expect(step3).toMatchObject({
      stepId: '3',
      content: 'Run E2E tests',
      status: 'pending',
      blockedBy: ['2'],
      createdAtMs: Date.parse(t5),
    });

    const items = buildMessageRenderItems(messages.map(toNormalized));
    const todoItem = items.find((item) => item.type === 'todo');
    expect(todoItem?.type).toBe('todo');
    if (todoItem?.type === 'todo') {
      expect(todoItem.steps).toEqual(latest?.steps);
      expect(todoItem.startedAtMs).toBe(Date.parse(t1));
    }
  });

  it('parses blockedBy and owner tags from plain TaskList output and cleans deleted refs', () => {
    const t1 = '2026-11-15T11:00:00.000Z';
    const t2 = '2026-11-15T11:01:00.000Z';
    const t3 = '2026-11-15T11:02:00.000Z';

    const messages: MessageRenderSourceMessageLike[] = [
      toolCall('tl1', 'TaskList', {}, t1),
      toolResult(
        'tlr1',
        'tl1',
        [
          '#1 [completed] Inspect database [owner: cindy]',
          '#2 [pending] Migrate schema [blocked by #1] [owner: worker-a]',
          '#3 [pending] Verify UI [blockedBy: 2]',
        ].join('\n'),
        t1,
      ),
      toolCall('tu1', 'TaskUpdate', { taskId: '2', status: 'deleted' }, t2),
      toolResult('tur1', 'tu1', JSON.stringify({ task: { id: '2', status: 'deleted' } }), t2),
      toolCall('tu2', 'TaskUpdate', { taskId: '3', addBlockedBy: ['1'], status: 'in_progress' }, t3),
      toolResult('tur2', 'tu2', JSON.stringify({ task: { id: '3', status: 'in_progress' } }), t3),
    ];

    const insertions = findMessageTodoInsertions(messages);
    const [onlyInsertion] = [...insertions.values()];
    expect(onlyInsertion.steps).toHaveLength(2);
    expect(onlyInsertion.steps?.[0]).toMatchObject({
      stepId: '1',
      status: 'completed',
      owner: 'cindy',
      blocks: ['3'],
    });
    expect(onlyInsertion.steps?.[1]).toMatchObject({
      stepId: '3',
      status: 'in_progress',
      blockedBy: ['1'],
      startedAtMs: Date.parse(t3),
    });
  });

  it('reconciles TodoWrite step timelines across updates without altering plain todos format', () => {
    const t1 = '2026-11-15T12:00:00.000Z';
    const t2 = '2026-11-15T12:03:00.000Z';

    const messages: MessageRenderSourceMessageLike[] = [
      toolCall(
        'tw1',
        'TodoWrite',
        {
          todos: [
            { stepId: 'fetch', content: 'Fetch data', status: 'in_progress', owner: 'bot-a' },
            {
              stepId: 'render',
              content: 'Render chart',
              status: 'pending',
              blockedBy: ['fetch'],
            },
          ],
        },
        t1,
      ),
      toolCall(
        'tw2',
        'TodoWrite',
        {
          todos: [
            { stepId: 'fetch', content: 'Fetch data', status: 'completed', owner: 'bot-a' },
            {
              stepId: 'render',
              content: 'Render chart',
              status: 'in_progress',
              blockedBy: ['fetch'],
            },
          ],
        },
        t2,
      ),
    ];

    const plans = extractSessionPlanSteps(messages);
    expect(plans).toHaveLength(1);
    expect(plans[0].startedAtMs).toBe(Date.parse(t1));
    expect(plans[0].steps).toMatchObject([
      {
        stepId: 'fetch',
        content: 'Fetch data',
        status: 'completed',
        owner: 'bot-a',
        blocks: ['render'],
        createdAtMs: Date.parse(t1),
        startedAtMs: Date.parse(t1),
        completedAtMs: Date.parse(t2),
        updatedAtMs: Date.parse(t2),
      },
      {
        stepId: 'render',
        content: 'Render chart',
        status: 'in_progress',
        blockedBy: ['fetch'],
        createdAtMs: Date.parse(t1),
        startedAtMs: Date.parse(t2),
        updatedAtMs: Date.parse(t2),
      },
    ]);
  });
});
