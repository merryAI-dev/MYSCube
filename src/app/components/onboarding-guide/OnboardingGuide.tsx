import { useEffect, useRef } from 'react';
import content from './content.html?raw';
import './guide.css';
import { connectGuideMotion } from './guide-motion';

export function OnboardingGuide({ embedded = false }: { embedded?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = root.current;
    const video = node?.querySelector<HTMLVideoElement>('video');
    const speed = node?.querySelector<HTMLSelectElement>('#speed');
    if (!node || !video || !speed) return;
    const disconnectMotion = connectGuideMotion(node, window.matchMedia('(prefers-reduced-motion: reduce)'));
    const fullVideo = node.querySelector<HTMLDetailsElement>('.full-video');
    const closeVideo = () => { if (!fullVideo?.open) video.pause(); };
    fullVideo?.addEventListener('toggle', closeVideo);
    const changeSpeed = () => { video.playbackRate = Number(speed.value); };
    const seek = (event: Event) => {
      const target = (event.target as Element).closest<HTMLButtonElement>('[data-time]');
      if (!target || !node.contains(target)) return;
      const time = Number(target.dataset.time);
      video.currentTime = time;
      video.focus({ preventScroll: true });
      video.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    };
    speed.addEventListener('change', changeSpeed);
    node.addEventListener('click', seek);
    return () => {
      speed.removeEventListener('change', changeSpeed);
      node.removeEventListener('click', seek);
      video.pause();
      disconnectMotion();
      fullVideo?.removeEventListener('toggle', closeVideo);
    };
  }, []);
  // This is bundled, reviewed guide markup, never user or API content.
  return <div ref={root} className={`product-walkthrough${embedded ? ' product-walkthrough--embedded' : ''}`} dangerouslySetInnerHTML={{ __html: content }} />;
}
