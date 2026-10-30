import { MotionSurface } from './motion';
import type { ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Loader2, Search } from 'lucide-react';
export function FeedbackState({kind,title,children}:{kind:'loading'|'empty'|'success'|'error';title:string;children?:ReactNode}){
 const Icon={loading:Loader2,empty:Search,success:CheckCircle2,error:AlertCircle}[kind];
 return <MotionSurface changeKey={kind + title}><div className={`feedback-state feedback-${kind}`} role={kind==='error'?'alert':'status'}><Icon aria-hidden className={kind==='loading'?'animate-spin':''}/><div><strong>{title}</strong>{children&&<p>{children}</p>}</div></div></MotionSurface>
}
