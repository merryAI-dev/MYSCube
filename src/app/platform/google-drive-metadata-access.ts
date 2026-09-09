import { GoogleAuthProvider, reauthenticateWithPopup } from 'firebase/auth';
import { getAuthInstance } from '../lib/firebase';

export async function requestGoogleDriveMetadataAccess(uid: string): Promise<string> {
  const auth = getAuthInstance();
  if (!auth?.currentUser || auth.currentUser.uid !== uid) throw new Error('Google 계정으로 로그인한 뒤 연결해 주세요.');
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive.metadata.readonly');
  provider.setCustomParameters({ prompt: 'select_account' });
  let result;
  try {
    result = await reauthenticateWithPopup(auth.currentUser, provider);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new Error('Google 연결이 취소되었습니다. 원할 때 다시 연결해 주세요.');
    if (code === 'auth/popup-blocked') throw new Error('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 연결해 주세요.');
    if (code === 'auth/user-mismatch') throw new Error('현재 로그인 계정과 같은 Google 계정을 선택해 주세요.');
    throw new Error('Google 연결을 완료하지 못했습니다. 조직의 앱 접근 정책과 연결 상태를 확인해 주세요.');
  }
  if (auth.currentUser?.uid !== uid || result.user.uid !== uid) throw new Error('로그인 계정이 변경되었습니다. 현재 계정으로 다시 연결해 주세요.');
  const token = GoogleAuthProvider.credentialFromResult(result)?.accessToken;
  if (!token) throw new Error('Google 조회 동의를 확인하지 못했습니다. 다시 연결해 주세요.');
  return token;
}
