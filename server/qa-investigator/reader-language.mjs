// Presentation checks never establish a cause. Evidence/candidate verification is separate.
const INTERNAL =
  /\b(?:BFF|JVM|Firestore|metadata|control-plane|downstream|endpoint|SHA)\b|\b(?:req_[0-9]+_[a-f0-9]+|ev_[a-f0-9]{64}|dpl_[A-Za-z0-9]+|[a-f0-9]{40})\b|\/(?:api|internal)\/|\b[a-z]+(?:_[a-z]+){2,}\b|\b[A-Z]+(?:_[A-Z]+){2,}\b|메타데이터|실효 환경|원자적 상태|주소 해석|독립 확인|핀된 소스|인증된.*요청 로그/i;
const CAVEAT_OPENING =
  /^(?:확인된 범위에서는|저장된 실행 기록으로|한 단계의 완료가|독립적으로 확인|제한된.*범위)/;
const REPORT_VOICE =
  /(?:접수자|제보자|신고자)\s*(?:와|의|에|에게)?\s*(?:연관(?:된)?|관련(?:된)?|신고(?:한)?|보고(?:한)?)\s*(?:오류|증상|현상|문제)?|(?:권고|권장)(?:합니다|드립니다)/;
const TECHNICAL_CAPTURE =
  /(?:개발자\s*도구|네트워크\s*(?:기록|로그|탭)|\bHAR\b)/i;
const REQUESTER_INTERNAL_ACTION =
  /(?:사용자|신청자|본인|귀하|당신)(?:(?!(?:담당자|관리자))[^.!?\n]){0,120}(?:서버\s*(?:로그|기록|설정)|배포\s*(?:설정|기록)|코드\s*(?:검색|확인)|개발자\s*도구|네트워크\s*(?:기록|로그|탭)|\bHAR\b)/i;
// The three prose fields in user_result are shown directly to the requester.
// A plain declarative ending makes them read like an internal report. Headlines
// may be short noun phrases; quoted business labels elsewhere remain intact.
const PLAIN_REPORT_ENDING = /(?<!니)다[.!?](?:\s|$)/;
export function validateReaderLanguage(answer) {
  const errors = [];
  const fields = {
    user_reply: answer?.user_reply,
    ...Object.fromEntries(
      ["headline", "what_happened", "observed_expected", "next_action"].map(
        (k) => [`user_result.${k}`, answer?.user_result?.[k]],
      ),
    ),
  };
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    if (INTERNAL.test(value))
      errors.push(
        `${field}: replace implementation terms and IDs with the affected business feature and visible symptom; retain technical details unchanged in evidence fields.`,
      );
    if (CAVEAT_OPENING.test(value.trim()))
      errors.push(
        `${field}: start with what the user cannot do and the best-supported explanation, not the scope of the investigation.`,
      );
    if (REPORT_VOICE.test(value))
      errors.push(
        `${field}: speak directly to the affected colleague in ordinary Korean; keep report labels and formal recommendations in technical notes.`,
      );
    if (field.startsWith("user_result.") && field !== "user_result.headline" &&
      PLAIN_REPORT_ENDING.test(value.trim()))
      errors.push(
        `${field}: use natural, polite Korean for this requester-facing sentence; keep the finding and its uncertainty unchanged.`,
      );
    if (TECHNICAL_CAPTURE.test(value) ||
      value.split(/[.!?\n]/).some((sentence) => REQUESTER_INTERNAL_ACTION.test(sentence)))
      errors.push(
        `${field}: a requester may share the screen, time, steps and visible message; assign privileged log, code or deployment checks to the service owner in technical actions.`,
      );
  }
  const reply = answer?.user_reply || "";
  if (reply.length > 900 || reply.split(/\n\s*\n/).some((p) => p.length > 300))
    errors.push(
      "user_reply: write a short business explanation; move detailed provenance and caveats to expandable technical evidence.",
    );
  return errors;
}
export const READER_LANGUAGE_INSTRUCTIONS = `
The primary reader is a colleague trying to finish a business task, not a developer reviewing an incident report. user_reply and all four user_result fields are public-facing; the headline may be a short natural phrase, and the other three fields should use polite Korean sentences rather than internal-report endings.
Apply the same explanation contract to any feature: (1) what the person cannot do, (2) the exact observed difference from the relevant rule, if established, (3) the conclusion that evidence actually supports, (4) who should do what next and how to verify the outcome.
Write to the affected colleague directly. Do not frame evidence as "접수자 기준" or "제보자 관점" or call the colleague a reporter, complainant or ticket submitter; avoid formal report phrases such as a recommendation being issued. If the report is only an example or an unverified account, say so clearly once in the public answer and keep each field's remaining sentence focused on its distinct purpose. Prefer one clear known fact and one decision-relevant unknown over a repeated scope disclaimer in the primary reply and every summary field. Keep material limits and counterevidence in the structured technical fields.
Separate actions by who can actually perform them. The affected colleague may provide the approximate time, screen, steps, visible message and relevant business item, then check the visible outcome after an authorized change. An operator or service owner must perform privileged log, code, deployment, permission or synchronization checks. Do not ask the affected colleague to collect developer-tool or network captures, inspect server records, or decide a technical fix. If the missing information requires access you do not have, name the owner and the precise check; never imply this agent already requested it.
Do not memorize an incident, preferred culprit, field coordinate, error code, or repair. Select the investigative tools and comparison from this case's request, deployed code and authoritative state. A superficially similar past report is a lead, not this case's answer.
Lead with the strongest justified conclusion. A confirmed cause, likely mechanism, normal business wait, source-access failure and unresolved cause need different answers. Do not call a cause confirmed just to sound decisive. Do not obscure a verified difference behind repeated caveats.
Use the screen's business labels and ordinary words. Describe an internal component by what it does for the user. Put request IDs, code symbols, hashes, paths and raw technical error codes in expandable evidence, not the primary reply.
Examples of STRUCTURE ONLY (never facts or recommendations for the current case):
- Registration: name whether a request was saved, its observed approval stage, and who owns the next step. A waiting approval is not automatically a system failure.
- Access: distinguish an observed missing permission from a sign-in failure; name the specific access request only when the current policy and account state support it.
- Data validation: compare the exact observed and required values at their verified source. Do not invent a cell, amount, expected label or correction from a familiar example.
- Delayed synchronization: distinguish the accepted write from the still-pending downstream update and state the observed progress/time; do not claim data was lost without evidence.
- Infrastructure failure: explain which business function could not reach which service in everyday language. Separate an observed connection failure from an unverified configuration or deployment cause.
- Missing evidence: state what is known and the single next discriminating check. Do not assign a cause or ask the reporter to investigate internal servers.
An amount ratio does not prove duplicate calculation; a warning does not prove a blocker; a merged fix does not prove deployment or a repair. Specificity is not certainty.
When observation and rule are both available, say the concrete difference; when one is missing, identify that missing comparison. Name the responsible role, precise action, and expected validation outcome. Avoid generic referrals such as asking someone to check everything.
Keep uncertainty once where it changes the decision. Preserve all technical evidence and caveats in facts, coverage, unknowns and action_items; never delete evidence to pass the presentation gate.
`;
