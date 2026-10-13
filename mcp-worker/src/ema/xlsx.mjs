import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

// 엑셀(.xlsx) 읽기·쓰기. Workers 에서 쓸 수 있게 DOM 없이 정규식으로 OOXML 을 다룬다.
// 읽기는 첫 시트의 값만 문자열로 가져오고(서식·수식 결과 값), 쓰기는 머리글 + 값만 만든다.

const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu;

export class XlsxError extends Error {}

function decodeXml(value) {
  return value
    .replace(/_x([0-9A-Fa-f]{4})_/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu, (match, entity) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

function escapeXml(value) {
  return String(value).replace(INVALID_XML_CHARS, '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(tag);
  return match ? decodeXml(match[1]) : '';
}

function textOf(fragment) {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/gu, '');
  const parts = [];
  for (const match of withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/gu)) parts.push(match[1] ?? '');
  return decodeXml(parts.join(''));
}

function columnIndex(reference) {
  const letters = /^[A-Z]+/u.exec(reference.toUpperCase())?.[0] ?? '';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function columnLetters(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function resolveTarget(target) {
  const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts = [];
  for (const part of normalized.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/**
 * 첫 번째 시트를 읽어 머리글 → 값 객체 배열로 돌려준다. 완전히 빈 행은 건너뛴다.
 * @returns {{ sheetName, headers, rows, rowNumbers }} rowNumbers[i] 는 rows[i] 의 시트 행 번호(1부터)
 */
export function readXlsx(bytes) {
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (file.originalSize > MAX_UNCOMPRESSED_BYTES) throw new XlsxError('파일이 너무 큽니다.');
        return /^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/u.test(file.name);
      },
    });
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError('엑셀(.xlsx) 파일이 아니거나 손상되었습니다.');
  }
  const read = (name) => (files[name] ? strFromU8(files[name]) : null);
  const workbook = read('xl/workbook.xml');
  const relationships = read('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) throw new XlsxError('엑셀(.xlsx) 파일이 아니거나 손상되었습니다.');

  const firstSheet = /<sheet\b[^>]*>/u.exec(workbook)?.[0];
  if (!firstSheet) throw new XlsxError('시트를 찾을 수 없습니다.');
  const sheetName = attribute(firstSheet, 'name');
  const relationshipId = attribute(firstSheet, 'r:id') || attribute(firstSheet, 'id');
  let sheetPath = '';
  for (const tag of relationships.match(/<Relationship\b[^>]*>/gu) ?? []) {
    if (attribute(tag, 'Id') === relationshipId) sheetPath = resolveTarget(attribute(tag, 'Target'));
  }
  const sheetXml = sheetPath ? read(sheetPath) : null;
  if (!sheetXml) throw new XlsxError('첫 번째 시트를 읽을 수 없습니다.');

  const shared = [];
  const sharedXml = read('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/gu)) shared.push(textOf(match[1] ?? ''));
  }

  const sheetRows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r')) || sheetRows.length + 1;
    const cells = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const reference = attribute(cellMatch[1], 'r');
      const type = attribute(cellMatch[1], 't');
      const body = cellMatch[2] ?? '';
      let value = '';
      if (type === 'inlineStr') value = textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/u.exec(body)?.[1] ?? '');
      else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(body)?.[1];
        if (raw !== undefined) {
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') value = '';
          else value = decodeXml(raw);
        }
      }
      const position = reference ? columnIndex(reference) : cells.length;
      if (position >= 0) cells[position] = value.trim();
    }
    if (cells.some((cell) => cell)) sheetRows.push({ rowNumber, cells });
  }
  if (sheetRows.length === 0) throw new XlsxError('시트가 비어 있습니다.');

  const [headerRow, ...dataRows] = sheetRows;
  const headers = [];
  headerRow.cells.forEach((cell, position) => {
    if (cell && !headers.some((entry) => entry.name === cell)) headers.push({ name: cell, position });
  });
  if (headers.length === 0) throw new XlsxError('머리글(첫 행)이 비어 있습니다.');
  const rows = dataRows.map(({ cells }) => Object.fromEntries(headers.map(({ name, position }) => [name, cells[position] ?? ''])));
  return { sheetName, headers: headers.map((entry) => entry.name), rows, rowNumbers: dataRows.map((row) => row.rowNumber) };
}

function displayWidth(value) {
  let width = 0;
  for (const char of String(value)) width += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

/** 머리글 + 값만 가진 .xlsx 를 만든다. 문자열은 항상 문자열 셀이라 수식으로 해석되지 않는다. */
export function buildXlsx({ sheetName = 'Sheet1', headers, rows }) {
  const safeSheetName = String(sheetName).replace(/[[\]:*?/\\]/gu, ' ').trim().slice(0, 31) || 'Sheet1';
  const lastColumn = columnLetters(Math.max(headers.length, 1) - 1);
  const lastRow = rows.length + 1;

  const cell = (reference, value, style = 0) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  };

  const widths = headers.map((header, column) => {
    const longest = rows.reduce((max, row) => Math.max(max, displayWidth(row[column] ?? '')), displayWidth(header));
    return Math.min(Math.max(longest + 2, 8), 60);
  });
  const sheetRows = [
    `<row r="1">${headers.map((header, column) => cell(`${columnLetters(column)}1`, header, 1)).join('')}</row>`,
    ...rows.map((row, index) => `<row r="${index + 2}">${headers.map((_, column) => cell(`${columnLetters(column)}${index + 2}`, row[column])).join('')}</row>`),
  ];

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows.join('')}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`;

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])));
}

/** UTF-8 BOM 이 붙은 CSV. 수식으로 읽힐 수 있는 문자열은 앞에 작은따옴표를 붙인다. */
export function buildCsv({ headers, rows }) {
  const quote = (value) => {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (typeof value === 'string' && /^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
  };
  return `﻿${[headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`;
}
