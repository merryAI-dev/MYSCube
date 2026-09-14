import { createSlackAlertService } from '../server/bff/slack-alerts.mjs';

const token = process.env.CASHFLOW_SLACK_BOT_TOKEN || process.env.SLACK_ALERT_BOT_TOKEN;
const channel = 'C0BQ6980HR6';
if (!token) {
  console.error('Slack bot token is not configured. Inject CASHFLOW_SLACK_BOT_TOKEN or SLACK_ALERT_BOT_TOKEN from the secret store.');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error('Slack authentication failed');
    console.log(JSON.stringify({ authenticated: true, teamId: body.team_id, botId: body.bot_id, user: body.user, channel, scopes: response.headers.get('x-oauth-scopes') }));
    if (process.argv.includes('--send-test')) {
      await createSlackAlertService({
        webhookUrl: '', botToken: token, channelId: channel,
        fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }),
      }).notifyMessage({ text: '[MYSCube 정산 도우미 연결 테스트] 기존 Slack 앱의 발송 연결을 확인합니다. 모델 API 호출과 정산 데이터 변경은 수행하지 않았습니다. 자동 질의응답은 아직 활성화되지 않았습니다.' });
      console.log(JSON.stringify({ testMessageSent: true, channel }));
    }
  } catch {
    console.error('Slack connection check failed. Check token validity, bot membership, and chat:write scope. No automatic retry was performed.');
    process.exitCode = 1;
  }
}
