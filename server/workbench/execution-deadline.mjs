import { createHttpError } from '../bff/bff-utils.mjs';

export async function withConversationDeadline(operation, signal) {
  if (signal.aborted) throw createHttpError(504, '요청 시간이 지나 완료하지 못했습니다. 이전 결과와 작성 내용은 유지됩니다.', 'conversation_deadline');
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_resolve, reject) => {
      abort = () => reject(createHttpError(504, '요청 시간이 지나 완료하지 못했습니다. 이전 결과와 작성 내용은 유지됩니다.', 'conversation_deadline'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
