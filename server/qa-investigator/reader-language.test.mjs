import test from "node:test";
import assert from "node:assert/strict";
import {
  validateReaderLanguage,
  READER_LANGUAGE_INSTRUCTIONS,
} from "./reader-language.mjs";
import { INVESTIGATION_READABILITY_REVIEW_GUIDANCE } from './agent.mjs';
test("rejects the reported technical answer in primary user copy", () => {
  const issues = validateReaderLanguage({
    user_reply:
      "확인된 범위에서는 브라우저 신고에 그치지 않습니다. 인증된 Vercel 요청 로그에서 JVM의 jvm_weekly_api_unconfigured와 BFF 주소 해석 실패가 관측됐습니다.",
  });
  assert.ok(issues.some((x) => x.includes("replace implementation")));
  assert.ok(issues.some((x) => x.includes("start with")));
});
test("accepts concrete business comparison while preserving technical evidence separately", () => {
  assert.deepEqual(
    validateReaderLanguage({
      user_reply:
        "현금흐름 자료를 불러오지 못했습니다. 화면 진단에는 A17의 ‘메입부가세’가 정해진 항목명 ‘매입부가세’와 다르다고 나옵니다. 담당자가 해당 셀과 양식을 대조해 주세요.",
      facts: [
        {
          claim:
            "BFF jvm_weekly_api_unconfigured req_1791792279993_aa0de4197a294e00",
        },
      ],
    }),
    [],
  );
});
test("accepts calibrated missing cause with a precise next step", () => {
  assert.deepEqual(
    validateReaderLanguage({
      user_reply:
        "월별 정산 화면이 정산 서버에 연결되지 못했습니다. 당시 배포의 연결 설정 문제로 보이지만, 어떤 설정이 빠졌는지는 아직 확인되지 않았습니다. 개발 담당자가 그 배포의 서버 연결 주소를 확인해야 합니다.",
    }),
    [],
  );
});
test("the structured summary receives the same gate; cell and business names remain allowed", () => {
  assert.ok(
    validateReaderLanguage({
      user_reply: "정산 승인이 멈췄습니다.",
      user_result: { headline: "Firestore JVM endpoint 조사" },
    }).length,
  );
  assert.deepEqual(
    validateReaderLanguage({
      user_result: {
        headline: "D-TIPS 월별 정산 승인 대기",
        observed_expected: "BS18의 입금 합계가 다릅니다.",
      },
    }),
    [],
  );
  assert.match(READER_LANGUAGE_INSTRUCTIONS, /warning does not prove/);
});

for (const [kind, reply] of [
  [
    "registration",
    "사업 등록 요청은 저장됐고 현재 승인 대기 중입니다. 승인 담당자가 신청 내용을 검토하면 다음 단계로 넘어갑니다.",
  ],
  [
    "access",
    "이 사업을 조회할 권한이 현재 계정에 없습니다. 사업 담당자에게 조회 권한을 요청해 주세요.",
  ],
  [
    "synchronization",
    "수정 내용은 저장됐지만 현황 화면에는 아직 반영되지 않았습니다. 담당자가 저장 시각 이후의 동기화 진행 상태를 확인해야 합니다.",
  ],
  [
    "unknown",
    "저장이 완료되지 않은 것은 확인했지만 원인은 아직 찾지 못했습니다. 개발 담당자가 해당 시각의 저장 요청과 처리 기록을 대조해야 합니다.",
  ],
  [
    "source blocked",
    "요청이 실패했다는 제보는 받았지만 당시 처리 기록에 접근하지 못했습니다. 운영 담당자가 조사 서비스의 기록 조회 권한을 복구하면 조사를 이어갈 수 있습니다.",
  ],
])
  test(`presentation contract accepts distinct ${kind} outcome without a cashflow template`, () =>
    assert.deepEqual(validateReaderLanguage({ user_reply: reply }), []));

test('keeps an observed business label even when it contains a reporter noun', () => {
  assert.deepEqual(validateReaderLanguage({ user_result: {
    observed_expected: '화면에는 ‘접수자 이름’ 항목이 비어 있지만, 등록 규칙에는 필수 항목으로 표시됩니다.',
  } }), []);
});

test('allows the requester to supply visible context while a service owner checks internal records', () => {
  assert.deepEqual(validateReaderLanguage({ user_result: {
    next_action: '사용자가 발생 시각을 알려주면 개발 담당자가 서버 기록을 확인해야 합니다.',
  } }), []);
  assert.ok(validateReaderLanguage({ user_result: {
    next_action: '사용자가 직접 서버 기록을 확인해야 합니다.',
  } }).some((issue) => issue.startsWith('user_result.next_action:')));
});

