import * as z from 'zod/v4';

export const reportPresentation = z.object({
  groupBy: z.array(z.enum(['cic', 'leader', 'state'])).max(3).default([]),
  detail: z.enum(['full', 'compact', 'summary']).default('full'),
  leaderOnly: z.boolean().default(false).describe('조직장 ID가 설정된 사업만. 이름 확인 불가와 미설정은 구분합니다.'),
}).strict();
const presentationPatch = z.object(Object.fromEntries(Object.entries(reportPresentation.shape)
  .map(([key, schema]) => [key, schema.removeDefault().optional()]))).strict();

export const reportInput = z.object({
  yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  kind: z.enum(['month_incomplete', 'week_overdue']),
  weekNo: z.number().int().min(1).max(5).optional(),
  cutoff: z.iso.datetime({ offset: true }).optional(),
  includeLateApproved: z.boolean().optional(),
  projectIds: z.array(z.string().min(1).max(120).regex(/^[^/]+$/)).min(1).max(100).optional(),
  presentation: reportPresentation.optional(),
}).strict().refine((v) => v.kind !== 'week_overdue' || (v.weekNo && v.cutoff), '주차와 기준 시각을 지정해주세요.');

const labels = { NOT_REQUESTED: '요청 전', SUBMITTED: '승인 대기', REOPEN_REQUESTED: '재개 요청', REOPENED: '재개됨',
  REJECTED: '반려', WITHDRAWN: '철회', UNKNOWN: '확인 필요', WAITING_FOR_UPDATE: '업데이트 대기',
  PENDING_APPROVAL: '승인 대기', LATE_APPROVED: '기한 후 승인 완료' };
const time = (value) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const label = (state) => labels[state] || '확인 필요';

function stateCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
  return counts;
}

export function reportEvidence(result, options = {}) {
  const presentation = reportPresentation.parse(options);
  const rows = result.rows.filter((row) => !presentation.leaderOnly || row.leaderId);
  const group = (items, dimensions) => {
    if (!dimensions.length) return [];
    const [dimension, ...rest] = dimensions;
    const groups = new Map();
    for (const row of items) {
      const key = dimension === 'leader' ? row.leaderId || '' : row[dimension] || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups].map(([key, members]) => ({ dimension, key,
      name: dimension === 'leader' ? members[0].leader : dimension === 'state' ? label(key) : key || 'CIC 확인 필요',
      count: members.length, states: stateCounts(members), projectIds: members.map((row) => row.projectId), groups: group(members, rest) }));
  };
  return { ...result, rows, presentation, matches: rows.length, excludedUnsetLeader: result.rows.length - rows.length,
    states: stateCounts(rows), groups: group(rows, [...new Set(presentation.groupBy)]) };
}

export function renderSettlementReport(result, options = {}) {
  const { groupBy, detail, leaderOnly } = reportPresentation.parse(options);
  const rows = result.rows.filter((row) => !leaderOnly || row.leaderId);
  const summarize = (items) => {
    const counts = new Map();
    for (const row of items) counts.set(label(row.state), (counts.get(label(row.state)) || 0) + 1);
    return [...counts].map(([state, count]) => `${state} ${count}개`).join(' · ');
  };
  const lines = [result.kind === 'month_incomplete' ? '[월결산 미완료·확인 필요 사업]' : '[주간 승인 기한 확인]',
    result.kind === 'month_incomplete' ? `월결산 대상: ${result.monthCloseTargetYearMonth}` : `주정산: ${result.yearMonth} · ${result.weekNo}주차`,
    ...(result.cutoff ? [`마감 기준: ${time(result.cutoff)} (한국시간)까지 · 과거 상태 복원이 아닌 조회 시점의 상태입니다.`] : []),
    ...(result.kind === 'week_overdue' ? [result.includeLateApproved ? '현재 미승인 및 기한 후 승인 포함' : '현재 미승인만 조회'] : []),
    `조회 ${result.checked}개 사업 · 해당 ${rows.length}개 사업`,
    ...(rows.length ? [summarize(rows)] : ['조회 범위에서 해당하는 사업이 없습니다.']),
    ...(leaderOnly ? [`조직장 ID가 설정된 사업만 표시했습니다. 미설정 ${result.rows.length - rows.length}개는 제외했습니다.`] : []),
    result.warning,
    ...(!result.complete ? ['요청한 사업 중 조회할 수 없는 항목이 있어 전체 결과가 아닙니다.'] : []),
  ];
  const append = (items, dimensions, depth = 0) => {
    if (!dimensions.length) {
      if (detail === 'full') lines.push(...items.map((row) => `- ${row.name} / ${row.leader}: ${label(row.state)}`));
      if (detail === 'compact') lines.push(items.map((row) => `${row.name} (${label(row.state)})`).join(', '));
      return;
    }
    const [dimension, ...rest] = dimensions;
    const groups = new Map();
    for (const row of items) {
      const key = dimension === 'leader' ? row.leaderId || '' : row[dimension] || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [key, members] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'ko'))) {
      const name = dimension === 'leader' ? members[0].leader : dimension === 'state' ? label(key) : key || 'CIC 확인 필요';
      lines.push('', `${'  '.repeat(depth)}${name}: ${members.length}개 사업 · ${summarize(members)}`);
      append(members, rest, depth + 1);
    }
  };
  append(rows, [...new Set(groupBy)]);
  if (detail === 'summary' && rows.length) lines.push('요약 형식으로 사업명 목록은 생략했습니다. 상세 목록도 이어서 요청하실 수 있어요.');
  if (result.queriedAt) lines.push('', `자료 조회 기준: ${time(result.queriedAt)} (한국시간)`);
  return lines.filter((line) => typeof line === 'string').join('\n');
}

