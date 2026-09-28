import { describe, expect, it } from 'vitest';
import { buildProjectDataset, PROJECT_COPY_LIMIT } from './project-copy.mjs';
const time = '2026-09-24T10:00:00.123456789Z';
const doc = (id = 'a', data = {}) => ({ id, data: { id: 'legacy-id', name: '합성 사업', status: 'RAW_STATUS', contractStart: '2026-03-01', contractEnd: '', ...data }, updateTime: time });
const build = (documents, extra = {}) => buildProjectDataset({ documents, readTime: time, capturedAt: '2026-09-24T10:00:01.000Z', ...extra });
describe('project projection preserves source facts', () => {
  it('preserves mismatched and repeated logical IDs, explicit false, empty dates and missing values', () => {
    const result = build([doc('b', { contractEndUndecided: false }), doc('a')]);
    expect(result.rows.map(row => row.document_id)).toEqual(['a', 'b']);
    expect(result.rows.map(row => row.project_id)).toEqual(['legacy-id', 'legacy-id']);
    expect(result.rows[0]).toMatchObject({ contract_start: '2026-03-01', contract_end_raw: '', contract_end: null, contract_end_undecided: null, cic: null, trashed_at_raw: null, document_updated_at: time });
    expect(result.rows[1].contract_end_undecided).toBe(false);
    expect(result.manifest.asOf).toBe(time); expect(result.manifest.coverage.expectedRows).toBe(2);
    expect(build([doc('a'), doc('b', { contractEndUndecided: false })]).manifest.sourceRevision).toBe(result.manifest.sourceRevision);
  });
  it('does not exclude trashed documents or reinterpret statuses', () => {
    expect(build([doc('trashed', { trashedAt: time })]).rows[0]).toMatchObject({ trashed_at_raw: time, status: 'RAW_STATUS' });
    expect(build([doc('null', { contractStart: null, contractEnd: null })]).rows[0]).toMatchObject({ contract_start: null, contract_start_raw: null });
  });
  it.each([
    [doc('a', { email: 'private@invalid.test' })], [doc('a', { contractStart: '2026-02-30' })],
    [doc('a', { contractEndUndecided: 'false' })], [doc('a', { updatedAt: { seconds: 1 } })], [doc(), doc()],
    [{ ...doc(), updateTime: '2026-09-24T10:00:00.123456790Z' }],
    [{ ...doc(), updateTime: '2026-02-30T00:00:00Z' }],
  ].map(documents => [documents]))('rejects unapproved fields, malformed types/dates, duplicate documents and revision-after-snapshot: %j', documents => {
    expect(() => build(documents)).toThrow();
  });
  it('refuses a truncated snapshot before any import', () => {
    expect(() => build(Array.from({ length: PROJECT_COPY_LIMIT + 1 }, (_, i) => doc(String(i))))).toThrow();
  });
  it('preserves both clocks across normal skew and rejects more than the shared sixty-second boundary', () => {
    const capturedAt = '2026-09-24T10:00:00.000000000Z';
    for (const readTime of ['2026-09-24T10:00:01.650000000Z', '2026-09-24T10:01:00.000000000Z']) {
      const value = build([doc()], { capturedAt, readTime });
      expect(value.manifest).toMatchObject({ capturedAt, asOf: readTime });
    }
    expect(() => build([doc()], { capturedAt, readTime: '2026-09-24T10:01:00.000000001Z' })).toThrow();
  });
  it.each(['2026-02-30T00:00:00Z', '2026-09-24T10:00:00.1234567890Z', '2026-09-24T19:00:00+09:00', '2026-09-24 10:00:00Z'])('rejects noncanonical snapshot times %s', readTime => {
    expect(() => build([doc()], { readTime })).toThrow();
  });
});
