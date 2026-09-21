export interface ProjectProposalFileFormat {
  extension: string;
  mimeType: string;
  signature: 'pdf' | 'zip' | 'ole' | 'hwp';
  aliases?: readonly string[];
}
export const PROJECT_PROPOSAL_FILE_FORMATS: readonly ProjectProposalFileFormat[];
export const PROJECT_PROPOSAL_FILE_ACCEPT: string;
export function projectProposalFileFormat(fileName: unknown): ProjectProposalFileFormat | null;

export const PROJECT_PROPOSAL_FILE_FORMAT_LABEL: string;
