import type { GamePatch } from '@/types/game';

export const detailFields = {
  info: ['title', 'originalTitle', 'developer', 'releaseDate', 'rating', 'coverPath', 'description', 'notes', 'vndbId'],
  files: ['installPath', 'exePath', 'launchArgs', 'workdir', 'savePath'],
  tags: ['tags', 'tagNames'],
} as const satisfies Record<string, readonly (keyof GamePatch)[]>;

export type DetailSection = keyof typeof detailFields;
export type GamePathState = 'ok' | 'archived' | 'offline' | 'missingFolder' | 'missingExe';

export function detailPatchFor(patch: GamePatch, section: DetailSection): GamePatch {
  return Object.fromEntries(detailFields[section].filter(key => Object.prototype.hasOwnProperty.call(patch, key)).map(key => [key, patch[key]]));
}

export function launchPathUnavailable(exePath: string | null, state: GamePathState | undefined, running: boolean): boolean {
  return !running && (!exePath?.trim() || state === 'offline' || state === 'missingFolder' || state === 'missingExe');
}
