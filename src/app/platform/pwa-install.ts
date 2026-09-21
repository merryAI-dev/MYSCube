export type PwaInstallPlatform = 'ios' | 'android' | 'desktop';

export interface PwaInstallTarget {
  platform: PwaInstallPlatform;
  endpoint: string;
  title: string;
  eyebrow: string;
  summary: string;
  primaryActionLabel: string;
  primaryActionHref: string;
  steps: string[];
  checks: string[];
}

const TARGETS: Record<PwaInstallPlatform, PwaInstallTarget> = {
  ios: {
    platform: 'ios',
    endpoint: '/install/ios',
    title: 'iPhone에서 MYSCube 설치',
    eyebrow: 'Safari · Add to Home Screen',
    summary: 'iPhone에서는 Safari의 홈 화면 추가 흐름을 사용합니다. 설치 후에는 브라우저 탭이 아니라 앱처럼 바로 열립니다.',
    primaryActionLabel: 'MYSCube 홈 열기',
    primaryActionHref: '/mobile-entry',
    steps: [
      'Safari에서 MYSCube 라이브 링크를 엽니다.',
      '공유 버튼을 누르고 홈 화면에 추가를 선택합니다.',
      'Open as Web App이 보이면 켠 상태로 추가합니다.',
      '홈 화면의 MYSCube 아이콘으로 다시 실행하면 서비스 홈 화면이 열립니다.',
    ],
    checks: [
      '주소창 없이 standalone 화면으로 열리는지 확인',
      'Google 로그인 후 기존 세션이 유지되는지 확인',
      '홈 화면에서 필요한 업무 메뉴를 열 수 있는지 확인',
    ],
  },
  android: {
    platform: 'android',
    endpoint: '/install/android',
    title: 'Android에서 MYSCube 설치',
    eyebrow: 'Chrome · Install app',
    summary: 'Android에서는 Chrome의 설치 버튼을 우선 사용합니다. Play Store 배포가 필요해지면 같은 PWA를 TWA로 감싸 배포합니다.',
    primaryActionLabel: 'MYSCube 홈 열기',
    primaryActionHref: '/mobile-entry',
    steps: [
      'Chrome에서 MYSCube 라이브 링크를 엽니다.',
      '주소창 또는 브라우저 메뉴의 앱 설치를 선택합니다.',
      '설치된 MYSCube 아이콘으로 다시 실행하면 서비스 홈 화면이 열립니다.',
      '홈 화면에서 필요한 업무 메뉴를 선택합니다.',
    ],
    checks: [
      '런처 아이콘에서 standalone 화면으로 열리는지 확인',
      '서비스 워커가 API 응답과 첨부파일을 캐시하지 않는지 확인',
      'TWA 전환 시 Digital Asset Links 검증이 통과할 준비가 되었는지 확인',
    ],
  },
  desktop: {
    platform: 'desktop',
    endpoint: '/install',
    title: 'MYSCube 설치',
    eyebrow: 'PWA · Install endpoint',
    summary: '기기별 설치 경로를 안내합니다. iPhone은 Safari 홈 화면 추가, Android는 Chrome 설치 흐름을 사용합니다.',
    primaryActionLabel: 'MYSCube 열기',
    primaryActionHref: '/',
    steps: [
      '현재 기기에 맞는 설치 안내를 선택합니다.',
      '설치 후 MYSCube 아이콘으로 앱을 실행합니다.',
      '모바일과 데스크톱 모두 서비스 홈 화면에서 시작합니다.',
    ],
    checks: [
      'manifest 아이콘이 192px, 512px, maskable 512px로 제공되는지 확인',
      'HTTPS 라이브 도메인에서 service worker가 등록되는지 확인',
      '설치 후 start_url이 정상적으로 앱 첫 화면을 여는지 확인',
    ],
  },
};

export function getPwaInstallPlatform(userAgent: string): PwaInstallPlatform {
  const ua = String(userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (ua.includes('android')) return 'android';
  return 'desktop';
}

export function getPwaInstallPlatformFromPath(pathname: string): PwaInstallPlatform | null {
  const path = String(pathname || '').toLowerCase().replace(/\/+$/, '');
  if (path === '/install/ios') return 'ios';
  if (path === '/install/android') return 'android';
  if (path === '/install') return null;
  return null;
}

export function getPwaInstallTarget(platform: PwaInstallPlatform): PwaInstallTarget {
  return TARGETS[platform];
}

export function resolvePwaInstallTarget(pathname: string, userAgent: string): PwaInstallTarget {
  return getPwaInstallTarget(getPwaInstallPlatformFromPath(pathname) || getPwaInstallPlatform(userAgent));
}

export function isStandaloneDisplay(mediaQueryResult: Pick<MediaQueryList, 'matches'> | null | undefined): boolean {
  return Boolean(mediaQueryResult?.matches);
}
