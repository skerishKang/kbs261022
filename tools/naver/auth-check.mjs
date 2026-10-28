#!/usr/bin/env node
// M1 — auth self-test CLI. Proves the LOCAL Node primitive can produce the
// vendor-recipe signature WITHOUT touching the network and WITHOUT real
// credentials: it uses a vendor-shaped ($2a$...) stand-in secret.
//
//   node tools/naver/auth-check.mjs --selftest
//
// A REAL token check (실제 토큰 발급) is out of scope for M1 and is refused
// here by construction — even with credentials in the environment. The live
// path unlocks only in a later milestone, behind NCOM_MODE=live +
// NCOM_LIVE_WRITE=YES + operator-supplied app credentials.

import process from 'node:process';
import { selfTestSignature } from './ncommerce-auth-local.mjs';

const args = process.argv.slice(2);

if (args.includes('--selftest')) {
  const result = await selfTestSignature();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (args.includes('--live-token')) {
  console.error('refused: 실제 토큰 발급은 이 레인(M1)에서 금지되어 있다. M0 인증키와 별도 승인 후 다음 단계에서 수행한다.');
  process.exit(2);
}

console.log('usage: node tools/naver/auth-check.mjs --selftest');
console.log('       (--live-token 은 M1 범위 밖 — 거부됨)');
process.exit(2);
