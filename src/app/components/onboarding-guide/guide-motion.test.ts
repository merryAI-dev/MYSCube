import { describe, it, expect, vi } from 'vitest';
import { connectGuideMotion } from './guide-motion';
function fixture(reduced: boolean) {
  const images = Array.from({length:4}, (_, i) => ({src:`${i}.png`,dataset:{gif:`${i}.gif`,poster:`${i}.png`}}));
  const events = new Map<string, () => void>();
  const toggle = {textContent:'',setAttribute:vi.fn(),addEventListener:(_:string,f:()=>void)=>events.set('click',f),removeEventListener:vi.fn()};
  const status = {textContent:''};
  const root = {querySelectorAll:()=>images,querySelector:(s:string)=>s.includes('toggle')?toggle:status};
  const preference = {matches:reduced,addEventListener:(_:string,f:()=>void)=>events.set('change',f),removeEventListener:vi.fn()};
  const dispose=connectGuideMotion(root as unknown as HTMLElement,preference as unknown as MediaQueryList);
  return {images,events,toggle,status,preference,dispose};
}
describe('GIF guide motion',()=>{
 it('automatically loads real GIF sources and stops/resumes every chapter',()=>{
  const f=fixture(false);expect(f.images.every(i=>i.src.endsWith('.gif'))).toBe(true);
  f.events.get('click')!();expect(f.images.every(i=>i.src.endsWith('.png'))).toBe(true);
  f.events.get('click')!();expect(f.images.every(i=>i.src.endsWith('.gif'))).toBe(true);
  f.dispose();expect(f.images.every(i=>i.src.endsWith('.png'))).toBe(true);expect(f.preference.removeEventListener).toHaveBeenCalled();
 });
 it('starts static for reduced motion and responds to live preference changes',()=>{
  const f=fixture(true);expect(f.images.every(i=>i.src.endsWith('.png'))).toBe(true);
  f.preference.matches=false;f.events.get('change')!();expect(f.images.every(i=>i.src.endsWith('.gif'))).toBe(true);
  f.preference.matches=true;f.events.get('change')!();expect(f.images.every(i=>i.src.endsWith('.png'))).toBe(true);f.dispose();
 });
});
