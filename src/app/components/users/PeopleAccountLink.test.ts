import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), link: vi.fn() }));
vi.mock('../../lib/platform-bff-client', () => ({ fetchPeopleLinkCandidatesViaBff: mocks.fetch, linkGovernancePersonViaBff: mocks.link }));
import { PeopleAccountLink, prioritizePeople, hasVerifiedPeopleLink } from './PeopleAccountLink';
let root: ReactTestRenderer;
const refreshed = vi.fn().mockResolvedValue(undefined);
const readiness = vi.fn();
const directory = { identityKey: 'staff@example.com', authUid: 'uid-staff', authVerified: true, authIssue: null, linkedPersonId: null, people: [{ personId: 'person-a', name: 'Synthetic', nickname: 'Staff', email: 'staff@example.com', linkedUid: null, expectedPersonVersion: 'version-1' }], emailMatchPersonIds: ['person-a'] };
const linked = { ...directory, linkedPersonId: 'person-a', people: [{ ...directory.people[0], linkedUid: directory.authUid }] };
const props = { identityKey: directory.identityKey, email: directory.identityKey, actor: { uid: 'admin' }, tenantId: 'test', onLinked: refreshed, onLinkState: readiness };
beforeEach(async () => {
  const storage = new Map<string,string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key:string,value:string) => storage.set(key,value), removeItem: (key:string) => storage.delete(key) });
  mocks.fetch.mockReset().mockResolvedValue(directory); mocks.link.mockReset().mockResolvedValue({ status: 'LINKED' }); refreshed.mockClear(); readiness.mockClear();
  await act(async () => { root = create(React.createElement(PeopleAccountLink, props)); });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const buttons = () => root.root.findAllByType('button');
