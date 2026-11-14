import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPrivatePath, sensitiveKinds} from '../scripts/check-public-source.mjs';

test('production services, maintenance files and backend tests cannot enter public source', () => {
  for (const name of ['server/service/config.json', 'cloudflare/worker.mjs', 'supabase/migrations/schema.sql',
    'scripts/friends-admin.mjs', 'tests/friends-backend.test.mjs', 'docs/changes/internal.md',
    'docs/superpowers/plans/internal.md', '.env', 'nested/.env.production', 'keys/private.pem', 'history.bundle']) {
    assert.equal(isPrivatePath(name), true, name);
  }
});

test('the client, legal disclosures and public policy remain distributable', () => {
  for (const name of ['src/App.tsx', 'src-tauri/src/friends/client.rs', 'src-tauri/Cargo.lock',
    'docs/legal/privacy-policy.md', 'supabase/functions/_shared/legal-policy.json']) {
    assert.equal(isPrivatePath(name), false, name);
  }
  assert.deepEqual(sensitiveKinds('sb_publishable_example and a normal HTTPS API endpoint'), []);
});

test('secret detection withholds values and recognizes privileged tokens', () => {
  const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----';
  const secret = 'sb_' + 'secret_' + 'a'.repeat(30);
  const payload = Buffer.from(JSON.stringify({role: 'service_role'})).toString('base64url');
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', payload, 'a'.repeat(32)].join('.');
  assert.deepEqual(sensitiveKinds(privateKey), ['private key']);
  assert.deepEqual(sensitiveKinds(secret), ['service secret']);
  assert.deepEqual(sensitiveKinds(jwt), ['service-role JWT']);
  assert(!sensitiveKinds(secret).join('').includes(secret));
});
