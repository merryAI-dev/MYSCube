import { getAuth } from 'firebase-admin/auth';
import { OAuth2Client } from 'google-auth-library';
import { createFirestoreDb, getOrInitAdminApp } from '../bff/firestore.mjs';
import { createQaAuthorityApp } from './app.mjs';

const QA_PROJECT = 'inner-platform-qa-20260310';
const BUSINESS_PROJECT = 'inner-platform-live-20260316';
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST
  || process.env.QA_FIRESTORE_DATABASE_ID !== 'qa-assistant'
  || process.env.QA_AUTHORITY_BUSINESS_PROJECT !== BUSINESS_PROJECT
  || process.env.QA_AUTHORITY_QA_PROJECT !== QA_PROJECT)
  throw Error('Explicit cloud QA and business projects required');
const qaApp = getOrInitAdminApp({ projectId: QA_PROJECT, appName: 'qa-authority-qa' });
const businessApp = getOrInitAdminApp({ projectId: BUSINESS_PROJECT, appName: 'qa-authority-business' });
const oauth = new OAuth2Client();
const app = createQaAuthorityApp({
  qaDb: createFirestoreDb({ projectId: QA_PROJECT, databaseId: 'qa-assistant', appName: 'qa-authority-qa' }),
  businessDb: createFirestoreDb({ projectId: BUSINESS_PROJECT, databaseId: '(default)', appName: 'qa-authority-business' }),
  verifyQaToken: (value) => getAuth(qaApp).verifyIdToken(value, true),
  verifyBusinessToken: (value) => getAuth(businessApp).verifyIdToken(value, true),
  getQaUser: (uid) => getAuth(qaApp).getUser(uid),
  getBusinessUser: (uid) => getAuth(businessApp).getUser(uid),
  verifyWorkerToken: async (value, audience) => (await oauth.verifyIdToken({ idToken: value, audience })).getPayload(),
  workerAudience: process.env.QA_AUTHORITY_AUDIENCE,
  reopenWorkerEmails: [`mysc-qa-intake@${QA_PROJECT}.iam.gserviceaccount.com`],
  projectWorkerEmails: [`qa-investigator@${QA_PROJECT}.iam.gserviceaccount.com`],
  memberWorkerEmails: [`mysc-qa-intake@${QA_PROJECT}.iam.gserviceaccount.com`],
  workerEmails: process.env.QA_AUTHORITY_WORKER_EMAILS?.split(',').map((value) => value.trim()).filter(Boolean),
});
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
