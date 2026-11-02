import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchDesktop } from './desktop.mjs';

export const bridgeDirectory = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-bridge');
export const stateDirectory = () => process.env.DSH_CODEX_DATA_DIR || bridgeDirectory();

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const launchable = error => error.code === 'BRIDGE_UNAVAILABLE' || (error.code === 'BRIDGE_UNREACHABLE' && error.connectionRefused);
function abortFailure(signal, message) {
  return failure(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED', message);
}
function withSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); done(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export class BridgeClient {
  constructor(options = {}) {
    this.file = options.file ?? process.env.DSH_CODEX_CONNECTION_FILE ?? join(bridgeDirectory(), 'connection.json');
    this.autoLaunch = options.autoLaunch ?? true;
    this.launch = options.launch ?? launchDesktop;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }
  async call(method, args = {}, { signal, timeoutMs = 45000 } = {}) {
    if (!this.autoLaunch) return await this.request(method, args, { signal, timeoutMs });
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let health;
    try {
      lifetime.throwIfAborted();
      health = await this.ready(lifetime);
      lifetime.throwIfAborted();
    } catch (error) {
      if (lifetime.aborted) throw abortFailure(lifetime, 'DeepSeek startup check was cancelled or timed out; the requested operation was not sent.');
      throw error;
    }
    if (method === 'health') return health;
    const remaining = Math.max(1, deadline - Date.now());
    // Fit a cold-start wait inside the caller's overall budget, returning a
    // normal wait timeout rather than losing the response to a transport timeout.
    if (method === 'wait') args = { ...args, timeoutMs: Math.min(args.timeoutMs ?? 50000, Math.max(0, remaining - 1000)) };
    // Send mutations exactly once, after readiness. Never replay an uncertain send/create.
    return await this.request(method, args, { signal: lifetime, timeoutMs: remaining });
  }
  async ready(signal) {
    try { return await this.request('health', {}, { signal, timeoutMs: 1500 }); }
    catch (error) { if (!launchable(error)) throw error; }
    signal.throwIfAborted();
    if (!this.starting) this.starting = this.startDesktop().finally(() => { this.starting = undefined; });
    return await withSignal(this.starting, signal);
  }
  async startDesktop() {
    const signal = AbortSignal.timeout(this.startupTimeoutMs);
    try {
      try { await this.launch({ signal }); }
      catch (error) { throw failure('LAUNCH_FAILED', `Could not open DeepSeek Harness: ${error.message}`); }
      for (;;) {
        signal.throwIfAborted();
        try { return await this.request('health', {}, { signal, timeoutMs: 1000 }); }
        catch (error) { if (!launchable(error)) throw error; }
        await delay(this.pollIntervalMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw failure('STARTUP_TIMEOUT', 'DeepSeek Harness was opened but its bridge did not become ready within the startup timeout. Check first-run setup and the dsh-codex-bridge extension; run the installer --doctor. The requested operation was not sent.');
      throw error;
    }
  }
  async request(method, args = {}, { signal, timeoutMs = 15000 } = {}) {
    let connection;
    let source;
    try { source = await readFile(this.file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw failure('BRIDGE_UNAVAILABLE', 'DeepSeek bridge unavailable. Open DeepSeek Harness with dsh-codex-bridge installed; run the installer --doctor.');
      throw failure('CONNECTION_READ_FAILED', 'Cannot read the local bridge discovery file');
    }
    try { connection = JSON.parse(source); }
    catch { throw failure('INVALID_CONNECTION', 'Invalid local bridge discovery file'); }
    if (!connection || connection.protocol !== 1 || connection.host !== '127.0.0.1' || !Number.isInteger(connection.port)
      || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) {
      throw failure('INVALID_CONNECTION', 'Invalid local bridge discovery file');
    }
    // Use a literal loopback address, refuse redirects and never pass a credential to another host.
    const lifetime = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response, body;
    try {
      response = await fetch(`http://127.0.0.1:${connection.port}/v1/call`, {
        method: 'POST', redirect: 'error', signal: lifetime,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ method, args }),
      });
      body = await response.json();
    } catch (error) {
      const retry = method === 'send' ? ' The send outcome is unknown; retry only with the same requestId.' : '';
      if (signal?.aborted) throw abortFailure(signal, `DeepSeek bridge request was cancelled or timed out; this does not cancel the App task.${retry}`);
      if (lifetime.aborted) throw failure('TIMEOUT', `DeepSeek bridge request timed out; the App task may still be running.${retry}`);
      if (response) throw failure('INVALID_RESPONSE', `DeepSeek bridge returned invalid JSON (HTTP ${response.status}).${retry}`);
      throw Object.assign(failure('BRIDGE_UNREACHABLE', `Cannot reach DeepSeek Harness. Reopen the app and run --doctor.${retry}`),
        { connectionRefused: error.cause?.code === 'ECONNREFUSED' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (!('result' in body) && !body.error)) {
      throw failure('INVALID_RESPONSE', 'DeepSeek bridge returned an invalid response envelope');
    }
    if (!response.ok || body.error) {
      const error = new Error(body.error?.message ?? `Bridge returned HTTP ${response.status}`);
      error.code = body.error?.code;
      throw error;
    }
    return body.result;
  }
}
