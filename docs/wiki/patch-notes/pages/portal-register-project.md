# Portal Register Project

- route: `/portal/register-project`
- primary users: PM, 사업 등록 제안 담당자
- status: active
- last updated: 2026-09-21

## Purpose

신규 사업 등록 제안을 올리고 계약/재무/팀 구성 정보를 입력하는 포털 등록 화면이다.

## Current UX Summary

- 단계형 등록 플로우에서 초안 저장과 단계 게이팅을 함께 다룬다.
- 신규 v2 등록은 계약서·고객사 사업자등록증·견적서·RFP/요청 메일을 필수 증빙으로 받는다.
- 제안서 Word/PPT와 발표자료 PPT는 선택 첨부이며, 미첨부 시 사유를 남긴다.
- 정산시스템·인건비 정산기준, 회차별 입금 예상월과 참여인력 구분을 구조화해 저장한다.
- 팀원 구성은 이름/닉네임 검색형 picker로 선택한다.
- 팀/인력 단계에서는 담당조직(CIC)과 중복되는 사내기업팀, 참여기업 조건을 입력하지 않는다.
- 등록 완료 이후 운영 알림과 후속 검토 흐름이 이어진다.

## Current Feature Checklist

- [x] 최종 결과보고서의 최종 제출·승인 조회 연결

- [x] 날짜 편집 중 기존 연도별 금액·입금 계획 유지
- [x] 계약기간 밖 연도는 확인 후 제외하고 합계를 다시 계산
- [x] 전각 숫자·원 단위 금액 입력, 형식 오류 시 기존 금액 보존
- [x] 미래 시작·종료 미정 사업의 시작 연도 재무 입력

- [x] 단계형 사업 등록 제안 가능
- [x] 초안 자동저장 가능
- [x] 직접 입력형 자금 흐름(`DIRECT_ENTRY`) 등록 가능
- [x] PPT 기준 필수·선택 첨부 7종과 형식별 파일 검증
- [x] 정산시스템·인건비 정산기준 입력 가능
- [x] 선금·중도금·잔금의 예상월 및 70% 미만 사유 입력 가능
- [x] 실제 투입인력·서류상 인력과 역할 구분 가능
- [x] 등록 완료 후 운영 알림 연계
- [x] 팀 구성과 계약 금액 입력 가능
- [x] 팀원 80명+ 목록을 이름/닉네임 검색으로 선택 가능
- [x] 중복 조직/조건 필드 없이 PM과 팀원 구성 중심으로 입력 가능
- [x] review 단계에서 빈 값은 `-` placeholder 대신 숨김 처리
- [x] AI 초안 카드와 최종 검토 영역은 값이 있는 필드만 노출

## Recent Changes

- [2026-09-21] 최종 결과보고서가 최종 제출 payload와 BFF 첨부 처리에서 빠지는 매핑을 연결했다. 기존 임시저장 데이터와 승인 정책은 유지한다.

- [2026-09-16] 날짜 공란·기간 축소로 연도별 입력을 자동 삭제하지 않게 했다. 잘못된 금액 문자열은 0으로 저장하지 않고 정정할 때까지 저장을 차단한다. 단년도·다년도 전환 시 기존 입금 계획을 해당 연도에 유지한다.

- [2026-07-14] 프로젝트 등록 PPT 기준의 기본정보 안내, 첨부 7종, 다년도 재무, 정산시스템, 입금 예상월, 참여인력 구분을 v2 최종저장 계약에 반영했다. 최종저장 후 사업관리 폴더를 자동 생성한다.
- [2026-07-13] 화면 이탈 시 한 번 확인한 뒤 최신 입력을 임시저장하고 수정 lease를 해제하도록 연결했다. 저장 또는 해제 실패 시 현재 화면에 남아 재시도할 수 있다.
- [2026-05-20] 공통 프로젝트 에디터의 팀원 선택을 긴 dropdown에서 이름/닉네임 검색형 picker로 바꾸고, 팀/인력 단계에서 사내기업팀과 참여기업 조건 입력을 제거해 신규 등록과 수정 루프가 같은 간소화된 팀 입력 UX를 사용하게 했다.
- [2026-04-14] review 단계의 최종 확인 경고 박스를 제거하고 요약 카드만 남겼다.
- [2026-04-14] review/AI 초안 summary에서 `-` placeholder를 제거하고 빈 row는 숨기도록 바꿨다.
- [2026-04-03] 직접 입력형 자금 흐름(`DIRECT_ENTRY`) 등록 플로우를 추가했다.
- [2026-04-03] 등록 완료 후 BFF/Slack 알림 연계를 넣었다.
- [2026-04-03] 투자사업 등록 정책과 등록값 정합성을 정리했다.
- [2026-04-01] draft 자동저장과 단계 게이팅 완화를 반영했다.
- [2026-03-27] viewer 등록 허용과 PDF 선택 입력 UX를 강화했다.

## Known Notes

- v1 기존 프로젝트 수정은 과거 필드가 없어도 계속 가능하며, 새 필수 검증은 v2 최종저장에 적용한다.
- 직접 입력형 자금 흐름과 일반 사업 등록 흐름은 후속 정산 구조에도 영향을 준다.

## Related Files

- `src/app/components/portal/PortalProjectRegister.tsx`
- `src/app/platform/project-request-registration.ts`
- `src/app/routes.tsx`

## Related Tests

- `tests/e2e/project-amount-investigation.spec.ts`
- `src/app/platform/project-input-preservation.test.ts`

- `src/app/components/portal/project-proposal.test.ts`
- `src/app/platform/project-request-registration.test.ts`
- `src/app/platform/project-team-members.test.ts`
- `src/app/platform/project-contract-amount.test.ts`

## Related QA / Ops Context

- 등록 제안, 계약서 업로드, 투자사업/펀드형 사업 예외 정책은 QA memory의 `project_register`, `contract_upload`, `project_settings`와 이어진다.

## Next Watch Points

- 필수 첨부와 선택 첨부의 미첨부 사유가 canonical 저장까지 유지되는지
- draft autosave와 단계 게이팅이 서로 충돌하지 않는지
- 직접 입력형 자금 흐름이 후속 portal/admin 정산 화면과 계속 정합한지
