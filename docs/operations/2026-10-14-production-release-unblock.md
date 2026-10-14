# 운영 배포 정체 해소 — 웹과 JVM 을 나눠 내보낸다

**날짜:** 2026-10-14

## 상황

| 대상 | 운영 버전 | 상태 |
|---|---|---|
| 웹 (Vercel) | `336fe9b2` (09-30) | 10-01 이후 main 커밋이 운영에 나가지 않음 |
| JVM (Cloud Run) | `hotfix-1c6d0817` (09-10) | 이후 JVM 변경(#854)이 나가지 않음 |

#854(10-01)가 JVM 과 BFF 결산 경로(`server/bff/routes/jvm-weekly-api.mjs`)를 함께 바꿔
`scripts/verify-cashflow-settlement-release-boundary.mjs` 가 모든 릴리스를 `atomic_cutover` 로 분류했다.

- `Production Deploy` 는 `atomic_cutover` 면 "JVM 쪽이 처리한다"며 Vercel 배포를 건너뛴다 (실행은 초록).
- `JVM Production Deploy` 는 `Block atomic cutover while settlement work is active` 에서 매번 실패한다.
  이 단계는 09-04 결산 주기 전환용 1회성 검사로, 마이그레이션 대상 사업 3개가 코드에 고정돼 있다
  (`EXPECTED_MIGRATION_PROJECTS`). 전환이 끝난 지금 운영의 옛 형식 head 는 0개라 통과할 수 없다.

## 해소 순서

1. **웹만** — main 의 `server/jvm-weekly-api` 를 운영 JVM(`1c6d0817`)과 같게 되돌린다 (#854 의 JVM 부분만).
   JVM 차이가 0 이 되어 분류가 `web` 이 되고, 멈춰 있던 웹 커밋이 나간다. JVM 은 그대로다.
   - #854 의 웹 변경은 운영 JVM 과 호환된다 (BFF 는 결산 차단 항목을 경고로 돌리는 것뿐이고,
     화면은 주정산 Projection 예외 승인 흐름을 계속 보낸다).
   - 이 머지에서 `JVM Production Deploy` 는 워크플로 파일 차이 때문에 돌지만 분류가 `web` 이라 배포 전에 멈춘다 (운영 영향 없음).
2. **JVM 만** — 운영 JVM + 월결산 원클릭 승인 JVM 변경만 담는다. 웹이 따라잡은 뒤라 분류가 `jvm_only` 가 되어
   cutover 검사 없이 배포된다.
3. **나중에** — #854 의 JVM 변경, 원클릭 승인 BFF 변경, 1회성 cutover 검사 정리.

## 재발 방지

1회성 cutover 검사를 정리하기 전까지는 JVM 과 BFF 결산 경로를 한 PR 에서 함께 바꾸지 않는다.
머지 후에는 `Production Deploy` 가 실제로 Vercel 에 배포했는지(Skip 단계가 아닌지) 확인한다.
