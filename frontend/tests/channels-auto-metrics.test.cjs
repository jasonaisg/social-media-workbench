const {test}=require('node:test');
const assert=require('node:assert/strict');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};

test('list metrics accept real zero, reject absent/invalid counters, and preserve old missing fields',async()=>{
 const {listMetrics,mergeLiveMetrics}=await import('../public/channels-auto-metrics.mjs');
 assert.deepEqual(listMetrics({favCount:0,likeCount:2,forwardCount:7},10).counts,{favCount:0,forwardCount:7,likeCount:2});
 assert.equal(listMetrics({favCount:0,likeCount:2,forwardCount:7}).status,'ok');
 assert.deepEqual(listMetrics({favCount:null,forwardCount:'7',likeCount:false}).counts,{});
 const merged=mergeLiveMetrics({counts:{favCount:8,likeCount:4},local_downloaded:true},listMetrics({favCount:0},20));
 assert.deepEqual(merged.counts,{favCount:0,likeCount:4});assert.equal(merged.local_downloaded,true);
 assert.equal(merged.field_fetched_at.favCount,20);
});

test('automatic queue is serial, deduplicated, pauses without readiness, and permits explicit retry',async()=>{
 const {createMetricsQueue}=await import('../public/channels-auto-metrics.mjs');
 let ready=false;const calls=[],changes=[],requests=[];
 const q=createMetricsQueue({canRun:()=>ready,request:feed=>{calls.push(feed.id);const d=deferred();requests.push(d);return d.promise},onChange:(id,m)=>changes.push([id,m])});
 q.add({id:'a'});q.add({id:'a'});q.add({id:'b'});assert.equal(calls.length,0);
 ready=true;void q.kick();assert.deepEqual(calls,['a']);
 requests[0].reject(new Error('微信已断开'));await tick();assert.deepEqual(calls,['a','b']);
 assert.equal(changes.find(([id,m])=>id==='a'&&m.auto_state==='failed')[1].error,'微信已断开');
 requests[1].resolve({counts:{favCount:0,likeCount:0,forwardCount:0}});await tick();
 q.add({id:'a'},true);assert.deepEqual(calls,['a','b','a']);
 requests[2].resolve({counts:{favCount:3}});await tick();
 assert.ok(changes.some(([id,m])=>id==='a'&&m.auto_state==='partial'));
 q.dispose();
});

test('changing authors aborts old work and ignores late replies; disposing stops queued work',async()=>{
 const {createMetricsQueue}=await import('../public/channels-auto-metrics.mjs');
 const calls=[],changes=[],requests=[];
 const q=createMetricsQueue({request:(feed,signal)=>{const d=deferred();calls.push([feed.id,signal]);requests.push(d);return d.promise},onChange:(id,m)=>changes.push([id,m])});
 q.add({id:'old'});q.add({id:'discard'});q.reset();assert.equal(calls[0][1].aborted,true);
 q.add({id:'new'});requests[0].resolve({counts:{favCount:1,likeCount:2,forwardCount:3}});await tick();
 assert.deepEqual(calls.map(x=>x[0]),['old','new']);
 assert.equal(changes.some(([id,m])=>id==='old'&&m.auto_state==='done'),false);
 q.add({id:'discard2'});q.dispose();requests[1].resolve({counts:{favCount:1}});await tick();
 assert.equal(calls.length,2);assert.equal(calls[1][1].aborted,true);
});
