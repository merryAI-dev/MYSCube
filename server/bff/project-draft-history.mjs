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
    updatedAt: typeof draft.updatedAt === 'string' ? draft.updatedAt : '',
  };
}

export async function prepareProjectDraftHistorySave({ db, tx, draftRef, before, after }) {
  const collection = projectDraftHistoryCollectionPath(draftRef.path, before);
  const oldRef = db.doc(`${collection}/${revision(before.draftRevision)}`);
  const newRef = db.doc(`${collection}/${revision(after.draftRevision)}`);
  const [oldSnapshot, newSnapshot] = await Promise.all([tx.get(oldRef), tx.get(newRef)]);
  if (revision(after.draftRevision) <= revision(before.draftRevision) || newSnapshot.exists) {
    throw createHttpError(409, '임시저장 버전이 변경되었습니다. 현재 저장 내용을 다시 불러온 뒤 저장해 주세요.', 'draft_version_conflict');
  }
  return () => {
    if (!oldSnapshot.exists) tx.create(oldRef, projectDraftHistoryItem(before));
    tx.create(newRef, projectDraftHistoryItem(after));
  };
}

export async function readProjectDraftHistory({ db, draftRef, draft }) {
  const path = projectDraftHistoryCollectionPath(draftRef.path, draft);
  const [latest, earliest] = await Promise.all([
    db.collection(path).orderBy('draftRevision', 'desc').limit(20).get(),
    db.collection(path).orderBy('draftRevision', 'asc').limit(1).get(),
  ]);
  const items = latest.docs.map((document) => projectDraftHistoryItem(document.data()));
  return {
    items: items.length ? items : [projectDraftHistoryItem(draft)],
    historyAvailableFromRevision: earliest.docs.length
      ? revision(earliest.docs[0].data()?.draftRevision)
      : revision(draft.draftRevision),
  };
}
