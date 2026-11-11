import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {AVATAR_CHOICES,avatarPreset} from './avatar-catalog';
import {FriendsAvatar} from './FriendsAvatar';

export function AvatarPickerDialog({open,current,saving,onClose,onConfirm}:{open:boolean;current:number;saving?:boolean;onClose:()=>void;onConfirm:(avatar:number)=>void}){
  const [selected,setSelected]=useState(current);
  useEffect(()=>{if(open)setSelected(current);},[open,current]);
  const preset=avatarPreset(selected);
  return <Dialog open={open} onClose={onClose} title="更换头像" description="选择一张角色头像，保存后好友会立即看到新头像。" footer={<>
    <Button type="button" variant="outline" onClick={onClose} disabled={saving}>取消</Button>
    <Button type="button" loading={saving} disabled={saving} onClick={()=>onConfirm(selected)}>保存头像</Button>
  </>}>
    <fieldset disabled={saving} className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <FriendsAvatar avatar={selected} className="size-14"/>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{preset.name}</p>
          <p className="truncate text-xs text-muted-foreground">{preset.work}</p>
        </div>
      </div>
      <div role="radiogroup" aria-label="选择头像" className="grid grid-cols-6 gap-2">
        {AVATAR_CHOICES.map(item=>{
          const active=selected===item.id;
          return <button key={item.id} type="button" role="radio" aria-checked={active} aria-label={`${item.name} · ${item.work}`} title={`${item.name} · ${item.work}`} onClick={()=>setSelected(item.id)} className={`relative rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-ring/40 ${active?'ring-2 ring-primary ring-offset-2 ring-offset-card':''}`}>
            <FriendsAvatar avatar={item.id} decorative className={`size-full rounded-lg ${active?'':'opacity-80 hover:opacity-100'}`}/>
            {active?<span aria-hidden="true" className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">✓</span>:null}
          </button>;
        })}
      </div>
    </fieldset>
  </Dialog>;
}
