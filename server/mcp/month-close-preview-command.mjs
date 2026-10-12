import { assertMonthCloseRequest, validCalendarDate } from './month-close-reminders.mjs';

const prefix = /^\s*(?:<@[A-Z0-9]+>\s*)?월결산\s+리마인드\s+미리보기(?:\s|$)/;
const chatGptProvenanceSuffix = /\n\s*\*다음을 사용하여 보냄\*\s+<@U0BHJEU5REW\|ChatGPT>\s*$/;

function stripObservedChatGptProvenance(value) {
  return value.replace(chatGptProvenanceSuffix, '').trim();
}

export function isMonthClosePreviewCommand(value) {
  return prefix.test(typeof value === 'string' ? value.trim() : '');
}

export function parseMonthClosePreviewCommand(value) {
  const source = stripObservedChatGptProvenance(typeof value === 'string' ? value.trim() : '');
  if (!isMonthClosePreviewCommand(source)) return null;
  const match = source.match(/^\s*(?:<@[A-Z0-9]+>\s*)?월결산\s+리마인드\s+미리보기\s+(20\d{2}-(?:0[1-9]|1[0-2]))\s+제출\s+(20\d{2}-\d{2}-\d{2})\s+([01]\d|2[0-3]):([0-5]\d)\s+승인\s+(20\d{2}-\d{2}-\d{2})\s+([01]\d|2[0-3]):([0-5]\d)\s*$/);
  if (!match) return { error: 'month_close_preview_usage' };
  if (!validCalendarDate(match[2]) || !validCalendarDate(match[5])) return { error: 'month_close_preview_usage' };
  try {
    return { input: assertMonthCloseRequest({ yearMonth: match[1], submissionDeadlineAt: `${match[2]}T${match[3]}:${match[4]}:00+09:00`,
      approvalDeadlineAt: `${match[5]}T${match[6]}:${match[7]}:00+09:00` }) };
  } catch { return { error: 'month_close_preview_usage' }; }
}
