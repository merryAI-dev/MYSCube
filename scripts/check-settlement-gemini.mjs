import { execFileSync } from 'node:child_process';
import { createGeminiCompletion } from '../server/mcp/gemini-model.mjs';

// Explicit one-shot smoke test. Never sends project data or starts a recurring agent.
try {
  const apiKey = (process.env.GEMINI_API_KEY || execFileSync('gcloud', [
    'secrets', 'versions', 'access', 'latest', '--secret=myscube-settlement-agent-gemini-key',
    '--project=inner-platform-live-20260316',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  console.log(JSON.stringify({ keyPresent: Boolean(apiKey), googleKeyShape: /^AIza[0-9A-Za-z_-]{35}$/.test(apiKey) }));
  // SDK 2.6 wraps HTTP 4xx in an error without status. Read the free token endpoint directly for diagnosis.
  const probe = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens', {
    method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'OK' }] }] }), signal: AbortSignal.timeout(10000),
  });
  if (!probe.ok) {
    const body = await probe.json().catch(() => ({}));
    const reason = body.error?.details?.find((item) => item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')?.reason;
    throw Object.assign(new Error('Provider rejected credential probe'), { providerStatus: probe.status,
      providerReason: /^[A-Z_]{1,80}$/.test(reason || '') ? reason : 'PROVIDER_REQUEST_FAILED' });
  }
  const complete = createGeminiCompletion({ apiKey, maxInputTokens: 16000 });
  const response = await complete({ messages: [{ role: 'user', content: '연결 확인입니다. OK라고만 답하세요.' }], tools: [], signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ connected: Boolean(response.content), model: 'gemini-3.6-flash' }));
} catch (error) {
  console.error(JSON.stringify({ providerStatus: error.providerStatus || null, providerReason: error.providerReason || 'CONFIGURATION_ERROR' }));
  console.error('연결 확인 실패: Secret Manager 키 등록, gcloud 인증, 모델 접근 권한을 확인하세요.');
  process.exitCode = 1;
}
