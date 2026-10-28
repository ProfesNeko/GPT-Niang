import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeLimits,freshness,readUsage,accountFingerprint} from '../runtime/usage.mjs';
import {mergeUsageSnapshot} from '../runtime/refresh-queue.mjs';
const w=(used=10,mins=300)=>({usedPercent:used,windowDurationMins:mins,resetsAt:2000000000});
const individual=(overrides={})=>({limit:'4000',used:'2082.8820300102234',remainingPercent:48,resetsAt:2000000000,...overrides});
test('Business personal cap works without primary or secondary windows',()=>{
  const r=normalizeLimits({rateLimitsByLimitId:{codex:{planType:'business',primary:null,secondary:null,individualLimit:individual()}}},1000);
  assert.equal(r.ok,true);assert.equal(r.queryOk,true);assert.equal(r.plan,'business');
  assert.equal(r.windows.length,1);
  const q=r.windows[0];
  assert.equal(q.kind,'individual');assert.equal(q.label,'个人额度');assert.equal(q.minutes,null);
  assert.equal(q.remaining,48);assert.equal(q.used,52);assert.equal(q.total,4000);
  assert.equal(q.amountUsed,2082.8820300102234);assert.equal(q.amountRemaining,4000-q.amountUsed);
  assert.equal(q.resetsAt,2000000000);
});
test('personal cap coexists with timed windows without discarding either',()=>{
  const r=normalizeLimits({rateLimits:{individualLimit:individual(),primary:w(10),secondary:w(80,10080)}});
  assert.equal(r.windows.length,3);assert.equal(r.queryOk,true);
  assert.deepEqual(r.windows.map(q=>q.remaining),[48,90,20]);
});
test('personal cap preserves exhausted, zero, full and decimal percentages',()=>{
  for(const remainingPercent of [0,0.1,48,100]){
    const q=normalizeLimits({rateLimits:{individualLimit:individual({remainingPercent})}}).windows[0];
    assert.equal(q.remaining,remainingPercent);assert.equal(q.used,100-remainingPercent);
  }
  const zero=normalizeLimits({rateLimits:{individualLimit:individual({limit:'0',used:'0',remainingPercent:0})}}).windows[0];
  assert.equal(zero.remaining,0);assert.equal(zero.amountRemaining,0);
});
test('derive a missing personal percentage only from valid amounts',()=>{
  for(const remainingPercent of [null,undefined]){
    const q=normalizeLimits({rateLimits:{individualLimit:individual({limit:'4000',used:'1000',remainingPercent})}}).windows[0];
    assert.equal(q.remaining,75);
  }
  const q=normalizeLimits({rateLimits:{individualLimit:individual({used:4500,remainingPercent:null})}}).windows[0];
  assert.equal(q.remaining,0);assert.equal(q.amountRemaining,0);
  for(const limit of [null,'', ' ',false,[],{},'NaN','Infinity',-1,'-1',0]){
    const r=normalizeLimits({rateLimits:{individualLimit:individual({limit,remainingPercent:null})}});
    assert.equal(r.ok,false);assert.equal(r.queryOk,false);
  }
});
test('malformed personal percentages are not replaced by guessed healthy values',()=>{
  for(const raw of [false,[],{},individual({remainingPercent:-1}),individual({remainingPercent:101}),individual({remainingPercent:'48'}),individual({remainingPercent:NaN})]){
    const r=normalizeLimits({rateLimits:{individualLimit:raw}});
    assert.equal(r.ok,false);assert.equal(r.queryOk,false);assert.equal(r.errorCode,'INVALID_WINDOWS');
  }
  assert.equal(normalizeLimits({rateLimits:{individualLimit:null}}).errorCode,'NO_WINDOWS');
});
test('personal reset and unknown amount fields remain unavailable, never invented',()=>{
  const r=normalizeLimits({rateLimits:{individualLimit:individual({limit:null,used:null,resetsAt:null})}},1000);
  assert.equal(r.ok,true);assert.equal(r.windows[0].total,null);assert.equal(r.windows[0].amountRemaining,null);
  assert.equal(r.windows[0].resetsAt,null);assert.equal(freshness(r.windows[0],1000,2000),'fresh');
  const expired=normalizeLimits({rateLimits:{individualLimit:individual({resetsAt:1})}},1000);
  assert.equal(freshness(expired.windows[0],1000,2000),'expired');
});
test('personal cap survives the desktop account snapshot pipeline',async()=>{
  let reads=0;
  const r=await readUsage('unused',{readDesktop:async()=>{reads++;return {accountId:'business-account',rateLimits:{planType:'business',individualLimit:individual()}};}});
  assert.equal(reads,1);assert.equal(r.source,'desktop');
  assert.equal(r.ok,true);assert.equal(r.clearPrevious,false);assert.equal(r.windows[0].remaining,48);
  const personal={...normalizeLimits({rateLimits:{primary:w(1)}}),accountKey:'personal'};
  const switched=mergeUsageSnapshot(personal,r);
  assert.equal(switched.windows.length,1);assert.equal(switched.windows[0].kind,'individual');
});

