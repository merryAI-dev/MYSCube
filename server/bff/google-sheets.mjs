import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { resolveServiceAccount } from './firestore.mjs';

const SHEETS_API_BASE_URL = 'https://sheets.googleapis.com/v4';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// 변경 감지용. 시트 내용을 읽지 않고 파일 메타데이터(modifiedTime)만 본다.
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const DRIVE_FILES_API_BASE_URL = 'https://www.googleapis.com/drive/v3';

export class GoogleSheetsServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GoogleSheetsServiceError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'google_sheets_error';
    this.details = options.details;
  }
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveServiceAccountFromEnv(env = process.env) {
  const rawPath = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH);
  if (rawPath) {
    return resolveServiceAccount({
      FIREBASE_SERVICE_ACCOUNT_JSON: fs.readFileSync(rawPath, 'utf8'),
      FIREBASE_SERVICE_ACCOUNT_BASE64: '',
    });
  }

  const rawJson = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON);
  if (rawJson) {
    return resolveServiceAccount({
      FIREBASE_SERVICE_ACCOUNT_JSON: rawJson,
      FIREBASE_SERVICE_ACCOUNT_BASE64: '',
    });
  }

  const rawBase64 = readOptionalText(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_BASE64);
  if (rawBase64) {
    return resolveServiceAccount({
      FIREBASE_SERVICE_ACCOUNT_JSON: '',
      FIREBASE_SERVICE_ACCOUNT_BASE64: rawBase64,
    });
  }

  return resolveServiceAccount(env);
}

