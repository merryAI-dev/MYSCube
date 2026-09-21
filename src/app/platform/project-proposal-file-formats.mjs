export const PROJECT_PROPOSAL_FILE_FORMATS = Object.freeze([
  { extension: '.pdf', mimeType: 'application/pdf', signature: 'pdf' },
  { extension: '.doc', mimeType: 'application/msword', signature: 'ole' },
  { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: 'zip' },
  { extension: '.hwp', mimeType: 'application/x-hwp', signature: 'hwp', aliases: ['application/haansofthwp', 'application/vnd.hancom.hwp'] },
  { extension: '.hwpx', mimeType: 'application/vnd.hancom.hwpx', signature: 'zip', aliases: ['application/hwp+zip'] },
  { extension: '.ppt', mimeType: 'application/vnd.ms-powerpoint', signature: 'ole' },
  { extension: '.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: 'zip' },
  { extension: '.xls', mimeType: 'application/vnd.ms-excel', signature: 'ole' },
  { extension: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: 'zip' },
].map(format => Object.freeze(format)));

export function projectProposalFileFormat(fileName) {
  const name = String(fileName || '').trim().toLowerCase();
  return PROJECT_PROPOSAL_FILE_FORMATS.find(format => name.endsWith(format.extension)) || null;
}

export const PROJECT_PROPOSAL_FILE_ACCEPT = PROJECT_PROPOSAL_FILE_FORMATS
  .flatMap(format => [format.extension, format.mimeType, ...(format.aliases || [])]).join(',');

export const PROJECT_PROPOSAL_FILE_FORMAT_LABEL = 'PDF, DOC/DOCX, HWP/HWPX, PPT/PPTX, XLS/XLSX';
