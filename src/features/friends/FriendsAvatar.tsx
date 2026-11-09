import {useState} from 'react';
import {avatarPreset} from './avatar-catalog';

export function FriendsAvatar({avatar,label,decorative=false,className='size-11'}:{avatar:number;label?:string;decorative?:boolean;className?:string}){
  const preset=avatarPreset(avatar);
  const [failedSource,setFailedSource]=useState<string|null>(null);
  return <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-sm font-medium text-primary ${className}`} role={decorative?undefined:'img'} aria-label={decorative?undefined:label??`${preset.name} · ${preset.work}`} aria-hidden={decorative||undefined}>
    {failedSource===preset.src?<span aria-hidden="true">友</span>:<img src={preset.src} alt="" width={64} height={64} loading="lazy" decoding="async" className="size-full object-cover" onError={()=>setFailedSource(preset.src)}/>}
  </span>;
}
