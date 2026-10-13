import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { buildCsv, buildXlsx, readXlsx, XlsxError } from '../src/ema/xlsx.mjs';

const fixture = () => new Uint8Array(readFileSync(new URL('./fixtures/registry-sample.xlsx', import.meta.url)));

describe('xlsx reader', () => {
  it('reads the first sheet of a real Excel file: headers, shared strings, numbers, blank rows', () => {
    const result = readXlsx(fixture());
    expect(result.sheetName).toBe('기업목록');
    expect(result.headers).toEqual(['기업명', '법인명', '창업자', '사업자번호', '섹터', '발굴경로', '이메일', '메모']);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ 기업명: '에코랩', 법인명: '주식회사 에코랩', 사업자번호: '123-45-67890', 이메일: 'eco@x.co' });
    expect(result.rows[1]).toMatchObject({ 기업명: '블루 & 그린', 법인명: '', 사업자번호: '1234567890', 이메일: '', 메모: '줄\n바꿈' });
    expect(result.rows[2]).toMatchObject({ 기업명: '한글기업', 메모: '공백' });
    // 빈 행은 건너뛰고 시트의 원래 행 번호를 알려 준다.
    expect(result.rowNumbers).toEqual([2, 3, 5]);
  });

  it('never evaluates formulas: a formula cell without a stored value reads as empty', () => {
    expect(readXlsx(fixture()).rows[0].메모).toBe('');
  });

  it('rejects files that are not xlsx or are empty, with a readable message', () => {
    expect(() => readXlsx(strToU8('not a zip'))).toThrow(XlsxError);
    expect(() => readXlsx(zipSync({ 'hello.txt': strToU8('x') }))).toThrow(/엑셀/);
    const empty = buildXlsx({ headers: [], rows: [] });
    expect(() => readXlsx(empty)).toThrow(XlsxError);
  });
});

describe('xlsx writer', () => {
  it('round-trips headers and values, keeping numbers, Korean text, entities and long cells', () => {
    const headers = ['FRN', '기업명', '완성도', '메모'];
    const rows = [
      ['AIR-KR-26-001', '에코랩 <주> & "그린"', 80, '한 줄\n두 줄'],
      ['AIR-KR-26-002', '', 0, '='],
      ['INF-KR-26-003', '긴 값', 100, 'x'.repeat(5000)],
    ];
    const bytes = buildXlsx({ sheetName: '기업:목록/1', headers, rows });
    const result = readXlsx(bytes);
    expect(result.sheetName).toBe('기업 목록 1');
    expect(result.headers).toEqual(headers);
    expect(result.rows[0]).toEqual({ FRN: 'AIR-KR-26-001', 기업명: '에코랩 <주> & "그린"', 완성도: '80', 메모: '한 줄\n두 줄' });
    expect(result.rows[1]).toEqual({ FRN: 'AIR-KR-26-002', 기업명: '', 완성도: '0', 메모: '=' });
    expect(result.rows[2].메모).toHaveLength(5000);
    expect(bytes[0]).toBe(0x50); // PK
  });

  it('strips characters that are illegal in XML instead of producing a broken file', () => {
    const bytes = buildXlsx({ headers: ['값'], rows: [['a\u0000b\u000Bc']] });
    expect(readXlsx(bytes).rows[0].값).toBe('abc');
  });

  it('writes an empty list as a valid file with only the header', () => {
    const result = readXlsx(buildXlsx({ headers: ['FRN', '기업명'], rows: [] }));
    expect(result.rows).toEqual([]);
    expect(result.headers).toEqual(['FRN', '기업명']);
  });
});

describe('csv writer', () => {
  it('adds a BOM for Excel, quotes special cells and neutralizes formulas', () => {
    const csv = buildCsv({ headers: ['이름', '메모'], rows: [['A, B', '"인용"'], ['=SUM(A1)', '+82 10'], ['x', 12]] });
    expect(csv.startsWith('﻿이름,메모\r\n')).toBe(true);
    expect(csv).toContain('"A, B","""인용"""');
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'+82 10");
    expect(csv).toContain('x,12');
  });
});
