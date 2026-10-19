import type { PlaySession } from "@/types/game";

export type PlayTimePeriod = "day" | "week" | "month";
export interface PlayTimeBucket {
  start: number;
  end: number;
  label: string;
  description: string;
  seconds: number;
}
export interface PlayTimeSeries {
  buckets: PlayTimeBucket[];
  totalSeconds: number;
  gameCount: number;
  activeDays: number;
  games: Array<{ gameId: number; seconds: number }>;
}

function periodStarts(now: Date) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  return { day, week, month: new Date(now.getFullYear(), now.getMonth(), 1) };
}

/** Local calendar bounds; month movement always starts on day one. */
export function playTimePeriodWindow(anchor: Date, period: PlayTimePeriod) {
  const start = periodStarts(anchor)[period];
  const end = new Date(start);
  if (period === "month") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (period === "week" ? 7 : 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export function movePlayTimePeriod(anchor: Date, period: PlayTimePeriod, direction: -1 | 1, now: Date): Date {
  const next = periodStarts(anchor)[period];
  if (period === "month") next.setMonth(next.getMonth() + direction);
  else next.setDate(next.getDate() + direction * (period === "week" ? 7 : 1));
  return new Date(Math.min(+next, +periodStarts(now)[period]));
}

/** Read the whole relevant calendar range; recent-history pagination is separate. */
export function playTimeWindow(now: Date) {
  const starts = periodStarts(now);
  const end = new Date(starts.day);
  end.setDate(end.getDate() + 1);
  return { start: new Date(Math.min(+starts.week, +starts.month)).toISOString(), end: end.toISOString() };
}

/** Shared normalization keeps current-period charts and historical reviews aligned. */
export function completedPlaySessions(sessions: readonly PlaySession[], cutoff: number) {
  return sessions.flatMap(session => {
    const start = Date.parse(session.startedAt);
    const end = session.endedAt ? Date.parse(session.endedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      && Number.isFinite(session.durationSeconds) && session.durationSeconds > 0 && start < cutoff
      ? [{ start, end, seconds: session.durationSeconds, gameId: session.gameId }] : [];
  });
}

export function buildPlayTimeSummary(sessions: readonly PlaySession[], now: Date, anchor = now): Record<PlayTimePeriod, PlayTimeSeries> {
  const starts = periodStarts(anchor);
  const cutoff = now.getTime();
  const completed = completedPlaySessions(sessions, cutoff);
  const series = (period: PlayTimePeriod): PlayTimeSeries => {
    const start = starts[period];
    const end = new Date(start);
    if (period === "month") end.setMonth(end.getMonth() + 1);
    else end.setDate(end.getDate() + (period === "week" ? 7 : 1));
    const buckets: PlayTimeBucket[] = [];
    for (let cursor = +start; cursor < +end;) {
      const date = new Date(cursor);
      const next = new Date(cursor);
      // Elapsed hours allow DST's repeated/missing hours; days use the calendar.
      if (period === "day") next.setTime(cursor + 3_600_000);
      else next.setDate(next.getDate() + 1);
      buckets.push({
        start: cursor, end: Math.min(+next, +end), seconds: 0,
        label: period === "day" ? `${date.getHours()}` : period === "week"
          ? date.toLocaleDateString("zh-CN", { weekday: "short" }) : `${date.getDate()}`,
        description: date.toLocaleString("zh-CN", period === "day"
          ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }
          : { month: "numeric", day: "numeric", weekday: "short" }),
      });
      cursor = +next;
    }
    const games = new Map<number, number>();
    for (const session of completed) {
      if (session.end <= +start || session.start >= Math.min(+end, cutoff)) continue;
      for (const bucket of buckets) {
        const overlap = Math.min(session.end, bucket.end, cutoff) - Math.max(session.start, bucket.start);
        if (overlap <= 0) continue;
        // Preserve recorded duration, including manually adjusted/paused sessions.
        const seconds = session.seconds * overlap / (session.end - session.start);
        bucket.seconds += seconds;
        games.set(session.gameId, (games.get(session.gameId) ?? 0) + seconds);
      }
    }
    return {
      buckets, totalSeconds: buckets.reduce((total, bucket) => total + bucket.seconds, 0),
      gameCount: games.size,
      games: [...games].map(([gameId, seconds]) => ({ gameId, seconds })).sort((a, b) => b.seconds - a.seconds || a.gameId - b.gameId),
      activeDays: period === "day" ? Number(buckets.some(bucket => bucket.seconds > 0)) : buckets.filter(bucket => bucket.seconds > 0).length,
    };
  };
  return { day: series("day"), week: series("week"), month: series("month") };
}
