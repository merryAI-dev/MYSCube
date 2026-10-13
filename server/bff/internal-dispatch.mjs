import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// MCP 가 기존 조회 API 를 같은 프로세스 안에서 부를 때만 붙는 표식이다. Symbol 이라 HTTP 요청으로는
// 만들 수 없고, 컨텍스트 미들웨어는 이 표식이 있을 때만 OAuth 로 확인된 MCP 사용자 context 를 쓴다.
// 그래서 각 API 의 역할·프로젝트 범위 검사가 앱 화면과 똑같이 적용된다.
export const MCP_INTERNAL_CONTEXT = Symbol('myscube.mcpInternalContext');

export function dispatchInternalGet(app, { path, query = {}, context, timeoutMs = 20_000 }) {
  if (!path.startsWith('/api/v1/')) throw new Error('internal_dispatch_path_invalid');
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)])).toString();
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = search ? `${path}?${search}` : path;
  req.headers = { host: 'internal.myscube' };
  req[MCP_INTERNAL_CONTEXT] = context;
  req.push(null);
  const res = new ServerResponse(req);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error('internal_dispatch_timeout')), timeoutMs);
    const collect = (chunk, encoding) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    };
    res.write = (chunk, encoding) => { collect(chunk, encoding); return true; };
    res.end = (chunk, encoding) => {
      collect(chunk, encoding);
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      let body = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON bodies are returned as text */ }
      resolve({ status: res.statusCode, body });
      res.emit('finish');
      return res;
    };
    try { app(req, res, (error) => { clearTimeout(timer); reject(error || new Error('internal_dispatch_not_found')); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
