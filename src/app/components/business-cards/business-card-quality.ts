import type {
  BusinessCardConfirmPayload,
  BusinessCardConfidence,
  BusinessCardExtraction,
  BusinessCardExtractedField,
} from '../../lib/platform-bff-client';

export function scoreBusinessCardConfidence(value: BusinessCardConfidence | undefined): number {
  if (value === 'high') return 0.9;
  if (value === 'medium') return 0.65;
  if (value === 'low') return 0.35;
  return 0;
}

export function isLowConfidenceField(field: BusinessCardExtractedField | undefined): boolean {
  if (!field?.value) return false;
  return scoreBusinessCardConfidence(field.confidence) < 0.6;
}

function splitListInput(value: string): string[] {
  return String(value || '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function buildBusinessCardConfirmPayload(input: {
  name: string;
  organization: string;
  department: string;
  title: string;
  role: string;
  emailsText: string;
  phonesText: string;
  website: string;
  address: string;
  memo: string;
}): BusinessCardConfirmPayload {
  return {
    name: input.name.trim(),
    organization: input.organization.trim(),
    department: input.department.trim(),
    title: input.title.trim(),
    role: input.role.trim(),
    emails: splitListInput(input.emailsText).map((item) => item.toLowerCase()),
    phones: splitListInput(input.phonesText),
    website: input.website.trim(),
    address: input.address.trim(),
    memo: input.memo.trim(),
  };
}

export function canConfirmBusinessCardContact(payload: Pick<BusinessCardConfirmPayload, 'name' | 'organization' | 'emails' | 'phones'>): boolean {
  const hasIdentity = Boolean(payload.name.trim() || payload.organization.trim());
  const hasContact = payload.emails.length > 0 || payload.phones.length > 0;
  return hasIdentity && hasContact;
}

export function formStateFromBusinessCardExtraction(extraction: BusinessCardExtraction) {
  return {
    name: extraction.name.value,
    organization: extraction.organization.value,
    department: extraction.department.value,
    title: extraction.title.value,
    role: extraction.role.value,
    emailsText: extraction.emails.map((item) => item.value).join(', '),
    phonesText: extraction.phones.map((item) => item.value).join(', '),
    website: extraction.website.value,
    address: extraction.address.value,
    memo: extraction.memo.value,
  };
}
