import { useEffect, useState } from 'react';
import { useProductOperations } from './useProductOperations';
import type { PublicIncident } from '../../lib/product-operations-client';
import { formatTime, statusLabels } from './labels';

export function ServiceGuidance() {
  const { client, ready } = useProductOperations();
  const [items, setItems] = useState<PublicIncident[] | null>(null);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let active = true;
    setItems(null); setError('');
    if (ready) void client.guidance().then((value) => { if (active) { setItems(value.items); setTruncated(value.truncated); } },
      (err) => { if (active) setError(err instanceof Error ? err.message : '안내를 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [client, ready]);
  return <section className="space-y-3" aria-label="서비스 이용 안내"><h2 className="font-semibold">서비스 이용 안내</h2>
    {error ? <p role="alert">{error}</p> : items === null ? <p role="status">안내를 불러오고 있습니다.</p> : !items.length ? <p className="text-sm text-muted-foreground">현재 공개된 진행 중 안내가 없습니다.</p> : items.map((item) => <article key={item.id} className="rounded-lg border bg-card p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{item.title}</h3><span className="text-xs">{statusLabels[item.status]}</span></div><p className="mt-2 whitespace-pre-wrap text-sm">{item.message}</p><p className="mt-2 whitespace-pre-wrap text-sm"><strong>이렇게 진행해 주세요: </strong>{item.nextAction}</p><p className="mt-3 text-xs text-muted-foreground">안내 수정 {formatTime(item.updatedAt)}</p></article>)}
    {truncated && <p className="text-sm">안내가 많아 일부만 표시합니다. 필요한 안내는 운영 담당자에게 확인해 주세요.</p>}
  </section>;
}
