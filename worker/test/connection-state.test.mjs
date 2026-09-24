import assert from "node:assert/strict";
import { test } from "node:test";
import { OAuthTransientState } from "../src/oauth-transient-state.js";
import { connectionDefaults, deleteConnectionDefaults } from "../src/wave-connection-state.js";
function environment() {
 const objects=new Map();
 return {objects,OAUTH_STATE:{idFromName:name=>name,get(name){
  if(!objects.has(name))objects.set(name,new Map());
  const data=objects.get(name);
  const storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k),deleteAll:async()=>data.clear()};
  return {fetch:(url,init)=>new OAuthTransientState({storage}).fetch(new Request(url,init))};
 }}};
}
test("connection defaults survive object recreation and remain isolated by user and connection",async()=>{
 const env=environment();const a=await connectionDefaults(env,"u1","a");
 assert.equal(await a.get(),undefined);await a.set("business-a");
 assert.equal(await (await connectionDefaults(env,"u1","a")).get(),"business-a");
 assert.equal(await (await connectionDefaults(env,"u1","b")).get(),undefined);
 assert.equal(await (await connectionDefaults(env,"u2","a")).get(),undefined);
});
test("user deletion clears only that user's defaults including pre-tokenKey grants",async()=>{
 const env=environment();for(const [user,key] of [["u1","a"],["u1",undefined],["u2","a"]])await(await connectionDefaults(env,user,key)).set("business");
 await deleteConnectionDefaults(env,"u1");
 assert.equal(await(await connectionDefaults(env,"u1","a")).get(),undefined);
 assert.equal(await(await connectionDefaults(env,"u1",undefined)).get(),undefined);
 assert.equal(await(await connectionDefaults(env,"u2","a")).get(),"business");
});
test("failed default writes and reads propagate instead of reporting a saved default",async()=>{
 const env={OAUTH_STATE:{idFromName:x=>x,get:()=>({fetch:async()=>new Response(null,{status:500})})}};
 const defaults=await connectionDefaults(env,"u","k");
 await assert.rejects(defaults.get(),/Could not load/);await assert.rejects(defaults.set("b"),/Could not save/);
});
