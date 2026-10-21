import { ready } from '@/lib/db';
import { invoke } from '@/lib/logging';
import type { LaunchProfile } from './profile-model';
export interface EffectiveLaunchProfile {
  profile: LaunchProfile;
  locale: boolean;
  magpie: boolean;
  luna: boolean;
  localeSource: string;
  localePath: string | null;
  scalingMode: string | null;
}
export const launchProfileGet = (gameId: number) => ready.then(() => invoke<EffectiveLaunchProfile>('launch_profile_get', { gameId }));
export const launchProfileSave = (gameId: number, profile: LaunchProfile) => ready.then(() => invoke<EffectiveLaunchProfile>('launch_profile_save', { gameId, profile }));
