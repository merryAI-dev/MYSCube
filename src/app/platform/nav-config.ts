import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, FolderKanban, BarChart3,
  Building2, Shield, UserCog,
  ListChecks, ArrowLeftRight, CalendarRange, Hash, Users,
} from 'lucide-react';

export interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  accent?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'CEO',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: '통합 대시보드' },
    ],
  },
  {
    label: '관리자',
    items: [
      { to: '/projects', icon: FolderKanban, label: '통합 대시보드' },
      { to: '/projects/migration-audit', icon: ArrowLeftRight, label: '프로젝트 등록/승인' },
      { to: '/cashflow', icon: BarChart3, label: '현금흐름 승인' },
      { to: '/participation', icon: Shield, label: '참여율 관리' },
    ],
  },
  {
    label: '경영기획실',
    items: [
      { to: '/cashflow/export', icon: BarChart3, label: '통합 관리' },
      { to: '/approvals', icon: ListChecks, label: '등록/승인', accent: true },
      { to: '/management-planning/project-codes', icon: Hash, label: '프로젝트 코드 부여', accent: true },
    ],
  },
  {
    label: 'AXR',
    items: [
      { to: '/axr/product-operations', icon: BarChart3, label: '서비스 운영 현황' },
      { to: '/axr/qa-evidence', icon: LayoutDashboard, label: '로그·GitHub QA' },
      { to: '/work-pages', icon: LayoutDashboard, label: '내 업무 페이지' },
      { to: '/cashflow-assistant', icon: BarChart3, label: '현금흐름 조회·진단' },
      { to: '/service-guidance', icon: ListChecks, label: '서비스 이용 안내' },
      { to: '/axr/cashflow-period-policy', icon: CalendarRange, label: '현금흐름 기간·마감 정책' },
      { to: '/users', icon: UserCog, label: '권한 관리' },
      { to: '/settings?tab=members', icon: UserCog, label: '멤버DB' },
      { to: '/people', icon: Users, label: '인력 명부' },
      { to: '/settings?tab=tenants', icon: Building2, label: '조직DB' },
    ],
  },
];
