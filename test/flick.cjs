const { chromium } = require('playwright'); const fs=require('fs'); const {webcrypto:C}=require('crypto');
const seed=JSON.parse(fs.readFileSync('/home/claude/starsky/test/.run/seed-main.json')); const b64=u=>Buffer.from(u).toString('base64');
(async()=>{const salt=C.getRandomValues(new Uint8Array(16)),iv=C.getRandomValues(new Uint8Array(12));
const km=await C.subtle.importKey('raw',Buffer.from('testpass123'),'PBKDF2',false,['deriveKey']);
const key=await C.subtle.deriveKey({name:'PBKDF2',salt,iterations:250000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt']);
const data={accounts:[{id:'a1',label:'Trader',seed:seed.user.master_seed,address:seed.user.account_id,type:'luma'}],active:'a1'};
const ct=new Uint8Array(await C.subtle.encrypt({name:'AES-GCM',iv},key,Buffer.from(JSON.stringify(data))));
const vault=JSON.stringify({v:1,iter:250000,salt:b64(salt),iv:b64(iv),ct:b64(ct)});
const br=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
const pg=await br.newPage({viewport:{width:1440,height:900}});
await pg.addInitScript(([v])=>{if(!localStorage.getItem('starsky.vault')){localStorage.setItem('starsky.vault',v);localStorage.setItem('starsky.cfg',JSON.stringify({net:'main',urls:{main:'ws://127.0.0.1:6006'},usd:{},book:[],lockMin:15}));}},[vault]);
await pg.goto('http://127.0.0.1:4173/');await pg.fill('#pw','testpass123');await pg.press('#pw','Enter');await pg.waitForTimeout(3000);
for(const t of ['home','markets','dex','network']){
 await pg.evaluate(t=>window.goTab(t),t);await pg.waitForTimeout(9000);
 const sizes=[];for(let k=0;k<30;k++){sizes.push(await pg.evaluate(()=>document.querySelector('main').innerText.length));await pg.waitForTimeout(500);}
 const dips=sizes.filter((x,i)=>i&&x<sizes[i-1]*0.8).length;
 console.log(t,'min',Math.min(...sizes),'max',Math.max(...sizes),'dips',dips);
 await pg.screenshot({path:'/tmp/pg_'+t+'.png',fullPage:true});}
await br.close()})();
