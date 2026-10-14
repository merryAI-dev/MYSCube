const base = 'https://api.github.com/repos/merryAI-dev/MYSCube';
const fail = code => {throw Object.assign(new Error(code), {code});};
export function createGithubIssueClient({token,fetchImpl=fetch,signal}) {
  if (typeof token !== 'string' || !token.trim()) fail('issue_github_auth_missing');
  async function request(path,{method='GET',body}={}) {
    let response;
    try {
      response=await fetchImpl(base+path,{method,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    } catch {fail(method==='POST'?'issue_github_publication_unknown':'issue_github_read_unavailable');}
    if (!response.ok) {await response.body?.cancel();fail(method==='POST'?'issue_github_publication_unknown':'issue_github_read_unavailable');}
    const chunks=[];let size=0;const reader=response.body.getReader();
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4000000){await reader.cancel();fail('issue_github_response_invalid');}chunks.push(value);}}finally{reader.releaseLock();}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('issue_github_response_invalid');}
  }
  function number(n){if(!Number.isSafeInteger(n)||n<1)fail('issue_github_number_invalid');return n;}
  return {
    get:n=>request(`/issues/${number(n)}`),
    create:({title,body})=>request('/issues',{method:'POST',body:{title,body}}),
    async find(marker){
      if(!/^<!-- mysc-qa:[a-f0-9]{64} -->$/.test(marker))fail('issue_github_marker_invalid');
      const matches = new Map();
      for(let page=1;;page++){
        const items=await request(`/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
        if(!Array.isArray(items))fail('issue_github_response_invalid');
        const found=items.filter(x=>!x.pull_request&&typeof x.body==='string'&&x.body.endsWith(`\n\n${marker}`));
        for (const item of found) matches.set(number(item.number), item);
        if(matches.size>1)fail('issue_github_duplicate_marker');
        if(items.length<100)return matches.values().next().value || null;
      }
    },
  };
}
