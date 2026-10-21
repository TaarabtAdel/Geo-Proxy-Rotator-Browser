class BrowserTabs {
  constructor({createView,attach,remove,configure,destroy=()=>{},onChange=()=>{},cities=['New York']}){
    Object.assign(this,{createView,attach,remove,configure,destroy,onChange,cities});
    this.items=[];this.activeId=null;this.nextId=1;this.queue=Promise.resolve();this.disposed=false;
  }
  get active(){return this.items.find(t=>t.id===this.activeId);}
  serialize(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
  snapshot(){return {activeId:this.activeId,items:this.items.map(t=>({id:t.id,title:t.title,url:t.url,loading:t.loading,city:t.spoofLocation?t.city:null,connection:t.net?.state,busy:!!t.net?.task,message:t.message||'',autoReload:t.autoReload?.snapshot()}))};}
  changed(){if(!this.disposed)this.onChange(this.snapshot());}
  async _create(url=''){
    if(this.disposed)throw Error('Cửa sổ đã đóng.');
    if(this.items.length>=30)throw Error('Tối đa 30 tab. Hãy đóng bớt tab trước.');
    const id=this.nextId++;
    const tab={id,title:'Tab '+id,url,city:null,loading:false,closing:false,spoofLocation:null};tab.view=this.createView(tab);
    try{await this.configure(tab);if(this.disposed)throw Error('Cửa sổ đã đóng.');}
    catch(e){tab.closing=true;await this.destroy(tab);tab.view.webContents.close();throw e;}
    this.items.push(tab);this.attach(tab.view);this.activeId=tab.id;this.changed();return tab;
  }
  create(url=''){return this.serialize(()=>this._create(url));}
  activate(id){if(!this.items.some(t=>t.id===id))throw Error('Tab không còn tồn tại.');this.activeId=id;this.changed();}
  cycle(delta){const index=this.items.findIndex(t=>t.id===this.activeId);if(this.items.length)this.activate(this.items[(index+delta+this.items.length)%this.items.length].id);}
  close(id){return this.serialize(async()=>{
    const index=this.items.findIndex(t=>t.id===id);if(index<0)return;
    const [tab]=this.items.splice(index,1);tab.closing=true;this.remove(tab.view);await this.destroy(tab);tab.view.webContents.close();
    if(!this.items.length){this.activeId=null;await this._create();}
    else{if(this.activeId===id)this.activeId=this.items[Math.min(index,this.items.length-1)].id;this.changed();}
  });}
  async changeCity(id,city){
    if(!this.cities.includes(city))throw Error('Thành phố không hợp lệ.');
    const tab=this.items.find(t=>t.id===id);if(!tab||tab.closing)throw Error('Tab không còn tồn tại.');
    const old=tab.city;try{await this.configure(tab,city);}catch(e){if(old&&this.cities.includes(old))await this.configure(tab,old).catch(()=>{});throw e;}
    if(tab.closing)throw Error('Tab đã đóng.');tab.city=city;tab.spoofLocation={name:city};this.changed();
  }
  dispose(){this.disposed=true;for(const tab of this.items){tab.closing=true;Promise.resolve(this.destroy(tab)).catch(()=>{});tab.view.webContents.close();}this.items=[];}
}
module.exports={BrowserTabs};
