import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';
export default defineConfig({base:'./',plugins:[react(),tailwindcss(),viteSingleFile()],resolve:{alias:[{find:/^@xrplf\/mpt-crypto(\/.*)?$/,replacement:path.resolve(__dirname,'stub-mpt.js')},{find:'@',replacement:path.resolve(__dirname,'.')}]},build:{outDir:'dist-single',assetsInlineLimit:100000000,cssCodeSplit:false}});
