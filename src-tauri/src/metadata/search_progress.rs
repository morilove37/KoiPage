use std::{future::Future, time::Duration};
use super::{CmdResult, MetadataCandidate, Provider};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataSourceProgress {
    pub provider: Provider,
    pub candidates: Vec<MetadataCandidate>,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

pub(crate) async fn report<F: Fn(MetadataSourceProgress) + Sync>(
    provider: Provider,
    search: impl Future<Output = CmdResult<Vec<MetadataCandidate>>>,
    progress: &F,
    timeout: Duration,
) -> CmdResult<Vec<MetadataCandidate>> {
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(timeout, search).await
        .unwrap_or_else(|_| Err(super::CmdError("搜索请求超时，请稍后重试该数据源".into())));
    progress(MetadataSourceProgress {
        provider,
        candidates: result.as_ref().ok().cloned().unwrap_or_default(),
        error: result.as_ref().err().map(|error| error.0.clone()),
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Mutex, task::Poll};

    #[tokio::test]
    async fn completed_provider_is_reported_before_other_provider_finishes() {
        let events = Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);
        let (release, waiting) = tokio::sync::oneshot::channel::<()>();
        let work = async {
            tokio::join!(
                report(Provider::Vndb, async { Ok(vec![]) }, &progress, Duration::from_secs(30)),
                report(Provider::TwoDfan, async { waiting.await.unwrap(); Ok(vec![]) }, &progress, Duration::from_secs(30))
            )
        };
        tokio::pin!(work);
        let polled = std::future::poll_fn(|cx| Poll::Ready(work.as_mut().poll(cx))).await;
        assert!(polled.is_pending());
        assert_eq!(events.lock().unwrap().len(), 1, "the fast result must be available before aggregate completion");
        assert_eq!(events.lock().unwrap()[0].provider, Provider::Vndb);
        release.send(()).unwrap();
        let (a,b) = work.await;
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn failure_and_timeout_both_report_one_terminal_event() {
        let events = Mutex::new(Vec::new());
        let progress = |event| events.lock().unwrap().push(event);
        let failed = report(Provider::TwoDfan, async { Err(super::super::CmdError("访问验证".into())) }, &progress, Duration::from_secs(30)).await;
        assert!(failed.is_err());
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(events.lock().unwrap()[0].error.as_deref(), Some("访问验证"));
        let timed_out = report(Provider::Vndb, std::future::pending(), &progress, Duration::ZERO).await;
        assert!(timed_out.unwrap_err().0.contains("超时"));
        assert_eq!(events.lock().unwrap().len(), 2);
        assert!(events.lock().unwrap()[1].error.as_deref().unwrap().contains("超时"));
    }
}
