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
    "sourceSha256": "888e9fe208d26ef445162cf2fd4c462bb5a7b3ce7c143dee2505e9fd661a4865",
    "startLine": 99,
    "endLine": 103,
    "excerpt": "    if (!calls?.length) {\n      if (!answers.length) return { status: 'unverified', answer: renderToolFailures(failures) || '정산 정보를 확인하지 못했습니다. 조회할 사업과 기간을 알려주세요.' };\n      return { status: failures.length ? 'partial' : 'answered', answer: [\n        ...answers, ...(failures.length ? [renderToolFailures(failures)] : [])].join('\\n\\n') };\n    }"
  },
  {
    "topic": "agent_runtime",
    "path": "server/mcp/hermes-harness.mjs",
    "sourceSha256": "8d1f9f72634e26b56f906b0fe88b0b92128fc04fb5a545a3586a59808e46e1b9",
    "startLine": 129,
    "endLine": 133,
    "excerpt": "        await record({ type: 'answer_policy', policy: 'server_evidence_only', harness: 'hermes', renderedResults: answers.length });\n        const partial = failures.length > 0 || message.partial === true;\n        if (!answers.length) { finish(null, { status: failures.length ? 'partial' : 'unverified', answer: renderToolFailures(failures) || '조회 근거를 확인하지 못했습니다. 사업과 기간을 확인해 다시 요청해주세요.' }); return; }\n        finish(null, { status: partial ? 'partial' : 'answered', answer: [...answers,\n          ...(failures.length ? [renderToolFailures(failures)] : []),"
  }
];
