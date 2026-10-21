const {proxyConfig}=require('./core.cjs');
const {isIP}=require('node:net');
const BLOCKED={mode:'fixed_servers',proxyRules:'http://127.0.0.1:9',proxyBypassRules:'<-loopback>'};
function ipKey(ip){
  if(!isIP(ip))throw Error('Dịch vụ trả về IP không hợp lệ.');
  if(isIP(ip)===4)return ip;
  const canonical=new URL('http://['+ip+']/').hostname.slice(1,-1);
  const m=canonical.match(/^::ffff:([\da-f]+):([\da-f]+)$/i);
  if(m){const a=parseInt(m[1],16),b=parseInt(m[2],16);return [a>>8,a&255,b>>8,b&255].join('.');}
  return canonical;
}
class IPRegistry{
  constructor(){this.owners=new Map();}
  available(ip,id){const owner=this.owners.get(ipKey(ip));return owner===undefined||owner===id;}
  claim(ip,id){const key=ipKey(ip);if(!this.available(ip,id)){const e=Error('IP đầu ra trùng với tab khác. Hãy chọn proxy khác.');e.code='DUPLICATE_IP';throw e;}this.release(id);this.owners.set(key,id);}
  release(id){for(const [ip,owner] of this.owners)if(owner===id)this.owners.delete(ip);}
}
class TabConnection{
  constructor({id,session,registry,verify,geo,stop,onChange=()=>{}}){
    Object.assign(this,{id,session,registry,verify,geo,stop,onChange});
    this.connected=false;this.checking=false;this.creds={};this.closed=false;this.task=null;this.controller=null;this.proxy=null;
    this.state={connected:false,ip:'—',city:'—',message:'Chưa kết nối tab này.'};
  }
  changed(){if(!this.closed)this.onChange();}
  async lock(message){
    this.connected=false;this.checking=false;this.registry.release(this.id);this.stop();this.creds={};this.proxy=null;
    this.state={connected:false,ip:'—',city:'—',message};this.changed();
    await this.session.closeAllConnections();await this.session.setProxy(BLOCKED);
  }
  async connect(p,signal){
    const config=proxyConfig(p);
    try{
      await this.lock('Đang xác minh IP riêng cho tab…');signal.throwIfAborted();if(this.closed)throw Error('Tab đã đóng.');
      this.creds={host:p.host.trim(),port:p.port,user:p.user||'',password:p.password||''};
      await this.session.clearAuthCache();await this.session.setProxy(config);await this.session.closeAllConnections();
      signal.throwIfAborted();this.checking=true;
      const result=await this.verify(this.session,signal,this.creds);
      signal.throwIfAborted();if(this.closed)throw Error('Tab đã đóng.');
      // Reserve synchronously before awaiting geometry, preventing simultaneous tabs claiming one exit IP.
      this.registry.claim(result.ip,this.id);
      if (!p.skipGeo && p.city) await this.geo(p.city);
      signal.throwIfAborted();if(this.closed)throw Error('Tab đã đóng.');
      this.proxy={id:p.id,type:p.type,host:p.host,port:p.port};this.checking=false;this.connected=true;
      this.state={connected:true,...result,message:'Proxy đã kết nối cho tab này.'};this.changed();return result;
    }catch(e){await this.lock(signal.aborted?'Đã dừng kết nối tab.':e.message);throw e;}
  }
  async check(signal){
    if(!this.connected)throw Error('Tab chưa kết nối.');
    try{
      const result=await this.verify(this.session,signal,this.creds);signal.throwIfAborted();if(this.closed)throw Error('Tab đã đóng.');
      this.registry.claim(result.ip,this.id);this.state={connected:true,...result,message:'Vừa kiểm tra IP riêng của tab.'};this.changed();return result;
    }catch(e){await this.lock('Đã dừng tab: '+e.message);throw e;}
  }
  async run(fn){
    if(this.closed)throw Error('Tab đã đóng.');if(this.task)throw Error('Tab đang xử lý. Bấm Dừng tìm để hủy.');
    this.controller=new AbortController();const signal=this.controller.signal;
    this.task=Promise.resolve().then(()=>{signal.throwIfAborted();return fn(signal);});this.changed();
    try{return await this.task;}finally{this.task=null;this.controller=null;this.changed();}
  }
  cancel(){this.controller?.abort();}
  async disconnect(){this.cancel();if(this.task)await this.task.catch(()=>{});await this.lock('Đã ngắt riêng tab này.');}
  async dispose(){
    this.closed=true;this.cancel();this.connected=false;this.registry.release(this.id);this.stop();
    if(this.task)await this.task.catch(()=>{});
    await this.session.closeAllConnections();await this.session.clearStorageData();await this.session.clearAuthCache();this.creds={};
  }
}
function waitFor(promise,signal){
  if(!signal)return promise;
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
    promise.then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});
  });
}
module.exports={TabConnection,IPRegistry,ipKey,BLOCKED,waitFor};
