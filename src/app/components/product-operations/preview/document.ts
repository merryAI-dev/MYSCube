export interface PreviewWidget {
  display?: 'cards' | 'table' | 'trend'; id: string; title: string; width: 'half' | 'full'; source: string; period: string; queriedAt: string;
  metrics: Array<{ label: string; value: string }>; columns: string[]; rows: string[][]; notes: string[];
  bars?: Array<{ label: string; width: number; value: string }>; error?: string;
}
export interface PreviewPage { title: string; description: string; widgets: PreviewWidget[] }
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export function compilePreviewDocument(page: PreviewPage, source: string, nonce: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(nonce) || page.widgets.length > 6) throw new Error('지원되는 화면 구성이 아닙니다.');
  const appBundle = `MYSCubePreview.render(${scriptJson(page)},report);`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'"><style>
  *{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,sans-serif;color:#172b4d;background:#f8fafc}main{padding:20px}h1{font-size:24px;margin:0}h2{font-size:17px;margin:0 0 6px}p{margin:6px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:20px}section{grid-column:span 2;min-width:0;border:1px solid #e2e8f0;background:white;border-radius:14px;padding:20px}.half{grid-column:span 1}.meta,.note{font-size:12px;color:#526176}.note{padding-top:6px}.metrics{display:flex;flex-wrap:wrap;gap:20px;margin:16px 0}.metrics article{min-width:110px}.metrics span{display:block;font-size:12px;color:#64748b}.metrics strong{font-size:24px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}th{background:#f1f5f9}.error{padding:12px;background:#fef2f2;color:#991b1b}.bar{display:flex;align-items:center;gap:8px;font-size:12px;margin:6px 0}.bar div{height:12px;background:#3b82f6;max-width:55%}.bar span{white-space:nowrap}@media(max-width:640px){.grid{grid-template-columns:minmax(0,1fr)}section,.half{grid-column:span 1}main{padding:12px}.metrics{gap:12px}}
  </style></head><body><div id="root"></div><script nonce="${nonce}">
  const report=(type)=>parent.postMessage({channel:'myscube-preview',nonce:${scriptJson(nonce)},type,height:Math.min(4000,document.documentElement.scrollHeight)},'*');
  window.addEventListener('error',()=>report('error')); window.addEventListener('unhandledrejection',()=>report('error'));
  ${source.replace(/<\/script/gi, '<\\/script')}
  try{${appBundle}}catch(error){report('error')}
  </script></body></html>`;
}
