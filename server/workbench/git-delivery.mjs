import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createGitCredentialProvider } from './git-credentials.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';
import { WorkspaceSourceSchema, reactSourceIdentity } from '../../shared/workbench-react-workspace.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => createHttpError(status, message, code);
const sha = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw fail(502, 'git_response_invalid', 'GitHub 저장 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
  return value;
};
const sourceInput = (input) => {
  const keys = ['pageId', 'version', 'title', 'sourceHash', 'code', 'workspace', 'apiIds', 'apiBindings', 'packageSetHash'];
  let identity;
  if (input && Object.hasOwn(input, 'workspace') && !Object.hasOwn(input, 'code')) {
    const parsed = WorkspaceSourceSchema.safeParse({ title: input.title, workspace: input.workspace });
    if (parsed.success) identity = reactSourceIdentity(parsed.data);
  } else if (input && !Object.hasOwn(input, 'workspace') && typeof input.code === 'string' && input.code.trim() && Buffer.byteLength(input.code) <= 200_000) {
    identity = input.code;
  }
  if (!input || Object.keys(input).some((key) => !keys.includes(key)) || !/^[a-zA-Z0-9-]{1,100}$/.test(input.pageId || '')
    || !Number.isSafeInteger(input.version) || input.version < 1 || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80
    || identity === undefined
    || !/^[a-f0-9]{64}$/.test(input.sourceHash || '') || digest(identity) !== input.sourceHash
    || !/^[a-zA-Z0-9._:-]{1,100}$/.test(input.packageSetHash || '') || !Array.isArray(input.apiIds) || input.apiIds.length > 20
    || input.apiIds.some((id) => !/^[a-zA-Z0-9-]{1,100}$/.test(id)) || new Set(input.apiIds).size !== input.apiIds.length) {
    throw fail(400, 'git_source_invalid', '저장된 React 버전과 원문 검증값을 확인해 주세요.');
  }
  const sourceText = input.workspace ? Object.values(input.workspace.files).join('\n') : input.code;
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}["'])/i.test(sourceText)) {
    throw fail(400, 'git_source_secret_detected', '코드에 인증 정보로 보이는 값이 있습니다. 제거한 뒤 새 버전으로 저장해 주세요.');
  }
  const bindings = input.apiBindings;
  if (bindings !== undefined && (!Array.isArray(bindings) || bindings.length !== input.apiIds.length
    || bindings.some((binding) => !binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some((key) => !['id', 'version'].includes(key))
      || !input.apiIds.includes(binding.id) || !Number.isSafeInteger(binding.version) || binding.version < 1)
    || new Set(bindings.map((binding) => binding.id)).size !== input.apiIds.length)) {
    throw fail(400, 'git_api_bindings_invalid', '저장한 페이지의 API 연결과 버전이 일치하지 않습니다. 저장 버전을 다시 확인해 주세요.');
  }
  return { ...input, ...(input.workspace ? { workspace: JSON.parse(identity) } : {}), apiIds: [...input.apiIds].sort(), ...(bindings !== undefined ? { apiBindings: [...bindings].sort((a, b) => a.id.localeCompare(b.id)) } : {}) };
};
const configuration = (env) => {
  const repository = env.WORKBENCH_GIT_REPOSITORY;
  const baseBranch = env.WORKBENCH_GIT_BASE_BRANCH || 'main';
  if (!repository || (!(env.WORKBENCH_GIT_CREDENTIAL_MODE === 'github-app') && !env.WORKBENCH_GITHUB_TOKEN)) throw fail(503, 'git_delivery_disabled', 'GitHub 연결이 아직 설정되지 않았습니다. 저장한 페이지는 그대로 유지됩니다.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,100}$/.test(baseBranch) || baseBranch.includes('//')) {
    throw fail(503, 'git_delivery_config_invalid', 'GitHub 저장소 또는 기준 브랜치 설정을 확인해 주세요.');
  }
  return { repository, baseBranch };
};
const safeResult = (record) => Object.fromEntries(['id', 'status', 'repository', 'baseBranch', 'branch', 'pageId', 'version', 'sourceHash', 'commitSha', 'pullNumber', 'pullUrl', 'pullState', 'merged', 'verifiedAt', 'createdAt', 'updatedAt'].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));

