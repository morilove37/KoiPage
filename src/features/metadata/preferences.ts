import type { MetadataProvider } from '@/lib/db';

export const DEFAULT_SOURCE_KEY = 'metadata_default_source';
export function normalizeDefaultSource(value: string | null | undefined): MetadataProvider {
  switch (value?.trim().toLowerCase()) {
    case 'nextmoe': return 'nextmoe';
    case 'bangumi': return 'bangumi';
    case '2dfan': return '2dfan';
    default: return 'vndb';
  }
}
