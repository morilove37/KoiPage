import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPlayed, shareGames, sharePages } from "../src/features/share/model.ts";

const game = (id, patch = {}) => ({ id, title: `游戏${id}`, status: "unplayed", playTimeSeconds: 0, lastPlayedAt: null, rating: null, releaseDate: null, ...patch });
test("only played games enter the initial selection, including manually completed games", () => {
  assert.equal(hasPlayed(game(1)), false);
  assert.equal(hasPlayed(game(1, { status: "wishlist" })), false);
  assert.equal(hasPlayed(game(1, { status: "completed" })), true);
  assert.equal(hasPlayed(game(1, { lastPlayedAt: "2026-10-16T00:00:00Z" })), true);
  assert.equal(hasPlayed(game(1, { playTimeSeconds: 1 })), true);
});
test("hidden games are excluded from the actual output, with no mutation of the library", () => {
  const games = [game(1, { status: "playing", playTimeSeconds: 100 }), game(2, { status: "completed", playTimeSeconds: 900 })];
  const result = shareGames(games, new Set([2]), "playTimeSeconds", "desc");
  assert.deepEqual(result.map(game => game.id), [1]);
  assert.equal(result.reduce((sum, game) => sum + game.playTimeSeconds, 0), 100);
  assert.equal(games.length, 2);
});
test("unrated games remain last in either rating direction", () => {
  const games = [game(1, { status: "playing" }), game(2, { status: "playing", rating: 8.25 }), game(3, { status: "playing", rating: 9.12 })];
  assert.deepEqual(shareGames(games, new Set(), "rating", "asc").map(game => game.id), [2, 3, 1]);
  assert.deepEqual(shareGames(games, new Set(), "rating", "desc").map(game => game.id), [3, 2, 1]);
});
test("titles use numeric ordering and reversing does not mutate the input", () => {
  const games = [game(1, { status: "playing", title: "Gal 10" }), game(2, { status: "playing", title: "Gal 2" })];
  assert.deepEqual(shareGames(games, new Set(), "title", "asc").map(game => game.id), [2, 1]);
  assert.deepEqual(games.map(game => game.id), [1, 2]);
});
test("large libraries paginate without truncating or duplicating games", () => {
  const games = Array.from({ length: 121 }, (_, index) => game(index));
  const pages = sharePages(games);
  assert.deepEqual(pages.map(page => page.length), [60, 60, 1]);
  assert.deepEqual(pages.flat().map(game => game.id), games.map(game => game.id));
  assert.deepEqual(sharePages([]), []);
});
