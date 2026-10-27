#!/usr/bin/env python3
# Builds the single deployable file. Edit CONFIG below (or the block at the top of the produced file) to point at your public LUMA nodes.
import gzip,base64,subprocess,sys
CONFIG='''{
  default: 'main',
  main: { url: 'wss://ws.lumanetwork.org', panel: 'https://api.lumanetwork.org' },
  test: { url: 'wss://ws-test.lumanetwork.org', panel: 'https://api-test.lumanetwork.org' },
}'''
subprocess.run(['npx','vite','build','-c','vite.single.config.ts'],check=True)
h=open('dist-single/index.html','rb').read()
b=base64.b64encode(gzip.compress(h,9)).decode()
out='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starsky</title><style>body{margin:0;background:#07070c;color:#8a8fa8;font:14px system-ui;display:grid;place-items:center;height:100vh}</style>
<script>/* STARSKY SITE CONFIG - edit to point at your public nodes */ window.STARSKY_CONFIG = '''+CONFIG+''';</script></head><body>Loading Starsky…<script>
(async()=>{try{const b=Uint8Array.from(atob("'''+b+'''"),c=>c.charCodeAt(0));
const t=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
document.open();document.write(t);document.close()}catch(e){document.body.textContent="Starsky needs a modern browser. "+e}})();
</script></body></html>'''
open(sys.argv[1] if len(sys.argv)>1 else 'starsky-live.html','w').write(out);print(len(out))
