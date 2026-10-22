const {test}=require('node:test');
const assert=require('node:assert/strict');
test('metrics keep zero, distinguish missing and reject invalid counters',async()=>{
 const {metricsText,readMetrics,metricsNote}=await import('../public/channels-metrics.mjs');
 assert.match(metricsText({counts:{favCount:0,forwardCount:12,likeCount:null}}),/点赞（拇指） 0 · 转发 12 · 推荐（爱心） 未获取/);
 assert.equal(readMetrics('broken'),null);
 assert.match(metricsNote({status:'failed',fetched_at:1789980000}),/更新失败.*更新/);
 assert.match(metricsText({counts:{favCount:true,forwardCount:-1,likeCount:1.2}}),/未获取.*未获取.*未获取/);
});
