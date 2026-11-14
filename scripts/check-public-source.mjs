import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicPolicy = 'supabase/functions/_shared/legal-policy.json';
const privateTests = new Set(["tests/account-deletion-atomic.test.mjs", "tests/friend-library-backend.test.mjs", "tests/friends-admin-entrypoint.test.mjs", "tests/friends-admin-reports.test.mjs", "tests/friends-admin.test.mjs", "tests/friends-backend.test.mjs", "tests/friends-cover-upgrade.test.mjs", "tests/friends-delete-account.test.mjs", "tests/friends-experience.test.mjs", "tests/friends-gateway.test.mjs", "tests/friends-moderation-hardening.test.mjs", "tests/friends-no-cover-review.test.mjs", "tests/friends-register.test.mjs", "tests/friends-registration-ip.test.mjs", "tests/friends-review-html.test.mjs", "tests/helpers/friends-db.mjs", "tests/hk-auth-migration.test.mjs"]);

export function isPrivatePath(raw) {
  const name = raw.replaceAll('\\', '/').replace(/^\.\//, '');
  if (name === publicPolicy) return false;
  return /^(?:server|cloudflare|supabase|maintenance|_backups|_verify)\//.test(name)
    || /^docs\/(?:superpowers|changes)\//.test(name)
    || name === 'scripts/friends-admin.mjs' || name === 'docs/legal/maintainer-assessment.md'
    || privateTests.has(name)
    || /(?:^|\/)\.env(?:$|\.)/.test(name)
    || /\.(?:pem|key|pfx|p12|dpapi|db|sqlite|sqlite3|bundle|dump)(?:$|\.)/i.test(name);
}

export function sensitiveKinds(text) {
  const patterns = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
    ['service secret', /sb_secret_[A-Za-z0-9_-]{15,}/],
    ['provider secret', /(?:sk-proj-|sk-ant-|sk-)[A-Za-z0-9_-]{25,}/],
    ['cloud credential', /AKIA[A-Z0-9]{16}/],
    ['private maintenance path', /(?:[\\/]server-access[\\/]|[\\/]hk-migration-[0-9]+|KoiPage[\\/]signing|SSH\s+ProxyCommand)/i],
  ];
  const found = patterns.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  for (const token of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try {
      if (JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).role === 'service_role') found.push('service-role JWT');
    } catch { /* A malformed token is not a usable JWT. */ }
  }
  return [...new Set(found)];
}

export function checkPublicSource() {
  const tracked = execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
  const failures = [];
  for (const name of tracked) {
    if (isPrivatePath(name)) failures.push(`${name}: private file`);
    const bytes = readFileSync(path.join(root, name));
    if (!bytes.includes(0)) {
      for (const kind of sensitiveKinds(bytes.toString('utf8'))) failures.push(`${name}: ${kind}`);
    }
  }
  if (failures.length) throw new Error(`Public source check failed (values withheld):\n${failures.join('\n')}`);
  console.log(`Public source boundary: ${tracked.length} tracked files checked.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkPublicSource();
