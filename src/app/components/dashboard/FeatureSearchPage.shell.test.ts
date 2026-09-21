import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'FeatureSearchPage.tsx'), 'utf8');
const searchSource = readFileSync(resolve(import.meta.dirname, 'AdminCommandSearch.tsx'), 'utf8');
const routesSource = readFileSync(resolve(import.meta.dirname, '../../routes.tsx'), 'utf8');

describe('FeatureSearchPage shell contract', () => {
  it('makes feature search the full-screen admin landing page with admin and practitioner grouping', () => {
    expect(routesSource).toContain('const FeatureSearchPage');
    expect(routesSource).toContain('{ index: true, element: <S C={FeatureSearchPage} /> }');
    expect(routesSource).toContain("{ path: 'dashboard', element: <S C={DashboardPage} /> }");
    expect(source).toContain('AdminCommandSearch');
    expect(source).toContain('displayName');
    expect(source).toContain('안녕하세요, {displayName} 사내기업가님');
    expect(source).toContain('아래 검색창에서 원하시는 기능을 바로 탐색하실 수 있습니다.');
    expect(source).toContain('관리자');
    expect(source).toContain('실무자');
    expect(source).toContain('전체 프로젝트 보기');
    expect(source).toContain('description');
    expect(source).toContain('프로젝트 목록, 담당조직, PM, 발주기관을 확인합니다.');
    expect(source).toContain('role="note"');
    expect(source).toContain('opacity-0');
    expect(source).toContain('group-hover:opacity-100');
    expect(source).toContain('group-focus-within:opacity-100');
    expect(source).toContain('absolute left-0 top-[-8px]');
    expect(source).toContain('min-h-dvh');
    expect(source).toContain('bg-[#001e46]');
    expect(source).toContain('mx-auto flex');
    expect(source).toContain('max-w-6xl');
    expect(source).toContain('border border-slate-200 bg-white');
    expect(source).not.toContain('border-emerald-200');
    expect(source).not.toContain('backdrop-blur-xl');
  });

  it('uses registration-focused quick suggestions without the ambiguous CIC chip', () => {
    expect(searchSource).toContain("const SUGGESTIONS = ['프로젝트 등록', '계약서', '사업비 입력', '권한']");
    expect(searchSource).not.toContain("'CIC'");
  });

  it('exposes project selection and registration in practitioner quick links', () => {
    expect(source).toContain("{ label: '프로젝트 선택', to: '/portal/project-select' }");
    expect(source).toContain("{ label: '프로젝트 등록 요청', to: '/portal/register-project' }");
    expect(source).not.toContain("{ label: '예산 편집', to: '/portal/budget' }");
    expect(source).not.toContain("{ label: '사업비 입력', to: '/portal/weekly-expenses' }");
  });
});
