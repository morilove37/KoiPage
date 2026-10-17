import type { PlaySession } from "@/types/game";
import { completedPlaySessions } from "./play-time.ts";

export interface CalendarDay {
  key: string;
  date: number;
  start: number;
  end: number;
  seconds: number;
  future: boolean;
  games: Array<{ gameId: number; seconds: number }>;
}

export function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthWindow(month: Date) {
  return {
    start: new Date(month.getFullYear(), month.getMonth(), 1).toISOString(),
    end: new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString(),
  };
}

export function calendarMonth(sessions: readonly PlaySession[], month: Date, now: Date) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = +new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const completed = completedPlaySessions(sessions, +now);
  const games = new Set<number>();
  const days: CalendarDay[] = Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), index + 1);
    const end = new Date(start.getFullYear(), start.getMonth(), index + 2);
    const totals = new Map<number, number>();
    for (const session of completed) {
      const overlap = Math.min(session.end, +end, +now) - Math.max(session.start, +date);
      if (overlap <= 0) continue;
      const seconds = session.seconds * overlap / (session.end - session.start);
      totals.set(session.gameId, (totals.get(session.gameId) ?? 0) + seconds);
      games.add(session.gameId);
    }
    return {
      key: calendarDateKey(date), date: index + 1, start: +date, end: +end,
      seconds: [...totals.values()].reduce((sum, value) => sum + value, 0),
      future: +date > today,
      games: [...totals].map(([gameId, seconds]) => ({ gameId, seconds })).sort((a, b) => b.seconds - a.seconds || a.gameId - b.gameId),
    };
  });
  return {
    days, leadingDays: (start.getDay() + 6) % 7,
    totalSeconds: days.reduce((sum, day) => sum + day.seconds, 0),
    activeDays: days.filter(day => day.seconds > 0).length, gameCount: games.size,
  };
}
