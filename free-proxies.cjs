const {isIP} = require('node:net');
const SOURCES = [
  {name:'Databay HTTP (US)',url:'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/http.txt',type:'http'},
  {name:'Databay SOCKS5 (US)',url:'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/socks5.txt',type:'socks5'},
  {name:'Proxifly (US)',url:'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt'},
  {name:'Proxifly CDN (US)',url:'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/US/data.txt'}
];
function publicIPv4(host) {
  if(isIP(host)!==4)return false;
  const [a,b,c]=host.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||
    (a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||
    (a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
function parseList(text,source,defaultType) {
  const result=[],seen=new Set();
  for(const line of String(text).split(/\r?\n/)){
    const raw=line.trim();
    const normalized=defaultType&&/^[\d.]+:\d+$/.test(raw)?`${defaultType}://${raw}`:raw;
    const m=normalized.match(/^(http|https|socks5):\/\/([\d.]+):(\d{1,5})\/?$/);
    if(!m||!publicIPv4(m[2])||+m[3]<1||+m[3]>65535)continue;
    const id=`${m[1]}://${m[2]}:${+m[3]}`;
    if(seen.has(id))continue;seen.add(id);
    result.push({id,type:m[1],host:m[2],port:+m[3],source,status:'Chưa kiểm tra'});
    if(result.length>=3000)break;
  }
  return result;
}
async function readLimited(response,limit=1048576){
  if(!response.ok)throw Error(`HTTP ${response.status}`);
  const reader=response.body.getReader();const chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;
    if(total>limit){await reader.cancel();throw Error('Danh sách quá lớn.');}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
async function loadList(fetcher,signal) {
  const errors=[],merged=new Map(),used=[];
  for(const source of SOURCES){
    if(signal?.aborted)throw Error('Đã dừng cập nhật.');
    try{
      const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
      const response=await fetcher(source.url,{signal:combined,cache:'no-store',redirect:'error'});
      const items=parseList(await readLimited(response),source.name,source.type);
      if(items.length){for(const item of items)if(!merged.has(item.id))merged.set(item.id,item);used.push(source.name);continue;}
      errors.push(source.name+': danh sách trống');
    }catch(e){errors.push(source.name+': '+e.message);}
  }
  if(merged.size)return {items:[...merged.values()],source:used.join(' + '),updatedAt:new Date().toISOString()};
  throw Error('Không tải được danh sách proxy Mỹ. '+errors.join(' | '));
}
// Reuse a fixed number of probe sessions; never change the browsing session while testing.
async function scanCandidates(items,{probe,onResult=()=>{},signal,limit=36,concurrency=3}){
  const queue=items.slice(0,limit);let next=0,completed=0,winner=null;
  const local=new AbortController();const combined=signal?AbortSignal.any([signal,local.signal]):local.signal;
  async function worker(slot){
    while(next<queue.length&&!combined.aborted&&!winner){
      const item=queue[next++];onResult(item,{status:'Đang kiểm tra…'},completed,queue.length);
      try{
        const result=await probe(item,slot,combined);
        if(combined.aborted)break;
        completed++;
        onResult(item,{status:'Đã kết nối',...result},completed,queue.length);
        if(!winner){winner={item,result};local.abort();}
      }catch(error){
        if(combined.aborted){onResult(item,{status:'Chưa kiểm tra'},completed,queue.length);break;}
        completed++;onResult(item,{status:'Không dùng được',error:error.message},completed,queue.length);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},(_,i)=>worker(i)));
  return {winner,completed,total:queue.length,cancelled:!!signal?.aborted};
}
function chooseBatch(items,limit=36){
  const good=items.filter(x=>x.status==='Đã kết nối'||x.status==='IP Mỹ đã xác minh');
  const untested=items.filter(x=>x.status==='Chưa kiểm tra');
  const failed=items.filter(x=>!good.includes(x)&&!untested.includes(x));
  // Shuffle untested candidates so repeated runs do not favor dead entries at the top.
  for(let i=untested.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[untested[i],untested[j]]=[untested[j],untested[i]];}
  return [...good,...untested,...failed].slice(0,limit);
}
module.exports={SOURCES,publicIPv4,parseList,readLimited,loadList,scanCandidates,chooseBatch};
