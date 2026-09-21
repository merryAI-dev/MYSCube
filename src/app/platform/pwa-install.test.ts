import { describe, expect, it } from 'vitest';
import {
  getPwaInstallPlatform,
  getPwaInstallPlatformFromPath,
  getPwaInstallTarget,
  isStandaloneDisplay,
  resolvePwaInstallTarget,
} from './pwa-install';

describe('pwa-install', () => {
  it('detects iOS from iPhone and iPad user agents', () => {
    expect(getPwaInstallPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1')).toBe('ios');
    expect(getPwaInstallPlatform('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1')).toBe('ios');
  });

  it('detects Android from Chrome user agents', () => {
    expect(getPwaInstallPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36')).toBe('android');
  });

  it('falls back to desktop for non-mobile user agents', () => {
    expect(getPwaInstallPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/125.0 Safari/537.36')).toBe('desktop');
  });

  it('maps explicit install endpoints to platform targets', () => {
    expect(getPwaInstallPlatformFromPath('/install/ios')).toBe('ios');
    expect(getPwaInstallPlatformFromPath('/install/android')).toBe('android');
    expect(getPwaInstallPlatformFromPath('/install')).toBeNull();
  });

  it('prefers explicit endpoint path over user-agent detection', () => {
    const target = resolvePwaInstallTarget('/install/android', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)');

    expect(target.platform).toBe('android');
    expect(target.endpoint).toBe('/install/android');
  });

  it('returns platform-specific install copy', () => {
    expect(getPwaInstallTarget('ios').steps.join(' ')).toContain('홈 화면에 추가');
    expect(getPwaInstallTarget('ios').steps.join(' ')).toContain('서비스 홈 화면이 열립니다');
    expect(getPwaInstallTarget('android').summary).toContain('TWA');
    expect(getPwaInstallTarget('desktop').steps.join(' ')).toContain('모바일과 데스크톱 모두 서비스 홈 화면');
  });

  it('reads standalone display mode', () => {
    expect(isStandaloneDisplay({ matches: true })).toBe(true);
    expect(isStandaloneDisplay({ matches: false })).toBe(false);
    expect(isStandaloneDisplay(null)).toBe(false);
  });
});
