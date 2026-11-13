import {useId} from 'react';
import {LegalDocuments} from './LegalDocuments';
import {isPolicyService, POLICY} from './consent';
import type {RegistrationConsentValue} from './consent';

export function RegistrationConsent({value, onChange, serverUrl, disabled}: {
  value: RegistrationConsentValue;
  onChange: (value: RegistrationConsentValue) => void;
  serverUrl: string;
  disabled: boolean;
}) {
  const id = useId(), supported = isPolicyService(serverUrl);
  return <fieldset disabled={disabled || !supported} className="space-y-4 rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed" aria-describedby={`${id}-notice`}>
    <legend className="px-1 text-sm font-medium">使用好友服务前请阅读并选择</legend>
    <p id={`${id}-notice`} className="text-muted-foreground">好友账号通过 Cloudflare 网络入口连接 Supabase 境外服务，数据库位于新加坡。Cloudflare 会处理网络 IP 和转发的账号、同步请求，网络处理可能涉及其他国家或地区。不同意可不注册，继续使用本地游戏管理；下面的选择不会开启作品或游戏库分享。</p>
    {!supported ? <p role="alert" className="text-destructive">当前连接不是本政策告知的内测服务，请恢复默认连接或联系服务维护者取得对应文档后再注册。</p> : null}
    <div className="space-y-2">
      <div className="flex items-start gap-2"><input id={`${id}-terms`} type="checkbox" required checked={value.termsAccepted && value.privacyAccepted} onChange={event => onChange({...value, termsAccepted: event.target.checked, privacyAccepted: event.target.checked})} className="mt-0.5 accent-primary"/><label htmlFor={`${id}-terms`}>我已阅读并同意《好友内测服务协议》和《隐私政策》。</label></div>
      <div className="pl-5"><LegalDocuments ids={['terms', 'privacy']}/></div>
    </div>
    <div className="space-y-2">
      <div className="flex items-start gap-2"><input id={`${id}-cross-border`} type="checkbox" required checked={value.crossBorderAccepted} onChange={event => onChange({...value, crossBorderAccepted: event.target.checked})} className="mt-0.5 accent-primary"/><label htmlFor={`${id}-cross-border`}>我已阅读《个人信息出境告知与单独同意》，单独同意按其中说明向境外接收方提供好友服务所需的个人信息。</label></div>
      <div className="pl-5"><LegalDocuments ids={['crossBorder', 'thirdParties']}/></div>
    </div>
    <p className="text-muted-foreground">提供者：{POLICY.operator} · 版本 {POLICY.version}<br/>隐私、删除及注销申请：<span className="select-all">{POLICY.contactEmail}</span>。不满十四周岁请勿自行注册，请由监护人联系开发者。</p>
  </fieldset>;
}
