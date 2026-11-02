import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSessionAdapter, BridgeError } from './session-adapter.mjs';
import { createMirrorWatcher } from './mirror.mjs';

export const name = 'dsh-codex-bridge';
export const inject = ['sessionController', 'sessions', 'sessionQuery', 'sessionProjections', 'agents', 'workspaceRegistry'];
export const discoveryPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-bridge', 'connection.json');

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new BridgeError('BODY_TOO_LARGE', 'Request exceeds 1 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_JSON', 'Expected a JSON request'); }
}
const reply = (res, status, value) => {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};

export async function startBridge(adapter, options = {}) {
  const file = options.file ?? discoveryPath();
  const token = randomBytes(32).toString('hex');
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    const controller = new AbortController(); controllers.add(controller);
    res.on('close', () => { controller.abort(); controllers.delete(controller); });
    try {
      const authority = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== authority || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
        return reply(res, 403, { error: { code: 'BROWSER_FORBIDDEN', message: 'Only authenticated local native clients are allowed' } });
      }
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return reply(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid local bridge credential' } });
      }
      if (req.method !== 'POST' || req.url !== '/v1/call') return reply(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        return reply(res, 415, { error: { code: 'CONTENT_TYPE', message: 'Use application/json' } });
      }
      const body = await readBody(req);
      if (!body || typeof body.method !== 'string') throw new BridgeError('INVALID_ARGUMENT', 'A method is required');
      const result = await adapter.call(body.method, body.args, controller.signal);
      reply(res, 200, { result });
    } catch (error) {
      reply(res, error.code === 'BODY_TOO_LARGE' ? 413 : error instanceof BridgeError ? 400 : 500,
        { error: { code: error.code ?? 'DSH_ERROR', message: error.message ?? 'DeepSeek operation failed' } });
    } finally { controllers.delete(controller); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 0;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const connection = { protocol: 1, host: '127.0.0.1', port: server.address().port, token, pid: process.pid, startedAt: new Date().toISOString() };
  try {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(connection), { mode: 0o600, flag: 'wx' });
    try { await rename(temp, file); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } catch (error) {
    await new Promise(done => server.close(done));
    throw error;
  }
  let closed = false;
  return {
    connection,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      const stopped = new Promise(done => server.close(done));
      server.closeAllConnections();
      await stopped;
      try {
        if (JSON.parse(await readFile(file, 'utf8')).token === token) await unlink(file);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

export function apply(ctx) {
  let disposed = false;
  let bridge;
  let mirror;
  const started = (async () => {
    try {
      const adapter = createSessionAdapter(ctx);
      bridge = await startBridge(adapter);
      if (disposed) await bridge.close();
      else {
        // Tails linked Codex transcripts and appends their messages to open
        // DeepSeek conversations, so both sides keep the same records.
        mirror = createMirrorWatcher(adapter, { ctx, logger: ctx.logger });
        mirror.start();
        ctx.logger.info('Codex bridge is ready on the local machine');
      }
    } catch (error) {
      // An optional integration must not prevent the desktop app from opening.
      ctx.logger.warn(`Codex bridge could not start: ${error.message}`);
    }
  })();
  ctx.effect(() => async () => { disposed = true; mirror?.stop(); await started; await bridge?.close(); }, 'codex-bridge');
}
