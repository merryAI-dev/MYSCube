import { createHash } from 'node:crypto';
const HASH = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const FAIL = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};
const normalize = (v) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const str = (v) => (typeof v === 'string' ? v.trim() : '');
function decode(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v)
    return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)])
    );
  return null;
}
function years(p) {
  const a = /^\d{4}-/.test(str(p.contractStart))
      ? Number(p.contractStart.slice(0, 4))
      : NaN,
    b = /^\d{4}-/.test(str(p.contractEnd))
      ? Number(p.contractEnd.slice(0, 4))
      : NaN;
  if (
    Number.isSafeInteger(a) &&
    Number.isSafeInteger(b) &&
    a <= b &&
    b - a <= 20
  )
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  return [
    ...new Set(
      (Array.isArray(p.financialYears) ? p.financialYears : [])
        .map((x) => Number(x?.year))
        .filter(Number.isSafeInteger)
    ),
  ].sort((a, b) => a - b);
}
// Mirrors routes/cashflow-sheet-lab.mjs readCashflowSheetLabConfig selection.
function binding(p, year) {
  const legacy = p.cashflowSheetLab,
    ys = years(p);
  const week = /^(\d{2})-(\d{1,2})-(\d{1,2})$/.exec(str(legacy?.startWeek));
  const legacyYear =
    week &&
    Number(week[2]) >= 1 &&
    Number(week[2]) <= 12 &&
    Number(week[3]) >= 1 &&
    Number(week[3]) <= 5
      ? 2000 + Number(week[1])
      : ys.length === 1
        ? ys[0]
        : 2026;
  const c =
    p.cashflowSheetLabSources?.[String(year)] ||
    (legacy && legacyYear === year ? legacy : null);
  if (!c || typeof c !== 'object' || !str(c.value))
    FAIL('sheet_binding_missing');
  const sourceYear = Number(c.sourceYear || year);
  if (
    !Number.isSafeInteger(sourceYear) ||
    sourceYear !== year ||
    (ys.length && !ys.includes(sourceYear))
  )
    FAIL('sheet_source_year_mismatch');
  const raw = str(c.value),
    id =
      raw.match(/\/d\/([A-Za-z0-9_-]+)/)?.[1] ||
      raw.match(/[?&]id=([A-Za-z0-9_-]+)/)?.[1] ||
      (/^[A-Za-z0-9_-]{20,}$/.test(raw) ? raw : null);
  if (!id || id.length > 200) FAIL('sheet_binding_invalid');
  return {
    spreadsheetId: id,
    sheetName: str(c.sheetName),
    sourceYear,
    updatedAt: str(c.updatedAt),
    selection: p.cashflowSheetLabSources?.[String(year)]
      ? 'year_source'
      : 'legacy_source',
  };
}
export function createSheetSourceTools({
  policy,
  firestoreAuth,
  sheetsAuth,
  authorize,
  labelContract,
}) {
  if (
    policy?.cloudProject !== 'inner-platform-live-20260316' ||
    policy.tenant !== 'mysc' ||
    !Array.isArray(policy.allowedProjectIds) ||
    !policy.allowedProjectIds.length ||
    policy.allowedProjectIds.some((x) => !/^p\d{10,20}$/.test(x)) ||
    typeof authorize !== 'function'
  )
    throw Error('invalid_sheet_source_policy');
  const contract = structuredClone(labelContract);
  if (
    !/^[a-f0-9]{40}$/.test(contract?.source_revision || '') ||
    !['coordinates_blob_sha', 'policy_blob_sha'].every((k) =>
      /^[a-f0-9]{40}$/.test(contract?.[k] || '')
    )
  )
    throw Error('invalid_sheet_label_contract');
  const entries = [];
  for (const mode of ['projection', 'actual']) {
    if (!Array.isArray(contract?.[mode]) || contract[mode].length !== 16)
      throw Error('invalid_sheet_label_contract');
    for (const e of contract[mode]) {
      if (
        !Number.isSafeInteger(e.row) ||
        e.row < 1 ||
        e.row > 60 ||
        typeof e.line_id !== 'string' ||
        !e.line_id ||
        typeof e.label !== 'string' ||
        !e.label ||
        e.label.length > 200
      )
        throw Error('invalid_sheet_label_contract');
      entries.push({ ...e, mode });
    }
  }
  if (
    new Set(entries.map((e) => e.row)).size !== 32 ||
    !entries.some((e) => e.row === 17)
  )
    throw Error('invalid_sheet_label_contract');
  const config = structuredClone(policy),
    safeLabels = new Set(entries.map((e) => normalize(e.label)));
  // Disclosure allowlist only; these spellings never count as valid template aliases.
  for (const label of [...safeLabels])
    if (label.includes('매입부가세'))
      safeLabels.add(label.replace('매입부가세', '메입부가세'));
  async function request(auth, url, signal) {
    if (!auth?.getClient) FAIL('source_credentials_missing');
    signal?.throwIfAborted();
    const client = await auth.getClient();
    const response = await client.request({
      url,
      method: 'GET',
      timeout: 20000,
      retry: false,
      signal,
      maxRedirects: 0,
    });
    const d = response.data;
    if (Buffer.byteLength(JSON.stringify(d)) > 2000000)
      FAIL('source_response_too_large');
    return d;
  }
  const base =
    'https://firestore.googleapis.com/v1/projects/inner-platform-live-20260316/databases/(default)/documents/orgs/mysc/projects/';
  async function project(id, signal) {
    const q = new URLSearchParams();
    for (const k of [
      'cashflowSheetLabSources',
      'cashflowSheetLab',
      'contractStart',
      'contractEnd',
      'financialYears',
      'version',
    ])
      q.append('mask.fieldPaths', k);
    const d = await request(firestoreAuth, base + id + '?' + q, signal);
    if (
      d.name !==
      `projects/inner-platform-live-20260316/databases/(default)/documents/orgs/mysc/projects/${id}`
    )
      FAIL('sheet_binding_invalid');
    return {
      value: decode({ mapValue: { fields: d.fields } }),
      update_time: str(d.updateTime),
    };
  }
  return {
    read_authorized_sheet_labels: {
      description:
        'Read only canonical fixed A-column label cells from the live Google Sheet bound to an authorized project/year. Separately scoped Sheets read-only ADC is required. Current observation only, never incident state; formula text, arbitrary labels, financial cells and document IDs are withheld. Saved mirror diagnostics are not a fallback.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['project_id', 'year'],
        properties: {
          project_id: { type: 'string', enum: config.allowedProjectIds },
          year: { type: 'integer', minimum: 2000, maximum: 2099 },
        },
      },
      async execute(args, { signal } = {}) {
        const observed_at = new Date().toISOString();
        let stage = 'authorization';
        try {
          if (
            !args ||
            typeof args !== 'object' ||
            Array.isArray(args) ||
            Object.keys(args).some(
              (k) => !['project_id', 'year'].includes(k)
            ) ||
            !config.allowedProjectIds.includes(args.project_id) ||
            !Number.isSafeInteger(args.year) ||
            args.year < 2000 ||
            args.year > 2099
          )
            FAIL('invalid_scope');
          await authorize();
          signal?.throwIfAborted();
          stage = 'project_binding_read';
          const before = await project(args.project_id, signal),
            b = binding(before.value, args.year),
            bindingHash = HASH(b);
          const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(b.spreadsheetId)}`;
          stage = 'sheet_tab_read';
          const meta = await request(
            sheetsAuth,
            endpoint +
              '?fields=spreadsheetId,sheets(properties(sheetId,title,index))',
            signal
          );
          if (
            meta.spreadsheetId !== b.spreadsheetId ||
            !Array.isArray(meta.sheets)
          )
            FAIL('sheet_response_invalid');
          const tabs = meta.sheets.map((s) => s.properties).filter(Boolean);
          let matches = b.sheetName
            ? tabs.filter((s) => s.title === b.sheetName)
            : tabs.filter(
                (s) =>
                  typeof s.title === 'string' &&
                  ['cashflow', '사용내역', '연동'].every((x) =>
                    s.title.toLowerCase().replace(/\s+/g, '').includes(x)
                  )
              );
          if (
            matches.length !== 1 ||
            !Number.isSafeInteger(matches[0].sheetId) ||
            typeof matches[0].title !== 'string' ||
            matches[0].title.length > 200
          )
            FAIL('sheet_tab_binding_ambiguous');
          if (
            !['cashflow', '사용내역', '연동'].every((x) =>
              matches[0].title.toLowerCase().replace(/\s+/g, '').includes(x)
            )
          )
            FAIL('sheet_tab_binding_ambiguous');
          const tab = matches[0],
            q = new URLSearchParams({
              includeGridData: 'true',
              fields:
                'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue))))',
            });
          const quoted = "'" + tab.title.replace(/'/g, "''") + "'";
          for (const e of entries) q.append('ranges', `${quoted}!A${e.row}`);
          await authorize();
          stage = 'sheet_label_read';
          const data = await request(sheetsAuth, endpoint + '?' + q, signal);
          if (
            data.spreadsheetId !== b.spreadsheetId ||
            !Array.isArray(data.sheets) ||
            data.sheets.length !== 1 ||
            data.sheets[0].properties?.sheetId !== tab.sheetId ||
            !Array.isArray(data.sheets[0].data)
          )
            FAIL('sheet_response_invalid');
          const cells = new Map();
          for (const block of data.sheets[0].data) {
            const row = block.startRow ?? 0;
            if (
              (block.startColumn ?? 0) !== 0 ||
              !Number.isSafeInteger(row) ||
              !entries.some((e) => e.row === row + 1) ||
              cells.has(row + 1) ||
              (block.rowData || []).length > 1 ||
              (block.rowData?.[0]?.values || []).length > 1
            )
              FAIL('sheet_response_invalid');
            cells.set(row + 1, block.rowData?.[0]?.values?.[0] || {});
          }
          if (cells.size !== entries.length) FAIL('sheet_response_incomplete');
          const rows = entries.map((e) => {
            const c = cells.get(e.row),
              formula = typeof c.userEnteredValue?.formulaValue === 'string';
            const raw =
              c.formattedValue ??
              c.effectiveValue?.stringValue ??
              c.effectiveValue?.numberValue ??
              c.effectiveValue?.boolValue ??
              c.userEnteredValue?.stringValue ??
              c.userEnteredValue?.numberValue ??
              c.userEnteredValue?.boolValue ??
              '';
            const text = normalize(raw),
              known = safeLabels.has(text),
              error = !!c.effectiveValue?.errorValue;
            return {
              project_id: args.project_id,
              year: args.year,
              mode: e.mode,
              line_id: e.line_id,
              source_cell: `A${e.row}`,
              expected_label: normalize(e.label),
              observed_label: known ? text : null,
              observed_hash: HASH({
                value: raw,
                user_type: formula
                  ? 'formula'
                  : Object.keys(c.userEnteredValue || {})[0] || 'empty',
              }),
              redacted: !known && text !== '',
              blank: text === '',
              formula_cell: formula,
              formula_text_included: false,
              effective_error: error,
              matches_expected: !error && text === normalize(e.label),
            };
          });
          stage = 'project_binding_recheck';
          const after = await project(args.project_id, signal);
          await authorize();
          signal?.throwIfAborted();
          if (
            before.update_time !== after.update_time ||
            bindingHash !== HASH(binding(after.value, args.year))
          )
            FAIL('sheet_binding_changed');
          const result = {
            project_id: args.project_id,
            year: args.year,
            rows,
            binding_version: bindingHash,
            project_update_time: before.update_time,
            config_updated_at: b.updatedAt || null,
            tab_identity_hash: HASH({
              id: b.spreadsheetId,
              sheetId: tab.sheetId,
            }),
            contract_hash: HASH(contract),
            expected_rule: {
              source_revision: contract.source_revision,
              coordinates_blob_sha: contract.coordinates_blob_sha,
              policy_blob_sha: contract.policy_blob_sha,
              deployed_rule_verified: false,
            },
            coverage: {
              complete: true,
              scope: 'fixed_live_sheet_label_cells',
              live_google_sheet_read: true,
              historical_state: false,
              financial_columns_read: false,
              formula_text_included: false,
              config_stable_before_after: true,
              sheet_atomic_snapshot: false,
              snapshot_fallback: false,
            },
          };
          const content_hash = HASH({
            source: 'read_authorized_sheet_labels',
            ...result,
          });
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: 'read_authorized_sheet_labels',
            status: 'available',
            ...result,
            cause_status: 'not_established',
          };
        } catch (e) {
          signal?.throwIfAborted();
          const allowed = [
            'invalid_scope',
            'source_credentials_missing',
            'source_response_too_large',
            'sheet_binding_missing',
            'sheet_source_year_mismatch',
            'sheet_binding_invalid',
            'sheet_binding_changed',
            'sheet_tab_binding_ambiguous',
            'sheet_response_invalid',
            'sheet_response_incomplete',
          ];
          const status = Number(e?.response?.status || e?.code);
          const code = allowed.includes(e?.safeCode)
            ? e.safeCode
            : status === 403
              ? 'source_access_denied'
              : status === 401
                ? 'source_auth_unavailable'
                : 'source_unavailable';
          return {
            evidence_id: `ev_${HASH({ code, observed_at })}`,
            observed_at,
            source: 'read_authorized_sheet_labels',
            status: 'unavailable',
            error_code: code,
            failed_stage: stage,
            rows: [],
            coverage: { complete: false, snapshot_fallback: false },
            cause_status: 'not_established',
          };
        }
      },
    },
  };
}
