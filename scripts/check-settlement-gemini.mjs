import { execFileSync } from 'node:child_process';
import { createGeminiCompletion } from '../server/mcp/gemini-model.mjs';

// Explicit one-shot smoke test. Never sends project data or starts a recurring agent.
try {
  const apiKey = process.env.GEMINI_API_KEY || execFileSync('gcloud', [
    'secrets', 'versions', 'access', 'latest', '--secret=myscube-settlement-agent-gemini-key',
    '--project=inner-platform-live-20260316',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const complete = createGeminiCompletion({ apiKey });
  const response = await complete({ messages: [{ role: 'user', content: '연결 확인입니다. OK라고만 답하세요.' }], tools: [], signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ connected: Boolean(response.content), model: 'gemini-3.6-flash' }));
} catch {
  console.error('연결 확인 실패: Secret Manager 키 등록, gcloud 인증, 모델 접근 권한을 확인하세요.');
  process.exitCode = 1;
}
