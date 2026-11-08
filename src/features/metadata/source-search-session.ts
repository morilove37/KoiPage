import type { MetadataCandidate, MetadataProvider, MetadataSearchResult, MetadataSourceProgress } from '../../lib/db';

export interface SourceSearchState {
  provider: MetadataProvider;
  phase: 'searching' | 'success' | 'empty' | 'error';
  candidates: MetadataCandidate[];
  message: string | null;
  elapsedMs: number | null;
}
export interface SourceSearchSnapshot {
  query: string;
  sources: SourceSearchState[];
  searching: boolean;
  result: MetadataSearchResult | null;
}
type Transport = (query: string, sources: MetadataProvider[], onProgress: (progress: MetadataSourceProgress) => void, contextCandidates: MetadataCandidate[]) => Promise<MetadataSearchResult>;
type Reconcile = (query: string, sources: MetadataProvider[], candidates: MetadataCandidate[]) => Promise<MetadataSearchResult>;

function retainVerifiedAliases(candidate: MetadataCandidate, known?: MetadataCandidate): MetadataCandidate {
  const aliases = [...new Set([...(candidate.aliases ?? []), ...(known?.aliases ?? [])])];
  return aliases.length ? { ...candidate, aliases } : candidate;
}

/** Isolates whole searches and per-source retries without discarding other hits. */
export function createSourceSearchSession(transport: Transport, onChange: (state: SourceSearchSnapshot) => void, now = () => performance.now(), reconcile?: Reconcile) {
  let generation = 0;
  let query = '';
  let order: MetadataProvider[] = [];
  let records: Partial<Record<MetadataProvider, SourceSearchState>> = {};
  let versions: Partial<Record<MetadataProvider, number>> = {};
  let automatic: Partial<Record<MetadataProvider, MetadataCandidate[]>> = {};
  let reconciliation = 0;
  let snapshot: SourceSearchSnapshot = { query: '', sources: [], searching: false, result: null };

  const publish = () => {
    const sources = order.map(provider => records[provider]!);
    snapshot = {
      query, sources, searching: sources.some(source => source.phase === 'searching'),
      result: order.length ? {
        candidates: sources.flatMap(source => source.candidates),
        errors: sources.filter(source => source.phase === 'error').map(source => ({provider: source.provider, message: source.message!})),
        automaticCandidates: order.flatMap(provider => automatic[provider] ?? []),
      } : null,
    };
    onChange(snapshot);
  };

  const request = async (providers: MetadataProvider[], epoch: number) => {
    const tickets = new Map<MetadataProvider, number>();
    const started = now();
    for (const provider of providers) {
      const ticket = (versions[provider] ?? 0) + 1;
      versions[provider] = ticket;
      tickets.set(provider, ticket);
      records[provider] = { provider, phase: 'searching', candidates: records[provider]?.candidates ?? [], message: null, elapsedMs: null };
      automatic[provider] = [];
    }
    const contextVersions = new Map(order.filter(provider => !providers.includes(provider)).map(provider => [provider, versions[provider]]));
    const contextCandidates = order.filter(provider => !providers.includes(provider) && records[provider]?.phase === 'success')
      .flatMap(provider => records[provider]!.candidates);
    publish();
    const current = (provider: MetadataProvider) => epoch === generation && tickets.has(provider) && tickets.get(provider) === versions[provider];
    const settle = (provider: MetadataProvider, candidates: MetadataCandidate[], error: string | null, elapsedMs: number) => {
      const hits = candidates.filter(c => c.provider === provider).map(candidate =>
        retainVerifiedAliases(candidate, records[provider]?.candidates.find(known => known.externalId === candidate.externalId)));
      records[provider] = {provider, candidates: hits, message: error, elapsedMs,
        phase: error !== null ? 'error' : hits.length ? 'success' : 'empty'};
    };
    try {
      const result = await transport(query, providers, progress => {
        if (!current(progress.provider)) return;
        settle(progress.provider, progress.candidates, progress.error, progress.elapsedMs);
        publish();
      }, contextCandidates);
      for (const provider of providers) {
        if (!current(provider)) continue;
        const error = result.errors.find(error => error.provider === provider)?.message ?? null;
        settle(provider, result.candidates.filter(c => c.provider === provider), error, records[provider]?.elapsedMs ?? Math.max(0, now() - started));
        const hits = records[provider]!.candidates;
        const ranked = [...result.automaticCandidates.filter(c => c.provider === provider), ...(automatic[provider] ?? [])];
        automatic[provider] = [...new Map(ranked.filter(c => hits.some(hit => hit.externalId === c.externalId)).map(c => [c.externalId, c])).values()];
      }
      // A retry carries other successful candidates only for identity checks,
      // never another network request. Do not overwrite a separately retried source.
      for (const [provider, version] of contextVersions) {
        if (epoch !== generation || versions[provider] !== version || records[provider]?.phase !== 'success') continue;
        const previous = records[provider]!;
        records[provider] = {...previous, candidates: previous.candidates.map(candidate =>
          retainVerifiedAliases(candidate, result.candidates.find(hit => hit.provider === provider && hit.externalId === candidate.externalId)))};
        const ranked = [...result.automaticCandidates.filter(c => c.provider === provider), ...(automatic[provider] ?? [])];
        automatic[provider] = [...new Map(ranked.map(c => [c.externalId, c])).values()];
      }
    } catch (cause) {
      for (const provider of providers) {
        if (current(provider) && records[provider]?.phase === 'searching') {
          settle(provider, records[provider]?.candidates ?? [], cause instanceof Error ? cause.message : String(cause), Math.max(0, now() - started));
        }
      }
    }
    if (epoch !== generation) return;
    publish();
    // Providers can finish while another source is being retried. Reconcile
    // the final current snapshot locally; this never searches a website again.
    if (reconcile && !snapshot.searching && snapshot.result && order.length > 1) {
      const ticket = ++reconciliation;
      const revision = order.map(provider => versions[provider]).join(',');
      try {
        const combined = await reconcile(query, [...order], snapshot.result.candidates);
        if (epoch !== generation || ticket !== reconciliation || revision !== order.map(provider => versions[provider]).join(',')) return;
        for (const provider of order) {
          const previous = records[provider]!;
          if (previous.phase !== 'success') continue;
          records[provider] = {...previous, candidates: previous.candidates.map(candidate =>
            retainVerifiedAliases(candidate, combined.candidates.find(hit => hit.provider === provider && hit.externalId === candidate.externalId)))};
          automatic[provider] = combined.automaticCandidates.filter(candidate => candidate.provider === provider);
        }
        publish();
      } catch { /* Keep usable search hits if local identity reconciliation fails. */ }
    }
  };

  return {
    search(rawQuery: string, providers: MetadataProvider[]) {
      generation += 1;
      query = rawQuery.trim();
      order = [...new Set(providers)];
      records = {}; versions = {}; automatic = {};
      return request(order, generation);
    },
    retry(provider: MetadataProvider) {
      if (!order.includes(provider) || records[provider]?.phase === 'searching') return Promise.resolve();
      return request([provider], generation);
    },
    cancel() {
      generation += 1; query = ''; order = []; records = {}; versions = {}; automatic = {};
      publish();
    },
    getSnapshot: () => snapshot,
  };
}
