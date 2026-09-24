import type * as z from 'zod/v4';
import { RemoteDomFrameSchema, RemoteDomEventSchema, RemoteDomControlSchema, RemoteDomFallbackFrameSchema } from '../shared/workbench-remote-dom.mjs';
export type DomFallbackFrame = z.infer<typeof RemoteDomFallbackFrameSchema>;
export type DomFrame = z.infer<typeof RemoteDomFrameSchema>;
export type DomEvent = z.infer<typeof RemoteDomEventSchema>;
export type DomControl = z.infer<typeof RemoteDomControlSchema>;
type NodeEvent = Exclude<DomEvent, { type: 'resize' }>;
export type DomAction = NodeEvent extends infer E ? E extends NodeEvent ? Omit<E, 'sessionId' | 'sourceHash' | 'documentEpoch' | 'baseRevision' | 'eventId'> : never : never;
export type InputDraft = { revision: number; eventId: string; composing: boolean; control: DomControl };
export const domIdentity = (frame: DomFrame) => `${frame.sessionId}:${frame.sourceHash}:${frame.documentEpoch}`;
export function settleDrafts(drafts: Map<string, InputDraft>, frame: DomFrame) {
  const ack = frame.snapshot.ack;
  const nodes = new Set(frame.snapshot.nodes.map(node => node.id));
  for (const [id, draft] of drafts) {
    if (!nodes.has(id) || !draft.composing && ack?.eventId === draft.eventId && ack.inputRevision === draft.revision) drafts.delete(id);
  }
}
export function bindDomAction(frame: DomFrame, action: DomAction, eventId: string): DomEvent {
  return RemoteDomEventSchema.parse({ ...action, eventId, sessionId: frame.sessionId, sourceHash: frame.sourceHash, documentEpoch: frame.documentEpoch, baseRevision: frame.snapshot.revision });
}
