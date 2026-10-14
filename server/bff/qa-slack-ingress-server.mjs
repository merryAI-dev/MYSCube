// Dedicated public Cloud Run service: only the signed Slack event route is mounted.
import { readFileSync } from 'node:fs';
import express from 'express';
import { createFirestoreDb } from './firestore.mjs';
import { createQaSlackIngress, mountQaSlackIngressRoute } from './qa-slack-ingress.mjs';

const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
const databaseId = process.env.QA_FIRESTORE_DATABASE_ID?.trim();
if (!projectId || databaseId !== 'qa-assistant' || process.env.FIRESTORE_EMULATOR_HOST
  || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Dedicated cloud QA database required');
const tenantId = process.env.QA_SLACK_TENANT_ID?.trim();
const teamId = process.env.QA_SLACK_TEAM_ID?.trim();
const allowedChannels = process.env.QA_SLACK_ALLOWED_CHANNELS?.split(',').map((v) => v.trim()).filter(Boolean);
const secretPath = process.env.QA_SLACK_SIGNING_SECRET_PATH?.trim();
if (!secretPath?.startsWith('/')) throw Error('Mounted Slack signing secret required');
const signingSecret = readFileSync(secretPath, 'utf8').trim();
const app = express();
app.disable('x-powered-by');
mountQaSlackIngressRoute(app, { ingress: createQaSlackIngress({
  db: createFirestoreDb({ projectId, databaseId }), tenantId, teamId, allowedChannels,
}), signingSecret });
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
