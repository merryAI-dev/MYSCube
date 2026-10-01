import { describe, expect, it, vi } from 'vitest';
import { createJavaWeeklyClient } from './java-weekly-client.mjs';

function liveEnv(overrides = {}) {
  return {
    BFF_DEPLOY_ENV: 'live',
    FIREBASE_PROJECT_ID: 'live-data-project',
    BFF_LIVE_FIREBASE_PROJECT_ID: 'live-data-project',
    JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'live-data-project',
    JVM_WEEKLY_API_BASE_URL: 'https://live-jvm.example',
    JVM_WEEKLY_INTERNAL_API_TOKEN: 'service-token',
    ...overrides,
  };
}

const context = {
  tenantId: 'tenant-a',
  actorId: 'pm-1',
  actorRole: 'pm',
  actorEmail: 'pm@example.com',
};

const monthlyContract = {
  sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  targetRevision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  yearMonth: '2026-07',
  cells: [{ mode: 'projection', weekNo: 1, cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 1000 }],
};

function responseBody(payload) {
  return new Response(JSON.stringify(payload)).body;
}

function chunkedResponse(chunks, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  };
}

describe('Java weekly cashflow client', () => {
  it.each([
    ['monthly', 'applyCashflowSheetLab', {
      idempotencyKey: 'live-monthly-1',
      ...monthlyContract,
    }, '/sheet-lab/apply'],
    ['batch', 'applyCashflowSheetBatch', {
      idempotencyKey: 'live-batch-1',
      sourceRevision: monthlyContract.sourceRevision,
      targetRevision: monthlyContract.targetRevision,
      months: [{ yearMonth: monthlyContract.yearMonth, cells: monthlyContract.cells }],
    }, '/sheet-lab/batch/apply'],
    ['annual', 'applyCashflowSheetAnnualTotal', {
      idempotencyKey: 'live-annual-1',
      sourceRevision: monthlyContract.sourceRevision,
      year: 2025,
      expectedRevision: 3,
      cells: [{ mode: 'projection', cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 1000 }],
    }, '/sheet-lab/annual/apply'],
  ])('allows aligned Live %s apply to reach the JVM once', async (_case, method, payload, path) => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a' }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await client[method]({ context, projectId: 'project-a', ...payload });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toContain(path);
  });

  it.each([
    ['unknown runtime', liveEnv({ BFF_DEPLOY_ENV: 'preview' })],
    ['Live using an unapproved data project', liveEnv({
      FIREBASE_PROJECT_ID: 'other-project',
      JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'other-project',
    })],
    ['unsupported runtime using the Live data project', liveEnv({ BFF_DEPLOY_ENV: 'unsupported' })],
  ])('fails before network for %s', async (_case, env) => {
    const fetchImpl = vi.fn();
    const client = createJavaWeeklyClient({ env, fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'blocked-1',
      ...monthlyContract,
    })).rejects.toMatchObject({ statusCode: 503, code: 'unsafe_bff_runtime' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an annual total to the dedicated JVM authority endpoint', async () => {
    const fetchImpl = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a', year: 2025 }),
      url,
      init,
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });
    await client.applyCashflowSheetAnnualTotal({
      context,
      projectId: 'project-a',
      idempotencyKey: 'annual-1',
      sourceRevision: monthlyContract.sourceRevision,
      year: 2025,
      expectedRevision: 3,
      cells: [{ mode: 'projection', cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 2300000 }],
      amendmentReason: '결산 후 실제 입금액 정정',
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7, finalize: true },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/api/v1/cashflow/project-a/sheet-lab/annual/apply');
    expect(JSON.parse(init.body)).toEqual({
      idempotencyKey: 'annual-1',
      sourceRevision: monthlyContract.sourceRevision,
      year: 2025,
      expectedRevision: 3,
      cells: [{ mode: 'projection', cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 2300000 }],
      amendmentReason: '결산 후 실제 입금액 정정',
    });
    expect(init.headers).toMatchObject({
      'x-edit-session-id': 'session-a',
      'x-edit-lease-id': 'lease-a',
      'x-edit-fence': '7',
      'x-edit-finalize': 'true',
    });
  });

  it('forwards the pinned monthly contract without a cashflow edit lease', async () => {
    const fetchImpl = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a', sourceSheetKey: 'cashflow-sheet-lab' }),
      init,
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });
    const openingBalanceCells = [
      { year: 2025, mode: 'projection', cashflowLine: 'SALES_IN', cellState: 'VALUE', amount: 1000 },
    ];
    const pendingApprovalAffectedMonths = [{
      yearMonth: '2026-07', warningCountIncrement: 1, differenceCount: 1,
      approvalDifferences: [{ requestId: 'request-a', changes: [{ lineId: 'DIRECT_COST_OUT' }] }],
    }];

    await client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-1',
      sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      targetRevision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      yearMonth: '2026-07',
      sourceSheetKey: 'caller-controlled',
      cells: [{ mode: 'actual', weekNo: 1, cashflowLine: 'DIRECT_COST_OUT', cellState: 'VALUE', amount: 1000 }],
      openingBalanceCells,
      pendingApprovalAffectedMonths,
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toMatchObject({ 'x-data-project-id': 'live-data-project' });
    expect(init.headers['x-edit-session-id']).toBeUndefined();
    expect(init.headers['x-edit-lease-id']).toBeUndefined();
    expect(init.headers['x-edit-fence']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      idempotencyKey: 'apply-1',
      sourceRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      targetRevision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      yearMonth: '2026-07',
      cells: [{ mode: 'actual', weekNo: 1, cashflowLine: 'DIRECT_COST_OUT', cellState: 'VALUE', amount: 1000 }],
      openingBalanceCells,
      pendingApprovalAffectedMonths,
    });
  });

  it('forwards multiple months in one JVM batch request without a cashflow edit lease', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a', months: [] }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });
    const months = [
      { yearMonth: '2026-07', cells: monthlyContract.cells },
      { yearMonth: '2026-08', cells: monthlyContract.cells },
    ];
    const pendingApprovalAffectedMonths = [{
      yearMonth: '2026-07', warningCountIncrement: 1, differenceCount: 100,
      approvalDifferences: [{ requestId: 'request-a', changes: Array.from({ length: 100 }, (_, index) => ({ index })) }],
    }];

    await client.applyCashflowSheetBatch({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-batch-1',
      sourceRevision: monthlyContract.sourceRevision,
      targetRevision: monthlyContract.targetRevision,
      months,
      replaceAllActualSources: true,
      settledWeekChangeConfirmation: {
        confirmationId: 'confirmation-a',
        targetRevision: monthlyContract.targetRevision,
        weeks: [{ yearMonth: '2026-07', weekNo: 3, completionRevision: 1 }],
      },
      pendingApprovalAffectedMonths,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/api/v1/cashflow/project-a/sheet-lab/batch/apply');
    expect(init.headers['x-edit-session-id']).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      idempotencyKey: 'apply-batch-1',
      sourceRevision: monthlyContract.sourceRevision,
      targetRevision: monthlyContract.targetRevision,
      months,
      replaceAllActualSources: true,
      settledWeekChangeConfirmation: {
        confirmationId: 'confirmation-a',
        targetRevision: monthlyContract.targetRevision,
        weeks: [{ yearMonth: '2026-07', weekNo: 3, completionRevision: 1 }],
      },
      pendingApprovalAffectedMonths,
    });
  });

  it('forwards a late closed-month change reason to the JVM batch authority', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a', months: [] }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await client.applyCashflowSheetBatch({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-batch-reason-1',
      sourceRevision: monthlyContract.sourceRevision,
      targetRevision: monthlyContract.targetRevision,
      months: [{ yearMonth: '2026-07', cells: monthlyContract.cells }],
      closedMonthChangeReason: '결산 후 실제 입금액 정정',
      acceptFormulaMismatches: true,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      closedMonthChangeReason: '결산 후 실제 입금액 정정',
      acceptFormulaMismatches: true,
    });
  });

  it('forwards annual and weekly formula evidence to the JVM preflight authority', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({
        ok: true,
        projectId: 'project-a',
        annualCheckCount: 1,
        weeklyCheckCount: 1,
      }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });
    const annualCells = [{ year: 2024, mode: 'projection', cashflowLine: 'SALES_IN', cellState: 'ZERO', amount: 0 }];
    const annualDerivedCells = ['depositTotal', 'withdrawalTotal', 'balance'].map((field) => ({
      year: 2024, periodKind: 'ANNUAL', mode: 'projection', field, amount: 0, sourceCell: 'C33',
    }));
    const months = [{ yearMonth: '2026-01', cells: monthlyContract.cells, calculationChecks: [{}] }];

    await client.validateCashflowSheetFormulas({
      context,
      projectId: 'project-a',
      sourceYear: 2026,
      annualCells,
      annualDerivedCells,
      months,
      acceptFormulaMismatches: true,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/api/v1/cashflow/project-a/sheet-lab/formulas/preflight');
    expect(JSON.parse(init.body)).toEqual({
      sourceYear: 2026,
      annualCells,
      annualDerivedCells,
      months,
      acceptFormulaMismatches: true,
    });
  });

  it.each([
    ['ok is not true', { ok: false, projectId: 'project-a', annualCheckCount: 1, weeklyCheckCount: 1 }, 'jvm_weekly_response_invalid'],
    ['projectId differs', { ok: true, projectId: 'project-b', annualCheckCount: 1, weeklyCheckCount: 1 }, 'jvm_weekly_project_mismatch'],
    ['annual count is negative', { ok: true, projectId: 'project-a', annualCheckCount: -1, weeklyCheckCount: 1 }, 'jvm_weekly_response_invalid'],
    ['annual count is not an integer', { ok: true, projectId: 'project-a', annualCheckCount: 1.5, weeklyCheckCount: 1 }, 'jvm_weekly_response_invalid'],
    ['weekly count is unsafe', { ok: true, projectId: 'project-a', annualCheckCount: 1, weeklyCheckCount: Number.MAX_SAFE_INTEGER + 1 }, 'jvm_weekly_response_invalid'],
    ['evidence counts differ', { ok: true, projectId: 'project-a', annualCheckCount: 2, weeklyCheckCount: 0 }, 'jvm_weekly_response_invalid'],
  ])('rejects a formula preflight response when %s', async (_case, response, code) => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody(response),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.validateCashflowSheetFormulas({
      context,
      projectId: 'project-a',
      sourceYear: 2026,
      annualCells: [],
      annualDerivedCells: [
        { year: 2026, mode: 'actual', field: 'depositTotal' },
        { year: 2026, mode: 'actual', field: 'withdrawalTotal' },
        { year: 2026, mode: 'actual', field: 'balance' },
      ],
      months: [{ yearMonth: '2026-01', cells: [], calculationChecks: [{}] }],
    })).rejects.toMatchObject({ statusCode: 502, code });
  });

  it('waits once for a slow batch conflict instead of retrying and masking it as unreachable', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: false,
          status: 409,
          body: responseBody({ code: 'cashflow_revision_conflict', message: '원장 revision이 변경되었습니다.' }),
        }), 10);
      }));
      const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl, jvmWeeklyApiTimeoutMs: 5 });
      const request = client.applyCashflowSheetBatch({
        context,
        projectId: 'project-a',
        idempotencyKey: 'apply-batch-slow-conflict',
        sourceRevision: monthlyContract.sourceRevision,
        targetRevision: monthlyContract.targetRevision,
        months: [{ yearMonth: '2026-07', cells: monthlyContract.cells }],
      });
      const assertion = expect(request).rejects.toMatchObject({
        statusCode: 409,
        code: 'cashflow_revision_conflict',
      });

      await vi.advanceTimersByTimeAsync(11);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails before network when BFF and JVM data projects differ', async () => {
    const fetchImpl = vi.fn();
    const client = createJavaWeeklyClient({
      env: liveEnv({ JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'different-project' }),
      fetchImpl,
    });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-2',
      ...monthlyContract,
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 },
    })).rejects.toMatchObject({ statusCode: 503, code: 'jvm_weekly_data_project_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards the explicit initial-ledger overwrite flag only when requested', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a' }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-overwrite-1',
      ...monthlyContract,
      replaceAllActualSources: true,
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 },
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      replaceAllActualSources: true,
    });
  });

  it('rejects a JVM response for another project', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-b' }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-3',
      ...monthlyContract,
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 },
    })).rejects.toMatchObject({ statusCode: 502, code: 'jvm_weekly_project_mismatch' });
  });

  it('uses the frontend Firebase project id when it is the only Live data-project source', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a' }),
    }));
    const env = liveEnv({
      FIREBASE_PROJECT_ID: undefined,
      VITE_FIREBASE_PROJECT_ID: 'frontend-project',
      JVM_WEEKLY_FIRESTORE_PROJECT_ID: 'frontend-project',
      BFF_LIVE_FIREBASE_PROJECT_ID: 'frontend-project',
    });
    const client = createJavaWeeklyClient({ env, fetchImpl });

    await client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-vite-project',
      ...monthlyContract,
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 },
    });

    expect(fetchImpl.mock.calls[0][1].headers['x-data-project-id']).toBe('frontend-project');
  });

  it('allows a sheet overwrite without a cashflow edit lease', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a' }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-without-lease',
      ...monthlyContract,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not retry a sent mutation after a transient JVM transport failure', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: responseBody({ ok: true, projectId: 'project-a' }),
      });
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-retry-1',
      ...monthlyContract,
    })).rejects.toMatchObject({ mutationOutcome: 'uncertain', attempt: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records an uncertain mutation attempt without logging request data', async () => {
    const events = [];
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: responseBody({ ok: true, projectId: 'project-a', privateAmount: 987654321 }),
      });
    const client = createJavaWeeklyClient({
      env: liveEnv(),
      fetchImpl,
      performanceLogger: (event) => events.push(event),
    });

    await expect(client.applyCashflowSheetLab({
      context: { ...context, requestId: 'req-performance-1' },
      projectId: 'project-a',
      idempotencyKey: 'apply-performance-1',
      ...monthlyContract,
    })).rejects.toMatchObject({ mutationOutcome: 'uncertain', attempt: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.every((event) => event.requestId === 'req-performance-1')).toBe(true);
    expect(events.filter((event) => event.phase === 'attempt_start').map((event) => event.attempt)).toEqual([1]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'auth_headers', attempt: 1, outcome: 'ok' }),
      expect.objectContaining({ phase: 'upstream_ttfb', attempt: 1, outcome: 'error' }),
      expect.objectContaining({ phase: 'attempt_complete', attempt: 1, outcome: 'error' }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'retry_scheduled' }),
    ]));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('project-a');
    expect(serialized).not.toContain('apply-performance-1');
    expect(serialized).not.toContain('987654321');
    expect(serialized).not.toContain('service-token');
  });

  it('reports a failed mutation asynchronously without retrying it', async () => {
    let loggerRan = false;
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: responseBody({ ok: true, projectId: 'project-a' }),
      });
    const client = createJavaWeeklyClient({
      env: liveEnv(),
      fetchImpl,
      performanceLogger: () => {
        loggerRan = true;
        const until = Date.now() + 20;
        while (Date.now() < until) {}
      },
    });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-slow-logger',
      ...monthlyContract,
    })).rejects.toMatchObject({ mutationOutcome: 'uncertain', attempt: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loggerRan).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(loggerRan).toBe(true);
  });

  it('uses the configured Live invoker credential instead of the GCP metadata server', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: responseBody({ ok: true, projectId: 'project-a' }),
    }));
    const resolveIdentityToken = vi.fn(async () => 'live-id-token');
    const client = createJavaWeeklyClient({
      env: liveEnv({
        JVM_WEEKLY_API_ID_TOKEN_AUDIENCE: 'https://live-jvm.example',
      }),
      fetchImpl,
      jvmWeeklyApiIdentityTokenResolver: resolveIdentityToken,
    });

    await client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-live-invoker-1',
      ...monthlyContract,
    });

    expect(resolveIdentityToken).toHaveBeenCalledWith({
      audience: 'https://live-jvm.example',
      serviceAccountJson: '',
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer live-id-token');
  });

  it('returns a clear retryable service error when JVM transport remains unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-unreachable-1',
      ...monthlyContract,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      attempt: 1,
      retryable: true,
      mutationOutcome: 'uncertain',
      elapsedMs: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts a hanging JVM request before the frontend timeout and returns the stable unreachable code', async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl, jvmWeeklyApiTimeoutMs: 5 });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-timeout-1',
      ...monthlyContract,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      attempt: 1,
      retryable: true,
      mutationOutcome: 'uncertain',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
  });

  it('times out a hanging identity-token resolver before the JVM fetch starts', async () => {
    const fetchImpl = vi.fn();
    const resolveIdentityToken = vi.fn(() => new Promise(() => {}));
    const client = createJavaWeeklyClient({
      env: liveEnv({
        JVM_WEEKLY_API_ID_TOKEN_AUDIENCE: 'https://live-jvm.example',
        JVM_WEEKLY_API_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'live-invoker@example.iam.gserviceaccount.com' }),
      }),
      fetchImpl,
      jvmWeeklyApiIdentityTokenResolver: resolveIdentityToken,
      jvmWeeklyApiTimeoutMs: 5,
    });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-token-timeout-1',
      ...monthlyContract,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      attempt: 2,
      retryable: true,
      mutationOutcome: 'not_started',
    });
    expect(resolveIdentityToken.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(resolveIdentityToken.mock.calls.every(([input]) => input.signal instanceof AbortSignal)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the attempt AbortSignal to a hanging metadata identity-token fetch', async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const client = createJavaWeeklyClient({
      env: liveEnv({ JVM_WEEKLY_API_ID_TOKEN_AUDIENCE: 'https://live-jvm.example' }),
      fetchImpl,
      jvmWeeklyApiTimeoutMs: 5,
    });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-metadata-timeout-1',
      ...monthlyContract,
    })).rejects.toMatchObject({ statusCode: 503, code: 'jvm_weekly_api_unreachable' });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchImpl.mock.calls.every(([, init]) => init.signal instanceof AbortSignal)).toBe(true);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).includes('metadata.google.internal'))).toBe(true);
  });

  it('does not resend an annual mutation after a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetAnnualTotal({
      context,
      projectId: 'project-a',
      idempotencyKey: 'annual-unreachable-1',
      sourceRevision: 'source-a',
      year: 2026,
      expectedRevision: 0,
      cells: [],
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      attempt: 1,
      mutationOutcome: 'uncertain',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps an in-flight mutation at one configured attempt', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
      const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl, jvmWeeklyApiTimeoutMs: 30_000 });
      const requestPromise = client.applyCashflowSheetLab({
        context,
        projectId: 'project-a',
        idempotencyKey: 'apply-total-timeout-budget',
        ...monthlyContract,
      });
      const assertion = expect(requestPromise)
        .rejects.toMatchObject({ statusCode: 503, code: 'jvm_weekly_api_unreachable' });

      await vi.advanceTimersByTimeAsync(12_001);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors an absolute caller deadline without retrying a timed-out mutation', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
      const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl, jvmWeeklyApiTimeoutMs: 12_000 });
      const requestPromise = client.requestJson({
        context,
        method: 'POST',
        path: '/api/v1/cashflow/project-a/month-close',
        body: { idempotencyKey: 'close-deadline-1' },
        deadlineAtMs: Date.now() + 20,
      });
      const assertion = expect(requestPromise).rejects.toMatchObject({
        statusCode: 504,
        code: 'cashflow_month_close_route_timeout',
      });

      await vi.advanceTimersByTimeAsync(21);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the JVM atomic write count on client errors', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 422,
      body: responseBody({
        code: 'atomic_write_limit_exceeded',
        message: 'Cashflow apply requires 501 writes.',
        expectedWriteCount: 501,
      }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-atomic-limit',
      ...monthlyContract,
      editSession: { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 },
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'atomic_write_limit_exceeded',
      details: { expectedWriteCount: 501 },
    });
  });

  it('normalizes an unstructured Spring 500 response into a stable retryable BFF error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      body: responseBody({ code: 'internal_error', error: 'Internal Server Error', message: 'unexpected failure' }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.applyCashflowSheetLab({
      context,
      projectId: 'project-a',
      idempotencyKey: 'apply-internal-error',
      ...monthlyContract,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_internal_error',
      upstreamStatus: 500,
    });
  });

  it('reads a JSON response from bounded chunks when Content-Length is missing', async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      '{"ok":true,',
      '"projectId":"project-a"}',
    ]));
    const client = createJavaWeeklyClient({
      env: liveEnv(),
      fetchImpl,
      jvmWeeklyApiMaxResponseBytes: 64,
    });

    await expect(client.getCashflowSnapshot({ context, projectId: 'project-a' }))
      .resolves.toEqual({ ok: true, projectId: 'project-a' });
  });

  it('reads authoritative sheet operation status with the stable type and raw key query', async () => {
    const payload = {
      version: '1', projectId: 'project-a', operationType: 'MONTH_APPLY',
      idempotencyKeyHash: `sha256:${'a'.repeat(64)}`, status: 'NOT_FOUND',
      appliedMonths: [], appliedYears: [], annualRevisions: [],
    };
    const fetchImpl = vi.fn(async () => chunkedResponse([JSON.stringify(payload)]));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.getCashflowSheetOperationStatus({
      context,
      projectId: 'project-a',
      operationType: 'MONTH_APPLY',
      idempotencyKey: 'month key/1',
    })).resolves.toEqual(payload);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://live-jvm.example/api/v1/cashflow/project-a/sheet-lab/operations?operationType=MONTH_APPLY&idempotencyKey=month%20key%2F1',
    );
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  it.each([
    ['missing', null],
    ['empty', chunkedResponse([''])],
    ['malformed', chunkedResponse(['{"ok":'])],
  ])('rejects a %s successful response with a stable boundary error', async (_case, response) => {
    const fetchImpl = vi.fn(async () => response || {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    });
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.getCashflowSnapshot({ context, projectId: 'project-a' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'jvm_weekly_response_invalid',
      endpoint: 'https://live-jvm.example',
      command: 'get_cashflow_snapshot',
      attempt: 1,
      upstreamStatus: 200,
      retryable: false,
      mutationOutcome: 'failed',
      elapsedMs: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('replaces the legacy English closed-month message with stable Korean guidance', async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      JSON.stringify({
        code: 'cashflow_month_closed',
        message: 'Cashflow month is closed and cannot be changed.',
      }),
    ], { status: 409 }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const error = await client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/cashflow/project-a/weekly-update-complete',
      command: 'complete_cashflow_weekly_update',
      body: { idempotencyKey: 'weekly-closed-guide' },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      statusCode: 409,
      code: 'cashflow_month_closed',
      message: '이미 누적 결산이 끝난 월이에요. 수정이 필요하면 관리자에게 월 재오픈을 요청해 주세요.',
    });
    expect(error.message).not.toMatch(/Cashflow|closed|cannot be changed/i);
  });

  it('names the week record that is not canonical from the engine details, never its English text', async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      JSON.stringify({
        code: 'cashflow_week_document_invalid',
        message: 'Cashflow month contains malformed or non-canonical week documents; migration is required before applying.',
        details: { documentId: 'project-a-2026-05-w3', yearMonth: '2026-05', weekNo: 3, problem: 'projection SALES_IN 값이 숫자가 아닙니다' },
      }),
    ], { status: 409 }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const error = await client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/cashflow/project-a/weekly-update-complete',
      command: 'complete_cashflow_weekly_update',
      body: { idempotencyKey: 'week-document-invalid' },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      statusCode: 409,
      code: 'cashflow_week_document_invalid',
      message: '2026-05 3주차 주차 기록이 표준 형태가 아닙니다: projection SALES_IN 값이 숫자가 아닙니다. 관리자에게 기록 정리를 요청해 주세요.',
      details: { documentId: 'project-a-2026-05-w3', yearMonth: '2026-05', weekNo: 3 },
    });
    expect(error.message).not.toMatch(/malformed|non-canonical|migration/i);
  });

  it('replaces a technical authority contract error with a recovery guide', async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      JSON.stringify({
        code: 'cashflow_month_close_contract_invalid',
        message: 'Stored cumulative cashflow close authority revision is invalid.',
      }),
    ], { status: 409 }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const error = await client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/cashflow/project-a/weekly-update-complete',
      command: 'complete_cashflow_weekly_update',
      body: { idempotencyKey: 'invalid-authority-guide' },
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      statusCode: 409,
      code: 'cashflow_month_close_contract_invalid',
      message: '월 결산 기준 정보를 확인할 수 없어 안전하게 중단했어요. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.',
    });
    expect(error.message).not.toMatch(/Cashflow|Stored|Firestore|revision/i);
  });

  it.each([
    [409, 'cashflow_unknown_conflict', 409, 'cashflow_unknown_conflict', '요청을 처리할 수 없습니다. 최신 상태와 입력 내용을 확인해 주세요.'],
    [500, 'internal_error', 503, 'jvm_weekly_api_internal_error', '현금흐름 저장 서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ])('does not expose an unknown upstream %i technical message', async (
    upstreamStatus,
    upstreamCode,
    statusCode,
    code,
    message,
  ) => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      JSON.stringify({
        code: upstreamCode,
        message: 'Firestore cumulative close revision invariant failed in JVM adapter.',
      }),
    ], { status: upstreamStatus }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const error = await client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/cashflow/project-a/month-close/reopen',
      command: 'request_cashflow_month_reopen',
      body: { idempotencyKey: `unknown-upstream-${upstreamStatus}` },
    }).catch((caught) => caught);

    expect(error).toMatchObject({ statusCode, code, message });
    expect(error.message).not.toMatch(/Firestore|cumulative|revision|invariant|JVM|adapter/i);
  });

  it.each([
    [401, 'weekly_auth_required', 401, false, 'failed'],
    [403, 'weekly_forbidden', 403, false, 'failed'],
    [404, 'weekly_not_found', 404, false, 'failed'],
    [409, 'weekly_conflict', 409, false, 'failed'],
    [409, 'cashflow_month_reopen_revision_changed', 409, false, 'failed'],
    [422, 'weekly_invalid', 422, false, 'failed'],
    [500, 'internal_error', 503, true, 'uncertain'],
  ])('preserves a structured upstream %i response', async (
    upstreamStatus,
    upstreamCode,
    statusCode,
    retryable,
    mutationOutcome,
  ) => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      JSON.stringify({ code: upstreamCode, message: 'safe upstream message' }),
    ], { status: upstreamStatus }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const expectedCode = upstreamStatus === 500 ? 'jvm_weekly_api_internal_error' : upstreamCode;
    await expect(client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/weekly-expenses/project-a/command',
      command: 'save_weekly_expense',
      body: { idempotencyKey: 'stable-error-1' },
    })).rejects.toMatchObject({
      statusCode,
      code: expectedCode,
      upstreamStatus,
      retryable,
      mutationOutcome,
      command: 'save_weekly_expense',
      attempt: 1,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty 422', 422, '', 422, 'java_weekly_api_error', false, 'failed'],
    ['malformed 422', 422, '{', 422, 'java_weekly_api_error', false, 'failed'],
    ['empty 500', 500, '', 503, 'jvm_weekly_api_internal_error', true, 'uncertain'],
    ['malformed 500', 500, '{', 503, 'jvm_weekly_api_internal_error', true, 'uncertain'],
  ])('handles a %s error body without crashing', async (
    _case,
    upstreamStatus,
    responseText,
    statusCode,
    code,
    retryable,
    mutationOutcome,
  ) => {
    const fetchImpl = vi.fn(async () => chunkedResponse([responseText], { status: upstreamStatus }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/weekly-expenses/project-a/command',
      body: {},
      retry: true,
    })).rejects.toMatchObject({
      statusCode,
      code,
      upstreamStatus,
      retryable,
      mutationOutcome,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a declared oversized body before reading it', async () => {
    const read = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '65' }),
      body: { getReader: () => ({ read, cancel: vi.fn(), releaseLock: vi.fn() }) },
    }));
    const client = createJavaWeeklyClient({
      env: liveEnv(),
      fetchImpl,
      jvmWeeklyApiMaxResponseBytes: 64,
    });

    await expect(client.getCashflowSnapshot({ context, projectId: 'project-a' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'jvm_weekly_response_too_large',
      upstreamStatus: 200,
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('stops reading when an inaccurate Content-Length overflows mid-stream', async () => {
    const fetchImpl = vi.fn(async () => chunkedResponse([
      '{"value":"1234567890',
      '1234567890"}',
    ], { headers: { 'content-length': '2' } }));
    const client = createJavaWeeklyClient({
      env: liveEnv(),
      fetchImpl,
      jvmWeeklyApiMaxResponseBytes: 24,
    });

    await expect(client.getCashflowSnapshot({ context, projectId: 'project-a' })).rejects.toMatchObject({
      statusCode: 502,
      code: 'jvm_weekly_response_too_large',
      upstreamStatus: 200,
      retryable: false,
    });
  });

  it('classifies a connection reset while reading a mutation response as uncertain', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          controller.error(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
        },
      }),
    }));
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    const error = await client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/weekly-expenses/sheet-secret/save-draft',
      command: 'save_weekly_expense',
      body: {},
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      endpoint: 'https://live-jvm.example',
      command: 'save_weekly_expense',
      attempt: 1,
      retryable: true,
      mutationOutcome: 'uncertain',
    });
    expect(JSON.stringify(error)).not.toContain('sheet-secret');
    expect(JSON.stringify(error)).not.toContain('service-token');
    expect(JSON.stringify(error)).not.toContain(context.actorEmail);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not retry a mutation without an idempotency key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const client = createJavaWeeklyClient({ env: liveEnv(), fetchImpl });

    await expect(client.requestJson({
      context,
      method: 'POST',
      path: '/api/v1/weekly-expenses/project-a/command',
      body: {},
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'jvm_weekly_api_unreachable',
      attempt: 1,
      retryable: true,
      mutationOutcome: 'uncertain',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
