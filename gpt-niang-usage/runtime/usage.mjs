import fs from 'node:fs';
import path from 'node:path';
import {readDesktopLimits} from './desktop-usage.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {identifyPlan,quotaWindowLabel} from './plan.mjs';

const resetTime=value=>typeof value==='number' && Number.isFinite(value) && value>0 && value<=253402271999?value:null;
function quotaAmount(value) {
  // The service returns decimal strings for credit amounts, not currency.
  if(typeof value==='string' && !/^\d+(?:\.\d+)?$/.test(value.trim()))return null;
  if(typeof value!=='number' && typeof value!=='string')return null;
  const number=Number(value);
  return Number.isFinite(number) && number>=0?number:null;
}
function normalizeIndividual(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
  const total=quotaAmount(raw.limit),amountUsed=quotaAmount(raw.used);
  const supplied=raw.remainingPercent;
  // Prefer the service's rounded percentage; derive only when it is absent.
  const remaining=supplied==null
    ?(total>0 && amountUsed!==null?Math.max(0,100*(1-amountUsed/total)):null)
    :(typeof supplied==='number' && Number.isFinite(supplied) && supplied>=0 && supplied<=100?supplied:null);
  if(remaining===null)return null;
  return {kind:'individual',label:'个人额度',minutes:null,used:100-remaining,remaining,
    resetsAt:resetTime(raw.resetsAt),total,amountUsed,
    amountRemaining:total!==null && amountUsed!==null?Math.max(0,total-amountUsed):null};
}

export function normalizeLimits(result, now=Date.now()) {
  const hasBuckets=result && Object.hasOwn(result,'rateLimitsByLimitId') && result.rateLimitsByLimitId!==null;
  const limit = hasBuckets ? result.rateLimitsByLimitId?.codex : result?.rateLimits;
  if(!limit || typeof limit!=='object' || Array.isArray(limit))return {ok:false,queryOk:false,source:'official',observedAt:now,...identifyPlan(null,null),windows:[],errorCode:'INVALID_LIMITS',error:'Codex 额度接口未返回有效额度数据'};
  const windows = [];
  let invalid=false;
  for (const key of ['primary','secondary']) {
    const raw = limit?.[key];
    const mins = raw?.windowDurationMins;
    const used = raw?.usedPercent;
    const reset = raw?.resetsAt;
    if(raw===null || raw===undefined)continue;
    if(typeof raw!=='object' || Array.isArray(raw) || !Number.isSafeInteger(mins) || mins<=0 || typeof used!=='number' || !Number.isFinite(used) || used<0 || used>100){invalid=true;continue;}
    if(windows.some(window=>window.minutes===mins)){invalid=true;continue;}
    // DateTimeOffset must also be able to represent the Beijing (+08:00) view.
    windows.push({label:quotaWindowLabel(mins),minutes:mins,used,remaining:100-used,resetsAt:resetTime(reset)});
  }
  windows.sort((a,b)=>a.minutes-b.minutes);
  if(limit.individualLimit!=null){
    const individual=normalizeIndividual(limit.individualLimit);
    if(individual)windows.unshift(individual);else invalid=true;
  }
  return {ok:windows.length>0,queryOk:!invalid,source:'official',observedAt:now,...identifyPlan(null,limit.planType),windows,...(invalid?{errorCode:'INVALID_WINDOWS',error:'Codex 额度接口返回的窗口数据不完整'}:windows.length===0?{errorCode:'NO_WINDOWS',error:'当前账户未提供可显示的额度窗口'}:{})};
}

// Only a fingerprint of public account/read identity fields is persisted.
// Missing identity cannot safely authorize reuse of another query's snapshot.
export function accountFingerprint(account) {
  const fields=['id','accountId','chatgptAccountId','email'];
  const identity=fields.map(key=>[key,typeof account?.[key]==='string'?account[key].trim():null]).filter(([,value])=>value);
  if(identity.length===0)return null;
  // Plan labels can lag behind the account or change without a different
  // account/read identity. They must not split one account into two snapshot
  // keys, otherwise every refresh writes an empty placeholder and a failed
  // quota read loses the previous snapshot.
  return createHash('sha256').update(JSON.stringify([account.type,identity])).digest('hex');
}