async function selectPerson() {
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'person-a' } }));
  act(() => root.root.findAllByType('input')[0].props.onChange({ target: { value: 'Confirmed by supervisor' } }));
  act(() => root.root.findAllByType('input')[1].props.onChange({ target: { checked: true } }));
}
it('automatically reads candidates but never auto-selects even a unique matching email', async () => {
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(root.root.findByType('select').props.value).toBe(''); expect(buttons()[1].props.disabled).toBe(true);
  expect(JSON.stringify(root.toJSON())).toContain('이메일과 직원 정보를 대조해 주세요. 계정을 연결한 다음 역할을 승인할 수 있어요.');
  act(() => root.root.findByType('select').props.onChange({ target: { value: 'person-a' } })); expect(buttons()[1].props.disabled).toBe(true);
  expect(mocks.link).not.toHaveBeenCalled();
});
it('prioritizes exact email candidates without changing input order', () => {
  const other = { ...directory.people[0], personId: 'person-b', name: 'A', email: 'other@example.com' };
  const input = { ...directory, people: [other, directory.people[0]] };
  expect(prioritizePeople(input).map(p=>p.personId)).toEqual(['person-a','person-b']);
  expect(input.people[0].personId).toBe('person-b');
});
it('links selected identity/version with a stable key, then verifies state without granting a role', async () => {
  await selectPerson(); mocks.fetch.mockResolvedValue(linked);
  await act(async () => { await buttons()[1].props.onClick(); });
  expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ expectedAuthUid:'uid-staff', personId: 'person-a', expectedPersonVersion: 'version-1', reason: 'Confirmed by supervisor', idempotencyKey: expect.any(String) }));
  expect(mocks.link.mock.calls[0][0]).not.toHaveProperty('role'); expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(refreshed).toHaveBeenCalledOnce();
  expect(readiness).toHaveBeenLastCalledWith(directory.identityKey,true);
  expect(JSON.stringify(root.toJSON())).toContain('2단계에서 승인된 역할');
  expect(root.root.findAllByType('select')).toHaveLength(0);
  expect(buttons()).toHaveLength(1);
});
it('preserves selected person and evidence for a definite conflict', async () => {
  mocks.link.mockRejectedValue({ status:409, code: 'people_uid_conflict' }); await selectPerson(); await act(async () => { await buttons()[1].props.onClick(); });
  expect(root.root.findByType('select').props.value).toBe('person-a'); expect(root.root.findAllByType('input')[0].props.value).toBe('Confirmed by supervisor');
  expect(JSON.stringify(root.toJSON())).toContain('다른 로그인 계정'); expect(refreshed).not.toHaveBeenCalled();
});
it('does not retry an acknowledged write when readback fails; refresh resolves it', async () => {
  await selectPerson(); mocks.fetch.mockRejectedValue(new Error('offline'));
  await act(async () => { await buttons()[1].props.onClick(); });
  expect(JSON.stringify(root.toJSON())).toContain('서버가 계정 연결 완료를 응답했습니다');
  expect(buttons()[1].props.disabled).toBe(true); expect(mocks.link).toHaveBeenCalledOnce();
  mocks.fetch.mockResolvedValue(linked); await act(async()=>{await buttons()[0].props.onClick();});
  expect(mocks.link).toHaveBeenCalledOnce(); expect(readiness).toHaveBeenLastCalledWith(directory.identityKey,true);
});
it('requires readback after ambiguous failure and resends the exact same command and key', async () => {
  await selectPerson(); mocks.link.mockRejectedValueOnce(new Error('timeout')); mocks.fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async()=>{await buttons()[1].props.onClick();}); const first=mocks.link.mock.calls[0][0];
  expect(buttons()[1].props.disabled).toBe(true);
  mocks.fetch.mockResolvedValue(directory); await act(async()=>{await buttons()[0].props.onClick();}); expect(buttons()[1].props.disabled).toBe(false);
  mocks.fetch.mockResolvedValue(linked); await act(async()=>{await buttons()[1].props.onClick();});
  expect(mocks.link.mock.calls[1][0]).toEqual(first);
});
it('retains an uncertain request after remount for the same actor only', async () => {
  await selectPerson(); mocks.link.mockRejectedValue(new Error('timeout')); mocks.fetch.mockRejectedValue(new Error('offline'));
  await act(async()=>{await buttons()[1].props.onClick();}); const first=mocks.link.mock.calls[0][0];
  act(()=>root.unmount()); mocks.fetch.mockResolvedValue(directory);
  await act(async()=>{root=create(React.createElement(PeopleAccountLink,props));});
  mocks.link.mockResolvedValue({status:'LINKED'});mocks.fetch.mockResolvedValue(linked);
  await act(async()=>{await buttons()[1].props.onClick();});expect(mocks.link.mock.calls[1][0]).toEqual(first);
  act(()=>root.unmount());mocks.fetch.mockResolvedValue(directory);
  await act(async()=>{root=create(React.createElement(PeopleAccountLink,{...props,actor:{uid:'different-admin'}}));});
  expect(root.root.findByType('select').props.value).toBe('');expect(buttons()[1].props.disabled).toBe(true);
});
it('blocks unverified targets and does not announce role readiness', async () => {
  mocks.fetch.mockResolvedValue({ ...directory, authVerified: false, authIssue: 'auth_identity_unverified' });
  await act(async () => { await buttons()[0].props.onClick(); }); expect(root.root.findByType('select').props.disabled).toBe(true); expect(buttons()[1].props.disabled).toBe(true);
  expect(readiness).toHaveBeenLastCalledWith(directory.identityKey,false);
});
it('does not permit retry after the target account was replaced', async () => {
  await selectPerson();mocks.link.mockRejectedValue(new Error('timeout'));mocks.fetch.mockResolvedValue({...directory,authUid:'replacement'});
  await act(async()=>{await buttons()[1].props.onClick();});expect(buttons()[1].props.disabled).toBe(true);
  expect(JSON.stringify(root.toJSON())).toContain('추가 변경을 중단');
});

it('requires the linked roster email to match the verified login before role readiness', () => {
  expect(hasVerifiedPeopleLink(linked)).toBe(true);
  expect(hasVerifiedPeopleLink({ ...linked, people: [{ ...linked.people[0], email: 'different@example.com' }] })).toBe(false);
  expect(hasVerifiedPeopleLink({ ...linked, people: [{ ...linked.people[0], email: '' }] })).toBe(false);
});
it('discards stale reads after tenant or token context changes and clears selection', async () => {
  await selectPerson();
  let finish!: (value: unknown) => void;
  mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async()=>{root.update(React.createElement(PeopleAccountLink,{...props,actor:{uid:'admin',idToken:'old-read'}}));});
  mocks.fetch.mockResolvedValue({...directory, authUid:'tenant-new',authVerified:false,authIssue:'auth_identity_unverified'});
  await act(async()=>{root.update(React.createElement(PeopleAccountLink,{...props,tenantId:'new-tenant',actor:{uid:'different-admin',idToken:'fresh'}}));});
  await act(async()=>{finish(linked);});
  expect(root.root.findByType('select').props.value).toBe('');
  expect(JSON.stringify(root.toJSON())).toContain('tenant-new');
  expect(JSON.stringify(root.toJSON())).not.toContain('본인 계정 연결 확인 완료');
  expect(readiness).toHaveBeenLastCalledWith(directory.identityKey,false);
});