export function resolveGoogleSheetsServiceConfig(env = process.env) {
  const serviceAccount = resolveServiceAccountFromEnv(env);
  return {
    serviceAccount,
    enabled: !!serviceAccount,
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractSpreadsheetId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const linkMatch = raw.match(/\/d\/([A-Za-z0-9-_]+)/);
  if (linkMatch) return linkMatch[1];

  const urlIdMatch = raw.match(/[?&]id=([A-Za-z0-9-_]+)/);
  if (urlIdMatch) return urlIdMatch[1];

  if (/^[A-Za-z0-9-_]{20,}$/.test(raw)) {
    return raw;
  }

  return '';
}

export function extractSpreadsheetGid(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const gidMatch = raw.match(/[?&#]gid=(\d+)/);
  if (!gidMatch) return null;
  const parsed = Number.parseInt(gidMatch[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSheetTitle(title) {
  return readOptionalText(title) || 'Sheet1';
}

function quoteSheetNameForRange(sheetName) {
  const normalized = normalizeSheetTitle(sheetName);
  return `'${normalized.replace(/'/g, "''")}'`;
}

function normalizeA1Range(rangeA1) {
  return readOptionalText(rangeA1).replace(/^'+|'+$/g, '');
}

function buildValuesRange(sheetName, rangeA1) {
  const quotedSheetName = quoteSheetNameForRange(sheetName);
  const normalizedRange = normalizeA1Range(rangeA1);
  return normalizedRange ? `${quotedSheetName}!${normalizedRange}` : quotedSheetName;
}

function normalizeSheetDescriptor(sheet) {
  return {
    sheetId: readOptionalNumber(sheet?.properties?.sheetId) ?? 0,
    title: normalizeSheetTitle(sheet?.properties?.title),
    index: readOptionalNumber(sheet?.properties?.index) ?? 0,
  };
}

export function createGoogleSheetsService(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = options.config || resolveGoogleSheetsServiceConfig(env);
  const authHeadersFactory = options.authHeadersFactory;
  let jwtClient = null;

  function assertConfigured() {
    if (!config.enabled || !config.serviceAccount?.client_email || !config.serviceAccount?.private_key) {
      throw new GoogleSheetsServiceError(
        'Google Sheets service account is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_JSON.',
        { statusCode: 503, code: 'google_sheets_not_configured' },
      );
    }
  }

  async function getAuthHeaders(accessToken) {
    const normalizedAccessToken = readOptionalText(accessToken);
    if (normalizedAccessToken) {
      return { authorization: `Bearer ${normalizedAccessToken}` };
    }
    if (typeof authHeadersFactory === 'function') {
      return authHeadersFactory();
    }
    assertConfigured();
    if (!jwtClient) {
      jwtClient = new JWT({
        email: config.serviceAccount.client_email,
        key: config.serviceAccount.private_key,
        scopes: [SHEETS_SCOPE],
      });
    }
    return jwtClient.getRequestHeaders();
  }

  let driveMetadataJwtClient = null;

  // 시트가 바뀌었는지 "싸게" 묻는다 (Drive files.get, ~수십 ms). 시트 본문 읽기(수 초)와
  // 분리하는 것이 핵심이다 - 검색엔진이 쿼리마다 크롤링하지 않는 것과 같은 원리로,
  // 변경이 없으면 고정본을 그대로 쓴다. 같은 서비스 계정을 쓰므로 시트가 SA 에
  // 공유돼 있으면 메타데이터도 읽힌다.
  async function getSpreadsheetFreshness(value) {
    const spreadsheetId = extractSpreadsheetId(value);
    if (!spreadsheetId) return null;
    assertConfigured();
    if (!driveMetadataJwtClient) {
      driveMetadataJwtClient = new JWT({
        email: config.serviceAccount.client_email,
        key: config.serviceAccount.private_key,
        scopes: [DRIVE_METADATA_SCOPE],
      });
    }
    const authHeaders = await driveMetadataJwtClient.getRequestHeaders();
    const response = await fetchImpl(
      `${DRIVE_FILES_API_BASE_URL}/files/${encodeURIComponent(spreadsheetId)}?supportsAllDrives=true&fields=modifiedTime,version`,
      { headers: { ...authHeaders } },
    );
    if (!response.ok) {
      throw new GoogleSheetsServiceError(
        '시트 변경 여부를 확인하지 못했습니다.',
        { statusCode: response.status, code: 'spreadsheet_freshness_unavailable' },
      );
    }
    const payload = await readJsonResponse(response);
    const modifiedTime = readOptionalText(payload?.modifiedTime);
    if (!modifiedTime) return null;
    return { spreadsheetId, modifiedTime, version: readOptionalText(payload?.version) };
  }

  async function sheetsFetch(pathname, init = {}, accessToken) {
    const authHeaders = await getAuthHeaders(accessToken);
    const response = await fetchImpl(`${SHEETS_API_BASE_URL}${pathname}`, {
      ...init,
      headers: {
        ...authHeaders,
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const details = await readJsonResponse(response);
      throw new GoogleSheetsServiceError(
        `Google Sheets API request failed (${response.status})`,
        {
          statusCode: response.status >= 500 ? 502 : response.status,
          code: 'google_sheets_api_error',
          details,
        },
      );
    }

    return readJsonResponse(response);
  }

  async function getSpreadsheetMeta(spreadsheetId, accessToken) {
    const normalizedId = extractSpreadsheetId(spreadsheetId);
    if (!normalizedId) {
      throw new GoogleSheetsServiceError(
        'Google Sheets 링크 또는 spreadsheet ID를 입력해 주세요.',
        { statusCode: 400, code: 'spreadsheet_id_required' },
      );
    }

    const fields = [
      'spreadsheetId',
      'properties.title',
      'sheets.properties.sheetId',
      'sheets.properties.title',
      'sheets.properties.index',
    ].join(',');
    const data = await sheetsFetch(
      `/spreadsheets/${encodeURIComponent(normalizedId)}?fields=${encodeURIComponent(fields)}`,
      {},
      accessToken,
    );
    const availableSheets = Array.isArray(data?.sheets)
      ? data.sheets.map((sheet) => normalizeSheetDescriptor(sheet)).sort((a, b) => a.index - b.index)
      : [];

    return {
      spreadsheetId: normalizedId,
      spreadsheetTitle: readOptionalText(data?.properties?.title) || normalizedId,
      availableSheets,
    };
  }

  async function getSheetValues({ spreadsheetId, sheetName, accessToken, rangeA1 }) {
    const normalizedId = extractSpreadsheetId(spreadsheetId);
    const normalizedSheetName = normalizeSheetTitle(sheetName);
    const range = buildValuesRange(normalizedSheetName, rangeA1);
    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });

    const data = await sheetsFetch(
      `/spreadsheets/${encodeURIComponent(normalizedId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
      {},
      accessToken,
    );

    return Array.isArray(data?.values)
      ? data.values.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
      : [];
  }

  async function batchUpdateValues({ spreadsheetId, sheetName, updates, accessToken, valueInputOption = 'USER_ENTERED' }) {
    const normalizedId = extractSpreadsheetId(spreadsheetId);
    const normalizedSheetName = normalizeSheetTitle(sheetName);
    const normalizedUpdates = Array.isArray(updates)
      ? updates
        .map((update) => ({
          range: buildValuesRange(normalizedSheetName, update?.rangeA1),
          values: Array.isArray(update?.values) ? update.values : [[update?.value ?? '']],
        }))
        .filter((update) => update.range)
      : [];

    if (!normalizedId) {
      throw new GoogleSheetsServiceError(
        'Google Sheets 링크 또는 spreadsheet ID를 입력해 주세요.',
        { statusCode: 400, code: 'spreadsheet_id_required' },
      );
    }
    if (normalizedUpdates.length === 0) {
      return { spreadsheetId: normalizedId, totalUpdatedCells: 0, responses: [] };
    }

    const data = await sheetsFetch(
      `/spreadsheets/${encodeURIComponent(normalizedId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          valueInputOption,
          data: normalizedUpdates,
        }),
      },
      accessToken,
    );

    return {
      spreadsheetId: normalizedId,
      totalUpdatedCells: Number(data?.totalUpdatedCells) || 0,
      totalUpdatedRows: Number(data?.totalUpdatedRows) || 0,
      totalUpdatedColumns: Number(data?.totalUpdatedColumns) || 0,
      totalUpdatedSheets: Number(data?.totalUpdatedSheets) || 0,
      responses: Array.isArray(data?.responses) ? data.responses : [],
    };
  }

  async function previewSpreadsheet({ value, sheetName, accessToken, rangeA1, selectSheet }) {
    const spreadsheetId = extractSpreadsheetId(value);
    if (!spreadsheetId) {
      throw new GoogleSheetsServiceError(
        'Google Sheets 링크 또는 spreadsheet ID를 입력해 주세요.',
        { statusCode: 400, code: 'spreadsheet_id_required' },
      );
    }

    const gid = sheetName ? null : extractSpreadsheetGid(value);
    const meta = await getSpreadsheetMeta(spreadsheetId, accessToken);

    let selectedSheet = null;
    if (sheetName) {
      selectedSheet = meta.availableSheets.find((sheet) => sheet.title === sheetName) || null;
      if (!selectedSheet) {
        throw new GoogleSheetsServiceError(
          `시트 탭을 찾을 수 없습니다: ${sheetName}`,
          { statusCode: 404, code: 'sheet_tab_not_found' },
        );
      }
    } else if (typeof selectSheet === 'function') {
      selectedSheet = selectSheet(meta.availableSheets) || null;
    } else if (gid != null) {
      selectedSheet = meta.availableSheets.find((sheet) => sheet.sheetId === gid) || null;
    }

    if (!selectedSheet) {
      selectedSheet = meta.availableSheets[0] || null;
    }
    if (!selectedSheet) {
      throw new GoogleSheetsServiceError(
        '읽을 수 있는 시트 탭이 없습니다.',
        { statusCode: 404, code: 'sheet_tab_missing' },
      );
    }

    const matrix = await getSheetValues({
      spreadsheetId: meta.spreadsheetId,
      sheetName: selectedSheet.title,
      accessToken,
      rangeA1,
    });

    return {
      spreadsheetId: meta.spreadsheetId,
      spreadsheetTitle: meta.spreadsheetTitle,
      selectedSheetName: selectedSheet.title,
      availableSheets: meta.availableSheets,
      matrix,
    };
  }

  return {
    serviceAccountEmail: readOptionalText(config.serviceAccount?.client_email),
    getServiceAccountEmail: () => readOptionalText(config.serviceAccount?.client_email),
    getSpreadsheetMeta,
    getSpreadsheetFreshness,
    getSheetValues,
    batchUpdateValues,
    previewSpreadsheet,
  };
}
