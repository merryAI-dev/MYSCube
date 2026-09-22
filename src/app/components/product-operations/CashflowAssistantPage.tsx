import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Input } from '../ui/input';
import { CashflowEvidencePanel } from './CashflowEvidencePanel';
import { useWorkbench } from './useWorkbench';
import { AssistantComposer } from './AssistantComposer';

export function CashflowAssistantPage() {
  const { ready, scope } = useWorkbench();
  const location = useLocation();
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(new Date()));
  if (!ready) return <p className="p-6">로그인 정보를 확인하고 있습니다.</p>;
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6"><h1 className="text-xl font-bold">현금흐름 조회·진단</h1><p className="text-sm">전사 범위 권한이 있는 계정은 전체 사업을, 그 외 계정은 담당 사업을 조회합니다. 10개씩 확인하며 페이지별 결과를 전사 합계로 표시하지 않습니다.</p><Link className="text-sm text-blue-700 underline" to={location.pathname.startsWith('/portal') ? '/portal/work-pages' : '/work-pages'}>내 업무 페이지에 조회 구성 저장하기</Link><label className="block max-w-xs text-sm">조회 연월<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label><AssistantComposer key={`ai-${scope}`} mode="cashflow" yearMonth={month} /><CashflowEvidencePanel key={scope} yearMonth={month} /></div>;
}
