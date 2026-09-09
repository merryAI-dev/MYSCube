import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Loader2, BookOpen, Lock, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { PageHeader } from '../layout/PageHeader';
import { useAuth } from '../../data/auth-store';
import { isPlatformApiEnabled } from '../../lib/platform-bff-client';
import {
  askGuide, getCurrentGuide, listGuideQA,
  type GuideMetadata, type AskResponse,
} from '../../lib/guide-api';
import type { GuideQA } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';

export function GuideChatPage() {
  const { user } = useAuth();
  const { orgId } = useFirebase();

  const [guideInfo, setGuideInfo] = useState<GuideMetadata | null>(null);
  const [qaList, setQaList] = useState<GuideQA[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bffEnabled = isPlatformApiEnabled();

  const actorParams = useCallback(() => ({
    tenantId: orgId || 'mysc',
    actor: { uid: user?.uid || '', email: user?.email || '', role: user?.role || '' },
  }), [orgId, user]);

  // Load guide info + Q&A history
  useEffect(() => {
    if (!bffEnabled || !user) { setInitialLoading(false); return; }

    Promise.all([
      getCurrentGuide(actorParams()),
      listGuideQA({ ...actorParams(), limit: 100 }),
    ])
      .then(([guideRes, qaRes]) => {
        setGuideInfo(guideRes.guide);
        setQaList(qaRes.items.reverse()); // oldest first for chat
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false));
  }, [bffEnabled, user, actorParams]);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [qaList.length]);

  const handleAsk = useCallback(async () => {
    if (!question.trim() || asking) return;
    const q = question.trim();
    setQuestion('');
    setError('');
    setAsking(true);

    // Optimistic: show user question immediately
    const tempQa: GuideQA = {
      id: `temp_${Date.now()}`,
      guideId: guideInfo?.id || '',
      question: q,
      answer: '',
      askedBy: user?.uid || '',
      askedByName: user?.email || '',
      askedByRole: user?.role || '',
      createdAt: new Date().toISOString(),
    };
    setQaList(prev => [...prev, tempQa]);

    try {
      const res = await askGuide({
        ...actorParams(),
        question: q,
        guideId: guideInfo?.id,
      });
      // Replace temp with real
      setQaList(prev => prev.map(qa =>
        qa.id === tempQa.id
          ? { ...qa, id: res.id, answer: res.answer, tokensUsed: res.tokensUsed }
          : qa,
      ));
    } catch (err) {
      setError((err as Error).message || '질문 처리 중 오류 발생');
      // Remove failed temp
      setQaList(prev => prev.filter(qa => qa.id !== tempQa.id));
    } finally {
      setAsking(false);
    }
  }, [question, asking, guideInfo, user, actorParams]);

  // ── Gate: BFF disabled ──
  if (!bffEnabled) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={MessageCircle}
          iconGradient="linear-gradient(135deg, #0f766e, #2dd4bf)"
          title="사업비 가이드 Q&A"
          description="사업비 가이드에 대해 질문하세요"
        />
        <Card>
          <CardContent className="py-12 text-center">
            <Lock className="w-8 h-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold">BFF 활성화 필요</p>
            <p className="text-xs text-muted-foreground mt-1">
              VITE_PLATFORM_API_ENABLED=true 설정 후 BFF 서버를 실행해 주세요.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Gate: No guide uploaded or not ready ──
  const guideNotReady = !initialLoading && (!guideInfo || guideInfo.status !== 'READY');

  return (
    <div className="space-y-5">
      <PageHeader
        icon={MessageCircle}
        iconGradient="linear-gradient(135deg, #0f766e, #2dd4bf)"
        title="사업비 가이드 Q&A"
        description={guideInfo ? `가이드: ${guideInfo.title}` : '사업비 가이드에 대해 질문하세요'}
      />

      {guideNotReady ? (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold">
              {guideInfo ? '가이드 캘리브레이션 진행 중입니다' : '등록된 가이드가 없습니다'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              관리자가 사업비 가이드를 등록하고 확정해야 Q&A를 이용할 수 있습니다.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="flex flex-col" style={{ height: 'calc(100vh - 200px)', minHeight: 400 }}>
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {qaList.length === 0 && !initialLoading && (
              <div className="text-center py-12">
                <BookOpen className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  사업비 가이드에 대해 궁금한 점을 질문하세요.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  예: "출장비 정산 기준은?" / "인건비 증빙 서류 뭐가 필요해?"
                </p>
              </div>
            )}

            {qaList.map((qa) => (
              <div key={qa.id} className="space-y-2">
                {/* Question */}
                <div className="flex justify-end">
                  <div className="bg-primary text-primary-foreground text-sm p-3 rounded-2xl rounded-br-md max-w-[80%]">
                    <p className="whitespace-pre-wrap">{qa.question}</p>
                  </div>
                </div>
                {/* Answer */}
                {qa.answer ? (
                  <div className="flex justify-start">
                    <div className="bg-muted text-sm p-3 rounded-2xl rounded-bl-md max-w-[80%]">
                      <p className="whitespace-pre-wrap">{qa.answer}</p>
                      <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                        <span>{qa.askedByName}</span>
                        {qa.tokensUsed && <span>{qa.tokensUsed.toLocaleString()} tokens</span>}
                      </div>
                    </div>
                  </div>
                ) : asking ? (
                  <div className="flex justify-start">
                    <div className="bg-muted text-sm p-3 rounded-2xl rounded-bl-md flex items-center gap-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span className="text-muted-foreground">답변 생성 중...</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            <div ref={scrollRef} />
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-t">
              {error}
            </div>
          )}

          {/* Input */}
          <div className="border-t p-3 flex gap-2">
            <Input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="사업비 가이드에 대해 질문하세요..."
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); } }}
              disabled={asking}
              className="flex-1"
            />
            <Button
              size="icon"
              onClick={handleAsk}
              disabled={!question.trim() || asking}
            >
              {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
