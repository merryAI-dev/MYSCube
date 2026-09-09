// ═══════════════════════════════════════════════════════════════
// MYSC — Firebase 연결 설정 & Firestore 시딩 UI
// ═══════════════════════════════════════════════════════════════

import { useState, useEffect } from 'react';
import {
  Database, Wifi, WifiOff, CloudUpload, CheckCircle2,
  XCircle, Loader2, AlertTriangle, Trash2, Server,
  RefreshCw, Shield, Eye, EyeOff,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import { useFirebase } from '../../lib/firebase-context';
import type { FirebaseConfig } from '../../lib/firebase';
import { seedAll, getCollectionCounts, type SeedProgress } from '../../lib/firestore-seed';
import { toast } from 'sonner';

// ── 연결 상태 표시 ──

function ConnectionStatus() {
  const { status, config, error, isOnline, orgId, isUsingEnvConfig } = useFirebase();

  const statusMap = {
    disconnected: { icon: WifiOff, label: '미연결', color: 'bg-gray-100 text-gray-700', dot: 'bg-gray-400' },
    connecting: { icon: Loader2, label: '연결 중...', color: 'bg-blue-50 text-blue-700', dot: 'bg-blue-400' },
    connected: { icon: Wifi, label: '연결됨', color: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
    error: { icon: XCircle, label: '오류', color: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
  };

  const s = statusMap[status];
  const Icon = s.icon;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg ${s.color}`}>
      <div className={`w-2.5 h-2.5 rounded-full ${s.dot} ${status === 'connecting' ? 'animate-pulse' : ''}`} />
      <Icon className={`w-4 h-4 ${status === 'connecting' ? 'animate-spin' : ''}`} />
      <div className="flex-1">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>{s.label}</span>
        {isOnline && config?.projectId && (
          <span className="text-[11px] ml-2 opacity-70">
            프로젝트: {config.projectId}
          </span>
        )}
        {isOnline && (
          <span className="text-[11px] ml-2 opacity-70">
            org: {orgId}
          </span>
        )}
        {isUsingEnvConfig && (
          <p className="text-[11px] mt-0.5 opacity-70">환경변수 기반 구성 사용 중</p>
        )}
        {error && (
          <p className="text-[11px] mt-0.5 text-red-600">{error}</p>
        )}
      </div>
    </div>
  );
}

// ── Firebase 설정 폼 ──

function ConfigForm() {
  const { connect, disconnect, status, config: currentConfig } = useFirebase();
  const [show, setShow] = useState(false);
  const [config, setConfig] = useState<FirebaseConfig>({
    apiKey: currentConfig?.apiKey || '',
    authDomain: currentConfig?.authDomain || '',
    projectId: currentConfig?.projectId || '',
    storageBucket: currentConfig?.storageBucket || '',
    messagingSenderId: currentConfig?.messagingSenderId || '',
    appId: currentConfig?.appId || '',
  });

  useEffect(() => {
    if (currentConfig) {
      setConfig(currentConfig);
    }
  }, [currentConfig]);

  const handleConnect = async () => {
    if (!config.apiKey || !config.projectId || !config.authDomain) {
      toast.error('apiKey, authDomain, projectId는 필수입니다.');
      return;
    }
    const ok = await connect(config);
    if (ok) {
      toast.success('Firebase 연결 성공!');
    } else {
      toast.error('Firebase 연결 실패');
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setConfig({ apiKey: '', authDomain: '', projectId: '', storageBucket: '', messagingSenderId: '', appId: '' });
    toast.info('Firebase 연결 해제됨');
  };

  const fields: { key: keyof FirebaseConfig; label: string; required?: boolean }[] = [
    { key: 'apiKey', label: 'API Key', required: true },
    { key: 'authDomain', label: 'Auth Domain', required: true },
    { key: 'projectId', label: 'Project ID', required: true },
    { key: 'storageBucket', label: 'Storage Bucket' },
    { key: 'messagingSenderId', label: 'Messaging Sender ID' },
    { key: 'appId', label: 'App ID' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[13px]" style={{ fontWeight: 600 }}>Firebase 프로젝트 설정</h4>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => setShow(!show)}
        >
          {show ? <EyeOff className="w-3 h-3 mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
          {show ? '숨기기' : '설정 보기'}
        </Button>
      </div>

      {show && (
        <div className="space-y-2">
          {fields.map(({ key, label, required }) => (
            <div key={key}>
              <label className="text-[11px] text-muted-foreground">
                {label} {required && <span className="text-red-500">*</span>}
              </label>
              <Input
                className="h-8 text-[12px] font-mono"
                placeholder={`firebase-${key}-here`}
                value={config[key]}
                onChange={(e) => setConfig(prev => ({ ...prev, [key]: e.target.value }))}
                type={key === 'apiKey' ? 'password' : 'text'}
                disabled={status === 'connected'}
              />
            </div>
          ))}

          <div className="flex gap-2 pt-1">
            {status !== 'connected' ? (
              <Button
                size="sm"
                className="h-8 text-[12px]"
                onClick={handleConnect}
                disabled={status === 'connecting'}
              >
                {status === 'connecting' ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Wifi className="w-3.5 h-3.5 mr-1" />
                )}
                연결
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                className="h-8 text-[12px]"
                onClick={handleDisconnect}
              >
                <WifiOff className="w-3.5 h-3.5 mr-1" />
                연결 해제
              </Button>
            )}
          </div>

          <div className="mt-2 p-2 bg-amber-50 rounded text-[11px] text-amber-800">
            <AlertTriangle className="w-3 h-3 inline mr-1" />
            Firebase Console &gt; 프로젝트 설정 &gt; 일반에서 웹 앱 구성 정보를 복사하세요.
            Firestore Security Rules에서 적절한 권한을 설정해야 합니다.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Firestore 시딩 ──

function SeedPanel() {
  const { db, isOnline, orgId } = useFirebase();
  const [seeding, setSeeding] = useState(false);
  const [progress, setProgress] = useState<SeedProgress | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);

  const refreshCounts = async () => {
    if (!db) return;
    setLoadingCounts(true);
    try {
      const c = await getCollectionCounts(db, orgId);
      setCounts(c);
    } catch (err) {
      toast.error('컬렉션 카운트 조회 실패');
    }
    setLoadingCounts(false);
  };

  const handleSeed = async () => {
    if (!db) return;
    setSeeding(true);
    setProgress(null);

    const result = await seedAll(db, orgId, (p) => setProgress(p));

    if (result.success) {
      toast.success(`시딩 완료! ${result.totalDocs}개 문서 업로드됨`);
      refreshCounts();
    } else {
      toast.error(`시딩 실패: ${result.error}`);
    }
    setSeeding(false);
  };

  if (!isOnline) {
    return (
      <div className="p-3 bg-gray-50 rounded-lg text-center text-[12px] text-muted-foreground">
        Firebase에 연결한 후 데이터 시딩을 할 수 있습니다.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[13px]" style={{ fontWeight: 600 }}>Firestore 데이터 시딩</h4>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={refreshCounts}
          disabled={loadingCounts}
        >
          {loadingCounts ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3 mr-1" />
          )}
          카운트 확인
        </Button>
      </div>

      {/* 컬렉션 카운트 */}
      {counts && (
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          {Object.entries(counts).map(([key, count]) => (
            <div key={key} className="flex items-center justify-between p-1.5 bg-muted/50 rounded">
              <span className="text-muted-foreground font-mono">{key}</span>
              <Badge variant={count > 0 ? 'default' : 'secondary'} className="h-4 text-[10px]">
                {count === -1 ? 'ERR' : count}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* 시딩 버튼 */}
      <div className="space-y-2">
        <Button
          onClick={handleSeed}
          disabled={seeding}
          className="w-full h-9 text-[12px]"
          variant={seeding ? 'secondary' : 'default'}
        >
          {seeding ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              {progress ? `${progress.step} (${progress.count}/${progress.total})` : '준비 중...'}
            </>
          ) : (
            <>
              <CloudUpload className="w-3.5 h-3.5 mr-1.5" />
              전체 데이터 시딩 (마스터시트 → Firestore)
            </>
          )}
        </Button>

        <p className="text-[10px] text-muted-foreground">
          직원(84명), 참여율 사업(13개), 참여율 배정(~125건), KOICA 프로젝트(7개+인력),
          메인 플랫폼 데이터(프로젝트/원장/거래/증빙/감사로그)를 Firestore에 일괄 업로드합니다.
          기존 데이터는 덮어씁니다.
        </p>
      </div>
    </div>
  );
}

// ── 메인 컴포넌트 ──

export function FirebaseSetup() {
  return (
    <Card className="shadow-sm border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-[15px]">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #f59e0b, #f97316)' }}>
            <Database className="w-4 h-4 text-white" />
          </div>
          Firebase / Firestore 연결
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConnectionStatus />
        <Separator />
        <ConfigForm />
        <Separator />
        <SeedPanel />
      </CardContent>
    </Card>
  );
}

// ── Compact 상태 표시 (사이드바용) ──

export function FirebaseStatusBadge() {
  const { status, isOnline, config } = useFirebase();

  if (status === 'disconnected') {
    return (
      <Badge variant="secondary" className="text-[10px] gap-1">
        <div className="w-1.5 h-1.5 rounded-full bg-gray-400" />
        로컬
      </Badge>
    );
  }

  if (status === 'connecting') {
    return (
      <Badge variant="secondary" className="text-[10px] gap-1 animate-pulse">
        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        연결중
      </Badge>
    );
  }

  if (status === 'connected') {
    return (
      <Badge className="text-[10px] gap-1 bg-green-600">
        <div className="w-1.5 h-1.5 rounded-full bg-white" />
        Firestore
      </Badge>
    );
  }

  return (
    <Badge variant="destructive" className="text-[10px] gap-1">
      <div className="w-1.5 h-1.5 rounded-full bg-white" />
      오류
    </Badge>
  );
}