export function createGitDeliveryService({ db, env = process.env, authorize, fetchImpl = fetch, now = () => Date.now(), requestTimeoutMs = 12_000, totalTimeoutMs = 45_000, retryDelayMs = 200, credentialProvider }) {
  const credentials = credentialProvider || createGitCredentialProvider({ env, fetchImpl, now });
  if (typeof authorize !== 'function') throw new Error('Git delivery requires authorization');
  const identify = (context, input, config) => {
    if (![context?.tenantId, context?.actorId].every((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value))) throw fail(403, 'git_scope_invalid', '현재 계정과 조직 정보를 확인해 주세요.');
    const id = digest(JSON.stringify([context.tenantId, context.actorId, config.repository.toLowerCase(), config.baseBranch, input.pageId, input.version]));
    return { id, ref: db.doc(`orgs/${context.tenantId}/workbench_git_deliveries/${id}`) };
  };
  const attempt = async (context, value, signal, readOnly = false) => {
      const config = configuration(env);
      const input = sourceInput(value);
      await authorize(context);
      const { id, ref } = identify(context, input, config);
      const identityHash = digest(JSON.stringify(input));
      signal.throwIfAborted();
      const lease = randomUUID();
      let record = await db.runTransaction(async (tx) => {
        const previous = (await tx.get(ref)).data();
        if (readOnly) {
          if (!previous) throw fail(404, 'git_delivery_not_found', '이 저장 버전의 GitHub 전달 이력이 없습니다.');
          if (previous.identityHash !== identityHash) throw fail(409, 'git_version_conflict', '저장 버전과 전달 이력이 일치하지 않습니다.');
          return previous;
        }
        if (previous?.identityHash && previous.identityHash !== identityHash) throw fail(409, 'git_version_conflict', '이 저장 버전으로 이미 다른 원문을 전달했습니다. 새 버전으로 저장해 주세요.');
        if (previous?.status === 'complete') return previous;
        if (previous?.leaseUntil > now()) throw fail(409, 'git_delivery_busy', '이 버전의 GitHub 전달이 진행 중입니다. 잠시 후 다시 확인해 주세요.');
        const next = { ...previous, id, identityHash, repository: config.repository, baseBranch: config.baseBranch,
          pageId: input.pageId, version: input.version, sourceHash: input.sourceHash, branch: `axr/page-${id.slice(0,24)}-${input.sourceHash.slice(0,12)}`,
          createdAt: previous?.createdAt || new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), status: 'publishing', lease, leaseUntil: now() + 90_000 };
        tx.set(ref, next);
        return next;
      });
      const checkpoint = async (patch = {}) => {
        record = await db.runTransaction(async (tx) => {
          const stored = (await tx.get(ref)).data();
          if (stored?.lease !== lease) throw fail(409, 'git_delivery_lease_lost', '다른 요청이 GitHub 전달을 이어받았습니다. 저장 결과를 다시 확인해 주세요.');
          const next = { ...stored, ...patch, updatedAt: new Date(now()).toISOString(), leaseUntil: patch.status === 'complete' ? 0 : now() + 90_000 };
          tx.set(ref, next);
          return next;
        });
      };
      const request = async (method, path, body, allowed = []) => {
        signal.throwIfAborted();
        await authorize(context);
        if (!readOnly && record.status !== 'complete') await checkpoint();
        let response;
        try {
          const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, 12_000)))]);
          const token = await credentials({ repository: config.repository, signal: requestSignal });
          response = await fetchImpl(`https://api.github.com/repos/${config.repository}${path}`, { method, redirect: 'error',
            signal: requestSignal, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        } catch (error) { if (error?.code?.startsWith('git_credential') || error?.code === 'git_delivery_disabled') throw error; signal.throwIfAborted(); throw fail(502, 'git_transport_failed', 'GitHub 응답을 확인하지 못했습니다. 같은 저장 버전으로 다시 시도하면 전달 이력을 확인하고 이어서 처리합니다.'); }
        signal.throwIfAborted();
        await authorize(context);
        if (allowed.includes(response.status)) return { httpStatus: response.status };
        if (!response.ok) throw fail(response.status === 403 ? 403 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 422, response.status >= 500 || response.status === 429 ? 'git_provider_unavailable' : 'git_request_failed', 'GitHub 전달을 완료하지 못했습니다. 연결 권한과 저장소 상태를 확인한 뒤 같은 버전으로 다시 시도해 주세요.');
        try { return await response.json(); } catch { throw fail(502, 'git_response_invalid', 'GitHub 응답을 확인하지 못했습니다. 다시 시도해 주세요.'); }
      };
      const verifyPull = (pull) => {
        if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || pull.head?.sha !== record.commitSha || pull.head?.ref !== record.branch || pull.base?.ref !== config.baseBranch
          || pull.head?.repo?.full_name?.toLowerCase() !== config.repository.toLowerCase() || !['open', 'closed'].includes(pull.state)) throw fail(409, 'git_pull_conflict', 'GitHub 검토 요청과 저장한 코드가 일치하지 않습니다. 기존 요청은 변경하지 않았습니다.');
        return { pullNumber: pull.number, pullUrl: `https://github.com/${config.repository}/pull/${pull.number}`, pullState: pull.state, merged: Boolean(pull.merged_at || pull.merged), verifiedAt: new Date(now()).toISOString() };
      };
      try {
        const repository = await request('GET', '');
        const publicTest = env.WORKBENCH_GIT_ALLOW_PUBLIC_TEST === 'true' && env.WORKBENCH_AUTH_MODE === 'emulator'
          && db.projectId?.startsWith('demo-') && /^(127\.0\.0\.1|localhost):\d+$/.test(env.FIRESTORE_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST || '');
        if (repository.full_name?.toLowerCase() !== config.repository.toLowerCase() || typeof repository.private !== 'boolean') throw fail(502, 'git_repository_invalid', 'GitHub 저장소의 대상과 공개 범위를 확인하지 못했습니다.');
        if (!repository.private && !publicTest) throw fail(403, 'git_public_repository_forbidden', '공개 저장소에는 업무 화면을 자동으로 전달할 수 없습니다. 비공개 전용 저장소를 연결해 주세요. 저장한 화면은 유지됩니다.');
        if (record.status === 'complete') {
          const current = verifyPull(await request('GET', `/pulls/${record.pullNumber}`));
          await authorize(context); return safeResult({ ...record, ...current });
        }
        if (readOnly) return safeResult(record);
        if (!record.commitSha) {
          if (!record.baseSha) {
            const base = await request('GET', `/git/ref/heads/${config.baseBranch}`);
            const commit = await request('GET', `/git/commits/${sha(base.object?.sha)}`);
            await checkpoint({ baseSha: sha(base.object?.sha), baseTree: sha(commit.tree?.sha) });
          }
          const folder = `generated/${id}`;
          const workspace = input.workspace;
          const sourceFiles = workspace ? workspace.files : { 'App.tsx': input.code };
          const manifest = {
            schemaVersion: workspace ? 2 : 1, pageId: input.pageId, version: input.version,
            entry: workspace?.entry || 'App.tsx', sourceHash: input.sourceHash,
            ...(workspace ? { workspaceSchemaVersion: workspace.schemaVersion, workspaceHash: input.sourceHash, packageSetId: workspace.packageSetId, files: Object.keys(sourceFiles).sort() } : {}),
            packageSetHash: input.packageSetHash, apiIds: input.apiIds,
            ...(input.apiBindings !== undefined ? { apis: input.apiBindings } : {}),
            runtime: 'isolated-react', dataExportPolicy: 'source-only-no-response-injection',
          };
          const files = {
            ...Object.fromEntries(Object.entries(sourceFiles).map(([path, content]) => [`${folder}/${path}`, content])),
            [`${folder}/manifest.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
            [`${folder}/README.md`]: '# MYSCube AXR generated React page\n\nThis immutable source is for code review. Registered API identifiers are references. This exporter does not add API credentials or fetched responses. Review any literals already present in the source before sharing. No production deployment or merge is performed.\n',
          };
          const tree = [];
          for (const [path, content] of Object.entries(files)) {
            const blob = await request('POST', '/git/blobs', { content, encoding: 'utf-8' });
            tree.push({ path, mode: '100644', type: 'blob', sha: sha(blob.sha) });
          }
          const builtTree = await request('POST', '/git/trees', { base_tree: record.baseTree, tree });
          const identity = { name: 'MYSCube AXR Workbench', email: 'axr-workbench@users.noreply.github.com', date: record.createdAt };
          const commit = await request('POST', '/git/commits', { message: `feat(axr): generated page ${input.pageId} v${input.version}\n\nSource-SHA256: ${input.sourceHash}`, tree: sha(builtTree.sha), parents: [record.baseSha], author: identity, committer: identity });
          await checkpoint({ commitSha: sha(commit.sha) });
        }
        const branchPath = `/git/ref/heads/${record.branch}`;
        let branch = await request('GET', branchPath, null, [404]);
        if (branch.httpStatus === 404) {
          await request('POST', '/git/refs', { ref: `refs/heads/${record.branch}`, sha: record.commitSha }, [409, 422]);
          branch = await request('GET', branchPath);
        }
        if (sha(branch.object?.sha) !== record.commitSha) throw fail(409, 'git_branch_conflict', '이 버전의 GitHub 브랜치가 변경되었습니다. 기존 코드를 덮어쓰지 않았습니다. 새 버전을 저장해 주세요.');
        const query = `?state=all&head=${encodeURIComponent(`${config.repository.split('/')[0]}:${record.branch}`)}&base=${encodeURIComponent(config.baseBranch)}&per_page=100`;
        const existing = await request('GET', `/pulls${query}`);
        if (!Array.isArray(existing)) throw fail(502, 'git_response_invalid', 'GitHub 검토 요청을 확인하지 못했습니다.');
        let pull = existing.find((item) => item.head?.ref === record.branch && item.base?.ref === config.baseBranch && item.head?.repo?.full_name?.toLowerCase() === config.repository.toLowerCase());
        if (!pull) pull = await request('POST', '/pulls', { title: `[AXR] ${input.title} · v${input.version}`, head: record.branch, base: config.baseBranch, draft: true,
          body: `저장한 React 페이지 v${input.version}의 원문 검토 요청입니다.\n\n- 원문 SHA-256: \`${input.sourceHash}\`\n- 생성 코드와 API 식별자만 포함합니다. 전달기는 API 인증 설정이나 조회 응답을 추가하지 않습니다.\n- 소스에 직접 입력된 내용은 공유 전에 검토해 주세요.\n- 운영 배포 및 자동 병합은 수행하지 않습니다.` });
        await checkpoint({ status: 'complete', ...verifyPull(pull) });
        await authorize(context);
        return safeResult(record);
      } catch (error) {
        await db.runTransaction(async (tx) => {
          const stored = (await tx.get(ref)).data();
          if (!readOnly && stored?.lease === lease && stored.status !== 'complete') tx.set(ref, { ...stored, status: 'retryable', leaseUntil: 0, updatedAt: new Date(now()).toISOString() });
        });
        throw error;
      }
  };
  const bounded = async (context, input, options, readOnly) => {
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(totalTimeoutMs, 60_000))), ...(options?.signal ? [options.signal] : [])]);
    for (let number = 0; number < (readOnly ? 1 : 2); number++) {
      try { return await attempt(context, input, signal, readOnly); }
      catch (error) {
        if (signal.aborted) throw fail(504, 'git_delivery_deadline', 'GitHub 전달 확인 시간이 지났습니다. 저장 버전은 유지됩니다. 같은 버전의 전달 상태를 다시 확인해 주세요.');
        if (number > 0 || readOnly || !['git_transport_failed', 'git_provider_unavailable', 'git_credential_unavailable'].includes(error.code)) throw error;
        try { await pause(Math.max(0, Math.min(retryDelayMs, 1000)), undefined, { signal }); }
        catch { throw fail(504, 'git_delivery_deadline', 'GitHub 전달 확인 시간이 지났습니다. 같은 저장 버전으로 다시 확인해 주세요.'); }
      }
    }
  };
  return {
    publish: (context, input, options) => bounded(context, input, options, false),
    status: (context, input, options) => bounded(context, input, options, true),
  };
}
