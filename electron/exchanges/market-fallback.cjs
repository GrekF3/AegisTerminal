// A failed stream may use one coalesced REST snapshot. Never start one HTTP
// request per UI consumer, and never relabel an old snapshot as a fresh one.
const pending=new Map(),recent=new Map();
async function marketWithFallback(key,primary,fallback) {
  const cached=recent.get(key);
  if(cached&&Date.now()-cached.at<1000)return cached.value;
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    try{return await primary();}
    catch(error){if(error.code!=='MARKET_STREAM_PENDING')throw error;
      const value=await fallback();recent.set(key,{at:Date.now(),value});return value;}
  })().finally(()=>pending.delete(key));
  pending.set(key,task);return task;
}
module.exports={marketWithFallback};
