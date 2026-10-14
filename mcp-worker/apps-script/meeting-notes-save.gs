// 회의록 드라이브 저장 웹 앱. EMA MCP Worker 가 호출한다. 배포 URL 은 Worker 설정(NOTES_SAVE_URL)에 둔다.
// 배포: 폴더 편집 권한이 있는 계정으로 script.google.com 새 프로젝트 → 이 코드 붙여넣기
//   → 배포 > 새 배포 > 웹 앱, 실행: 나, 액세스: 모든 사용자 → 웹 앱 URL 을 Worker 비밀 NOTES_SAVE_URL 로.
const FOLDER_ID = '16jX-kywwIxXxYUGMWk1roj0fiW6yC4v-';

function doPost(e) {
  const reply = (body) => ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
  let input;
  try { input = JSON.parse(e.postData.contents); } catch (error) { return reply({ ok: false, error: 'bad_request' }); }
  const fileName = String(input.fileName || '').trim();
  const markdown = String(input.markdown || '');
  const sourceRef = String(input.sourceRef || '').trim();
  if (!/\.md$/.test(fileName) || !markdown) return reply({ ok: false, error: 'bad_request' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const folder = DriveApp.getFolderById(FOLDER_ID);
    let file = null;
    const byName = folder.getFilesByName(fileName);
    if (byName.hasNext()) file = byName.next();
    if (!file && sourceRef) {
      const tag = 'sourceRef:' + sourceRef;
      const bySource = folder.searchFiles('fullText contains ' + JSON.stringify(tag) + ' and trashed = false');
      while (!file && bySource.hasNext()) {
        const candidate = bySource.next();
        if (candidate.getDescription() === tag) file = candidate;
      }
    }
    const updated = Boolean(file);
    if (file) {
      file.setContent(markdown);
      if (file.getName() !== fileName) file.setName(fileName);
    } else {
      file = folder.createFile(fileName, markdown, 'text/markdown');
    }
    if (sourceRef) file.setDescription('sourceRef:' + sourceRef);
    return reply({ ok: true, updated: updated, fileId: file.getId(), url: file.getUrl(), name: file.getName() });
  } finally {
    lock.releaseLock();
  }
}
