import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, 'ProjectEditorWizard.tsx'), 'utf8');
// 폼 레이아웃 체계는 project-form-layout.tsx 로 승격됐다 - 골격 계약은 그 파일을 본다.
const layoutSource = readFileSync(resolve(import.meta.dirname, 'project-form-layout.tsx'), 'utf8');
const adminWizardSource = readFileSync(resolve(import.meta.dirname, 'ProjectWizard.tsx'), 'utf8');
const portalRegisterSource = readFileSync(resolve(import.meta.dirname, '../portal/PortalProjectRegister.tsx'), 'utf8');
const portalEditSource = readFileSync(resolve(import.meta.dirname, '../portal/PortalProjectEdit.tsx'), 'utf8');
const contractDocumentPolicySource = readFileSync(resolve(import.meta.dirname, '../../platform/project-contract-document-policy.ts'), 'utf8');

describe('ProjectEditorWizard dropdown contract', () => {
  it('lists the seven registration documents as a status checklist and keeps every per-slot detail', () => {
    // 표(5열) 대신 상태 우선 체크리스트다: 행마다 아이콘이 먼저 말하고, 액션은 오른쪽 한 곳.
    // 미첨부는 오류가 아니라 대기이므로 필수만 앰버, 선택은 슬레이트로 말한다.
    expect(source).toContain("divide-y divide-slate-100 border-y border-slate-200");
    expect(source).toContain('CircleCheck className="h-4 w-4 text-emerald-600"');
    expect(source).toContain("unmet ? 'text-amber-500' : 'text-slate-300'");
    // Stacked cards hid whether a slot was still missing; each row now states it.
    expect(source).toContain("deferred ? '이후 제출(예외 처리)' : '미첨부'");
    expect(source).toContain('const unmet = !attached && !deferred && slot.number <= 3');
    // Details that only existed inside the old card must survive in the row.
    expect(source).toContain('분석 요약');
    expect(source).toContain('기존 계약서는 관리자 화면에서만 제거할 수 있습니다.');
    expect(source).toContain('산출내역서(견적서) 이후 제출(예외 처리)');
    expect(source).toContain("placeholder=\"https://drive.google.com/...\"");
  });

  it('lets an upload in flight be cancelled and takes back one that already landed', () => {
    expect(source).toContain('const cancelProjectDocumentUpload');
    expect(source).toContain('업로드 취소');
    expect(source).toContain('documentUploadRunRef');
    // The request cannot be recalled, so a late success is undone rather than left behind.
    expect(source).toContain('if (documentUploadRunRef.current[kind] !== runId) {');
    expect(source).toContain('await onRemoveProjectDocument?.(kind);');
  });

  it('requires documents 1-2, allows document 3 to be deferred, and keeps documents 4-7 optional', () => {
    expect(source).toContain("label: '계약서 *'");
    // 필수 표시는 라벨 문자열에 붙이던 ' *' 대신 ProjectFormRow 의 required 프로퍼티가 맡는다.
    // 마커를 한 군데(강조색 `*`)에서만 그리기 위한 변경이고, 어떤 항목이 필수인지는 그대로다.
    expect(source).toContain('label="모두 싸인으로 진행하셨나요?"');
    expect(source).toContain('계약서를 써니(사업지원팀)에게 제출했습니다.');
    expect(source).toContain("label: '고객사 사업자등록증 *'");
    expect(source).toContain("label: '산출내역서(견적서) *'");
    expect(source).toContain("label: '제안서(워드)'");
    // 이 칸이 받는 건 proposal_ppt_original 이고 입력값은 구글드라이브 링크다.
    // 내용(PPT)을 앞에 두고 매체는 괄호로 덧붙여 6번과 같은 말로 읽히게 한다.
    expect(source).toContain("label: '제안서 PPT 링크(구글드라이브 링크)'");
    expect(source).toContain("label: '발표자료(구글드라이브 링크)'");
    expect(source).toContain("label: 'RFP'");
    expect(source.match(/description: '있을 시'/g)).toHaveLength(3);
    expect(source).toContain("description: '없으면 사업요청사항을 확인할 수 있는 메일 본문 등 첨부'");
    expect(source).toContain("&& (draft.quoteDocument || draft.quoteSubmissionDeferred)");
    expect(source).toContain("mode === 'portal-register' && !hasRequiredRegistrationDocuments");
    expect(source).not.toContain("kinds: ['proposal', 'rfp_request_evidence']");
    expect(source).not.toContain('제안서와 RFP/요청 메일 중 하나만 남겨주세요.');
    expect(source).toContain('산출내역서(견적서) 이후 제출(예외 처리)');
    expect(source).toContain("!draft.quoteDocument && !draft.quoteSubmissionDeferred");
    expect(source).not.toContain("if (!draft.proposalWordOriginalDocument)");
  });

  it('lets the portal shell own the page title without rendering a duplicate editor header', () => {
    expect(source.match(/>\{title\}<\/h1>/g)).toHaveLength(1);
    expect(source).toContain('{embeddedInShell ? (');
    expect(source).toContain('<div className="flex justify-end">');
  });

  it('renders editor dropdowns from canonical option maps instead of surface-local labels', () => {
    expect(source).toContain('getProjectTypeSelectableOptions');
    expect(source).toContain('PROJECT_TYPE_LABELS[type]');
    expect(source).toContain('getProjectContractTypeSelectableOptions');
    expect(source).toContain('normalizeProjectContractType');
    expect(source).toContain('SETTLEMENT_TYPE_LABELS');
    expect(source).toContain('BASIS_LABELS');
    expect(source).toContain('ACCOUNT_TYPE_LABELS');
    expect(source).toContain('PROJECT_CURRENCY_LABELS');
    expect(source).toContain('ContractDocumentPreview');
    expect(source).toContain('draft.contractDocument');
    expect(source).not.toContain('<Input value={draft.contractType}');
  });

  it('uses the PPT settlement-system options and keeps a selected legacy value representable', () => {
    expect(source).toContain('PROJECT_SETTLEMENT_SYSTEM_CODES');
    expect(source).toContain('PROJECT_SETTLEMENT_SYSTEM_CODES.includes(draft.settlementSystem)');
    expect(source).toContain('[draft.settlementSystem]');
  });

  it('keeps select values representable in their option lists', () => {
    expect(source).toContain('const ownerOptions = useMemo');
    expect(source).toContain('const selectedOwner = useMemo');
    expect(source).toContain('const hasUnlinkedStoredOwner');
    expect(source).toContain('구성원 원장에서 선택');
    expect(source).not.toContain('<SelectItem value="none">선택 안 함</SelectItem>');
    // The stored value is offered back explicitly, labelled, so it is never silently lost.
    expect(source).toContain('withSavedOrgMemberOption(ledgerMemberOptions');
    expect(source).toContain('· 기존 선택');
    // Linkage is still judged against the ledger, so the unlinked warning keeps firing.
    expect(source).toContain('ledgerMemberOptions.find((member) => member.uid === draft.registeredById)');
  });

  it('uses a member select for project owner instead of free text manager input', () => {
    expect(source).toContain('최종 보고자 (실무책임자)');
    expect(source).toContain('registeredById');
    expect(source).toContain('registeredByName: member.label.replace(');
    expect(source).not.toContain('<Input value={draft.managerName}');
  });

  it('lets project registration and edit choose a designated executive approver from the member directory', () => {
    expect(source).toContain('label="최종 결재자 (총괄책임자)"');
    expect(source).toContain('const selectedExecutiveApprover = useMemo');
    expect(source).toContain('const executiveApproverOptions = useMemo');
    expect(source).not.toContain('requesterId?: string');
    expect(portalRegisterSource).not.toContain('requesterId={actor.uid}');
    expect(source).not.toContain('member.uid !== draft.registeredById && member.uid !== requesterId');
    expect(source).not.toContain('const isSelfExecutiveApprover = Boolean(');
    expect(source).not.toContain('최종 보고자 (실무책임자)와 최종 결재자 (총괄책임자)는 달라야 합니다.');
  });

  it('drops only members marked inactive, so members without a status still appear', () => {
    // Requiring status to equal ACTIVE hid the 15 members whose document carries no status
    // field at all, which is what QA reported as missing people.
    const optionsSource = readFileSync(
      resolve(import.meta.dirname, '../../data/project-team-member-options.ts'),
      'utf8',
    );
    expect(optionsSource).toContain("if (status === 'INACTIVE' || status === 'DELETED') return;");
    expect(optionsSource).not.toContain("=== 'ACTIVE'");
    expect(source).toContain('buildOrgMemberPickerOptions(members, roster)');
    expect(source).toContain('const executiveApproverOptions = useMemo');
  });

  /*
   * 참여인력은 참여율 시트에서 온다. 사람이 같은 내용을 두 곳에 적지 않게 하려고 수기 입력을
   * 걷어냈다. 여기서는 연동 경로가 살아 있는지와, 걷어낸 수기 입력이 되살아나지 않는지를 본다.
   */
  it('syncs the participation roster from the sheet instead of manual entry', () => {
    expect(source).toContain('const syncTeamFromSheet = () => {');
    expect(source).toContain('previewParticipationSheetByLinkViaBff(');
    expect(source).toContain("{teamSyncing ? '연동 중' : '연동하기'}");
    // 저장 전에도 눌러야 하므로 화면의 링크·계약 기간을 그대로 보낸다.
    expect(source).toContain('contractStart: draft.contractStart,');
    expect(source).toContain('contractEnd: draft.contractEnd,');
    // 명단은 승인 서류·인력 현황·사업 검색이 쓴다. 연동이 그것까지 채워야 끊기지 않는다.
    // 월별 값은 이 mapper가 빈칸(null)과 명시적 0을 구분한 뒤 같은 명단에 싣는다.
    expect(source).toContain('mapParticipationSheetPreviewToProjectTeamMembers');
    expect(source).toContain('const mappedTeamMembers = mapParticipationSheetPreviewToProjectTeamMembers(preview);');
    expect(source).toContain("update('teamMembersDetailed', mappedTeamMembers);");
    expect(source).toContain('teamMembersDetailed: mappedTeamMembers');
    // 성공한 입력 조합을 기억해야 링크·계약기간 변경 뒤 옛 preview를 저장하지 않는다.
    expect(source).toContain('participationSheetSyncSignature({');
  });

  it('blocks a V2 save until the current sheet link and contract period have a valid preview', () => {
    // 판정 자체는 순수 helper의 behavior test가 맡고, 이 테스트는 Wizard submit gate 연결만 본다.
    expect(source).toContain('participationSheetSyncIssue({');
    expect(source).toContain('draft,');
    expect(source).toContain('initialDraft,');
    expect(source).toContain('syncedSignature:');
    expect(source).toContain("issues.push({ step: 'team', label: participationSyncIssue });");
  });

  it('requires links for new projects while allowing unchanged pre-link projects to keep editing', () => {
    expect(source).toContain('participationSheetLinkRequired({');
    expect(source).toContain('const participationSheetBaseline = trustedParticipationSheetDraft || initialDraft;');
    expect(source).toContain('allowLegacyNoLink: Boolean(trustedParticipationSheetDraft)');
    expect(source).toContain('trustInitialPersistedSheetState: Boolean(trustedParticipationSheetDraft)');
    expect(source).toContain('if (requiresParticipationSheetLink && !draft.participationSheetLink.trim())');
    expect(adminWizardSource).toContain('trustedParticipationSheetDraft={editProject ? initialDraft : undefined}');
    expect(portalEditSource).toContain('trustedParticipationSheetDraft={canonicalDraft}');
    expect(portalRegisterSource).not.toContain('trustedParticipationSheetDraft');
  });

  // 표는 저장된 명단이 아니라 방금 읽은 시트다. 저장본을 그리면 연동 전 옛 값이 보인다.
  it('draws the sheet itself, sliced by year so a ten-year contract fits', () => {
    expect(source).toContain('const [teamSyncPreview, setTeamSyncPreview]');
    expect(source).toContain('teamSyncPreview.rows.map((row) => (');
    expect(source).toContain("teamSyncPreview.months.filter((month) => month.startsWith(teamSyncYear))");
    expect(source).toContain('aria-label="확인할 연도"');
    expect(source).not.toContain('{draft.teamMembersDetailed.map((member, index) => (');
  });

  it('shows which account the sheet must be shared with', () => {
    expect(source).toContain('fetchParticipationSystemAccountViaBff(');
    // 명단 자동 갱신(참조 푸시)에는 편집 권한이 필요하다 - 보기 권한 안내는 되돌아오면 안 된다.
    expect(source).toContain('에 편집자 권한으로 공유해 주세요.');
    expect(source).not.toContain('보기 권한으로 공유');
  });

  it('does not judge the sheet again in the browser', () => {
    // 막는 이유는 서버가 적어 준 대로 보여 준다. 화면이 다시 판정하면 두 곳이 어긋난다.
    expect(source).toContain('preview.blocking.map((issue) => issue.message)');
    expect(source).not.toContain('function TeamMemberSearchCombobox');
    expect(source).not.toContain('const addTeamMember');
    expect(source).not.toContain('createEmptyTeamMember');
  });

  it('requires the sheet link instead of an operating manager headcount', () => {
    // 역할 구성은 시트를 보고 사람이 판단할 일이라 저장을 막지 않는다. 대신 참여율을 적을 곳
    // 자체가 없는 상태는 막는다.
    expect(source).toContain("issues.push({ step: 'team', label: '참여율 시트 링크' });");
    expect(source).not.toContain("label: '운영매니저 1인 이상'");
    expect(source).not.toContain('hasProjectOperatingManager');
  });

  it('uses project operations terminology and exposes currency selection', () => {
    expect(source).toContain('서류상 참여인력');
    expect(source).toContain("{ id: 'team', label: '팀/인력', icon: Users }");
    expect(source).not.toContain('<Label className="text-xs">팀원 구성</Label>');
    // 라벨은 이제 ProjectFormRow 의 라벨 열이 그린다. 개별 <Label className="text-xs"> 는 사라졌다.
    // 통화는 사업 단위로 하나라 표 밖의 단독 행에서 고른다(2026-08-26 보람). 행마다 빈
    // 통화 칸을 두면 표가 넓어지고, 합계 행의 드롭다운은 무엇의 단위인지 읽히지 않았다.
    expect(source).toContain('<ProjectFormRow label="통화">');
    expect(source).toContain('aria-label="통화"');
    expect(source).toContain('PROJECT_CURRENCY_LABELS[draft.currency]');
  });

  it('receives department options instead of mapping hardcoded options directly in the wizard UI', () => {
    expect(source).toContain('departmentOptions?: string[]');
    expect(source).toContain('dedupeProjectDepartmentLabels(departmentOptions ? departmentOptions');
    expect(source).toContain('<ProjectFormRow label="담당조직(CIC)" required');
    expect(source).toContain('<SelectValue placeholder="담당조직 선택" />');
    expect(source).not.toContain('PROJECT_DEPARTMENT_OPTIONS.map((department)');
    expect(adminWizardSource).toContain('useProjectDepartmentSettings');
    expect(adminWizardSource).toContain('departmentOptions={departmentOptions}');
  });

  it('does not key editable team member rows by typed member name', () => {
    expect(source).toContain("key={`sheet-row-${row.rowIndex}`}");
    expect(source).not.toContain("key={`${member.memberName || 'member'}-${index}`}");
  });

  it('keeps the team step focused on CIC and member assignments without duplicate organization fields', () => {
    expect(source).not.toContain('<Label className="text-xs">사내기업팀</Label>');
    expect(source).not.toContain("<Input value={draft.teamName}");
    expect(source).not.toContain('<Label className="text-xs">참여기업 조건</Label>');
    expect(source).not.toContain("<Input value={draft.participantCondition}");
    expect(source).not.toContain('<ReviewRow label="사내기업팀"');
    expect(source).not.toContain('<ReviewRow label="참여 조건"');
  });

  // 팀원 줄은 시트에서 오므로 추가·수정 버튼이 없다. 투입기간은 시트의 투입시작·종료월이
  // 그대로 들어오고, 저장 경로의 정규화는 그대로 남아 있어야 한다.
  it('keeps the roster normalization while the rows come from the sheet', () => {
    expect(source).toContain('createProjectEditorWizardDraft');
    expect(source).toContain('normalizeProjectTeamMemberDraftRows');
    expect(source).toContain('mapParticipationSheetPreviewToProjectTeamMembers(preview)');
    expect(source).not.toContain('<Label className="text-xs">인건비 시작월</Label>');
    expect(source).not.toContain('onClick={addTeamMember}');
  });

  it('treats zero-won payment split values as explicit editable values', () => {
    expect(source).toContain('formatProjectAmountInput(draft.contractAmount, hasContractAmountInput)');
    expect(source).toContain('formatProjectAmountInput(draft.salesVatAmount, hasSalesVatAmountInput)');
    expect(source).toContain('formatProjectAmountInput(draft.totalRevenueAmount, hasTotalRevenueAmountInput)');
    expect(source).toContain('formatProjectAmountInput(draft.supportAmount, hasSupportAmountInput)');
    expect(source).toContain('formatProjectAmountInput(draft.budgetCurrentYear, draft.budgetCurrentYear > 0)');
    expect(source).toContain('formatProjectAmountInput(draft.taxInvoiceAmount, draft.taxInvoiceAmount > 0)');
    // 선금·중도금·잔금은 표의 세 행이 되어 같은 셀 코드를 돈다. 세 필드 모두 0원을 명시값으로
    // 다룬다는 계약(두 번째 인자 true)은 그대로다.
    expect(source).toContain("['contract', '선금/계약금'");
    expect(source).toContain("['interim', '중도금'");
    expect(source).toContain("['final', '잔금'");
    expect(source).toContain('formatProjectAmountInput(paymentPlan[field], true)');
  });

  it('shows annual profit rates as derived values and keys v2 settlement details to the basis', () => {
    // 연도별 수익률은 입력칸 모양을 벗고 표의 파생값 칸으로 바뀌었다. "자동 계산" 도움말을
    // 연도마다 반복하던 줄은 형태(입력칸 없음)가 대신하므로 지웠다.
    expect(source).toContain('{`${(row.profitRate * 100).toFixed(2)}%`}');
    expect(source).not.toContain('연도별 계약금액과 총수익으로 자동 계산');
    expect(source).not.toContain("updateFinancialYear(\n                      index,\n                      'profitRate'");
    expect(source).toContain("const settlementDetailsEnabled = usesRegistrationV2 ? draft.basis !== 'NONE' : draft.settlementType !== 'NONE'");
    expect(source).toContain("requiresSettlementConfirmations ? (");
    expect(source).toContain('정산 기준이 정산없음이면 통장·정산 시스템 입력이 필요하지 않습니다.');
  });

  it('renders the PPT v2 business-type and settlement-basis options without removed values', () => {
    expect(source).toContain("usesRegistrationV2 ? '사업유형' : '정산 유형'");
    expect(source).toContain("usesRegistrationV2 && draft.settlementType === 'NONE' ? undefined : draft.settlementType");
    expect(source).toContain(".filter(([key]) => !usesRegistrationV2 || key !== 'NONE')");
    expect(source).toContain(".filter(([key]) => usesRegistrationV2 ? key !== '기타' : key !== 'NONE')");
    expect(source).toContain("if (draft.settlementType === 'NONE') issues.push({ step: 'financial', label: '사업유형' })");
    expect(source).toContain("value={REGISTRATION_V2_BASIS_LABELS[draft.basis as Exclude<Basis, '기타'>]}");
  });

  it('balances the desktop review grid without changing the DOM reading order', () => {
    expect(source).not.toContain('className="contents lg:block lg:space-y-4"');
    expect(source).toContain('<Card className="shadow-none lg:col-start-1 lg:row-start-1 lg:self-start">');
    expect(source).toContain('<Card className="shadow-none lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:self-start">');
    expect(source).toContain('<Card className="shadow-none lg:col-start-1 lg:row-start-2 lg:self-start">');
    expect(source).toContain('<Card className="shadow-none lg:col-start-1 lg:row-start-3 lg:self-start">');

    const basicIndex = source.indexOf('>기본 정보</CardTitle>');
    const financialIndex = source.indexOf('>계약/재무</CardTitle>');
    const teamIndex = source.indexOf('>팀/인력</CardTitle>');
    const paymentIndex = source.indexOf('>입금/정산</CardTitle>');
    expect(basicIndex).toBeGreaterThan(-1);
    expect(basicIndex).toBeLessThan(financialIndex);
    expect(financialIndex).toBeLessThan(teamIndex);
    expect(paymentIndex).toBe(-1);
  });

  it('keeps portal edit drafts stable when async listener data refreshes', () => {
    expect(source).toContain('const lastResetKeyRef = useRef<string | null>(null)');
    expect(source).toContain("const resetKey = `${draftKey}::${autosave?.key || ''}`");
    expect(source).toContain('shouldResetProjectEditorDraft({');
    expect(source).toContain('lastPersistedFingerprint: lastPersistedFingerprintRef.current');
    expect(source).toContain('incomingFingerprint: initialDraftFingerprint');
    expect(source).not.toContain('lastInitialDraftFingerprintRef');
  });

  it('upgrades restored portal autosaves to the registration-v2 contract', () => {
    expect(source).toContain('function normalizeRestoredProjectEditorDraft');
    expect(source).toContain("mode === 'portal-register' || mode === 'portal-edit'");
    expect(source).toContain('registrationRequirementsVersion: 2');
    expect(source).toContain('normalizeRestoredProjectEditorDraft(restoreCandidate.draft, mode)');
  });

  it('uses the project name as the single PPT registration name', () => {
    expect(source).toContain('label="프로젝트명"');
    expect(source).not.toContain('그룹웨어 등록명');
    expect(source).toContain('계약서에 기재된 계약명 그대로 입력');
    expect(source).toContain('띄어쓰기를 포함해 계약서 표기와 동일하게 입력해 주세요.');
    expect(source).toContain('예: 26농식품AC');
    expect(source).not.toContain('maxLength=');
    expect(source).not.toContain('프로젝트명 10자 이하');
    expect(source).not.toContain('/10자');
    expect(source).not.toContain("event.target.value.slice(0, mode === 'portal-register' ? 10 : 80)");
    expect(source).toContain('계약연도+프로젝트명 형식으로 입력해 주세요.');
    expect(source).toContain('다년도 사업은 같은 연도만 변경된 동일 프로젝트명을 사용해주세요.(재경팀이 부여하는 A_, C_와 같은 코드는 기입하지 않습니다)');
    expect(source).not.toContain('재경팀이 부여하는 프로젝트 코드는 직접 입력하지 않습니다.');
    expect(source).toContain('사업자등록증상 법인명을 띄어쓰기까지 동일하게 입력해 주세요.');
    expect(source).toContain('어떤 대상에게 어떤 가치를 제공하는 프로젝트인지 입력');
    expect(source).toContain('CJ푸드빌 새로운 점포를 만들어갈 사내기업가 육성');
    expect(source).toContain('프로젝트 주요 수행 내용');
    expect(source).toContain('1. 사업제안서 작성 교육');
    expect(source).toContain('2. 사업제안서 작성 - 25개팀 이상 1:1 코칭');
    expect(source).toContain('3. 선정된 10개 팀 사업제안 구체화 1:1 컨설팅');
    expect(source).toContain("{ id: 'team', label: '팀/인력', icon: Users }");
    expect(source).not.toContain('const updateProjectName = (value: string)');
  });

  /**
   * 도움말 자리가 라벨 아래에서 "입력 아래 `·` 불릿"으로 옮겨졌다.
   * 예전에는 필드마다 도움말이 위/아래로 흩어져 있었고, 이제 ProjectFormRow 의 hints 한 곳만
   * 쓴다. 문구는 한 글자도 지우지 않았고 순서(설명 → 예시)도 그대로다.
   */
  it('keeps the purpose and main-content guidance in the one shared hint slot', () => {
    const purposeField = source.slice(
      source.indexOf('label="프로젝트 목적"'),
      source.indexOf('label="프로젝트 주요 내용"'),
    );
    const mainContentField = source.slice(
      source.indexOf('label="프로젝트 주요 내용"'),
      source.indexOf('const renderContractTypeSelect'),
    );

    expect(purposeField.indexOf('어떤 대상에게 어떤 가치를 제공하는 프로젝트인지 입력')).toBeLessThan(
      purposeField.indexOf('예: CJ푸드빌 새로운 점포를 만들어갈 사내기업가 육성'),
    );
    expect(purposeField).toContain('hints={[');
    expect(purposeField).toContain('예: CJ푸드빌 새로운 점포를 만들어갈 사내기업가 육성');
    expect(mainContentField.indexOf('프로젝트 주요 수행 내용, 범위, 산출물 등 프로그램 핵심 내용 요약')).toBeLessThan(
      mainContentField.indexOf('1. 사업제안서 작성 교육'),
    );
    expect(mainContentField).toContain('hints={[');
    expect(mainContentField).toContain('<span className="block">1. 사업제안서 작성 교육</span>');
    expect(mainContentField).toContain('<span className="block">2. 사업제안서 작성 - 25개팀 이상 1:1 코칭</span>');
    expect(mainContentField).toContain('<span className="block">3. 선정된 10개 팀 사업제안 구체화 1:1 컨설팅</span>');
    expect(purposeField).not.toContain('placeholder=');
    expect(mainContentField).not.toContain('placeholder=');
    expect(portalRegisterSource).toContain('<ProjectEditorWizard');
    expect(portalEditSource).toContain('<ProjectEditorWizard');
  });

  it('uses the PPT financial total labels in both entry and review surfaces', () => {
    expect(source).toContain('총매출부가세');
    expect(source).toContain('총지원금');
    expect(source).toContain('총수익률');
    expect(source).not.toContain('label="매출 부가세"');
    expect(source).not.toContain('label="지원금"');
    expect(source).not.toContain('label="수익률"');
  });

  it('draws the step navigation as numbered circles joined by a line', () => {
    // 레퍼런스(RCS Biz Center 가입 흐름)와 같은 형태 - 원형 번호를 선으로 잇고 라벨은
    // 아래에 둔다. 박스 칩 4개를 늘어놓던 이전 형태를 대체한다.
    expect(source).toContain("{done ? '✓' : index + 1}");
    expect(source).toContain("'mt-[13px] h-px flex-1'");
    expect(source).toContain('ring-4 ring-[#0176D3]/15');
    expect(source).not.toContain('grid gap-2 lg:grid-cols-4');
    expect(source).not.toContain('grid gap-1.5 lg:grid-cols-5');
  });

  it('warns users to verify the uploaded contract before saving', () => {
    expect(source).toContain('등록하려는 계약서가 맞는지 꼭 확인해주세요!');
    // rose 와 red 가 같은 "주의" 뜻으로 섞여 쓰이고 있었다. 색 하나에 뜻 하나만 두려고
    // 오류·주의는 red 로 모았다.
    expect(source).toContain('descriptionClassName="text-red-700"');
    expect(source).not.toContain('rose-');
    expect(source).not.toContain('업로드된 PDF를 마지막 확인 단계에서 바로 봅니다.');
    expect(source).toContain('documentPreviewUrls?: Partial<Record<ProjectRequestDocumentKind, string>>');
    expect(source).toContain('documentPreviewStates?: Partial<Record<ProjectRequestDocumentKind');
    expect(source).toContain('onLoadDocumentPreview?: (kind: ProjectRequestDocumentKind)');
    expect(source).toContain('documentPreviewUrls?.[kind] || document.downloadURL');
    expect(source).toContain('원문 불러오기');
    expect(source).toContain('원문 다시 불러오기');
  });

  it('supports contract PDF upload before saving registration or edit drafts', () => {
    expect(source).toContain('onContractFileUpload');
    expect(source).toContain('onProjectDocumentFileUpload');
    expect(source).toContain('handleProjectDocumentSelect');
    expect(source).toContain('PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_BYTES');
    expect(source).toContain('PROJECT_REQUEST_DOCUMENT_UPLOAD_MAX_SIZE_LABEL');
    expect(source).toContain('mergeContractAnalysisIntoDraft');
    expect(source).toContain('contractAnalysisMergeMode');
    expect(source).toContain("contractAnalysisMergeMode === 'none'");
    expect(source).toContain('입력값은 자동으로 바꾸지 않습니다.');
    expect(source).toContain('`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 업로드`');
    expect(source).toContain('`${PROJECT_DOCUMENT_BUTTON_LABELS[kind]} 교체`');
    expect(source).toContain('산출내역서(견적서) PDF');
    expect(source).toContain('제안서 PDF');
    expect(source).toContain('quoteDocument');
    expect(source).toContain('proposalDocument');
    expect(source).toContain('buildContractDocumentEditPolicy');
    expect(contractDocumentPolicySource).toContain('첨부 제거');
    expect(source).toContain('canRemoveContractDocument');
    expect(source).toContain('기존 계약서는 관리자 화면에서만 제거할 수 있습니다.');
    expect(contractDocumentPolicySource).toContain('교체 취소');
  });

  it('keeps the PPT registration attachment contract and completed-project checkout without a new route', () => {
    expect(portalRegisterSource).toContain('registrationRequirementsVersion: 2');
    expect(source).toContain("'customer_business_registration'");
    expect(source).toContain("'proposal'");
    expect(source).toContain("'rfp_request_evidence'");
    expect(source).toContain("'proposal_word_original'");
    expect(source).toContain("'proposal_ppt_original'");
    expect(source).toContain("'presentation_ppt_original'");
    expect(source).toContain('등록 제출서류 7종');
    expect(source).toContain('stacked');
    expect(source).toContain("className=\"grid gap-1.5 text-left\"");
    expect(source).toContain('1~2번은 필수, 3번은 첨부 또는 이후 제출');
    expect(source).toContain('등록 제출서류');
    expect(source).toContain("if (draft.settlementType === 'NONE') issues.push({ step: 'financial', label: '사업유형' })");
    expect(source).toContain('고객사 사업자등록증 PDF');
    expect(source).toContain('계약 종료일은 시작일 이후여야 합니다.');
    expect(source).not.toContain('인건비 투입 종료월은 시작월 이후여야 합니다.');
    expect(source).toContain('참여인력은 참여율 시트에서 연동합니다. 시트 링크를 먼저 넣어 주세요.');
    // 정산지원 담당자는 저장을 막지 않는다. 예전에는 submitIssues 에 들어가 최종 저장을
    // 막았고, 후보 드롭다운도 두 사람으로 좁혀 다른 사람을 아예 고를 수 없었다. 담당이
    // 바뀌거나 그 두 분이 자리를 비우면 프로젝트 등록 자체가 멈춘다.
    expect(source).not.toContain("issues.push({ step: 'team', label: '정산지원은 도담 또는 써니를 선택' })");
    expect(source).not.toContain('hasInvalidProjectSettlementSupportMember');
    expect(source).not.toContain('정산지원은 도담 또는 써니를 선택해 주세요.');
    expect(source).toContain("const requiresSettlementConfirmations = usesRegistrationV2 ? draft.basis !== 'NONE' : draft.settlementType !== 'NONE'");
    expect(source).not.toContain('정산 기준이 정산없음인 사업은 인건비·고객사 정산 확인을 입력하지 않습니다.');
    expect(source).not.toContain('xl:grid-cols-[132px_minmax(0,1.4fr)_minmax(0,1fr)_110px_120px_140px_140px]');
    expect(source).not.toContain('alternativeDocumentAttached');
    expect(source).not.toContain('특이사항 (메모란)');
    expect(source).not.toContain('lg:sticky lg:bottom-4');
    expect(source).not.toContain('발주처');
    expect(source).toMatch(/number: 4,\s+label: '제안서\(워드\)'/);
    // 5번 칸이 받는 건 proposal_ppt_original 이다. 내용이 앞, 매체가 괄호다.
    expect(source).toMatch(/number: 5,\s+label: '제안서 PPT 링크\(구글드라이브 링크\)'/);
    expect(source).toMatch(/number: 6,\s+label: '발표자료\(구글드라이브 링크\)'/);
    expect(source).toContain('{usesRegistrationV2 ? (');
    // The seven slots render as one table instead of stacked cards.
    expect(source).toContain('renderRegistrationDocumentTable');
    expect(source).toContain('{slot.description}');
    expect(source).toContain('isValidDriveUrl(draft.registrationConfirmations.proposalPptOriginal)');
    expect(source).toMatch(/number: 7,\s+label: 'RFP'/);
    // 연도별 표는 이제 독립 섹션이 아니라 「계약 정보」 안에 있다. 통화·기간과 떨어지면
    // 무엇의 금액인지 멀어지기 때문이다.
    expect(source).toContain('title="계약 정보"');
    expect(source).not.toContain('title="연도별 계약·재무"');
    expect(source).toContain('계약기간 전체 연도별 재무 확인');
    expect(source).not.toContain('4대보험 포함 확인');
    expect(source).not.toContain('퇴직급여 포함 확인');
    expect(source).not.toContain('모두싸인으로 계약했나요? *');
    expect(source).toContain('종료사업 체크아웃');
    expect(source).toContain("'performance_certificate'");
    expect(source).toContain("'tax_invoice'");
    expect(source).toContain("'final_settlement_report'");
    expect(source).toContain('evidenceDeletedAfterUsb');
    expect(source).toContain('SETTLEMENT_SYSTEM_LABELS');
    expect(source).toContain('LABOR_SETTLEMENT_BASIS_LABELS');
    expect(source).toContain('PROJECT_TEAM_MEMBER_ROLES');
    expect(source).toContain('paymentExpectedMonths');
    expect(source).toContain('label="선금·중도금 합계 70% 미만 사유"');
    expect(source).toContain('최종 저장 후 사업관리 폴더가 자동 생성');
  });

  it('merges payment fields into the contract-finance step and removes retired registration fields', () => {
    expect(source).not.toContain("{ id: 'payment', label: '입금/정산'");
    expect(source).not.toContain("if (step.id === 'payment')");
    expect(source).toContain('renderPaymentFields(row, index)');
    // 단년 계약의 입금 계획도 다른 묶음과 같은 섹션 껍데기를 쓴다. 렌더 조건은 그대로다.
    expect(source).toContain('{!hasMultiYearContract ? (');
    // 바로 아래가 표라 섹션 제목의 밑선을 그리지 않는다(flushBelow). 굵은 검은 선 두 줄이
    // 겹쳐 보이던 문제를 고친 것이고, 섹션 구성 자체는 그대로다.
    expect(source).toContain('<ProjectFormSection title="입금 계획" flushBelow>');
    expect(source).not.toContain('최종 입금 메모');
    expect(source).not.toContain('기타 참고사항');
    expect(source).not.toContain('등록 전 확인사항');
    expect(source).not.toContain('renderRegistrationConfirmations');
    expect(source).not.toContain("issues.push({ step: 'payment'");
    expect(source).toContain('총실비(원가)');
    expect(source).toContain('ACCOUNT_TYPE_LABELS');
    expect(source).toContain('INTEREST_REFUND_POLICY_LABELS');
    expect(source).not.toContain('최종 입금 재무주차');
    expect(source).not.toContain('placeholder="예: 26-8-1"');
    expect(source).toContain('const effectivePaymentPlan = hasMultiYearContract');
    expect(source).toContain('total.contract + (row.paymentPlan?.contract || 0)');
    expect(source).toContain('년 선금·중도금 합계 70% 미만 사유`}');
    expect(source).toContain("updateFinancialYear(financialYearIndex!, 'advanceInterimBelow70Reason'");
    expect(source).not.toContain('년 계약/재무 정산 완료');
    expect(source).not.toContain('최종 입금 주차 ${row.finalPaymentExpectedWeek || \'-\'}');
    expect(source).not.toContain('disabled={!financeWeekYear}');
    expect(source).not.toContain('계약 종료일을 입력하면 재무주차를 선택할 수 있습니다.');
    expect(source).not.toContain('입금계획');
  });

  it('wires admin project editor to contract upload without automatic analysis merge', () => {
    expect(adminWizardSource).toContain('uploadProjectRequestContractFile');
    expect(adminWizardSource).not.toContain('uploadProjectRequestSupplementalDocumentFile');
    expect(adminWizardSource).toContain('handleContractFileUpload');
    expect(adminWizardSource).not.toContain('handleProjectDocumentFileUpload');
    expect(adminWizardSource).toContain('onContractFileUpload={handleContractFileUpload}');
    expect(adminWizardSource).not.toContain('onProjectDocumentFileUpload={handleProjectDocumentFileUpload}');
    expect(adminWizardSource).toContain('contractAnalysisMergeMode="none"');
    expect(adminWizardSource).toContain('canRemoveContractDocument');
  });

  it('shows supplemental project documents only when a BFF-backed upload callback exists', () => {
    expect(source).toContain('const registrationDocumentKinds = onProjectDocumentFileUpload');
    expect(source).toContain("REGISTRATION_DOCUMENT_KINDS.filter((kind) => kind === 'contract')");
    expect(source).toContain('const checkoutDocumentKinds = onProjectDocumentFileUpload ? CHECKOUT_DOCUMENT_KINDS : []');
    expect(source).toContain('if (onProjectDocumentFileUpload) {');
    expect(source).toContain('registrationDocumentKinds.map((kind) => renderProjectDocumentUpload(kind))');
    expect(source).toContain('checkoutDocumentKinds.map((kind) => renderProjectDocumentUpload(kind))');
  });

  it('keeps private edit inputs read-only without disabling step navigation', () => {
    expect(source).toContain('readOnly?: boolean');
    expect(source).toContain('<fieldset disabled={readOnly} className="contents">');
    expect(source).toContain('disabled={readOnly || autosaveState');
    expect(source).toContain('disabled={readOnly || !!busyActionId || action.disabled}');
    expect(source).toContain('shouldResetProjectEditorDraft({');
    expect(source).toContain('autosave?.onSave, draftKey, hasPendingRetryFile, hasRequiredRegistrationDocuments, mode, readOnly, uploadInProgress');
  });

  it('keeps failed attachment files retryable and clears the input only after success', () => {
    expect(source).toContain('retryDocumentFileRef');
    expect(source).toContain('processProjectDocument(kind, retryFile');
    expect(source).toContain('다시 시도`');
    expect(source).toContain('if (input) input.value =');
    expect(source).not.toContain('finally {\n      input.value =');
  });

  it('blocks unload and navigation while input, upload, a retry file, or an active edit session remains', () => {
    expect(source).not.toContain('usePortalNavigationGuard');
    expect(source).toContain('useBlocker(shouldConfirmExit)');
    expect(source).toContain("window.addEventListener('beforeunload'");
    expect(source).toContain('hasUnsavedInput || uploadInProgress || hasPendingRetryFile');
    expect(source).toContain('saveDraftAndRelease');
  });

  it('never double-submits or final-submits after the latest private draft save fails', () => {
    expect(source).toContain('if (submitInFlightRef.current) return');
    expect(source).toContain("throw new Error('최신 입력을 임시저장하지 못해 최종 저장을 중단했습니다.')");
    expect(source.indexOf('persistAutosaveSnapshot(draft, stepIndex)')).toBeLessThan(source.indexOf('await onSubmit(createProjectEditorDraft(draft), actionId)'));
  });

  it('never saves or submits a stale snapshot while an attachment mutation is in flight', () => {
    // 자동저장 가드는 렌더 시점 값이 아니라 ref 를 즉석에서 본다 - 대기 파일을 버리고
    // 나가는 경로에서도 임시저장이 돼야 하기 때문이다.
    expect(source).toContain('if (uploadInProgress || pendingRetryNow) return false;');
    expect(source).toContain("toast.error('첨부파일 처리를 완료한 뒤 임시저장해 주세요.')");
    expect(source).toContain("toast.error('첨부파일 처리를 완료한 뒤 최종 저장해 주세요.')");
    expect(source).toContain("disabled={readOnly || autosaveState === 'saving' || uploadInProgress || hasPendingRetryFile || (mode === 'portal-register' && !hasRequiredRegistrationDocuments)}");
    expect(source).toContain("toast.error('첨부파일 처리를 완료한 뒤 최종 저장해 주세요.')");
  });

  it('keeps the final save button pressable and explains every reason it cannot submit yet', () => {
    expect(source).toContain('disabled={readOnly || !!busyActionId || action.disabled}');
    expect(source).toContain('const submitBlocked = !canSubmit || Boolean(submitBlockedStatusReason);');
    expect(source).toContain('if (submitBlocked) {');
    expect(source).toContain('setSubmitBlockedNotice(true);');
    expect(source).toContain("'첨부파일을 처리하고 있습니다. 처리가 끝난 뒤 최종 저장해 주세요.'");
    expect(source).toContain("'업로드하지 못한 첨부파일이 있습니다. 해당 파일을 다시 첨부해 주세요.'");
    expect(source).toContain("'임시저장을 진행하고 있습니다. 잠시 후 다시 시도해 주세요.'");
    expect(source).toContain('아직 최종 저장할 수 없습니다');
    expect(source).toContain('최종 저장 전 확인이 필요합니다');
    expect(source).toContain('setStepIndex(Math.max(0, STEPS.findIndex((step) => step.id === issue.step)))');
    expect(source).toContain('단계로 이동');
    expect(source).toContain('{stepIndex === STEPS.length - 1 && !readOnly ? (');
    expect(source).toContain('if (!submitBlocked) setSubmitBlockedNotice(false);');
  });

  it('shows the blocking reason only beside the final save button, not at the top of the review step', () => {
    expect(source).not.toContain('입력이 필요합니다.');
    expect(source.match(/renderSubmitBlockers\(\)/g)).toHaveLength(1);
  });

  it('removes private registration attachments through the owner-authorized draft API before clearing local state', () => {
    expect(source).toContain('canRemoveProjectDocuments?: boolean');
    expect(source).toContain('onRemoveProjectDocument?: (kind: ProjectRequestDocumentKind) => void | Promise<void>;');
    expect(source).toContain('const canRemove = canRemoveProjectDocuments &&');
    expect(source).toContain('await onRemoveProjectDocument?.(kind)');
    expect(portalRegisterSource).toContain('canRemoveProjectDocuments');
    expect(portalRegisterSource).toContain('onRemoveProjectDocument={removeDocument}');
    expect(portalRegisterSource).toContain('draftClient.removeAttachment(record.draftId, ownership');
    expect(source).toContain('privateDraftAttachment={Boolean(documentPreviewStates?.contract)');
  });
});

