import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameProcessController } from '../src/features/launch/process-state.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const states = new Map();
  const controller = createGameProcessController({
    readRunning: async () => false,
    launch: async () => ({ pid: 101, sessionId: 1 }),
    stop: async () => true,
    onChange: (id, state) => states.set(id, state),
    ...overrides,
  });
  return { ...controller, state: () => states.get(7)?.status ?? 'idle' };
}

test('an older process query cannot overwrite a newer query', async () => {
  const first = deferred();
  const second = deferred();
  const replies = [first, second];
  const game = fixture({ readRunning: () => replies.shift().promise });
  const stale = game.refresh(7);
  const fresh = game.refresh(7);
  second.resolve(true);
  await fresh;
  first.resolve(false);
  await stale;
  assert.equal(game.state(), 'running');
});

test('an exit invalidates a process query already in flight', async () => {
  const reply = deferred();
  const game = fixture({ readRunning: () => reply.promise });
  const pending = game.refresh(7);
  game.exited(7, 1);
  reply.resolve(true);
  await pending;
  assert.equal(game.state(), 'idle');
});

test('an exit before launch resolves cannot resurrect a finished game', { timeout: 2000 }, async () => {
  const launched = deferred();
  const entered = deferred();
  const game = fixture({ launch: () => { entered.resolve(); return launched.promise; } });
  const pending = game.start(7);
  await entered.promise;
  assert.equal(game.state(), 'starting');
  game.exited(7, 1);
  launched.resolve({ pid: 101, sessionId: 1 });
  await pending;
  assert.equal(game.state(), 'idle');
});

test('a second start cannot launch again while the first launch is pending', { timeout: 2000 }, async () => {
  const launched = deferred();
  const entered = deferred();
  let starts = 0;
  const game = fixture({ launch: () => { starts++; entered.resolve(); return launched.promise; } });
  const pending = game.start(7);
  await entered.promise;
  game.exited(7, 1);
  assert.equal((await game.start(7)).kind, 'busy');
  launched.resolve({ pid: 101, sessionId: 1 });
  await pending;
  assert.equal(starts, 1);
});

test('a failed launch restores an idle button and allows retry', async () => {
  let fails = true;
  const game = fixture({
    launch: async () => {
      if (fails) throw new Error('exe missing');
      return { pid: 101, sessionId: 1 };
    },
  });
  await assert.rejects(game.start(7), /exe missing/);
  assert.equal(game.state(), 'idle');
  fails = false;
  assert.equal((await game.start(7)).kind, 'started');
  assert.equal(game.state(), 'running');
});

test('a tracked running process opens its panel without launching again', async () => {
  let starts = 0;
  const game = fixture({ readRunning: async () => true, launch: async () => { starts++; } });
  assert.equal((await game.start(7)).kind, 'running');
  assert.equal(game.state(), 'running');
  assert.equal(starts, 0);
});

test('an older refresh cannot reset a successful launch', async () => {
  const reply = deferred();
  let reads = 0;
  const game = fixture({ readRunning: () => ++reads === 1 ? reply.promise : Promise.resolve(false) });
  const stale = game.refresh(7);
  await game.start(7);
  reply.resolve(false);
  await stale;
  assert.equal(game.state(), 'running');
});

test('a delayed exit from a previous session cannot clear the new process', async () => {
  const game = fixture({ launch: async () => ({ pid: 202, sessionId: 2 }) });
  await game.start(7);
  game.exited(7, 1);
  assert.equal(game.state(), 'running');
  game.exited(7, 2);
  assert.equal(game.state(), 'idle');
});

test('a rejected stop preserves the process state; a confirmed stop clears it', async () => {
  let fails = true;
  const game = fixture({ stop: async () => { if (fails) throw new Error('access denied'); return true; } });
  await game.start(7);
  await assert.rejects(game.stop(7), /access denied/);
  assert.equal(game.state(), 'running');
  fails = false;
  await game.stop(7);
  assert.equal(game.state(), 'idle');
});
