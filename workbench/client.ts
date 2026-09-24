import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, type Auth } from 'firebase/auth';
import { createWorkbenchTransport } from './transport';

const configured = Boolean(import.meta.env.VITE_WORKBENCH_AUTH_PROJECT_ID && import.meta.env.VITE_WORKBENCH_AUTH_API_KEY);
export const demo = import.meta.env.DEV && import.meta.env.VITE_WORKBENCH_DEMO === 'true';
export const auth: Auth | null = configured ? getAuth(initializeApp({
  apiKey: import.meta.env.VITE_WORKBENCH_AUTH_API_KEY,
  authDomain: import.meta.env.VITE_WORKBENCH_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_WORKBENCH_AUTH_PROJECT_ID,
}, 'isolated-workbench')) : null;
export const subscribe = (callback: (actorId: string | null) => void) => {
  if (demo) { callback('demo-admin'); return () => {}; }
  if (!auth) { callback(null); return () => {}; }
  return onAuthStateChanged(auth, (user) => callback(user?.uid || null));
};
export const login = () => auth ? signInWithPopup(auth, new GoogleAuthProvider()) : Promise.reject(new Error('독립 제작 공간의 로그인 연결 설정이 필요합니다.'));
export const logout = () => auth ? signOut(auth) : Promise.resolve();
let storage: Storage | undefined;
try { storage = window.sessionStorage; } catch { /* In-memory operation keys remain available when browser storage is denied. */ }
const transport = createWorkbenchTransport({ actor: () => demo ? 'demo-admin' : auth?.currentUser?.uid || null, token: async () => auth?.currentUser?.getIdToken(), storage });
export const workbenchRequest = transport.request;
export const recoverWorkbenchRequests = transport.recover;
export const recoverWorkbenchRequest = transport.recoverOne;
export const acknowledgeWorkbenchRequest = transport.acknowledge;
export const request = (path: string, method = 'GET', body?: unknown) => workbenchRequest(`/html-work-pages${path}`, method, body);
