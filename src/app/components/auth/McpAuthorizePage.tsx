import { useEffect, useState } from 'react';
import { useAuth } from '../../data/auth-store';

export function McpAuthorizePage() {
  const { isLoading, user, loginWithGoogle } = useAuth();
  const [message, setMessage] = useState('MYSCube 로그인 확인 중…');
  const requestId = new URLSearchParams(window.location.search).get('request_id') || '';

  useEffect(() => {
    if (isLoading || !user?.idToken || !requestId) return;
    void fetch('/api/v1/mcp/oauth/authorize/complete', {
      method: 'POST', headers: { authorization: `Bearer ${user.idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId }),
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.redirectUri) throw new Error(body?.message || 'MCP 인증을 완료하지 못했습니다.');
      window.location.assign(body.redirectUri);
    }).catch((error) => setMessage(error instanceof Error ? error.message : 'MCP 인증을 완료하지 못했습니다.'));
  }, [isLoading, requestId, user?.idToken]);

  if (!requestId) return <main className="mx-auto max-w-md p-8 text-sm">MCP 인증 요청이 올바르지 않습니다.</main>;
  if (isLoading) return <main className="mx-auto max-w-md p-8 text-sm">{message}</main>;
  if (!user) return (
    <main className="mx-auto max-w-md space-y-4 p-8 text-sm">
      <p>AI 도구(Claude, ChatGPT 등)에서 MYSCube 데이터를 조회하려면 회사 Google 계정으로 한 번 로그인해 주세요. 로그인 상태는 30일 동안 유지됩니다.</p>
      <button type="button" className="rounded bg-slate-900 px-4 py-2 text-white" onClick={() => void loginWithGoogle()}>Google로 로그인</button>
    </main>
  );
  return <main className="mx-auto max-w-md p-8 text-sm">{message}</main>;
}
