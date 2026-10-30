import type { ProfileInput, SyncItem, SyncValue } from './api';

export interface ProfileDraft { subjectId: string; enabled: boolean; rate: string; comment: string; subjectEdited: boolean; enabledEdited: boolean; rateEdited: boolean; commentEdited: boolean }
export function profileDraft(item: SyncItem): ProfileDraft {
  return { subjectId: item.subjectId === null ? '' : String(item.subjectId), enabled: item.enabled,
    rate: item.personalRate === null ? '' : String(item.personalRate), comment: item.personalComment ?? '', subjectEdited: false, enabledEdited: false, rateEdited: false, commentEdited: false };
}
export function rebaseProfileDraft(item: SyncItem, draft: ProfileDraft): ProfileDraft {
  const latest = profileDraft(item);
  return { ...draft, subjectId: draft.subjectEdited ? draft.subjectId : latest.subjectId,
    enabled: draft.enabledEdited ? draft.enabled : latest.enabled,
    rate: draft.rateEdited ? draft.rate : latest.rate, comment: draft.commentEdited ? draft.comment : latest.comment };
}
export function profileInput(item: SyncItem, draft: ProfileDraft): ProfileInput {
  draft = rebaseProfileDraft(item, draft);
  const id = draft.subjectId.trim();
  if (id && (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) throw new Error('Bangumi ID 必须是正整数。');
  const rate = draft.rate.trim();
  if (draft.rateEdited && rate !== '' && (!/^\d+$/.test(rate) || Number(rate) > 10)) throw new Error('我的评分必须为 0–10 的整数；0 表示未评分。');
  return { gameId: item.gameId, expectedRevision: item.revision, subjectId: id ? Number(id) : null, enabled: draft.enabled,
    personalRate: draft.rateEdited ? (rate === '' ? null : Number(rate)) : item.personalRate,
    personalComment: draft.commentEdited ? draft.comment : item.personalComment };
}
export function valueLabel(value: SyncValue): string {
  const status: Record<number, string> = { 1: '想玩', 2: '已通关', 3: '游玩中', 4: '搁置', 5: '弃坑' };
  return `状态：${value.collectionType === null ? '未收藏 / 未游玩' : status[value.collectionType] ?? value.collectionType}；评分：${value.rate === 0 ? '未评分（0）' : value.rate}；短评：${value.comment || '（空）'}`;
}
