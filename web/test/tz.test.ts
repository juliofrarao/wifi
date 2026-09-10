import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTime, monthRange, zoneOffsetMs, zonedToIso } from '../src/lib/tz';

test('zonedToIso converts wall-clock time in America/Sao_Paulo to UTC', () => {
  // São Paulo is UTC-3 (no DST since 2019).
  assert.equal(zonedToIso('2026-09-10', '07:45', 'America/Sao_Paulo'), '2026-09-10T10:45:00.000Z');
  assert.equal(zonedToIso('2026-09-10', '23:59:59', 'America/Sao_Paulo'), '2026-09-11T02:59:59.000Z');
  assert.equal(zonedToIso('2026-01-01', '00:00', 'UTC'), '2026-01-01T00:00:00.000Z');
});

test('zonedToIso handles DST zones', () => {
  // New York: EDT in July (UTC-4), EST in January (UTC-5).
  assert.equal(zonedToIso('2026-07-01', '12:00', 'America/New_York'), '2026-07-01T16:00:00.000Z');
  assert.equal(zonedToIso('2026-01-15', '12:00', 'America/New_York'), '2026-01-15T17:00:00.000Z');
  assert.equal(zoneOffsetMs(Date.UTC(2026, 0, 15, 12), 'America/Sao_Paulo'), -3 * 3600_000);
});

test('time validation and month ranges', () => {
  assert.equal(isValidTime('07:45'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('7:45'), false);
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
});