// The desktop app replaces its hash-named CLI folder during updates. Resolve
// the executable on every refresh rather than pinning the install-time path.
export function resolveCodexExecutable(configuredPath,{env=process.env,platform=process.platform}={}) {
  const isFile=file=>{try{return fs.statSync(file).isFile();}catch{return false;}};
  if(typeof configuredPath==='string' && isFile(configuredPath))return configuredPath;
  const executable=platform==='win32'?'codex.exe':'codex';
  if(platform==='darwin'){
    // Finder launches with a minimal PATH. Prefer the CLI shipped with the app.
    // An explicit app root also lets tests isolate themselves from real logins.
    const applications=env.GPT_NIANG_CODEX_APP?[env.GPT_NIANG_CODEX_APP]:[
      '/Applications/Codex.app',
      ...(env.HOME?[path.join(env.HOME,'Applications','Codex.app')]:[]),
      '/Applications/ChatGPT.app',
      ...(env.HOME?[path.join(env.HOME,'Applications','ChatGPT.app')]:[])
    ];
    for(const app of applications){
      for(const relative of ['Contents/Resources/codex-cli/bin/codex','Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','Contents/Resources/codex']){
        const file=path.join(app,relative);
        if(isFile(file))return file;
      }
    }
  }

  const localData=env.LOCALAPPDATA??env.LocalAppData;
  if(platform==='win32' && localData){
    const root=path.join(localData,'OpenAI','Codex','bin');
    const candidates=[];
    const add=file=>{try{const stat=fs.statSync(file);if(stat.isFile())candidates.push({file,modified:stat.mtimeMs});}catch{}};
    add(path.join(root,executable));
    try{for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(entry.isDirectory())add(path.join(root,entry.name,executable));}}catch{}
    candidates.sort((a,b)=>b.modified-a.modified||a.file.localeCompare(b.file));
    if(candidates.length)return candidates[0].file;
  }
  for(const directory of (env.PATH??env.Path??'').split(platform==='win32'?';':':')){
    const trimmed=directory.trim().replace(/^"(.*)"$/,'$1');
    if(!trimmed)continue;
    const file=path.join(trimmed,executable);
    if(isFile(file))return file;
  }
  return configuredPath;
}

// Read the running desktop's account usage through its existing app-tools bridge.
// The legacy first argument is ignored; it can never start an executable.
export async function readUsage(_legacyCli, {onAccount=()=>{},readDesktop=readDesktopLimits,...options}={}) {
  try {
    const raw=await readDesktop(options);
    const bucket=raw?.rateLimitsByLimitId?.codex??raw?.rateLimits;
    const accountKey=accountFingerprint({type:'chatgpt',accountId:raw.accountId,planType:bucket?.planType});
    onAccount(accountKey);
    const data=normalizeLimits(raw);
    return {...data,source:'desktop',authType:'chatgpt',accountKey,
      clearPrevious:!accountKey||(data.queryOk&&!data.ok)};
  } catch {
    return {ok:false,queryOk:false,source:'desktop',...identifyPlan(null,null),
      errorCode:'DESKTOP_USAGE_UNAVAILABLE',error:'暂时无法读取当前 Codex 桌面版的剩余用量，请确认桌面版已打开',
      accountKey:null,clearPrevious:true,windows:[]};
  }
}

export function atomicJson(file,data) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,file);}
  finally{try{fs.unlinkSync(tmp);}catch{}}
}

export function freshness(window,observedAt,now=Date.now()) {
  if(!window || !Number.isFinite(observedAt))return 'unavailable';
  if(Number.isFinite(window.resetsAt) && window.resetsAt>0 && window.resetsAt*1000<=now)return 'expired';
  return now-observedAt>180000?'stale':'fresh';
}
