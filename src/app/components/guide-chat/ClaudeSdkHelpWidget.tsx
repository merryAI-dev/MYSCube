import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Bot, Loader2, MessageCircleQuestion, Send, Sparkles, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { isPlatformApiEnabled } from '../../lib/platform-bff-client';
import {
  askClaudeSdkHelp,
  getClaudeSdkHelpMeta,
  type ClaudeSdkHelpMeta,
} from '../../lib/claude-sdk-help-api';

interface WidgetMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: 'anthropic' | 'fallback';
}

export function ClaudeSdkHelpWidget() {
  const location = useLocation();
  const { user, isAuthenticated } = useAuth();
  const { orgId } = useFirebase();
  const bffEnabled = isPlatformApiEnabled();

  const [open, setOpen] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [asking, setAsking] = useState(false);
  const [meta, setMeta] = useState<ClaudeSdkHelpMeta | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const attemptedMetaRef = useRef(false);

  const hidden = !bffEnabled
    || !isAuthenticated
    || !user
    || !user.idToken
    || location.pathname === '/login'
    || location.pathname === '/workspace-select';

  const actorParams = useMemo(() => ({
    tenantId: orgId || 'mysc',
    actor: {
      uid: user?.uid || '',
      email: user?.email || '',
      role: user?.role || '',
      idToken: user?.idToken,
    },
  }), [orgId, user?.uid, user?.email, user?.role, user?.idToken]);

  useEffect(() => {
    if (!open) {
      attemptedMetaRef.current = false;
      setError('');
    }
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, open]);

  useEffect(() => {
    if (!open || meta || loadingMeta || attemptedMetaRef.current || !actorParams.actor.idToken) return;
    attemptedMetaRef.current = true;
    setLoadingMeta(true);
    void getClaudeSdkHelpMeta(actorParams)
      .then(setMeta)
      .catch((err) => setError((err as Error).message || '도움 정보를 불러오지 못했습니다.'))
      .finally(() => setLoadingMeta(false));
  }, [actorParams, loadingMeta, meta, open]);

  const submitQuestion = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized || asking) return;
    const userMessage: WidgetMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: normalized,
    };

    setQuestion('');
    setError('');
    setAsking(true);
    setMessages((prev) => [...prev, userMessage]);

    try {
      const result = await askClaudeSdkHelp({
        ...actorParams,
        question: normalized,
        history: [...messages, userMessage].map((item) => ({
          role: item.role,
          content: item.content,
        })),
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: result.answer,
          provider: result.provider,
        },
      ]);
    } catch (err) {
      setError((err as Error).message || '답변 생성에 실패했습니다.');
    } finally {
      setAsking(false);
    }
  }, [actorParams, asking, messages]);

  if (hidden) return null;

  return (
    <>
      <div className="fixed right-5 bottom-5 z-[70] flex flex-col items-end gap-2">
        <div className="rounded-full bg-background/90 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm ring-1 ring-border/60 backdrop-blur">
          사용법 도움이 필요하면 물어보세요
        </div>
        <Button
          type="button"
          size="icon"
          className="h-14 w-14 rounded-full shadow-xl"
          onClick={() => setOpen((prev) => !prev)}
        >
          <Bot className="h-6 w-6" />
        </Button>
      </div>

      {open ? (
        <div className="fixed right-3 bottom-24 z-[70] flex w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl sm:right-5 sm:w-[380px] md:w-[420px]">
          <div className="border-b border-border/60 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <MessageCircleQuestion className="h-4 w-4" />
                  사업관리 메리
                </div>
                <p className="text-xs text-muted-foreground">
                  실제 홈페이지 흐름 기준으로 사업 설정, Drive 연결, Migration, 증빙 업로드 사용법을 안내합니다.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex h-[min(70vh,640px)] max-h-[calc(100dvh-8rem)] min-h-[440px] min-w-0 flex-col">
            <div className="shrink-0 border-b border-border/60 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Badge variant="secondary">사용법 중심</Badge>
                <Badge variant="outline">실제 화면 흐름 기반</Badge>
              </div>

              {loadingMeta ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  도움 정보를 불러오는 중...
                </div>
              ) : meta ? (
                <div className="space-y-2">
                  <div className="rounded-xl border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                    <div className="mb-2 flex items-center gap-1 font-semibold text-foreground">
                      <Sparkles className="h-3.5 w-3.5" />
                      기본 사용 가이드
                    </div>
                    <ol className="space-y-1.5">
                      {meta.quickstartSteps.slice(0, 4).map((step, index) => (
                        <li key={step} className="flex gap-2">
                          <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                            {index + 1}
                          </span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="text-xs font-semibold">바로 물어보기</div>
                  <div className="flex flex-wrap gap-2">
                    {meta.starterQuestions.slice(0, 4).map((item) => (
                      <Button
                        key={item}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto whitespace-normal text-left text-[11px]"
                        onClick={() => void submitQuestion(item)}
                        disabled={asking}
                      >
                        {item}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
                  예: “구글드라이브 연결은 어디서 하고 기본 폴더 생성은 어떻게 해?”
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm ${
                        message.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground'
                      }`}
                    >
                      <pre className="whitespace-pre-wrap break-words font-sans">{message.content}</pre>
                      {message.role === 'assistant' && message.provider && (
                        <div className="mt-2 text-[10px] text-muted-foreground">
                          {message.provider === 'anthropic' ? 'Merry 답변' : 'Merry 안내'}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}

              {asking && (
                <div className="flex justify-start">
                  <div className="rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      실제 사용 흐름 기준으로 답변을 정리하고 있습니다...
                    </div>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>

            {error && (
              <div className="shrink-0 border-t border-border/60 bg-destructive/10 px-4 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="shrink-0 border-t border-border/60 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
              <div className="flex gap-2">
                <Input
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="예: 기본 폴더 생성은 어디서 해? 업로드 후 동기화는 왜 필요해?"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void submitQuestion(question);
                    }
                  }}
                  disabled={asking}
                />
                <Button
                  type="button"
                  size="icon"
                  disabled={!question.trim() || asking}
                  onClick={() => void submitQuestion(question)}
                >
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
