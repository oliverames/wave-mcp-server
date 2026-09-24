import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const base = "http://127.0.0.1:18943";
const resource = "https://wave.amesvt.com/mcp";
const storage = await mkdtemp(join(tmpdir(), "wave-migration-"));
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--config", "test/fixtures/wrangler.jsonc", "--ip", "127.0.0.1", "--port", "18943", "--persist-to", storage], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let output = ""; for (const pipe of [child.stdout, child.stderr]) pipe.on("data", chunk => { output += chunk; });
let checks = 0;
function equal(a,b) { assert.deepEqual(a,b); checks++; }
async function json(response) {
 const text = await response.text();
 if (text.startsWith("event:")) return JSON.parse(text.split("\n").find(x=>x.startsWith("data: ")).slice(6));
 try { return JSON.parse(text); } catch { throw new Error(`${response.status}: ${text.slice(0,500)}`); }
}
async function authorize(userId="fixture-user",tokenKey=randomBytes(8).toString("hex"),writesEnabled=false) {
 const client=await json(await fetch(`${base}/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({redirect_uris:["http://localhost/callback"],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"],client_name:"Migration fixture"})}));
 const verifier=randomBytes(32).toString("base64url");
 const params=new URLSearchParams({client_id:client.client_id,redirect_uri:"http://localhost/callback",response_type:"code",scope:writesEnabled?"read write":"read",resource,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
 const grant=await json(await fetch(`${base}/fixture/authorize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({authUrl:`${base}/authorize?${params}`,userId,tokenKey,writesEnabled})}));
 const code=new URL(grant.redirectTo).searchParams.get("code");
 const tokenResponse=await fetch(`${base}/token`,{method:"POST",body:new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,redirect_uri:"http://localhost/callback",code,code_verifier:verifier,resource})});
 equal(tokenResponse.status,200); const token=await json(tokenResponse); assert.ok(token.access_token);return token.access_token;
}
let id=0;
async function modern(token,method,params={}) {
 const headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":`Bearer ${token}`,"MCP-Protocol-Version":"2026-07-28","Mcp-Method":method};
 if(params.name) headers["Mcp-Name"]=params.name;
 return fetch(`${base}/mcp`,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params:{...params,_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})});
}
async function call(token,name,args={}) { const r=await modern(token,"tools/call",{name,arguments:args});equal(r.status,200);return (await json(r)).result; }
try {
 let ready=false;
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{if(output.includes(`Ready on ${base}`) && (await fetch(base)).ok){ready=true;break;}}catch{}await delay(200);}
 assert.ok(ready,output);
 for(const path of ["/mcp","/sse"]){equal((await fetch(base+path)).status,401);equal((await fetch(base+path,{headers:{Origin:"https://untrusted.invalid"}})).status,403);}
 const a=await authorize();const b=await authorize();const writer=await authorize("fixture-user",undefined,true);
 const discover=await modern(a,"server/discover");if(discover.status!==200)throw new Error(await discover.text());equal(discover.status,200);await json(discover);
 const list=await json(await modern(a,"tools/list"));assert.ok(list.result.tools.length>0);checks++;
 const writeList=await json(await modern(writer,"tools/list"));assert.ok(writeList.result.tools.length>list.result.tools.length);checks++;
 equal((await call(a,"wave_auth_status")).structuredContent.default_business_id,null);
 const business="12345678-1234-1234-1234-123456789012";
 const set=await call(a,"wave_set_default_business",{business_id:business});assert.ok(!set.isError,JSON.stringify(set));checks++;
 assert.ok((await call(a,"wave_auth_status")).structuredContent.default_business_id);checks++;
 equal((await call(b,"wave_auth_status")).structuredContent.default_business_id,null);
 const rejected=await authorize("denied-user");equal((await modern(rejected,"tools/list")).status,500);
 const legacy=await fetch(`${base}/mcp`,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":`Bearer ${a}`},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"fixture",version:"1"}}})});
 equal(legacy.status,200);const session=legacy.headers.get("mcp-session-id");assert.ok(session);checks++;await json(legacy);
 async function legacyCall(method,params={}) {
   const response=await fetch(`${base}/mcp`,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json, text/event-stream","Authorization":`Bearer ${a}`,"Mcp-Session-Id":session,"MCP-Protocol-Version":"2025-03-26"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})});
   equal(response.status,200);return (await json(response)).result;
 }
 const oldList=await legacyCall("tools/list");
 equal(oldList.tools.map(t=>t.name).sort(),list.result.tools.map(t=>t.name).sort());
 const oldResources=await legacyCall("resources/list");
 const newResources=(await json(await modern(a,"resources/list"))).result;
 equal(oldResources.resources.map(r=>r.uri).sort(),newResources.resources.map(r=>r.uri).sort());
 equal((await legacyCall("tools/call",{name:"wave_auth_status",arguments:{}})).structuredContent.default_business_id,null);
 const legacySet=await legacyCall("tools/call",{name:"wave_set_default_business",arguments:{business_id:"87654321-4321-4321-4321-210987654321"}});
 assert.ok(!legacySet.isError);checks++;
 const oldDefault=(await legacyCall("tools/call",{name:"wave_auth_status",arguments:{}})).structuredContent.default_business_id;
 assert.notEqual(oldDefault,(await call(a,"wave_auth_status")).structuredContent.default_business_id);checks++;
 equal((await fetch(`${base}/mcp`,{method:"POST",headers:{"Content-Type":"text/plain","Authorization":`Bearer ${a}`},body:"{}"})).status,415);
 equal((await fetch(`${base}/mcp`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${a}`,Origin:"https://untrusted.invalid"},body:"{}"})).status,403);
 // The public deletion flow clears the new connection default records too.
 const deletion=await(await fetch(`${base}/delete`)).text();
 const csrf=deletion.match(/name="csrf" value="([^"]+)"/)[1];
 equal((await fetch(`${base}/delete`,{method:"POST",body:new URLSearchParams({csrf,wave_user_id:"fixture-user"})})).status,200);
 equal((await call(a,"wave_auth_status")).structuredContent.default_business_id,null);
 console.log(`Migration local integration: ${checks} assertions passed.`);
} catch(error) { console.error(output);throw error; }
finally { child.kill("SIGTERM"); if(child.exitCode===null)await once(child,"exit");await rm(storage,{recursive:true,force:true}); }
