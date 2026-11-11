use crate::commands::error::{CmdError, CmdResult};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

static POLICY: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../supabase/functions/_shared/legal-policy.json"))
        .expect("bundled legal policy must be valid JSON")
});

#[derive(Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
#[derive(Default)]
pub struct RegistrationConsent {
    version: String,
    terms_accepted: bool,
    privacy_accepted: bool,
    cross_border_accepted: bool,
}

pub fn validate(value: Option<&RegistrationConsent>, server_url: &str) -> CmdResult<()> {
    if server_url.trim_end_matches('/') != POLICY["serverUrl"].as_str().unwrap_or_default() {
        return Err(CmdError("FRIENDS_CONSENT_REQUIRED: 当前连接不是本政策告知的服务，请恢复默认连接或联系维护者".into()));
    }
    if let Some(value) = value {
        if value.version == POLICY["version"].as_str().unwrap_or_default()
            && value.terms_accepted && value.privacy_accepted && value.cross_border_accepted
        { return Ok(()); }
    }
    Err(CmdError("FRIENDS_CONSENT_REQUIRED: 请先阅读并同意当前版本的服务协议、隐私政策和出境告知".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registration_requires_current_complete_consent_for_the_disclosed_service() {
        let server = POLICY["serverUrl"].as_str().unwrap();
        let value = json!({"version":POLICY["version"],"termsAccepted":true,"privacyAccepted":true,"crossBorderAccepted":true});
        let accepted: RegistrationConsent = serde_json::from_value(value.clone()).unwrap();
        assert!(validate(Some(&accepted), server).is_ok());
        assert!(validate(Some(&accepted), &format!("{server}/")).is_ok());
        assert!(validate(None, server).is_err());
        assert!(validate(Some(&accepted), "https://another.supabase.co").is_err());
        for key in ["termsAccepted", "privacyAccepted", "crossBorderAccepted"] {
            let mut incomplete = value.clone();
            incomplete[key] = json!(false);
            assert!(validate(Some(&serde_json::from_value(incomplete).unwrap()), server).is_err());
            let mut invalid = value.clone();
            invalid[key] = json!("true");
            assert!(serde_json::from_value::<RegistrationConsent>(invalid).is_err());
        }
        let mut stale = value;
        stale["version"] = json!("old");
        assert!(validate(Some(&serde_json::from_value(stale).unwrap()), server).is_err());
    }
}
