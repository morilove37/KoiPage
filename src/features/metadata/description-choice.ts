import type { MetadataDescriptionOption, MetadataProvider } from '@/lib/db';

interface Described {
  description?: string | null;
  descriptionLang?: string | null;
  descriptionSource?: MetadataProvider | null;
  descriptionOptions?: MetadataDescriptionOption[];
  provider?: MetadataProvider | null;
  attribution?: string | null;
}

export function descriptionChoices(detail: Described): MetadataDescriptionOption[] {
  const choices: MetadataDescriptionOption[] = [];
  const available = [...(detail.descriptionOptions ?? [])];
  if (detail.description?.trim()) available.push({ source: detail.descriptionSource ?? detail.provider ?? null,
    language: detail.descriptionLang ?? null, text: detail.description, attribution: detail.attribution });
  for (const option of available) {
    if (!option.text.trim() || choices.some(existing => existing.source === option.source && existing.language === option.language && existing.text.trim() === option.text.trim())) continue;
    choices.push(option);
  }
  return choices;
}

export function selectDescription<T extends Described>(detail: T, choice: string | null): T {
  if (choice === null || !/^(0|[1-9]\d*)$/.test(choice)) return detail;
  const selected = descriptionChoices(detail)[Number(choice)];
  if (!selected) return detail;
  const attribution = [...new Set([detail.attribution, selected.attribution].flatMap(value => value?.split('、').map(part => part.trim()).filter(Boolean) ?? []))].join('、') || null;
  return { ...detail, description: selected.text, descriptionLang: selected.language, descriptionSource: selected.source, attribution };
}

export function defaultDescriptionChoice(detail: Described, preferred: MetadataProvider): string | null {
  const choices = descriptionChoices(detail);
  const chinese = choices.flatMap((option, index) => {
    const language = option.language?.trim().toLowerCase() ?? '';
    return language === 'zh' || language.startsWith('zh-') || language.startsWith('zh_') ? [index] : [];
  });
  if (chinese.length) {
    const preferredChinese = chinese.find(index => choices[index].source === preferred);
    const currentChinese = chinese.find(index => choices[index].text.trim() === detail.description?.trim()
      && choices[index].source === (detail.descriptionSource ?? detail.provider ?? null));
    return String(preferredChinese ?? currentChinese ?? chinese[0]);
  }
  const index = choices.findIndex(option => option.source === preferred);
  return index < 0 ? null : String(index);
}
