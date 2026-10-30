import { Button } from '../ui/button';
import { ShieldCheck, CircleHelp } from 'lucide-react';
import { MotionSurface } from '../ui/motion';
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
  const pending = issue === 'PENDING';
  return <main className="membership-page"><MotionSurface className="membership-card" changeKey={issue}>
    <section aria-live="polite">
      <div className="membership-mark">{pending ? <ShieldCheck /> : <CircleHelp />}</div>
      <p className="eyebrow">{pending ? '로그인은 완료됐어요' : '계정 상태 확인'}</p>
      <h1>{pending ? <>이제 관리자 확인만<br />남았어요</> : guide.title}</h1>
      <p className="membership-lead">{pending ? '명부의 직원과 계정을 연결하고 역할을 승인하면 MYSCube를 시작할 수 있어요.' : guide.message}</p>
      <div className="handoff-card"><span>관리자에게 전달할 이메일</span><strong>{email}</strong>{pending && <p>이 계정의 <b>명부 연결과 역할 승인</b>을 확인해 달라고 요청해 주세요.</p>}</div>
      {pending && <div className="quiet-note"><CircleHelp size={18} /><p>현재는 어느 승인 단계인지 확인할 수 없어요.<br />처리가 끝났다는 안내를 받으면 다시 확인해 주세요.</p></div>}
      <div className="grid gap-2">
        <Button size="lg" onClick={onRetry}>승인 상태 다시 확인</Button>
        <Button variant="ghost" onClick={onLogout}>로그아웃</Button>
        <button ref={trigger} type="button" className="text-sm text-blue-700 underline py-3" onClick={() => { opened.current = true; setShowGuide(true); }}>가입 흐름 개편안 보기 · 운영 적용 전</button>
      </div>
      {pending && <p className="membership-footnote">승인 전에는 프로젝트를 등록할 수 없어요.</p>}
    </section>
  </MotionSurface></main>;
}
