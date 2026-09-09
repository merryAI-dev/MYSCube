#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/;
const INVOCATION = /^[1-9][0-9]*-[1-9][0-9]*$/;
const DEPLOYMENT_URL = /https:\/\/[A-Za-z0-9.-]+\.vercel\.app/g;

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing deployment environment: ${name}`);
  return value;
}

function pair(args, flag, name, value) {
  args.push(flag, `${name}=${value}`);
}

export function buildVercelProductionDeployArgs({
  sourceDir, commitSha, invocation, maintenance, env = process.env,
}) {
  if (typeof sourceDir !== 'string' || !sourceDir
    || !FULL_SHA.test(commitSha)
    || !INVOCATION.test(invocation)
    || typeof maintenance !== 'boolean') {
    throw new Error('Invalid Vercel production deployment input.');
  }
  const liveProject = required(env, 'LIVE_FIREBASE_PROJECT_ID');
  const args = [
    '--yes', required(env, 'VERCEL_CLI_PACKAGE'), 'deploy', '--prod', '--yes', '--skip-domain',
    '--token', required(env, 'VERCEL_TOKEN'), '--scope', 'merryai-devs-projects',
  ];
  pair(args, '--build-env', 'VITE_PLATFORM_API_ENABLED', 'true');
  pair(args, '--build-env', 'VITE_FIRESTORE_CORE_ENABLED', 'false');
  pair(args, '--build-env', 'VITE_FIREBASE_PROJECT_ID', liveProject);
  for (const [name, value] of [
    ['BFF_DEPLOY_ENV', required(env, 'BFF_DEPLOY_ENV')],
    ['BFF_AUTH_MODE', required(env, 'BFF_AUTH_MODE')],
    ['BFF_EDIT_LEASES_ENABLED', required(env, 'BFF_EDIT_LEASES_ENABLED')],
    ['BFF_WORKERS_ENABLED', maintenance ? 'false' : 'true'],
    ['BFF_SCHEDULER_OWNER', maintenance ? 'disabled' : 'vercel'],
    ['BFF_MAINTENANCE_READ_ONLY', maintenance ? 'true' : 'false'],
    ['BFF_ALLOWED_ORIGINS', required(env, 'BFF_ALLOWED_ORIGINS')],
    ['MYSCUBE_MCP_OAUTH_ISSUER', 'https://myscube.myscguard.app'],
    ['MYSCUBE_MCP_PUBLIC_ORIGIN', 'https://myscube.myscguard.app'],
    ['FIREBASE_PROJECT_ID', liveProject],
    ['BFF_FIREBASE_AUTH_PROJECT_ID', liveProject],
    ['BFF_LIVE_FIREBASE_PROJECT_ID', liveProject],
    ['JVM_WEEKLY_FIRESTORE_PROJECT_ID', required(env, 'JVM_WEEKLY_FIRESTORE_PROJECT_ID')],
    ['JVM_WEEKLY_AUTH_MODE', required(env, 'JVM_WEEKLY_AUTH_MODE')],
    ['JVM_WEEKLY_API_BASE_URL', required(env, 'JVM_WEEKLY_API_BASE_URL')],
    ['JVM_WEEKLY_API_ID_TOKEN_AUDIENCE', required(env, 'JVM_WEEKLY_API_ID_TOKEN_AUDIENCE')],
    ['JVM_WEEKLY_INTERNAL_API_TOKEN', required(env, 'JVM_WEEKLY_INTERNAL_API_TOKEN')],
    ['JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON', required(env, 'JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON')],
    ['SLACK_ALERT_WEBHOOK_URL', ''],
    ['SLACK_ALERT_BOT_TOKEN', required(env, 'SLACK_ALERT_BOT_TOKEN')],
    ['SLACK_ALERT_CHANNEL_ID', required(env, 'SLACK_ALERT_CHANNEL_ID')],
    ['PROJECT_REGISTRATION_SLACK_WEBHOOK_URL', ''],
    ['PROJECT_REGISTRATION_SLACK_BOT_TOKEN', ''],
    ['PROJECT_REGISTRATION_SLACK_CHANNEL_ID', ''],
  ]) pair(args, '--env', name, value);
  pair(args, '--meta', 'maintenanceReadOnly', String(maintenance));
  pair(args, '--meta', 'githubCommitSha', commitSha);
  pair(args, '--meta', 'githubActionsInvocation', invocation);
  return { command: 'npx', args, cwd: sourceDir };
}

export async function deployVercelProductionCandidate(options, spawnImpl = spawn) {
  const command = buildVercelProductionDeployArgs(options);
  if (!statSync(command.cwd).isDirectory()) throw new Error('Deployment source directory is missing.');
  let output = '';
  await new Promise((resolvePromise, reject) => {
    const child = spawnImpl(command.command, command.args, {
      cwd: command.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        const text = String(chunk);
        output += text;
        process.stderr.write(text);
      });
    }
    child.once('error', reject);
    child.once('close', (status) => (
      status === 0 ? resolvePromise() : reject(new Error(`Vercel deploy failed with status ${status}.`))
    ));
  });
  const deploymentUrl = [...output.matchAll(DEPLOYMENT_URL)].at(-1)?.[0] || '';
  if (!deploymentUrl) throw new Error('Could not parse Vercel deployment URL.');
  return { deploymentUrl, deploymentHost: deploymentUrl.slice('https://'.length) };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--source-dir', '--commit-sha', '--invocation', '--maintenance'].includes(name) || value === undefined) {
      throw new Error('Invalid Vercel production deployment arguments.');
    }
    if (values.has(name)) throw new Error('Duplicate Vercel production deployment argument.');
    values.set(name, value);
  }
  if (!['true', 'false'].includes(values.get('--maintenance'))) {
    throw new Error('--maintenance must be true or false.');
  }
  return {
    sourceDir: resolve(values.get('--source-dir') || ''),
    commitSha: values.get('--commit-sha'),
    invocation: values.get('--invocation'),
    maintenance: values.get('--maintenance') === 'true',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await deployVercelProductionCandidate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
