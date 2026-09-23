import { useLocation } from 'react-router';

export function IsolatedWorkbenchEntry() {
  const { pathname } = useLocation();
  let destination: string | null = null;
  try {
    const origin = new URL(String(import.meta.env.VITE_AXR_WORKBENCH_ORIGIN || ''));
    if (origin.protocol === 'https:' && origin.origin !== window.location.origin && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password) {
      destination = new URL(pathname.replace(/^\/portal/, ''), origin).href;
    }
  } catch { /* The operational application does not contact an unconfigured analysis service. */ }
  return <section className="mx-auto max-w-2xl space-y-4 p-6">
    <h1 className="text-xl font-semibold">AXR 분석 도구</h1>
    <p className="text-sm text-muted-foreground">분석 도구는 기존 업무와 분리된 공간에서 실행합니다. 분석 화면에 문제가 생겨도 이 창에서 프로젝트 등록·승인·정산을 계속 이용할 수 있습니다.</p>
    {destination ? <a className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm text-white" href={destination} target="_blank" rel="noopener noreferrer">분석 도구 새 창에서 열기</a>
      : <p className="rounded-md bg-slate-50 p-4 text-sm">독립 분석 공간의 연결을 준비하고 있습니다. 기존 업무는 정상적으로 이용하실 수 있습니다.</p>}
  </section>;
}