test('prefer current codex bucket over legacy and unrelated model buckets',()=>{
  const r=normalizeLimits({rateLimits:{primary:w(90)},rateLimitsByLimitId:{codex:{primary:w(12),secondary:w(61,10080)},other:{primary:w(98)}}},1000);
  assert.deepEqual(r.windows.map(x=>[x.minutes,x.used,x.remaining]),[[300,12,88],[10080,61,39]]);
});
test('missing current bucket does not borrow a different account or meter',()=>{
  assert.equal(normalizeLimits({rateLimits:{primary:w()},rateLimitsByLimitId:{other:{primary:w()}}}).ok,false);
});
test('missing and invalid fields stay unavailable, valid zero and full usage survive',()=>{
  for(const x of [null,{}, {usedPercent:null,windowDurationMins:300,resetsAt:2000000000},w(-1),w(101),w(NaN),w(5,0),w(5,1.5),w(5,Number.MAX_SAFE_INTEGER+1)])assert.equal(normalizeLimits({rateLimits:{primary:x}}).ok,false);
  assert.equal(normalizeLimits({rateLimits:{primary:w(0)}}).windows[0].remaining,100);
  assert.equal(normalizeLimits({rateLimits:{primary:w(100)}}).windows[0].remaining,0);
});
test('an exhausted window still reports zero remaining and keeps the other window',()=>{
  for(const [short,week] of [[100,34],[20,100],[100,100]]){
    const result=normalizeLimits({rateLimits:{primary:w(short),secondary:w(week,10080)}});
    assert.equal(result.ok,true);assert.equal(result.queryOk,true);
    assert.deepEqual(result.windows.map(window=>window.remaining),[100-short,100-week]);
  }
});
test('passed reset stays expired instead of invented replenishment',()=>{
  assert.equal(freshness({resetsAt:2},1000,3000),'expired');
  assert.equal(freshness({resetsAt:1000},1000,200000),'stale');
  assert.equal(freshness({resetsAt:1000},1000,2000),'fresh');
});
test('desktop unavailable returns an actionable failure without launching the legacy CLI',async()=>{
  let spawned=false;
  const r=await readUsage('Z:/not-a-codex-executable.exe',{spawnProcess:()=>{spawned=true;throw new Error('must not run');},readDesktop:async()=>{throw new Error('desktop closed');}});
  assert.equal(spawned,false);assert.equal(r.ok,false);assert.equal(r.clearPrevious,true);
  assert.equal(r.errorCode,'DESKTOP_USAGE_UNAVAILABLE');assert.deepEqual(r.windows,[]);
});

test('desktop read failure clears a snapshot whose account cannot be verified',async()=>{
  const response=await readUsage(null,{readDesktop:async()=>{throw new Error('offline');}});
  const previous=normalizeLimits({rateLimits:{primary:w(12)}},1000);
  const snapshot=mergeUsageSnapshot(previous,response,2000);
  assert.equal(snapshot.ok,false);assert.deepEqual(snapshot.windows,[]);assert.equal(snapshot.checkedAt,2000);
  assert.match(snapshot.error,/桌面版/);
});

test('a missing reset keeps the valid percentage and does not invent expiry',()=>{
  for(const resetsAt of [null,undefined,NaN,0,-1,'2000000000',1e100,253402300799]) {
    const result=normalizeLimits({rateLimits:{primary:{...w(12),resetsAt}}},1000);
    assert.equal(result.ok,true);assert.equal(result.queryOk,true);
    assert.equal(result.windows[0].remaining,88);assert.equal(result.windows[0].resetsAt,null);
    assert.equal(freshness(result.windows[0],1000,2000),'fresh');
  }
});

