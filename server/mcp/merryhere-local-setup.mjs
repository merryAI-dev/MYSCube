import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { saveLocalRoomLogin, localRelayApi } from './merryhere-local-login.mjs';

export async function startLocalRoomSetup({ store, startRunner, login = saveLocalRoomLogin, api = localRelayApi }) {
  const nonce = randomBytes(24).toString('hex');
  let origin, busy = false, pairingCode = '', started = false, approvedRequest;
  const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Merryhere 개인 연결</title>
<style>body{font:16px system-ui;max-width:620px;margin:60px auto;padding:24px;background:#f5f7fa;color:#182a38}section{background:white;padding:24px;border-radius:16px;margin:18px 0}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}button{background:#185f52;color:white;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef4f1;padding:16px}#status{white-space:pre-wrap}small{line-height:1.7}label{display:block}</style>
<h1>Merryhere 개인 연결</h1><p>로그인 세션은 이 컴퓨터에만 저장됩니다. 비밀번호는 저장하거나 Slack으로 보내지 않습니다.</p>
<section><h2>1. Merryhere 로그인</h2><form id="login"><label>아이디 또는 이메일<input name="loginId" type="text" autocomplete="username" autocapitalize="none" required></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label><button>로그인하고 세션 저장</button></form></section>
<section><h2>2. Slack 계정 연결</h2><button id="pair">연결 코드 만들기</button><p>기존 채널에서 @innerplatform-alerts를 멘션하고 아래 문장을 보내주세요.</p><pre id="code">로그인 후 연결 코드를 만들어주세요.</pre><button id="check">Slack 연결 요청 확인</button><p id="identity"></p><button id="approve" hidden>표시된 계정이 본인입니다 · 연결하고 실행</button></section>
<p id="status" role="status">설정 준비 완료</p><small>연결 완료 후에는 실행기가 백그라운드에서 동작합니다. 컴퓨터가 꺼져 있거나 잠자기 상태이면 회의실 요청을 처리할 수 없습니다.</small>
<script nonce="${nonce}">
const status=document.querySelector('#status');let pending;
async function call(action,data={}){status.textContent='처리 중…';let r=await fetch(location.pathname+'/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});let v=await r.json();if(!r.ok)throw Error(v.error);return v;}
async function act(fn){for(const b of document.querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){status.textContent=e.message;}finally{for(const b of document.querySelectorAll('button'))b.disabled=false;}}
document.querySelector('#login').onsubmit=e=>{e.preventDefault();act(async()=>{const f=e.target;const data=Object.fromEntries(new FormData(f));f.password.value='';await call('login',data);status.textContent='로그인 확인 완료. 연결 코드를 만들어주세요.';});};
document.querySelector('#pair').onclick=()=>act(async()=>{const v=await call('pair');document.querySelector('#code').textContent='회의실 로컬 연결 '+v.code;status.textContent='이 문장을 Slack에서 봇에게 보낸 뒤 연결 요청 확인을 누르세요. 코드는 10분간 유효합니다.';});
document.querySelector('#check').onclick=()=>act(async()=>{const v=await call('check');pending=v.pending;document.querySelector('#identity').textContent=pending?pending.name+' ('+pending.email+')':'';document.querySelector('#approve').hidden=!pending;status.textContent=v.started?'설정 완료. 백그라운드 실행기가 켜져 있습니다.':pending?'표시된 이름과 이메일이 본인인지 확인해주세요.':'Slack 연결 요청을 기다리고 있습니다.';});
document.querySelector('#approve').onclick=()=>act(async()=>{await call('approve',{requestId:pending.requestId});status.textContent='설정 완료. Slack에서 원래 회의실 질문을 다시 보내세요. 이 창은 닫아도 됩니다.';document.querySelector('#approve').hidden=true;});
</script></html>`;
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host) return send(403, { error: '허용되지 않은 요청입니다.' });
    if (req.method === 'GET' && req.url === `/${nonce}`) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
    if (req.method !== 'POST' || req.headers.origin !== origin || !req.url.startsWith(`/${nonce}/`)
      || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: '설정 화면에서 다시 요청해주세요.' });
    if (busy) return send(409, { error: '앞선 처리가 끝날 때까지 기다려주세요.' });
    busy = true;
    try {
      const chunks = []; let length = 0;
      for await (const part of req) { length += part.length; if (length > 8192) throw new Error('body_limit'); chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), action = req.url.slice(nonce.length + 2);
      if (action === 'login') {
        if (typeof body.loginId !== 'string' || !body.loginId.trim() || body.loginId.length > 320 || typeof body.password !== 'string' || body.password.length > 4096) throw new Error('invalid_login');
        await login({ store, loginId: body.loginId, password: body.password });
        return send(200, { ok: true });
      }
      if (action === 'pair') {
        const session = await store.read('session.json');
        if (!session?.accountKey || !session.cookies) return send(400, { error: '먼저 Merryhere에 로그인해주세요.' });
        const token = randomBytes(32).toString('hex'); pairingCode = randomBytes(16).toString('hex');
        await api('register', token, { code: pairingCode });
        await store.write('connection.json', { token }); started = false; approvedRequest = null;
        return send(200, { code: pairingCode });
      }
      const connection = await store.read('connection.json'), session = await store.read('session.json');
      if (!connection?.token) return send(400, { error: '먼저 연결 코드를 만들어주세요.' });
      if (action === 'check') {
        if (!pairingCode || started) return send(200, { pending: null, started });
        const state = await api('poll', connection.token, { sessionReady: Boolean(session?.cookies), accountKey: session?.accountKey });
        return send(200, { pending: state.pending || null, started });
      }
      if (action === 'approve') {
        if (approvedRequest !== body.requestId || !approvedRequest) {
          await api('approve', connection.token, { requestId: body.requestId, accepted: true });
          approvedRequest = body.requestId;
        }
        await startRunner(); started = true;
        send(200, { ok: true }); server.close(); return;
      }
      send(404, { error: '알 수 없는 요청입니다.' });
    } catch { send(400, { error: '처리하지 못했습니다. 로그인 정보 또는 서버 연결을 확인한 뒤 다시 시도해주세요.' }); }
    finally { busy = false; }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/${nonce}` };
}
