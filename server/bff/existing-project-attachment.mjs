function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isLegacyProjectAttachmentPath(path, tenantId) {
  const parts = text(path).split('/');
  return /^[A-Za-z0-9._-]+$/.test(text(tenantId))
    && !['.', '..'].includes(tenantId)
    && parts.length === 5
    && parts[0] === 'orgs' && parts[1] === tenantId
    && ['project-request-contracts', 'project-request-documents'].includes(parts[2])
    && /^[A-Za-z0-9._-]+$/.test(parts[3]) && !['.', '..'].includes(parts[3])
    && /^[\w.\-가-힣()]+$/.test(parts[4]) && !['.', '..'].includes(parts[4]);
}

// existingAttachment must come from the current server project, in the same document field.
export function assertExistingProjectAttachment({ tenantId, projectId, path, attachment, existingAttachment }) {
  if (!/^[A-Za-z0-9._-]+$/.test(text(projectId)) || ['.', '..'].includes(projectId)
    || !isLegacyProjectAttachmentPath(path, tenantId)
    || text(path) !== text(attachment?.path)
    || text(path) !== text(existingAttachment?.path)
    || !Number.isSafeInteger(attachment?.size) || attachment.size < 1
    || attachment.size !== existingAttachment?.size
    || !text(attachment?.contentType)
    || text(attachment.contentType) !== text(existingAttachment?.contentType)
    || text(attachment.attachmentId) !== text(existingAttachment?.attachmentId)) {
    throw new Error('Existing project attachment does not match the current project document');
  }
  return text(path);
}

export function assertExistingProjectAttachmentMetadata(attachment, metadata) {
  if (Number(metadata?.size) !== attachment.size
    || text(metadata?.contentType) !== text(attachment.contentType)
    || text(metadata?.metadata?.attachmentId) !== text(attachment.attachmentId)) {
    throw new Error('Existing project attachment metadata does not match');
  }
}
