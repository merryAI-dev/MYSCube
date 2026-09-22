import * as z from 'zod/v4';
export const WIDGETS = Object.freeze({
  'cashflow': { label: '현금흐름 반영 현황', unit: '원', source: 'cashflow-evidence' },
  'operations': { label: '저장·제출·승인 품질', unit: '업무 시도 건', source: 'product-operations' },
  'guidance': { label: '구성원 서비스 안내', unit: '공개 안내 건', source: 'service-guidance' },
});
export const insightWidget = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), kind: z.enum(['cashflow', 'operations', 'guidance']),
  title: z.string().trim().min(1).max(80), display: z.enum(['cards', 'table', 'trend']), days: z.union([z.literal(7), z.literal(14), z.literal(28)]),
  search: z.string().max(100), width: z.enum(['half', 'full']),
}).strict().refine((value) => value.display !== 'trend' || value.kind === 'operations', '일별 추이는 운영 품질 지표에서만 사용할 수 있습니다.');
export const insightPageConfig = z.object({ schemaVersion: z.literal(2), source: z.literal('insight-dashboard'),
  title: z.string().trim().min(1).max(80), description: z.string().max(500), yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  presentation: z.enum(['table', 'cards']), search: z.string().max(100), widgets: z.array(insightWidget).min(1).max(6),
}).strict().refine((value) => new Set(value.widgets.map((item) => item.id)).size === value.widgets.length, '위젯 식별자는 중복될 수 없습니다.');

export function proposeInsightLayout(question, yearMonth) {
  const text = String(question).slice(0, 1000);
  const widgets = [];
  const add = (kind, display) => widgets.push({ id: `widget-${widgets.length + 1}`, kind, title: WIDGETS[kind].label, display, days: /28일|한달|한 달/.test(text) ? 28 : /14일|2주/.test(text) ? 14 : 7,
    search: text.match(/CIC\s*\d+/i)?.[0].replace(/\s/g, '').toUpperCase() || '', width: 'full' });
  if (/현금|입금|출금|캐시|cash/i.test(text)) add('cashflow', 'table');
  if (/오류|에러|품질|저장|승인|제출|장애/.test(text)) add('operations', /추이|추세|차트/.test(text) ? 'trend' : 'cards');
  if (/안내|공지|구성원/.test(text)) add('guidance', 'cards');
  return { config: widgets.length ? insightPageConfig.parse({ schemaVersion: 2, source: 'insight-dashboard', title: 'CEO 인사이트', description: text, yearMonth,
    presentation: 'cards', search: '', widgets }) : null,
    interpretation: '등록된 지표 키워드로 구성한 제안입니다. AI 추론 결과가 아니며, 적용 전 지표·기간을 확인해 주세요.',
    unsupported: '지원 지표: 현금흐름 반영 현황, 저장·제출·승인 품질, 구성원 안내. 매출 예측·전체 회사 잔고·A/B 인과 효과는 생성하지 않습니다.' };
}