export function createSettlementReportTools({ readReport, loadPreviousReports, saveReport }) {
  return [{ name: 'settlement_report',
    description: '등록 사업 기준 월결산 미완료 또는 주간 미승인 목록을 새로 조회합니다. 전체는 projectIds 생략. yearMonth는 운영 주기월(8월 월결산은 9월). presentation으로 CIC/조직장/상태별 묶음, 상세/간결/요약을 자유롭게 조합하세요. 월결산만 요청하면 주정산을 추가하지 마세요. 기간·최신 상태가 바뀌지 않는 형식 정정에는 reformat_report를 사용하세요. 주간 cutoff는 마감 상한이며 과거 상태 복원이 아닙니다. includeLateApproved=false는 현재 미승인만입니다.',
    schema: reportInput,
    async execute(input, context) {
      const { presentation, ...query } = input;
      const report = await readReport(query, context);
      await saveReport({ query, report, presentation: reportPresentation.parse(presentation || {}) });
      return { ...report, presentation };
    },
    modelResult: (result) => reportEvidence(result, result.presentation),
    render: (result) => renderSettlementReport(result, result.presentation),
  }, {
    name: 'reformat_report',
    description: '같은 사용자의 이전 보고서에서 형식만 수정합니다. 정산 재조회 없이 원래 조회시각·범위·미확인 경고를 유지합니다. "CIC별로", "조직장: 사업1,2", "답변 형식 오류" 등에 사용하세요. kind로 월결산만/주정산만 선택할 수 있습니다. 새로운 기간·마감·사업 범위·최신 상태 요청에는 사용할 수 없으며 settlement_report로 새로 조회해야 합니다.',
    schema: z.object({ kind: z.enum(['month_incomplete', 'week_overdue']).optional(), presentation: presentationPatch }).strict(),
    async execute(input) {
      const snapshots = await loadPreviousReports();
      const selected = snapshots.filter(({ report }) => !input.kind || report.kind === input.kind)
        .map((snapshot) => ({ ...snapshot, presentation: reportPresentation.parse({ ...snapshot.presentation, ...input.presentation }) }));
      for (const snapshot of selected) await saveReport(snapshot);
      return { snapshots: selected };
    },
    modelResult: (result) => ({ reused: true, snapshots: result.snapshots.map(({ query, report, presentation, sourceJobId }) => ({ query, sourceJobId, report: reportEvidence(report, presentation) })),
      ...(!result.snapshots.length ? { nextAction: '저장된 근거가 없습니다. 원래 질문의 범위로 settlement_report를 새로 조회하세요.' } : {}) }),
    render: (result) => result.snapshots.length ? ['요청하신 형식으로 다시 정리했어요. 정산을 새로 조회한 결과가 아니라 아래 자료 조회 기준의 내용입니다.',
      ...result.snapshots.map(({ report, presentation }) => renderSettlementReport(report, presentation))].join('\n\n') : '저장된 조회 근거가 없어 새 조회가 필요합니다.',
  }];
}
