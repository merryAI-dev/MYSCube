// Generated from allowlisted source files. Run node scripts/generate-agent-code-evidence.mjs after source changes.
export const CODE_EVIDENCE = [
  {
    "topic": "accounting",
    "path": "server/bff/cashflow-coordinates.mjs",
    "sourceSha256": "ce190dd5817dc0da05618684ac5e4d043c241f5836b58154489db0d195832824",
    "startLine": 71,
    "endLine": 77,
    "excerpt": "export function weekOrdinal(weeklyYear, yearMonth, weekNo) {\n  if (!isWeeklyMonth(weeklyYear, yearMonth)) return -1;\n  const week = Number(weekNo);\n  if (!Number.isInteger(week) || week < 1 || week > WEEKS_PER_MONTH) return -1;\n  const month = Number(String(yearMonth).slice(5, 7));\n  return (month - 1) * WEEKS_PER_MONTH + (week - 1);\n}"
  },
  {
    "topic": "accounting",
    "path": "server/bff/cashflow-coordinates.mjs",
    "sourceSha256": "ce190dd5817dc0da05618684ac5e4d043c241f5836b58154489db0d195832824",
    "startLine": 25,
    "endLine": 27,
    "excerpt": "export const ANNUAL_COLUMNS_BEFORE = Object.freeze([2, 3]);\nexport const ANNUAL_COLUMNS_AFTER = Object.freeze([64, 65, 66, 67, 68, 69]);\nexport const SOURCE_YEAR_TOTAL_COLUMN = 70;"
  },
  {
    "topic": "sheet_validation",
    "path": "server/bff/routes/jvm-weekly-api.mjs",
    "sourceSha256": "f9205ee7b08d002befc3e1d5d4946fb69c9b99878f336f6b150070220005344d",
    "startLine": 2762,
    "endLine": 2775,
    "excerpt": "  if (projectionRows.length !== 19 || actualRows.length !== 19) {\n    blockers.push({\n      code: 'SHEET_CONTROL_TOTAL_INCOMPLETE',\n      message: 'Projection/Actual BO control total이 불완전합니다. 시트값을 다시 불러와 주세요.',\n    });\n  } else if (\n    typeof controls?.deposit?.matches !== 'boolean'\n    || rows.some((row) => typeof row?.matches !== 'boolean')\n  ) {\n    blockers.push({\n      code: 'SHEET_CONTROL_TOTAL_INVALID',\n      message: 'Projection/Actual BO control total 검산값이 올바르지 않습니다. 시트값을 다시 불러와 주세요.',\n    });\n  }"
  },
  {
    "topic": "sheet_validation",
    "path": "server/bff/cashflow-sheet-snapshot.mjs",
    "sourceSha256": "319da58f6c87d42f543ad0044ab5c8d5565f20e6eaf73e7615048a76b3a4979a",
    "startLine": 408,
    "endLine": 408,
    "excerpt": "    matches: value === null || computed === null ? null : value === computed,"
  },
  {
    "topic": "connectivity",
    "path": "server/bff/cashflow-project-scope.mjs",
    "sourceSha256": "8b971e9b2cbab0686041fa56fef3fd51779cfe056d239258931202b87f87edeb",
    "startLine": 68,
    "endLine": 72,
    "excerpt": "export function isProjectInActorScope({ role, members, actorId, projectId, workspaceUser = false }) {\n  if (workspaceUser) return true;\n  if (TENANT_WIDE_PROJECT_ROLES.includes(normalizedRole(role))) return true;\n  return hasProjectAccess({ members, actorId, projectId });\n}"
  },
  {
    "topic": "agent_runtime",
    "path": "server/mcp/settlement-agent.mjs",
    "sourceSha256": "1568d01d6ec038227eaa62bc6ae0b91036d1bf88eb00927f48f6ca06c245b93e",
    "startLine": 93,
    "endLine": 97,
    "excerpt": "    if (!calls?.length) {\n      if (!answers.length) return { status: 'unverified', answer: '정산 정보를 확인하지 못했습니다. 조회할 사업과 기간을 알려주세요.' };\n      return { status: failed ? 'partial' : 'answered', answer: [\n        ...answers, ...(failed ? ['일부 조회가 실패했습니다. 전체 완료 여부를 판단할 수 없습니다.'] : [])].join('\\n\\n') };\n    }"
  },
  {
    "topic": "agent_runtime",
    "path": "server/mcp/hermes-harness.mjs",
    "sourceSha256": "2bd04aec231cea6efff04ab5a521bd6960c3e21fd9dc5591f4ab0499d1450ced",
    "startLine": 122,
    "endLine": 126,
    "excerpt": "        await record({ type: 'answer_policy', policy: 'server_evidence_only', harness: 'hermes', renderedResults: answers.length });\n        const partial = failed || message.partial === true;\n        if (!answers.length) { finish(null, { status: failed ? 'partial' : 'unverified', answer: '조회 근거를 확인하지 못했습니다. 사업과 기간을 확인해 다시 요청해주세요.' }); return; }\n        finish(null, { status: partial ? 'partial' : 'answered', answer: [...answers,\n          ...(partial ? ['🔎 일부 처리를 마치지 못해 전체 결과가 아닙니다.'] : [])].join('\\n\\n') });"
  }
];
