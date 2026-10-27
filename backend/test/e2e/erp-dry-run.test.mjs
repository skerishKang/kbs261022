// The dry-run entry point is tested from the outside: spawned as a real process
// with no env of its own, asserting the exit code and the measured lines it
// prints. Importing the modules proves less than this — a module that is only
// reachable from tests is not wired into anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/erp-naver-dry-run.mjs');

async function cli(args, env = {}) {
  const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
    env: { ...process.env, ERP_MODE: '', NCOM_MODE: '', ERP_LIVE_WRITE: '', NCOM_LIVE_WRITE: '', ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr: stderr || '' };
}

test('plan-only dry run exits 0, reads the committed catalogue and transmits nothing', async () => {
  const { stdout, stderr } = await cli(['--rows', '8']);
  assert.equal(stderr, '');
  assert.match(stdout, /ERP=disabled NCOM=disabled transmitted=false/);
  assert.match(stdout, /rows=4575 .*erp_code_verified=0/);
  assert.match(stdout, /registerable_now=0 of 4575/);
  assert.match(stdout, /nothing was transmitted/);
  assert.doesNotMatch(stdout, /live/i, 'a plan-only run must not even name the live path as active');
  assert.ok(stdout.split('\n').length > 15, 'the report covers catalogue, product, customer, slip, stock and naver stages');
});

test('--mock drives both loopback transports and still transmits nothing real', async () => {
  const { stdout } = await cli(['--rows', '8', '--mock']);
  assert.match(stdout, /erp\.bootstrap: zone=\w+ session_present=true/);
  assert.match(stdout, /erp\.SaveBasicProduct: ok=true sent=3 rows=3/);
  assert.match(stdout, /BAL_QTY -> stock, today: updates=0 rejected=1 reasons=\{"no_naver_channel_product":1\}/);
  assert.match(stdout, /if an item id existed: updates=1 endpoints=\["productModifyOrigin"\]/);
  assert.match(stdout, /transmitted=false/);
  assert.match(stdout, /mock calls seen: erp=4 ncom=2/);
});

test('the entry point refuses to run when a live mode is exported', async () => {
  await assert.rejects(cli([], { ERP_MODE: 'live', ERP_LIVE_WRITE: 'YES' }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /dry-run only/);
    return true;
  });
});
