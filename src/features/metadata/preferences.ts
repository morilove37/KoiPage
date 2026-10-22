import type { MetadataProvider } from '@/lib/db';

export const DEFAULT_SOURCE_KEY = 'metadata_default_source';
export const ENABLED_SOURCES_KEY = 'metadata_enabled_sources';
const PROVIDERS: MetadataProvider[] = ['nextmoe', 'vndb', 'bangumi', '2dfan'];

/** Only an absent preference means all sources. Invalid settings fail closed. */
export function normalizeEnabledSources(value: string | null | undefined): MetadataProvider[] {
  if (value == null) return [...PROVIDERS];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is MetadataProvider => PROVIDERS.includes(item)))];
  } catch { return []; }
}

export function normalizeDefaultSource(value: string | null | undefined, enabled?: readonly MetadataProvider[]): MetadataProvider {
  const preferred = parseDefaultSource(value);
  return enabled?.length && !enabled.includes(preferred) ? enabled[0] : preferred;
}

function parseDefaultSource(value: string | null | undefined): MetadataProvider {
  switch (value?.trim().toLowerCase()) {
    case 'nextmoe': return 'nextmoe';
    case 'bangumi': return 'bangumi';
    case '2dfan': return '2dfan';
    default: return 'vndb';
  }
}
