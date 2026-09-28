import { comparisonInput, createAccountingComparisonTool, renderAccountingComparison } from './accounting-compare.mjs';
import { accountingEvidence } from './accounting-read.mjs';

export function createCfoBriefTool({ readSnapshot, authorize, record = async () => {} }) {
  return {
    name: 'cfo_brief', schema: comparisonInput,
    description: '선택 사업 최대 10개에 대한 CFO 브리핑을 한 번에 수행합니다. 두 기간 조회→동일 사업 비교→변동 또는 음수 잔액 사업 최대 3개 자동 선정→비교 기간의 항목별 P/A 차이 확인→미실행 조치안을 작성합니다. 일반 비교만이면 accounting_compare를 쓰세요. 원장 재조회 없이 같은 자료에서 추가 분석하며 원인·담당자·업무 완료를 추정하지 않습니다. 확정된 전사 결산 또는 지급 승인 보고가 아닙니다.',
    async execute(raw, { signal } = {}) {
      const input = comparisonInput.parse(raw);
      const snapshots = new Map();
      const stages = [];
      const stage = async (name, outcome, details = {}) => {
        signal?.throwIfAborted();
        stages.push({ name, outcome, ...details });
        await record({ type: 'cfo_workflow_stage', name, outcome, ...details });
      };
      await stage('COMPARE_PERIODS', 'STARTED');
      const compare = createAccountingComparisonTool({ authorize, readSnapshot: async (request) => {
        const snapshot = await readSnapshot(request);
        snapshots.set(`${request.params.projectId}:${request.query.yearMonth}`, snapshot);
        return snapshot;
      } });
      const comparison = await compare.execute(input, { signal });
      await stage('COMPARE_PERIODS', comparison.complete ? 'SUCCEEDED' : 'PARTIAL', { projects: comparison.requestedProjects });
      const candidates = [...new Set([
        ...comparison.rows.filter((row) => row.current.actual?.cumulativeBalance < 0).map((row) => row.projectId),
        ...comparison.drivers.inflow.items.map((row) => row.projectId),
        ...comparison.drivers.outflow.items.map((row) => row.projectId),
        ...comparison.drivers.cumulativeBalance.items.map((row) => row.projectId),
      ])];
      const investigations = [];
      for (const projectId of candidates.slice(0, 3)) {
        signal?.throwIfAborted();
        await authorize();
        const source = snapshots.get(`${projectId}:${input.current.yearMonth}`);
        if (!source) continue;
        const evidence = accountingEvidence(source, { projectId, ...input.current, detail: 'lines' });
        const differences = [];
        let unknown = 0;
        for (const [weekIndex, week] of evidence.difference.weeks.entries()) {
          for (const [lineIndex, line] of week.lines.entries()) {
            if (line.amount === null) { unknown++; continue; }
            if (line.amount === 0) continue;
            differences.push({ weekNo: week.weekNo, lineId: line.lineId, label: line.label, difference: line.amount,
              projection: evidence.projection[weekIndex].lines[lineIndex].amount,
              actual: evidence.actual[weekIndex].lines[lineIndex].amount,
              coordinate: evidence.actual[weekIndex].lines[lineIndex].coordinate });
          }
        }
        differences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.weekNo - b.weekNo || a.coordinate.rowIndex - b.coordinate.rowIndex);
        investigations.push({ projectId, name: evidence.projectName || '사업명 확인 필요',
          yearMonth: input.current.yearMonth, comparison: 'CURRENT_ACTUAL_MINUS_PROJECTION',
          inspectedCells: evidence.difference.weeks.reduce((sum, week) => sum + week.lines.length, 0),
          unknownCells: unknown, differences: differences.slice(0, 5), differingCells: differences.length,
          truncated: differences.length > 5, source: comparison.rows.find((row) => row.projectId === projectId).current.source });
      }
      await stage('INSPECT_CURRENT_VARIANCE', 'SUCCEEDED', { investigated: investigations.length, candidates: candidates.length });
      await authorize();
      signal?.throwIfAborted();
      await stage('PROPOSE_FOLLOW_UP', 'SUCCEEDED', { proposals: comparison.proposedActions.length, executedBusinessActions: 0 });
      return { comparison, investigations, stages, investigationScope: { candidates: candidates.length, inspected: investigations.length,
        remaining: candidates.length - investigations.length, maxProjects: 3 },
        actionStatus: 'PROPOSED_NOT_ASSIGNED',
        warning: '추가 분석은 비교 기간의 계획 대비 실적 차이입니다. 기간 간 변동의 원인을 증명하지 않습니다. 조치안은 아직 저장·배정·실행되지 않았습니다.' };
    },
    render: (result) => {
      const money = (value) => `${value.toLocaleString('ko-KR')}원`;
      return [renderAccountingComparison(result.comparison),
        `추가 확인: ${result.investigationScope.inspected}개 사업 (후보 ${result.investigationScope.candidates}개, 미확인 ${result.investigationScope.remaining}개)`,
        ...result.investigations.flatMap((item) => [
          `${item.name} · ${item.yearMonth}: 비교 불가 ${item.unknownCells}개 셀 · 차이 ${item.differingCells}개${item.truncated ? ' 중 5개 표시' : ''}`,
          ...item.differences.map((cell) => `- ${cell.weekNo}주차 ${cell.label}: 계획 ${money(cell.projection)} / 실적 ${money(cell.actual)} / 차이 ${money(cell.difference)}`),
        ]), result.warning].join('\n');
    },
  };
}
