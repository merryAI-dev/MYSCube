import React from 'react';
import {act, create} from 'react-test-renderer';
import {describe,it,expect,vi} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
vi.mock('./OnboardingGuide',()=>({OnboardingGuide:()=>React.createElement('section',{'data-testid':'guide'},'개편안 · 운영 적용 전')}));
import {MembershipPending} from '../auth/MembershipPending';
import {OnboardingGuidePage} from './OnboardingGuidePage';
const auth=vi.hoisted(()=>({isLoading:false,isAuthenticated:true}));
vi.mock('../../data/auth-store',()=>({useAuth:()=>auth}));
vi.mock('react-router',()=>({Navigate:(p:any)=>React.createElement('a',{href:p.to},'login')}));
describe('informational guide preserves access boundary',()=>{
 it.each(['PENDING','INACTIVE','UNAVAILABLE'] as const)('returns to %s state without calling approval or logout',async issue=>{
  const retry=vi.fn(),logout=vi.fn();let r:any;
  await act(async()=>{r=create(React.createElement(MembershipPending,{issue,email:'synthetic@example.com',onRetry:retry,onLogout:logout}))});
  await act(async()=>r.root.findAllByType('button').find((b:any)=>String(b.props.children).includes('개편안')).props.onClick());
  expect(r.root.findByProps({'data-testid':'guide'})).toBeTruthy();expect(retry).not.toHaveBeenCalled();expect(logout).not.toHaveBeenCalled();
  await act(async()=>r.root.findByType('button').props.onClick());
  expect(r.root.findAllByProps({'data-testid':'guide'})).toHaveLength(0);
  await act(async()=>r.root.findAllByType('button').find((b:any)=>b.props.children==='승인 상태 다시 확인').props.onClick());expect(retry).toHaveBeenCalledOnce();
  await act(async()=>r.unmount());
 });
 it('guards active route while loading or signed out',async()=>{
  let r:any;auth.isLoading=true;await act(async()=>{r=create(React.createElement(OnboardingGuidePage))});expect(r.root.findByProps({role:'status'})).toBeTruthy();
  auth.isLoading=false;auth.isAuthenticated=false;await act(async()=>r.update(React.createElement(OnboardingGuidePage)));expect(r.root.findByType('a').props.href).toBe('/login');
  auth.isAuthenticated=true;await act(async()=>r.update(React.createElement(OnboardingGuidePage)));expect(r.root.findByProps({'data-testid':'guide'})).toBeTruthy();await act(async()=>r.unmount());
 });
 it('ships all referenced media and preserves actual captions',()=>{
 const html=readFileSync(resolve('src/app/components/onboarding-guide/content.html'),'utf8');
 for(const [,p] of html.matchAll(/(?:src|href|poster)="(\/guides\/onboarding\/media\/[^\"]+)"/g))expect(existsSync(resolve('public'+p))).toBe(true);
 const captions=readFileSync(resolve('public/guides/onboarding/media/ko.vtt'),'utf8');expect(captions.startsWith('WEBVTT')).toBe(true);
 });
});
