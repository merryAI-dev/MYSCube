import { createBffApp } from '../server/bff/app.mjs';
import { createFirestoreDb } from '../server/bff/firestore.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_PROJECT_ID !== 'demo-product-operations-browser') {
  throw new Error('This browser QA server requires the isolated demo Firestore emulator.');
}
const db = createFirestoreDb({ projectId: process.env.FIREBASE_PROJECT_ID });
await db.doc('orgs/mysc/members/u001').set({ uid: 'u001', status: 'ACTIVE', role: 'admin' });
await db.doc('orgs/mysc/members/u002').set({ uid: 'u002', status: 'ACTIVE', role: 'pm', projectIds: ['qa-project'] });
await db.doc('orgs/mysc/projects/qa-project').set({ name: 'QA 격리 사업', cic: 'CIC1', status: 'ACTIVE' });
await db.doc('orgs/mysc/client_error_events/qa-browser-example').set({ actorId: 'u001', createdAt: new Date().toISOString(), occurredAt: new Date().toISOString(), extra: { code: 'project_draft_conflict', status: 409 }, message: 'QA 비공개 오류 원문', actorEmail: 'private@example.test' });
const app = createBffApp({ projectId: process.env.FIREBASE_PROJECT_ID, authMode: 'headers', allowedOrigins: ['http://localhost:4173'] });
app.listen(8797, '127.0.0.1', () => console.log('Isolated product operations QA BFF: http://127.0.0.1:8797'));
