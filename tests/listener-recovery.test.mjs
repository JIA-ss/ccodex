import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {evaluate,recoveryExpression,connectRpc} from '../scripts/recover-listener.mjs';
import {installListenerGuard} from '../dist/gateway/listenerGuard.js';

test('restore an unlinked socket without losing an existing in-flight RPC; refuse an existing path', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccx-listener-')),sock=path.join(root,'gw.sock');
 const wsModule=new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href;
 const code=`import http from 'node:http';import fs from 'node:fs';import {WebSocketServer} from '${wsModule}';
 const wss=new WebSocketServer({noServer:true});const server=http.createServer((q,r)=>r.end('ok'));
 server.on('upgrade',(q,s,h)=>wss.handleUpgrade(q,s,h,ws=>ws.on('message',b=>{const m=JSON.parse(b);setTimeout(()=>ws.send(JSON.stringify({id:m.id,result:m.params})),m.method==='slow'?250:0);})));server.listen(${JSON.stringify(sock)});
 process.once('SIGTERM',()=>{for(const client of wss.clients)client.terminate();server.close();});`;
 const p=spawn(process.execPath,['--inspect=127.0.0.1:0','--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});
 let endpoint;let original,reconnected;
 try{
  endpoint=await new Promise((resolve,reject)=>{let text='';p.stderr.on('data',b=>{text+=b;const m=/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(text);if(m)resolve(m[0]);});p.once('error',reject);});
  while(!fs.existsSync(sock))await new Promise(r=>setTimeout(r,10));
  original=await connectRpc(sock);const slow=original.request('slow',{unchanged:'in-flight'});fs.unlinkSync(sock);
  const proof=await evaluate(endpoint,recoveryExpression(sock));assert.equal(proof.pid,p.pid);assert.equal(proof.mode,0o600);
  reconnected=await connectRpc(sock);assert.deepEqual(await reconnected.request('new',{new:'works'}),{new:'works'});
  assert.deepEqual(await slow,{unchanged:'in-flight'});assert.deepEqual(await original.request('old',{old:'works'}),{old:'works'});
  await assert.rejects(evaluate(endpoint,recoveryExpression(sock)),/existing endpoint/);
 }finally{original?.socket.close();reconnected?.socket.close();p.kill('SIGTERM');await new Promise(r=>p.once('exit',r));fs.rmSync(root,{recursive:true,force:true});}
});

test('in-process listener guard heals pathname loss while existing work continues', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ccx-guard-')),sock=path.join(root,'gw.sock');
 const wsModule=new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href;
 const code=`import http from 'node:http';import {WebSocketServer} from '${wsModule}';
 const wss=new WebSocketServer({noServer:true});const server=http.createServer((q,r)=>r.end('ok'));
 server.on('upgrade',(q,s,h)=>wss.handleUpgrade(q,s,h,ws=>ws.on('message',b=>{const m=JSON.parse(b);setTimeout(()=>ws.send(JSON.stringify({id:m.id,result:m.params})),m.method==='slow'?650:0);})));server.listen(${JSON.stringify(sock)});
 process.once('SIGTERM',()=>{for(const client of wss.clients)client.terminate();server.close();});`;
 const p=spawn(process.execPath,['--inspect=127.0.0.1:0','--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});
 let original,reconnected;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let text='';p.stderr.on('data',b=>{text+=b;const m=/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.exec(text);if(m)resolve(m[0]);});p.once('error',reject);});
  while(!fs.existsSync(sock))await new Promise(r=>setTimeout(r,10));
  const expression=`(${installListenerGuard.toString()})(${JSON.stringify(sock)},10)`;
  const proof=await evaluate(endpoint,expression);assert.equal(proof.pid,p.pid);
  original=await connectRpc(sock);const slow=original.request('slow',{kept:'in-flight'});
  for(let i=0;i<2;i++){
   fs.unlinkSync(sock);const until=Date.now()+1500;
   while(!fs.existsSync(sock)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
   assert.ok(fs.existsSync(sock));assert.equal(fs.statSync(sock).mode&0o777,0o600);
   reconnected=await connectRpc(sock);assert.deepEqual(await reconnected.request('new',{round:i}),{round:i});reconnected.socket.close();
  }
  assert.deepEqual(await slow,{kept:'in-flight'});assert.equal((await evaluate(endpoint,'process.pid')),p.pid);
 }finally{original?.socket.close();reconnected?.socket.close();p.kill('SIGTERM');await new Promise(r=>p.once('exit',r));fs.rmSync(root,{recursive:true,force:true});}
});
