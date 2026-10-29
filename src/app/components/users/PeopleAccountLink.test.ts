import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), link: vi.fn() }));
vi.mock('../../lib/platform-bff-client', () => ({ fetchPeopleLinkCandidatesViaBff: mocks.fetch, linkGovernancePersonViaBff: mocks.link }));
import { PeopleAccountLink } from './PeopleAccountLink';
let root: ReactTestRenderer;
const refreshed = vi.fn().mockResolvedValue(undefined);
const directory = { identityKey: 'staff@example.com', authUid: 'uid-staff', authVerified: true, authIssue: null, linkedPersonId: null, people: [{ personId: 'person-a', name: 'Synthetic', nickname: 'Staff', email: '', linkedUid: null, expectedPersonVersion: 'version-1' }], emailMatchPersonIds: ['person-a'] };
beforeEach(async () => { mocks.fetch.mockReset().mockResolvedValue(directory); mocks.link.mockReset().mockResolvedValue({ status: 'LINKED' }); refreshed.mockClear(); await act(async () => { root = create(React.createElement(PeopleAccountLink, { identityKey: 'staff@example.com', email: 'staff@example.com', actor: { uid: 'admin' }, tenantId: 'test', onLinked: refreshed })); }); });
afterEach(() => act(() => root.unmount()));
const buttons = () => root.root.findAllByType('button');
async function selectPerson() {
  await act(async () => { await buttons()[0].props.onClick(); });
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'person-a' } }));
  act(() => root.root.findAllByType('input')[0].props.onChange({ target: { value: 'Confirmed by supervisor' } }));
  act(() => root.root.findAllByType('input')[1].props.onChange({ target: { checked: true } }));
}
it('never auto-selects even a unique matching email; requires selection, reason and explicit confirmation', async () => {
  await act(async () => { await buttons()[0].props.onClick(); });
  expect(root.root.findByType('select').props.value).toBe(''); expect(buttons()[1].props.disabled).toBe(true);
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'person-a' } })); expect(buttons()[1].props.disabled).toBe(true);
  expect(mocks.link).not.toHaveBeenCalled();
});
it('links only selected identity/version, then rereads state without approving a role', async () => {
  await selectPerson(); await act(async () => { await buttons()[1].props.onClick(); });
  expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ personId: 'person-a', expectedPersonVersion: 'version-1', reason: 'Confirmed by supervisor' }));
  expect(mocks.link.mock.calls[0][0]).not.toHaveProperty('role'); expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(refreshed).toHaveBeenCalledOnce();
  expect(JSON.stringify(root.toJSON())).toContain('승인된 역할을 선택');
});
it('preserves selected person and evidence when linking fails, and explains the conflict', async () => {
  mocks.link.mockRejectedValue({ code: 'people_uid_conflict' }); await selectPerson(); await act(async () => { await buttons()[1].props.onClick(); });
  expect(root.root.findByType('select').props.value).toBe('person-a'); expect(root.root.findAllByType('input')[0].props.value).toBe('Confirmed by supervisor');
  expect(JSON.stringify(root.toJSON())).toContain('다른 로그인 계정'); expect(refreshed).not.toHaveBeenCalled();
});
it('blocks unverified target even after selection', async () => {
  mocks.fetch.mockResolvedValue({ ...directory, authVerified: false, authIssue: 'auth_identity_unverified' });
  await act(async () => { await buttons()[0].props.onClick(); }); expect(root.root.findByType('select').props.disabled).toBe(true); expect(buttons()[1].props.disabled).toBe(true);
});
