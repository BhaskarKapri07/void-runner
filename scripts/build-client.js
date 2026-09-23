import { readFile, writeFile, mkdir } from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const script=s=>'<script>\n'+s.replace(/<\/script/gi,'<\\/script')+'\n</script>';
// ES modules in dependency order, each exposed as a global in the single-file build.
const modules=[['shared/netcode.js','VoidShared'],['shared/engine.js','VoidEngine'],['shared/protocol.js','VoidProtocol'],['peer.js','VoidPeer'],['online.js',null]];
const globals=Object.fromEntries(modules);
const resolve=(file,from)=>(file.slice(0,file.lastIndexOf('/')+1)+from).replace(/(^|\/)\.\//g,'$1');
async function bundle([file,name]){
 const source=await read(file);
 const imports=[...source.matchAll(/^import \{([^}]*)\} from '([^']+)';\s*$/gm)].map(([,names,from])=>{const global=globals[resolve(file,from)];if(!global)throw Error(file+' imports unknown module '+from);return 'const {'+names.trim()+'}=window.'+global+';'});
 const exported=[...source.matchAll(/^export (?:const|let|function|class) (\w+)/gm)].map(m=>m[1]);
 const body=source.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'');
 return script(name?'window.'+name+'=(()=>{'+imports.join('')+'\n'+body+'\nreturn {'+exported.join(',')+'};})();':'{'+imports.join('')+'\n'+body+'\n}');
}
let html=await read('index.html');
html=html.replace('<link rel="stylesheet" href="style.css">','<style>\n'+await read('style.css')+'\n</style>');
html=html.replace('<script src="config.js"></script>',script(await read('config.js')+"\nwindow.VOIDRUNNER_SERVER ||= 'https://void-runner.onrender.com';\n"));
html=html.replace('<script src="game.js"></script>',script(await read('game.js')));
html=html.replace('<script type="module" src="online.js"></script>',(await Promise.all(modules.map(bundle))).join('\n'));
html=html.replace(/<a[^>]+id="downloadClient"[^>]*>.*?<\/a>/,'<span class="downloadlink">PORTABLE CLIENT · SOLO WORKS OFFLINE</span>');
html=html.replace('href="./"','href="#"');
await mkdir(new URL('../downloads/',import.meta.url),{recursive:true});
await writeFile(new URL('../downloads/voidrunner.html',import.meta.url),html);
console.log('Portable client: '+Buffer.byteLength(html)+' bytes');
