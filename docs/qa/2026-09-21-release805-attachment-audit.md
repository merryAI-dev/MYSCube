# Release 805 첨부·링크 독립 전수 QA

- 대상: 배포 SHA `8401b966`, 2026-09-21 17:26:52 KST 완료된 새 운영 읽기 snapshot.
- 운영 쓰기: 0. Firestore 저장본과 GCS 객체 metadata GET만 수행했다.
- 방법: 실제 배포 소스의 `buildMigrationReviewDocumentSlots`, 요청 payload resolver, Portal 등록/수정 hydrator를 새 snapshot에 실행했다. 브라우저는 해당 소스와 운영 저장본을 로컬에서 재현했으며, 인증된 운영 UI 검증과 구별한다.

## 결과

| 검사 | 실측 결과 |
|---|---|
| 원장 79 + 요청 125 + 수정 초안 67 + 등록 초안 168 | 439개 문서, 3,073개 제출 슬롯 실행 |
| 파일 path/name/downloadURL, 제안서·발표 링크, 상태 | mapper/hydrator 누락 0, attachmentRefs 미반영 0 |
| 상태 분포 | 제출 594, 미입력 1,821, 기록 없음 658, 추후 제출 9, 해당 없음 4 |
| GCS 고유 객체 | 220개 GET, 정상 219, 404 1 |
| 정상 객체 크기/MIME 대조 | 불일치 0 |
| 탐나는인재 실제 양쪽 컴포넌트 | 3개 프로젝트 모두 대응 일치, 새 PNG 6장 육안 확인, 브라우저 오류 0 |

404는 등록 초안 `321b0993-4e00-4386-9522-532c1337a571`의 폐기(DISCARDED) 파일 1건이다. 현재 snapshot에서 해당 경로는 이 폐기 초안에만 참조되어 있다. 활동 초안·원장·요청의 누락 파일로 발견된 것은 아니다. 자동 삭제나 복구는 하지 않았다.

## 탐나는인재 3개 문서 구별

| 프로젝트 ID | 실무자 제안서 링크 | 승인 화면 |
|---|---|---|
| p1775209310774 | 빈 입력 | 기록 없음 |
| p1789643398531_b7a5250b | 빈 입력 | 미입력 |
| p1789694976951_558db8db | 저장된 Google Drive 링크 | 제출됨 + 동일 href의 링크 열기 |

저장된 링크가 있는 문서가 미제출로 표시되는 현상은 새 snapshot 재현에서 발견되지 않았다. 다른 두 프로젝트까지 제출됐다고 단정하지 않는다. 외부 Drive 문서 접근 권한·문서 본문은 검사하지 않았다.

## 남은 요구사항·검증 한계

- **50MB 및 확장자 제한 해제는 미구현이다.** 실제 private draft 경로는 프론트·클라이언트·BFF 모두 10MB 상한이다. 계약서/견적서 등 PDF 전용, 제안서 Word DOCX, PPT PPTX 등 종류별 제한도 남아 있다. 1GB인 과거 직접 업로드 상수가 존재하지만 현재 임시저장 경로의 50MB 지원을 뜻하지 않는다.
- 원본 바이너리 다운로드·PDF 내용/미리보기 렌더링은 이번 객체 metadata 검사에 포함하지 않았다.
- 실제 운영 로그인 세션을 통한 업로드/제출/승인은 하지 않았다. 읽기 전용 운영 자료 재현의 증거이며, 코드만 읽고 판정한 결과는 아니다.
- 로컬 하네스에서 비공개 Portal hydrator와 Context에 export만 추가해 호출했다. 처음 하네스 export 부족으로 실행 실패한 기록을 남겼고, 수정 후 재실행 성공했다. 제품 코드는 변경하지 않았다.

## 증거

- `/tmp/myscube-805-audit/evidence.json`
- `/tmp/myscube-805-audit/attachment-display-matrix.json`
- `/tmp/myscube-805-audit/attachment-display-execution.log`
- `/tmp/myscube-805-audit/storage-attachment-audit.json`
- `/tmp/myscube-805-audit/storage-execution.log`
- `/tmp/myscube-805-audit/tamna/result.json`
- `/tmp/myscube-805-audit/tamna/*-proposal.png`
- `/tmp/myscube-805-audit/tamna-execution4.log`

