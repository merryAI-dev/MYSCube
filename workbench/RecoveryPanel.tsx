import { useState } from 'react';
import { acknowledgeWorkbenchRequest, recoverWorkbenchRequests } from './client';
import type { RecoveredWrite } from './transport';

export function RecoveryPanel({ onRecovered, scope }: { onRecovered: (value: unknown) => boolean; scope?: 'react-page' | 'html-page' | 'registered-api' }) {
  const [items, setItems] = useState<RecoveredWrite[]>([]), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  return <section className="side-panel" aria-label="저장 결과 복구">
    <button className="quiet" disabled={busy} onClick={async () => {
      setBusy(true); setMessage('');
      try { const pending = await recoverWorkbenchRequests(); const found = pending.filter((item) => !scope || item.path.startsWith(scope === 'react-page' ? '/react-work-pages' : scope === 'html-page' ? '/html-work-pages' : '/workbench-apis')); setItems(found); if (!found.length) setMessage('확인하지 않은 저장 요청이 없습니다.'); }
      catch (error) { setMessage(error instanceof Error ? error.message : '저장 결과를 확인하지 못했습니다.'); }
      finally { setBusy(false); }
    }}>저장 결과 확인</button>
    <p className="subtle">응답이 끊겼을 때 서버에 저장되었는지 확인합니다. 불러오기를 선택하기 전까지 현재 편집 내용은 유지됩니다.</p>
    {message && <p role="status">{message}</p>}
    {items.map((item) => <div className="history-row" key={item.key}>
      <span>{new Date(item.startedAt).toLocaleString('ko-KR')} · {item.state === 'completed' ? item.recoveredAfterScopeChange ? '현재 권한으로 다시 확인한 저장본' : '저장 완료' : item.state === 'pending' ? '처리 결과 확인 중' : item.state === 'scope_changed' ? '조회 권한 변경 · 저장 요청 보존 중' : '같은 내용으로 다시 시도할 수 있습니다'}</span>
      {item.state === 'scope_changed' && <p className="error" role="alert">{item.message || '조회 권한이 바뀌어 이전 저장 결과를 확인할 수 없습니다. 중복 저장을 막기 위해 새로 저장하지 않았습니다.'}</p>}
      {item.state === 'completed' && <button onClick={() => { if (onRecovered(item.body)) { acknowledgeWorkbenchRequest(item); setItems((values) => values.filter((value) => value.key !== item.key)); } }}>복구한 저장본 불러오기</button>}
    </div>)}
  </section>;
}
