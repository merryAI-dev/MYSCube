const KST_OFFSET_MS = 9 * 3_600_000;

export function kstCalendarDate(nowIso = new Date().toISOString()) {
  const at = Date.parse(String(nowIso || ''));
  if (!Number.isFinite(at)) return '';
  return new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isRealIsoCalendarDate(value) {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** 화면의 `종료됨`과 동일하게 KST 현재일보다 계약 종료일이 지난 경우만 종료로 본다. */
export function isProjectContractEnded(contractEnd, nowIso = new Date().toISOString()) {
  const end = String(contractEnd ?? '').slice(0, 10);
  const today = kstCalendarDate(nowIso);
  return isRealIsoCalendarDate(end) && Boolean(today) && end < today;
}
