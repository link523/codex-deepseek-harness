import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export { appCandidates, locateApp } from '../plugins/deepseek-harness/server/desktop.mjs';

export async function inspectProfile(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  try { return JSON.parse(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')); }
  catch { throw new Error('Desktop profile not initialized. Open DeepSeek Harness once, finish setup, then quit the App before installation.'); }
}
