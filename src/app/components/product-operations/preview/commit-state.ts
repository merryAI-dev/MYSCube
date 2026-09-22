export class PreviewCommitState {
  latest = '';
  active = '';
  states = new Map<string, 'pending' | 'committed' | 'failed'>();
  good: string[] = [];
  start(nonce: string) {
    for (const [id, state] of this.states) if (state === 'pending') this.states.delete(id);
    this.latest = nonce; this.states.set(nonce, 'pending');
  }
  ready(nonce: string) {
    if (nonce !== this.latest || this.states.get(nonce) !== 'pending') return false;
    this.states.set(nonce, 'committed'); this.good = [...this.good, nonce].slice(-2); this.active = nonce;
    for (const id of this.states.keys()) if (!this.good.includes(id)) this.states.delete(id);
    return true;
  }
  fail(nonce: string) {
    if (!this.states.has(nonce) || this.states.get(nonce) === 'failed') return false;
    this.states.set(nonce, 'failed'); this.good = this.good.filter((id) => id !== nonce); this.active = this.good.at(-1) || '';
    return true;
  }
  retained(nonce: string) { return this.states.get(nonce) === 'pending' || this.good.includes(nonce); }
}
