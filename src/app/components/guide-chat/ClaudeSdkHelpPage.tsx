import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Bot, Code2, Loader2, Send, Sparkles } from 'lucide-react';
import { PageHeader } from '../layout/PageHeader';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { isPlatformApiEnabled } from '../../lib/platform-bff-client';
import {
  askClaudeSdkHelp,
  getClaudeSdkHelpMeta,
  type ClaudeSdkHelpMeta,
} from '../../lib/claude-sdk-help-api';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: 'anthropic' | 'fallback';
  warning?: string;
  tokensUsed?: number;
}

export function ClaudeSdkHelpPage() {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const bffEnabled = isPlatformApiEnabled();

  const [meta, setMeta] = useState<ClaudeSdkHelpMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const attemptedMetaRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);

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
    if (!bffEnabled || !user || !user.idToken || attemptedMetaRef.current) {
      setLoading(false);
      return;
    }

    attemptedMetaRef.current = true;
    getClaudeSdkHelpMeta(actorParams)
      .then(setMeta)
      .catch((err) => setError((err as Error).message || '도움봇 정보를 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, [actorParams, bffEnabled, user]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const submitQuestion = useCallback(async (nextQuestion: string) => {
    const normalized = nextQuestion.trim();
    if (!normalized || asking) return;
    setQuestion('');
    setError('');
    setAsking(true);

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: normalized,
    };
    setMessages((prev) => [...prev, userMessage]);

    try {
      const result = await askClaudeSdkHelp({
        ...actorParams,
        question: normalized,
        history: [...messages, userMessage]
          .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
          .map((entry) => ({ role: entry.role, content: entry.content })),
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          content: result.answer,
          provider: result.provider,
          warning: result.warning,
          tokensUsed: result.tokensUsed,
        },
      ]);
    } catch (err) {
      setError((err as Error).message || '답변 생성에 실패했습니다.');
    } finally {
      setAsking(false);
    }
  }, [actorParams, asking, messages]);

  if (!bffEnabled) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={Bot}
          iconGradient="linear-gradient(135deg, #2563eb, #0f766e)"
          title="사업관리 메리"
          description="실제 홈페이지 흐름 기준으로 사업 설정, Drive 연결, Migration, 증빙 업로드 사용법을 안내합니다"
        />
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-semibold">BFF 활성화 필요</p>
            <p className="text-xs text-muted-foreground mt-1">
              `VITE_PLATFORM_API_ENABLED=true` 설정과 BFF 실행이 필요합니다.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Bot}
        iconGradient="linear-gradient(135deg, #2563eb, #0f766e)"
        title="사업관리 메리"
        description="실제 홈페이지 흐름 기준으로 사업 설정, Drive 연결, Migration, 증빙 업로드 사용법을 안내합니다"
      />

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="w-4 h-4" />
                빠른 시작
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {loading ? (
                <div className="text-xs text-muted-foreground">불러오는 중...</div>
              ) : (
                meta?.quickstartSteps.map((step, index) => (
                  <div key={step} className="rounded-md border p-2 text-xs">
                    <div className="font-semibold text-[11px] mb-1">Step {index + 1}</div>
                    <div className="text-muted-foreground whitespace-pre-wrap">{step}</div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <BookOpen className="w-4 h-4" />
                참고 레퍼런스
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {meta?.sourceFiles.map((source) => (
                <div key={source.path} className="rounded-md border p-2">
                  <div className="text-[11px] font-semibold">{source.label}</div>
                  <div className="text-[10px] text-muted-foreground">{source.path}</div>
                  <div className="text-[11px] mt-1 text-muted-foreground">{source.note}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Code2 className="w-4 h-4" />
                추천 질문
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {meta?.starterQuestions.map((item) => (
                <Button
                  key={item}
                  type="button"
                  variant="outline"
                  className="w-full h-auto justify-start whitespace-normal text-left text-xs py-2"
                  onClick={() => void submitQuestion(item)}
                  disabled={asking}
                >
                  {item}
                </Button>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="flex flex-col min-h-[640px]">
          <CardHeader className="pb-3 border-b">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-sm">대화</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  설치, 환경변수, SDK 초기화, 스트리밍 패턴, merry 코드 참고 경로까지 물어볼 수 있습니다.
                </p>
              </div>
              {meta?.model && <Badge variant="secondary">{meta.model}</Badge>}
            </div>
          </CardHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && !loading && (
              <div className="text-center py-16">
                <Bot className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">
                  사업 설정, 구글드라이브 연결, Migration, 증빙 업로드/동기화 사용법을 질문해보세요.
                </p>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className="space-y-2">
                <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl p-3 text-sm ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-br-md'
                        : 'bg-muted rounded-bl-md'
                    }`}
                  >
                    <pre className="whitespace-pre-wrap break-words font-sans">{message.content}</pre>
                    {message.role === 'assistant' && (
                      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                          {message.provider === 'anthropic' ? 'Merry 답변' : 'Merry 안내'}
                        </Badge>
                        {message.tokensUsed ? <span>{message.tokensUsed.toLocaleString()} tokens</span> : null}
                      </div>
                    )}
                    {message.warning && (
                      <div className="mt-2 text-[10px] text-amber-600">
                        {message.warning}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {asking && (
              <div className="flex justify-start">
                <div className="bg-muted text-sm p-3 rounded-2xl rounded-bl-md flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-muted-foreground">Claude가 답변을 정리하고 있습니다...</span>
                </div>
              </div>
            )}

            <div ref={scrollRef} />
          </div>

          {error && (
            <div className="px-4 py-2 text-xs text-destructive bg-destructive/10 border-t">
              {error}
            </div>
          )}

          <div className="border-t p-3 flex gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="예: merry 기준으로 ClaudeSDKClient 초기화 예시를 보여줘"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitQuestion(question);
                }
              }}
              disabled={asking}
              className="flex-1"
            />
            <Button
              size="icon"
              disabled={!question.trim() || asking}
              onClick={() => void submitQuestion(question)}
            >
              {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
