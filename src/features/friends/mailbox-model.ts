import type {Mailbox,MailFilter} from './types';

export const MAIL_PAGE_SIZE=30;
export interface MailboxState {mailbox:Mailbox|null;loading:boolean;error:string;offset:number;filter:MailFilter}
export interface MailboxInput {action:'list'|'read'|'read_all';id:string|null;offset:number;filter:MailFilter}
export const emptyMailboxState=():MailboxState=>({mailbox:null,loading:false,error:'',offset:0,filter:'all'});

/** An unavailable inbox must never look empty. */
export function parseMailbox(value:unknown):Mailbox{
  const record=value as Partial<Mailbox>|null;
  const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  if(!record||!Array.isArray(record.items)||!count(record.unread)||!count(record.total)||typeof record.hasMore!=='boolean')throw Error('邮件服务返回了无效数据，请稍后刷新。');
  for(const item of record.items){
    if(!item||typeof item.id!=='string'||!item.id||!['announcement','library','report'].includes(item.kind)||typeof item.title!=='string'||typeof item.body!=='string'||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||(item.readAt!==null&&(typeof item.readAt!=='string'||!Number.isFinite(Date.parse(item.readAt)))))throw Error('邮件内容暂时无法读取，请稍后刷新。');
  }
  return record as Mailbox;
}

/** One in-flight operation prevents polling from undoing a read receipt. */
export function createMailboxController({load,onChange}:{load:(input:MailboxInput)=>Promise<Mailbox>;onChange:(state:MailboxState)=>void}){
  let state=emptyMailboxState(),alive=true;
  const publish=(patch:Partial<MailboxState>)=>{state={...state,...patch};if(alive)onChange(state);};
  async function run(action:MailboxInput['action'],id:string|null=null,offset=state.offset,filter=state.filter):Promise<boolean>{
    if(!alive||state.loading)return false;
    publish({loading:true,error:'',offset,filter,...(offset!==state.offset||filter!==state.filter?{mailbox:null}:{})});
    try{
      const mailbox=await load({action,id,offset,filter});
      if(!alive)return false;
      if(offset>0&&mailbox.items.length===0&&mailbox.total<=offset){
        publish({loading:false});return run('list',null,Math.max(0,Math.floor((mailbox.total-1)/MAIL_PAGE_SIZE)*MAIL_PAGE_SIZE),filter);
      }
      publish({mailbox,loading:false});return true;
    }catch(error){if(alive)publish({loading:false,error:error instanceof Error?error.message:String(error)});return false;}
  }
  return {refresh:()=>run('list'),navigate:(offset:number,filter:MailFilter)=>run('list',null,offset,filter),read:(id:string)=>run('read',id),readAll:()=>run('read_all'),destroy:()=>{alive=false;}};
}
