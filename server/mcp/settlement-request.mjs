const financialTools = new Set(['accounting_read', 'accounting_report', 'accounting_compare', 'cfo_brief']);

export function resolveSettlementRequest(question, now = new Date()) {
  const text = question.replace(/<@[A-Z0-9]+>|\[(?:hermes|baseline)\]/gi, '').trim();
  const current = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 7);
  const bareCfo = /^(?:CFO|씨에프오)\s*브리핑\s*(?:해\s*줘|해주세요|해|부탁해|부탁합니다)?[.!?\s]*$/i.test(text);
  const weekly = /주\s*정산/.test(text);
  const monthly = /월\s*결산|월\s*정산/.test(text);
  const financial = /금액|입금|출금|잔액|실적|계획|원장|P\s*\/\s*A|차액|비교/i.test(text);
  if (/아니고|말고/.test(text) && !/금액\s*말고/.test(text)) return null;
  const statusOnly = (weekly || monthly) && (!financial || /(?:여부|상태)\s*만|금액\s*(?:말고|제외)/.test(text));
  if (!bareCfo && !statusOnly) return null;
  const kind = bareCfo || (weekly && monthly) ? 'both' : weekly ? 'week' : 'month';
  const periods = [...text.matchAll(/(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월|(20\d{2})-(\d{2})/g)];
  let yearMonth = null;
  let defaultedYear = false;
  if (periods.length === 1) {
    const [, year, month, isoYear, isoMonth] = periods[0];
    const m = Number(month || isoMonth);
    if (m >= 1 && m <= 12) {
      yearMonth = `${year || isoYear || current.slice(0, 4)}-${String(m).padStart(2, '0')}`;
      defaultedYear = !year && !isoYear;
    }
  } else if (!periods.length && (bareCfo || /이번\s*달|이번\s*월/.test(text))) yearMonth = current;
  const weeks = [...text.matchAll(/(\d+)\s*주차/g)];
  const weekNo = weeks.length === 1 && Number(weeks[0][1]) >= 1 && Number(weeks[0][1]) <= 5 ? Number(weeks[0][1]) : undefined;
  const allProjects = bareCfo || /전체\s*(?:등록\s*(?:된\s*)?)?사업|전사/.test(text);
  const ambiguous = /제외|빼고|중에서|담당|CIC|센터|팀|작년|내년|지난해|다음해|지난\s*주|이번\s*주|마감|기한|까지|미완료|미승인|승인\s*완료|완료된|대기\s*(?:중|인)|[~～–—]|\d\s*-\s*\d(?!\d)/i.test(text)
    || (kind === 'both' && !bareCfo) || weeks.length > 1 || (weeks.length === 1 && !weekNo);
  const directSyntax = /^(?:(?:어\s*)?미안[,.]?\s*)?(?:전체\s*(?:등록\s*(?:된\s*)?)?사업|전사)\s*(?:의\s*)?(?:(?:20\d{2}\s*년\s*)?\d{1,2}\s*월|20\d{2}-\d{2}|이번\s*(?:달|월))\s*(?:\d\s*주차\s*)?(?:주\s*정산|월\s*결산|월\s*정산)(?:\s|결과|완료|여부|상태|만|을|를|은|는|좀|이야기해줘|알려줘|보여줘|확인해줘|정리해줘|해주세요|해줘|[.!?])*$/;
  const direct = allProjects && yearMonth && !ambiguous && (bareCfo || directSyntax.test(text));
  return { kind, bareCfo, direct: Boolean(direct),
    input: direct ? { yearMonth, kind, ...(weekNo ? { weekNo } : {}) } : null,
    notice: bareCfo ? `CFO 기본 브리핑: 전체 등록 사업의 ${current} 주정산과 직전 월 월결산 현황입니다. 금액 비교는 사업과 두 기간을 지정해 요청해주세요.`
      : defaultedYear ? `연도 미지정: 한국시간 현재 연도 ${current.slice(0, 4)}년 기준으로 조회했습니다.` : '',
  };
}

export function settlementRequestTools(tools, request) {
  return request ? tools.filter((tool) => !financialTools.has(tool.name)) : tools;
}
