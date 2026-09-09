import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Download,
  Image as ImageIcon,
  Loader2,
  Search,
  Sparkles,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { PwaInstallPrompt } from '../pwa/PwaInstallPrompt';
import { useAuth } from '../../data/auth-store';
import {
  confirmBusinessCardImportViaBff,
  isPlatformApiEnabled,
  processBusinessCardViaBff,
  searchContactsViaBff,
  updateContactViaBff,
  type ActorLike,
  type BusinessCardConfirmPayload,
  type BusinessCardImportResult,
  type ContactSearchResult,
} from '../../lib/platform-bff-client';
import {
  prepareBusinessCardImage,
  type BusinessCardPreparedImage,
} from './business-card-image';
import {
  buildBusinessCardConfirmPayload,
  canConfirmBusinessCardContact,
  formStateFromBusinessCardExtraction,
  isLowConfidenceField,
} from './business-card-quality';

type BusinessCardTab = 'search' | 'capture';

interface BusinessCardContactFormState {
  name: string;
  organization: string;
  department: string;
  title: string;
  role: string;
  emailsText: string;
  phonesText: string;
  website: string;
  address: string;
  memo: string;
}

const TABS: Array<{ id: BusinessCardTab; label: string; description: string }> = [
  { id: 'capture', label: '명함 등록', description: '카메라 가이드에 맞춰 촬영하거나 이미지 파일로 새 명함을 등록합니다.' },
  { id: 'search', label: '검색', description: '전사 연락처를 이름, 회사, 이메일, 전화번호로 찾습니다.' },
];

