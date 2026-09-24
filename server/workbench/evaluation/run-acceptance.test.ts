import { Firestore } from '@google-cloud/firestore';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from './run-acceptance.mjs';
import { ACCEPTANCE_CASES } from './acceptance-cases.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('frozen evaluation runner provenance and reporting', () => {
  it('runs every frozen case once without reporting a fixture answer as model accuracy or authenticated production behavior', async () => {
    const db = new Firestore({ projectId: 'demo-workbench-c4-harness' });
    const directory = await mkdtemp(join(tmpdir(), 'axr-c4-harness-'));
    let report: any;
    try {
      report = await runAcceptance({ db, outputDirectory: directory, sourceSha: '1'.repeat(40), model: 'fixture-only', render: false,
        complete: async () => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify({ action: 'answer',
          interpretation: { summary: '평가 도구 실행 검증', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [] },
          answer: '정확도를 검증하지 않는 fixture 응답입니다.', evidenceIds: [] }) } }] }) });
      const persisted = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
      expect(persisted).toEqual(report);
      expect(report.status).toBe('review_required');
      expect(report.environment).toMatchObject({ model: 'fixture harness validation', syntheticDataOnly: true, renderer: 'disabled' });
      expect(report.actualUserAuthentication).toBe(false);
      expect(report.caseResults.map((value: any) => value.id)).toEqual(ACCEPTANCE_CASES.map(value => value.id));
      expect(report.caseResults.flatMap((value: any) => value.turns)).toHaveLength(23);
      for (const value of report.caseResults) {
        expect(value.executionStatus).toBe('executed');
        expect(value.expected).toEqual(ACCEPTANCE_CASES.find(item => item.id === value.id)!.turns.map(turn => turn.expected));
        expect((await db.doc(`orgs/${value.tenantId}`).get()).data()).toMatchObject({ evaluationOnly: true, runId: report.runId, caseId: value.id });
        expect(value.turns.every((turn: any) => turn.trace.length === 1 && turn.queries.length === 0)).toBe(true);
      }
      expect(report).not.toHaveProperty('passedCases');
    } finally {
      if (report) for (const value of report.caseResults) await db.recursiveDelete(db.doc(`orgs/${value.tenantId}`));
      await db.terminate(); await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
