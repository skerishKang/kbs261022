import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const read = (rel) => readFileSync(join(SITE, rel), 'utf8');

test('sync.html loads shared auth helper and sync admin script', () => {
  const html = read('sync.html');
  assert.match(html, /cgi-auth\.js\?v=/);
  assert.match(html, /cgi-sync-admin\.js\?v=/);
  assert.match(html, /id="authBox"/);
  assert.match(html, /id="syncTableBox"/);
  assert.match(html, /id="syncRetryBtn"/);
});
