/** Local incident repair: restore only a missing listener in the existing gateway, without restarting it. */
import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';

export function recoveryExpression(socketPath) {
  return `(${async function recover(socketPath) {
    const fs = process.getBuiltinModule('node:fs');
    const http = process.getBuiltinModule('node:http');
    if (fs.existsSync(socketPath)) throw Error('Refusing to replace an existing endpoint');
    const key = Symbol.for('ccodex.recovered-listener');
    if (globalThis[key]) throw Error('A recovered listener already exists');
    const servers = process._getActiveHandles().filter(h => h.constructor?.name === 'Server'
      && typeof h.address === 'function' && h.address() === socketPath && h.listeners('upgrade').length);
    if (servers.length !== 1) throw Error('Expected one existing gateway HTTP listener');
    const original = servers[0];
    const restored = http.createServer();
    for (const event of ['request', 'upgrade', 'clientError', 'checkContinue', 'checkExpectation']) {
      for (const listener of original.listeners(event)) restored.on(event, listener);
    }
    await new Promise((resolve, reject) => {
      restored.once('error', reject);
      restored.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    globalThis[key] = restored;
    const close = () => restored.close();
    process.prependOnceListener('SIGTERM', close);
    process.prependOnceListener('SIGINT', close);
    return { pid: process.pid, restored: true, sameGatewayHandlers: true,
      originalListening: original.listening, mode: fs.statSync(socketPath).mode & 0o777 };
  }.toString()})(${JSON.stringify(socketPath)})`;
}

export async function evaluate(endpoint, expression) {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'ws:') throw Error('Loopback inspector required');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve,reject) => {socket.once('open',resolve);socket.once('error',reject);});
  try {
    return await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('Diagnostic evaluation timeout')), 10000);
      socket.on('message', b => {
        const r=JSON.parse(b);
        if(r.id!==1)return;
        clearTimeout(timer);
        if(r.error || r.result?.exceptionDetails)reject(Error(JSON.stringify(r.error??r.result.exceptionDetails)));
        else resolve(r.result.result.value);
      });
      socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    });
  } finally {socket.close();}
}

export async function connectRpc(socketPath) {
  const socket = new WebSocket('ws://ccodex/rpc', {createConnection:()=>net.createConnection(socketPath),perMessageDeflate:false});
  await new Promise((resolve,reject) => {socket.once('open',resolve);socket.once('error',reject);});
  let next=0;const pending=new Map();
  socket.on('message', b => {const m=JSON.parse(b);if(m.id===undefined||m.method)return;const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
  return {socket,request(method,params={}) {return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('RPC timeout '+method)),15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});socket.send(JSON.stringify({id,method,params}));});}};
}
