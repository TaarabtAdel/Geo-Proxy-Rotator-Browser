const {test}=require('node:test');const assert=require('node:assert/strict');
const {proxyConfig,targetURL,checkUS,cities}=require('./core.cjs');
test('proxy fixed, no automatic DIRECT fallback',()=>{const p=proxyConfig({type:'http',host:'proxy.example.com',port:8080});assert.equal(p.mode,'fixed_servers');assert.equal(p.proxyRules,'http://proxy.example.com:8080');assert.equal(p.proxyBypassRules,'<-loopback>');});
test('reject proxy rules injection, bad ports, unsupported auth',()=>{for(const host of ['x;direct://','http://abc','a/b','a b',''])assert.throws(()=>proxyConfig({type:'http',host,port:80}));for(const port of [0,65536,'80x'])assert.throws(()=>proxyConfig({type:'http',host:'a',port}));assert.throws(()=>proxyConfig({type:'socks5',host:'a',port:80,user:'x'}));});
test('navigation rejects privileged URLs',()=>{for(const s of ['file:///etc/passwd','javascript:alert(1)','data:text/html,abc','https://user:pass@abc.com'])assert.throws(()=>targetURL(s));assert.equal(targetURL('example.com'),'https://example.com/');assert.match(targetURL('hello world'),/q=hello%20world/);});
test('fail closed for non-US and malformed IP lookup',()=>{for(const d of [{},{success:true,country_code:'VN',ip:'1.2.3.4'},{success:false,country_code:'US',ip:'1.2.3.4'}])assert.throws(()=>checkUS(d));assert.equal(checkUS({success:true,country_code:'US',ip:'1.2.3.4'}).country,'US');assert.ok(Object.keys(cities).length>=50);});
const {checkIP}=require('./core.cjs');
test('checkIP accepts any country when proxy responds',()=>{assert.equal(checkIP({success:true,country_code:'DE',ip:'1.2.3.4',city:'Berlin'}).country,'DE');assert.throws(()=>checkIP({success:false,ip:'1.2.3.4'}));});
const {parseProxySource,parseProxyLine}=require('./parse-proxy.cjs');
test('parse proxy lines like Geo-Proxy-Rotator',()=>{
 assert.deepEqual(parseProxyLine('96.227.245.221:999'),{host:'96.227.245.221',port:999,protocol:'http'});
 assert.deepEqual(parseProxyLine('socks5://1.2.3.4:1080'),{host:'1.2.3.4',port:1080,protocol:'socks5'});
 assert.equal(parseProxySource('8.8.8.8:80\n# comment\nbad\n8.8.8.8:80').proxies.length,1);
});
const {loadProxyList,loadLinkList}=require('./local-lists.cjs');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
test('load local list files from directory',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-browser-'));
 await fs.writeFile(path.join(dir,'list-proxy.txt'),'1.2.3.4:8080\n5.6.7.8:3128\n');
 await fs.writeFile(path.join(dir,'list-link.txt'),'https://example.com/a\n# x\nnot-a-url\nhttps://b.test/\n');
 const proxies=await loadProxyList(dir);assert.equal(proxies.items.length,2);
 assert.deepEqual(await loadLinkList(dir),['https://example.com/a','https://b.test/']);
});
const {parseList,publicIPv4,loadList,scanCandidates,chooseBatch}=require('./free-proxies.cjs');
test('public feed parser rejects private addresses, injected rules, credentials and unsupported protocols',()=>{
 const input=['http://8.8.8.8:80','http://8.8.8.8:80','https://1.1.1.1:443','socks5://9.9.9.9:1080','http://127.0.0.1:80','http://10.0.0.1:80','http://169.254.169.254:80','socks4://8.8.4.4:10','http://8.8.8.8:0','http://user:pw@8.8.8.8:80','http://8.8.8.8:80;direct://'].join('\n');
 assert.equal(parseList(input,'test').length,3);assert.equal(publicIPv4('100.64.0.1'),false);assert.equal(publicIPv4('192.168.1.1'),false);assert.equal(proxyConfig({type:'https',host:'1.1.1.1',port:443}).proxyRules,'https://1.1.1.1:443');
});
test('list loading falls back, rejects malformed feeds and cancels',async()=>{
 let n=0;const r=await loadList(async()=>{if(n++===0)throw Error('unavailable');return new Response('http://8.8.8.8:80');});assert.equal(r.items.length,1);assert.ok(n>=2);
 await assert.rejects(loadList(async()=>new Response('<html>no proxies</html>')));
 const c=new AbortController();c.abort();await assert.rejects(loadList(async()=>{throw Error('must not fetch');},c.signal));
});
test('scan enforces concurrency and exits when a valid US result is returned',async()=>{
 const items=Array.from({length:10},(_,id)=>({id}));let active=0,max=0,calls=0;
 const r=await scanCandidates(items,{concurrency:3,probe:async(item,slot,signal)=>{active++;max=Math.max(max,active);calls++;try{await new Promise(r=>setTimeout(r,5));if(item.id===2)return {country:'US',ip:'1.2.3.4'};throw Error('dead');}finally{active--;}}});
 assert.equal(r.winner.item.id,2);assert.ok(max<=3);assert.ok(calls<10);
});
test('all failed does not connect and repeat scan prefers remaining entries',async()=>{
 const items=Array.from({length:5},(_,id)=>({id,status:'Chưa kiểm tra'}));
 const r=await scanCandidates(items,{limit:3,probe:async()=>{throw Error('offline');},onResult:(p,v)=>Object.assign(p,v)});
 assert.equal(r.winner,null);assert.equal(r.completed,3);assert.equal(chooseBatch(items,2).filter(x=>x.status==='Chưa kiểm tra').length,2);
});
test('cancel stops scanning without declaring a connection',async()=>{
 const c=new AbortController();let calls=0;
 const r=await scanCandidates([{id:1},{id:2}],{signal:c.signal,concurrency:1,probe:async()=>{calls++;c.abort();throw Error('abort');}});
 assert.equal(r.cancelled,true);assert.equal(r.winner,null);assert.equal(calls,1);
});
const {BrowserTabs}=require('./tabs.cjs');
function tabHarness(){
 const configured=[],closed=[],attached=[];
 const manager=new BrowserTabs({cities:['New York','Los Angeles','Honolulu','Denver'],createView:()=>({webContents:{close(){closed.push(this);},stop(){}},setVisible(){}}),attach:v=>attached.push(v),remove:v=>attached.splice(attached.indexOf(v),1),configure:async(t,c)=>{configured.push([t.id,c]);},onChange:()=>{}});
 return {manager,configured,closed,attached};
}
test('tabs switch and close independently, last close leaves a new tab',async()=>{
 const {manager:m,closed,attached}=tabHarness();const a=await m.create('https://a.com');const b=await m.create('https://b.com');
 assert.equal(m.active.id,b.id);m.activate(a.id);assert.equal(m.active.url,'https://a.com');
 await m.close(b.id);assert.equal(m.active.id,a.id);assert.equal(closed.length,1);assert.equal(attached.length,1);
 await m.close(a.id);assert.equal(m.items.length,1);assert.notEqual(m.active.id,a.id);assert.equal(m.active.url,'');
});
test('each tab keeps its own location while another tab changes',async()=>{
 const {manager:m,configured}=tabHarness();const a=await m.create();const b=await m.create();
 await m.changeCity(a.id,'Honolulu');const c=await m.create();
 assert.equal(a.city,'Honolulu');assert.equal(b.city,null);assert.equal(c.city,null);
 assert.ok(!configured.some(x=>x[0]===b.id&&x[1]==='Honolulu'));
 m.cycle(-1);assert.equal(m.activeId,b.id);
});
test('failed location configuration rolls back only the selected tab',async()=>{
 const {manager:m}=tabHarness();const a=await m.create();const b=await m.create();
 m.configure=async(t,c)=>{if(t.id===a.id&&c==='Denver')throw Error('CDP unavailable');};
 await assert.rejects(m.changeCity(a.id,'Denver'));assert.equal(a.city,null);assert.equal(b.city,null);
});
test('failed tab creation does not leave a tab or attached view',async()=>{
 const {manager:m,closed,attached}=tabHarness();m.configure=async()=>{throw Error('CDP failure');};
 await assert.rejects(m.create());assert.equal(m.items.length,0);assert.equal(closed.length,1);assert.equal(attached.length,0);
});

