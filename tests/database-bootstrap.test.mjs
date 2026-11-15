import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapDatabase } from '../src/lib/database-bootstrap.ts';

test('selected database initialization reuses its native logical pool without SQL plugin load', async () => {
  let legacy = 0;
  const db = await bootstrapDatabase(async () => {}, () => ({ path: 'sqlite:galgame.db' }), async () => { legacy++; return {}; });
  assert.equal(db.path, 'sqlite:galgame.db'); assert.equal(legacy, 0);
});

test('only an older executable missing the native bootstrap command uses legacy load', async () => {
  let legacy = 0;
  assert.equal(await bootstrapDatabase(async () => { throw 'Command initialize_database not found'; }, () => 'selected', async () => { legacy++; return 'legacy'; }), 'legacy');
  assert.equal(legacy, 1);
});

test('missing custom drive, corrupt database, checksum and pending restart errors never open the default database', async () => {
  for (const reason of ['custom database not found', 'migration checksum mismatch', 'database disk image is malformed', 'pending restart required', 'Command another_command not found']) {
    let legacy = 0;
    await assert.rejects(bootstrapDatabase(async () => { throw new Error(reason); }, () => 'selected', async () => { legacy++; return 'legacy'; }), { message: reason });
    assert.equal(legacy, 0);
  }
});
