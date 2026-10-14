import { appendFileSync } from 'node:fs';
import { formatUsageReport, SERVERS, summarizeUsage, usageQuery } from '../mcp-worker/src/usage-report.mjs';

// 주간 MCP(MYSCube·EMA Station) 사용량을 Analytics Engine 에서 읽어 GitHub 실행 요약에 남기고, 웹훅이 있으면 Slack 에 올린다.
// 사용법: node scripts/mcp-usage-report.mjs [일수=7]
const env = process.env;
const days = Number(process.argv[2] || env.REPORT_DAYS || 7);
const auth = env.CLOUDFLARE_API_TOKEN
  ? { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
  : { 'X-Auth-Key': env.CLOUDFLARE_API_KEY, 'X-Auth-Email': env.CLOUDFLARE_EMAIL };

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Cloudflare ${path.split('?')[0]} failed: ${response.status} ${text.slice(0, 300)}`);
  return text;
}

const zone = JSON.parse(await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}`)).result;
if (zone.name !== 'myscguard.app') throw new Error('Unexpected zone');
const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const sections = [];
for (const { title, dataset } of SERVERS) {
  // 아직 한 번도 기록되지 않은 데이터셋은 조회 오류가 난다. 다른 서버 보고는 계속 낸다.
  let rows;
  try {
    const raw = await cf(`/accounts/${zone.account.id}/analytics_engine/sql`, { method: 'POST', body: `${usageQuery(days, dataset)} FORMAT JSON` });
    rows = JSON.parse(raw).data ?? [];
  } catch (error) {
    console.error(`${title}: ${error.message}`);
    sections.push(`*${title} 사용량*\n조회하지 못했습니다(아직 기록이 없거나 조회 오류). 실행 로그를 확인하세요.`);
    continue;
  }
  sections.push(formatUsageReport(summarizeUsage(rows), { days, from: day(days), to: day(0), title }));
}
const text = sections.join('\n\n');
console.log(text);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (env.MCP_USAGE_SLACK_WEBHOOK_URL) {
  const response = await fetch(env.MCP_USAGE_SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!response.ok) throw new Error(`Slack webhook failed: ${response.status}`);
} else {
  console.log('MCP_USAGE_SLACK_WEBHOOK_URL 이 없어 Slack 전송은 건너뜁니다.');
}
