import { randomBytes } from 'node:crypto';
import { createMerryhereClient, kstDate, MerryhereError } from './merryhere-client.mjs';
import { MERRYHERE_CONNECT_PATH } from './merryhere-connection.mjs';

const messages = {
  connected: '연결되었습니다. Slack 스레드로 돌아가 원래 요청을 다시 보내주세요.',
  link_invalid: '링크가 만료되었거나 이미 사용되었습니다. Slack에서 “회의실 계정 연결”을 보내 새 링크를 받아주세요.',
  input_invalid: '아이디와 비밀번호를 입력하고 동의에 체크해주세요.',
  login_failed: 'Merryhere 로그인에 실패했습니다. 아이디와 비밀번호를 확인해주세요. 이 링크로 몇 번 더 시도할 수 있습니다.',
  connect_unavailable: '회의실 계정 연결 기능이 아직 준비되지 않았습니다. 관리자에게 알려주세요.',
  rate_limited: '시도가 너무 많습니다. 잠시 후 다시 시도해주세요.',
  provider: 'Merryhere 응답을 확인하지 못했습니다. 잠시 후 다시 시도해주세요. 비밀번호는 저장하지 않았습니다.',
};

// Login is proven by opening the reservation page as the user; a rejected login silently returns to the login form.
export function verifyMerryhereLogin({ fetchImpl = fetch, now = Date.now } = {}) {
  return async ({ email, password }) => {
    const client = createMerryhereClient({ email, password, fetchImpl });
    try { await client.login(); await client.calendar(kstDate(now())); }
    catch (error) { throw new MerryhereError(['login_required', 'login_failed', 'session_expired'].includes(error.code) ? 'login_failed' : error.code || 'provider_error'); }
  };
}

function page(nonce) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Merryhere 계정 연결</title><style>
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--text:#191f28;--muted:#6b7684;--line:#d1d6db;--accent:#00766f;--error:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1b1f24;--text:#eef0f2;--muted:#a3abb4;--line:#39414a;--accent:#3cc2b8;--error:#f87171}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:420px;margin:48px auto;padding:0 16px}form{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}label{display:block;margin:12px 0 4px;font-weight:600}
input[type=text],input[type=password]{box-sizing:border-box;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.consent{display:flex;gap:8px;align-items:flex-start;font-weight:400;color:var(--muted)}button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:default}#result{margin-top:16px;font-weight:600}#result.error{color:var(--error)}#result.ok{color:var(--accent)}
</style></head><body><main><form id="connect" novalidate><h1>Merryhere 계정 연결</h1>
<p>Slack에서 회의실을 조회·예약할 때 사용할 Merryhere 계정을 한 번 연결합니다. 비밀번호는 암호화해 서버에만 보관하며 Slack이나 화면에 다시 표시하지 않습니다.</p>
<label for="loginId">Merryhere 아이디(이메일)</label><input id="loginId" type="text" autocomplete="username" required maxlength="200">
<label for="password">비밀번호</label><input id="password" type="password" autocomplete="current-password" required maxlength="200">
<label class="consent"><input id="consent" type="checkbox"> <span>회의실 조회·예약 시 서버가 내 계정으로 Merryhere에 로그인하며, 예약 확정 시 포인트가 차감되는 것에 동의합니다. Slack에서 “회의실 계정 연결 해제”를 보내면 언제든 삭제됩니다.</span></label>
<button id="submit" type="submit">연결하기</button><div id="result" role="status" aria-live="polite"></div></form></main>
<script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const form=document.getElementById('connect'),result=document.getElementById('result'),button=document.getElementById('submit');
const show=(text,ok)=>{result.textContent=text;result.className=ok?'ok':'error';};
if(!/^[A-Za-z0-9_-]{43}$/.test(token)){show('연결 링크가 올바르지 않습니다. Slack에서 받은 링크를 그대로 열어주세요.',false);button.disabled=true;}
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;show('Merryhere 로그인을 확인하는 중입니다…',true);
try{const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',
body:JSON.stringify({token,loginId:document.getElementById('loginId').value,password:document.getElementById('password').value,consent:document.getElementById('consent').checked})});
const body=await response.json();show(body.message,response.ok);document.getElementById('password').value='';if(response.ok){form.querySelectorAll('input').forEach(i=>i.disabled=true);return;}}
catch{show('연결 요청을 보내지 못했습니다. 잠시 후 다시 시도해주세요.',false);}button.disabled=false;});
</script></body></html>`;
}

export function mountMerryhereConnect(app, { connections, verify, clock = Date.now }) {
  const attempts = new Map();
  const secure = (res, nonce) => res.set({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` });
  app.get(MERRYHERE_CONNECT_PATH, (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    secure(res, nonce).type('html').send(page(nonce));
  });
  app.post(MERRYHERE_CONNECT_PATH, async (req, res) => {
    secure(res, 'none');
    const minute = Math.floor(clock() / 60000), key = req.ip || 'unknown', prior = attempts.get(key);
    const count = prior?.minute === minute ? prior.count + 1 : 1;
    if (attempts.size >= 1000 && !attempts.has(key)) attempts.clear();
    attempts.set(key, { minute, count });
    if (count > 10) return res.status(429).json({ message: messages.rate_limited });
    try {
      await connections.connect(req.body || {}, verify);
      res.json({ ok: true, message: messages.connected });
    } catch (error) {
      const code = messages[error.code] ? error.code : 'provider';
      res.status({ link_invalid: 410, input_invalid: 400, login_failed: 401, connect_unavailable: 503 }[code] || 502).json({ ok: false, message: messages[code] });
    }
  });
}
