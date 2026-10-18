export interface BirthdayGame { id: number; title: string; favorite: number; status: string }
export interface BirthdayCharacter {
  id: string;
  source: 'vndb' | 'bangumi';
  externalId: string;
  name: string;
  originalName: string | null;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  birthdayRaw: string | null;
  avatarPath: string | null;
  hidden: boolean;
  customized: boolean;
  games: BirthdayGame[];
}
export interface BirthdaySyncState { gameId: number; title: string; source: string | null; externalId: string | null; status: string; syncedAt: string | null; error: string | null }
export interface BirthdayProgress { running: boolean; cancelling: boolean; total: number; completed: number; failed: number; current: string | null; error: string | null }
export interface BirthdaySnapshot { characters: BirthdayCharacter[]; sync: BirthdaySyncState[]; enabled: boolean; progress: BirthdayProgress }
export interface BirthdayEdit { name: string | null; month: number | null; day: number | null; avatarFile: string | null; hidden: boolean; reset: boolean }
