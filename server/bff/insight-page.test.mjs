import { it, expect } from 'vitest';
import { insightPageConfig, proposeInsightLayout } from '../../shared/insight-page.mjs';
it('creates only registered metrics and rejects arbitrary queries/duplicate widgets', () => {
  const result = proposeInsightLayout('14일 오류 추이와 CIC1 현금흐름, 구성원 안내', '2026-09');
  expect(result.config.widgets).toHaveLength(3); expect(result.config.widgets[0].search).toBe('CIC1');
  expect(result.config.widgets[1]).toMatchObject({ display: 'trend', days: 14 });
  expect(proposeInsightLayout('고객별 내년 매출 예측', '2026-09').config).toBe(null);
  expect(insightPageConfig.safeParse({ ...result.config, url: 'http://internal' }).success).toBe(false);
  expect(insightPageConfig.safeParse({ ...result.config, widgets: [result.config.widgets[0], result.config.widgets[0]] }).success).toBe(false);
});
