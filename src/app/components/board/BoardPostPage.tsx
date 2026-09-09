import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  ArrowBigUp,
  ArrowBigDown,
  MessageCircle,
  Pencil,
  Reply,
  Trash2,
} from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Separator } from '../ui/separator';
import { EmptyState } from '../ui/empty-state';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { useAuth } from '../../data/auth-store';
import { useBoard } from '../../data/board-store';
import type { BoardChannel, BoardComment } from '../../data/types';
import { BOARD_CHANNEL_LABELS } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';
import { featureFlags } from '../../config/feature-flags';
import { getOrgCollectionPath, getOrgDocumentPath } from '../../lib/firebase';

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '-';
  return d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function groupReplies(comments: BoardComment[]) {
  const byParent = new Map<string, BoardComment[]>();
  const roots: BoardComment[] = [];
  for (const c of comments) {
    if (c.deletedAt) continue;
    const parentId = c.parentId || '';
    if (!parentId) {
      roots.push(c);
      continue;
    }
    const list = byParent.get(parentId) || [];
    list.push(c);
    byParent.set(parentId, list);
  }
  return { roots, byParent };
}

export function BoardPostPage() {
  const { postId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { posts, votePost, addComment, updatePost, deletePost, updateComment, deleteComment, buildVoteDocId } = useBoard();
  const { db, isOnline, orgId } = useFirebase();
  const basePath = location.pathname.startsWith('/portal/') ? '/portal/board' : '/board';

  const [comments, setComments] = useState<BoardComment[]>([]);
  const [myVote, setMyVote] = useState<-1 | 0 | 1>(0);
  const [content, setContent] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState('');

  // Post edit/delete state
  const [showEditPost, setShowEditPost] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', body: '', channel: 'general' as BoardChannel, tags: '' });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Comment edit/delete state
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editCommentBody, setEditCommentBody] = useState('');
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);

  const firestoreEnabled = featureFlags.firestoreCoreEnabled && isOnline && !!db && !!user?.uid;
  const id = String(postId || '');

  const post = useMemo(() => posts.find((p) => p.id === id) || null, [posts, id]);

  useEffect(() => {
    if (!firestoreEnabled || !db || !id) {
      setComments([]);
      return;
    }

    const q = query(
      collection(db, getOrgCollectionPath(orgId, 'boardComments')),
      where('postId', '==', id),
      orderBy('createdAt', 'asc'),
    );

    const unsub = onSnapshot(q, (snap) => {
      setComments(snap.docs.map((d) => d.data() as BoardComment));
    }, (err) => {
      console.error('[Board] comments listen error:', err);
    });

    return () => unsub();
  }, [firestoreEnabled, db, orgId, id]);

  useEffect(() => {
    if (!firestoreEnabled || !db || !id || !user?.uid) {
      setMyVote(0);
      return;
    }

    const voteId = buildVoteDocId(id, user.uid);
    const voteRef = doc(db, getOrgDocumentPath(orgId, 'boardVotes', voteId));
    const unsub: Unsubscribe = onSnapshot(voteRef, (snap) => {
      if (!snap.exists()) {
        setMyVote(0);
        return;
      }
      const v = snap.data()?.value;
      setMyVote(v === 1 ? 1 : v === -1 ? -1 : 0);
    }, () => setMyVote(0));
    return () => unsub();
  }, [firestoreEnabled, db, orgId, id, user?.uid, buildVoteDocId]);

  const threaded = useMemo(() => groupReplies(comments), [comments]);

  async function submitComment() {
    if (!content.trim() || !id) return;
    const created = await addComment(id, content);
    if (!created) return;
    if (!firestoreEnabled) setComments((prev) => [...prev, created]);
    setContent('');
  }

  async function submitReply(parentId: string) {
    if (!replyContent.trim() || !id) return;
    const created = await addComment(id, replyContent, parentId);
    if (!created) return;
    if (!firestoreEnabled) setComments((prev) => [...prev, created]);
    setReplyContent('');
    setReplyTo(null);
  }

  const isPostOwner = !!user && !!post && post.createdBy === user.uid;

  function openEditPost() {
    if (!post) return;
    setEditForm({
      title: post.title,
      body: post.body,
      channel: post.channel,
      tags: (post.tags || []).join(', '),
    });
    setShowEditPost(true);
  }

  async function handleEditPost() {
    if (!id || !editForm.title.trim() || !editForm.body.trim()) return;
    const tags = editForm.tags
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 10);
    await updatePost(id, {
      title: editForm.title.trim(),
      body: editForm.body.trim(),
      channel: editForm.channel,
      tags,
    });
    setShowEditPost(false);
  }

  async function handleDeletePost() {
    if (!id) return;
    await deletePost(id);
    setShowDeleteConfirm(false);
    navigate(basePath);
  }

  function startEditComment(c: BoardComment) {
    setEditingCommentId(c.id);
    setEditCommentBody(c.body);
  }

  async function handleEditComment() {
    if (!editingCommentId || !editCommentBody.trim()) return;
    await updateComment(editingCommentId, editCommentBody.trim());
    if (!firestoreEnabled) {
      setComments((prev) => prev.map((c) =>
        c.id !== editingCommentId ? c : { ...c, body: editCommentBody.trim(), updatedAt: new Date().toISOString() },
      ));
    }
    setEditingCommentId(null);
    setEditCommentBody('');
  }

  async function handleDeleteComment(commentId: string) {
    if (!id) return;
    await deleteComment(id, commentId);
    if (!firestoreEnabled) {
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    }
    setDeletingCommentId(null);
  }

  if (!id || !post) {
    return (
      <Card>
        <EmptyState
          icon={MessageCircle}
          title="글을 찾을 수 없습니다"
          description="삭제되었거나 접근할 수 없는 글입니다."
          action={{ label: '게시판으로', onClick: () => navigate(basePath), icon: ArrowLeft }}
          variant="compact"
        />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" className="gap-1.5 -ml-2" onClick={() => navigate(basePath)}>
        <ArrowLeft className="w-4 h-4" />
        게시판으로
      </Button>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-12 shrink-0 flex flex-col items-center justify-start pt-0.5">
              <Button
                variant={myVote === 1 ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={async () => {
                  const result = await votePost(post.id, 'up');
                  if (result.ok) setMyVote(result.value);
                }}
              >
                <ArrowBigUp className="w-4 h-4" />
              </Button>
              <p className="text-[12px]" style={{ fontWeight: 800 }}>{post.voteScore || 0}</p>
              <Button
                variant={myVote === -1 ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={async () => {
                  const result = await votePost(post.id, 'down');
                  if (result.ok) setMyVote(result.value);
                }}
              >
                <ArrowBigDown className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-muted/20">
                  {BOARD_CHANNEL_LABELS[post.channel]}
                </Badge>
                <h1 className="text-[18px] leading-tight" style={{ fontWeight: 900, letterSpacing: '-0.03em' }}>
                  {post.title}
                </h1>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                <span style={{ fontWeight: 600 }}>{post.createdByName}</span>
                <span>·</span>
                <span>{fmtTime(post.createdAt)}</span>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <MessageCircle className="w-3.5 h-3.5" />
                  {post.commentCount || 0}
                </span>
              </div>

              {(post.tags || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(post.tags || []).map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px] h-4 px-1.5">
                      #{t}
                    </Badge>
                  ))}
                </div>
              )}

              {isPostOwner && (
                <div className="flex items-center gap-1.5 mt-2">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={openEditPost}>
                    <Pencil className="w-3.5 h-3.5" />
                    수정
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px] text-destructive hover:text-destructive" onClick={() => setShowDeleteConfirm(true)}>
                    <Trash2 className="w-3.5 h-3.5" />
                    삭제
                  </Button>
                </div>
              )}
            </div>
          </div>

          <Separator />

          <div className="text-[13px] leading-relaxed whitespace-pre-wrap">
            {post.body}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-[12px]" style={{ fontWeight: 800 }}>댓글</p>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="댓글을 입력하세요"
            className="min-h-[90px]"
          />
          <div className="flex justify-end">
            <Button onClick={submitComment} disabled={!content.trim()}>
              댓글 등록
            </Button>
          </div>

          <Separator />

          {threaded.roots.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">아직 댓글이 없습니다.</p>
          ) : (
            <div className="space-y-3">
              {threaded.roots.map((c) => {
                const replies = threaded.byParent.get(c.id) || [];
                return (
                  <div key={c.id} className="space-y-2">
                    <div className="rounded-lg border bg-background p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] text-muted-foreground">
                          <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{c.createdByName}</span>
                          <span className="mx-1">·</span>
                          <span>{fmtTime(c.createdAt)}</span>
                          {c.updatedAt !== c.createdAt && <span className="ml-1 text-[10px]">(수정됨)</span>}
                        </div>
                        <div className="flex items-center gap-1">
                          {user && c.createdBy === user.uid && (
                            <>
                              <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => startEditComment(c)}>
                                <Pencil className="w-3 h-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 text-[11px] text-destructive hover:text-destructive"
                                onClick={() => setDeletingCommentId(c.id)}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </>
                          )}
                          <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setReplyTo((prev) => (prev === c.id ? null : c.id))}>
                            <Reply className="w-3.5 h-3.5" />
                            답글
                          </Button>
                        </div>
                      </div>

                      {editingCommentId === c.id ? (
                        <div className="mt-2 space-y-2">
                          <Textarea
                            value={editCommentBody}
                            onChange={(e) => setEditCommentBody(e.target.value)}
                            className="min-h-[80px]"
                          />
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => { setEditingCommentId(null); setEditCommentBody(''); }}>
                              취소
                            </Button>
                            <Button size="sm" onClick={handleEditComment} disabled={!editCommentBody.trim()}>
                              저장
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-2 text-[13px] whitespace-pre-wrap">{c.body}</p>
                      )}

                      {deletingCommentId === c.id && (
                        <div className="mt-2 flex items-center gap-2 p-2 rounded bg-destructive/10 text-[12px]">
                          <span>이 댓글을 삭제하시겠습니까?</span>
                          <Button variant="destructive" size="sm" className="h-6 text-[11px]" onClick={() => handleDeleteComment(c.id)}>
                            삭제
                          </Button>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setDeletingCommentId(null)}>
                            취소
                          </Button>
                        </div>
                      )}

                      {replyTo === c.id && (
                        <div className="mt-3 space-y-2">
                          <Textarea
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            placeholder="답글을 입력하세요"
                            className="min-h-[80px]"
                          />
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => { setReplyTo(null); setReplyContent(''); }}>
                              취소
                            </Button>
                            <Button onClick={() => submitReply(c.id)} disabled={!replyContent.trim()}>
                              답글 등록
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {replies.length > 0 && (
                      <div className="pl-6 space-y-2">
                        {replies.map((r) => (
                          <div key={r.id} className="rounded-lg border bg-muted/20 p-3">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[11px] text-muted-foreground">
                                <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{r.createdByName}</span>
                                <span className="mx-1">·</span>
                                <span>{fmtTime(r.createdAt)}</span>
                                {r.updatedAt !== r.createdAt && <span className="ml-1 text-[10px]">(수정됨)</span>}
                              </div>
                              {user && r.createdBy === user.uid && (
                                <div className="flex items-center gap-1">
                                  <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => startEditComment(r)}>
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 text-[11px] text-destructive hover:text-destructive"
                                    onClick={() => setDeletingCommentId(r.id)}
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              )}
                            </div>

                            {editingCommentId === r.id ? (
                              <div className="mt-2 space-y-2">
                                <Textarea
                                  value={editCommentBody}
                                  onChange={(e) => setEditCommentBody(e.target.value)}
                                  className="min-h-[60px]"
                                />
                                <div className="flex justify-end gap-2">
                                  <Button variant="outline" size="sm" onClick={() => { setEditingCommentId(null); setEditCommentBody(''); }}>
                                    취소
                                  </Button>
                                  <Button size="sm" onClick={handleEditComment} disabled={!editCommentBody.trim()}>
                                    저장
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <p className="mt-2 text-[13px] whitespace-pre-wrap">{r.body}</p>
                            )}

                            {deletingCommentId === r.id && (
                              <div className="mt-2 flex items-center gap-2 p-2 rounded bg-destructive/10 text-[12px]">
                                <span>이 답글을 삭제하시겠습니까?</span>
                                <Button variant="destructive" size="sm" className="h-6 text-[11px]" onClick={() => handleDeleteComment(r.id)}>
                                  삭제
                                </Button>
                                <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setDeletingCommentId(null)}>
                                  취소
                                </Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 글 수정 다이얼로그 */}
      <Dialog open={showEditPost} onOpenChange={setShowEditPost}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>글 수정</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>채널</Label>
                <select
                  value={editForm.channel}
                  onChange={(e) => setEditForm((p) => ({ ...p, channel: e.target.value as BoardChannel }))}
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
                  value={editForm.tags}
                  onChange={(e) => setEditForm((p) => ({ ...p, tags: e.target.value }))}
                  placeholder="예: 결재, 예산"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>제목</Label>
              <Input
                value={editForm.title}
                onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>본문</Label>
              <Textarea
                value={editForm.body}
                onChange={(e) => setEditForm((p) => ({ ...p, body: e.target.value }))}
                className="min-h-[160px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditPost(false)}>취소</Button>
            <Button onClick={handleEditPost} disabled={!editForm.title.trim() || !editForm.body.trim()}>
              저장
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 글 삭제 확인 다이얼로그 */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>글 삭제</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            이 글을 삭제하시겠습니까? 삭제된 글은 게시판 목록에 표시되지 않습니다.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>취소</Button>
            <Button variant="destructive" onClick={handleDeletePost}>삭제</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
