// Builds downloads/voidrunner.html: the whole client in one file that runs from file://.
// Each ES module becomes a script that publishes its exports on a global. The rewrite is regex
// based, so it supports exactly the forms this codebase uses (`import { a, b } from './x.js'` and
// `export const|let|function|class name`) and fails the build on anything else.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Dependencies first; online.js is the entry point and exports nothing.
const MODULES = [
  ['shared/netcode.js', 'VoidNetcode'], ['shared/engine.js', 'VoidEngine'], ['shared/protocol.js', 'VoidProtocol'], ['shared/match.js', 'VoidMatch'],
  ['shared/world.js', 'VoidWorld'], ['shared/client.js', 'VoidClient'], ['peer.js', 'VoidPeer'], ['online.js', null],
];

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const script = source => '<script>\n' + source.replace(/<\/script/gi, '<\\/script') + '\n</script>';
const resolve = (from, specifier) => (from.slice(0, from.lastIndexOf('/') + 1) + specifier).replace(/(^|\/)\.\//g, '$1');

function bundle(path, global, source, built) {
  const imports = [...source.matchAll(/^import \{([^}]*)\} from '([^']+)';\s*$/gm)].map(([, names, specifier]) => {
    const dependency = resolve(path, specifier), exposed = built.get(dependency);
    if (!exposed) throw Error(`${path} imports ${specifier}, which is not bundled before it`);
    return `const {${names.trim()}} = window.${exposed};`;
  });
  const exported = [...source.matchAll(/^export (?:const|let|function|class) (\w+)/gm)].map(m => m[1]);
  const body = source.replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');
  const leftover = body.match(/^\s*(import|export)\b.*$/m);
  if (leftover) throw Error(`${path}: unsupported module syntax: ${leftover[0].trim()}`);
  if (global) built.set(path, global);
  return script(global ? `window.${global} = (() => {${imports.join('')}\n${body}\nreturn {${exported.join(',')}};})();` : `{${imports.join('')}\n${body}\n}`);
}

const built = new Map(), scripts = [];
for (const [path, global] of MODULES) scripts.push(bundle(path, global, await read(path), built));

// Function replacements, so `$&` or `$'` in the inlined sources is never treated as a pattern.
let html = await read('index.html');
const style = await read('style.css'), config = await read('config.js'), game = await read('game.js');
html = html.replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + style + '\n</style>');
html = html.replace('<script src="config.js"></script>', () => script(config + "\nwindow.VOIDRUNNER_SERVER ||= 'https://void-runner.onrender.com';\n"));
html = html.replace('<script src="game.js"></script>', () => script(game));
html = html.replace('<script type="module" src="online.js"></script>', () => scripts.join('\n'));
html = html.replace(/<a[^>]+id="downloadClient"[^>]*>.*?<\/a>/, () => '<span class="downloadlink">PORTABLE CLIENT · SOLO WORKS OFFLINE</span>');
html = html.replace('href="./"', () => 'href="#"');
await mkdir(new URL('../downloads/', import.meta.url), { recursive: true });
await writeFile(new URL('../downloads/voidrunner.html', import.meta.url), html);
console.log('Portable client: ' + Buffer.byteLength(html) + ' bytes');
