import { describe, expect, it } from 'vitest';
import {
  buildDriveProjectChangeRequestFolderName,
  buildDriveProjectFolderName,
  buildDriveTransactionFolderName,
  deriveEvidenceLabelFromFileName,
  extractDriveFolderId,
  inferEvidenceCategoryFromDocumentText,
  inferEvidenceCategoryFromFileName,
  resolveEvidenceSyncPatch,
} from './google-drive.mjs';

describe('google-drive helpers', () => {
  it('builds deterministic project and transaction folder names', () => {
    expect(buildDriveProjectFolderName('온드림 AI 증빙', 'p001')).toBe('온드림_AI_증빙_p001');
    expect(buildDriveProjectChangeRequestFolderName({
      requestedAt: '2026-09-07T09:30:00.000Z',
      requestId: 'change-p001',
      requestVersion: 2,
    })).toBe('2026-09-07_change-p001_v2');
    expect(buildDriveTransactionFolderName({
      id: 'tx001',
      dateTime: '2026-03-11',
      budgetCategory: '회의비',
      budgetSubCategory: '다과비',
      counterparty: '카페',
      memo: '회의 간식',
    } as any)).toBe('20260311_회의비_다과비_tx001');
  });

  it('infers evidence categories with confidence', () => {
    expect(inferEvidenceCategoryFromFileName('세금계산서_3월.pdf')).toEqual({
      category: '세금계산서',
      confidence: 0.96,
    });
    expect(inferEvidenceCategoryFromFileName('random.bin')).toEqual({
      category: '기타',
      confidence: 0.2,
    });
  });

  it('supports the expanded evidence category dictionary from Merry operations', () => {
    expect(inferEvidenceCategoryFromFileName('강의자료_202603.pdf').category).toBe('강의자료');
    expect(inferEvidenceCategoryFromFileName('견적서_수정.xlsx').category).toBe('견적서');
    expect(inferEvidenceCategoryFromFileName('전자세금계산서_4월.pdf').category).toBe('세금계산서');
    expect(inferEvidenceCategoryFromFileName('송금확인증_4월.pdf').category).toBe('입금확인서');
    expect(inferEvidenceCategoryFromFileName('지출결의서_초안.hwp').category).toBe('지출결의');
    expect(inferEvidenceCategoryFromFileName('거래명세표_4월.pdf').category).toBe('거래명세서');
    expect(inferEvidenceCategoryFromFileName('비용지급확인서_홍길동.pdf').category).toBe('비용지급확인서');
    expect(inferEvidenceCategoryFromFileName('이체확인증_3월.pdf').category).toBe('이체확인증');
    expect(inferEvidenceCategoryFromFileName('진행결과보고서_최종.pdf').category).toBe('진행결과보고서');
    expect(inferEvidenceCategoryFromFileName('ZOOM invoice March.pdf').category).toBe('ZOOM invoice');
    expect(inferEvidenceCategoryFromFileName('표준재무제표증명_2025.pdf').category).toBe('표준재무제표증명');
  });

  it('infers 표준재무제표증명 from OCR-like text', () => {
    const result = inferEvidenceCategoryFromDocumentText(`
      급 번 호 표준재무제표증명 처 리 기 간
      1025-275-9002-611 개인 법인 즉 시
      상 호 ( 법 인 명 ) 주식회사 스트레스솔루션 사 업 자 등 록 번 호 753-88-02435
      성 명 ( 대 표 자 ) 배익렬 주민(법인)등록번호 160111-*******
      업 태 정보통신업
      종 목 소프트웨어 개발 및 공급업
    `);

    expect(result).toEqual({
      category: '표준재무제표증명',
      confidence: 0.95,
    });
  });

  it('extracts folder ids from drive links or raw values', () => {
    expect(extractDriveFolderId('https://drive.google.com/drive/folders/1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg?usp=share_link'))
      .toBe('1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg');
    expect(extractDriveFolderId('1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg'))
      .toBe('1GD5XnPypL-s6Jp44TJjRRd0nnP0Yu_sg');
    expect(extractDriveFolderId('not-a-drive-link')).toBe('');
  });

  it('builds sync patch and preserves manual completed desc when customized', () => {
    const patch = resolveEvidenceSyncPatch({
      transaction: {
        evidenceRequired: ['세금계산서', '입금확인서', '계약서'],
        evidenceCompletedDesc: '세금계산서, 계약서',
        evidenceCompletedManualDesc: '계약서',
        evidenceAutoListedDesc: '세금계산서',
        evidenceDriveLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
      evidences: [
        { fileName: '세금계산서_3월.pdf', category: '세금계산서' },
        { fileName: '입금확인서_3월.pdf', category: '입금확인서' },
      ],
      folder: {
        webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
    });

    expect(patch.evidenceAutoListedDesc).toBe('세금계산서, 입금확인서');
    expect(patch.evidenceCompletedManualDesc).toBe('계약서');
    expect(patch.evidenceCompletedDesc).toBe('세금계산서, 입금확인서, 계약서');
    expect(patch.evidencePendingDesc).toBeUndefined();
    expect(patch.supportPendingDocs).toBeUndefined();
    expect(patch.evidenceMissing).toEqual([]);
    expect(patch.evidenceStatus).toBe('COMPLETE');
  });

  it('uses auto-listed completed desc when manual field is empty', () => {
    const patch = resolveEvidenceSyncPatch({
      transaction: {
        evidenceRequired: ['세금계산서', '입금확인서'],
        evidenceCompletedDesc: '',
        evidenceAutoListedDesc: '',
        evidenceDriveLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
      evidences: [
        { fileName: '세금계산서_3월.pdf', category: '세금계산서' },
        { fileName: '입금확인서_3월.pdf', category: '입금확인서' },
      ],
      folder: {
        webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
    });

    expect(patch.evidenceCompletedManualDesc).toBeUndefined();
    expect(patch.evidenceCompletedDesc).toBe('세금계산서, 입금확인서');
    expect(patch.evidencePendingDesc).toBeUndefined();
    expect(patch.evidenceMissing).toEqual([]);
    expect(patch.evidenceStatus).toBe('COMPLETE');
  });

  it('matches required evidence against normalized upload categories and filenames', () => {
    const patch = resolveEvidenceSyncPatch({
      transaction: {
        evidenceRequired: ['전자세금계산서', '입금확인증'],
        evidenceCompletedDesc: '',
        evidenceAutoListedDesc: '',
        evidenceDriveLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
      evidences: [
        { fileName: '20260311_운영비_세금계산서_1.pdf', category: '세금계산서' },
        { fileName: '20260311_운영비_입금확인서_1.pdf', category: '입금확인서' },
      ],
      folder: {
        webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
    });

    expect(patch.evidenceCompletedManualDesc).toBeUndefined();
    expect(patch.evidenceCompletedDesc).toBe('세금계산서, 입금확인서');
    expect(patch.evidencePendingDesc).toBeUndefined();
    expect(patch.evidenceMissing).toEqual([]);
    expect(patch.evidenceStatus).toBe('COMPLETE');
  });

  it('keeps a readable filename-derived label when the category is unknown', () => {
    expect(deriveEvidenceLabelFromFileName('20260404_현장확인메일_final.msg')).toBe('현장확인메일');

    const patch = resolveEvidenceSyncPatch({
      transaction: {
        evidenceRequired: ['현장확인메일'],
        evidenceCompletedDesc: '',
        evidenceAutoListedDesc: '',
        evidenceDriveLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
      evidences: [
        { fileName: '20260404_현장확인메일_final.msg', category: '기타', parserCategory: '기타' },
      ],
      folder: {
        webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
    });

    expect(patch.evidenceCompletedDesc).toBe('현장확인메일');
    expect(patch.evidenceStatus).toBe('COMPLETE');
  });

  it('derives legacy manual-only entries from completed desc when auto list already exists', () => {
    const patch = resolveEvidenceSyncPatch({
      transaction: {
        evidenceRequired: ['세금계산서', '입금확인서', '계약서'],
        evidenceCompletedDesc: '세금계산서, 계약서',
        evidenceAutoListedDesc: '세금계산서',
        evidenceDriveLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
      evidences: [
        { fileName: '세금계산서_3월.pdf', category: '세금계산서' },
        { fileName: '입금확인서_3월.pdf', category: '입금확인서' },
      ],
      folder: {
        webViewLink: 'https://drive.google.com/drive/folders/fld-tx',
      },
    });

    expect(patch.evidenceCompletedManualDesc).toBe('계약서');
    expect(patch.evidenceCompletedDesc).toBe('세금계산서, 입금확인서, 계약서');
  });
});
