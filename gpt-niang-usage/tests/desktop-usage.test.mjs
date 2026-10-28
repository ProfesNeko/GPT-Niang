import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {desktopRequest,readDesktopLimits} from '../runtime/desktop-usage.mjs';

test('desktop reader calls only the running host usage tool with the bound context',async()=>{
  const calls=[];
  const raw={accountId:'account-a',rateLimits:{primary:{usedPercent:12,windowDurationMins:300}}};
  const result=await readDesktopLimits({threadId:'bound-thread',pipes:['existing-pipe'],request:async(pipe,method,params)=>{
    calls.push({pipe,method,params});
    return method==='tools/list'?{tools:[{name:'get_usage_limits',namespace:'codex_app'}]}:
      {success:true,contentItems:[{type:'inputText',text:JSON.stringify(raw)}]};
  }});
  assert.deepEqual(result,raw);
  assert.deepEqual(calls.map(call=>call.method),['tools/list','tools/call']);
  assert.equal(calls[1].params.tool,'get_usage_limits');
  assert.equal(calls[1].params.threadId,'bound-thread');
  assert.deepEqual(calls[1].params.arguments,{});
});

test('missing desktop or binding never launches a fallback server',async()=>{
  for(const options of [{threadId:'bound',pipes:[]},{threadId:null,pipes:['existing']}]){
    await assert.rejects(readDesktopLimits({...options,request:()=>assert.fail('must not connect')}));
  }
});

test('host errors and invalid usage payloads are not shown as healthy percentages',async()=>{
  for(const reply of [{success:false}, {success:true,contentItems:[]},
    {success:true,contentItems:[{type:'inputText',text:'null'}]}]){
    await assert.rejects(readDesktopLimits({threadId:'bound',pipes:['existing'],request:async(_pipe,method)=>
      method==='tools/list'?{tools:[{name:'get_usage_limits',namespace:'codex_app'}]}:reply}));
  }
});

test('native framing handles split headers and bodies and closes the socket',async()=>{
  let received;
  const server=net.createServer(socket=>{
    let data=Buffer.alloc(0);
    socket.on('data',chunk=>{
      data=Buffer.concat([data,chunk]);
      if(data.length<4||data.length<4+data.readUInt32LE(0))return;
      received=JSON.parse(data.subarray(4).toString());
      const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}}));
      const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
      socket.write(header.subarray(0,2));
      setImmediate(()=>{socket.write(Buffer.concat([header.subarray(2),body.subarray(0,5)]));
        setImmediate(()=>socket.end(body.subarray(5)));});
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await desktopRequest('existing','tools/list',{},
      {connect:()=>net.createConnection(server.address()),timeoutMs:1000});
    assert.deepEqual(result,{ok:true});assert.equal(received.method,'tools/list');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
