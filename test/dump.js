const fs=require('fs');const S=JSON.parse(fs.readFileSync(__dirname+'/.run/seed-main.json'));const amt=process.argv[2]||'2500';const sell=process.argv[3]!=='buy';
const rpc=async(m,p={})=>{const r=await fetch(`http://127.0.0.1:${S.rpc}`,{method:'POST',body:JSON.stringify({method:m,params:[p]})});return (await r.json()).result;};
(async()=>{const t=S.trader,I=(v)=>({currency:S.toks.USD,issuer:S.issuer.account_id,value:String(v)});
const tx=sell?{TransactionType:'OfferCreate',Account:t.account_id,Flags:0x00020000,TakerGets:I(amt),TakerPays:'1'}:{TransactionType:'OfferCreate',Account:t.account_id,Flags:0x00020000,TakerGets:String(amt*1e6),TakerPays:I(1)};
const nid=(await rpc('server_info')).info.network_id;if(nid>1024)tx.NetworkID=nid;const r=await rpc('submit',{secret:t.master_seed,tx_json:tx});console.log(r.engine_result,r.engine_result_message||'');})();
