import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Field,Textarea} from '@/components/ui/input';
import {cn} from '@/lib/utils';
import type {ReportReason} from './api';

export const REPORT_REASONS:readonly {value:ReportReason;label:string;hint:string}[]=[
  {value:'cover',label:'封面违规',hint:'封面包含色情、暴力或其他不适合公开展示的内容'},
  {value:'content',label:'内容违规',hint:'公开游戏库中的作品信息违反社区规范'},
  {value:'other',label:'其他问题',hint:'其他需要管理员介入处理的情况'},
];

/** Report a friend's public profile, or one of the covers in their shared library. */
export function ReportDialog({open,target,busy,defaultReason='cover',onClose,onSubmit}:{open:boolean;target:{username:string;nickname:string}|null;busy?:boolean;defaultReason?:ReportReason;onClose:()=>void;onSubmit:(input:{reason:ReportReason;detail:string})=>void}){
  const [reason,setReason]=useState<ReportReason>(defaultReason);
  const [detail,setDetail]=useState('');
  useEffect(()=>{if(open){setReason(defaultReason);setDetail('');}},[open,defaultReason]);
  const submit=()=>{if(busy)return;onSubmit({reason,detail:detail.trim()});};
  return <Dialog open={open} onClose={onClose} title="举报" description={target?`举报 @${target.username}（${target.nickname}）的公开内容，管理员会尽快核实处理。`:'管理员会尽快核实处理。'} footer={<>
    <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
    <Button type="button" variant="destructive" loading={busy} disabled={busy} onClick={submit}>提交举报</Button>
  </>}>
    <fieldset disabled={busy} className="space-y-4">
      <div role="radiogroup" aria-label="举报原因" className="space-y-2">
        {REPORT_REASONS.map(item=>{
          const active=reason===item.value;
          return <button key={item.value} type="button" role="radio" aria-checked={active} onClick={()=>setReason(item.value)} className={cn('w-full rounded-md border p-3 text-left text-sm transition','outline-none focus-visible:ring-2 focus-visible:ring-ring/40',active?'border-primary bg-primary/5':'border-border hover:border-primary/40')}>
            <span className="font-medium">{item.label}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{item.hint}</span>
          </button>;
        })}
      </div>
      <Field label="补充说明（可选）" hint="最多 500 字，便于管理员定位问题。">
        <Textarea value={detail} maxLength={500} rows={4} onChange={event=>setDetail(event.target.value)} placeholder="请描述需要核实的情况" aria-label="举报补充说明"/>
      </Field>
    </fieldset>
  </Dialog>;
}
