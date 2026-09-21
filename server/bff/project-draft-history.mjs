import { createHash } from 'node:crypto';
import { createHttpError } from './bff-utils.mjs';

function revision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function projectDraftHistoryCollectionPath(draftPath, draft) {
  // 수정 초안은 같은 문서에서 새 작성 회차가 시작되면 리비전이 0으로 돌아간다.
  const generation = createHash('sha256').update(JSON.stringify([
    draft.ownerUid || draft.ownerId || '', draft.historyGeneration || draft.createdAt || '',
  ])).digest('hex').slice(0, 32);
  return `${draftPath}/history/${generation}/revisions`;
}

export function projectDraftHistoryItem(draft) {
  return {
    draftRevision: revision(draft.draftRevision),
    payload: draft.payload && typeof draft.payload === 'object' ? draft.payload : {},
    attachmentRefs: Array.isArray(draft.attachmentRefs) ? draft.attachmentRefs : [],
    savedById: typeof draft.savedById === 'string' ? draft.savedById : null,
    savedByName: typeof draft.savedByName === 'string' ? draft.savedByName : null,
    savedAt: typeof draft.savedAt === 'string' ? draft.savedAt : null,
    stepIndex: Number.isInteger(draft.stepIndex) ? draft.stepIndex : 0,
    updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : '',
  };
}

export async function prepareProjectDraftHistorySave({ db, tx, draftRef, before, after, actor }) {
  const collection = projectDraftHistoryCollectionPath(draftRef.path, before);
  const oldRef = db.doc(`${collection}/${revision(before.draftRevision)}`);
  const newRef = db.doc(`${collection}/${revision(after.draftRevision)}`);
  const [oldSnapshot, newSnapshot] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);
  if (revision(after.draftRevision) <= revision(before.draftRevision) || newSnapshot.exists) {
    throw createHttpError(409, '임시저장 버전이 변경되었습니다. 현재 저장 내용을 다시 불러온 뒤 저장해 주세요.', 'draft_version_conflict');
  }
  return () => {
    if (!oldSnapshot.exists) tx.create(oldRef, projectDraftHistoryItem(before));
    tx.create(newRef, projectDraftHistoryItem({ ...after, savedById: actor?.actorId || null, savedByName: actor?.actorHistoryDisplayName || null, savedAt: actor ? after.updatedAt : null }));
  };
}

export async function readProjectDraftHistory({ db, draftRef, draft, beforeRevision }) {
  if (beforeRevision !== undefined && (!Number.isSafeInteger(Number(beforeRevision)) || Number(beforeRevision) < 0)) throw createHttpError(400, '이력 페이지 값이 올바르지 않습니다.', 'draft_request_invalid');
  const path = projectDraftHistoryCollectionPath(draftRef.path, draft);
  let latestQuery = db.collection(path).orderBy('draftRevision', 'desc');
  if (beforeRevision !== undefined) latestQuery = latestQuery.startAfter(Number(beforeRevision));
  const [latest, earliest] = await Promise.all([
    latestQuery.limit(21).get(),
    db.collection(path).orderBy('draftRevision', 'asc').limit(1).get(),
  ]);
  const items = latest.docs.slice(0, 20).map((document) => projectDraftHistoryItem(document.data()));
  return {
    items: items.length ? items : beforeRevision !== undefined ? [] : [projectDraftHistoryItem(draft)],
    historyGeneration: path.split('/').at(-2),
    hasMore: latest.docs.length > 20,
    nextBeforeRevision: latest.docs.length > 20 ? items.at(-1).draftRevision : null,
    historyAvailableFromRevision: earliest.docs.length
      ? revision(earliest.docs[0].data()?.draftRevision)
      : revision(draft.draftRevision),
  };
}

export async function readProjectDraftRestoreSource({ db, tx, draftRef, draft, historyGeneration, sourceRevision }) {
  const path = projectDraftHistoryCollectionPath(draftRef.path, draft);
  if (historyGeneration !== path.split('/').at(-2)) throw createHttpError(409, '다른 작성 회차의 이력입니다. 현재 임시저장을 다시 열어 주세요.', 'draft_history_generation_conflict');
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) throw createHttpError(400, '복원할 버전이 올바르지 않습니다.', 'draft_request_invalid');
  const snapshot = await tx.get(db.doc(`${path}/${sourceRevision}`));
  if (!snapshot.exists) throw createHttpError(404, '저장된 버전 이력을 찾을 수 없습니다.', 'draft_history_not_found');
  return projectDraftHistoryItem(snapshot.data());
}

export async function assertProjectDraftRestoreAttachments({ source, fieldByKind, inspect }) {
  const refs = [...source.attachmentRefs];
  for (const [documentKind, field] of Object.entries(fieldByKind)) {
    const document = source.payload?.[field];
    if (document?.path) refs.push({ ...document, documentKind, inheritedFromProjectRequest: source.attachmentRefs.some(ref => ref.path === document.path && ref.documentKind === documentKind && ref.inheritedFromProjectRequest === true) });
  }
  try {
    for (const ref of refs) {
      if (!fieldByKind[ref.documentKind] || !ref.path) throw new Error('invalid attachment');
      const stored = await inspect(ref);
      if (stored.path !== ref.path || Number(stored.size) !== Number(ref.size) || stored.contentType !== ref.contentType || (ref.attachmentId && stored.attachmentId !== ref.attachmentId)) throw new Error('attachment metadata changed');
    }
  } catch {
    throw createHttpError(422, '이 버전의 첨부파일이 삭제되었거나 접근할 수 없어 복원하지 않았습니다. 현재 임시저장은 그대로 유지됩니다. 필요한 파일을 다시 첨부해 주세요.', 'draft_history_attachment_unavailable');
  }
}
