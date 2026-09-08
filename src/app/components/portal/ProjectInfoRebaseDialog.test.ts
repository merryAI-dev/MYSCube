import { expect, it } from 'vitest';
import { displayValue } from './ProjectInfoRebaseDialog';

it('shows actual differing annual amounts and monthly participation rates', () => {
  expect(displayValue([{ year: 2026, contractAmount: 1000 }])).toContain('1,000');
  expect(displayValue([{ year: 2026, contractAmount: 1000 }])).not.toBe(displayValue([{ year: 2026, contractAmount: 2000 }]));
  const person = { memberName: '메리', monthlyRates: { '2026-01': 10 } };
  expect(displayValue([person])).toContain('월별 참여율');
  expect(displayValue([person])).not.toBe(displayValue([{ ...person, monthlyRates: { '2026-01': 20 } }]));
});
