import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRun } from "./bridge-cursor-runtime";
import type { ComposerSidebar } from "./composer-sidebar";

const timing={pollMs:2,stallMs:20,startTimeoutMs:20,runTimeoutMs:100};
function sidebar(read:()=>unknown):ComposerSidebar{return {readConversation:read} as unknown as ComposerSidebar}
async function consume(run:BridgeRun){const events=[];for await(const event of run.stream())events.push(event);return {events,result:await run.wait()}}
test("a quiet bridge transcript is never reported as completed",async()=>{
 const run=new BridgeRun(sidebar(()=>({status:"aborted",assistant:[{bubbleId:"a",text:"Starting work"}]})),"chat",0,false,timing);
 const {events,result}=await consume(run);
 assert.ok(events.length>0);assert.equal(result.status,"error");assert.match(result.error!.message!,/without confirming completion/);
});
test("bridge store failures terminate the stream and report an error",async()=>{
 const run=new BridgeRun(sidebar(()=>{throw Error("store unavailable")}),"chat",0,false,timing);
 const {result}=await consume(run);assert.equal(result.status,"error");assert.match(result.error!.message!,/store unavailable/);
});
test("a confirmed bridge completion preserves its final answer",async()=>{
 const run=new BridgeRun(sidebar(()=>({status:"completed",assistant:[{bubbleId:"a",text:"Finished"}]})),"chat",0,false,timing);
 const {result}=await consume(run);assert.equal(result.status,"finished");assert.equal(result.result,"Finished");
});