test('plain country feeds parse and sources merge without duplicates',async()=>{assert.equal(parseList('8.8.8.8:80','US','http')[0].type,'http');const r=await loadList(async()=>new Response('http://8.8.8.8:80'));assert.equal(r.items.length,1);assert.match(r.source,/Databay/);});
const {IPRegistry,TabConnection,ipKey}=require('./tab-network.cjs');
function networkHarness(id,registry,ip){
 const calls=[],session={async closeAllConnections(){calls.push('close');},async setProxy(p){calls.push(p.proxyRules);},async clearAuthCache(){},async clearStorageData(){calls.push('clear');}};
 const n=new TabConnection({id,session,registry,verify:async()=>({ip,country:'US',city:'Test'}),geo:async city=>calls.push('geo:'+city),stop:()=>calls.push('stop')});
 return {n,calls,session};
}
const proxy={type:'http',host:'proxy.example',port:8080,city:'New York'};
test('two tabs receive independent proxies and disconnect only their own session',async()=>{
 const reg=new IPRegistry(),a=networkHarness(1,reg,'8.8.8.8'),b=networkHarness(2,reg,'1.1.1.1');
 await Promise.all([a.n.run(sig=>a.n.connect(proxy,sig)),b.n.run(sig=>b.n.connect({...proxy,host:'other.example',city:'Miami'},sig))]);
 assert.equal(a.n.state.ip,'8.8.8.8');assert.equal(b.n.state.ip,'1.1.1.1');
 const unchanged=[...b.calls];await a.n.disconnect();assert.equal(a.n.connected,false);assert.equal(b.n.connected,true);assert.deepEqual(b.calls,unchanged);
 assert.ok(!reg.available('1.1.1.1',1));assert.ok(reg.available('8.8.8.8',2));
});
test('simultaneous equal exit IPs cannot both connect',async()=>{
 const reg=new IPRegistry(),a=networkHarness(1,reg,'8.8.8.8'),b=networkHarness(2,reg,'8.8.8.8');
 const r=await Promise.allSettled([a.n.run(sig=>a.n.connect(proxy,sig)),b.n.run(sig=>b.n.connect(proxy,sig))]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(Number(a.n.connected)+Number(b.n.connected),1);
 assert.equal(r.find(x=>x.status==='rejected').reason.code,'DUPLICATE_IP');
});
test('rechecking a rotating proxy detects duplicate and stops only that tab',async()=>{
 const reg=new IPRegistry(),a=networkHarness(1,reg,'8.8.8.8'),b=networkHarness(2,reg,'1.1.1.1');
 await a.n.run(sig=>a.n.connect(proxy,sig));await b.n.run(sig=>b.n.connect(proxy,sig));
 b.n.verify=async()=>({ip:'8.8.8.8',country:'US',city:'Test'});
 await assert.rejects(b.n.run(sig=>b.n.check(sig)),{code:'DUPLICATE_IP'});
 assert.equal(a.n.connected,true);assert.equal(b.n.connected,false);
});
test('cancelling one connecting tab does not cancel another and clears its IP reservation',async()=>{
 const reg=new IPRegistry(),a=networkHarness(1,reg,'8.8.8.8'),b=networkHarness(2,reg,'1.1.1.1');
 let releaseGeo;const waiting=new Promise(r=>{releaseGeo=r;});a.n.geo=()=>waiting;
 const pending=a.n.run(sig=>a.n.connect(proxy,sig));
 await b.n.run(sig=>b.n.connect(proxy,sig));a.n.cancel();releaseGeo();
 await assert.rejects(pending);assert.equal(a.n.connected,false);assert.equal(b.n.connected,true);assert.ok(reg.available('8.8.8.8',2));
});
test('IP comparisons normalize IPv6 and mapped IPv4 forms',()=>{
 const reg=new IPRegistry();reg.claim('2001:4860:4860::8888',1);
 assert.equal(reg.available('2001:4860:4860:0:0:0:0:8888',2),false);
 assert.equal(ipKey('::ffff:8.8.8.8'),'8.8.8.8');assert.throws(()=>ipKey('not-an-ip'));
});
test('closing one network clears its cookies/auth only, leaving other session intact',async()=>{
 const reg=new IPRegistry(),a=networkHarness(1,reg,'8.8.8.8'),b=networkHarness(2,reg,'1.1.1.1');
 await a.n.run(sig=>a.n.connect(proxy,sig));await b.n.run(sig=>b.n.connect(proxy,sig));
 const before=[...b.calls];await a.n.dispose();assert.ok(a.calls.includes('clear'));assert.deepEqual(b.calls,before);assert.equal(b.n.connected,true);
});
const {EventEmitter}=require('node:events');const {verifyIP}=require('./verify.cjs');
test('IP verification uses requested session and credentials scoped to that proxy',async()=>{
 const s={name:'private-tab-session'};let observed,auth;
 const net={request(options){observed=options;const req=new EventEmitter();req.setHeader=()=>{};req.abort=()=>{};
 req.end=()=>queueMicrotask(()=>{
  req.emit('login',{isProxy:true,host:'proxy.example',port:8080},(...args)=>auth=args);
  const res=new EventEmitter();res.statusCode=200;req.emit('response',res);res.emit('data',Buffer.from(JSON.stringify({success:true,country_code:'US',ip:'8.8.8.8',city:'X'})));res.emit('end');
 });return req;}};
 const result=await verifyIP(net,s,new AbortController().signal,{host:'proxy.example',port:8080,user:'tab-user',password:'tab-pass'});
 assert.equal(observed.session,s);assert.equal(observed.useSessionCookies,false);assert.deepEqual(auth,['tab-user','tab-pass']);assert.equal(result.ip,'8.8.8.8');
});
test('verification never supplies proxy credentials to a different host',async()=>{
 let auth;const net={request(){const req=new EventEmitter();req.setHeader=()=>{};req.abort=()=>{};req.end=()=>queueMicrotask(()=>{
 req.emit('login',{isProxy:true,host:'wrong.example',port:8080},(...args)=>auth=args);req.emit('error',Error('authentication refused'));
 });return req;}};
 await assert.rejects(verifyIP(net,{},new AbortController().signal,{host:'proxy.example',port:8080,user:'a',password:'b'}));assert.deepEqual(auth,[]);
});
const {RandomReload,INTERVALS}=require('./auto-reload.cjs');
function reloadHarness(random=()=>0){
 let available=true,time=1000,count=0,id=0;const timers=new Map();
 const r=new RandomReload({canReload:()=>available,reload:()=>{count++;available=false;},random,now:()=>time,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
 return {r,timers,setAvailable:v=>{available=v;r.reconcile();},count:()=>count,fire:()=>{const [key,t]=timers.entries().next().value;timers.delete(key);time+=t.ms;t.fn();}};
}
test('random reload picks exactly the eight requested intervals',()=>{
 assert.deepEqual(INTERVALS,[60,120,180,240,300,360,420,480]);
 for(let i=0;i<8;i++){const {r,timers}=reloadHarness(()=>i/8);r.setEnabled(true);assert.equal(r.snapshot().delay,INTERVALS[i]);assert.equal([...timers.values()][0].ms,INTERVALS[i]*1000);}
});
test('reload waits for completion, chooses again and does not reset on tab UI updates',()=>{
 let index=0;const h=reloadHarness(()=>index++/8);h.r.setEnabled(true);const deadline=h.r.nextAt;
 h.r.reconcile();h.r.reconcile();assert.equal(h.r.nextAt,deadline);assert.equal(h.timers.size,1);
 h.fire();assert.equal(h.count(),1);assert.equal(h.timers.size,0);assert.equal(h.r.snapshot().paused,true);
 h.setAvailable(true);assert.equal(h.r.delay,120);assert.equal(h.timers.size,1);
});
const {articleSkipReason,shouldFailProxy,articleFailedToLoad,isArticlePageUrl}=require('./article-flow.cjs');
const {GeoDataStore}=require('./geo-data.cjs');
test('article skip and proxy fatal match extension rules',()=>{
 assert.equal(articleSkipReason(403,''),'HTTP 403');
 assert.equal(articleSkipReason(0,'ERR_CERT_AUTHORITY_INVALID'),'ERR_CERT_AUTHORITY_INVALID');
 assert.equal(shouldFailProxy({status:407,error:''}),true);
 assert.equal(shouldFailProxy({status:0,error:'ERR_PROXY_CONNECTION_FAILED'}),true);
 assert.equal(isArticlePageUrl('https://example.com/a'),true);
 assert.equal(isArticlePageUrl('https://ipwho.is/'),false);
 assert.equal(articleFailedToLoad({status:0,error:''},'chrome-error://'),true);
});
test('geo data store remembers proxy article pairs',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usa-geo-'));
 const store=new GeoDataStore(dir);
 const proxy={type:'http',host:'1.2.3.4',port:8080,user:'',password:''};
 await store.load();
 assert.equal(store.pendingPairExists([proxy],['https://a.test/']),true);
 await store.remember(proxy,'https://a.test/x',{ok:true});
 assert.equal(store.alreadyRun(proxy,'https://a.test/x'),true);
 assert.equal(store.pendingPairExists([proxy],['https://a.test/x']),false);
 assert.equal(store.countPairs(),1);
});
test('page script that never returns cannot block the article loop',async()=>{
 const {runScript}=require('./scroll.cjs');
 const hung={isDestroyed:()=>false,executeJavaScript:()=>new Promise(()=>{})};
 const t=Date.now();await runScript(hung,'1',50);assert.ok(Date.now()-t<1000);
 const failing={isDestroyed:()=>false,executeJavaScript:()=>Promise.reject(Error('gone'))};
 await runScript(failing,'1',50);
});
test('truncated data file is backed up and salvaged instead of crashing',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-broken-'));
 const full=JSON.stringify({version:1,proxyHealth:{'1.1.1.1:80':{status:'dead'}},proxyArticleDone:{'1.1.1.1:80':[{url:'https://a.test/',ok:true,at:1},{url:'https://b.test/',ok:false,at:2,note:'x'}]}},null,2);
 await fs.writeFile(path.join(dir,'geo-proxy-data.json'),full.slice(0,full.lastIndexOf('"note"')));
 const s=new GeoDataStore(dir);await s.load();
 assert.ok(s.recovered.backup.startsWith('geo-proxy-data.broken-'));
 assert.equal(s.isDead({type:'http',host:'1.1.1.1',port:80}),true);
 assert.equal(s.alreadyRun({type:'http',host:'1.1.1.1',port:80},'https://a.test/'),true);
 await s.save();JSON.parse(await fs.readFile(path.join(dir,'geo-proxy-data.json'),'utf8'));
 assert.ok(!(await fs.readdir(dir)).some(f=>f.endsWith('.tmp')));
});
test('Next skips the wait, skips a loading article once, and never cascades',async()=>{
 const {runArticles,requestNext,defaultRunnerState}=require('./tab-runner.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-next-'));
 const store=new GeoDataStore(dir);await store.load();
 const wc=new EventEmitter();let url='',loading=false;
 Object.assign(wc,{id:1,isDestroyed:()=>false,isLoading:()=>loading,stop(){loading=false;},getURL:()=>url,executeJavaScript:async()=>{}});
 const session={webRequest:{onCompleted(){},onErrorOccurred(){}}};
 const tab={id:1,view:{webContents:wc},session,runner:defaultRunnerState()};
 const state=tab.runner;state.running=true;
 const links=['https://a.test/1','https://a.test/2','https://a.test/3'];
 const hangs=new Set(['https://a.test/2']);
 const deps={links,dataStore:store,publishPanel(){},config:{waitMinSec:30,waitMaxSec:30,articleLoadTimeoutSec:30,scrollEnabled:false},
  loadTab(t,u){url=u;loading=true;if(!hangs.has(u))setTimeout(()=>{loading=false;wc.emit('did-stop-loading');},30);}};
 const clicks=setInterval(()=>{if((state.phase==='waiting'&&state.articleIndex!==1)||(state.phase==='loading_article'&&state.articleIndex===1&&loading))requestNext(tab);},150);
 const proxy={type:'http',host:'9.9.9.9',port:80};
 const t=Date.now();
 try{await runArticles(deps,tab,state,new AbortController().signal,proxy);}finally{clearInterval(clicks);}
 assert.ok(Date.now()-t<10000);
 const list=store.done['9.9.9.9:80'];
 const get=u=>list.find(e=>e.url===u);
 assert.equal(get('https://a.test/1').ok,true);
 assert.equal(get('https://a.test/2').ok,false);assert.match(get('https://a.test/2').note,/Next/);
 assert.equal(get('https://a.test/3').ok,true);
});
test('geo-config.json may contain comments and still loads',async()=>{
 const {stripJsonComments,loadRotatorConfig}=require('./rotator-config.cjs');
 assert.deepEqual(JSON.parse(stripJsonComments('{\n // a\n "u": "http://x//y", /* b */ "n": 1,\n}')),{u:'http://x//y',n:1});
 const c=await loadRotatorConfig(__dirname);
 assert.equal(c.waitMinSec,100);assert.equal(c.scrollSpeed,'normal');assert.equal(c.articleLoadTimeoutSec,60);
});
test('fresh install seeds data from committed sample but never overwrites',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-seed-'));
 const sample=path.join(dir,'geo-proxy-data.sample.json');
 await fs.writeFile(sample,JSON.stringify({version:1,proxyArticleDone:{'1.2.3.4:80':['https://a.test/']}}));
 const store=new GeoDataStore(dir);
 assert.equal(await store.seedFrom(sample),true);await store.load();assert.equal(store.countPairs(),1);
 await store.remember({type:'http',host:'5.5.5.5',port:80},'https://b.test/',{ok:true});
 assert.equal(await store.seedFrom(sample),false);await store.load();assert.equal(store.countPairs(),2);
 assert.equal(await new GeoDataStore(path.join(dir,'none')).seedFrom(path.join(dir,'missing.json')),false);
});
test('geo data file uses extension format and merge rules',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usa-geo-'));
 const file=path.join(dir,'geo-proxy-data.json');
 await fs.writeFile(file,JSON.stringify({version:1,savedAt:1,config:{loop:true},proxyLease:{x:{owner:'p',claimedAt:1}},
  proxyHealth:{'1.2.3.4:8080':{status:'dead',updatedAt:5,owner:'p',ip:'',note:'x'}},
  proxyArticleDone:{'1.2.3.4:8080':['https://a.test/p?fbclid=abc']}}));
 const store=new GeoDataStore(dir);await store.load();
 const proxy={type:'http',host:'1.2.3.4',port:8080};
 assert.equal(store.isDead(proxy),true);
 assert.equal(store.alreadyRun(proxy,'https://a.test/p?fbclid=zzz'),true);
 await store.remember(proxy,'https://a.test/q?fbclid=1',{ok:true});
 await store.remember(proxy,'https://a.test/q',{ok:false,note:'timeout'});
 const saved=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual(Object.keys(saved),['version','savedAt','config','proxyHealth','proxyArticleDone','proxyLease']);
 assert.deepEqual(saved.config,{loop:true});assert.ok(saved.proxyLease.x);
 const q=saved.proxyArticleDone['1.2.3.4:8080'].find(e=>typeof e==='object');
 assert.equal(q.url,'https://a.test/q');assert.equal(q.ok,true);assert.equal(typeof q.at,'number');
});
test('tabs never check the same proxy at once and stopping mid-check does not mark it dead',async()=>{
 const {acquireProxy,defaultRunnerState}=require('./tab-runner.cjs');
 const {ProxyLease}=require('./proxy-lease.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-lease-'));
 const store=new GeoDataStore(dir);await store.load();
 const candidates=[1,2,3].map(n=>({id:'p'+n,type:'http',host:'10.0.0.'+n,port:80}));
 const lease=new ProxyLease();const checking=new Map();
 const deps={candidates,lease,dataStore:store,links:['https://a.test/'],config:{proxyTimeoutSec:5},
  ensureLists:async()=>{},publishPanel(){},
  connectTab:(tab,p,signal)=>new Promise((_,reject)=>{checking.set(tab.id,p.id);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})};
 const mk=id=>({id,proxySlot:0,proxyCursor:0,runner:Object.assign(defaultRunnerState(),{running:true})});
 const a=mk(1),b=mk(2),ca=new AbortController(),cb=new AbortController();
 const ra=acquireProxy(deps,a,a.runner,ca.signal),rb=acquireProxy(deps,b,b.runner,cb.signal);
 await new Promise(r=>setTimeout(r,600));
 assert.equal(checking.get(1),'p1');assert.equal(checking.get(2),'p2');
 assert.equal(lease.status('p1'),'checking');assert.equal(lease.status('p2'),'checking');
 const statsNow=store.stats(candidates,id=>lease.status(id));assert.equal(statsNow.checking,2);
 ca.abort();cb.abort();
 await assert.rejects(ra);await assert.rejects(rb);
 assert.equal(store.isDead(candidates[0]),false);assert.equal(store.isDead(candidates[1]),false);
 assert.equal(lease.has('p1'),false);assert.equal(lease.has('p2'),false);
 assert.equal(a.runner.failedCount,0);
});
test('only real proxy failures during check are marked dead',async()=>{
 const {acquireProxy,checkFailureKind,defaultRunnerState}=require('./tab-runner.cjs');
 const {ProxyLease}=require('./proxy-lease.cjs');
 const dup=Error('IP đầu ra trùng với tab khác.');dup.code='DUPLICATE_IP';
 assert.equal(checkFailureKind(dup),'skip');
 assert.equal(checkFailureKind(Error('Dịch vụ IP trả HTTP 429')),'skip');
 assert.equal(checkFailureKind(Error('net::ERR_INTERNET_DISCONNECTED')),'local');
 assert.equal(checkFailureKind(Error('net::ERR_PROXY_CONNECTION_FAILED')),'dead');
 assert.equal(checkFailureKind(Error('Hết thời gian kiểm tra IP.')),'dead');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-kind-'));
 const store=new GeoDataStore(dir);await store.load();
 const candidates=[1,2,3].map(n=>({id:'p'+n,type:'http',host:'10.0.1.'+n,port:80}));
 const errors={p1:dup,p2:Error('net::ERR_PROXY_CONNECTION_FAILED'),p3:Error('net::ERR_INTERNET_DISCONNECTED')};
 const deps={candidates,lease:new ProxyLease(),dataStore:store,links:['https://a.test/'],config:{proxyTimeoutSec:5},
  ensureLists:async()=>{},publishPanel(){},connectTab:async(tab,p)=>{throw errors[p.id];}};
 const tab={id:1,proxySlot:0,proxyCursor:0,runner:Object.assign(defaultRunnerState(),{running:true})};
 await assert.rejects(acquireProxy(deps,tab,tab.runner,new AbortController().signal),e=>e.name==='NoProxyError'&&e.busy);
 assert.equal(store.isDead(candidates[0]),false);
 assert.equal(store.isDead(candidates[1]),true);
 assert.equal(store.isDead(candidates[2]),false);
 assert.equal(tab.runner.failedCount,1);
 assert.equal(tab.proxyCursor,2);
});
test('stale extension pending counts as untried and all chips add up to total',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-pending-'));
 await fs.writeFile(path.join(dir,'geo-proxy-data.json'),JSON.stringify({version:1,proxyHealth:{
  '1.1.1.1:80':{status:'pending',owner:'ext',updatedAt:1,note:'Đang dùng'},
  '1.1.1.2:80':{status:'dead',owner:'ext',updatedAt:1},
  '1.1.1.3:80':{status:'live',owner:'ext',updatedAt:1}}}));
 const store=new GeoDataStore(dir);await store.load();
 const list=[1,2,3,4].map(n=>({id:'1.1.1.'+n+':80',type:'http',host:'1.1.1.'+n,port:80}));
 const s=store.stats(list,id=>id==='1.1.1.4:80'?'checking':null);
 assert.equal(s.untried,1);assert.equal(s.dead,1);assert.equal(s.live,1);assert.equal(s.checking,1);
 assert.equal(s.untried+s.dead+s.busy+s.live+s.inUse+s.checking,s.total);
 assert.equal(store.isDead(list[0]),false);
});
test('settings in geo-proxy-data.json win over txt files, which only seed an empty config',async()=>{
 const S=require('./app-settings.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-settings-'));
 await fs.writeFile(path.join(dir,'list-proxy.txt'),'1.1.1.1:80\n');
 await fs.writeFile(path.join(dir,'list-link.txt'),'https://file.test/a\n');
 await fs.writeFile(path.join(dir,'geo-config.json'),'{"waitMinSec":7,"waitMaxSec":9}');
 const store=new GeoDataStore(dir);await store.load();
 let r=await S.resolveLists(store,dir);
 assert.equal(r.proxySource,'list-proxy.txt');assert.equal(r.linkSource,'list-link.txt');
 assert.deepEqual(r.links,['https://file.test/a']);assert.equal(r.runnerConfig.waitMinSec,7);
 const before=S.configStamp(store.config);
 await store.updateConfig(S.settingsPatch({proxySourceUrl:'https://src.test/a.txt|socks5',
  proxyText:'2.2.2.2:8080\nsocks5://3.3.3.3:1080\n2.2.2.2:8080\nrác',articleText:'https://cfg.test/x?fbclid=1\nhttps://cfg.test/x?fbclid=2',
  waitMinSec:50,waitMaxSec:20,proxyTimeoutSec:30,articleLoadTimeoutSec:60,scrollEnabled:true,scrollSpeed:'fast',scrollDepthPercent:90,loop:true}));
 assert.notEqual(S.configStamp(store.config),before);
 r=await S.resolveLists(store,dir);
 assert.equal(r.proxySource,'geo-proxy-data.json');
 assert.deepEqual(r.candidates.map(c=>c.id),['2.2.2.2:8080','socks5://3.3.3.3:1080']);
 assert.deepEqual(r.links,['https://cfg.test/x?fbclid=1']);
 assert.equal(r.runnerConfig.waitMinSec,20);assert.equal(r.runnerConfig.waitMaxSec,50);assert.equal(r.runnerConfig.scrollSpeed,'fast');
 assert.equal(store.config.proxySourceUrl,'https://src.test/a.txt|socks5');
 assert.throws(()=>S.settingsPatch({proxyText:'',articleText:'ftp://x',waitMinSec:1,waitMaxSec:1,proxyTimeoutSec:15,articleLoadTimeoutSec:60,scrollDepthPercent:95}),/http/);
 assert.throws(()=>S.settingsPatch({proxyText:'',articleText:'',waitMinSec:1,waitMaxSec:1,proxyTimeoutSec:2,articleLoadTimeoutSec:60,scrollDepthPercent:95}),/Timeout proxy/);
});
test('fetching proxy sources merges in order, forces protocol, and keeps going when one source fails',async()=>{
 const S=require('./app-settings.cjs');
 const bodies={'https://a.test/list.txt':'1.1.1.1:80\n2.2.2.2:80','https://b.test/s5.txt':'2.2.2.2:80\n4.4.4.4:1080'};
 const fetcher=async(url)=>bodies[url]!=null?{ok:true,status:200,text:async()=>bodies[url]}:{ok:false,status:500};
 const r=await S.fetchProxySources('https://a.test/list.txt\nhttps://b.test/s5.txt|socks5\nhttps://down.test/x',fetcher);
 assert.deepEqual(r.proxyText.split('\n'),['1.1.1.1:80','2.2.2.2:80','socks5://2.2.2.2:80','socks5://4.4.4.4:1080']);
 assert.equal(r.errors.length,1);assert.match(r.errors[0],/HTTP 500/);
 await assert.rejects(S.fetchProxySources('https://down.test/x',fetcher),/HTTP 500/);
});
test('settings table shows the same status words as the tab panel',async()=>{
 const S=require('./app-settings.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'geo-table-'));
 const store=new GeoDataStore(dir);await store.load();
 await store.setHealth({type:'http',host:'1.1.1.1',port:80},'live',{ip:'9.9.9.9'});
 await store.setHealth({type:'http',host:'1.1.1.2',port:80},'dead',{note:'ERR_PROXY_CONNECTION_FAILED'});
 const t=S.inspectProxies('1.1.1.1:80\n1.1.1.2:80\n1.1.1.3:80\n1.1.1.4:80\nsocks5://1.1.1.5:1080:u:p\nxx',store,id=>id==='1.1.1.4:80'?'checking':null);
 assert.deepEqual(t.rows.map(r=>r.status),['Live','Không','Chưa thử','Đang kiểm tra','Không hỗ trợ']);
 assert.equal(t.rows[0].title,'IP 9.9.9.9');assert.equal(t.skipped,1);assert.equal(t.counts['Chưa thử'],1);
});
function fakeGeoSyncServer(){
 const leases=new Map(),health={},done={},log=[];let config={};
 const live=()=>{const now=Date.now();for(const [k,l] of leases)if(l.expiresAt<=now)leases.delete(k);return [...leases.entries()].map(([key,l])=>({key,...l}));};
 const handlers={
  claim:b=>{live();const l=leases.get(b.key);if(l&&l.owner!==b.owner)return{ok:false,owner:l.owner};leases.set(b.key,{owner:b.owner,machine:b.machine,expiresAt:Date.now()+b.ttlMs,claimedAt:Date.now()});return{ok:true};},
  release:b=>{for(const [k,l] of leases)if(b.machine&&!b.owner?l.machine===b.machine:(l.owner===b.owner&&(!b.keys||b.keys.includes(k))))leases.delete(k);return{ok:true};},
  renew:()=>({ok:true}),
  batch:b=>{for(const op of b.ops){log.push(op);if(op.action==='setHealth')health[op.proxyKey]={...op.entry,updatedAt:Date.now()};else (done[op.proxyKey]||(done[op.proxyKey]=[])).push({url:op.url,ok:op.outcome?.ok,at:1});}return{ok:true};},
  updateConfig:b=>{config={...config,...b.patch};return{ok:true,config};},
  pull:()=>({ok:true,full:true,seq:log.length,config,proxyHealth:health,proxyArticleDone:done,leases:live()}),
 };
 const fetcher=async(url,opts)=>{const b=JSON.parse(opts.body);if(opts.headers['x-geo-sync-key']!=='k')return{ok:false,status:401,json:async()=>({error:'Sai khoá đồng bộ.'})};
  return{ok:true,status:200,json:async()=>handlers[b.action](b)};};
 return {fetcher,leases,log};
}
test('host mode: two machines never check the same proxy and share health through the server',async()=>{
 const {SyncClient}=require('./sync-client.cjs');const {RemoteGeoDataStore,RemoteProxyLease}=require('./remote-store.cjs');
 const {acquireProxy,defaultRunnerState}=require('./tab-runner.cjs');
 const srv=fakeGeoSyncServer();
 const candidates=[1,2,3,4].map(n=>({id:'10.9.0.'+n+':80',type:'http',host:'10.9.0.'+n,port:80,user:'',password:''}));
 const machine=async name=>{const client=new SyncClient({url:'http://h',key:'k',machine:name,fetcher:srv.fetcher});
  const store=new RemoteGeoDataStore(client,name);await store.load();const lease=new RemoteProxyLease(client,name);const checking=new Map();
  return {store,lease,checking,deps:{candidates,lease,dataStore:store,links:['https://a.test/'],config:{proxyTimeoutSec:5},ensureLists:async()=>{},publishPanel(){},
   connectTab:(tab,p,signal)=>new Promise((_,reject)=>{checking.set(tab.id,p.id);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}};};
 const A=await machine('nha'),B=await machine('cty');
 const runs=[];
 for(const M of [A,B])for(const id of [1,2]){const tab={id,proxySlot:0,proxyCursor:0,runner:Object.assign(defaultRunnerState(),{running:true})};
  const ctrl=new AbortController();const p=acquireProxy(M.deps,tab,tab.runner,ctrl.signal);p.catch(()=>{});runs.push({M,tab,ctrl,p});}
 await new Promise(r=>setTimeout(r,700));
 const used=runs.map(r=>r.M.checking.get(r.tab.id));
 assert.equal(new Set(used).size,4);assert.equal(srv.leases.size,4);
 await A.store.setHealth(candidates[3],'dead',{note:'x'});await A.store.flush();
 B.store.lastPull=0;await B.store.refreshIfChanged();
 assert.equal(B.store.isDead(candidates[3]),true);
 assert.equal(candidates.filter(c=>B.store.isBusyExternal(c)).length,2);
 for(const r of runs)r.ctrl.abort();for(const r of runs)await r.p.catch(()=>{});
 for(const r of runs)r.M.lease.release(r.tab.id);
 await new Promise(r=>setTimeout(r,50));
 assert.equal(srv.leases.size,0);
 assert.equal(A.store.isDead(candidates[0]),false);
});
test('data mode is local unless host is chosen; old enabled flag still means host',()=>{
 const {normalizeSyncConfig}=require('./sync-client.cjs');
 assert.equal(normalizeSyncConfig({}).mode,'local');
 assert.equal(normalizeSyncConfig({mode:'host'}).mode,'host');
 assert.equal(normalizeSyncConfig({enabled:true}).mode,'host');
 assert.equal(normalizeSyncConfig({mode:'local',enabled:true}).mode,'local');
 const {machineId}=require('./sync-client.cjs');
 assert.match(normalizeSyncConfig({}).installId,/^[0-9a-f]{4}$/);
 assert.equal(normalizeSyncConfig({installId:'a3f9'}).installId,'a3f9');
 assert.equal(normalizeSyncConfig({machine:'old-name'}).machine,undefined);
 assert.equal(machineId('113.161.5.20','a3f9'),'113.161.5.20-a3f9');
 assert.notEqual(machineId('1.2.3.4',normalizeSyncConfig({}).installId),machineId('1.2.3.4','ffff'));
});
test('reload pauses on disconnect and cannot fire after disable or close',()=>{
 const a=reloadHarness(),b=reloadHarness();a.r.setEnabled(true);b.r.setEnabled(true);
 a.setAvailable(false);assert.equal(a.timers.size,0);assert.equal(b.timers.size,1);
 a.setAvailable(true);a.r.setEnabled(false);assert.equal(a.timers.size,0);
 b.r.dispose();assert.equal(b.timers.size,0);b.r.setEnabled(true);assert.equal(b.timers.size,0);
});
