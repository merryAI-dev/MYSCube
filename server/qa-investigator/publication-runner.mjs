import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { createCaseAuthorityClient } from './authority-client.mjs';
import { createIssueCloudStore } from './issue-cloud-store.mjs';
import { createIssuePublicationModel } from './issue-publication-model.mjs';
import { createGithubIssueClient } from './github-issue-client.mjs';
import { runPublicationSweep } from './publication-worker.mjs';

async function main() {
  if (process.env.GOOGLE_CLOUD_PROJECT !== 'inner-platform-qa-20260310'
    || !['gpt-6-sol', 'gpt-6-luna'].includes(process.env.QA_MODEL)
    || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('issue_runner_configuration_invalid');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const authorizeScope = createCaseAuthorityClient({ auth, origin: process.env.QA_AUTHORITY_ORIGIN });
  const [apiKey, token] = await Promise.all(['/secrets/openai/key', '/secrets/github/token'].map(async path => (await readFile(path, 'utf8')).trim()));
  if (!apiKey || !token) throw new Error('issue_runner_secret_missing');
  const result = await runPublicationSweep({
    client,
    createDelivery(caseId) {
      const cloud = createIssueCloudStore({ client, caseId, authorizeScope });
      const model = createIssuePublicationModel({ apiKey, model: process.env.QA_MODEL, onModelEvent: cloud.recordModelEvent });
      return { store: cloud.store, authorize: cloud.authorize, ...model, github: createGithubIssueClient({ token }) };
    },
    onResult: async result => { console.log(JSON.stringify({ event: 'qa_issue_publication', ...result })); },
  });
  if (result.failed) process.exitCode = 1;
}
await main().catch(() => { console.error(JSON.stringify({ event: 'qa_issue_publication', status: 'failed', error_code: 'issue_runner_failed' })); process.exitCode = 1; });
