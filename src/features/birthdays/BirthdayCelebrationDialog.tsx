import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { CoverImage } from '@/components/ui/cover-image';
import { Dialog } from '@/components/ui/dialog';
import { useAnnouncementStore } from '@/features/announcements/store';
import { useUpdateStore } from '@/lib/updater';
import { cn } from '@/lib/utils';
import { birthdaysList } from './io';
import { birthdayDate, buildBirthdayEntries, localBirthdayDate } from './model';
import type { BirthdayEntry } from './model';
import type { BirthdayCharacter } from './types';
import { useLocalBirthdayDay } from './useBirthdays';
import {
  dismissBirthdayCelebration, initializeBirthdayReminder, showBirthdayCelebration, useBirthdayReminderStore,
} from './reminder-store';

const OTHER_DIALOG = '[role="dialog"]:not(.birthday-celebration-dialog)';

/** Birthday greetings yield to startup announcements and any user-initiated modal. */
function useOtherDialogOpen() {
  const [blocked, setBlocked] = useState(() => Boolean(document.querySelector(OTHER_DIALOG)));
  useEffect(() => {
    const update = () => setBlocked(Boolean(document.querySelector(OTHER_DIALOG)));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] });
    update();
    return () => observer.disconnect();
  }, []);
  return blocked;
}

function useCachedBirthdayCharacters() {
  const [characters, setCharacters] = useState<BirthdayCharacter[]>([]);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const snapshot = await birthdaysList();
        if (alive && request === sequence) setCharacters(snapshot.characters);
      } catch (cause) { console.warn('[birthday-reminder] cached characters:', cause); }
    };
    const wake = () => {
      const next = document.visibilityState === 'visible';
      setVisible(next);
      if (next) void refresh();
    };
    const subscription = listen('birthdays-updated', () => { void refresh(); });
    void subscription.then(remove => { if (!alive) remove(); }).catch(() => {});
    void refresh();
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false; sequence++;
      void subscription.then(remove => remove()).catch(() => {});
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);
  return { characters, visible };
}

export function BirthdayCelebrationView({ entries, now, onClose, error }: {
  entries: BirthdayEntry[]; now: Date; onClose: () => void; error?: string | null;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const characterList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => {
      if (!document.querySelector(OTHER_DIALOG) && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const single = entries.length === 1;
  return <div onKeyDownCapture={event => {
    if (event.key === 'Tab') {
      event.preventDefault();
      // Both the scrollable list and the dismissal button stay reachable.
      if (document.activeElement === characterList.current) closeButton.current?.focus();
      else characterList.current?.focus();
    }
  }}>
    <Dialog open onClose={onClose} title="生日快乐" className="birthday-celebration-dialog max-w-3xl"
      description={`${now.getMonth() + 1} 月 ${now.getDate()} 日 · 今日寿星`}
      footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">每天只提醒一次，可在「设置 → 角色生日」中关闭。</p>
        <Button ref={closeButton} type="button" onClick={onClose}>生日快乐！</Button>
      </div>}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
        <section aria-label="今日生日角色" className="min-w-0">
          <p className="text-xs font-medium tracking-wider text-primary">为喜欢的角色，留住特别的一天</p>
          <h3 className="mt-2 break-words text-xl font-semibold leading-relaxed">
            {single ? `${entries[0].character.name}，生日快乐！` : `今天有 ${entries.length} 位角色生日，一起送上祝福吧！`}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">愿新的一岁，也有温暖的故事相伴。</p>
          <ul ref={characterList} tabIndex={0} aria-label="今日寿星列表" className="mt-4 max-h-[44vh] space-y-3 overflow-y-auto rounded-xl pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {entries.map(({ character, observed }) => <li key={character.id} className="flex min-w-0 items-center gap-4 rounded-xl border border-border bg-background/60 p-3">
              <div className={cn('shrink-0 overflow-hidden rounded-lg bg-primary/10', single ? 'h-40 w-28' : 'h-28 w-20')}>
                <CoverImage path={character.avatarPath} alt={character.name} className="h-full w-full object-cover object-top" fallbackText={character.name.slice(0, 1)} />
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="break-words text-base font-semibold">{character.name}</p>
                {character.originalName && character.originalName !== character.name ? <p className="break-words text-xs text-muted-foreground">{character.originalName}</p> : null}
                <p className="text-xs font-medium text-primary">{birthdayDate(character)} · 今天生日</p>
                <p className="break-words text-xs leading-relaxed text-muted-foreground">{character.games.map(game => game.title).join(' / ')}</p>
                {observed ? <p className="text-[11px] text-muted-foreground">原生日 2 月 29 日，平年于 3 月 1 日庆祝。</p> : null}
              </div>
            </li>)}
          </ul>
        </section>
        <aside className="flex flex-col items-center justify-center rounded-2xl border border-primary/10 bg-gradient-to-br from-primary/5 via-card to-rose-500/10 p-3">
          <img src="/birthdays/hotaru-celebrate.png" alt="水无月萤捧着草莓生日蛋糕，送上生日祝福" width={256} height={256}
            draggable={false} className="h-56 w-full object-contain md:h-64" />
          <p className="mt-2 text-center text-sm font-medium text-primary">生日快乐，一起庆祝吧！</p>
        </aside>
      </div>
      {error ? <p role="status" className="mt-3 text-xs text-destructive">{error}，可在设置中重试。</p> : null}
    </Dialog>
  </div>;
}

export function BirthdayCelebrationDialog() {
  const now = useLocalBirthdayDay();
  const day = localBirthdayDate(now);
  const { characters, visible } = useCachedBirthdayCharacters();
  const state = useBirthdayReminderStore();
  const announcementBusy = useAnnouncementStore(s => s.loading || s.queue.length > 0 || s.manual !== null);
  const updating = useUpdateStore(s => s.startupPending || s.status === 'checking' || s.dialogOpen);
  const otherDialog = useOtherDialogOpen();
  const blocked = announcementBusy || updating || otherDialog || !visible;
  const today = useMemo(() => buildBirthdayEntries(characters.filter(c => c.games.length > 0), now, 0), [characters, now]);

  useEffect(() => { void initializeBirthdayReminder(); }, []);
  useEffect(() => {
    if (state.activeDate && state.activeDate !== day) dismissBirthdayCelebration();
    if (!blocked && !state.loading && document.visibilityState === 'visible' && !document.querySelector(OTHER_DIALOG)) {
      showBirthdayCelebration(characters, now);
    }
  }, [blocked, characters, now, day, state.loading, state.preferences?.enabled, state.activeDate]);

  if (blocked || !state.preferences?.enabled || state.activeDate !== day || today.length === 0) return null;
  return <BirthdayCelebrationView entries={today} now={now} error={state.error} onClose={() => {
    // A newly opened higher-priority modal must own its Escape key.
    if (!document.querySelector(OTHER_DIALOG)) dismissBirthdayCelebration();
  }} />;
}
