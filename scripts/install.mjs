import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { locateApp, inspectProfile } from './platform.mjs';
import { BridgeClient } from '../plugins/deepseek-harness/server/client.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const pluginRoot = join(projectRoot, 'plugins', 'deepseek-harness');

async function run(command, args, options = {}) {
  return await new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`Command failed (exit ${code})`)));
  });
}

export async function addMarketplace(home, source) {
  const file = join(home, '.agents', 'plugins', 'marketplace.json');
  let market;
  let existing = false;
  try { market = JSON.parse(await readFile(file, 'utf8')); existing = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  market ??= { name: 'personal-local', interface: { displayName: 'Personal Local' }, plugins: [] };
  if (!Array.isArray(market.plugins)) throw new Error('Existing personal marketplace has no plugins array; refusing to overwrite it');
  const rel = relative(home, source).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../') || /^[A-Za-z]:/.test(rel)) throw new Error('Personal marketplace plugin must be inside your home directory');
  const entry = {
    name: 'deepseek-harness', source: { source: 'local', path: `./${rel}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools',
  };
  const index = market.plugins.findIndex(item => item.name === entry.name);
  if (index < 0) market.plugins.push(entry);
  else market.plugins[index] = { ...market.plugins[index], ...entry };
  await mkdir(dirname(file), { recursive: true });
  if (existing) await copyFile(file, `${file}.backup-${Date.now()}-${randomUUID().slice(0, 6)}`);
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(market, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
  return file;
}

async function doctor() {
  const report = { node: process.version, platform: process.platform };
  try { report.app = (await locateApp()).app; }
  catch (error) { report.appError = error.message; }
  try { const profile = await inspectProfile(); report.companionInstalled = Boolean(profile.dependencies?.['dsh-codex-bridge']); }
  catch (error) { report.profileError = error.message; }
  try { report.bridge = await new BridgeClient({ autoLaunch: false }).call('health', {}, { timeoutMs: 2000 }); }
  catch (error) { report.bridgeError = error.message; }
  console.log(JSON.stringify(report, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  const flags = new Set(args);
  const allowed = new Set(['--all', '--codex', '--deepseek', '--doctor', '--dry-run', '--help']);
  for (const flag of flags) if (!allowed.has(flag)) throw new Error(`Unknown option ${flag}`);
  if (flags.has('--help') || !args.length) {
    console.log('node scripts/install.mjs --all | --codex | --deepseek | --doctor [--dry-run]\n--deepseek requires DeepSeek Harness to be fully quit. --all installs both halves.');
    return;
  }
  if (flags.has('--doctor')) return await doctor();
  const actions = [];
  if (flags.has('--all') || flags.has('--deepseek')) {
    const app = await locateApp(); await inspectProfile();
    // No shell: paths containing spaces or metacharacters stay literal on both platforms.
    const cliArgs = ['--expose-internals', app.cli, 'plugin', '--profile', 'desktop', 'add', `file:${join(pluginRoot, 'bridge')}`, '--offline'];
    actions.push({ action: 'Install DeepSeek companion using the App-owned package manager', executable: app.executable, args: cliArgs });
    if (!flags.has('--dry-run')) await run(app.executable, cliArgs, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  }
  if (flags.has('--all') || flags.has('--codex')) {
    actions.push({ action: 'Add personal Codex marketplace entry', plugin: pluginRoot });
    if (!flags.has('--dry-run')) await addMarketplace(homedir(), pluginRoot);
  }
  console.log(JSON.stringify({ dryRun: flags.has('--dry-run'), actions }, null, 2));
  if (!flags.has('--dry-run')) console.log('Open DeepSeek Harness. Restart Codex, then install DeepSeek Harness from your personal local plugin source. Review and trust its sync hook to enable automatic next-prompt sync.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
