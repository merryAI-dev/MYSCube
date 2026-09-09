import { describe, expect, it } from 'vitest';
import * as routes from './routes/jvm-weekly-api.mjs';

describe('BFF consumes JVM settlement eligibility', () => {
  it('does not infer eligibility from a missing upstream field', () => {
    expect(routes.readProjectSettlementEligibility?.(undefined)).toEqual({ status: 'UNAVAILABLE', weekly: false, monthly: false, writable: false });
  });
  it('preserves the immediate closure contract', () => {
    const closed = { status: 'CLOSED', weekly: false, monthly: false, writable: false };
    expect(routes.readProjectSettlementEligibility?.(closed)).toEqual(closed);
    expect(routes.readProjectSettlementEligibility?.({ ...closed, monthly: true })?.status).toBe('UNAVAILABLE');
  });
});
