import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

describe('local Kubernetes rehearsal manifests', () => {
  it('keeps the local overlay isolated from live data and schedulers', () => {
    const configMap = read('infra/k8s/overlays/local/bff-env-configmap.yaml');
    const overlay = read('infra/k8s/overlays/local/kustomization.yaml');
    const namespace = read('infra/k8s/overlays/local/namespace.yaml');

    expect(configMap).toContain('BFF_DEPLOY_ENV: local');
    expect(configMap).toContain('FIREBASE_PROJECT_ID: demo-inner-platform-local');
    expect(configMap).not.toContain('inner-platform-live-20260316');
    expect(configMap).toContain('BFF_WORKERS_ENABLED: "false"');
    expect(configMap).toContain('BFF_SCHEDULER_OWNER: disabled');
    expect(configMap).toContain('FIRESTORE_EMULATOR_HOST: host.docker.internal:8080');
    expect(overlay).toContain('value: Never');
    expect(namespace).toContain('inner-platform.mysc.co.kr/environment: local');
  });

  it('does not define CronJobs or public ingress in the local overlay', () => {
    const files = [
      'infra/k8s/base/bff-deployment.yaml',
      'infra/k8s/base/bff-service.yaml',
      'infra/k8s/base/kustomization.yaml',
      'infra/k8s/overlays/local/bff-env-configmap.yaml',
      'infra/k8s/overlays/local/kustomization.yaml',
      'infra/k8s/overlays/local/namespace.yaml',
    ];
    const combined = files.map(read).join('\n---\n');

    expect(combined).not.toMatch(/\bkind:\s*CronJob\b/);
    expect(combined).not.toMatch(/\bkind:\s*Ingress\b/);
    expect(combined).not.toMatch(/\btype:\s*LoadBalancer\b/);
    expect(combined).not.toMatch(/\btype:\s*NodePort\b/);
  });

  it('keeps the BFF container build compatible with production-only installs', () => {
    const dockerfile = read('server/bff/Dockerfile');

    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
    expect(dockerfile).toContain('COPY policies ./policies');
    expect(dockerfile).toContain('COPY src/app/policies ./src/app/policies');
  });
});
