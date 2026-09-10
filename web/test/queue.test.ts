import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreateEventsBody, CreateEventsResult } from '@creche/shared';
import {
  applyOutcome,
  backoffMs,
  bodyForSend,
  createQueueItem,
  isQueueLate,
  markSending,
  nextToSend,
  notApplied,
  pruneQueue,
  queueCounts,
  type StoredQueueItem,
} from '../src/gate/queueLogic';

const body: CreateEventsBody = {
  type: 'checkin',
  guardianId: '11111111-1111-4111-8111-111111111111',
  method: 'code',
  credentialId: '22222222-2222-4222-8222-222222222222',
  events: [
    { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', childId: 'c1111111-1111-4111-8111-111111111111' },
    { clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', childId: 'c2222222-2222-4222-8222-222222222222' },
  ],
};

function item(overrides: Partial<StoredQueueItem> = {}): StoredQueueItem {
  return { ...createQueueItem(body, { type: 'checkin', childNames: ['Ana', 'Pedro'], personName: 'Maria' }, 'batch-1', '2026-09-10T10:00:00.000Z', 2), ...overrides };
}

const okResult: CreateEventsResult = {
  batchId: 'batch-1',
  undoUntil: '2026-09-10T10:01:00.000Z',
  results: [
    { clientId: body.events[0].clientId, childId: body.events[0].childId, status: 'created' },
    { clientId: body.events[1].clientId, childId: body.events[1].childId, status: 'rejected', error: { code: 'INVALID_STATE', message: 'Já está na creche' } },
  ],
  warnings: [],
};

test('pending → sending → sent keeps the result', () => {
  const sending = markSending(item(), '2026-09-10T10:00:01.000Z');
  assert.equal(sending.status, 'sending');
  assert.equal(sending.lastAttemptAt, '2026-09-10T10:00:01.000Z');
  const t = applyOutcome(sending, { kind: 'ok', result: okResult }, '2026-09-10T10:00:02.000Z');
  assert.equal(t.item.status, 'sent');
  assert.equal(t.retry, false);
  assert.deepEqual(t.item.result, okResult);
  assert.equal(t.item.lastError, null);
});

test('4xx → rejected (never retried); 401 → needs_login', () => {
  const sending = markSending(item(), '2026-09-10T10:00:01.000Z');
  const rejected = applyOutcome(sending, { kind: 'http', status: 400, code: 'VALIDATION', message: 'Corpo inválido' }, '2026-09-10T10:00:02.000Z');
  assert.equal(rejected.item.status, 'rejected');
  assert.equal(rejected.retry, false);
  assert.match(rejected.item.lastError ?? '', /VALIDATION/);

  const login = applyOutcome(sending, { kind: 'http', status: 401, code: 'UNAUTHORIZED' }, '2026-09-10T10:00:02.000Z');
  assert.equal(login.item.status, 'needs_login');
  assert.equal(login.retry, false);
});

test('5xx / network / timeout → pending with backoff 2 s → 60 s', () => {
  let current = markSending(item(), '2026-09-10T10:00:01.000Z');
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    const outcome = i % 3 === 0 ? ({ kind: 'http', status: 503 } as const) : i % 3 === 1 ? ({ kind: 'network' } as const) : ({ kind: 'timeout' } as const);
    const t = applyOutcome(current, outcome, '2026-09-10T10:00:02.000Z');
    assert.equal(t.item.status, 'pending');
    assert.equal(t.retry, true);
    assert.equal(t.item.attempts, i + 1);
    delays.push(t.retryInMs);
    current = markSending(t.item, '2026-09-10T10:00:03.000Z');
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(backoffMs(0), 2000);
});

test('bodyForSend marks queued for retries and old items', () => {
  const fresh = item();
  assert.equal(bodyForSend(fresh, '2026-09-10T10:00:10.000Z', '2026-09-10T09:00:00.000Z').queued, false);
  assert.equal(bodyForSend(fresh, '2026-09-10T10:00:10.000Z', '2026-09-10T09:00:00.000Z').directoryGeneratedAt, '2026-09-10T09:00:00.000Z');
  assert.equal(bodyForSend(item({ attempts: 1 }), '2026-09-10T10:00:10.000Z', null).queued, true);
  assert.equal(bodyForSend(fresh, '2026-09-10T10:02:00.000Z', null).queued, true);
});

test('nextToSend is FIFO over pending items only', () => {
  const items = [
    item({ batchId: 'b', createdAt: '2026-09-10T10:00:02.000Z' }),
    item({ batchId: 'a', createdAt: '2026-09-10T10:00:01.000Z' }),
    item({ batchId: 'sent', createdAt: '2026-09-10T09:00:00.000Z', status: 'sent' }),
    item({ batchId: 'login', createdAt: '2026-09-10T09:00:00.000Z', status: 'needs_login' }),
  ];
  assert.equal(nextToSend(items)?.batchId, 'a');
  assert.equal(nextToSend([]), null);
});

test('counts, late chip and "não aplicados"', () => {
  const items = [
    item({ batchId: 'p', createdAt: '2026-09-10T10:00:00.000Z' }),
    item({ batchId: 'l', status: 'needs_login', createdAt: '2026-09-10T09:30:00.000Z' }),
    item({ batchId: 'r', status: 'rejected', lastError: 'VALIDATION: inválido', updatedAt: '2026-09-10T10:05:00.000Z' }),
    item({ batchId: 's', status: 'sent', result: okResult, updatedAt: '2026-09-10T10:06:00.000Z' }),
  ];
  const counts = queueCounts(items);
  assert.equal(counts.pending, 1);
  assert.equal(counts.needsLogin, 1);
  assert.equal(counts.rejected, 1);
  assert.equal(counts.sent, 1);
  assert.equal(counts.waiting, 2);
  assert.equal(counts.oldestWaitingAt, '2026-09-10T09:30:00.000Z');
  assert.equal(isQueueLate(counts, Date.parse('2026-09-10T09:35:00.000Z')), false);
  assert.equal(isQueueLate(counts, Date.parse('2026-09-10T09:41:00.000Z')), true);

  const na = notApplied(items);
  assert.equal(na.length, 2);
  assert.equal(na[0].batchId, 's');
  assert.equal(na[0].childName, 'Pedro');
  assert.equal(na[0].code, 'INVALID_STATE');
  assert.equal(na[1].batchId, 'r');
  assert.equal(na[1].code, 'VALIDATION');
});

test('pruneQueue drops clean sent items after 24 h but keeps rejections', () => {
  const clean: StoredQueueItem = item({ batchId: 'clean', status: 'sent', result: { ...okResult, results: [okResult.results[0]] }, updatedAt: '2026-09-09T09:00:00.000Z' });
  const dirty: StoredQueueItem = item({ batchId: 'dirty', status: 'sent', result: okResult, updatedAt: '2026-09-09T09:00:00.000Z' });
  const recent: StoredQueueItem = item({ batchId: 'recent', status: 'sent', result: { ...okResult, results: [okResult.results[0]] }, updatedAt: '2026-09-10T09:00:00.000Z' });
  const kept = pruneQueue([clean, dirty, recent, item()], '2026-09-10T10:00:00.000Z').map((i) => i.batchId);
  assert.deepEqual(kept, ['dirty', 'recent', 'batch-1']);
});
