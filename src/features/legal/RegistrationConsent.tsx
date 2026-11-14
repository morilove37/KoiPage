import {useId} from 'react';
import {LegalDocuments} from './LegalDocuments';
import {isPolicyService} from './consent';
import type {RegistrationConsentValue} from './consent';

export function RegistrationConsent({value, onChange, serverUrl, disabled}: {
  value: RegistrationConsentValue;
  onChange: (value: RegistrationConsentValue) => void;
  serverUrl: string;
  disabled: boolean;
}) {
  const id = useId(), supported = isPolicyService(serverUrl);
  return <fieldset disabled={disabled || !supported} className="space-y-4 rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed">
    <legend className="px-1 text-sm font-medium">使用好友服务前请阅读并选择</legend>
    {!supported ? <p role="alert" className="text-destructive">当前连接不是本政策告知的内测服务，请恢复默认连接或联系服务维护者取得对应文档后再注册。</p> : null}
    <div className="space-y-2">
      <div className="flex items-start gap-2"><input id={`${id}-terms`} type="checkbox" required checked={value.termsAccepted && value.privacyAccepted} onChange={event => onChange({...value, termsAccepted: event.target.checked, privacyAccepted: event.target.checked})} className="mt-0.5 accent-primary"/><label htmlFor={`${id}-terms`}>我已阅读并同意《好友内测服务协议》和《隐私政策》。</label></div>
      <div className="pl-5"><LegalDocuments ids={['terms', 'privacy']}/></div>
    </div>
    <div className="space-y-2">
      <div className="flex items-start gap-2"><input id={`${id}-cross-border`} type="checkbox" required checked={value.crossBorderAccepted} onChange={event => onChange({...value, crossBorderAccepted: event.target.checked})} className="mt-0.5 accent-primary"/><label htmlFor={`${id}-cross-border`}>我已阅读《个人信息出境告知与单独同意》，单独同意按其中说明向境外接收方提供好友服务所需的个人信息。</label></div>
      <div className="pl-5"><LegalDocuments ids={['crossBorder', 'thirdParties']}/></div>
    </div>
  </fieldset>;
}
