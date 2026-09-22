import { execFileSync } from 'node:child_process';
import { Firestore } from 'firebase-admin/firestore';
import { OAuth2Client } from 'google-auth-library';
import { createQaEvidenceService } from '../server/bff/qa-evidence.mjs';
import { createGithubCodeReader } from '../server/bff/github-code-evidence.mjs';
if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run the separate emulator QA for fixtures.');
const authClient = new OAuth2Client({ eagerRefreshThresholdMillis: 1000 });
authClient.setCredentials({ access_token: execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), expiry_date: Date.now() + 300000 });
const db = new Firestore({ projectId: 'inner-platform-live-20260316', authClient });
try {
  const members = await db.collection('orgs/mysc/members').where('role', '==', 'admin').get();
  const member = members.docs.find((doc) => doc.data().status === 'ACTIVE');
  if (!member) throw new Error('No active persisted admin available for read verification.');
  const context = { tenantId: 'mysc', actorId: member.id, actorRole: 'admin' };
  const query = createQaEvidenceService({ db });
  const result = await query(context, { question: '보관 중인 오류의 코드 버전과 원인 근거가 충분한가요?', area: 'draft' });
  const selected = result.logs[0] ? await query(context, { question: '이 오류의 원인을 확인할 근거는?', area: 'draft', eventId: result.logs[0].id }) : null;
  const sha = process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const github = await createGithubCodeReader()({ sha, area: 'draft', code: 'project_registration_draft_not_found' });
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), productionReadOnly: true, productionWrites: 0,
    actualLogsRead: result.logs.length, truncated: result.coverage.truncated,
    logsWithClientRelease: result.logs.filter((row) => row.clientRelease).length,
    selectedCorrelation: selected?.correlation, selectedCodeStatus: selected?.github.status,
    selectedUnknowns: selected?.unknowns, githubIndependentRead: { status: github.status, sha, paths: github.items.map((item) => ({ path: item.path, status: item.status, blobSha: item.blobSha, url: item.url })) },
    note: '별도 GitHub 조회의 SHA는 로컬 HEAD입니다. 운영 오류의 실패 버전으로 연결하지 않았습니다.' }, null, 2));
} finally { await db.terminate(); }
