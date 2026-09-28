import * as parse5 from 'parse5';
import { validateHtmlSource } from '../../shared/workbench-html.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const element = (tagName, children = [], attrs = []) => ({ nodeName: tagName, tagName, namespaceURI: 'http://www.w3.org/1999/xhtml', attrs, childNodes: children });
const text = (value) => ({ nodeName: '#text', value: value === null || value === undefined ? '자료 없음' : String(value) });
const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const removeAttr = (node, name) => { node.attrs = (node.attrs || []).filter((item) => item.name !== name); };
const valueText = (value) => value === null || value === undefined ? '자료 없음' : String(value);

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function tableNodes(evidence) {
  const headers = evidence.columns.map((column) => element('th', [text(column.label || column.name)]));
  const rows = evidence.rows.length ? evidence.rows.map((row) => {
    const record = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    return element('tr', evidence.columns.map((column, index) => element('td', [text(Array.isArray(row) ? row[index] : record[column.name])])));
  }) : [element('tr', [element('td', [text('조회 결과가 없습니다.')], [{ name: 'colspan', value: String(Math.max(1, evidence.columns.length)) }])])];
  return [element('table', [element('thead', [element('tr', headers)]), element('tbody', rows)])];
}

function provenanceNodes(metadata) {
  const labels = { provenance: '출처', asOf: '기준 시각', capturedAt: '수집 시각', completeness: '완전성', definition: '계산 기준', resultScope: '표시 범위', limitations: '자료 해석 안내' };
  const items = Object.entries(labels).filter(([key]) => Object.hasOwn(metadata, key)).map(([key, label]) => `${label}: ${valueText(metadata[key])}`);
  return items.length ? [element('p', [text(items.join(' · '))])] : [];
}

function validateEvidenceList(evidenceList) {
  if (!Array.isArray(evidenceList) || evidenceList.length > 64) throw new Error('binding_evidence_invalid');
  const map = new Map();
  for (const evidence of evidenceList) {
    if (!evidence || typeof evidence !== 'object' || !ID.test(evidence.evidenceId || '') || map.has(evidence.evidenceId)
      || !Array.isArray(evidence.columns) || !Array.isArray(evidence.rows) || evidence.columns.length > 64 || evidence.rows.length > 1000) throw new Error('binding_evidence_invalid');
    const names = new Set();
    for (const column of evidence.columns) {
      if (!column || typeof column.name !== 'string' || !column.name || column.name.length > 120 || names.has(column.name)
        || (column.label !== undefined && typeof column.label !== 'string') || (column.type !== undefined && typeof column.type !== 'string')) throw new Error('binding_evidence_invalid');
      names.add(column.name);
    }
    if (evidence.metadata !== undefined && (!evidence.metadata || typeof evidence.metadata !== 'object' || Array.isArray(evidence.metadata))) throw new Error('binding_evidence_invalid');
    map.set(evidence.evidenceId, { ...evidence, metadata: evidence.metadata || {} });
  }
  return map;
}

function validateBindings(bindings, evidence) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).length > 64) throw new Error('binding_definition_invalid');
  for (const [id, binding] of Object.entries(bindings)) {
    if (!ID.test(id) || !binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('binding_definition_invalid');
    const keys = Object.keys(binding).sort().join('|');
    if (binding.kind === 'table') {
      if (keys !== 'evidenceId|kind' || !evidence.has(binding.evidenceId)) throw new Error('binding_definition_invalid');
    } else if (binding.kind === 'value') {
      if (keys !== 'column|evidenceId|kind|row' || !evidence.has(binding.evidenceId) || !Number.isInteger(binding.row) || binding.row < 0
        || binding.row >= evidence.get(binding.evidenceId).rows.length || !evidence.get(binding.evidenceId).columns.some((column) => column.name === binding.column)) throw new Error('binding_definition_invalid');
    } else throw new Error('binding_definition_invalid');
  }
  return bindings;
}

export function resolveHtmlBindings({ title, html, bindings }, evidenceList) {
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || typeof html !== 'string' || html.length > 200_000) throw new Error('binding_template_invalid');
  const evidence = validateEvidenceList(evidenceList);
  const definitions = validateBindings(bindings, evidence);
  let document; let parseError = false;
  try { document = parse5.parse(html, { onParseError: () => { parseError = true; } }); } catch { throw new Error('binding_template_invalid'); }
  if (parseError) throw new Error('binding_template_invalid');
  const usedEvidence = new Set(); const tableEvidence = new Set(); const usedBindings = new Set(); let invalid = false;
  walk(document, (node) => {
    if (!node.tagName) return;
    const evidenceId = attr(node, 'data-evidence'); const bindingId = attr(node, 'data-binding');
    if (evidenceId && bindingId) { invalid = true; return; }
    if (evidenceId !== undefined) {
      const item = evidence.get(evidenceId); if (node.tagName !== 'section' || !item) { invalid = true; return; }
      removeAttr(node, 'data-evidence'); node.childNodes = [...provenanceNodes(item.metadata), ...tableNodes(item)]; usedEvidence.add(evidenceId);
      tableEvidence.add(evidenceId);
    }
    if (bindingId !== undefined) {
      const binding = definitions[bindingId]; if (!binding || usedBindings.has(bindingId)) { invalid = true; return; }
      const item = evidence.get(binding.evidenceId); removeAttr(node, 'data-binding');
      node.childNodes = binding.kind === 'table' ? [...provenanceNodes(item.metadata), ...tableNodes(item)] : [text((Array.isArray(item.rows[binding.row]) ? item.rows[binding.row][item.columns.findIndex((column) => column.name === binding.column)] : item.rows[binding.row]?.[binding.column]))];
      usedBindings.add(bindingId); usedEvidence.add(binding.evidenceId);
      if (binding.kind === 'table') tableEvidence.add(binding.evidenceId);
    }
  });
  if (invalid || usedBindings.size !== Object.keys(definitions).length) throw new Error('binding_marker_invalid');
  for (const id of usedEvidence) {
    if (Object.values(evidence.get(id).semantic?.definitionVersions || {}).some((value) => value.id === 'cashflow_inflow') && !tableEvidence.has(id)) throw new Error('binding_coverage_required');
  }
  const resolved = parse5.serialize(document);
  const validation = validateHtmlSource({ title, html: resolved });
  if (!validation.ok) throw new Error('binding_resolved_html_invalid');
  return { source: { title, html: resolved }, template: { title, html }, bindings: definitions, evidenceIds: [...usedEvidence].sort() };
}
