import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logValue, trackedCommand } from '../src/lib/log-model.ts';

test('log formatting preserves useful error details and hides nested secrets', () => {
  const value = { provider: 'vndb', apiKey: 'do-not-export', authorization: 'Bearer do-not-export', nested: { access_token: 'do-not-export' } };
  const result = logValue(value);
  assert.ok(result.includes('vndb'));
  assert.ok(!result.includes('do-not-export'));
  assert.ok(logValue(new Error('connection failed')).includes('connection failed'));
});
test('circular and oversized console values cannot break log capture', () => {
  const value = { message: 'test' }; value.self = value;
  assert.ok(logValue(value).includes('test'));
  assert.ok(logValue('x'.repeat(20000)).length <= 8192);
});
test('record operation summaries while excluding polling and logging IPC', () => {
  for (const command of ['metadata_search','metadata_detail','scan_directory','launch_game','stop_game','import_games','export_games','backup_database','archive_extract']) assert.equal(trackedCommand(command),true);
  for (const command of ['settings_get','game_running','games_list','logs_write','logs_info','logs_export']) assert.equal(trackedCommand(command),false);
});
