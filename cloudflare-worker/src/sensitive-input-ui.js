export const SENSITIVE_INPUT_UI = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}*{box-sizing:border-box}body{margin:0;padding:12px;color:#18202b;background:transparent}.card{border:1px solid #dce2ea;border-radius:16px;padding:20px;background:#fff}.head{display:flex;gap:12px;align-items:flex-start}.lock{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:#eaf3ff;font-size:20px}h1{font-size:19px;margin:0 0 5px}p{margin:0;color:#5f6977;line-height:1.45}.device{margin-top:12px;padding:9px 11px;border-radius:9px;background:#f4f7fb;font-size:13px}.field{margin-top:16px}label{display:block;font-size:14px;font-weight:600;margin-bottom:7px}input,select{width:100%;border:1px solid #bbc5d2;border-radius:10px;padding:11px 12px;font:inherit;background:#fff;color:inherit}.check{display:flex;gap:9px;align-items:flex-start;font-weight:500}.check input{width:auto;margin-top:3px}.help{font-size:12px;margin-top:5px}.actions{display:flex;gap:9px;margin-top:20px}button{border:0;border-radius:10px;padding:11px 15px;font:600 14px inherit;cursor:pointer}.primary{flex:1;background:#1677ff;color:#fff}.secondary{background:#edf1f5;color:#364152}.status{font-size:13px;margin-top:12px}.success{color:#087443}.error{color:#b42318}.privacy{font-size:11px;margin-top:13px;color:#788391}.hidden{display:none}@media(prefers-color-scheme:dark){body{color:#edf2f7}.card{background:#1f2937;border-color:#3b4655}.lock{background:#19385f}.device{background:#111827}.secondary{background:#374151;color:#edf2f7}input,select{background:#111827;border-color:#536071}}
  </style>
</head>
<body>
  <main id="root" class="card"><p>正在准备安全输入…</p></main>
  <script>
    (function(){
      var root=document.getElementById('root'),latest=null,pending=new Map(),nextId=1;
      function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(ch){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[ch]})}
      function request(method,params){var id=nextId++;window.parent.postMessage({jsonrpc:'2.0',id:id,method:method,params:params},'*');return new Promise(function(resolve,reject){pending.set(id,{resolve:resolve,reject:reject})})}
      function callTool(name,args){if(window.openai&&window.openai.callTool)return window.openai.callTool(name,args);return request('tools/call',{name:name,arguments:args})}
      function followUp(prompt){if(window.openai&&window.openai.sendFollowUpMessage)return window.openai.sendFollowUpMessage({prompt:prompt,scrollToBottom:true});return request('ui/message',{role:'user',content:[{type:'text',text:prompt}]})}
      function b64url(bytes){var binary='',chunk=0x8000;for(var i=0;i<bytes.length;i+=chunk){binary+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+chunk,bytes.length)))}return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
      async function encrypt(values,data){
        var deviceKey=await crypto.subtle.importKey('jwk',data.devicePublicKey,{name:'ECDH',namedCurve:'P-256'},false,[]);
        var ephemeral=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
        var shared=await crypto.subtle.deriveBits({name:'ECDH',public:deviceKey},ephemeral.privateKey,256);
        var aes=await crypto.subtle.importKey('raw',shared,{name:'AES-GCM',length:256},false,['encrypt']);
        var iv=crypto.getRandomValues(new Uint8Array(12)),encoder=new TextEncoder();
        var plaintext=encoder.encode(JSON.stringify({challengeId:data.challengeId,values:values,submittedAt:Date.now()}));
        var ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv,additionalData:encoder.encode(data.challengeId)},aes,plaintext);
        plaintext.fill(0);
        return {challengeId:data.challengeId,ephemeralPublicKey:await crypto.subtle.exportKey('jwk',ephemeral.publicKey),iv:b64url(iv),ciphertext:b64url(new Uint8Array(ciphertext))};
      }
      function fieldHtml(field){
        var id='sensitive-'+field.id,required=field.required===false?'':' required';
        if(field.type==='select')return '<div class="field"><label for="'+id+'">'+esc(field.label)+'</label><select id="'+id+'" name="'+esc(field.id)+'"'+required+'><option value="">请选择…</option>'+field.options.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>'}).join('')+'</select>'+(field.help?'<p class="help">'+esc(field.help)+'</p>':'')+'</div>';
        if(field.type==='confirm')return '<div class="field"><label class="check"><input id="'+id+'" name="'+esc(field.id)+'" type="checkbox"'+required+'><span>'+esc(field.label)+(field.help?'<p class="help">'+esc(field.help)+'</p>':'')+'</span></label></div>';
        var masked=['password','secret','payment'].includes(field.type),inputType=masked?'password':(field.type==='email'?'email':(field.type==='phone'?'tel':'text'));
        var autocomplete=field.type==='otp'?'one-time-code':'off',inputmode=field.type==='otp'||field.type==='payment'?'numeric':'text';
        return '<div class="field"><label for="'+id+'">'+esc(field.label)+'</label><input id="'+id+'" name="'+esc(field.id)+'" type="'+inputType+'" inputmode="'+inputmode+'" autocomplete="'+autocomplete+'" placeholder="'+esc(field.placeholder||'')+'"'+required+'>'+(field.help?'<p class="help">'+esc(field.help)+'</p>':'')+'</div>';
      }
      function setStatus(text,kind){var el=document.getElementById('status');if(el){el.className='status '+(kind||'');el.textContent=text}}
      function render(data){
        if(!data||data.status!=='awaiting_user'||!Array.isArray(data.fields))return;
        if(latest&&latest.challengeId===data.challengeId)return;latest=data;
        root.innerHTML='<div class="head"><div class="lock">🔐</div><div><h1>'+esc(data.title)+'</h1><p>'+esc(data.description)+'</p></div></div><div class="device">目标设备：'+esc(data.deviceName||data.deviceId)+'</div><form id="sensitive-form">'+data.fields.map(fieldHtml).join('')+'<div class="actions"><button class="secondary" type="button" id="cancel">取消</button><button class="primary" type="submit">加密并发送</button></div><p id="status" class="status"></p></form><p class="privacy">输入内容在此卡片中加密；ChatGPT、对话记录和中央服务只接收密文，不会收到明文。</p>';
        var form=document.getElementById('sensitive-form');
        form.addEventListener('submit',async function(event){event.preventDefault();var submit=form.querySelector('.primary'),cancel=form.querySelector('.secondary');submit.disabled=true;cancel.disabled=true;setStatus('正在加密并发送到目标设备…','');
          try{var values={};latest.fields.forEach(function(field){var el=document.getElementById('sensitive-'+field.id);values[field.id]=field.type==='confirm'?el.checked:el.value});var envelope=await encrypt(values,latest);Object.keys(values).forEach(function(key){values[key]=''});values=null;var result=await callTool('submit_sensitive_input',envelope);form.reset();form.querySelectorAll('input,select,button').forEach(function(el){el.disabled=true});setStatus('已安全填写，ChatGPT 将继续任务。','success');await followUp('敏感信息已由我在安全输入卡片中完成并发送到目标设备。请读取新的设备状态并继续刚才暂停的任务；不要要求我在聊天中重复该信息。')}
          catch(error){submit.disabled=false;cancel.disabled=false;setStatus('发送失败：'+(error&&error.message?error.message:'请重试。'),'error')}
        });
        document.getElementById('cancel').addEventListener('click',async function(){try{await callTool('cancel_sensitive_input',{challengeId:latest.challengeId})}catch{}root.innerHTML='<p>已取消，没有向设备发送任何信息。</p>';await followUp('我取消了本次敏感信息输入。请停止相关步骤或提供不需要该信息的替代方案。')});
      }
      window.addEventListener('message',function(event){if(event.source!==window.parent)return;var message=event.data;if(!message||message.jsonrpc!=='2.0')return;if(message.id!==undefined&&pending.has(message.id)){var item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);return}if(message.method==='ui/notifications/tool-result')render(message.params&&message.params.structuredContent)});
      if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);
    })();
  </script>
</body>
</html>`;
