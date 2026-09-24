(()=>{
  'use strict';
  const embedded=window.parent!==window;
  if(embedded) document.body.classList.add('kalo-embedded');

  const notifyParent=(type,payload={})=>{
    if(!embedded) return;
    try{window.parent.postMessage({source:'kalo',type,...payload},'*')}catch(_){/* no-op */}
  };

  window.addEventListener('keydown',(event)=>{
    if(event.key==='Escape'){
      notifyParent('close');
      return;
    }
    if(event.altKey && event.key.toLowerCase()==='k'){
      event.preventDefault();
      notifyParent('toggle');
    }
  },true);

  window.addEventListener('load',()=>notifyParent('ready'));
  document.documentElement.lang='vi';
  document.title='Kalo';
})();