개인/계약 정보와 접근 링크가 포함된 원시 snapshot 및 PNG는 로컬 증거로만 보관하고 Git에 넣지 않았다.

## 추가: BFF projection 차이 독립 분류

새 snapshot 125개 요청에 실제 변경 patch mapper를 실행한 122개 성공 결과를 재분류했다. 나머지 3개는 참여율 시트 연결 검증으로 거부됐으며, 상태는 WITHDRAWN 2개·APPROVED 1개다. 이를 현재 승인 대기 3개 장애로 표현해서는 안 된다.

- `groupwareName` missing 15개: 입력이 모두 빈 문자열이다. 실제 문자열의 유실은 아니다.
- `teamMembers` missing 122개: 원장 모델은 `teamMembersDetailed`를 사용한다. 106개는 상세 인력이 있고 입력/출력 내용과 개수가 같다. 상세 인력 없는 16개는 `-` 8개, 빈 문자열 5개, 실제 구형 요약 3개다. 구형 3개를 새 실제 승인 컴포넌트에서 재현하면 각각 1명·1명·7명으로 표시된다. 단순 missing 집계로 122개 인력 유실이라 판단할 수 없다.
- 선택 파일 사유 47개: `rfpRequestEvidence: ''` 추가이며 기존 비어 있지 않은 사유가 사라진 경우 0개.
- 인력 배치 3개: `others: []` 추가. 담당 조직 3개: CIC 공백 정규화. 문자열 9개: 끝 공백/개행 trim. 7개: 빈 값에 현재 원장 값 fallback(그룹웨어명 2, 등록자 이메일 3, 등록자/담당자 ID 각 1). 이는 과거 요청을 현재 원장에 대입한 결과이며 요청 저장본 변경은 아니다.
- 정산 기준 6개 중 4개: SUPPLY_AMOUNT→공급가액 동의어 정규화. **2개는 공급대가→NONE의 의미 변환이므로 무해 정규화와 분리했다.**

### 정산 기준 의미 변환 2건

`change-p1775198490730`(노루OI_1단계, PENDING): 구형 payload에 정산 유형 NONE과 기준 공급대가가 함께 저장돼 있다. 현재 원장은 TYPE2/공급대가다. 구형 mapper 규칙은 정산 유형 NONE이면 기준을 NONE으로 바꾼다. 이는 BFF 문자열 누락이 아니라 입력 내 모순 + 구형 조건부 정규화의 결합이다.

다만 현재 승인 시 이 변환까지 도달하지 않는다. 요청 base 10, target 미기록, 현재 원장 version 20이다. 실제 `mergeProjectAndRequestDocs`를 새 snapshot의 읽기 전용 transaction adapter로 실행했으며 `canonical_version_conflict`가 발생했고, patch 함수 호출 0·쓰기 0이었다. 실제 승인 route도 `enforceChangeRequestVersion`을 사용한다. review-document GET의 추가 검사도 버전 불일치를 blocking 안내한다. 기존 readiness는 이전 형식·미기록·빈 첨부 안내를 반환했다. 따라서 현재 자동 손상으로 단정할 수 없으나, 버전만 억지로 보정해 옛 payload를 승인하면 의미 변환 위험이 남는다. 등록자가 현행 화면에서 정산 유형/기준을 함께 확인하고 새 제출하도록 해야 한다.

`pr-1779778767187`(APPROVED): 구형 요청 NONE/공급대가, 현재 원장도 NONE/공급대가다. 과거 승인 요청을 현재 변경 mapper에 대입하면 NONE으로 정규화된다. 현재 승인 대기 실패나 이번 배포가 값을 바꿨다는 증거는 아니다.

추가 증거: `/tmp/myscube-805-audit/projection-classification.json`, `/tmp/myscube-805-audit/basis-readiness.json`, `/tmp/myscube-805-audit/team-legacy-summary/result.json`. 운영 POST·승인·원장 수정은 하지 않았다.
