import fs from 'node:fs';
import net from 'node:net';
import {randomUUID} from 'node:crypto';

// Reuse the app-tools pipe owned by the running desktop application. Never
// launch Codex or fall back to a second app-server when the desktop is absent.
export function desktopPipes(env=process.env) {
  const paths=[];
  if(env.CODEX_APP_TOOLS_PIPE_PATH)paths.push(env.CODEX_APP_TOOLS_PIPE_PATH);
  if(process.platform==='win32'){
    try{for(const name of fs.readdirSync('\\\\.\\pipe\\')){
      if(/^codex-app-tools-[a-z0-9-]+$/i.test(name))paths.push('\\\\.\\pipe\\'+name);
    }}catch{}
  }
  return [...new Set(paths)];
}

export function desktopRequest(pipe,method,params,{timeoutMs=12000,connect=net.createConnection}={}) {
  return new Promise((resolve,reject)=>{
    let data=Buffer.alloc(0),settled=false,socket;
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);socket?.destroy();
      error?reject(error):resolve(result);
    };
    const timer=setTimeout(()=>finish(new Error('桌面版额度读取超时')),timeoutMs);
    try{socket=connect(pipe);}catch(error){finish(error);return;}
    socket.on('error',error=>finish(error));
    socket.on('close',()=>finish(new Error('Codex 桌面连接已关闭')));
    socket.on('connect',()=>{
      const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,params}));
      const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header,body]));
    });
    socket.on('data',chunk=>{
      data=Buffer.concat([data,chunk]);
      if(data.length<4)return;
      const size=data.readUInt32LE(0);
      if(size>8*1024*1024){finish(new Error('桌面额度响应过大'));return;}
      if(data.length<size+4)return;
      try{
        const response=JSON.parse(data.subarray(4,size+4).toString('utf8'));
        if(response?.jsonrpc!=='2.0'||response.id!==1)throw new Error('桌面额度响应无效');
        if(response.error)throw new Error(response.error.message??'桌面额度读取失败');
        finish(null,response.result);
      }catch(error){finish(error);}
    });
  });
}

export async function readDesktopLimits({threadId=process.env.CODEX_THREAD_ID,
  pipes=desktopPipes(),request=desktopRequest,timeoutMs=18000}={}) {
  if(!threadId)throw new Error('尚未绑定 Codex 桌面对话');
  if(!pipes.length)throw new Error('请先打开 Codex 桌面版');
  const deadline=Date.now()+timeoutMs;
  let lastError;
  for(const pipe of pipes){
    try{
      const options=()=>({timeoutMs:Math.max(1,deadline-Date.now())});
      const list=await request(pipe,'tools/list',{threadStartKind:'all'},options());
      const tool=list?.tools?.find(tool=>tool.name==='get_usage_limits');
      if(!tool)throw new Error('当前 Codex 桌面版未提供额度读取功能');
      const id='gpt-niang-usage-'+randomUUID();
      const response=await request(pipe,'tools/call',{
        arguments:{},callerSource:'codex',callId:id,hostId:'local',
        namespace:tool.namespace,threadId,tool:tool.name,turnId:id
      },options());
      if(!response?.success)throw new Error('Codex 桌面版暂时无法读取剩余用量');
      const texts=response.contentItems?.filter(item=>item.type==='inputText').map(item=>item.text)??[];
      const limits=texts.map(text=>{try{return JSON.parse(text);}catch{return null;}}).find(value=>value&&typeof value==='object'&&!Array.isArray(value));
      if(!limits||typeof limits!=='object'||Array.isArray(limits))throw new Error('桌面额度数据无效');
      return limits;
    }catch(error){lastError=error;if(Date.now()>=deadline)break;}
  }
  throw lastError??new Error('请先打开 Codex 桌面版');
}
