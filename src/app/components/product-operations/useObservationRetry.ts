import { useEffect } from 'react';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { readPlatformApiRuntimeConfig, toRequestActor } from '../../lib/platform-bff-client';
import { flushOperationObservations } from '../../platform/operation-observations';

export function useObservationRetry() {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  useEffect(() => {
    if (!user?.uid) return;
    const context = { tenantId: orgId || 'mysc', actor: toRequestActor(user), baseUrl: readPlatformApiRuntimeConfig().baseUrl };
    const retry = () => { void flushOperationObservations(context); };
    retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [orgId, user?.uid, user?.idToken]);
}
