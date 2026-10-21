const {checkUS,checkIP}=require('./core.cjs');
function verifyIP(net,ses,signal,creds={},timeout=10000,parse=checkUS){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    let settled=false,authTries=0;
    const req=net.request({url:'https://ipwho.is/',session:ses,method:'GET',useSessionCookies:false,redirect:'error'});
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){reject(error);req.abort();}else resolve(result);};
    const abort=()=>finish(signal.reason||Error('Đã dừng kiểm tra.'));
    const timer=setTimeout(()=>finish(Error('Hết thời gian kiểm tra IP.')),timeout);
    signal?.addEventListener('abort',abort,{once:true});
    req.setHeader('Cache-Control','no-cache');
    req.on('login',(info,callback)=>{
      if(authTries++<1&&info.isProxy&&info.host===creds.host&&+info.port===+creds.port)callback(creds.user||'',creds.password||'');else callback();
    });
    req.on('error',error=>finish(error));
    req.on('response',res=>{
      if(res.statusCode!==200){finish(Error('Dịch vụ IP trả HTTP '+res.statusCode));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>65536){finish(Error('Phản hồi IP quá lớn.'));return;}chunks.push(chunk);});
      res.on('error',error=>finish(error));
      res.on('end',()=>{try{finish(null,parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch(e){finish(e);}});
    });
    req.end();
  });
}
function verifyIPAny(net,ses,signal,creds={},timeout=10000){return verifyIP(net,ses,signal,creds,timeout,checkIP);}
module.exports={verifyIP,verifyIPAny};
