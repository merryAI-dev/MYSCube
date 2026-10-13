// 미리보기를 마친 배치를 실제로 등록한다. MCP 도구와 웹 확정 화면이 같은 코드를 쓴다.
export const COMMIT_CHUNK = 25;
export const COMMIT_BUDGET_MS = 45_000;

export async function runImportCommit({ ema, store, uid, batchId, excludeRows = [], awardCredits = false, now = () => Date.now() }) {
  const batch = await store.loadBatch(batchId, uid);
  if (!batch?.preview) throw new Error('이 배치는 미리보기가 없습니다. 먼저 ema_registry_import_preview를 호출하세요.');
  const excluded = new Set(excludeRows);
  const rows = batch.preview.items.map((item) => ({
    index: item.index,
    record: item.record,
    action: excluded.has(item.sheetRow) ? 'skip' : item.action,
  }));
  const byIndex = new Map(batch.preview.items.map((item) => [item.index, item]));
  const results = new Map((batch.commit?.results ?? []).filter((entry) => entry.status !== 'not_processed' && entry.status !== 'error').map((entry) => [entry.index, entry]));

  const started = now();
  let timedOut = false;
  let failure = null;
  const pending = rows.filter((row) => !results.has(row.index));
  for (let offset = 0; offset < pending.length; offset += COMMIT_CHUNK) {
    if (now() - started > COMMIT_BUDGET_MS) { timedOut = true; break; }
    const chunk = pending.slice(offset, offset + COMMIT_CHUNK);
    try {
      const response = await ema.call('commitRegistryImport', { batchId, rows: chunk, awardCredits });
      for (const entry of response.results) {
        if (entry.status !== 'not_processed') results.set(entry.index, entry);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : '등록 중 오류가 발생했습니다.';
      break;
    }
  }

  const entries = [...results.values()].sort((a, b) => a.index - b.index);
  const decorate = (entry) => ({ sheetRow: byIndex.get(entry.index)?.sheetRow, name: entry.name, status: entry.status, frn: entry.frn, reason: entry.reason, message: entry.message });
  const counts = {};
  entries.forEach((entry) => { counts[entry.status] = (counts[entry.status] || 0) + 1; });
  const remaining = rows.length - entries.length;
  await store.saveBatch(batchId, { ...batch, commit: { at: new Date(now()).toISOString(), awardCredits, results: entries } });
  return {
    batchId,
    status: remaining === 0 && !failure ? 'done' : 'in_progress',
    counts,
    remaining,
    ...(failure ? { error: failure, retry: '같은 batchId로 다시 호출하면 이어서 처리하며 중복 등록되지 않습니다.' } : {}),
    ...(timedOut ? { retry: '시간 제한으로 일부만 처리했습니다. 같은 batchId로 다시 호출하면 이어서 처리합니다.' } : {}),
    created: entries.filter((entry) => entry.status === 'created').map(decorate),
    linked: entries.filter((entry) => entry.status === 'linked').map(decorate),
    problems: entries.filter((entry) => ['error', 'skipped'].includes(entry.status)).map(decorate),
  };

}
