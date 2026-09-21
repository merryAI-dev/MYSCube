# 관리자 사업비 입력 방식 제거: 독립 QA

배포804 전수조사와 구분되는 **후속 미배포 소스 패치** 검증이다. 제품 변경은 root 담당, 본 QA는 격리 harness와 문서만 수정했다.

통과 기준: 관리자 승인문서·상세패널·admin Wizard 계약/재무 및 최종 확인에서 사업비 입력 방식 행과 값이 모두 사라진다. 실무자 Portal 양쪽 화면과 저장값은 유지된다. 숨김 처리가 원장/BFF/제출 payload 필드 삭제로 연결되면 실패다.

첫 독립 실행에서 DetailPanel의 전체 제출필드 목록에 `사업비 입력 방식 / BANK_UPLOAD`가 남아 FAIL했다. root가 제출필드 및 누락 안내를 추가 필터링한 후 재실행하여 다음을 확인했다.

- 실제 Dialog, DetailPanel, admin Wizard 재무·최종 확인 DOM에서 사업비 입력 방식/통장내역 업로드0개.
- admin Wizard 임시저장 callback의 fundInputMode는 BANK_UPLOAD 그대로 보존.
- Portal Wizard 재무·최종 확인에는 통장내역 업로드가 유지됨.
- JavaScript 오류0건. actual DetailPanel 캡처도 직접 육안 확인.

**수정 후 지정 범위 PASS.** 합성 fixture, 배포804 소스에 현재3파일을 덮어쓴 로컬 실제 컴포넌트 검증이며 운영 클릭/저장은 실행하지 않았다. 증거 `/tmp/myscube-admin-fund-removal-qa/result.json` 및 PNG, 실행기 `/tmp/myscube-804-required/admin-removal.mjs`.
