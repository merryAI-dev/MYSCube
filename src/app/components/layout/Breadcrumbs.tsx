import { useLocation, Link } from 'react-router';
import { ChevronRight, Home } from 'lucide-react';

const ROUTE_LABELS: Record<string, string> = {
  '': '대시보드',
  'projects': '프로젝트',
  'new': '사업 등록',
  'cashflow': '캐시플로',
  'axr': 'AXR',
  'cashflow-period-policy': '현금흐름 기간·마감 정책',
  'qa-evidence': '로그·GitHub QA',
  'product-operations': '서비스 운영 현황',
  'work-pages': '내 업무 페이지',
  'cashflow-assistant': '현금흐름 조회·진단',
  'service-guidance': '서비스 이용 안내',
  'evidence': '증빙/정산',
  'participation': '참여율 관리',
  'koica-personnel': 'KOICA 인력배치',
  'audit': '감사로그',
  'settings': '설정',
  'ledgers': '원장',
  'edit': '수정',
};

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  if (segments.length === 0) return null;

  const crumbs: { label: string; path: string; isCurrent: boolean }[] = [];

  segments.forEach((seg, i) => {
    const path = '/' + segments.slice(0, i + 1).join('/');
    const isCurrent = i === segments.length - 1;
    // Skip UUID-like segments in display, just mark as "상세"
    const isId = seg.length > 8 && !ROUTE_LABELS[seg];
    const label = isId ? '상세' : (ROUTE_LABELS[seg] || seg);
    crumbs.push({ label, path, isCurrent });
  });

  return (
    <nav className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <Link to="/" className="flex items-center gap-1 hover:text-foreground transition-colors">
        <Home className="w-3 h-3" />
      </Link>
      {crumbs.map((crumb, i) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <ChevronRight className="w-3 h-3 text-muted-foreground/50" />
          {crumb.isCurrent ? (
            <span className="text-foreground" style={{ fontWeight: 500 }}>{crumb.label}</span>
          ) : (
            <Link to={crumb.path} className="hover:text-foreground transition-colors">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
