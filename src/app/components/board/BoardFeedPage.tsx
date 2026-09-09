import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ArrowBigUp, ArrowBigDown, MessageCircle, MessagesSquare, Plus, Search } from 'lucide-react';
import { PageHeader } from '../layout/PageHeader';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Separator } from '../ui/separator';
import { useBoard } from '../../data/board-store';
import { previewText, sortBoardPosts, type BoardSort } from '../../data/board.helpers';
import { BOARD_CHANNEL_LABELS, type BoardChannel } from '../../data/types';

type ChannelFilter = 'all' | BoardChannel;

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function BoardFeedPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { posts, createPost, votePost } = useBoard();
  const basePath = location.pathname.startsWith('/portal/') ? '/portal/board' : '/board';

  const [sort, setSort] = useState<BoardSort>('hot');
  const [channel, setChannel] = useState<ChannelFilter>('all');
  const [q, setQ] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    channel: 'general' as BoardChannel,
    title: '',
    body: '',
    tags: '',
  });

  const nowIso = useMemo(() => new Date().toISOString(), []);

  const filtered = useMemo(() => {
    const queryText = q.trim().toLowerCase();
    return posts.filter((p) => {
      if (p.deletedAt) return false;
      if (channel !== 'all' && p.channel !== channel) return false;
      if (!queryText) return true;
      const hay = `${p.title}\n${p.body}\n${(p.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(queryText);
    });
  }, [posts, channel, q]);

  const sorted = useMemo(() => sortBoardPosts(filtered, sort, nowIso), [filtered, sort, nowIso]);

  async function handleCreate() {
    const created = await createPost({
      title: form.title,
      body: form.body,
      channel: form.channel,
      tagsInput: form.tags,
    });
    if (!created) return;
    setShowCreate(false);
    setForm({ channel: 'general', title: '', body: '', tags: '' });
    navigate(`${basePath}/${created.id}`);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="전사 게시판"
        description="질문, 아이디어, 도움요청을 한 곳에서 공유합니다"
        iconGradient="linear-gradient(135deg, #0f172a 0%, #334155 100%)"
        icon={MessagesSquare}
        badge={`${sorted.length}건`}
        actions={(
          <Button size="sm" className="h-8 text-[12px] gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus className="w-3.5 h-3.5" /> 새 글
          </Button>
        )}
      />

      <div className="flex flex-col md:flex-row gap-2 md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <Tabs value={sort} onValueChange={(v) => setSort(v as BoardSort)}>
            <TabsList>
              <TabsTrigger value="hot">HOT</TabsTrigger>
              <TabsTrigger value="new">최신</TabsTrigger>
              <TabsTrigger value="top">TOP</TabsTrigger>
              <TabsTrigger value="active">활동</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="hidden md:flex items-center gap-1.5">
            {(['all', 'general', 'qna', 'ideas', 'help', 'training'] as ChannelFilter[]).map((c) => (
              <Button
                key={c}
                variant={channel === c ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 text-[12px]"
                onClick={() => setChannel(c)}
              >
                {c === 'all' ? '전체' : BOARD_CHANNEL_LABELS[c]}
              </Button>
            ))}
          </div>
        </div>

        <div className="relative w-full md:max-w-sm">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="검색: 제목, 본문, 태그"
            className="pl-8"
          />
        </div>
      </div>

      <div className="md:hidden flex flex-wrap gap-1.5">
        {(['all', 'general', 'qna', 'ideas', 'help', 'training'] as ChannelFilter[]).map((c) => (
          <Button
            key={c}
            variant={channel === c ? 'secondary' : 'outline'}
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => setChannel(c)}
          >
            {c === 'all' ? '전체' : BOARD_CHANNEL_LABELS[c]}
          </Button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-[13px] text-muted-foreground">아직 글이 없습니다. 첫 글을 남겨보세요.</p>
          <Button className="mt-3 gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" /> 새 글
          </Button>
        </Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((post) => (
            <Card key={post.id} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3">
                <div className="flex gap-3">
                  <div className="w-12 shrink-0 flex flex-col items-center justify-start pt-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => votePost(post.id, 'up')}
                      aria-label="upvote"
                    >
                      <ArrowBigUp className="w-4 h-4" />
                    </Button>
                    <p className="text-[12px]" style={{ fontWeight: 800 }}>{post.voteScore || 0}</p>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => votePost(post.id, 'down')}
                      aria-label="downvote"
                    >
                      <ArrowBigDown className="w-4 h-4" />
                    </Button>
                  </div>

                  <div className="flex-1 min-w-0">
                    <button
                      className="text-left w-full"
                      onClick={() => navigate(`${basePath}/${post.id}`)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-muted/20">
                          {BOARD_CHANNEL_LABELS[post.channel]}
                        </Badge>
                        <h3 className="text-[14px] line-clamp-1" style={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
                          {post.title}
                        </h3>
                      </div>
                      <p className="text-[12px] text-muted-foreground line-clamp-2">
                        {previewText(post.body, 160)}
                      </p>
                    </button>

                    <div className="flex items-center justify-between mt-2 gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {(post.tags || []).slice(0, 5).map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px] h-4 px-1.5">
                            #{t}
                          </Badge>
                        ))}
                      </div>

                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
                        <span className="hidden sm:inline">{post.createdByName}</span>
                        <span>{fmtTime(post.lastActivityAt || post.createdAt)}</span>
                        <span className="inline-flex items-center gap-1">
                          <MessageCircle className="w-3.5 h-3.5" />
                          {post.commentCount || 0}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 글 작성</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>채널</Label>
                <select
                  value={form.channel}
                  onChange={(e) => setForm((p) => ({ ...p, channel: e.target.value as BoardChannel }))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  {Object.entries(BOARD_CHANNEL_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>태그 (선택)</Label>
                <Input
                  value={form.tags}
                  onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))}
                  placeholder="예: 결재, 예산, 회계"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>제목</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                placeholder="예: 사업비 증빙 기준 질문"
              />
            </div>

            <div className="space-y-1.5">
              <Label>본문</Label>
              <Textarea
                value={form.body}
                onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                placeholder="상황/질문/제안 내용을 구체적으로 적어주세요."
                className="min-h-[160px]"
              />
            </div>

            <Separator />
            <p className="text-[11px] text-muted-foreground">
              민감 정보(주민번호, 계좌번호 등)는 게시하지 마세요. 필요한 경우 담당자에게 별도 채널로 공유합니다.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>취소</Button>
            <Button onClick={handleCreate} disabled={!form.title.trim() || !form.body.trim()}>
              게시
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