/**
 * 화면 골격 계약. 이 블록은 "저장되는 값"이 아니라 "보여주는 방식"만 고정한다.
 * 45개 필드가 각자 크기·간격·색을 정하던 상태로 돌아가지 않게 막는 것이 목적이다.
 */
describe('ProjectEditorWizard form skeleton contract', () => {
  // 토큰 정의부(주석 포함)를 빼고 실제 렌더 코드만 검사한다.
  const renderBody = source.slice(source.indexOf('function getProjectEditorAutosaveStorageKey'));

  it('routes every field through one row component instead of per-field markup', () => {
    expect(layoutSource).toContain('export function ProjectFormRow(');
    expect(layoutSource).toContain('export function ProjectFormSection(');
    // 위저드는 정의하지 않고 가져다 쓴다 - 정의가 되살아나면 이중 출처다.
    expect(source).not.toContain('function ProjectFormRow(');
    expect(source).toContain("from './project-form-layout'");
    // 라벨·필수·부연·도움말·오류의 자리를 한 번만 정한다.
    expect(layoutSource).toContain('hints?: ReactNode[];');
    expect(layoutSource).toContain('errors?: string[];');
    expect(layoutSource).toContain('lg:grid-cols-[168px_minmax(0,1fr)]');
    // 컨트롤 폭 통일점 - 개별 컨트롤 max-w 금지의 근거.
    expect(layoutSource).toContain('max-w-xl');
    // 라벨 열이 고정폭이라 `*` 가 저절로 세로 정렬된다. 왼쪽 세로 마커는 두지 않는다.
    expect(source).not.toContain('border-l-4');
  });

  it('keeps type to four roles and spacing to three values', () => {
    expect(layoutSource).toContain("export const FORM_SECTION_CLASS = 'text-[14px] font-bold");
    expect(layoutSource).toContain("export const FORM_LABEL_CLASS = 'text-[12px] font-semibold");
    expect(layoutSource).toContain("export const FORM_VALUE_CLASS = 'text-[13px]'");
    expect(layoutSource).toContain("export const FORM_NUMERIC_VALUE_CLASS = 'text-[13px] tabular-nums'");
    expect(layoutSource).toContain("export const FORM_HINT_CLASS = 'text-[11px] font-normal");
    // text-xs 와 text-[12px] 는 같은 12px 를 두 이름으로 부르던 중복이었다. 이름을 하나로 모았다.
    expect(renderBody).not.toContain('text-xs');
    expect(renderBody).not.toContain('text-[10px]');
    expect(renderBody).not.toContain("'text-[12px]");
    expect(layoutSource).toContain("export const FORM_FIELD_STACK_CLASS = 'space-y-4'");
    expect(layoutSource).toContain("export const FORM_SECTION_STACK_CLASS = 'space-y-6'");
  });

  it('gives the accent colour exactly one meaning and keeps errors red', () => {
    // 필수 마커 · 포커스 링 · 활성 단계 칩. 그 밖에는 회색조를 쓴다.
    expect(source).toContain("'[&_[data-slot=input]]:focus-visible:ring-[#0176D3]/25'");
    // 등록 제출서류 7종 밖은 모든 값이 필수라 `*` 가 아무것도 구분하지 못한다.
    // 표시를 걷어냈으므로 폼 어디에도 빨간 별표가 남아 있으면 안 된다.
    expect(source).not.toContain('text-red-600">*</span>');
    expect(source).toContain("active && 'border-[#0176D3] bg-[#0176D3] text-white ring-4 ring-[#0176D3]/15'");
    expect(source).not.toContain('rose-');
  });

  it('strips the input shell from every calculated value', () => {
    expect(source).toContain('function ProjectComputedValue(');
    expect(source).toContain('계산됨');
    // readOnly 입력칸을 흐린 배경으로 위장하던 처리를 없앴다.
    expect(source).not.toContain('bg-muted/40');
    expect(source).not.toContain('총수익 / 계약금액 기준 자동 계산');
    expect(source).toContain('<ProjectComputedValue value={profitRateLabel');
  });

  it('adds a remaining-count badge to the step chips without touching the verdict', () => {
    expect(source).toContain('const canSubmit = submitIssues.length === 0;');
    expect(source).toContain('const stepIssueCounts = useMemo(');
    expect(source).toContain('submitIssues.forEach((issue) => { counts[issue.step] += 1; });');
    expect(source).toContain('남은 필수 항목 ${remaining}개');
    expect(source).toContain('onClick={() => setStepIndex(index)}');
  });

  it('repeats the submit-issue wording beside the field and scrolls to it', () => {
    expect(source).toContain('const issueLabelSet = useMemo(');
    expect(source).toContain('const fieldIssues = useCallback(');
    expect(source).toContain('errors={fieldIssues(\'프로젝트명\')}');
    expect(source).toContain('data-issue-label');
    expect(source).toContain("row.scrollIntoView({ block: 'center', behavior: 'smooth' })");
    expect(source).toContain('const goToIssue = (issue: { step: ProjectEditorStep; label: string }) =>');
    expect(source).toContain('onClick={() => goToIssue(issue)}');
  });

  it('reads the finance as one table for both single- and multi-year contracts', () => {
    expect(source).toContain('const renderAnnualFinanceTable = ');
    // 연도 수와 무관하게 금액은 연도별 표가 가진다. 단년도만 다른 모양이던 것을 없앴다.
    expect(source).toContain('const annualTotalsOwnAmounts = usesRegistrationV2;');
    expect(source).toContain('>연도</th>');
    expect(source).toContain('>합계</th>');
    expect(source).toContain("'px-3 py-2.5 text-right font-semibold text-[#0176D3]'");
    // 총계 입력칸 5개는 v1 등록에만 남는다.
    expect(source).toContain('formatProjectAmountInput(draft.contractAmount, hasContractAmountInput)');
    // 계약서 대조 체크는 걷어냈다. 체크박스를 지우면서 그것을 요구하던 제출 검증도 함께 지웠다.
    expect(source).not.toContain('금액을 계약서와 대조하여 확인했습니다.');
    expect(source).not.toContain('row.year === year && row.confirmed');
    // 진행 상태는 사람이 고르지 않고 계약 기간에서 나온다.
    expect(source).not.toContain('<ProjectFormRow label="프로젝트 진행 상태">');
    expect(source).toContain('deriveProjectStatusFromContractPeriod');
    // 입금 계획은 금액 표와 다른 경로다. 연도별로 쪼개는 것은 다년도뿐이다.
    expect(source).toContain('{annualTotalsOwnAmounts && hasMultiYearContract ? (');
  });

  it('derives the single-year contract amount from its items without rewriting stored values', () => {
    expect(source).toContain('const contractAmountIsDerived = annualTotalsOwnAmounts && !hasMultiYearContract');
    expect(source).toContain('deriveContractAmountFromItems');
    // 자동 계산은 사람이 금액을 고칠 때만 일어난다. 불러오기만으로 값이 바뀌면 사고다.
    expect(source).toContain('const storedContractAmountConflict = ');
    expect(source).toContain('저장된 계약금액');
    expect(source).toContain('어느 쪽이 맞는지 먼저 확인해 주세요');
  });

  it('shows a read-only Korean unit beside amounts without touching the stored value', () => {
    expect(source).toContain('function formatKoreanAmountUnit(');
    expect(source).toContain("[100000000, '억']");
    expect(source).toContain('const amountHint = (value: number, entered: boolean, prefix = \'\')');
    // 저장은 여전히 parseProjectAmountInput 이 만든 원 단위 숫자다.
    expect(source).toContain('parseProjectAmountInput(rawValue)');
  });

  it('opens each step with a single "prepare this" note', () => {
    expect(source).toContain('const STEP_PREPARATION_NOTES');
    expect(source).toContain('이 단계에서 준비할 것');
    expect(source).toContain('STEP_PREPARATION_NOTES[step.id].map((note)');
  });
});

