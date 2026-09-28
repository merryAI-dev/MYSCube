import { describe, expect, it } from 'vitest';
import { resolveReactRuntime } from './react-runtime-config.mjs';

describe('React runtime activation boundary', () => {
  const production = { WORKBENCH_APP_ORIGIN: 'https://studio.example.com', WORKBENCH_REACT_RUNTIME_URL: 'https://render.example.net/runtime', WORKBENCH_REACT_RUNTIME_VERIFIED: 'true' };
  it('leaves React execution disabled without affecting HTML when no runtime is configured', () => expect(resolveReactRuntime({})).toBeNull());
  it('requires the operator verification gate for real execution', () => expect(() => resolveReactRuntime({ ...production, WORKBENCH_REACT_RUNTIME_VERIFIED: 'false' })).toThrow(/verified/));
  it('cannot enable browser execution in production with a verification flag alone', () => expect(() => resolveReactRuntime(production)).toThrow(/container runtime/));
  it.each(['https://render.example.com/runtime', 'http://render.example.net/runtime', 'https://127.0.0.1/runtime', 'https://user:secret@render.example.net/runtime', 'https://render.example.net/runtime?token=value'])('refuses a same-site or unsafe runtime %s', (url) => expect(() => resolveReactRuntime({ ...production, WORKBENCH_REACT_RUNTIME_URL: url })).toThrow());
  it('uses public suffixes rather than comparing host strings', () => expect(() => resolveReactRuntime({ ...production, WORKBENCH_APP_ORIGIN: 'https://studio.company.co.kr', WORKBENCH_REACT_RUNTIME_URL: 'https://preview.company.co.kr/runtime' })).toThrow());
  it('permits separate loopback ports only in an explicit demo emulator environment', () => {
    const local = { WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_REACT_RUNTIME_URL: 'http://localhost:8792/runtime', WORKBENCH_PROJECT_ID: 'demo-react', WORKBENCH_AUTH_MODE: 'emulator' };
    expect(resolveReactRuntime(local)).toMatchObject({ local: true });
    expect(() => resolveReactRuntime({ ...local, WORKBENCH_AUTH_MODE: 'production' })).toThrow();
  });
});
