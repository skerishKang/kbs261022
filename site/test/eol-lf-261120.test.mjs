// 줄바꿈 고정 시험: Windows(core.autocrlf=true)로 받은 사본에서도 텍스트 파일이 LF 로 나오게
// .gitattributes 가 `* text=auto eol=lf` 를 가진다. 데이터·증빙 폴더(-text)는 바이트를 그대로 둔다.
//
//   node --test site/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
const lines = attrs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('.gitattributes: 텍스트는 LF, 데이터·증빙 폴더는 변환하지 않는다', () => {
  const all = lines.indexOf('* text=auto eol=lf');
  assert.ok(all >= 0, '* text=auto eol=lf 가 없다');
  // 뒤에 오는 규칙이 이긴다 — 예외(-text)는 전체 규칙보다 뒤에 있어야 한다.
  for (const rule of ['data/** -text', 'reports/** -text']) {
    const at = lines.indexOf(rule);
    assert.ok(at > all, `${rule} 가 없거나 전체 규칙보다 앞에 있다`);
  }
  for (const ext of ['png', 'jpg', 'xlsx', 'pdf']) {
    assert.ok(lines.includes(`*.${ext} binary`), `*.${ext} binary 가 없다`);
  }
});

test('사이트 화면 파일(CSS·JS·HTML)은 LF 로 받는다', () => {
  const files = ['site/assets/css/cgi-catalog.css', 'site/assets/js/cgi-catalog.js', 'site/index.html'];
  for (const f of files) {
    const negated = lines.some((l) => l.endsWith(' -text') && (l.startsWith(f + ' ') || l.startsWith('site/**')));
    assert.ok(!negated, `${f} 가 변환 예외로 빠져 있다`);
  }
});
