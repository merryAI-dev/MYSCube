import { randomUUID } from 'node:crypto';
export const domNodeId = (char) => `n_${char.repeat(24)}`;
export function domFrame(sessionId = randomUUID(), sourceHash = 'a'.repeat(64), revision = 1) {
  return { kind: 'dom', sessionId, sourceHash, documentEpoch: '11111111-1111-4111-8111-111111111111', sequence: revision, width: 1280, height: 720,
    snapshot: { schemaVersion: 1, revision, rootNodeId: domNodeId('a'), focusedNodeId: null, ack: null, nodes: [
      { id: domNodeId('a'), parentId: null, kind: 'element', tag: 'main', attributes: { id: domNodeId('a') }, style: {} },
      { id: domNodeId('b'), parentId: domNodeId('a'), kind: 'element', tag: 'button', attributes: { id: domNodeId('b'), type: 'button' }, style: {} },
      { id: domNodeId('c'), parentId: domNodeId('a'), kind: 'element', tag: 'input', attributes: { id: domNodeId('c') }, style: {}, control: { type: 'text', value: '', checked: false, selectedValues: [], disabled: false, readOnly: false, selectionStart: 0, selectionEnd: 0 } },
    ] } };
}
export function domEvent(frame, extra = {}) { return { sessionId: frame.sessionId, sourceHash: frame.sourceHash, documentEpoch: frame.documentEpoch, eventId: randomUUID(), nodeId: domNodeId('b'), baseRevision: frame.snapshot.revision, type: 'click', ...extra }; }
