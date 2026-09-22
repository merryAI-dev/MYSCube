import { useMemo } from 'react';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { createWorkbenchClient } from '../../lib/workbench-client';

export function useWorkbench() {
  const { user, isLoading } = useAuth();
  const { orgId } = useFirebase();
  const client = useMemo(() => createWorkbenchClient({ tenantId: orgId || 'mysc', actor: {
    uid: user?.uid || '', email: user?.email, role: user?.role, idToken: user?.idToken,
  } }), [orgId, user?.uid, user?.email, user?.role, user?.idToken]);
  return { client, ready: !isLoading && Boolean(user?.uid), isAdmin: user?.role === 'admin', scope: `${orgId}:${user?.uid}:${user?.role}` };
}
