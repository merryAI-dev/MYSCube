export async function exhaustedCredit(response) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("provider_error_read_timeout")), 2000);
  });
  try {
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) return false;
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return response.status === 429 &&
      ["credit_balance_exhausted", "insufficient_quota"].includes(body?.error?.code) &&
      body?.error?.type === "insufficient_quota";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}


export function observeProviderRequest({model,outcome,httpStatus=null},write=line=>console.info(line)) {
  if(!/^gpt-[a-z0-9.-]+$/.test(model||'')||!['accepted_http','credit_exhausted','http_error','network_error'].includes(outcome))return;
  if(httpStatus!==null&&(!Number.isInteger(httpStatus)||httpStatus<100||httpStatus>599))return;
  try{write(JSON.stringify({producer:'qa_provider_observer_v1',phase:'provider_request_observed',provider:'openai',model,
    observed_at:new Date().toISOString(),outcome,http_status:httpStatus}));}catch{}
}
