import { describe, expect, it } from 'vitest';
import {
  buildBusinessCardConfirmPayload,
  canConfirmBusinessCardContact,
  isLowConfidenceField,
  scoreBusinessCardConfidence,
} from './business-card-quality';

describe('business-card-quality', () => {
  it('maps confidence labels to numeric scores', () => {
    expect(scoreBusinessCardConfidence('high')).toBe(0.9);
    expect(scoreBusinessCardConfidence('medium')).toBe(0.65);
    expect(scoreBusinessCardConfidence('low')).toBe(0.35);
  });

  it('flags only filled low-confidence fields', () => {
    expect(isLowConfidenceField({ value: '홍길동', confidence: 'low', evidence: '홍길동' })).toBe(true);
    expect(isLowConfidenceField({ value: '', confidence: 'low', evidence: '' })).toBe(false);
    expect(isLowConfidenceField({ value: 'MYSC', confidence: 'medium', evidence: 'MYSC' })).toBe(false);
  });

  it('requires identity and contact method before confirmation', () => {
    expect(canConfirmBusinessCardContact({ name: '홍길동', organization: '', emails: ['a@example.com'], phones: [] })).toBe(true);
    expect(canConfirmBusinessCardContact({ name: '', organization: 'MYSC', emails: [], phones: ['01012345678'] })).toBe(true);
    expect(canConfirmBusinessCardContact({ name: '', organization: '', emails: ['a@example.com'], phones: [] })).toBe(false);
    expect(canConfirmBusinessCardContact({ name: '홍길동', organization: '', emails: [], phones: [] })).toBe(false);
  });

  it('builds trimmed confirm payloads from form state', () => {
    const payload = buildBusinessCardConfirmPayload({
      name: ' 홍길동 ',
      organization: ' MYSC ',
      department: '',
      title: ' 대표 ',
      role: '',
      emailsText: ' A@EXAMPLE.COM, b@example.com ',
      phonesText: '010-1234-5678\n02-123-4567',
      website: ' https://example.com ',
      address: '',
      memo: ' 메모 ',
    });

    expect(payload).toMatchObject({
      name: '홍길동',
      organization: 'MYSC',
      title: '대표',
      emails: ['a@example.com', 'b@example.com'],
      phones: ['010-1234-5678', '02-123-4567'],
      memo: '메모',
    });
  });
});