test('only successful well-formed absence is distinguished from failed quota reads',()=>{
  assert.equal(normalizeLimits({rateLimits:{secondary:w(30,10080)}}).queryOk,true);
  assert.equal(normalizeLimits({rateLimits:{primary:null,secondary:null}}).queryOk,true);
  for(const response of [null,{}, {rateLimits:null},{rateLimits:[]},{rateLimitsByLimitId:{other:{primary:w()}}},{rateLimits:{primary:w(NaN),secondary:w(20,10080)}}])assert.equal(normalizeLimits(response).queryOk,false);
  const duplicate=normalizeLimits({rateLimits:{primary:w(10),secondary:w(20)}});
  assert.equal(duplicate.queryOk,false);assert.equal(duplicate.windows.length,1);
});

test('public account identity is fingerprinted without persisting email or credentials',()=>{
  const account={type:'chatgpt',email:'a@example.test',planType:'plus',accessToken:'not-stored'};
  const key=accountFingerprint(account);
  assert.match(key,/^[a-f0-9]{64}$/);
  assert.equal(key,accountFingerprint({...account,accessToken:'different'}));
  assert.notEqual(key,accountFingerprint({...account,email:'b@example.test'}));
  assert.equal(accountFingerprint({type:'chatgpt',email:null,planType:'plus'}),null);
});

test('quota failures reuse only a verified same-account snapshot',()=>{
  const previous={...normalizeLimits({rateLimits:{primary:w(12)}},1000),accountKey:'account-a'};
  const failed={ok:false,queryOk:false,error:'temporary failure',windows:[],accountKey:'account-a'};
  const same=mergeUsageSnapshot(previous,failed,2000);
  assert.equal(same.ok,true);assert.equal(same.queryOk,false);assert.equal(same.observedAt,1000);
  assert.equal(same.windows[0].remaining,88);
  for(const accountKey of ['account-b',null,undefined]) {
    const different=mergeUsageSnapshot(previous,{...failed,accountKey},2000);
    assert.equal(different.ok,false);assert.deepEqual(different.windows,[]);
  }
  const older={...previous,observedAt:500,windows:[{remaining:99}]};
  assert.equal(mergeUsageSnapshot(previous,older,2000),previous);
});

test('desktop identity is attached even when returned quota data is incomplete',async()=>{
  const seen=[];
  const result=await readUsage(null,{readDesktop:async()=>({accountId:'account-b',rateLimits:{planType:'plus',primary:w(NaN)}}),onAccount:key=>seen.push(key)});
  assert.equal(result.ok,false);assert.equal(result.queryOk,false);assert.equal(result.clearPrevious,false);
  assert.equal(result.accountKey,accountFingerprint({type:'chatgpt',accountId:'account-b',planType:'plus'}));
  assert.deepEqual(seen,[result.accountKey]);assert.equal(JSON.stringify(result).includes('account-b'),false);
});

test('invalid desktop replies fail without crashing the worker',async()=>{
  for(const raw of [null,false,42,[]]){
    const result=await readUsage(null,{readDesktop:async()=>raw});
    assert.equal(result.ok,false);assert.equal(result.clearPrevious,true);
  }
});

test('desktop account switches cannot reuse a previous account snapshot',async()=>{
  const read=accountId=>readUsage(null,{readDesktop:async()=>({accountId,rateLimits:{planType:'plus',primary:w(12)}})});
  const a=await read('account-a'),b=await read('account-b');
  assert.notEqual(a.accountKey,b.accountKey);
  const failed={...b,ok:false,queryOk:false,windows:[]};
  assert.equal(mergeUsageSnapshot(a,failed).ok,false);
});

test('MCP rejects malformed input without crashing and still serves read-only protocol metadata',async()=>{
  const proc=spawn(process.execPath,[fileURLToPath(new URL('../runtime/mcp.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='';
  proc.stdout.on('data',chunk=>{output+=chunk;});proc.stderr.on('data',chunk=>{errors+=chunk;});
  const closed=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('close',code=>resolve(code));});
  proc.stdin.end(['{bad-json','null','[]','false','{"id":7}',JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'}),JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'}),JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})].join('\n')+'\n');
  assert.equal(await closed,0,errors);
  const responses=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(responses.filter(response=>response.error?.code===-32700).length,1);
  assert.equal(responses.filter(response=>response.error?.code===-32600).length,4);
  assert.equal(responses.find(response=>response.id===1).result.serverInfo.name,'gpt-niang-usage');
  assert.deepEqual(responses.find(response=>response.id===2).result,{});
  assert.equal(responses.find(response=>response.id===3).result.tools[0].name,'get_codex_usage');
});