describe('ProjectEditorWizard safe exit contract', () => {
  it('offers continue, discard, and private-save choices before releasing the edit session', () => {
    expect(source).toContain('onLeave?: () => void | Promise<void>;');
    expect(source).toContain('수정 세션을 종료할까요?');
    expect(source).toContain('계속 작성');
    expect(source).toContain('저장하지 않고 종료');
    expect(source).toContain('임시저장 후 종료');
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('await persistAutosaveSnapshot(draft, stepIndex)');
    expect(source).toContain('await onLeave?.();');
  });
});

// 참여율 시트 링크는 참여인력 섹션 안에 있어야 한다. 기본 정보에 두면 참여율을 입력하는
// 사람이 그 칸을 영영 만나지 못한다(보람: "거기 넣으면 아무도 모른다").
describe('참여율 시트 링크 자리', () => {
  it('참여인력 섹션 안에 있고 연동 결과 표보다 먼저 나온다', () => {
    const sectionAt = source.indexOf('title="서류상 참여인력"');
    const linkAt = source.indexOf('label="참여율 시트 링크"');
    const teamListAt = source.indexOf('시트 링크를 넣고 연동하기를 누르면');
    expect(sectionAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(sectionAt);
    expect(linkAt).toBeLessThan(teamListAt);
  });

  it('기본 정보 섹션에는 없다', () => {
    const basicAt = source.indexOf('<ProjectFormSection title="기본 정보">');
    const linkAt = source.indexOf('label="참여율 시트 링크"');
    const folderAt = source.indexOf('label="사업관리 구글폴더링크"');
    expect(folderAt).toBeGreaterThan(basicAt);
    expect(linkAt).toBeGreaterThan(folderAt + 1000);
  });

  it('검토 요약에도 실려 승인자가 본다', () => {
    expect(source).toContain('<ReviewRow label="참여율 시트 링크" value={draft.participationSheetLink} />');
  });

  it('대시보드에서 제거된 시트 확인 기능을 안내하지 않는다', () => {
    expect(source).toContain('저장한 시트 내용은 참여율 연동과 사람별 참여율 집계에 사용됩니다.');
    expect(source).not.toContain('참여인력 대시보드의 "시트 확인"');
  });
});
