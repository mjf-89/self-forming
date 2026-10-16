// Test support for the supervised-server fixes (verified stop of the whole process tree,
// the sf-secrets helper). Everything here is local and fake: a loopback HTTP server that
// speaks the SecretBroker.kt protocol with DUMMY values, temporary directories and private
// tmux socket names (never "sf-servers"). No real secret broker, keystore or server is used.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomBytes } from 'node:crypto';

export const DUMMY_TOKEN = 'f'.repeat(16) + randomBytes(8).toString('hex'); // fake broker token, not a real one

/**
 * A fake secret broker: GET /v1/env?label=&wait= with "Authorization: Bearer <token>" ->
 * 200 {"values":{...},"denied":[...],"locked":[...]} (SecretBroker.kt). `answer` may be
 * replaced per test: {status, values, denied, locked, raw}. Requests are recorded
 * (path, query, authorization matched, user agent), never their header values.
 */
export async function startFakeBroker({ token = DUMMY_TOKEN, answer = {} } = {}) {
  const state = { answer: { status: 200, values: {}, denied: [], locked: [], ...answer }, requests: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const authorized = request.headers.authorization === `Bearer ${token}`;
    state.requests.push({ method: request.method, path: url.pathname, label: url.searchParams.get('label'), wait: url.searchParams.get('wait'), authorized });
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (!authorized) return send(401, { error: 'unauthorized' });
    if (request.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname !== '/v1/env') return send(404, { error: 'not found' });
    const { status, values, denied, locked, raw } = state.answer;
    if (raw !== undefined) return send(status, raw);
    if (status !== 200) return send(status, { error: 'refused' });
    send(200, { values, denied, locked });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A loopback port nobody listens on right now. */
export async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Runs a shell command; resolves {code, stdout, stderr}. env replaces the environment (default: baseEnv(), so
 * nothing the test runner inherited, such as a real SF_SECRETS_TOKEN, ever reaches a test process).
 */
export function run(command, { env = baseEnv(), cwd, input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${command.slice(0, 80)}`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}

/** A minimal environment for the helper: PATH only, plus what the test adds. */
export const baseEnv = (extra = {}) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', ...extra });

/**
 * An execution environment over real /bin/bash (as NativeExecutionEnv runs commands),
 * for the real-process stop test. Commands are recorded.
 */
export function realEnv(cwd) {
  const commands = [];
  return {
    cwd, commands,
    async exec(command, options = {}) {
      commands.push(command);
      return new Promise((resolve) => {
        const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...baseEnv(), ...options.env ?? {} }, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), (options.timeout ?? 30) * 1000);
        const forward = (chunk) => options.onOutput?.(String(chunk));
        child.stdout.on('data', forward);
        child.stderr.on('data', forward);
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: true, value: { exitCode: code ?? -1 } }); });
        child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: { code: 'exec_failed', message: error.message } }); });
      });
    }
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
