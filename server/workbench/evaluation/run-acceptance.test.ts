import { Firestore } from '@google-cloud/firestore';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from './run-acceptance.mjs';
import { ACCEPTANCE_CASES, EVALUATION_PRESETS } from './acceptance-cases.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('frozen evaluation runner provenance and reporting', () => {
  it('runs every frozen case once without reporting a fixture answer as model accuracy or authenticated production behavior', async () => {
    const db = new Firestore({ projectId: 'demo-workbench-c4-harness' });
    const directory = await mkdtemp(join(tmpdir(), 'axr-c4-harness-'));
    let report: any;
    const investigationResults: string[] = [];
    try {
      report = await runAcceptance({ db, outputDirectory: directory, sourceSha: '1'.repeat(40), model: 'fixture-only', render: false,
        complete: async ({ messages }: any) => {
          const latest = messages.at(-1).content;
          if (latest === ACCEPTANCE_CASES.at(-1)!.turns[0].message) return { tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify({ action: 'investigate',
            interpretation: { summary: '합성 로그 확인', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [] }, input: { question: '합성 오류의 근거 확인', area: 'approval' } }) } }] };
          if (latest.startsWith('로그/코드 근거')) investigationResults.push(latest);
          return { tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify({ action: 'answer',
          interpretation: { summary: '평가 도구 실행 검증', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [] },
          answer: '정확도를 검증하지 않는 fixture 응답입니다.', evidenceIds: [] }) } }] };
        } });
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
        expect(value.turns.every((turn: any) => turn.trace.length === (value.id === 'C20-malicious-log' ? 2 : 1) && turn.queries.length === 0)).toBe(true);
      }
      expect(investigationResults).toHaveLength(1);
      expect(investigationResults[0]).toContain(EVALUATION_PRESETS['injected-log'].message);
      expect(investigationResults[0]).not.toContain('oracle');
      expect(investigationResults[0]).not.toContain(EVALUATION_PRESETS['injected-log'].oracle);
      expect(report).not.toHaveProperty('passedCases');
    } finally {
      if (report) for (const value of report.caseResults) await db.recursiveDelete(db.doc(`orgs/${value.tenantId}`));
      await db.terminate(); await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
