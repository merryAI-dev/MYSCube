import { useEffect, useRef, useState } from 'react';
import type { ProjectDraftHistory, ProjectDraftHistoryItem } from '../../lib/project-draft-history';
import { REQUEST_FIELD_LABELS } from '../../platform/project-migration-review-dossier';
import { Button } from '../ui/button';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}

export function draftVersionValue(value: unknown, present: boolean): string {
  if (!present) return '기록 없음';
  if (value === null) return '비워 둠';
  if (value === '') return '빈 입력';
  if (value === 'NOT_APPLICABLE') return '해당 없음';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'number') return value.toLocaleString('ko-KR');
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? value.map((item) => draftVersionValue(item, true)).join('\n') : '항목 없음';
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${REQUEST_FIELD_LABELS[key] || key}: ${draftVersionValue(item, true)}`).join('\n') || '항목 없음';
  return '기록 없음';
}

export function compareProjectDraftVersions(previous: Record<string, unknown>, current: Record<string, unknown>) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter((key) => (
    Object.hasOwn(previous, key) !== Object.hasOwn(current, key)
    || JSON.stringify(canonicalValue(previous[key])) !== JSON.stringify(canonicalValue(current[key]))
  )).map((key) => ({
    key,
    label: REQUEST_FIELD_LABELS[key] || key,
    previous: draftVersionValue(previous[key], Object.hasOwn(previous, key)),
    current: draftVersionValue(current[key], Object.hasOwn(current, key)),
  }));
}

export function ProjectDraftVersionPanel({ serverDraft, editorRevision, submittedStatus, submittedVersion, loadHistory }: {
  serverDraft: ProjectDraftHistoryItem & { baseCanonicalVersion?: number; status?: string };
  editorRevision: number;
  submittedStatus?: string | null;
  submittedVersion?: number;
  loadHistory: () => Promise<ProjectDraftHistory>;
}) {
  const [history, setHistory] = useState<ProjectDraftHistory | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await loadHistory();
      if (request !== generation.current) return;
      setHistory(result);
      setSelected((old) => result.items.some((item) => item.draftRevision === old) ? old : result.items[0]?.draftRevision ?? null);
    } catch {
      if (request === generation.current) setError('저장 이력을 불러오지 못했습니다. 현재 입력과 임시저장은 유지됩니다. 잠시 후 다시 조회해 주세요.');
    } finally { if (request === generation.current) setBusy(false); }
  };
  const item = history?.items.find((entry) => entry.draftRevision === selected);
  const differences = item ? compareProjectDraftVersions(item.payload, serverDraft.payload) : [];
  const attachmentDifferences = item && JSON.stringify(canonicalValue(item.attachmentRefs)) !== JSON.stringify(canonicalValue(serverDraft.attachmentRefs))
    ? [{ key: 'attachments', label: '첨부파일 목록', previous: item.attachmentRefs.map((file) => file.name).join('\n') || '첨부 없음', current: serverDraft.attachmentRefs.map((file) => file.name).join('\n') || '첨부 없음' }]
    : [];
  const statusLabel = submittedStatus === 'PENDING' ? '조직장 검토 대기' : submittedStatus === 'APPROVED' ? '승인 완료' : submittedStatus === 'REJECTED' ? '반려' : submittedStatus === 'SUBMITTED' ? '제출 완료' : '제출 상태 기록 없음';
  return <section aria-label="임시저장 버전 관리" className="mb-4 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-800">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">임시저장 버전 관리</h2><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>{busy ? '저장 이력 조회 중' : '저장 이력 조회'}</Button></div>
    <dl className="mt-3 grid gap-2 sm:grid-cols-2">
      <div><dt className="text-xs text-slate-500">화면에 불러온 초안</dt><dd>버전 {editorRevision}</dd></div>
      <div><dt className="text-xs text-slate-500">마지막으로 저장 확인한 초안</dt><dd>버전 {serverDraft.draftRevision} · {serverDraft.updatedAt ? new Date(serverDraft.updatedAt).toLocaleString('ko-KR') : '저장 시각 기록 없음'}</dd></div>
      {serverDraft.baseCanonicalVersion !== undefined && <div><dt className="text-xs text-slate-500">초안 작성 기준 프로젝트</dt><dd>버전 {serverDraft.baseCanonicalVersion}</dd></div>}
      <div><dt className="text-xs text-slate-500">조직장에게 제출된 문서</dt><dd>{submittedVersion !== undefined ? `요청 버전 ${submittedVersion} · ` : ''}{statusLabel}</dd></div>
    </dl>
    <p className="mt-3 text-xs leading-5 text-slate-600">작성 중 변경은 임시저장 성공 후 이 패널에 반영됩니다. 초안의 저장 버전과 조직장에게 제출된 문서는 별개입니다. 버전 번호가 크다는 이유만으로 올바른 내용으로 확정되지 않습니다.</p>
    {error && <p role="alert" className="mt-3 text-amber-800">{error}</p>}
    {history && <div className="mt-4 border-t border-slate-200 pt-3">
      <p className="mb-2 text-xs text-slate-600">{history.historyAvailableFromRevision !== null ? `버전 ${history.historyAvailableFromRevision}부터 보관된 이력을 조회합니다.` : '이전 버전의 보관 시작 시점은 기록되어 있지 않습니다.'} 현재 작성 회차의 최근 20개 저장 이력을 표시합니다. 기록되지 않은 이전 내용은 복원하거나 추정하지 않습니다.</p>
      {history.items.length ? <>
        <label className="flex items-center gap-2">비교할 저장 버전<select aria-label="비교할 저장 버전" className="rounded border border-slate-300 bg-white p-2" value={selected ?? ''} onChange={(event) => setSelected(Number(event.target.value))}>{history.items.map((entry) => <option key={entry.draftRevision} value={entry.draftRevision}>버전 {entry.draftRevision}{entry.updatedAt ? ` · ${new Date(entry.updatedAt).toLocaleString('ko-KR')}` : ''}</option>)}</select></label>
        <p className="my-2 text-xs text-slate-600">선택한 이력과 마지막 저장 확인본을 비교합니다. 비교만 하며 현재 입력을 덮어쓰지 않습니다. 첨부파일은 보관된 목록만 비교하며, 이전 파일의 열기·복원 가능 여부를 보장하지 않습니다.</p>
        {differences.length || attachmentDifferences.length ? <div className="overflow-x-auto"><table className="w-full min-w-[540px] border-collapse text-left text-xs"><thead><tr><th className="p-2">항목</th><th className="p-2">선택한 버전 {selected}</th><th className="p-2">마지막 저장 확인본 {serverDraft.draftRevision}</th></tr></thead><tbody>{[...differences, ...attachmentDifferences.map((row) => ({ ...row, label: '첨부파일 목록' }))].map((row) => <tr key={row.key} className="border-t border-slate-200"><th className="p-2 align-top">{row.label}</th><td className="whitespace-pre-wrap break-all p-2 align-top">{row.previous}</td><td className="whitespace-pre-wrap break-all p-2 align-top">{row.current}</td></tr>)}</tbody></table></div> : <p>저장된 입력값과 첨부파일 목록에 차이가 없습니다.</p>}
      </> : <p>조회할 수 있는 저장 이력이 없습니다.</p>}
    </div>}
  </section>;
}
