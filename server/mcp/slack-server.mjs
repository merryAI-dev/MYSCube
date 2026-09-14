import express from 'express';
import { createFirestoreDb } from '../bff/firestore.mjs';
import { createSlackIngress } from './slack-ingress.mjs';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECT is required');
const app = express();
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/slack/events', express.raw({ type: 'application/json', limit: '32kb' }), createSlackIngress({
  db: createFirestoreDb({ projectId }), secret: process.env.SLACK_SIGNING_SECRET,
  teamId: process.env.SLACK_TEAM_ID,
}));
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
