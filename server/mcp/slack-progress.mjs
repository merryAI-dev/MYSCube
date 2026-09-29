const stages = Object.freeze({
  INTERPRET_REQUEST: '요청 내용과 조회 범위를 확인하고 있습니다.',
  READ_PROJECTS: '등록 사업 목록을 조회하고 있습니다.',
  READ_ROOMS: 'Merryhere에서 회의실의 날짜·시간·이용 차단 여부를 확인하고 있습니다.',
  READ_SETTLEMENT: '주정산·월결산 상태를 조회하고 있습니다.',
  READ_ACCOUNTING: '회계 원장 자료를 조회하고 있습니다.',
  COMPARE_PERIODS: '두 기간의 원장 자료를 조회하고 비교하고 있습니다.',
  INSPECT_VARIANCE: '조회된 자료의 항목별 차이를 확인하고 있습니다.',
  PREPARE_ANSWER: '확인된 조회 결과를 정리하고 있습니다.',
});

export async function readProgressJob(db, jobId) {
  let timeout;
  try {
    return (await Promise.race([db.doc(`settlement_agent_jobs/${jobId}`).get(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('progress_lookup_timeout')), 800); }),
    ])).data();
  } finally { clearTimeout(timeout); }
}

export function createSlackProgress({ job, db, send, now = () => Date.now(), intervalMs = 1500 }) {
  let latest;
  let timer;
  let inFlight;
  let closed = false;
  let disabled = !/^\d{1,12}\.\d{1,6}$/.test(job.progressTs || '');
  let lastSentAt = -Infinity;
  let lastStage;
  let sent = 0;
  let deliveryUncertain = false;
  const dispatch = () => {
    timer = undefined;
    if (closed || disabled || inFlight || !latest) return;
    const stage = latest;
    latest = undefined;
    inFlight = (async () => {
      const current = await readProgressJob(db, job.id);
      if (closed || current?.status !== 'running' || current.leaseId !== job.leaseId || current.leaseUntil <= now()) {
        disabled = true;
        return;
      }
      if (sent >= 8) { disabled = true; return; }
      sent++;
      lastSentAt = now();
      lastStage = stage;
      const updatedAt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(now()));
      try { await send({ channel: job.channelId, ts: job.progressTs,
        text: `⏳ ${stages[stage]}\n최근 진행 표시: ${updatedAt} (한국시간)\n표시가 오래 유지되면 처리가 지연되거나 중단됐을 수 있습니다.`,
        blocks: [], parse: 'none', unfurl_links: false, unfurl_media: false });
      } catch (error) { deliveryUncertain = true; throw error; }
    })().catch(() => { disabled = true; }).finally(() => {
      inFlight = undefined;
      if (latest && !closed && !disabled) schedule();
    });
  };
  const schedule = () => {
    if (closed || disabled || timer || inFlight) return;
    const delay = Math.max(0, lastSentAt + intervalMs - now());
    if (delay) timer = setTimeout(dispatch, delay); else dispatch();
  };
  return {
    show(stage) {
      if (closed || disabled || !Object.hasOwn(stages, stage)) return;
      if (stage === lastStage) { latest = undefined; clearTimeout(timer); timer = undefined; return; }
      latest = stage;
      schedule();
    },
    async close() {
      closed = true;
      latest = undefined;
      clearTimeout(timer);
      await inFlight;
      return { canReplaceReceipt: !deliveryUncertain };
    },
  };
}

export const toolProgressStage = Object.freeze({
  project_search: 'READ_PROJECTS', cashflow_status: 'READ_SETTLEMENT', settlement_report: 'READ_SETTLEMENT',
  settlement_status_report: 'READ_PROJECTS', accounting_read: 'READ_ACCOUNTING', accounting_report: 'READ_ACCOUNTING',
  accounting_compare: 'COMPARE_PERIODS', cfo_brief: 'COMPARE_PERIODS', reformat_report: 'PREPARE_ANSWER',
});
