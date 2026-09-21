# 프로젝트 등록/승인

- route: `/approvals`, `/projects/migration-audit`
- primary users: 관리자, 지정 조직장
- status: active
- last updated: 2026-09-21

## Purpose

프로젝트 등록·수정 요청의 조직장 결재 상태를 조회하고 처리한다.

## Current UX Summary

내 검토함의 대기 문서를 먼저 표시하며, 검토함·CIC·검색 조건 안에서 승인 완료와 반려 문서도 조회한다.

## Current Feature Checklist

- [x] 검토한 제출본만 승인, 이전 형식 사전 안내 및 작성 의견 보존 (개발 반영, 미배포)

- [x] 최종 제출본 기준 검토, 추가 첨부·Drive 링크 동시 표시, 다년도 입금 비율 일치

- [x] 원장에 이미 연결된 기존 계약서의 승인·열람 호환 처리

- [x] 승인 완료·반려 문서를 상태 필터로 조회
- [x] 상단 대기 건수와 요약·목록이 동일한 상태 판정 사용
- [x] 최초 진입은 내 검토함·대기 상태 유지
- [x] 지정 조직장 승인 권한 유지

## Recent Changes

- [2026-09-21 / 미배포] 문서를 열 때 서버가 반환한 제출본과 검토 토큰을 고정한다. 재제출되면 승인을 중단하고 작성 의견을 유지한 채 재검토한다. 이전 양식과 실제 승인 보완 조건을 구별하여 해당 항목·원인·수정 주체·조치 동선을 승인 전에 안내한다. 연도 부가세·수익률·확인값·폴더·저장 당시 월별 참여율을 함께 표시한다. 운영 데이터 일괄 수정 없이 개발·검증 중이며 실제 배포는 별도 진행한다.

- [2026-09-21] 승인 문서의 금액·부서·계약서·체크아웃 노출을 최종 제출본으로 통일했다. 제안서 PDF·종료 증빙과 파일에 함께 제출한 Drive 링크를 표시하고, 다년도 선금 비율을 연도별 합계로 계산한다.

- [2026-09-17] JLIN·전남의 기존 계약서가 새 첨부 경로 검사에서 거절되던 문제를 수정했다. 서버 원장의 동일 문서 필드와 경로·용량·형식·첨부 ID가 일치하는 파일만 기존 경로를 허용한다. 승인 트랜잭션에서도 현재 원장을 다시 확인한다. 파일 이동·삭제·승인 대행은 수행하지 않는다.

- [2026-09-17] 대기 문서만 먼저 남겨 승인 완료 집계가 0이 되던 부모 필터를 제거했다. 별도 원장 상태로 계산하던 상단 대기 건수를 요청 이력을 반영한 공통 요약 기준으로 통일했다. 조회 중·실패 시 대기 숫자를 확정적으로 표시하지 않는다.

## Known Notes

현재 프로젝트별 최신 요청 상태를 표시하며, 과거 승인 이벤트의 누적 건수와는 다르다. 신규 수정 요청이 생기면 다시 대기로 표시될 수 있다.

## Related Files

- `src/app/components/approval/AdminApprovalPage.tsx`
- `src/app/components/projects/ProjectMigrationAuditPage.tsx`
- `src/app/platform/project-migration-console.ts`

## Related Tests

- `src/app/components/approval/AdminApprovalPage.shell.test.ts`
- `src/app/platform/project-migration-console.test.ts`
- `tests/e2e/approval-status-regression.spec.ts`

## Related QA / Ops Context

9월 16일 KOSA·Seed0·중서원 승인 Slack 알림과, 완료 필터에서 0건으로 표시되는 화면을 대조했다. 원장과 승인 이력의 쓰기·마이그레이션은 수행하지 않는다.

## Next Watch Points

동일 프로젝트 재제출, 내 검토함·전체 전환, 검색 및 CIC 조건에서 요약과 목록의 상태 일치를 확인한다.

독립 브라우저 4사례 통과: 두 진입 경로, 승인·반려 및 내/전체·CIC 조회, 완료 문서 읽기 전용, 조회 오류, 승인 후 수정 요청 대기 상태 정렬. 실제 화면과 격리 API 응답을 사용했다. 전체 단위 4,151개와 빌드 통과, 신규 타입 오류 없음.
