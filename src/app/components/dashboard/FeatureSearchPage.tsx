import { OnboardingGuideLink } from '../onboarding-guide/OnboardingGuideLink';
import { ArrowRight, Building2, UserRoundCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useAppStore } from '../../data/store';
import { useAuth } from '../../data/auth-store';
import { AdminCommandSearch } from './AdminCommandSearch';
import { MyscWordmark } from '../brand/MyscWordmark';

const ADMIN_ENTRY_POINTS = [
  { label: '전체 프로젝트 보기', to: '/projects', description: '프로젝트 목록, 담당조직, PM, 발주기관을 확인합니다.' },
  { label: '프로젝트 등록/승인', to: '/projects/migration-audit', description: '신규 등록 요청, 수정 제출, 계약서 PDF 검토를 처리합니다.' },
  { label: '캐시플로 모니터링', to: '/cashflow', description: '입금, 지출, 계약금, 지원금, 수익 흐름을 확인합니다.' },
  { label: '권한/사용자', to: '/users', description: '사용자 역할, 조직장, 접근 권한을 관리합니다.' },
];

const PM_ENTRY_POINTS = [
  { label: '프로젝트 선택', to: '/portal/project-select' },
  { label: '프로젝트 등록 요청', to: '/portal/register-project' },
  // 자기 인사정보를 넣는 자리. 프로젝트 일 못지않게 자주 찾는다.
  { label: '마이페이지', to: '/portal/career-profile' },
];

export function FeatureSearchPage() {
  const { projects } = useAppStore();
  const { user } = useAuth();
  const navigate = useNavigate();
  const displayName = user?.name?.trim() || '구성원';

  return (
    <div className="min-h-dvh bg-slate-50 px-4 py-5 dark:bg-slate-950 md:px-6 md:py-8">
      <div className="mx-auto flex min-h-[calc(100dvh-2.5rem)] w-full max-w-6xl flex-col space-y-5 md:min-h-[calc(100dvh-4rem)]">
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="border-b border-slate-800 bg-[#001e46] px-5 py-5 text-white md:px-7">
            <MyscWordmark tone="onDark" size="md" />
          </div>
          <div className="space-y-5 px-5 py-6 md:px-7 md:py-8">
            <div className="w-full">
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-slate-600 dark:text-slate-300">
                Feature Search
              </p>
              <h1 className="mt-2 text-[30px] font-extrabold leading-tight tracking-[-0.02em] text-slate-950 dark:text-slate-50 md:text-[38px]">
                안녕하세요, {displayName} 사내기업가님
              </h1>
              <p className="mt-3 text-[14px] leading-6 text-slate-600 dark:text-slate-300">
                아래 검색창에서 원하시는 기능을 바로 탐색하실 수 있습니다.
              </p>
            </div>

<OnboardingGuideLink />
            <AdminCommandSearch projects={projects} role={user?.role} />
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/70">
            <div className="flex items-center gap-2 text-slate-900 dark:text-slate-200">
              <Building2 className="h-4 w-4" />
              <h2 className="text-[13px] font-bold">관리자</h2>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {ADMIN_ENTRY_POINTS.map((item) => (
                <div key={item.to} className="group relative">
                  <button
                    type="button"
                    aria-describedby={`admin-entry-note-${item.to.replace(/[^a-z0-9]+/gi, '-')}`}
                    onClick={() => navigate(item.to)}
                    className="flex h-10 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-left text-[12px] font-semibold text-slate-950 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    {item.label}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <div
                    id={`admin-entry-note-${item.to.replace(/[^a-z0-9]+/gi, '-')}`}
                    role="note"
                    className="pointer-events-none absolute left-0 top-[-8px] z-50 w-64 origin-bottom-left -translate-y-full scale-95 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-medium leading-5 text-slate-900 opacity-0 shadow-lg shadow-slate-900/10 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                      Memo
                    </span>
                    <span>{item.description}</span>
                    <span className="absolute bottom-[-5px] left-4 h-2.5 w-2.5 rotate-45 border-b border-r border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950" />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/70">
            <div className="flex items-center gap-2 text-slate-900 dark:text-slate-200">
              <UserRoundCheck className="h-4 w-4" />
              <h2 className="text-[13px] font-bold">실무자</h2>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PM_ENTRY_POINTS.map((item) => (
                <button
                  key={item.to}
                  type="button"
                  onClick={() => navigate(item.to)}
                  className="flex h-10 items-center justify-between rounded-md border border-slate-200 bg-white px-3 text-left text-[12px] font-semibold text-slate-950 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                >
                  {item.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