const CAMERA_GUIDE = {
  left: 0.11,
  top: 0.28,
  width: 0.78,
  aspectRatio: 1.58,
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildContactsCsv(items: ContactSearchResult[]): string {
  const header = ['이름', '회사/소속', '부서', '직함', '역할', '이메일', '전화번호', '웹사이트', '주소', '메모', '수정일'];
  const rows = items.map((item) => [
    item.name,
    item.organization,
    item.department || '',
    item.title || '',
    item.role || '',
    item.emails?.join('; ') || '',
    item.phones?.join('; ') || '',
    item.website || '',
    item.address || '',
    item.memo || '',
    item.updatedAt || '',
  ]);
  return [header, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

function createEmptyContactFormState(): BusinessCardContactFormState {
  return {
    name: '',
    organization: '',
    department: '',
    title: '',
    role: '',
    emailsText: '',
    phonesText: '',
    website: '',
    address: '',
    memo: '',
  };
}

function contactToFormState(contact: ContactSearchResult): BusinessCardContactFormState {
  return {
    name: contact.name || '',
    organization: contact.organization || '',
    department: contact.department || '',
    title: contact.title || '',
    role: contact.role || '',
    emailsText: contact.emails?.join(', ') || '',
    phonesText: contact.phones?.join(', ') || '',
    website: contact.website || '',
    address: contact.address || '',
    memo: contact.memo || '',
  };
}

export function BusinessCardLabPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<BusinessCardTab>('capture');
  const [preparedImage, setPreparedImage] = useState<BusinessCardPreparedImage | null>(null);
  const [imageError, setImageError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [searching, setSearching] = useState(false);
  const [savingContactId, setSavingContactId] = useState('');
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [currentImport, setCurrentImport] = useState<BusinessCardImportResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ContactSearchResult[]>([]);
  const [contactDrafts, setContactDrafts] = useState<Record<string, BusinessCardContactFormState>>({});
  const [hasLoadedInitialContacts, setHasLoadedInitialContacts] = useState(false);
  const [formState, setFormState] = useState<BusinessCardContactFormState>(() => createEmptyContactFormState());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const activeTabMeta = useMemo(
    () => TABS.find((tab) => tab.id === activeTab) || TABS[0],
    [activeTab],
  );
  const tenantId = user?.tenantId || 'mysc';
  const actor: ActorLike | null = user ? {
    uid: user.uid,
    email: user.email,
    role: user.role,
    idToken: user.idToken,
  } : null;
  const confirmPayload = useMemo(() => buildBusinessCardConfirmPayload(formState), [formState]);
  const canSave = canConfirmBusinessCardContact(confirmPayload) && Boolean(currentImport?.importId);
  const bffEnabled = isPlatformApiEnabled();
  const busyLabel = preparing
    ? '이미지 준비 중'
    : processing
      ? 'Gemini가 명함을 읽는 중'
      : saving
        ? 'DB에 저장 중'
        : '';
  const captureBusy = Boolean(busyLabel);

  useEffect(() => {
    if (!scannerOpen || !cameraStream || !videoRef.current) return;
    videoRef.current.srcObject = cameraStream;
  }, [cameraStream, scannerOpen]);

  useEffect(() => () => {
    cameraStream?.getTracks().forEach((track) => track.stop());
  }, [cameraStream]);

  useEffect(() => {
    if (activeTab !== 'search' || hasLoadedInitialContacts || !actor || !bffEnabled) return;
    setHasLoadedInitialContacts(true);
    void handleSearchContacts('');
  }, [activeTab, actor, bffEnabled, hasLoadedInitialContacts]);

  async function prepareSelectedFile(file: File) {
    setImageError('');
    if (!file) return;
    setPreparing(true);
    try {
      const nextImage = await prepareBusinessCardImage(file);
      setPreparedImage(nextImage);
      setCurrentImport(null);
      setFormState(createEmptyContactFormState());
      setPreparing(false);
      await processPreparedImage(nextImage);
    } catch (error) {
      setPreparedImage(null);
      setImageError(error instanceof Error ? error.message : '이미지를 준비하지 못했습니다.');
    } finally {
      setPreparing(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      if (scannerOpen) closeScanner();
      await prepareSelectedFile(file);
    }
    event.target.value = '';
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    setCameraStream(null);
  }

  async function openScanner() {
    setImageError('');
    setCameraError('');
    setScannerOpen(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('이 브라우저에서는 앱 내 카메라를 사용할 수 없습니다. 이미지 업로드를 이용해 주세요.');
      return;
    }
    setCameraStarting(true);
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      setCameraStream(stream);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : '카메라 권한을 열지 못했습니다.');
    } finally {
      setCameraStarting(false);
    }
  }

  function closeScanner() {
    stopCamera();
    setScannerOpen(false);
    setCameraError('');
  }

  async function handleCaptureFromScanner() {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setCameraError('카메라 화면을 아직 읽지 못했습니다. 잠시 후 다시 촬영해 주세요.');
      return;
    }

    const displayWidth = video.clientWidth || video.videoWidth;
    const displayHeight = video.clientHeight || video.videoHeight;
    const guideHeight = (displayWidth * CAMERA_GUIDE.width) / CAMERA_GUIDE.aspectRatio;
    const guideTop = displayHeight * CAMERA_GUIDE.top;
    const guide = {
      x: displayWidth * CAMERA_GUIDE.left,
      y: guideTop,
      width: displayWidth * CAMERA_GUIDE.width,
      height: guideHeight,
    };
    const scale = Math.max(displayWidth / video.videoWidth, displayHeight / video.videoHeight);
    const renderedWidth = video.videoWidth * scale;
    const renderedHeight = video.videoHeight * scale;
    const offsetX = (displayWidth - renderedWidth) / 2;
    const offsetY = (displayHeight - renderedHeight) / 2;
    const source = {
      x: Math.max(0, Math.round((guide.x - offsetX) / scale)),
      y: Math.max(0, Math.round((guide.y - offsetY) / scale)),
      width: Math.min(video.videoWidth, Math.round(guide.width / scale)),
      height: Math.min(video.videoHeight, Math.round(guide.height / scale)),
    };
    source.width = Math.max(1, Math.min(source.width, video.videoWidth - source.x));
    source.height = Math.max(1, Math.min(source.height, video.videoHeight - source.y));

    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) {
      setCameraError('촬영 이미지를 만들지 못했습니다.');
      return;
    }
    context.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, source.width, source.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((nextBlob) => resolve(nextBlob), 'image/jpeg', 0.92);
    });
    if (!blob) {
      setCameraError('촬영 이미지를 저장하지 못했습니다.');
      return;
    }
    const file = new File([blob], `business-card-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
    closeScanner();
    await prepareSelectedFile(file);
  }

  function updateFormField(key: keyof typeof formState, value: string) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  function applyImportForEdit(item: BusinessCardImportResult) {
    if (!item.extracted) return;
    setCurrentImport({
      importId: item.importId,
      status: item.status,
      extracted: item.extracted,
      error: item.error || null,
    });
    setFormState(formStateFromBusinessCardExtraction(item.extracted));
    setWorkflowMessage('');
    setActiveTab('capture');
  }

  async function processPreparedImage(image: BusinessCardPreparedImage) {
    if (!actor) {
      setWorkflowMessage('로그인 정보를 확인하지 못해 자동 추출을 시작하지 못했습니다.');
      return;
    }
    if (!bffEnabled) {
      setWorkflowMessage('BFF API가 꺼져 있어 명함 추출을 실행할 수 없습니다.');
      return;
    }
    setProcessing(true);
    setWorkflowMessage('');
    try {
      const result = await processBusinessCardViaBff({
        tenantId,
        actor,
        upload: {
          fileName: image.fileName,
          mimeType: image.mimeType,
          fileSize: image.fileSize,
          contentBase64: image.contentBase64,
        },
      });
      applyImportForEdit(result);
      setWorkflowMessage('Gemini가 읽은 값을 아래에 채웠습니다. 필요한 부분만 수정한 뒤 DB에 저장하세요.');
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : '명함 추출 요청에 실패했습니다.');
    } finally {
      setProcessing(false);
    }
  }

  async function handleSaveContact() {
    if (!actor || !currentImport?.importId || !canSave) return;
    setSaving(true);
    setWorkflowMessage('');
    try {
      const result = await confirmBusinessCardImportViaBff({
        tenantId,
        actor,
        importId: currentImport.importId,
        contact: confirmPayload,
      });
      setWorkflowMessage(`연락처로 저장했습니다. contactId: ${result.contactId}`);
      setCurrentImport((current) => current ? { ...current, status: 'saved' } : current);
      setActiveTab('search');
      setSearchQuery(confirmPayload.name || confirmPayload.organization || confirmPayload.emails[0] || confirmPayload.phones[0] || '');
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : '연락처 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSearchContacts(nextQuery = searchQuery) {
    if (!actor || !bffEnabled) return;
    setSearching(true);
    setWorkflowMessage('');
    try {
      const result = await searchContactsViaBff({
        tenantId,
        actor,
        query: nextQuery.trim(),
      });
      setSearchResults(result.items);
      setContactDrafts(Object.fromEntries(result.items.map((item) => [item.id, contactToFormState(item)])));
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : '연락처 검색에 실패했습니다.');
    } finally {
      setSearching(false);
    }
  }

  function updateContactDraft(contactId: string, key: keyof BusinessCardContactFormState, value: string) {
    setContactDrafts((current) => ({
      ...current,
      [contactId]: {
        ...(current[contactId] || createEmptyContactFormState()),
        [key]: value,
      },
    }));
  }

  async function handleSaveSearchContact(contact: ContactSearchResult) {
    if (!actor || !bffEnabled) return;
    const draft = contactDrafts[contact.id] || contactToFormState(contact);
    const payload: BusinessCardConfirmPayload = buildBusinessCardConfirmPayload(draft);
    if (!canConfirmBusinessCardContact(payload)) {
      setWorkflowMessage('저장하려면 이름 또는 회사/소속 1개 이상, 이메일 또는 전화번호 1개 이상이 필요합니다.');
      return;
    }
    setSavingContactId(contact.id);
    setWorkflowMessage('');
    try {
      const result = await updateContactViaBff({
        tenantId,
        actor,
        contactId: contact.id,
        contact: payload,
      });
      setSearchResults((current) => current.map((item) => (item.id === contact.id ? result.contact : item)));
      setContactDrafts((current) => ({ ...current, [contact.id]: contactToFormState(result.contact) }));
      setWorkflowMessage('연락처를 DB에 저장했습니다.');
    } catch (error) {
      setWorkflowMessage(error instanceof Error ? error.message : '연락처 저장에 실패했습니다.');
    } finally {
      setSavingContactId('');
    }
  }

  function handleDownloadSearchResultsCsv() {
    if (searchResults.length === 0) return;
    const csv = `\uFEFF${buildContactsCsv(searchResults)}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `business-card-contacts-${date}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-dvh bg-[linear-gradient(135deg,#eef6ff_0%,#f8fbff_48%,#f3f7fb_100%)] px-4 py-6 dark:bg-[linear-gradient(135deg,#061a2f_0%,#0f172a_52%,#111827_100%)] md:px-6 md:py-8">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <section className="overflow-hidden rounded-lg border border-white/70 bg-white/55 shadow-xl shadow-slate-900/5 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/45">
          <div className="border-b border-white/40 bg-[#0f2747]/95 px-5 py-5 text-white md:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-sky-100/80">
                  LAB · Business Card DB
                </p>
                <h1 className="mt-2 text-[28px] font-extrabold leading-tight md:text-[36px]">
                  명함 DB
                </h1>
                <p className="mt-2 max-w-2xl text-[13px] leading-6 text-sky-50/85">
                  명함을 촬영하거나 업로드하면 Gemini가 자동으로 읽고, 바로 수정한 뒤 전사 연락처 DB에 저장합니다.
                </p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-sky-50 backdrop-blur-md">
                <Sparkles className="h-3.5 w-3.5" />
                Gemini 자동 추출
              </span>
            </div>
          </div>

          <div className="border-b border-white/50 px-5 py-4 md:px-7">
            <PwaInstallPrompt />
          </div>

          <div className="grid gap-5 px-5 py-5 md:grid-cols-[240px_1fr] md:px-7 md:py-6">
            <nav className="space-y-2">
              {TABS.map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-all ${
                      active
                        ? 'border-sky-200 bg-white/85 text-sky-950 shadow-md shadow-sky-900/10 dark:border-sky-400/30 dark:bg-sky-950/35 dark:text-sky-100'
                        : 'border-white/70 bg-white/45 text-slate-700 hover:border-sky-200 hover:bg-white/70 dark:border-white/10 dark:bg-slate-950/35 dark:text-slate-300 dark:hover:border-sky-400/20'
                    }`}
                  >
                    <span className="block text-[13px] font-bold">{tab.label}</span>
                    <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{tab.description}</span>
                  </button>
                );
              })}
            </nav>

            <main className="min-h-[420px] rounded-lg border border-white/70 bg-white/55 p-4 shadow-inner shadow-white/60 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/35 md:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[18px] font-extrabold text-slate-950 dark:text-slate-50">{activeTabMeta.label}</h2>
                  <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{activeTabMeta.description}</p>
                </div>
              </div>

              {activeTab === 'capture' && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="rounded-lg border border-dashed border-sky-200 bg-sky-50/55 p-4 dark:border-sky-400/25 dark:bg-sky-950/20">
                    <div className="flex min-h-[260px] flex-col items-center justify-center gap-4 text-center">
                      <button
                        type="button"
                        onClick={openScanner}
                        disabled={captureBusy}
                        className="flex h-20 w-20 touch-manipulation items-center justify-center rounded-full border border-sky-200 bg-white text-[#0f2747] shadow-sm transition hover:bg-sky-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 dark:border-sky-400/25 dark:bg-slate-950/70 dark:text-sky-100"
                        aria-label="명함 촬영 시작"
                      >
                        {captureBusy ? <Loader2 className="h-8 w-8 animate-spin" /> : <Camera className="h-8 w-8" />}
                      </button>
                      <div>
                        <h3 className="text-[16px] font-bold text-slate-950 dark:text-slate-50">명함 스캔</h3>
                        <p className="mt-2 max-w-md text-[13px] leading-6 text-muted-foreground">
                          카메라 버튼을 누르면 촬영 화면이 열립니다. 이미지가 준비되면 Gemini 분석이 자동으로 시작되고, 같은 화면에서 바로 수정해 저장합니다.
                        </p>
                      </div>
                      <Input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={captureBusy}>
                          <ImageIcon className="h-4 w-4" />
                          이미지 선택
                        </Button>
                      </div>
                      {busyLabel && (
                        <div className="w-full max-w-sm rounded-lg border border-sky-200 bg-white/80 px-3 py-3 text-left shadow-sm dark:border-sky-400/20 dark:bg-slate-950/45">
                          <div className="flex items-center gap-2 text-[12px] font-semibold text-[#0f2747] dark:text-sky-100">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {busyLabel}
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                            <div className="h-full w-2/3 animate-pulse rounded-full bg-[#0f2747] dark:bg-sky-300" />
                          </div>
                        </div>
                      )}
                      {imageError && (
                        <p className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700 dark:border-rose-400/20 dark:bg-rose-950/25 dark:text-rose-200">
                          <AlertTriangle className="h-4 w-4" />
                          {imageError}
                        </p>
                      )}
                    </div>
                  </div>

                  <aside className="rounded-lg border border-white/70 bg-white/65 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-950/45">
                    <h3 className="flex items-center gap-2 text-[13px] font-bold text-slate-950 dark:text-slate-50">
                      <UserRoundCheck className="h-4 w-4 text-sky-600" />
                      업로드 미리보기
                    </h3>
                    {preparedImage ? (
                      <div className="mt-3 space-y-3">
                        <img
                          src={preparedImage.previewUrl}
                          alt="명함 미리보기"
                          className="aspect-[1.58/1] w-full rounded-lg border border-slate-200 object-cover dark:border-white/10"
                        />
                        <dl className="space-y-2 text-[12px]">
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">파일명</dt>
                            <dd className="max-w-[180px] truncate font-semibold text-slate-900 dark:text-slate-100">{preparedImage.fileName}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">형식</dt>
                            <dd className="font-semibold text-slate-900 dark:text-slate-100">{preparedImage.mimeType}</dd>
                          </div>
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">용량</dt>
                            <dd className="font-semibold text-slate-900 dark:text-slate-100">{formatBytes(preparedImage.fileSize)}</dd>
                          </div>
                        </dl>
                        <div className="rounded-lg border border-sky-200/70 bg-sky-50/70 px-3 py-2 text-[11px] leading-5 text-[#0f2747] dark:border-sky-400/20 dark:bg-sky-950/25 dark:text-sky-100">
                          업로드되면 Gemini가 자동으로 추출합니다. 결과는 아래 입력칸에서 수정할 수 있습니다.
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex min-h-[240px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white/40 px-4 text-center text-[12px] leading-5 text-muted-foreground dark:border-white/10 dark:bg-slate-950/25">
                        선택한 명함 이미지가 여기에 표시됩니다.
                      </div>
                    )}
                  </aside>
                  <div className="lg:col-span-2">
                    {workflowMessage && (
                      <div className="mb-4 rounded-lg border border-sky-200/70 bg-sky-50/75 px-3 py-2 text-[12px] font-semibold text-sky-800 dark:border-sky-400/20 dark:bg-sky-950/25 dark:text-sky-200">
                        {workflowMessage}
                      </div>
                    )}

                    {currentImport?.extracted && (
                      <section className="rounded-lg border border-white/70 bg-white/70 p-4 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-950/45">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="text-[15px] font-extrabold text-slate-950 dark:text-slate-50">추출값 수정 및 DB 저장</h3>
                            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                              Gemini가 읽은 값을 필요하면 수정하세요. 저장하면 전사 연락처 검색 DB에 반영됩니다.
                            </p>
                          </div>
                          <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-[#0f2747] dark:border-sky-400/20 dark:bg-sky-950/25 dark:text-sky-100">
                            {currentImport.status === 'saved' ? '저장됨' : currentImport.status === 'failed' ? '실패' : '수정 가능'}
                          </span>
                        </div>

                        {currentImport.extracted.warnings.length > 0 && (
                          <div className="mt-3 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[12px] leading-5 text-amber-800 dark:border-amber-400/20 dark:bg-amber-950/25 dark:text-amber-200">
                            {currentImport.extracted.warnings.join(' · ')}
                          </div>
                        )}

                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {[
                            ['name', '이름', currentImport.extracted.name],
                            ['organization', '회사/소속', currentImport.extracted.organization],
                            ['department', '부서', currentImport.extracted.department],
                            ['title', '직함', currentImport.extracted.title],
                            ['role', '직책/역할', currentImport.extracted.role],
                            ['website', '웹사이트', currentImport.extracted.website],
                          ].map(([key, label, field]) => (
                            <label key={String(key)} className="space-y-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
                              <span className="flex items-center gap-2">
                                {label as string}
                                {isLowConfidenceField(field as typeof currentImport.extracted.name) && (
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">확인 필요</span>
                                )}
                              </span>
                              <Input
                                value={formState[key as keyof typeof formState]}
                                onChange={(event) => updateFormField(key as keyof typeof formState, event.target.value)}
                              />
                            </label>
                          ))}
                          <label className="space-y-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
                            이메일
                            <Input value={formState.emailsText} onChange={(event) => updateFormField('emailsText', event.target.value)} placeholder="email@example.com, ..." />
                          </label>
                          <label className="space-y-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200">
                            전화번호
                            <Input value={formState.phonesText} onChange={(event) => updateFormField('phonesText', event.target.value)} placeholder="010-0000-0000, ..." />
                          </label>
                          <label className="space-y-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 md:col-span-2">
                            주소
                            <Input value={formState.address} onChange={(event) => updateFormField('address', event.target.value)} />
                          </label>
                          <label className="space-y-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200 md:col-span-2">
                            메모
                            <Input value={formState.memo} onChange={(event) => updateFormField('memo', event.target.value)} />
                          </label>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                          <p className="text-[11px] text-muted-foreground">
                            저장 조건: 이름 또는 회사/소속 1개 이상, 이메일 또는 전화번호 1개 이상
                          </p>
                          <Button type="button" onClick={handleSaveContact} disabled={!canSave || saving || currentImport.status === 'saved'}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            DB 저장
                          </Button>
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'search' && (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2 md:flex-row">
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleSearchContacts();
                      }}
                      placeholder="이름, 회사, 이메일, 전화번호 검색. 비워두면 전체 목록"
                    />
                    <Button type="button" onClick={() => void handleSearchContacts()} disabled={searching || !bffEnabled}>
                      {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      검색
                    </Button>
                    <Button type="button" variant="outline" onClick={handleDownloadSearchResultsCsv} disabled={searchResults.length === 0}>
                      <Download className="h-4 w-4" />
                      Excel CSV
                    </Button>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-white/70 bg-white/65 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-950/35">
                    {searchResults.length === 0 ? (
                      <div className="flex min-h-[180px] flex-col items-center justify-center px-4 text-center">
                        <Search className="h-8 w-8 text-sky-600 dark:text-sky-300" />
                        <h3 className="mt-3 text-[15px] font-bold text-slate-950 dark:text-slate-50">
                          {searching ? '연락처를 불러오는 중' : '전사 연락처 DB'}
                        </h3>
                        <p className="mt-2 max-w-md text-[12px] leading-5 text-muted-foreground">
                          검색어 없이 조회하면 연락처 목록이 먼저 표시됩니다.
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-white/70 dark:divide-white/10">
                        {searchResults.map((contact) => {
                          const draft = contactDrafts[contact.id] || contactToFormState(contact);
                          const draftPayload = buildBusinessCardConfirmPayload(draft);
                          const canSaveContact = canConfirmBusinessCardContact(draftPayload);
                          const isSavingContact = savingContactId === contact.id;
                          return (
                            <section key={contact.id} className="px-3 py-3 md:px-4">
                              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-[13px] font-bold text-slate-950 dark:text-slate-50">{draft.name || draft.organization || '이름 없음'}</p>
                                  <p className="mt-1 text-[11px] text-muted-foreground">
                                    {[draft.organization, draft.department, draft.title || draft.role].filter(Boolean).join(' · ') || contact.id}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void handleSaveSearchContact(contact)}
                                  disabled={!canSaveContact || isSavingContact}
                                >
                                  {isSavingContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                                  저장
                                </Button>
                              </div>
                              <div className="grid gap-2 md:grid-cols-4">
                                {[
                                  ['name', '이름'],
                                  ['organization', '회사/소속'],
                                  ['department', '부서'],
                                  ['title', '직함'],
                                  ['role', '역할'],
                                  ['emailsText', '이메일'],
                                  ['phonesText', '전화번호'],
                                  ['website', '웹사이트'],
                                ].map(([key, label]) => (
                                  <label key={`${contact.id}-${key}`} className="space-y-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                                    {label}
                                    <Input
                                      value={draft[key as keyof BusinessCardContactFormState]}
                                      onChange={(event) => updateContactDraft(contact.id, key as keyof BusinessCardContactFormState, event.target.value)}
                                      className="h-9 bg-white text-[12px] dark:bg-slate-950/60"
                                    />
                                  </label>
                                ))}
                                <label className="space-y-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 md:col-span-2">
                                  주소
                                  <Input
                                    value={draft.address}
                                    onChange={(event) => updateContactDraft(contact.id, 'address', event.target.value)}
                                    className="h-9 bg-white text-[12px] dark:bg-slate-950/60"
                                  />
                                </label>
                                <label className="space-y-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 md:col-span-2">
                                  메모
                                  <Textarea
                                    value={draft.memo}
                                    onChange={(event) => updateContactDraft(contact.id, 'memo', event.target.value)}
                                    className="min-h-9 bg-white text-[12px] dark:bg-slate-950/60"
                                  />
                                </label>
                              </div>
                              <p className="mt-2 text-[10px] text-muted-foreground">
                                저장 조건: 이름 또는 회사/소속 1개 이상, 이메일 또는 전화번호 1개 이상 · score {contact.score.toFixed(2)}
                              </p>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

            </main>
          </div>
        </section>
      </div>
      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950 md:items-center md:bg-slate-950/80 md:p-6">
          <div className="relative flex h-dvh w-full max-w-md flex-col overflow-hidden bg-slate-950 text-white md:h-[760px] md:rounded-lg md:border md:border-white/10">
            <div className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-4 py-3">
              <Button type="button" size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={closeScanner} aria-label="스캐너 닫기">
                <X className="h-5 w-5" />
              </Button>
              <span className="rounded-full bg-black/35 px-3 py-1 text-[12px] font-semibold backdrop-blur-md">명함을 가이드 안에 맞춰주세요</span>
              <span className="h-10 w-10" aria-hidden="true" />
            </div>
            <div className="relative flex-1 overflow-hidden">
              {cameraStream ? (
                <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  {cameraStarting ? <Loader2 className="h-8 w-8 animate-spin" /> : <Camera className="h-8 w-8" />}
                  <p className="text-[13px] text-white/80">{cameraError || '카메라를 여는 중입니다.'}</p>
                </div>
              )}
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,transparent_42%,rgba(2,6,23,0.52)_74%)]" />
              <div
                className="pointer-events-none absolute rounded-[6px] border-2 border-sky-300 bg-sky-300/10 shadow-[0_0_0_999px_rgba(2,6,23,0.42)]"
                style={{
                  left: `${CAMERA_GUIDE.left * 100}%`,
                  top: `${CAMERA_GUIDE.top * 100}%`,
                  width: `${CAMERA_GUIDE.width * 100}%`,
                  aspectRatio: String(CAMERA_GUIDE.aspectRatio),
                }}
              >
                <span className="absolute -left-0.5 -top-0.5 h-5 w-5 border-l-4 border-t-4 border-sky-100" />
                <span className="absolute -right-0.5 -top-0.5 h-5 w-5 border-r-4 border-t-4 border-sky-100" />
                <span className="absolute -bottom-0.5 -left-0.5 h-5 w-5 border-b-4 border-l-4 border-sky-100" />
                <span className="absolute -bottom-0.5 -right-0.5 h-5 w-5 border-b-4 border-r-4 border-sky-100" />
              </div>
            </div>
            <div className="z-20 border-t border-white/10 bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+18px)] pt-4 text-slate-950">
              {cameraError && (
                <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-center text-[12px] font-semibold text-rose-700">
                  {cameraError}
                </p>
              )}
              <div className="flex items-center justify-center gap-6">
                <Button type="button" variant="ghost" className="h-12 w-12 rounded-full" onClick={() => fileInputRef.current?.click()} aria-label="이미지 선택">
                  <ImageIcon className="h-5 w-5" />
                </Button>
                <button
                  type="button"
                  onClick={handleCaptureFromScanner}
                  disabled={!cameraStream || cameraStarting}
                  className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-slate-950 bg-white disabled:opacity-50"
                  aria-label="명함 촬영"
                >
                  <span className="h-10 w-10 rounded-full bg-[#0f2747] shadow-inner" />
                </button>
                <span className="h-12 w-12" aria-hidden="true" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
