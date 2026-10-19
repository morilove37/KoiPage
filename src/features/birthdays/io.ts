import { invoke } from '@/lib/logging';
import { ready } from '@/lib/db';
import type { BirthdayEdit, BirthdayProgress, BirthdaySnapshot } from './types';
export const birthdaysList = () => ready.then(() => invoke<BirthdaySnapshot>('birthdays_list'));
export const birthdaysUpdate = (id: string, input: BirthdayEdit) => ready.then(() => invoke<void>('birthdays_update', { id, input }));
export const birthdaysSyncStart = (force: boolean) => ready.then(() => invoke<BirthdayProgress>('birthdays_sync_start', { force }));
export const birthdaysSyncCancel = () => invoke<BirthdayProgress>('birthdays_sync_cancel');
export const birthdaysExport = (path: string) => ready.then(() => invoke<number>('birthdays_export', { path }));
export const birthdaysImport = (path: string) => ready.then(() => invoke<number>('birthdays_import', { path }));
