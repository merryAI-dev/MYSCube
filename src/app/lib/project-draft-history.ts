export interface ProjectDraftHistoryItem {
  draftRevision: number;
  payload: Record<string, unknown>;
  attachmentRefs: Array<{ documentKind: string; name: string; size?: number }>;
  updatedAt?: string;
  updatedBy?: string;
  savedById?: string | null;
  savedByName?: string | null;
  savedAt?: string | null;
}

export interface ProjectDraftHistory {
  items: ProjectDraftHistoryItem[];
  historyAvailableFromRevision: number | null;
  historyGeneration?: string;
  hasMore?: boolean;
  nextBeforeRevision?: number | null;
}

export function parseProjectDraftHistory(value: unknown): ProjectDraftHistory {
  const data = value as Partial<ProjectDraftHistory> | null;
  if (!data || !Array.isArray(data.items) || data.items.some((item) => (
    !item || typeof item !== 'object' || !Number.isSafeInteger(item.draftRevision) || item.draftRevision < 0
    || !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)
    || !Array.isArray(item.attachmentRefs)
    || item.attachmentRefs.some((file) => !file || typeof file.name !== 'string' || typeof file.documentKind !== 'string')
  ))) throw new Error('임시저장 이력의 형식을 확인할 수 없습니다. 다시 조회해 주세요.');
  return {
    items: data.items,
    ...(typeof data.historyGeneration === 'string' ? { historyGeneration: data.historyGeneration } : {}),
    ...(typeof data.hasMore === 'boolean' ? { hasMore: data.hasMore } : {}),
    ...(Number.isSafeInteger(data.nextBeforeRevision) || data.nextBeforeRevision === null ? { nextBeforeRevision: data.nextBeforeRevision } : {}),
    historyAvailableFromRevision: Number.isSafeInteger(data.historyAvailableFromRevision)
      ? data.historyAvailableFromRevision! : null,
  };
}
