import { useEffect, useRef, useState } from 'react';
import { fetchPeopleLinkCandidatesViaBff, linkGovernancePersonViaBff, type ActorLike, type PeopleLinkCandidates } from '../../lib/platform-bff-client';
import { governanceErrorMessage } from './auth-governance-errors';
import { isUncertainGovernanceError, newGovernanceOperation, operationStorageKey, readGovernanceOperation, saveGovernanceOperation, type GovernanceOperation } from './governance-operation';

type LinkBody = { personId: string; expectedAuthUid: string; expectedPersonVersion: string; reason: string };
export function hasVerifiedPeopleLink(directory: PeopleLinkCandidates) {
  return directory.authVerified && !!directory.authUid && !!directory.linkedPersonId
    && directory.people.filter((person) => person.linkedUid === directory.authUid).length === 1
    && directory.people.some((person) => person.personId === directory.linkedPersonId && person.linkedUid === directory.authUid && person.email.trim().toLowerCase() === directory.identityKey.trim().toLowerCase());
}
export function prioritizePeople(directory: PeopleLinkCandidates) {
  const matches = new Set(directory.emailMatchPersonIds);
  return [...directory.people].sort((a, b) => Number(matches.has(b.personId)) - Number(matches.has(a.personId)) || a.name.localeCompare(b.name, 'ko'));
}
export function PeopleAccountLink({ identityKey, email, actor, tenantId, onLinked, onLinkState }: { identityKey: string; email: string; actor: ActorLike; tenantId: string; onLinked: () => Promise<void>; onLinkState?: (identityKey: string, ready: boolean) => void }) {
  const [directory, setDirectory] = useState<PeopleLinkCandidates | null>(null);
  const [personId, setPersonId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = operationStorageKey(tenantId, actor.uid, identityKey, 'link');
  const [pending, setPending] = useState<GovernanceOperation<LinkBody> | null>(() => readGovernanceOperation(key));
  const [retryReady, setRetryReady] = useState(false);
  const callbacks = useRef({ onLinked, onLinkState });
  callbacks.current = { onLinked, onLinkState };
  const mounted = useRef(true);
  const generation = useRef(0);
  const refreshSequence = useRef(0);
  const selected = directory?.people.find((person) => person.personId === personId);
  const persist = (operation: GovernanceOperation<LinkBody> | null) => { saveGovernanceOperation(key, operation); setPending(operation); };
  const refresh = async (operation = pending) => {
    const currentGeneration = generation.current;
    const sequence = ++refreshSequence.current;
    callbacks.current.onLinkState?.(identityKey, false);
    setRetryReady(false);
    const next = await fetchPeopleLinkCandidatesViaBff({ identityKey, actor, tenantId });
    if (!mounted.current || currentGeneration !== generation.current || sequence !== refreshSequence.current) return;
    setDirectory(next);
    callbacks.current.onLinkState?.(identityKey, hasVerifiedPeopleLink(next));
    if (operation) {
      if (hasVerifiedPeopleLink(next) && next.linkedPersonId === operation.body.personId && next.authUid === operation.body.expectedAuthUid) {
        persist(null); setConfirmed(false);
        setMessage('직원과 로그인 계정의 연결을 확인했습니다. 2단계에서 승인된 역할을 반영해 주세요.');
        await callbacks.current.onLinked();
      } else if (operation.acknowledged) {
        setMessage('서버는 연결 완료를 응답했지만 현재 조회 결과와 다릅니다. 다시 연결하지 말고 관리자에게 확인해 주세요.');
      } else if (next.authUid !== operation.body.expectedAuthUid || !next.authVerified || next.linkedPersonId) {
        setMessage('이전 요청 이후 계정 또는 연결 상태가 달라졌습니다. 추가 변경을 중단하고 관리자에게 확인해 주세요.');
      } else {
        setRetryReady(true);
        setMessage('아직 연결되지 않은 상태를 확인했습니다. 동일한 요청을 안전하게 다시 확인할 수 있습니다.');
      }
    }
  };
  const load = async (operation = pending) => {
    const currentGeneration = generation.current;
    setBusy(true); setMessage(''); setConfirmed(false);
    try { await refresh(operation); }
    catch (error) { if (mounted.current && currentGeneration === generation.current) setMessage(operation ? '연결 요청 결과가 아직 확인되지 않았습니다. 상태 조회를 다시 시도해 주세요. 새 연결 요청은 보내지 않습니다.' : governanceErrorMessage(error)); }
    finally { if (mounted.current && currentGeneration === generation.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    setDirectory(null); setPersonId(''); setReason(''); setConfirmed(false);
    const operation = readGovernanceOperation<LinkBody>(key);
    setPending(operation);
    void load(operation);
    return () => { mounted.current = false; generation.current += 1; callbacks.current.onLinkState?.(identityKey, false); };
  }, [identityKey, tenantId, actor.uid, actor.idToken]);
  const link = async () => {
    if (busy || (pending && !retryReady)) return;
    if (!pending && (!selected || !confirmed || !reason.trim() || !directory?.authVerified || !directory.authUid)) return;
    const currentGeneration = generation.current;
    const operation = pending || newGovernanceOperation(actor.uid, { personId, expectedAuthUid: directory!.authUid!, expectedPersonVersion: selected!.expectedPersonVersion, reason: reason.trim() });
    persist(operation); setBusy(true); setMessage(''); setRetryReady(false);
    callbacks.current.onLinkState?.(identityKey, false);
    let acknowledged = operation;
    try {
      await linkGovernancePersonViaBff({ identityKey, actor, tenantId, ...operation.body, idempotencyKey: operation.idempotencyKey });
      acknowledged = { ...operation, acknowledged: true };
      saveGovernanceOperation(key, acknowledged);
      if (!mounted.current || currentGeneration !== generation.current) return;
      setPending(acknowledged);
    } catch (error) {
      if (!mounted.current || currentGeneration !== generation.current) return;
      if (!isUncertainGovernanceError(error)) {
        persist(null); setMessage(governanceErrorMessage(error)); setBusy(false); return;
      }
    }
    try { await refresh(acknowledged); }
    catch {
      if (!mounted.current || currentGeneration !== generation.current) return;
      setMessage(acknowledged.acknowledged
        ? '서버가 계정 연결 완료를 응답했습니다. 최신 상태 조회가 실패했으므로 상태를 다시 확인해 주세요. 연결 요청을 다시 보내지 않습니다.'
        : '응답을 받지 못해 연결 결과가 불확실합니다. 상태를 다시 조회한 뒤 같은 요청을 확인해 주세요.');
    } finally { if (mounted.current && currentGeneration === generation.current) setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border p-3" aria-label="직원 계정 연결">
    <h3 className="font-semibold text-sm">1. 인력 명부와 로그인 계정 연결</h3>
    <p className="text-xs text-stone-600">명부에 이메일을 입력하는 것만으로 계정이 연결되지는 않습니다. 본인 확인 후 계정을 연결하고, 2단계에서 역할을 승인합니다.</p>
    <button type="button" className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => void load()}>{busy ? '연결 상태 확인 중' : '연결 상태 새로고침'}</button>
    {directory && <>
      <dl className="rounded bg-stone-50 p-3 text-sm space-y-1"><div><dt className="inline font-medium">로그인 이메일: </dt><dd className="inline">{email}</dd></div><div><dt className="inline font-medium">계정 확인: </dt><dd className="inline">{directory.authVerified ? 'Google 계정 검증 완료' : '검증되지 않음'}</dd></div><div><dt className="inline font-medium">로그인 UID: </dt><dd className="inline break-all">{directory.authUid || '없음'}</dd></div></dl>
      {!directory.authVerified && <p role="alert" className="text-sm text-red-700">{governanceErrorMessage({ code: directory.authIssue || 'auth_identity_unverified' })}</p>}
      {hasVerifiedPeopleLink(directory) && <p className="text-sm text-emerald-800">본인 계정 연결 확인 완료 · {directory.people.find((person) => person.personId === directory.linkedPersonId)?.name}. 2단계 역할 반영은 인력 명부에 연결된 승인 가능한 관리자가 수행합니다.</p>}
      <label className="block text-sm">연결할 직원
        <select aria-label="연결할 직원" className="mt-1 w-full border rounded p-2" value={personId} disabled={busy || !!pending || !directory.authVerified || hasVerifiedPeopleLink(directory)} onChange={(event) => { setPersonId(event.target.value); setConfirmed(false); }}>
          <option value="">본인 확인 후 직접 선택해 주세요</option>
          {prioritizePeople(directory).map((person) => <option key={person.personId} value={person.personId} disabled={!!person.linkedUid && person.linkedUid !== directory.authUid}>{directory.emailMatchPersonIds.includes(person.personId) ? '[이메일 일치] ' : ''}{person.name} {person.nickname ? `(${person.nickname})` : ''} · {person.email || '명부 이메일 없음'}{person.linkedUid ? ' · 연결됨' : ''}</option>)}
        </select>
      </label>
      {selected && <div className="rounded border p-3 text-sm"><p>선택한 직원: {selected.name} {selected.nickname && `(${selected.nickname})`}</p><p>명부 이메일: {selected.email || '없음 — 본인 확인 근거가 필요합니다'}</p><p className="break-all">연결된 UID: {selected.linkedUid || '없음'}</p><p>이름이나 이메일 일치만으로 본인 여부를 확정하지 않습니다.</p></div>}
      <label className="block text-sm">본인 확인 근거
        <input className="mt-1 w-full rounded border p-2" aria-label="본인 확인 근거" value={reason} maxLength={500} disabled={busy || !!pending || hasVerifiedPeopleLink(directory)} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} placeholder="직원에게 확인한 방법과 승인 근거" />
      </label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || !!pending || !selected || hasVerifiedPeopleLink(directory)} onChange={(event) => setConfirmed(event.target.checked)} />{selected ? `${selected.name} (${selected.nickname || selected.personId}) 직원의 로그인 계정이 ${email}임을 확인했습니다.` : '직원을 선택하고 로그인 계정의 본인 여부를 확인해 주세요.'}</label>
      <button type="button" className="rounded bg-stone-900 text-white px-3 py-2 text-sm disabled:opacity-50" disabled={busy || (pending ? !retryReady : (!selected || !confirmed || !reason.trim() || !directory.authVerified || hasVerifiedPeopleLink(directory)))} onClick={() => void link()}>{pending ? '같은 연결 요청 다시 확인' : '계정 연결 승인'}</button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
