import policy from '../../../supabase/functions/_shared/legal-policy.json';

export const POLICY = policy;
export interface RegistrationConsentValue {
  version: string;
  termsAccepted: boolean;
  privacyAccepted: boolean;
  crossBorderAccepted: boolean;
}

export function emptyRegistrationConsent(): RegistrationConsentValue {
  return {version: POLICY.version, termsAccepted: false, privacyAccepted: false, crossBorderAccepted: false};
}

export function isRegistrationConsentValid(value: unknown): value is RegistrationConsentValue {
  if (!value || typeof value !== 'object') return false;
  const consent = value as Partial<RegistrationConsentValue>;
  return consent.version === POLICY.version && consent.termsAccepted === true
    && consent.privacyAccepted === true && consent.crossBorderAccepted === true;
}

export const isPolicyService = (serverUrl: string) => serverUrl.replace(/\/$/, '') === POLICY.serverUrl;
