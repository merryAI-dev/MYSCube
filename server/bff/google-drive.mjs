import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { resolveServiceAccount } from './firestore.mjs';

const DRIVE_API_BASE_URL = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API_BASE_URL = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const INVALID_DRIVE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MULTI_SPACE = /\s+/g;
const MULTI_UNDERSCORE = /_+/g;

export class DriveServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DriveServiceError';
    this.statusCode = options.statusCode || 500;
    this.code = options.code || 'drive_error';
    this.details = options.details;
  }
}

function readOptionalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEvidenceFileName(fileName) {
  return String(fileName || '')
    .normalize('NFC')
    .trim()
    .replace(/[_-]+/g, ' ');
}

function humanizeEvidenceStem(fileName) {
  return normalizeEvidenceFileName(fileName)
    .replace(/\.[^.]+$/, '')
    .replace(/\b20\d{2}[._-]?\d{1,2}([._-]?\d{1,2})?\b/g, ' ')
    .replace(/\b\d{6,8}\b/g, ' ')
    .replace(/\b(v|ver)\d+\b/gi, ' ')
    .replace(/\b(final|finals|draft|최종본?|수정본?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '기타';
}

function normalizeSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(INVALID_DRIVE_CHARS, ' ')
    .replace(MULTI_SPACE, ' ')
    .replace(/[()\[\]{}]/g, '')
    .replace(/\s/g, '_')
    .replace(MULTI_UNDERSCORE, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function escapeDriveQueryLiteral(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

export function extractDriveFolderId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const folderMatch = raw.match(/\/drive\/folders\/([A-Za-z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];

  const urlIdMatch = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (urlIdMatch) return urlIdMatch[1];

  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) {
    return raw;
  }

  return '';
}

function formatDriveDateToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'undated';
  const match = raw.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/);
  if (!match) return normalizeSegment(raw.slice(0, 10), 'undated');
  return `${match[1]}${match[2]}${match[3]}`;
}

export function buildDriveProjectFolderName(projectName, projectId) {
  const nameToken = normalizeSegment(projectName, 'project');
  const idToken = normalizeSegment(projectId || '', '');
  return idToken ? `${nameToken}_${idToken}` : nameToken;
}

export function buildDriveProjectChangeRequestFolderName({ requestedAt, requestId, requestVersion }) {
  const dateToken = readOptionalText(requestedAt).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || 'undated';
  const requestToken = normalizeSegment(requestId, 'request');
  const versionToken = Number.isSafeInteger(Number(requestVersion)) && Number(requestVersion) > 0
    ? Number(requestVersion)
    : 1;
  return `${dateToken}_${requestToken}_v${versionToken}`;
}

export function buildDriveTransactionFolderName(transaction) {
  const dateToken = formatDriveDateToken(transaction?.dateTime);
  const budgetToken = normalizeSegment(transaction?.budgetCategory || transaction?.counterparty || '미분류', '미분류');
  const subBudgetToken = normalizeSegment(transaction?.budgetSubCategory || transaction?.memo || '기타', '기타');
  const transactionToken = normalizeSegment(transaction?.id || '', 'tx');
  return [dateToken, budgetToken, subBudgetToken, transactionToken].join('_');
}

const CATEGORY_PATTERNS = [
  { category: 'ZOOM invoice', confidence: 0.92, patterns: [/zoom\s*invoice/i] },
  { category: '심사결과보고서', confidence: 0.93, patterns: [/심사\s*결과\s*보고서/i] },
  { category: '진행결과보고서', confidence: 0.92, patterns: [/진행\s*결과\s*보고서/i] },
  { category: '결과보고서', confidence: 0.9, patterns: [/결과\s*보고서/i] },
  { category: '강의자료', confidence: 0.91, patterns: [/강의\s*자료/i, /lecture/i] },
  { category: '견적서', confidence: 0.91, patterns: [/견적서/i, /견적\b/i, /quotation/i, /estimate/i] },
  { category: '결과물', confidence: 0.82, patterns: [/결과물/i, /deliverable/i, /output/i] },
  { category: '계약서', confidence: 0.9, patterns: [/계약서/i, /contract/i, /agreement/i] },
  { category: '협약서', confidence: 0.89, patterns: [/협약서/i, /mou/i, /memorandum/i] },
  { category: '공문', confidence: 0.87, patterns: [/공문/i, /공문서/i, /official\s*letter/i] },
  { category: '매출전표', confidence: 0.9, patterns: [/매출전표/i, /카드\s*매출\s*전표/i] },
  { category: '보도자료', confidence: 0.86, patterns: [/보도자료/i, /press\s*release/i] },
  { category: '표준재무제표증명', confidence: 0.95, patterns: [/표준\s*재무\s*제표\s*증명/i, /재무\s*제표\s*증명/i] },
  { category: '비용지급확인서', confidence: 0.91, patterns: [/비용\s*지급\s*확인서/i] },
  { category: '사업자등록증', confidence: 0.94, patterns: [/사업자\s*등록증?/i, /business\s*registration/i] },
  { category: '사용계획서', confidence: 0.83, patterns: [/사용\s*계획서/i] },
  { category: '세금계산서', confidence: 0.96, patterns: [/전자\s*세금\s*계산서/i, /세금\s*계산서/i, /tax\s*invoice/i, /invoice/i] },
  { category: '신분증 사본', confidence: 0.91, patterns: [/신분증\s*사본/i, /id\s*copy/i, /identity/i] },
  { category: '심사자료', confidence: 0.88, patterns: [/심사\s*자료/i, /review\s*material/i] },
  { category: '영수증', confidence: 0.94, patterns: [/영수증/i, /receipt/i] },
  { category: '우버 인증 내역', confidence: 0.83, patterns: [/우버\s*인증\s*내역/i, /uber/i] },
  { category: '운영계획', confidence: 0.82, patterns: [/운영\s*계획/i] },
  { category: '원천세 내역', confidence: 0.88, patterns: [/원천세\s*내역/i, /withholding/i] },
  { category: '이력서', confidence: 0.92, patterns: [/이력서/i, /resume/i, /cv/i] },
  { category: '이체확인증', confidence: 0.92, patterns: [/계좌\s*이체\s*확인증/i, /이체\s*확인증/i, /이체\s*확인서/i, /transfer\s*confirmation/i] },
  { category: '입금확인증', confidence: 0.9, patterns: [/입금\s*확인증/i, /입금증/i, /deposit\s*confirmation/i] },
  { category: '입금확인서', confidence: 0.9, patterns: [/입금\s*확인서/i, /송금\s*확인/i, /송금\s*확인증/i, /deposit/i] },
  { category: '재단 메일', confidence: 0.75, patterns: [/재단\s*메일/i, /foundation\s*mail/i, /email/i] },
  { category: '정산규정', confidence: 0.86, patterns: [/정산\s*규정/i, /policy/i] },
  { category: '지출결의', confidence: 0.84, patterns: [/지출\s*결의서?/i, /품의서/i] },
  { category: '진행개요', confidence: 0.81, patterns: [/진행\s*개요/i, /overview/i] },
  { category: '청구내역서', confidence: 0.9, patterns: [/청구\s*내역서/i, /billing\s*statement/i] },
  { category: '청구서', confidence: 0.88, patterns: [/청구서/i, /bill/i, /claim/i] },
  { category: '출장신청서', confidence: 0.88, patterns: [/출장\s*신청서/i, /travel\s*request/i] },
  { category: '통장사본', confidence: 0.8, patterns: [/통장\s*사본/i, /bank\s*copy/i] },
  { category: '해외송금영수증', confidence: 0.92, patterns: [/해외\s*송금\s*영수증/i, /wire\s*receipt/i, /swift/i] },
  { category: '해외이용내역서', confidence: 0.86, patterns: [/해외\s*이용\s*내역서/i, /overseas\s*usage/i] },
  { category: '행사계획안', confidence: 0.84, patterns: [/행사\s*계획안/i, /event\s*plan/i] },
  { category: '회의록', confidence: 0.9, patterns: [/회의록/i, /minutes/i] },
  { category: '참석자명단', confidence: 0.88, patterns: [/참석자\s*명단/i, /출석부/i, /attendance/i] },
  { category: '거래명세서', confidence: 0.86, patterns: [/거래\s*명세(?:서|표)?/i, /거래\s*내역서/i, /statement/i] },
  { category: '사진', confidence: 0.72, patterns: [/사진/i, /photo/i, /image/i] },
];

export function inferEvidenceCategoryFromFileName(fileName, fallback = '기타') {
  const normalized = normalizeEvidenceFileName(fileName);
  if (!normalized) return { category: fallback, confidence: 0.2 };
  const matched = CATEGORY_PATTERNS.find((entry) => entry.patterns.some((pattern) => pattern.test(normalized)));
  if (!matched) {
    return { category: fallback, confidence: 0.2 };
  }
  return { category: matched.category, confidence: matched.confidence };
}

export function deriveEvidenceLabelFromFileName(fileName, fallback = '기타') {
  const inferred = inferEvidenceCategoryFromFileName(fileName, fallback);
  if (inferred.category && inferred.category !== fallback) return inferred.category;
  return humanizeEvidenceStem(fileName) || fallback;
}

export function inferEvidenceCategoryFromDocumentText(documentText, fallback = '기타') {
  const normalized = String(documentText || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return { category: fallback, confidence: 0.2 };
  if (
    (/표준\s*재무\s*제표\s*증명/i.test(normalized) || /재무\s*제표\s*증명/i.test(normalized))
    && /사업자\s*등록\s*번호/i.test(normalized)
    && /(업태|종목)/i.test(normalized)
  ) {
    return { category: '표준재무제표증명', confidence: 0.95 };
  }
  return inferEvidenceCategoryFromFileName(normalized, fallback);
}

export function buildEvidenceCompletedDesc(evidences) {
  const categories = (Array.isArray(evidences) ? evidences : [])
    .map((evidence) => {
      const explicit = readOptionalText(evidence?.category);
      if (explicit && explicit !== '기타') return explicit;
      const parsed = readOptionalText(evidence?.parserCategory);
      if (parsed && parsed !== '기타') return parsed;
      return deriveEvidenceLabelFromFileName(evidence?.fileName);
    })
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(categories)].join(', ');
}

function splitEvidenceList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeEvidenceMatchKey(value) {
  const normalized = String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[_\-\s()[\]{}]+/g, '');
  if (!normalized) return '';
  if (normalized.includes('zoominvoice')) return 'ZOOM invoice';
  if (normalized.includes('표준재무제표증명') || normalized.includes('재무제표증명')) return '표준재무제표증명';
  if (normalized.includes('세금계산서') || normalized.includes('전자세금계산') || normalized.includes('taxinvoice')) return '세금계산서';
  if (normalized.includes('입금확인증') || normalized.includes('입금확인서') || normalized.includes('depositconfirmation')) return '입금확인서';
  if (normalized.includes('이체확인증') || normalized.includes('이체확인서') || normalized.includes('transferconfirmation')) return '이체확인증';
  if (normalized.includes('해외송금영수증') || normalized.includes('wirereceipt') || normalized.includes('swift')) return '해외송금영수증';
  return normalized;
}

function collectEvidenceMatchKeys(evidence) {
  const keys = new Set();
  for (const candidate of [
    evidence?.category,
    evidence?.parserCategory,
    evidence?.fileName,
    evidence?.originalFileName,
  ]) {
    const raw = readOptionalText(candidate);
    if (!raw) continue;
    const normalized = normalizeEvidenceMatchKey(raw);
    if (normalized) keys.add(normalized);
    const inferred = inferEvidenceCategoryFromFileName(raw).category;
    const inferredNormalized = normalizeEvidenceMatchKey(inferred);
    if (inferredNormalized) keys.add(inferredNormalized);
  }
  return keys;
}

function mergeEvidenceCompletedDesc(previousCompleted, autoCompletedDesc) {
  const merged = [];
  const seen = new Set();
  for (const entry of [
    ...splitEvidenceList(previousCompleted),
    ...splitEvidenceList(autoCompletedDesc),
  ]) {
    const key = normalizeEvidenceMatchKey(entry) || entry;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.join(', ');
}

function resolveManualCompletedDesc(transaction) {
  const explicitManual = readOptionalText(transaction?.evidenceCompletedManualDesc);
  if (explicitManual) return explicitManual;

  const completedDesc = readOptionalText(transaction?.evidenceCompletedDesc);
  const autoCompletedDesc = readOptionalText(transaction?.evidenceAutoListedDesc);
  if (!completedDesc) return '';
  if (!autoCompletedDesc) return completedDesc;

  const autoKeys = new Set(
    splitEvidenceList(autoCompletedDesc)
      .map((entry) => normalizeEvidenceMatchKey(entry) || entry),
  );

  return splitEvidenceList(completedDesc)
    .filter((entry) => {
      const key = normalizeEvidenceMatchKey(entry) || entry;
      return !autoKeys.has(key);
    })
    .join(', ');
}

function computeEvidenceMissing(requiredValues, completedDesc, evidences = []) {
  const completedKeys = new Set(
    splitEvidenceList(completedDesc)
      .map((entry) => normalizeEvidenceMatchKey(entry))
      .filter(Boolean),
  );
  for (const evidence of Array.isArray(evidences) ? evidences : []) {
    for (const key of collectEvidenceMatchKeys(evidence)) {
      completedKeys.add(key);
    }
  }
  return requiredValues.filter((required) => {
    const requiredKey = normalizeEvidenceMatchKey(required);
    if (!requiredKey) return true;
    return !completedKeys.has(requiredKey);
      });
}

function computeEvidenceStatus({ hasLink, requiredValues, completedDesc }) {
  const completed = splitEvidenceList(completedDesc);
  if (!requiredValues.length) {
    if (hasLink && completed.length > 0) return 'COMPLETE';
    if (hasLink || completed.length > 0) return 'PARTIAL';
    return 'MISSING';
  }

  const missing = computeEvidenceMissing(requiredValues, completedDesc);
  if (missing.length === 0 && hasLink) return 'COMPLETE';
  if (hasLink || completed.length > 0) return 'PARTIAL';
  return 'MISSING';
}

function readRequiredEvidence(transaction) {
  if (Array.isArray(transaction?.evidenceRequired) && transaction.evidenceRequired.length > 0) {
    return transaction.evidenceRequired
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }
  return splitEvidenceList(transaction?.evidenceRequiredDesc);
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

export function resolveDriveServiceConfig(env = process.env) {
  const serviceAccount = resolveServiceAccountFromEnv(env);
  return {
    sharedDriveId: readOptionalText(env.GOOGLE_DRIVE_SHARED_DRIVE_ID),
    defaultParentFolderId: readOptionalText(env.GOOGLE_DRIVE_EVIDENCE_ROOT_FOLDER_ID),
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

function buildFileQuery({ parentFolderId, folderOnly = false, appProperties = {}, name }) {
  const conditions = ['trashed = false'];
  if (folderOnly) {
    conditions.push(`mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`);
  } else {
    conditions.push(`mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`);
  }
  if (parentFolderId) {
    conditions.push(`'${escapeDriveQueryLiteral(parentFolderId)}' in parents`);
  }
  if (name) {
    conditions.push(`name = '${escapeDriveQueryLiteral(name)}'`);
  }
  for (const [key, value] of Object.entries(appProperties)) {
    const normalizedValue = readOptionalText(value);
    if (!normalizedValue) continue;
    conditions.push(
      `appProperties has { key='${escapeDriveQueryLiteral(key)}' and value='${escapeDriveQueryLiteral(normalizedValue)}' }`,
    );
  }
  return conditions.join(' and ');
}

function normalizeDriveFile(file, fallbackDriveId = '') {
  return {
    id: readOptionalText(file?.id),
    name: readOptionalText(file?.name),
    mimeType: readOptionalText(file?.mimeType),
    size: Number.parseInt(String(file?.size || '0'), 10) || 0,
    webViewLink: readOptionalText(file?.webViewLink),
    webContentLink: readOptionalText(file?.webContentLink),
    modifiedTime: readOptionalText(file?.modifiedTime),
    createdTime: readOptionalText(file?.createdTime),
    parents: Array.isArray(file?.parents) ? file.parents.filter(Boolean) : [],
    driveId: readOptionalText(file?.driveId) || fallbackDriveId,
    appProperties: file?.appProperties && typeof file.appProperties === 'object' ? file.appProperties : {},
  };
}

export function resolveEvidenceSyncPatch({ transaction, evidences, folder }) {
  const autoCompletedDesc = buildEvidenceCompletedDesc(evidences);
  const manualCompletedDesc = resolveManualCompletedDesc(transaction);
  const completedDesc = mergeEvidenceCompletedDesc(autoCompletedDesc, manualCompletedDesc) || undefined;
  const requiredValues = readRequiredEvidence(transaction);
  const evidenceMissing = computeEvidenceMissing(requiredValues, completedDesc, evidences);
  const evidencePendingDesc = evidenceMissing.join(', ');
  const hasLink = !!readOptionalText(folder?.webViewLink) || !!readOptionalText(transaction?.evidenceDriveLink);

  return {
    attachmentsCount: evidences.length,
    evidenceAutoListedDesc: autoCompletedDesc || undefined,
    evidenceCompletedManualDesc: manualCompletedDesc || undefined,
    evidenceCompletedDesc: completedDesc || undefined,
    evidencePendingDesc: evidencePendingDesc || undefined,
    supportPendingDocs: evidencePendingDesc || undefined,
    evidenceMissing,
    evidenceStatus: computeEvidenceStatus({
      hasLink,
      requiredValues,
      completedDesc,
    }),
  };
}

export function createGoogleDriveService(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = options.config || resolveDriveServiceConfig(env);
  let jwtClient = null;

  function assertConfigured() {
    if (!config.enabled || !config.serviceAccount?.client_email || !config.serviceAccount?.private_key) {
      throw new DriveServiceError(
        'Google Drive service account is not configured. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_JSON.',
        { statusCode: 503, code: 'drive_not_configured' },
      );
    }
  }

  function getJwtClient() {
    assertConfigured();
    if (jwtClient) return jwtClient;
    jwtClient = new JWT({
      email: config.serviceAccount.client_email,
      key: config.serviceAccount.private_key,
      scopes: [DRIVE_SCOPE],
    });
    return jwtClient;
  }

  async function driveFetch(pathname, init = {}, baseUrl = DRIVE_API_BASE_URL) {
    const client = getJwtClient();
    const authHeaders = await client.getRequestHeaders();
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...authHeaders,
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const details = await readJsonResponse(response);
      throw new DriveServiceError(
        `Google Drive API request failed (${response.status})`,
        {
          statusCode: response.status >= 500 ? 502 : response.status,
          code: 'drive_api_error',
          details,
        },
      );
    }

    return readJsonResponse(response);
  }

  async function getFile(fileId) {
    const normalizedId = readOptionalText(fileId);
    if (!normalizedId) return null;

    try {
      const data = await driveFetch(
        `/files/${encodeURIComponent(normalizedId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents,driveId,appProperties`,
      );
      return normalizeDriveFile(data, config.sharedDriveId);
    } catch (error) {
      if (error instanceof DriveServiceError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async function findFolder({ parentFolderId, name, appProperties }) {
    const q = buildFileQuery({
      parentFolderId,
      folderOnly: true,
      appProperties,
      name,
    });
    const params = new URLSearchParams({
      q,
      pageSize: '10',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      fields: 'files(id,name,mimeType,webViewLink,parents,driveId,appProperties)',
    });
    const data = await driveFetch(`/files?${params.toString()}`);
    const first = Array.isArray(data?.files) ? data.files[0] : null;
    return first ? normalizeDriveFile(first, config.sharedDriveId) : null;
  }

  async function createFolder({ name, parentFolderId, appProperties = {} }) {
    const normalizedParentId = readOptionalText(parentFolderId);
    if (!normalizedParentId) {
      throw new DriveServiceError(
        'A parent folder is required to create an evidence folder. Set GOOGLE_DRIVE_EVIDENCE_ROOT_FOLDER_ID.',
        { statusCode: 503, code: 'drive_parent_missing' },
      );
    }

    const data = await driveFetch('/files?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents,driveId,appProperties', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        parents: [normalizedParentId],
        appProperties,
      }),
    });
    return normalizeDriveFile(data, config.sharedDriveId);
  }

  async function renameFile({ fileId, name }) {
    const normalizedFileId = readOptionalText(fileId);
    const normalizedName = readOptionalText(name);
    if (!normalizedFileId) {
      throw new DriveServiceError('fileId is required', { statusCode: 400, code: 'drive_file_id_required' });
    }
    if (!normalizedName) {
      throw new DriveServiceError('name is required', { statusCode: 400, code: 'drive_file_name_required' });
    }

    const data = await driveFetch(
      `/files/${encodeURIComponent(normalizedFileId)}?supportsAllDrives=true&fields=id,name,mimeType,webViewLink,parents,driveId,appProperties`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: normalizedName }),
      },
    );
    return normalizeDriveFile(data, config.sharedDriveId);
  }

  async function uploadFileToFolder({
    folderId,
    fileName,
    mimeType = 'application/octet-stream',
    contentBase64,
    appProperties = {},
  }) {
    const normalizedFolderId = readOptionalText(folderId);
    const normalizedFileName = readOptionalText(fileName);
    const normalizedMimeType = readOptionalText(mimeType) || 'application/octet-stream';
    const normalizedContentBase64 = readOptionalText(contentBase64);

    if (!normalizedFolderId) {
      throw new DriveServiceError('folderId is required', { statusCode: 400, code: 'drive_folder_id_required' });
    }
    if (!normalizedFileName) {
      throw new DriveServiceError('fileName is required', { statusCode: 400, code: 'drive_file_name_required' });
    }
    if (!normalizedContentBase64) {
      throw new DriveServiceError('contentBase64 is required', { statusCode: 400, code: 'drive_file_content_required' });
    }

    const contentBuffer = Buffer.from(normalizedContentBase64, 'base64');
    if (!contentBuffer.length) {
      throw new DriveServiceError('Decoded upload body is empty', { statusCode: 400, code: 'drive_file_content_invalid' });
    }

    const boundary = `driveupload_${Date.now().toString(36)}`;
    const metadata = {
      name: normalizedFileName,
      parents: [normalizedFolderId],
      appProperties,
    };
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: ${normalizedMimeType}\r\n\r\n`,
      'utf8',
    );
    const suffix = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([prefix, contentBuffer, suffix]);

    const data = await driveFetch(
      `/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,webContentLink,modifiedTime,createdTime,parents,driveId,appProperties`,
      {
        method: 'POST',
        headers: {
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
      DRIVE_UPLOAD_API_BASE_URL,
    );
    return normalizeDriveFile(data, config.sharedDriveId);
  }

  async function ensureProjectRootFolder({ tenantId, projectId, projectName, existingFolderId, preferredParentFolderId }) {
    const existingFolder = await getFile(existingFolderId);
    if (existingFolder) {
      return existingFolder;
    }

    const parentFolderId = readOptionalText(preferredParentFolderId) || config.defaultParentFolderId;
    const folderName = buildDriveProjectFolderName(projectName, projectId);
    const appProperties = {
      managedBy: 'mysc-platform',
      tenantId,
      projectId,
      folderRole: 'project-root',
    };

    const found = await findFolder({ parentFolderId, name: folderName, appProperties });
    if (found) {
      return found;
    }

    return createFolder({
      name: folderName,
      parentFolderId,
      appProperties,
    });
  }

  async function renameManagedProjectRootFolder({ projectId, projectName, existingFolderId }) {
    const existingFolder = await getFile(existingFolderId);
    if (!existingFolder) return null;
    const managedBy = readOptionalText(existingFolder.appProperties?.managedBy);
    const folderRole = readOptionalText(existingFolder.appProperties?.folderRole);
    const folderProjectId = readOptionalText(existingFolder.appProperties?.projectId);
    if (managedBy !== 'mysc-platform' || folderRole !== 'project-root' || folderProjectId !== readOptionalText(projectId)) {
      return existingFolder;
    }
    const nextName = buildDriveProjectFolderName(projectName, projectId);
    if (!nextName || existingFolder.name === nextName) {
      return existingFolder;
    }
    return renameFile({ fileId: existingFolder.id, name: nextName });
  }

  async function ensureTransactionFolder({ tenantId, projectId, projectName, transaction, projectFolderId, existingFolderId }) {
    const existingFolder = await getFile(existingFolderId);
    if (existingFolder) {
      const projectRootFolder = await ensureProjectRootFolder({
        tenantId,
        projectId,
        projectName,
        existingFolderId: projectFolderId,
      });
      return {
        folder: existingFolder,
        projectRootFolder,
      };
    }

    const projectRootFolder = await ensureProjectRootFolder({
      tenantId,
      projectId,
      projectName,
      existingFolderId: projectFolderId,
    });
    const folderName = buildDriveTransactionFolderName(transaction);
    const appProperties = {
      managedBy: 'mysc-platform',
      tenantId,
      projectId,
      transactionId: transaction.id,
      folderRole: 'transaction-root',
    };

    const found = await findFolder({
      parentFolderId: projectRootFolder.id,
      name: folderName,
      appProperties,
    });
    if (found) {
      return {
        folder: found,
        projectRootFolder,
      };
    }

    const folder = await createFolder({
      name: folderName,
      parentFolderId: projectRootFolder.id,
      appProperties,
    });
    return {
      folder,
      projectRootFolder,
    };
  }

  async function ensureProjectChangeRequestFolder({
    tenantId,
    projectId,
    projectName,
    projectFolderId,
    requestId,
    requestVersion,
    requestedAt,
  }) {
    const projectRootFolder = await ensureProjectRootFolder({
      tenantId,
      projectId,
      projectName,
      existingFolderId: projectFolderId,
    });
    const requestsProperties = {
      managedBy: 'mysc-platform',
      tenantId,
      projectId,
      folderRole: 'project-change-requests',
    };
    const requestsFolder = await findFolder({
      parentFolderId: projectRootFolder.id,
      name: '변경 요청',
      appProperties: requestsProperties,
    }) || await createFolder({
      name: '변경 요청',
      parentFolderId: projectRootFolder.id,
      appProperties: requestsProperties,
    });
    const folderName = buildDriveProjectChangeRequestFolderName({ requestedAt, requestId, requestVersion });
    const requestProperties = {
      managedBy: 'mysc-platform',
      tenantId,
      projectId,
      requestId,
      requestVersion: String(requestVersion),
      folderRole: 'project-change-request',
    };
    const folder = await findFolder({
      parentFolderId: requestsFolder.id,
      name: folderName,
      appProperties: requestProperties,
    }) || await createFolder({
      name: folderName,
      parentFolderId: requestsFolder.id,
      appProperties: requestProperties,
    });
    return { folder, projectRootFolder };
  }

  async function listFolderFiles({ folderId }) {
    const normalizedFolderId = readOptionalText(folderId);
    if (!normalizedFolderId) {
      throw new DriveServiceError('folderId is required', { statusCode: 400, code: 'drive_folder_id_required' });
    }

    const files = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams({
        q: buildFileQuery({ parentFolderId: normalizedFolderId, folderOnly: false }),
        pageSize: '200',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        orderBy: 'createdTime asc,name',
        fields: 'nextPageToken,files(id,name,mimeType,size,webViewLink,webContentLink,modifiedTime,createdTime,parents,driveId,appProperties)',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const data = await driveFetch(`/files?${params.toString()}`);
      const nextItems = Array.isArray(data?.files)
        ? data.files.map((item) => normalizeDriveFile(item, config.sharedDriveId))
        : [];
      files.push(...nextItems);
      pageToken = readOptionalText(data?.nextPageToken);
    } while (pageToken);

    return files;
  }

  return {
    getConfig() {
      return {
        enabled: config.enabled,
        sharedDriveId: config.sharedDriveId,
        defaultParentFolderId: config.defaultParentFolderId,
        serviceAccountEmail: readOptionalText(config.serviceAccount?.client_email),
      };
    },
    assertConfigured,
    getFile,
    ensureProjectRootFolder,
    renameManagedProjectRootFolder,
    ensureTransactionFolder,
    ensureProjectChangeRequestFolder,
    listFolderFiles,
    uploadFileToFolder,
  };
}
