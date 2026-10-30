import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDescriptionChoice, descriptionChoices, selectDescription } from '../src/features/metadata/description-choice.ts';

const detail = {
  title: 'CLANNAD', provider: 'vndb', description: '中文简介', descriptionLang: 'zh-Hans', descriptionSource: 'bangumi',
  descriptionOptions: [
    { source: 'vndb', language: 'en', text: 'English intro', attribution: 'VNDB' },
    { source: 'bangumi', language: 'zh-Hans', text: '中文简介', attribution: 'Bangumi' },
    { source: '2dfan', language: 'zh', text: '另一份中文简介', attribution: '2DFan' },
  ],
};

test('initial choice prefers Chinese even with VNDB default, then prefers the default among Chinese sources', () => {
  assert.equal(defaultDescriptionChoice(detail, 'vndb'), '1');
  assert.equal(defaultDescriptionChoice(detail, 'bangumi'), '1');
  assert.equal(defaultDescriptionChoice(detail, '2dfan'), '2');
  assert.equal(defaultDescriptionChoice(detail, 'nextmoe'), '1');
  assert.equal(selectDescription(detail, defaultDescriptionChoice(detail, 'vndb')).description, '中文简介');
  assert.equal(selectDescription(detail, defaultDescriptionChoice(detail, 'nextmoe')).description, '中文简介');
});

test('without a Chinese intro the default source is used, and manual English choice remains available', () => {
  const englishOnly = { ...detail, description: 'English intro', descriptionLang: 'en', descriptionSource: 'vndb', descriptionOptions: [detail.descriptionOptions[0]] };
  assert.equal(defaultDescriptionChoice(englishOnly, 'vndb'), '0');
  assert.equal(defaultDescriptionChoice(englishOnly, 'nextmoe'), null);
  assert.equal(selectDescription(detail, '0').description, 'English intro');
});

test('switching source updates submitted text, language and source without changing identity', () => {
  const english = selectDescription(detail, '0');
  assert.equal(english.description, 'English intro');
  assert.equal(english.descriptionLang, 'en');
  assert.equal(english.descriptionSource, 'vndb');
  assert.equal(english.title, detail.title);
  assert.equal(english.provider, 'vndb');
  assert.equal(english.attribution, 'VNDB');
  assert.equal(selectDescription(detail, '2').description, '另一份中文简介');
  assert.equal(detail.description, '中文简介');
});

test('changing choice keeps source attribution and does not change field-selection state', () => {
  const original = { ...detail, attribution: 'VNDB、鲲 Galgame 论坛', checked: { description: false, title: true } };
  const selected = selectDescription(original, '2');
  assert.equal(selected.attribution, 'VNDB、鲲 Galgame 论坛、2DFan');
  assert.equal(selected.checked.description, false);
  assert.equal(selected.checked, original.checked);
});

test('default and stale choices preserve automatic selection', () => {
  for (const index of [null, '', 'no', '-1', '999']) assert.equal(selectDescription(detail, index).description, '中文简介');
});

test('choices filter blanks, deduplicate and support legacy detail responses', () => {
  assert.equal(descriptionChoices({ ...detail, descriptionOptions: [...detail.descriptionOptions, detail.descriptionOptions[0], { source: 'nextmoe', language: 'zh', text: ' ' }] }).length, 3);
  assert.equal(descriptionChoices({ description: 'Only intro', descriptionLang: 'en', provider: 'vndb' }).length, 1);
  assert.deepEqual(descriptionChoices({ description: ' ' }), []);
});
