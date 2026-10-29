import { useState } from 'react';
import { fetchPeopleLinkCandidatesViaBff, linkGovernancePersonViaBff, type ActorLike, type PeopleLinkCandidates } from '../../lib/platform-bff-client';
import { governanceErrorMessage } from './auth-governance-errors';

export function PeopleAccountLink({ identityKey, email, actor, tenantId, onLinked }: { identityKey: string; email: string; actor: ActorLike; tenantId: string; onLinked: () => Promise<void> }) {
  const [directory, setDirectory] = useState<PeopleLinkCandidates | null>(null);
  const [personId, setPersonId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selected = directory?.people.find((person) => person.personId === personId);
  const load = async () => {
    setBusy(true); setMessage(''); setConfirmed(false);
    try { setDirectory(await fetchPeopleLinkCandidatesViaBff({ identityKey, actor, tenantId })); }
    catch (error) { setMessage(governanceErrorMessage(error)); }
    finally { setBusy(false); }
  };
  const link = async () => {
    if (!selected || !confirmed || !reason.trim() || !directory?.authVerified || !directory.authUid) return;
    setBusy(true); setMessage('');
    try {
      await linkGovernancePersonViaBff({ identityKey, actor, tenantId, personId, expectedAuthUid: directory.authUid, expectedPersonVersion: selected.expectedPersonVersion, reason: reason.trim() });
      setDirectory(await fetchPeopleLinkCandidatesViaBff({ identityKey, actor, tenantId }));
      await onLinked();
      setConfirmed(false);
      setMessage('직원과 로그인 계정을 연결했습니다. 승인된 역할을 선택하고 권한 반영을 진행해 주세요.');
    } catch (error) { setMessage(governanceErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border p-3" aria-label="직원 계정 연결">
    <h3 className="font-semibold text-sm">직원과 로그인 계정 연결</h3>
    <p className="text-xs text-stone-600">인력 명부에 있는 본인을 확인해 연결합니다. 역할 승인은 별도로 진행합니다.</p>
    <button type="button" className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => void load()}>직원 명부 확인</button>
    {directory && <>
      {!directory.authVerified && <p role="alert" className="text-sm text-red-700">{governanceErrorMessage({ code: directory.authIssue || 'auth_identity_unverified' })}</p>}
      {directory.linkedPersonId && <p className="text-sm">이미 연결된 직원 기록이 있습니다. 다른 직원으로 바꾸지 말고 현재 연결을 확인해 주세요.</p>}
      <label className="block text-sm">연결할 직원
        <select aria-label="연결할 직원" className="mt-1 w-full border rounded p-2" value={personId} disabled={busy || !directory.authVerified} onChange={(event) => { setPersonId(event.target.value); setConfirmed(false); }}>
          <option value="">본인 확인 후 직접 선택해 주세요</option>
          {directory.people.map((person) => <option key={person.personId} value={person.personId} disabled={!!person.linkedUid && person.linkedUid !== directory.authUid}>{person.name} {person.nickname ? `(${person.nickname})` : ''} · {person.email || '명부 이메일 없음'}{person.linkedUid ? ' · 연결됨' : ''}</option>)}
        </select>
      </label>
      <label className="block text-sm">본인 확인 근거
        <input className="mt-1 w-full rounded border p-2" aria-label="본인 확인 근거" value={reason} maxLength={500} disabled={busy} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} placeholder="직원에게 확인한 방법과 승인 근거" />
      </label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || !selected} onChange={(event) => setConfirmed(event.target.checked)} />{selected ? `${selected.name} (${selected.nickname || selected.personId}) 직원의 로그인 계정이 ${email}임을 확인했습니다.` : '직원을 선택하고 로그인 계정의 본인 여부를 확인해 주세요.'}</label>
      <button type="button" className="rounded bg-stone-900 text-white px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !selected || !confirmed || !reason.trim() || !directory.authVerified} onClick={() => void link()}>계정 연결 승인</button>
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
