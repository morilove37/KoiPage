export const homeCards = [
  { id: 'hero', label: '游戏大封面' },
  { id: 'filters', label: '常用筛选' },
  { id: 'total', label: '累计游玩' },
  { id: 'playing', label: '游玩中' },
  { id: 'completed', label: '已通关' },
  { id: 'upNext', label: '待开始' },
  { id: 'recent', label: '最近游玩记录' },
  { id: 'statistics', label: '游玩时长与回顾' },
  { id: 'friends', label: '好友同好' },
  { id: 'birthdays', label: '角色生日' },
  { id: 'waiting', label: '等待开启的故事' },
  { id: 'progress', label: '游戏库进度' },
] as const;

export type HomeCardId = typeof homeCards[number]['id'];
export const homeCardPreferencesKey = 'koipage.home.hidden-cards.v1';

export function readHiddenHomeCards(raw: string | null): HomeCardId[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? homeCards.map(card => card.id).filter(id => value.includes(id)) : [];
  } catch {
    return [];
  }
}
