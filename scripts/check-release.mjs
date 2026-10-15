import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const rustVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== config.version || pkg.version !== rustVersion) throw new Error('package.json, tauri.conf.json and Cargo.toml versions must agree.');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Use a stable x.y.z release version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${pkg.version}`) throw new Error('Release tag must match the application version.');
if (config.identifier !== 'com.galgame.manager') throw new Error('Keep the existing storage identifier.');
if (config.bundle.windows.wix.upgradeCode !== '6DEDB5F6-B6AD-591D-9E2F-6A962908D12D') throw new Error('Keep the existing MSI upgrade code.');
if (config.bundle.createUpdaterArtifacts !== true) throw new Error('Updater signatures must be enabled.');
const updater = config.plugins?.updater;
if (updater?.endpoints?.[0] !== 'https://github.com/morilove37/KoiPage/releases/latest/download/latest.json') throw new Error('Unexpected update endpoint.');
if (!Buffer.from(updater.pubkey ?? '', 'base64').toString('utf8').startsWith('untrusted comment: minisign public key:')) throw new Error('A valid updater public key is required.');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
if (!changelog.includes(`## [${pkg.version}]`)) throw new Error('Add the current version to CHANGELOG.md.');
readFileSync(new URL(`../docs/releases/v${pkg.version}.md`, import.meta.url), 'utf8');
console.log(`Release v${pkg.version}: versions, storage IDs, update endpoint, public key and release notes agree.`);
