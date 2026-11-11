import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

export const rawMarkdown={name:'raw-markdown',setup(builder){
  builder.onResolve({filter:/\.md\?raw$/},args=>({path:resolve(dirname(args.importer),args.path.slice(0,-4)),namespace:'raw-markdown'}));
  builder.onLoad({filter:/.*/,namespace:'raw-markdown'},async({path})=>({contents:await readFile(path,'utf8'),loader:'text'}));
}};
