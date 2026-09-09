import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { PlatformApiError } from '../../platform/api-client';
import { fetchProjectClosureDriveViaBff, type ProjectClosureDriveContents as DriveContents } from '../../lib/platform-bff-client';
import { Button } from '../ui/button';
import { requestGoogleDriveMetadataAccess } from '../../platform/google-drive-metadata-access';

export function ProjectClosureDriveContents({ projectId, link }: { projectId: string; link?: string }) {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const [contents, setContents] = useState<DriveContents | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsConnection, setNeedsConnection] = useState(true);
  const [needsPermission, setNeedsPermission] = useState(false);
  const token = useRef('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setContents(null);
    setLoading(false);
    setError('');
    token.current = '';
    setNeedsConnection(true);
    setNeedsPermission(false);
    return () => { generation.current += 1; token.current = ''; };
  }, [projectId, link, orgId, user?.uid]);

  async function load(pageToken?: string) {
    if (!user || loading) return;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    setNeedsPermission(false);
    try {
      if (!token.current) {
        const accessToken = await requestGoogleDriveMetadataAccess(user.uid);
        if (current !== generation.current) return;
        token.current = accessToken;
        setNeedsConnection(false);
      }
      const result = await fetchProjectClosureDriveViaBff({ tenantId: orgId, actor: user, projectId, link, pageToken, googleAccessToken: token.current });
      if (current === generation.current) setContents(result);
    } catch (cause) {
      if (current === generation.current) {
        setContents(null);
        if (!(cause instanceof PlatformApiError) || cause.code === 'project_closure_google_reconnect' || cause.code === 'project_closure_google_account_mismatch') {
          token.current = '';
          setNeedsConnection(true);
        }
        setNeedsPermission(cause instanceof PlatformApiError && ['project_closure_drive_forbidden', 'project_closure_drive_not_found'].includes(cause.code));
        setError(cause instanceof PlatformApiError && cause.code.startsWith('project_closure_')
          ? cause.serverMessage || '프로젝트 연결 폴더와 조회 권한을 확인해 주세요.'
          : cause instanceof Error && !(cause instanceof PlatformApiError) ? cause.message
          : '자료 목록을 확인하지 못했습니다. 연결 상태와 Drive 공유 권한을 확인한 뒤 다시 조회해 주세요.');
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  return <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-[12px]" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-semibold text-slate-800">Drive 자료 목록</p>
      <Button type="button" variant="outline" size="sm" disabled={!user || loading} onClick={() => void load()}>
        {loading ? '조회 중…' : needsConnection ? 'Google 연결 후 조회' : contents ? '처음부터 다시 조회' : '자료 목록 조회'}
      </Button>
    </div>
    <p className="text-slate-500">본인의 Google 권한으로 연결 폴더 바로 아래 자료를 조회합니다. 파일 수정·삭제나 공유 권한 변경은 하지 않습니다.</p>
    {!user ? <p role="status">로그인 후 자료 목록을 조회할 수 있습니다.</p> : null}
    {loading ? <p role="status">자료 목록을 불러오고 있습니다.</p> : null}
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
    {needsPermission ? <div role="status" className="text-slate-600">
      <p>폴더가 이동·삭제되었거나 접근 권한이 없을 수 있습니다. 현재 로그인한 Google 계정으로 폴더를 열어 소유자에게 뷰어 권한을 요청해 주세요.</p>
      {(() => {
        try {
          const url = new URL(link || '');
          const id = url.protocol === 'https:' && url.hostname === 'drive.google.com' && !url.username && !url.password && !url.port
            ? url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{1,200})\/?$/)?.[1] : null;
          return id ? <a className="text-blue-700 underline" href={`https://drive.google.com/drive/folders/${id}`} target="_blank" rel="noopener noreferrer">Drive에서 열어 접근 권한 요청</a> : <p>프로젝트 담당자에게 연결 폴더와 공유 권한을 확인해 주세요.</p>;
        } catch { return null; }
      })()}
    </div> : null}
    {contents && !loading ? <>
      {contents.items.length === 0 ? <p role="status">이 페이지에 표시할 파일이나 폴더가 없습니다.</p> : <ul className="divide-y divide-slate-100">
        {contents.items.map((item) => <li key={item.id} className="flex items-start gap-2 py-2">
          <span className="shrink-0 text-slate-500">{item.mimeType === 'application/vnd.google-apps.folder' ? '폴더' : '파일'}</span>
          <a className="break-all text-blue-700 underline underline-offset-2" href={item.mimeType === 'application/vnd.google-apps.folder'
            ? `https://drive.google.com/drive/folders/${encodeURIComponent(item.id)}`
            : `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`} target="_blank" rel="noopener noreferrer">{item.name}</a>
        </li>)}
      </ul>}
      {contents.nextPageToken ? <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load(contents.nextPageToken!)}>다음 페이지</Button> : null}
    </> : null}
  </div>;
}
