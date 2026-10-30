import { Children, isValidElement, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// MYSCube design values, not measured Apple/Toss timing constants.
export const motionTokens = { duration: 260, disclosure: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', distance: 6 };
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useLayoutEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}
export function MotionSurface({ children, changeKey, className = '' }: { children: ReactNode; changeKey?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || reduced || !node.animate) return;
    const animation = node.animate([{ transform: `translateY(${motionTokens.distance}px)`, opacity: .94 }, { transform: 'translateY(0)', opacity: 1 }], { duration: motionTokens.duration, easing: motionTokens.easing });
    return () => animation.cancel();
  }, [changeKey, reduced]);
  return <div ref={ref} className={className} data-motion-surface>{children}</div>;
}
export function MotionDisclosure({children, className = ''}: {children: ReactNode; className?: string}) {
  const items = Children.toArray(children);
  const summary = items.find(item => isValidElement(item) && item.type === 'summary');
  const content = items.filter(item => item !== summary);
  const label = isValidElement<{children: ReactNode}>(summary) ? summary.props.children : '상세 보기';
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const start = node.getBoundingClientRect().height;
    active.current?.cancel();
    if (!open && node.contains(document.activeElement)) trigger.current?.focus({preventScroll:true});
    node.inert = !open;
    node.hidden = false;
    const end = open ? node.scrollHeight : 0;
    node.style.height = open ? 'auto' : '0px';
    if (reduced || !node.animate || start === end) { node.hidden = !open; return; }
    const animation = node.animate([{height:`${start}px`, opacity:open ? .94 : 1},{height:`${end}px`,opacity:open ? 1 : .94}], {duration:motionTokens.disclosure,easing:motionTokens.easing});
    active.current = animation;
    animation.onfinish = () => { if (active.current === animation) {node.hidden = !open; active.current = null;} };

  }, [open, reduced]);
  useLayoutEffect(() => () => { if (active.current) {active.current.onfinish = null; active.current.cancel();} }, []);
  return <div className={`motion-disclosure ${className}`}><button ref={trigger} type="button" className="motion-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span aria-hidden className="disclosure-chevron">›</span>{label}</button><div id={id} ref={panel} className="motion-disclosure-panel" hidden={!open && reduced}><div className="motion-disclosure-content">{content}</div></div></div>;
}
