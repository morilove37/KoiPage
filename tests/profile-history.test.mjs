import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const compiled=await build({absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',entryPoints:['src/features/friends/ProfilePlayHistory.tsx']});
const mod={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(require,mod,mod.exports);
const {ProfilePlayHistory}=mod.exports;
function nodes(tree){
  if(Array.isArray(tree))return tree.flatMap(nodes);
  if(!React.isValidElement(tree))return [];
  return [tree,...nodes(tree.props.children)];
}
const text=tree=>Array.isArray(tree)?tree.map(text).join(''):React.isValidElement(tree)?text(tree.props.children):tree==null||typeof tree==='boolean'?'':String(tree);
function mount(initial){
  const slots=[];let cursor=0,tree,props=initial;
  const dispatcher={
    useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useRef(initial){return slots[cursor++]??={current:initial};},
    useMemo(compute){cursor++;return compute();},
  };
  const render=()=>{
    cursor=0;
    const internal=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher,previous=internal.current;
    internal.current=dispatcher;
    try{tree=ProfilePlayHistory(props);}finally{internal.current=previous;}
  };
  render();
  return {get tree(){return tree;},update(next){props={...props,...next};render();},click(label){
    const button=nodes(tree).find(node=>node.props['aria-label']===label||text(node)===label&&typeof node.props.onClick==='function');
    assert.ok(button,`control exists: ${label}`);button.props.onClick();render();
  }};
}
const session=(key,title)=>({key,title,vndbId:null,bangumiId:null,startedAt:'2026-11-11T10:00:00Z',endedAt:'2026-11-11T10:01:00Z',durationSeconds:60});
const history={enabled:true,sessions:[session('a','一'),session('b','一'),session('c','二'),session('d','三'),session('e','四')]};
const rows=tree=>nodes(tree).filter(node=>node.props['data-history-group']);
const entries=tree=>nodes(tree).filter(node=>node.props['data-session-id']);

test('profile history uses three preview groups and bounded, lazy independent timelines',()=>{
  const view=mount({history,error:'',games:[],isSelf:true,onRetry(){}});
  assert.equal(rows(view.tree).length,3);assert.equal(entries(view.tree).length,0);
  assert.match(text(rows(view.tree)[0]),/连续游玩 2 次 · 合计 2 分钟/);
  view.click('展开全部游玩记录');
  const region=nodes(view.tree).find(node=>node.props.role==='region');
  assert.match(region.props.className,/max-h-96/);assert.equal(rows(region).length,4);
  view.click('展开一的游玩明细');
  assert.deepEqual(entries(view.tree).map(node=>node.props['data-session-id']),['a','b']);
  assert.match(nodes(view.tree).find(node=>node.type==='ol'&&node.props['aria-label']==='一的游玩明细').props.className,/max-h-48/);
  view.click('展开二的游玩明细');view.click('收起一的游玩明细');
  assert.deepEqual(entries(view.tree).map(node=>node.props['data-session-id']),['c']);
  view.update({history:{...history,sessions:[...history.sessions]}});
  assert.equal(rows(view.tree).length,4);assert.equal(entries(view.tree).length,1);
  view.click('收起记录');assert.equal(rows(view.tree).length,3);
});

test('profile history exposes retry and privacy/empty states without stale timeline entries',()=>{
  let retries=0;
  const view=mount({history,error:'offline',games:[],isSelf:true,onRetry(){retries++;}});
  assert.equal(rows(view.tree).length,0);view.click('重试游玩记录');assert.equal(retries,1);
  view.update({error:'',history:{enabled:false,sessions:history.sessions}});
  assert.match(text(view.tree),/你尚未开启游玩记录展示/);assert.equal(rows(view.tree).length,0);
  view.update({isSelf:false});assert.match(text(view.tree),/对方未开启游玩记录展示/);
  view.update({history:{enabled:true,sessions:[]}});assert.match(text(view.tree),/最近 7 天没有游玩记录/);
});
