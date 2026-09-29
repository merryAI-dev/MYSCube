import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { localStore } from '../server/mcp/merryhere-local-store.mjs';
import { createMerryhereClient, kstDate } from '../server/mcp/merryhere-client.mjs';
import { executeLocalRoomCommand } from '../server/mcp/merryhere-local-executor.mjs';

const base = 'https://myscube.myscguard.app';
const store = await localStore(join(homedir(), '.myscube-merryhere'));
const action = process.argv[2];
async function api(action, token, body) {
  const response = await fetch(`${base}/api/v1/merryhere/local/${action}`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 401 ? 'local_connection_expired' : 'local_server_unavailable');
  return response.json();
}
try {
  if (action === 'login') {
    if (!process.stdin.isTTY) throw new Error('interactive_terminal_required');
    let muted = false;
    const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
    const terminal = createInterface({ input: process.stdin, output, terminal: true });
    const email = await terminal.question('Merryhere 이메일: ');
    const pending = terminal.question('Merryhere 비밀번호 (화면에 표시되지 않습니다): ');
    muted = true;
    const password = await pending;
    terminal.close(); process.stdout.write('\n');
    let session;
    const client = createMerryhereClient({ email, password, saveSession: async cookies => { session = cookies; } });
    await client.login(); await client.calendar(kstDate());
    const identities = await store.read('identities.json') || {};
    const identity = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    const accountKey = identities[identity] || randomBytes(16).toString('hex');
    await store.write('identities.json', { ...identities, [identity]: accountKey });
    await store.write('session.json', { cookies: session, accountKey });
    console.log('로그인 확인 완료. 세션만 이 컴퓨터에 저장했습니다. 비밀번호는 저장하지 않았습니다.');
  } else if (action === 'pair') {
    const token = randomBytes(32).toString('hex'), code = randomBytes(16).toString('hex');
    await api('register', token, { code });
    await store.write('connection.json', { token });
    console.log(`Slack에서 봇을 멘션하고 다음 문장을 보내세요 (10분 이내):\n회의실 로컬 연결 ${code}\n이후 npm run merryhere:local -- run 으로 실행기를 켜세요.`);
  } else if (action === 'run') {
    const connection = await store.read('connection.json');
    if (!connection?.token) throw new Error('local_pair_required');
    console.log('로컬 회의실 실행기 시작. 종료하려면 Ctrl+C. 로그인 필요 시 별도 터미널에서 npm run merryhere:local -- login');
    let priorStatus;
    for (;;) {
      try {
        const session = await store.read('session.json');
        const ready = Boolean(session?.cookies && Object.keys(session.cookies).length);
        const { paired, command, pending } = await api('poll', connection.token, { sessionReady: ready, accountKey: session?.accountKey });
        if (pending) {
          if (!process.stdin.isTTY) throw new Error('interactive_terminal_required');
          const terminal = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await terminal.question(`Slack 연결 요청: ${String(pending.name).replace(/[\x00-\x1f\x7f]/g, '')} (${String(pending.email).replace(/[\x00-\x1f\x7f]/g, '')}). 본인 계정인가요? [yes/no] `);
          terminal.close();
          await api('approve', connection.token, { requestId: pending.requestId, accepted: answer.trim().toLowerCase() === 'yes' });
          continue;
        }
        const status = paired ? ready ? '연결됨' : '로컬 로그인이 필요합니다' : 'Slack 연결 코드를 입력해주세요';
        if (priorStatus !== status) console.log(status);
        priorStatus = status;
        if (command) {
          const result = await executeLocalRoomCommand({ command, store, authorizeWrite: id => api('permit', connection.token, { id }) });
          if (!result.ok && ['login_required', 'login_failed', 'session_expired'].includes(result.code)) {
            await store.write('session.json', {});
            console.log('Merryhere 세션이 만료되었습니다. 별도 터미널에서 npm run merryhere:local -- login 을 실행해주세요.');
          }
          await api('complete', connection.token, { id: command.id, result });
        }
      } catch (error) {
        if (['local_connection_expired', 'interactive_terminal_required'].includes(error.message)) throw error;
        if (priorStatus !== 'offline') console.log('서버 연결이 지연되고 있습니다. 예약은 자동 재제출하지 않습니다.');
        priorStatus = 'offline';
      }
      await sleep(3000);
    }
  } else console.log('사용법: npm run merryhere:local -- login | pair | run');
} catch (error) {
  const messages = { interactive_terminal_required: '본인의 터미널에서 login을 실행해주세요.', local_pair_required: '먼저 pair로 Slack과 연결해주세요.',
    local_connection_expired: '로컬 연결이 만료되거나 해제되었습니다. pair로 다시 연결해주세요.',
    local_server_unavailable: '서버 연결을 확인하지 못했습니다. 배포 상태를 확인해주세요.' };
  console.error(messages[error.message] || '처리하지 못했습니다. 로그인 정보·연결·로컬 파일 권한을 확인해주세요.'); process.exitCode = 1;
}
