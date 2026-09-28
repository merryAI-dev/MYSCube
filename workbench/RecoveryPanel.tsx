import { useEffect, useRef, useState } from 'react';
import { acknowledgeWorkbenchRequest, recoverWorkbenchRequest, recoverWorkbenchRequests } from './client';
import type { RecoveredWrite } from './transport';

type Props = { onRecovered: (value: unknown) => boolean; scope?: 'react-page' | 'html-page' | 'registered-api'; disabled?: boolean; targetKey?: string };

export function RecoveryPanel({ onRecovered, scope, disabled = false, targetKey }: Props) {
  const [items, setItems] = useState<RecoveredWrite[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const generation = useRef(0), working = useRef(false);
  const current = useRef({ onRecovered, scope, disabled, targetKey });
  current.current = { onRecovered, scope, disabled, targetKey };
  useEffect(() => {
    generation.current++; working.current = false; setBusy(false); setItems([]); setMessage('');
    return () => { generation.current++; working.current = false; };
  }, [scope, disabled, targetKey]);
  const check = async (selected?: RecoveredWrite) => {
    if (working.current || current.current.disabled) return;
    const requestGeneration = ++generation.current, owner = current.current;
    const active = () => generation.current === requestGeneration && current.current.scope === owner.scope && current.current.targetKey === owner.targetKey && !current.current.disabled;
    working.current = true; setBusy(true); setItems([]); setMessage('');
    try {
      const pending = selected ? [await recoverWorkbenchRequest(selected)] : await recoverWorkbenchRequests();
      if (!active()) return;
      const found = pending.filter((item) => !owner.scope || item.path.startsWith(owner.scope === 'react-page' ? '/react-work-pages' : owner.scope === 'html-page' ? '/html-work-pages' : '/workbench-apis'));
      setItems(found);
      if (!found.length) setMessage('확인하지 않은 저장 요청이 없습니다.');
      if (selected && found[0]?.state === 'completed' && current.current.onRecovered(found[0].body)) {
        acknowledgeWorkbenchRequest(found[0]); setItems([]);
      }
    } catch (error) {
      if (active()) { setItems([]); setMessage(error instanceof Error ? error.message : '저장 결과를 확인하지 못했습니다.'); }
    } finally {
      if (generation.current === requestGeneration) { working.current = false; setBusy(false); }
    }
  };
  return <section className="side-panel" aria-label="저장 결과 복구" aria-busy={busy}>
    <button className="quiet" disabled={busy || disabled} onClick={() => void check()}>저장 결과 확인</button>
    <p className="subtle">응답이 끊겼을 때 서버에 저장되었는지 확인합니다. 불러올 때 현재 조회 권한을 다시 확인하며, 불러오기를 확정하기 전까지 편집 내용과 저장 요청은 유지됩니다.</p>
    {busy && <p role="status">저장 결과와 현재 조회 권한을 확인하고 있습니다.</p>}
    {message && <p role="status">{message}</p>}
    {!busy && items.map((item) => <div className="history-row" key={item.key}>
      <span>{new Date(item.startedAt).toLocaleString('ko-KR')} · {item.state === 'completed' ? item.recoveredAfterScopeChange ? '현재 권한으로 다시 확인한 저장본' : '저장 완료' : item.state === 'pending' ? '처리 결과 확인 중' : item.state === 'scope_changed' ? '조회 권한 변경 · 저장 요청 보존 중' : '같은 내용으로 다시 시도할 수 있습니다'}</span>
      {item.state === 'scope_changed' && <p className="error" role="alert">{item.message || '조회 권한이 바뀌어 이전 저장 결과를 확인할 수 없습니다. 중복 저장을 막기 위해 새로 저장하지 않았습니다.'}</p>}
      {item.state === 'completed' && <button disabled={busy || disabled} onClick={() => void check(item)}>복구한 저장본 불러오기</button>}
    </div>)}
  </section>;
}
