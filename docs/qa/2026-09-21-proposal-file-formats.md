# 제안서 파일 슬롯 형식 확대 — 업로드 경로 검증

## 범위

`proposal_word_original` / `proposalWordOriginalDocument` 키를 유지하면서 제안서 파일 슬롯만 PDF, DOC/DOCX, HWP/HWPX, PPT/PPTX, XLS/XLSX를 허용한다. 기존 DOCX와 저장된 첨부를 수정하거나 옮기는 작업은 없다. 다른 슬롯, 10MB 제한, 주정산/월결산/JVM은 변경하지 않는다.

확장자·MIME·기본 헤더 유형은 `project-proposal-file-formats.mjs`를 프론트와 BFF가 함께 사용한다. 브라우저가 빈 값이나 generic MIME을 주더라도 허용 확장자에 따른 MIME으로 업로드한다. BFF는 확장자, MIME, 기본 PDF/ZIP/OLE 헤더를 확인한다. HWP는 CFB/OLE 형식(5.x), HWPX는 ZIP 컨테이너다. 한컴의 [공식 형식 설명](https://blog.hancom.com/en/hwp-hwpx-data-extraction-format-library/)에서 이를 확인했다. 구형 HWP 2.x/3.x의 별도 바이너리 규격까지 지원했다고 주장하지 않는다.

깊은 압축 해제/본문 파싱/악성파일 검사나 문서 미리보기 기능을 새로 추가하지 않았다. 기존 DOCX/PPTX 검증과 같은 컨테이너 헤더 수준이다. ZIP/OLE 형식 내부 문서 종류까지 판별하는 검증은 아니다.

## 데이터 경로

- 프론트: 파일 선택 accept, 확장자 허용, 업로드 MIME을 동일 표에 맞춘다.
- 등록/수정 signed URL init: 제안서 슬롯의 파일명/MIME을 같은 규칙으로 확인한다.
- 등록/수정 첨부 bind: 실제 바이트의 기본 헤더까지 공통 validator로 확인한다. 기존 base64 경로와 signed Storage path 경로에 함께 적용된다.
- 복원: 기존 경로·소유권·크기·MIME 일치 검사를 유지한다. 과거 저장 파일의 형식을 새 정책으로 재판정하거나 삭제하지 않는다.
- 제출/승격: 기존 키/이름/MIME/크기를 유지하며 원본 바이트를 복사한다.
- Storage rules: private draft 및 canonical registration 경로는 클라이언트 직접 접근이 차단되고 BFF Admin SDK/signed URL을 사용한다. MIME별 rules 제한은 없으므로 rules 변경이 필요하지 않다.

## 실행 결과

- 6개 테스트 파일 **252개 통과**: `/tmp/myscube-proposal-formats-tests2.log`.
- 9가지 형식 각각 프론트 허용/MIME, BFF 헤더, 등록 최종 제출, 수정 최종 제출, 수정 init→Storage bind, 복원 메타데이터, canonical 복사를 실행했다.
- 헤더 위장, MIME 불일치, 이중 확장자, ZIP/HTML/매크로 확장자 등 허용 목록 밖 파일을 거부했다. 계약서·견적서 등 다른 슬롯 제한은 유지된다.
- 등록 init에도 9형식 정상과 `.exe` 덧붙인 파일 거부를 추가 확인했다: `/tmp/myscube-proposal-registration-init.log`.

테스트의 Storage는 소유권/메타데이터 계약을 재현하는 fixture이며, 운영 파일을 업로드하지 않았다. 실제 운영 브라우저 업로드 완료나 배포 완료를 뜻하지 않는다.
