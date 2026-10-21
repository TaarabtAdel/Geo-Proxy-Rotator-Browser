const INTERVALS=Object.freeze([60,120,180,240,300,360,420,480]);
class RandomReload{
  constructor({canReload,reload,onChange=()=>{},random=Math.random,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
    Object.assign(this,{canReload,reload,onChange,random,now,setTimer,clearTimer});
    this.enabled=false;this.disposed=false;this.timer=null;this.nextAt=null;this.delay=null;this.error='';
  }
  snapshot(){return {enabled:this.enabled,nextAt:this.nextAt,delay:this.delay,paused:this.enabled&&this.nextAt===null,error:this.error};}
  clear(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.nextAt=null;this.delay=null;}
  setEnabled(enabled){if(this.disposed)return;this.enabled=!!enabled;this.error='';this.reconcile();this.onChange(this.snapshot());}
  reconcile(){
    if(this.disposed||!this.enabled||!this.canReload()){this.clear();return;}
    if(this.timer!==null)return;
    this.delay=INTERVALS[Math.min(INTERVALS.length-1,Math.floor(this.random()*INTERVALS.length))];
    this.nextAt=this.now()+this.delay*1000;
    this.timer=this.setTimer(()=>{
      this.timer=null;this.nextAt=null;this.delay=null;
      if(!this.enabled||this.disposed)return;
      if(this.canReload()){
        try{this.reload();}catch(e){this.enabled=false;this.error=e.message;}
      }
      this.reconcile();this.onChange(this.snapshot());
    },this.delay*1000);
  }
  dispose(){this.disposed=true;this.enabled=false;this.clear();}
}
module.exports={RandomReload,INTERVALS};
