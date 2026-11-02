import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { spawn } from 'node:child_process';

const exists = async path => { try { await access(path); return true; } catch { return false; } };
export function appCandidates(platform = process.platform, env = process.env, home = homedir()) {
  const paths = platform === 'win32' ? win32 : posix;
  if (env.DSH_DESKTOP_PATH) return [env.DSH_DESKTOP_PATH];
  if (platform === 'win32') return [...new Set([
    paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    paths.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    paths.join(env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ])];
  if (platform === 'darwin') return [
    '/Applications/DeepSeek Harness.app', paths.join(home, 'Applications', 'DeepSeek Harness.app'),
  ];
  throw new Error('This package targets Windows and macOS');
}

export async function locateApp() {
  for (const candidate of appCandidates()) {
    if (!(await exists(candidate))) continue;
    const resources = process.platform === 'darwin' ? join(candidate, 'Contents', 'Resources') : join(candidate, '..', 'resources');
    const executable = process.platform === 'darwin' ? join(candidate, 'Contents', 'MacOS', 'DeepSeek Harness') : candidate;
    const cli = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    if (await exists(join(resources, 'app.asar'))) return { app: candidate, executable, cli };
  }
  throw new Error('DeepSeek Harness desktop app not found. Set DSH_DESKTOP_PATH to its .exe (Windows) or .app (macOS).');
}

export function launchSpec(app, platform = process.platform) {
  if (platform === 'darwin') return { command: '/usr/bin/open', args: ['-a', app], detached: false };
  if (platform === 'win32') return { command: app, args: [], detached: true };
  throw new Error('Automatic desktop launch supports Windows and macOS');
}

export async function launchDesktop({ signal } = {}) {
  signal?.throwIfAborted();
  const { app } = await locateApp();
  signal?.throwIfAborted();
  const spec = launchSpec(app);
  const env = { ...process.env };
  // An Electron-based host may export this for CLI execution. The GUI needs it absent.
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(spec.command, spec.args, { shell: false, stdio: 'ignore', windowsHide: true,
      detached: spec.detached, env, ...(spec.detached ? {} : { signal }) });
    child.once('error', reject);
    if (spec.detached) child.once('spawn', () => { child.unref(); done(); });
    else child.once('close', code => code === 0 ? done() : reject(new Error(`Desktop launcher exited with code ${code}`)));
  });
}