const audienceCases = [
  {
    kind: 'login',
    reply: '로그인 뒤 첫 화면이 나타나지 않았습니다. 어느 단계에서 멈췄는지는 아직 확인되지 않았습니다. 같은 문제가 다시 생기면 화면과 시각, 누른 순서를 알려 주세요.',
    action: '같은 문제가 다시 생기면 화면과 시각, 누른 순서를 알려 주세요.',
    wrong: '사용자가 개발자 도구에서 네트워크 기록을 모아 주세요.',
  },
  {
    kind: 'access',
    reply: '현재 계정에는 이 사업을 볼 권한이 없습니다. 사업 담당자에게 해당 사업의 조회 권한을 요청해 주세요.',
    action: '사업 담당자에게 해당 사업의 조회 권한을 요청해 주세요.',
    wrong: '접수자 연관 오류를 확인했습니다. 사업 담당자에게 요청해 주세요.',
  },
  {
    kind: 'registration',
    reply: '등록 내용은 저장됐고 지금은 승인 대기 중입니다. 승인 담당자가 신청 내용을 검토한 뒤 결과를 확인해 주세요.',
    action: '승인 담당자가 신청 내용을 검토한 뒤 결과를 확인해 주세요.',
    wrong: '승인 담당자에게 검토를 권고합니다.',
  },
  {
    kind: 'synchronization',
    reply: '수정 내용은 저장됐지만 현황 화면에는 아직 반영되지 않았습니다. 운영 담당자가 해당 시각 이후의 반영 상태를 확인해 주세요.',
    action: '운영 담당자가 해당 시각 이후의 반영 상태를 확인해 주세요.',
    wrong: '사용자가 서버 로그와 배포 설정을 확인해 주세요.',
  },
  {
    kind: 'calculation',
    reply: '현금흐름 화면에서 A17의 ‘메입부가세’가 정해진 ‘매입부가세’와 다릅니다. 시트 담당자가 A17 항목명을 대조한 뒤 다시 불러와 확인해 주세요.',
    action: '시트 담당자가 A17 항목명을 대조한 뒤 다시 불러와 확인해 주세요.',
    wrong: '시트 담당자가 민감정보를 뺀 네트워크 기록을 제출해 주세요.',
  },
];

for (const scenario of audienceCases) {
  test(`${scenario.kind}: keeps a concrete reader action and technical facts outside the presentation gate`, () => {
    const answer = {
      user_reply: scenario.reply,
      user_result: {
        headline: `${scenario.kind} 처리 상태`,
        what_happened: scenario.reply.split('.')[0],
        observed_expected: '',
        next_action: scenario.action,
        result_kind: 'inconclusive',
      },
      facts: [{ claim: 'BFF JVM endpoint ev_' + 'a'.repeat(64) }],
    };
    assert.deepEqual(validateReaderLanguage(answer), []);
    assert.deepEqual(validateReaderLanguage({ ...answer, user_result: {
      ...answer.user_result, next_action: scenario.wrong,
    } }).some((issue) => issue.startsWith('user_result.next_action:')), true);
  });
}

test('all requester summary fields keep polite direct voice without turning a report into a verified event', () => {
  const reportedOnly = {
    user_reply: '로그인 뒤 첫 화면으로 돌아온다는 내용은 검증용 예시라 실제 화면 이동은 확인되지 않았습니다.',
    user_result: {
      headline: '로그인 뒤 화면 이동은 아직 확인되지 않았습니다',
      what_happened: '이 내용은 검증용 예시다. 실제 화면 이동은 확인되지 않았다.',
      observed_expected: '관찰된 단서는 있으나 실제 화면 이동과 정상 기준은 비교할 수 없다.',
      next_action: '같은 현상이 발생하면 화면과 시각을 알려 주고 담당자가 당시 기록을 대조해야 한다.',
    },
  };
  const issues = validateReaderLanguage(reportedOnly);
  for (const field of ['what_happened', 'observed_expected', 'next_action'])
    assert.ok(issues.some((issue) => issue.startsWith(`user_result.${field}:`) &&
      issue.includes('polite Korean')));
  assert.ok(!issues.some((issue) => issue.startsWith('user_result.headline:')));

  const repaired = structuredClone(reportedOnly);
  repaired.user_result.what_happened = '이 내용은 검증용 예시이며 실제 화면 이동은 확인되지 않았습니다.';
  repaired.user_result.observed_expected = '관찰된 단서는 있지만 실제 화면 이동과 정상 기준은 비교할 수 없습니다.';
  repaired.user_result.next_action = '같은 현상이 발생하면 화면과 시각을 알려 주시고, 담당자가 당시 기록을 대조해 주세요.';
  assert.deepEqual(validateReaderLanguage(repaired), []);
});

for (const [kind, whatHappened, observedExpected, nextAction] of [
  ['access', '현재 계정에서 이 사업을 열 수 없습니다.', '조회 권한이 없다는 확인 결과가 있습니다.',
    '사업 담당자에게 이 사업의 조회 권한을 요청해 주세요.'],
  ['registration', '등록 요청은 저장됐고 승인 대기 중입니다.', '신청 상태는 승인 대기로 표시됩니다.',
    '승인 담당자의 검토 결과를 확인해 주세요.'],
  ['synchronization', '변경 내용은 저장됐지만 현황 화면에는 아직 보이지 않습니다.',
    '저장 완료와 화면 반영 상태가 다릅니다.', '운영 담당자가 해당 시각 이후의 반영 상태를 확인해 주세요.'],
  ['calculation', '정산 값이 화면에서 예상과 다르게 보입니다.',
    '화면의 ‘접수자 이름’처럼 사업상 필요한 항목명은 그대로 대조해야 합니다.',
    '시트 담당자가 실제 값과 정해진 기준을 대조해 주세요.'],
])
  test(`${kind} summary accepts polite distinct fields and preserves literal business labels`, () => {
    assert.deepEqual(validateReaderLanguage({ user_result: {
      headline: `${kind} 처리 상태`, what_happened: whatHappened,
      observed_expected: observedExpected, next_action: nextAction,
    } }), []);
  });

test('readability critic guidance covers all public summary fields without mandating a stock answer', () => {
  assert.match(INVESTIGATION_READABILITY_REVIEW_GUIDANCE,
    /Headlin[e], what_happened, observed_expected and next_action are requester-facing/);
  assert.match(INVESTIGATION_READABILITY_REVIEW_GUIDANCE, /reporter or repeating/);
  assert.match(INVESTIGATION_READABILITY_REVIEW_GUIDANCE, /do not demand a preferred sentence/);
  assert.match(INVESTIGATION_READABILITY_REVIEW_GUIDANCE, /claimed observed value cannot come only from the user report/);
});
