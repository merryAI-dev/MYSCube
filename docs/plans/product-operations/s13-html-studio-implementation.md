# S13 — 실제 HTML·Tailwind 제작 공간

목표: 자연어와 참고 자료로 실제 HTML 소스를 생성·수정하고, 원문을 직접 읽고 편집·저장·복원·내보낼 수 있도록 한다. 위젯 설정 JSON을 결과물로 대신하지 않는다. HTTP 전송은 JSON envelope이지만 검토·저장 결과는 HTML/CSS 파일이다.

## 참고 자료를 실제 요청에 제공

- TOI의 성공한 미리보기만 적용하는 흐름: https://toss.tech/article/52885
- Tailwind의 정적 CSS 생성: https://tailwindcss.com/docs/installation/using-vite
- 전체 클래스 이름과 소스 탐지: https://tailwindcss.com/docs/detecting-classes-in-source-files
- 반응형 기준: https://tailwindcss.com/docs/responsive-design
- 의미 있는 HTML와 접근성: https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/HTML

외부 URL을 매 요청마다 임의로 크롤링하지 않는다. 검토한 지침과 저장소에서 직접 작성한 예제를 버전이 있는 reference 파일로 제공한다. 사용자는 전달할 레퍼런스를 확인하고 선택할 수 있다. CEO 요약과 운영 검토처럼 서로 다른 레이아웃 예제를 제공한다. 화면을 꾸미기 위해 실제처럼 보이는 수치·추이·차트를 만들지 않는다.

## 실행과 소스

생성 결과를 먼저 제안으로 보여 주고 사용자가 적용한 뒤 저장한다. 구조 검증 실패 시 1회 수정 요청만 허용하고, 계속 실패하면 기존 소스를 보존하며 실패를 안내한다. HTML/CSS와 native details/summary는 지원하며 임의 JS 실행·React 브라우저 컴파일은 이 버전에 없다.

소스와 실행본을 구분해 저장한다. Tailwind는 서비스 내부에 고정 설치한 버전으로 CSS를 만들고, 결과 CSS·실행 HTML·각 해시를 함께 보존한다. 외부 CDN은 사용하지 않는다. 소스의 과거 버전은 덮지 않고 복원도 새 버전으로 기록한다. Git 리뷰용 파일 내보내기를 제공하며 자동 Git 커밋·PR 작성은 아직 없다.

## UI 기준

TOI의 넓은 미리보기와 요청 패널 분리를 참고한다. 작업 영역은 미리보기/소스를 전환하고, 생성 요청과 레퍼런스는 가까이 배치한다. 정상 화면 위에 생성 오류를 구분해 표시한다. 저장 버전, 미저장 상태, 코드 리뷰 대상이 일치해야 한다. 모바일은 순서를 유지한 한 열로 전환한다.

## 격리와 현재 한계

- 별도 frontend entry/build, 별도 서버 process/DB client. 운영 app에 새 수집 대기·API 호출 없음.
- sandbox 권한 없음, 원문 parse 후 실행문서에 강제 CSP. script·event·network·외부이동·form·외부문서·과도한 DOM 거부.
- 로그인 UID를 key로 제작 세션을 분리해 이전 계정의 늦은 응답이 다음 계정 상태에 적용되지 않도록 한다.
- 제작 데이터와 정책만 저장하며 주정산/월결산/JVM 운영 쓰기는 하지 않는다.
- 독립 GCP/IAM·모델 quota와 전용 key, 운영 자료 공급은 아직 미연결이다. 현재 gcloud 접근 범위에서 workbench/axr 명칭의 프로젝트·secret을 확인하지 못했다. 기존 운영 AI key를 재사용하지 않았다.
- 모델 stub에 의한 계약 테스트와 실제 모델 호출 성공을 혼동하지 않는다. 전용 모델 연결 전 AI 버튼은 비활성 상태이며 API는503을 반환한다.
