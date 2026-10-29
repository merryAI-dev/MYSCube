import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  auth: { user: { uid: 'test-user' }, isAuthenticated: true, isLoading: false },
  firebase: { db: {}, isOnline: true, orgId: 'demo-cashflow-read' },
}));
vi.mock('./auth-store', () => ({ useAuth: () => mocks.auth }));
vi.mock('../lib/firebase-context', () => ({ useFirebase: () => mocks.firebase }));
vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => args, query: (...args: unknown[]) => args,
  where: (...args: unknown[]) => args, limit: (n: number) => n,
  getDocs: mocks.getDocs,
}));
vi.mock('../lib/firebase', () => ({ getOrgCollectionPath: (org: string, name: string) => `${org}/${name}` }));
vi.mock('../lib/platform-bff-client', () => ({}));
import { CashflowWeekProvider, useCashflowWeeks } from './cashflow-weeks-store';

let state: ReturnType<typeof useCashflowWeeks>;
let root: ReactTestRenderer;
function Probe() { state = useCashflowWeeks(); return null; }
const tree = (loadWeeks?: boolean) => React.createElement(CashflowWeekProvider, { loadWeeks, children: React.createElement(Probe) });
beforeEach(() => { mocks.getDocs.mockReset().mockResolvedValue({ docs: [] }); });
afterEach(() => { act(() => root?.unmount()); });

it('keeps month navigation without reading weeks or completion documents', async () => {
  await act(async () => { root = create(tree(false)); });
  expect(mocks.getDocs).not.toHaveBeenCalled();
  act(() => state.setYearMonth('2026-10'));
  act(() => state.goNextMonth());
  expect(state.yearMonth).toBe('2026-11');
  act(() => state.goPrevMonth());
  expect(state.yearMonth).toBe('2026-10');
  expect(state.isLoading).toBe(false);
  expect(mocks.getDocs).not.toHaveBeenCalled();
  await act(async () => root.update(tree()));
  expect(mocks.getDocs).toHaveBeenCalledTimes(2);
  expect(state.yearMonth).toBe('2026-10');
});

it('discards an in-flight detail read after switching to overview', async () => {
  let resolve!: (value: unknown) => void;
  mocks.getDocs.mockReturnValue(new Promise((done) => { resolve = done; }));
  await act(async () => { root = create(tree(true)); });
  expect(mocks.getDocs).toHaveBeenCalledTimes(2);
  expect(state.isLoading).toBe(true);
  await act(async () => root.update(tree(false)));
  await act(async () => resolve({ docs: [{ data: () => ({ projectId: 'synthetic', yearMonth: '2026-10', weekNo: 1 }) }] }));
  expect(state.weeks).toEqual([]);
  expect(state.weeklySettlementCompletedKeys).toEqual([]);
  expect(state.isLoading).toBe(false);
});
