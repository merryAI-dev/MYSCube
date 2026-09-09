import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Upload, FileText, Loader2, CheckCircle2, Send, BookOpen, Lock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { Separator } from '../ui/separator';
import { useAuth } from '../../data/auth-store';
import { useAppStore } from '../../data/store';
import { isPlatformApiEnabled } from '../../lib/platform-bff-client';
import {
  uploadGuide, calibrateGuide, finalizeGuide, getCurrentGuide,
  type GuideMetadata, type CalibrateResponse,
} from '../../lib/guide-api';
import { extractTextFromPdf } from '../../lib/pdf-extract';
import { warmPdfJs } from '../../platform/lazy-heavy-modules';

interface CalibrationMsg { role: 'user' | 'assistant'; content: string }

export function GuideUploadTab() {
  const { user } = useAuth();
  const { org } = useAppStore();

  const [guideInfo, setGuideInfo] = useState<GuideMetadata | null>(null);
  const [loading, setLoading] = useState(false);

  // Upload state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [sourceType, setSourceType] = useState<'pdf' | 'text' | 'markdown'>('text');
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);

  // Calibration state
  const [calibrationGuideId, setCalibrationGuideId] = useState('');
  const [calibrationMessages, setCalibrationMessages] = useState<CalibrationMsg[]>([]);
  const [calibrationInput, setCalibrationInput] = useState('');
  const [calibrating, setCalibrating] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [maxTurns, setMaxTurns] = useState(3);
  const [finalizing, setFinalizing] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  const bffEnabled = isPlatformApiEnabled();

  const actorParams = useCallback(() => ({
    tenantId: org?.id || 'mysc',
    actor: { uid: user?.uid || '', email: user?.email || '', role: user?.role || '' },
  }), [org?.id, user]);

  // Load current guide info
  useEffect(() => {
    if (!bffEnabled || !user) return;
    setLoading(true);
    getCurrentGuide(actorParams())
      .then(res => setGuideInfo(res.guide))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [bffEnabled, user, actorParams]);

  // File handler
  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    if (file.name.endsWith('.pdf')) {
      setSourceType('pdf');
      setExtracting(true);
      try {
        const text = await extractTextFromPdf(file);
        setContent(text);
        if (!title) setTitle(file.name.replace(/\.pdf$/i, ''));
      } catch (err) {
        setContent(`[PDF 텍스트 추출 실패: ${(err as Error).message}]`);
      } finally {
        setExtracting(false);
      }
    } else {
      setSourceType(file.name.endsWith('.md') ? 'markdown' : 'text');
      const text = await file.text();
      setContent(text);
      if (!title) setTitle(file.name.replace(/\.(txt|md)$/i, ''));
    }
  }, [title]);

  // Upload
  const handleUpload = useCallback(async () => {
    if (!content.trim() || !title.trim() || uploading) return;
    setUploading(true);
    try {
      const res = await uploadGuide({
        ...actorParams(),
        title: title.trim(),
        content: content.trim(),
        sourceType,
        sourceFileName: fileName || undefined,
      });
      setCalibrationGuideId(res.id);
      setCalibrationMessages([]);
      setTurnCount(0);
      setGuideInfo({
        id: res.id,
        title: title.trim(),
        status: 'CALIBRATING',
        sourceType,
        charCount: res.charCount,
        calibrationTurns: 0,
        hasCalibrationSummary: false,
        uploadedByName: user?.email || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Clear upload form
      setContent('');
      setFileName('');
    } catch (err) {
      alert(`업로드 실패: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [content, title, sourceType, fileName, uploading, actorParams, user]);

  // Calibrate
  const handleCalibrate = useCallback(async () => {
    if (!calibrationInput.trim() || calibrating) return;
    const msg = calibrationInput.trim();
    setCalibrationInput('');
    setCalibrationMessages(prev => [...prev, { role: 'user', content: msg }]);
    setCalibrating(true);
    try {
      const res = await calibrateGuide({
        ...actorParams(),
        guideId: calibrationGuideId || undefined,
        message: msg,
      });
      setCalibrationMessages(prev => [...prev, { role: 'assistant', content: res.answer }]);
      setTurnCount(res.turnCount);
      setMaxTurns(res.maxTurns);
      if (!calibrationGuideId) setCalibrationGuideId(res.guideId);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      setCalibrationMessages(prev => [...prev, { role: 'assistant', content: `오류: ${(err as Error).message}` }]);
    } finally {
      setCalibrating(false);
    }
  }, [calibrationInput, calibrating, calibrationGuideId, actorParams]);

  // Finalize
  const handleFinalize = useCallback(async () => {
    if (finalizing) return;
    setFinalizing(true);
    try {
      await finalizeGuide({ ...actorParams(), guideId: calibrationGuideId || undefined });
      setGuideInfo(prev => prev ? { ...prev, status: 'READY' } : prev);
      setCalibrationMessages([]);
      setCalibrationGuideId('');
    } catch (err) {
      alert(`확정 실패: ${(err as Error).message}`);
    } finally {
      setFinalizing(false);
    }
  }, [finalizing, calibrationGuideId, actorParams]);

  if (!bffEnabled) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Lock className="w-8 h-8 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm font-semibold">BFF 활성화 필요</p>
          <p className="text-xs text-muted-foreground mt-1">
            VITE_PLATFORM_API_ENABLED=true 설정 후 BFF 서버를 실행해 주세요.
          </p>
        </CardContent>
      </Card>
    );
  }

  const isCalibrating = guideInfo?.status === 'CALIBRATING' || calibrationGuideId;

  return (
    <div className="space-y-4">
      {/* Current guide info */}
      {guideInfo && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="w-4 h-4" />
              현재 등록된 가이드
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium">{guideInfo.title}</span>
              <Badge variant={guideInfo.status === 'READY' ? 'default' : 'secondary'}>
                {guideInfo.status === 'READY' ? '활성' : '캘리브레이션 중'}
              </Badge>
              <span className="text-muted-foreground">
                {guideInfo.charCount.toLocaleString()}자
              </span>
              {guideInfo.calibrationTurns > 0 && (
                <span className="text-muted-foreground">
                  캘리브레이션 {guideInfo.calibrationTurns}턴
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload new guide */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="w-4 h-4" />
            새 가이드 업로드
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>제목</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="예: 2026 사업비 가이드"
            />
          </div>
          <div className="space-y-1.5">
            <Label>파일 업로드 (.pdf, .txt, .md)</Label>
            <Input
              type="file"
              accept=".pdf,.txt,.md"
              onClick={() => warmPdfJs()}
              onFocus={() => warmPdfJs()}
              onChange={handleFile}
            />
            {extracting && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> PDF 텍스트 추출 중...
              </p>
            )}
            {!extracting && (
              <p className="text-xs text-muted-foreground">
                PDF는 첫 업로드 때 분석 엔진을 먼저 준비한 뒤 내용을 읽습니다.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>또는 직접 붙여넣기</Label>
            <textarea
              className="w-full min-h-[120px] rounded-md border px-3 py-2 text-sm resize-y bg-background"
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="가이드 텍스트를 여기에 붙여넣으세요..."
            />
            {content && (
              <p className="text-xs text-muted-foreground">{content.length.toLocaleString()}자</p>
            )}
          </div>
          <Button
            onClick={handleUpload}
            disabled={!title.trim() || !content.trim() || uploading}
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Upload className="w-4 h-4 mr-1" />}
            업로드 (캘리브레이션 시작)
          </Button>
        </CardContent>
      </Card>

      {/* Calibration chat */}
      {isCalibrating && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" />
                캘리브레이션 ({turnCount}/{maxTurns}턴)
              </CardTitle>
              <Button
                variant="default"
                size="sm"
                onClick={handleFinalize}
                disabled={finalizing}
              >
                {finalizing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                확정하기
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              가이드에 대해 궁금한 점을 질문하세요. 이 대화는 향후 Q&A 품질 향상에 반영됩니다.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Messages */}
            <div className="max-h-[320px] overflow-y-auto space-y-2 rounded-md border p-3 bg-muted/30">
              {calibrationMessages.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  가이드에 대해 질문해 보세요. (예: "출장비 정산 기준이 뭐야?")
                </p>
              )}
              {calibrationMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`text-sm p-2.5 rounded-lg max-w-[85%] ${
                    msg.role === 'user'
                      ? 'ml-auto bg-primary text-primary-foreground'
                      : 'bg-background border'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </div>
              ))}
              {calibrating && (
                <div className="bg-background border text-sm p-2.5 rounded-lg max-w-[85%] flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span className="text-muted-foreground">답변 생성 중...</span>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="flex gap-2">
              <Input
                value={calibrationInput}
                onChange={e => setCalibrationInput(e.target.value)}
                placeholder="가이드에 대해 질문하세요..."
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCalibrate(); } }}
                disabled={calibrating || turnCount >= maxTurns}
              />
              <Button
                size="icon"
                onClick={handleCalibrate}
                disabled={!calibrationInput.trim() || calibrating || turnCount >= maxTurns}
              >
                <Send className="w-4 h-4" />
              </Button>
            </div>
            {turnCount >= maxTurns && (
              <p className="text-xs text-amber-600">최대 턴 수에 도달했습니다. "확정하기"를 눌러주세요.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
