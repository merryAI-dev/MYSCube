import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { membershipGuidance, type MembershipIssue } from '../../data/member-access';

const OnboardingGuide = lazy(() => import('../onboarding-guide/OnboardingGuide')
  .then(m => ({ default: m.OnboardingGuide }))
  .catch(() => ({ default: function GuideUnavailable() {
    return <section role="alert" className="p-6">
      <h2>가이드를 불러오지 못했어요</h2>
      <p>위의 버튼으로 가입 상태 안내에 돌아갈 수 있어요.</p>
      <button type="button" onClick={() => window.location.reload()}>새로고침하고 다시 확인</button>
    </section>;
  } })));

export function MembershipPending({ issue, email, onRetry, onLogout }: { issue: MembershipIssue; email: string; onRetry: () => void; onLogout: () => void }) {
  const [showGuide, setShowGuide] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!showGuide && opened.current) trigger.current?.focus();
  }, [showGuide]);
  if (showGuide) return <>
    <button type="button" className="sticky top-0 z-50 w-full bg-slate-900 p-3 text-white" onClick={() => setShowGuide(false)}>가입 상태 안내로 돌아가기</button>
    <Suspense fallback={<p role="status">가이드를 불러오고 있어요</p>}><OnboardingGuide embedded /></Suspense>
  </>;
  const guide = membershipGuidance(issue);
  return <main className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
    <section className="max-w-lg rounded-xl border bg-white p-8 space-y-5" aria-live="polite">
      <h1 className="text-xl font-semibold">{guide.title}</h1>
      <p className="text-sm text-stone-700">{guide.message}</p>
      <p className="text-sm font-medium">로그인 이메일: {email}</p>
      <div className="flex gap-3">
        <button type="button" className="rounded bg-stone-900 px-4 py-2 text-white" onClick={onRetry}>승인 상태 다시 확인</button>
        <button type="button" className="rounded border px-4 py-2" onClick={onLogout}>로그아웃</button>
      </div>
      <button ref={trigger} type="button" className="text-sm text-blue-700 underline" onClick={() => { opened.current = true; setShowGuide(true); }}>가입 흐름 개편안 보기 · 운영 적용 전</button>
    </section>
  </main>;
}
