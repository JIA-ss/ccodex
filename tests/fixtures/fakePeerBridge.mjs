import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const args=JSON.parse(process.argv[3].startsWith('@')?fs.readFileSync(process.argv[3].slice(1),'utf8'):process.argv[3]);
if(process.argv[2]!=='continue'||!args.require_native||args.expected_native_pid!==Number(process.env.FAKE_PEER_OWNER_PID))throw Error('Expected native-only, same-owner delivery');
const jobId=crypto.createHash('sha256').update(args.request_id).digest('hex').slice(0,32),root=process.env.CLAUDE_BRIDGE_STATE;
fs.mkdirSync(root,{recursive:true});const file=path.join(root,jobId+'.json');
if(fs.existsSync(file)){console.log(fs.readFileSync(file,'utf8'));process.exit(0);}
const job={...args,job_id:jobId,status:'running',transport:'native_peer'};
fs.writeFileSync(file,JSON.stringify(job),{mode:0o600});
fs.appendFileSync(process.env.FAKE_PEER_SENDS,JSON.stringify({requestId:args.request_id,owner:args.expected_native_pid})+'\n');
const transcript=process.env.FAKE_PEER_TRANSCRIPT,records=fs.readFileSync(transcript,'utf8').trim().split('\n').map(JSON.parse),last=records.findLast(x=>x.uuid);
const uuid=crypto.randomUUID(),promptId=crypto.randomUUID(),marker='[Codex bridge request '+jobId+']\n';
const at=new Date().toISOString();
fs.appendFileSync(transcript,JSON.stringify({type:'user',uuid,parentUuid:last.uuid,sessionId:args.session_id,promptId,timestamp:at,cwd:'/work',message:{role:'user',content:marker+args.prompt},origin:{kind:'peer',from:'bridge:codex',name:'Codex session bridge',msg_id:jobId,body:marker+args.prompt}})+'\n');
setTimeout(()=>{
 fs.appendFileSync(transcript,JSON.stringify({type:'assistant',uuid:crypto.randomUUID(),parentUuid:uuid,sessionId:args.session_id,promptId,timestamp:new Date().toISOString(),message:{role:'assistant',model:'claude-opus-5-5',id:'msg_peer_'+jobId,content:[{type:'text',text:'app: '+args.prompt}],stop_reason:'end_turn'}})+'\n');
 Object.assign(job,{status:'completed',delivery_message_uuid:uuid,result:'app: '+args.prompt});fs.writeFileSync(file,JSON.stringify(job),{mode:0o600});console.log(JSON.stringify(job));
},150);
