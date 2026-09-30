import { waitUntil } from '@vercel/functions';
import { createBffApp } from '../bff/app.mjs';
import { resolveProjectId } from '../bff/firestore.mjs';
import { createSlackServiceHandler } from './slack-service-boundary.mjs';

const app = createBffApp({ projectId: resolveProjectId(), waitUntil });
export default createSlackServiceHandler(app, { release: process.env.SLACK_SERVICE_RELEASE });
