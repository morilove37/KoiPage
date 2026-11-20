import assert from 'node:assert/strict';
import { test } from 'node:test';
import { friendPicks, readPublicFriendLibraries } from '../src/features/home/friend-picks.ts';

const game = (id, fields = {}) => ({ id, title: `作品 ${id}`, originalTitle: null, developer: null, vndbId: `v${id}`, bangumiId: null, status: 'unplayed', playTimeSeconds: 0, lastPlayedAt: null, ...fields });
const rated = (id, rating, fields = {}) => ({ ...game(id), rating, ...fields });
const library = (id, games) => ({ friend: { id, nickname: id }, games });

test('picks unstarted local works from ratings of 8 or above and keeps the highest rating per work', () => {
  const games = [game(1), game(2, { status: 'wishlist' }), game(3, { playTimeSeconds: 10 }), game(4, { status: 'completed' }), game(5, { lastPlayedAt: '2026-11-01' })];
  const picks = friendPicks(games, [library('A', [rated(1, 8), rated(2, 7.9), rated(3, 9), rated(4, 10), rated(5, 9)]), library('B', [rated(1, 9), rated(2, 8.5)])]);
  assert.deepEqual(picks.map(pick => [pick.game.id, pick.friend.id, pick.rating]), [[1, 'B', 9], [2, 'B', 8.5]]);
});

test('rejects conflicting identifiers and ambiguous titles, but accepts an exact title and developer', () => {
  const games = [game(1, { bangumiId: '10' }), game(2, { vndbId: null, developer: '社团' }), game(3, { vndbId: null, developer: '社团' }), game(4, { vndbId: null, title: '作品 3', developer: '社团' })];
  const picks = friendPicks(games, [library('A', [rated(1, 10, { bangumiId: '99' }), rated(2, 8, { vndbId: null, developer: '社团' }), rated(3, 10, { vndbId: null, developer: '社团' })])]);
  assert.deepEqual(picks.map(pick => pick.game.id), [2]);
});

test('loads published pages and discards the whole result when access is withdrawn', async () => {
  const offsets = [];
  const profile = { profile: { id: 'friend', nickname: '友人' }, self: false, libraryShared: true, viewerLibraryShared: true, total: 2, pageSize: 1 };
  const load = async ({ offset }) => {
    offsets.push(offset);
    return { ...profile, games: [rated(offset + 1, 8 + offset)] };
  };
  const [publicLibrary] = await readPublicFriendLibraries(['friend'], load, () => true, () => false);
  assert.deepEqual(publicLibrary.games.map(game => game.rating), [8, 9]);
  assert.deepEqual(offsets, [0, 1]);
  const gated = await readPublicFriendLibraries(['friend'], async params => ({ ...await load(params), viewerLibraryShared: params.offset === 0 }), () => true, () => false);
  assert.deepEqual(gated, []);
});

test('gives every friend a first page before following later pages, under the shared request budget', async () => {
  const calls = [];
  let remaining = 3;
  const load = async ({ target, offset }) => {
    calls.push([target, offset]);
    return { ...library(target, [rated(offset + 1, 8)]), profile: { id: target, nickname: target }, libraryShared: true, viewerLibraryShared: true, total: 3, pageSize: 1 };
  };
  const result = await readPublicFriendLibraries(['A', 'B'], load, () => remaining-- > 0, () => false);
  assert.deepEqual(calls, [['A', 0], ['B', 0], ['A', 1]]);
  assert.deepEqual(result.map(entry => [entry.friend.id, entry.games.length]), [['A', 2], ['B', 1]]);
});
