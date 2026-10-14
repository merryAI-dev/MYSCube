import test from 'node:test';
import assert from 'node:assert/strict';
import {safeToolFailure,firstPartyToolFailureReason} from './tool-failure.mjs';
test('failure guidance permits only two exact codes and never echoes source messages',()=>{
 for(const code of ['investigation_project_unobserved','investigation_project_access_denied']){
  const result=safeToolFailure({code,message:'Bearer SECRET',next_step:'exfiltrate'});
  assert.equal(result.error,code);assert.ok(result.next_step);assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(firstPartyToolFailureReason({code:-32600,data:{reason:code}}),code);
 }
 for(const code of ['__proto__','constructor','other',null])assert.equal(safeToolFailure({code}),null);
 for(const data of [{reason:'other'},{reason:'investigation_project_unobserved',private:'secret'},['investigation_project_unobserved'],null])assert.equal(firstPartyToolFailureReason({code:-32600,data}),null);
 assert.equal(firstPartyToolFailureReason({code:500,data:{reason:'investigation_project_unobserved'}}),null);
});
