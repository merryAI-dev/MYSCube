import { membershipGuidance, type MembershipIssue } from '../../data/member-access';

export function MembershipPending({ issue, email, onRetry, onLogout }: { issue: MembershipIssue; email: string; onRetry: () => void; onLogout: () => void }) {
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
    </section>
  </main>;
}
