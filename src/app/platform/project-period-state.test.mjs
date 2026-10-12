import test from 'node:test';
import assert from 'node:assert/strict';
import { isProjectContractEnded, kstCalendarDate } from './project-period-state.mjs';

test('uses the KST calendar day for the shared project-ended decision', () => {
  assert.equal(kstCalendarDate('2026-10-11T15:00:00Z'), '2026-10-12');
  assert.equal(kstCalendarDate('2026-10-12T00:00:00+09:00'), '2026-10-12');
  assert.equal(kstCalendarDate('2026-10-11T08:00:00-07:00'), '2026-10-12');
  assert.equal(isProjectContractEnded('2026-10-11', '2026-10-11T15:00:00Z'), true);
  assert.equal(isProjectContractEnded('2026-10-12', '2026-10-11T15:00:00Z'), false);
  assert.equal(isProjectContractEnded('2026-10-11', '2026-10-11T14:59:59Z'), false);
  assert.equal(isProjectContractEnded('2026-10-11', '2026-10-11T15:00:00Z'), true);
  assert.equal(isProjectContractEnded('', '2026-10-11T15:00:00Z'), false);
  assert.equal(isProjectContractEnded('2026-02-30', '2026-10-11T15:00:00Z'), false);
});
