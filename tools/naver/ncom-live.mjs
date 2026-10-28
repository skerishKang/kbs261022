#!/usr/bin/env node
// L1 — 네이버 커머스API 라이브 실행 경로 CLI (CGI-1 LOCAL2 운영 레인).
//
//   node tools/naver/ncom-live.mjs token                 # 라이브 토큰 발급 점검(값 미출력)
//   node tools/naver/ncom-live.mjs categories            # GET /v1/categories 코퍼스 수집(live)
//   node tools/naver/ncom-live.mjs mapping --corpus <f>  # 153경로 매핑(기존 도구 위임)
//   node tools/naver/ncom-live.mjs upload   --execute    # 파일럿 이미지 업로드(live, 쓰기 게이트)
//   node tools/naver/ncom-live.mjs dupcheck              # 판매자관리코드 중복조회(read)
//   node tools/naver/ncom-live.mjs build    [flags]      # 등록 요청 본문 조립·검증(전송 0건)
//   node tools/naver/ncom-live.mjs register --execute --i-confirm-register [flags]
//   node tools/naver/ncom-live.mjs status                # 장부·라이브 산출물 요약
//
// 자격증명은 환경 변수만(NCOM_CLIENT_ID / NCOM_CLIENT_SECRET). --env-file(기본
// ~/.config/cgi-erp/ncom.env)은 KEY=VALUE 를 읽어 '비어 있는' 환경 변수만 채운다.
// 값은 절대 출력되지 않는다 — 출력되는 것은 키 이름뿐이다.
//
// 게이트(backend/lib/ncom-live-pipeline.mjs evaluateLiveGates):
//   읽기(token/categories/dupcheck) : NCOM_MODE=live + 자격증명
//   쓰기(upload)                    : 위 + NCOM_LIVE_WRITE=YES + --execute
//   등록(register)                  : 위 + --i-confirm-register
//   판매노출 ON                     : --display-status ON --sell-ack (고객 판매개시 결정 ack)
//
// 이 도구는 mock 모드를 거부한다 — mock 검증은 기존 레인(계약 테스트)이 담당하고,
// 여기는 라이브 실행 결과만 남긴다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseCsv } from '../../backend/lib/product-mapping.mjs';
import { mapSupplierStock, planPilotRegister, ledgerEntriesFromRegisterRun, mergeRegistrationLedger, runPilotDuplicateCheck, runPilotImageUpload, runPilotRegister, evaluateLiveGates, LIVE_LANE_DOC } from '../../backend/lib/ncom-live-pipeline.mjs';
import { imagesFromLedger } from '../../backend/lib/image-upload-runner.mjs';
import { createLocalNcomAuth } from './ncommerce-auth-local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const step = argv[0];
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const LIVE_DIR = 'reports/data/registration/live';
const LEDGER_REL = 'reports/data/registration/ncom_registration_ledger.json';
const PKG_REL = 'reports/data/registration/m2b_pilot_packages.json';
const MASTER_REL = 'data/full_catalog/product_db_compact.csv';
const die = (message, code = 2) => { console.error(`refused: ${message}`); process.exit(code); };

/** KEY=VALUE 행을 읽어 '비어 있는' 환경 변수만 채운다. 값은 출력하지 않는다. */
function loadEnvFile(rel) {
  const full = rel.startsWith('~') ? path.join(os.homedir(), rel.slice(1)) : path.resolve(ROOT, rel);
  if (!fs.existsSync(full)) return { loaded: false, keys: [], path: full };
  const keys = [];
  for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (process.env[key] === undefined || String(process.env[key]).trim() === '') {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys, path: full };
}

function loadPackages() {
  const packages = JSON.parse(fs.readFileSync(path.join(ROOT, PKG_REL), 'utf8')).packages;
  if (!Array.isArray(packages) || packages.length !== 3) die(`${PKG_REL} 파일럿 패키지는 3건이어야 한다`);
  return packages;
}

/** product_db_compact 에서 cgiId(samamusic.co.kr:1769)의 availability·수집시각을 찾는다. */
function findAvailability(cgiId) {
  const [site, id] = String(cgiId).split(':');
  if (!site || !id) die(`cgiId 형태를 읽을 수 없다: ${cgiId}`);
  const rows = parseCsv(fs.readFileSync(path.join(ROOT, MASTER_REL), 'utf8'));
  const row = rows.find((r) => String(r.source_site ?? '').trim() === site.trim() && String(r.source_product_id ?? '').trim() === id.trim());
  if (!row) return { availability: null, collectedAt: null, found: false };
  return { availability: row.availability ?? null, collectedAt: row.collected_at ?? null, found: true };
}

function readJsonMap(rel, label) {
  if (!rel) return new Map();
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(full)) die(`${label} 파일이 없다: ${rel}`);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  return new Map(Object.entries(parsed));
}

function readDetailDir(rel) {
  const map = new Map();
  if (!rel) return map;
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(full)) die(`--detail-dir 디렉터리가 없다: ${rel}`);
  for (const entry of fs.readdirSync(full)) {
    if (!/\.html?$/i.test(entry)) continue;
    const key = entry.replace(/\.html?$/i, '');
    map.set(key, fs.readFileSync(path.join(full, entry), 'utf8'));
  }
  return map;
}

/** 업로드 장부 → 상품별 images 필드(imagesFromLedger 계약 재사용). */
function imagesByCgiIdFromLedger(rel, packages) {
  const map = new Map();
  if (!rel || !fs.existsSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel))) return map;
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const ledger = JSON.parse(fs.readFileSync(full, 'utf8'));
  const entries = Array.isArray(ledger) ? ledger : ledger.ledger;
  if (!Array.isArray(entries)) die(`업로드 장부 형태를 읽을 수 없다: ${rel}`);
  for (const pkg of packages) {
    const own = entries.filter((entry) => entry.cgiId === pkg.cgiId);
    if (!own.length) continue;
    const plan = pkg.images?.upload_plan ?? null;
    if (!plan) continue;
    const images = imagesFromLedger({ ledger: own, plan });
    if (images.uploadedViaImageApi) map.set(pkg.cgiId, images);
  }
  return map;
}

function stockByCgiId(packages, { ack = false } = {}) {
  const map = new Map();
  for (const pkg of packages) {
    const { availability, collectedAt, found } = findAvailability(pkg.cgiId);
    const stock = mapSupplierStock({ availability, collectedAt, allowStale: ack });
    map.set(pkg.cgiId, found ? stock : { ...stock, reason: stock.reason ?? 'source_row_missing' });
  }
  return map;
}

function writeJson(rel, payload) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${JSON.stringify(payload, null, 2)}\n`);
  return full;
}

const printGateRefusal = (refusal) => {
  console.error('live gate refused — 아무것도 전송하지 않았다:');
  for (const reason of refusal.reasons) console.error(`  - ${reason}`);
};

const loadRuntime = async () => {
  const envFile = flag('env-file', path.join('~', '.config', 'cgi-erp', 'ncom.env'));
  const envLoaded = typeof envFile === 'string' ? loadEnvFile(envFile) : { loaded: false, keys: [] };
  if (envLoaded.loaded) console.log(`env-file: ${envLoaded.path} (설정된 키: ${envLoaded.keys.join(', ') || '없음'})`);
  else console.log(`env-file: 없음(${envLoaded.path}) — 환경 변수만 사용`);
  const { runtime, bcrypt } = await createLocalNcomAuth({ env: process.env });
  if (!bcrypt.bcryptHashpw) die(`bcrypt 원시체 미확보 — ${bcrypt.reason}`);
  if (!runtime.available) die('NCOM_CLIENT_ID / NCOM_CLIENT_SECRET 환경 변수가 필요하다(값은 출력되지 않는다)');
  return runtime;
};

const summary = {
  token: async () => {
    const runtime = await loadRuntime();
    if (runtime.mode !== 'live') { printGateRefusal(evaluateLiveGates({ env: process.env, action: 'read', acks: {} })); process.exit(2); }
    try {
      await runtime.token();
      const expiresAt = runtime.tokenExpiresAt();
      console.log(`mode=${runtime.mode} token=issued(값 미출력) expires_at=${new Date(expiresAt).toISOString()} expires_in_s=${Math.max(0, Math.round((expiresAt - Date.now()) / 1000))} naver_requests=${runtime.stats.attempts}`);
      process.exit(0);
    } catch (error) {
      console.error(`token issuance failed: ${error.code ?? 'error'} — ${error.message}`);
      if (error.verdict?.traceId) console.error(`traceId=${error.verdict.traceId}`);
      process.exit(1);
    }
  },

  categories: async () => {
    const runtime = await loadRuntime();
    if (runtime.mode !== 'live') { printGateRefusal(evaluateLiveGates({ env: process.env, action: 'read', acks: {} })); process.exit(2); }
    const outRel = String(flag('corpus-out', 'reports/data/naver/category_corpus_live.json'));
    const result = await runtime.call('categoryList', { query: { last: 'true' } });
    const categories = Array.isArray(result.data) ? result.data : (Array.isArray(result.raw) ? result.raw : null);
    if (!categories) die('응답이 카테고리 목록이 아니다 — 파일을 쓰지 않는다');
    const crypto = await import('node:crypto');
    const canonical = JSON.stringify(categories);
    const corpus = {
      kind: 'cgi-naver-category-corpus',
      source: 'GET /v1/categories?last=true',
      mode: 'live',
      fetched_at: new Date().toISOString(),
      sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
      row_count: categories.length,
      categories,
    };
    const written = writeJson(outRel, corpus);
    console.log(`wrote ${path.relative(ROOT, written)}`);
    console.log(`mode=live rows=${categories.length} sha256=${corpus.sha256.slice(0, 16)}… naver_requests=${runtime.stats.attempts}`);
    console.log(`다음 단계: node backend/tools/naver-category-candidates.mjs --corpus ${outRel}`);
    process.exit(0);
  },

  mapping: async () => {
    const corpusRel = String(flag('corpus', ''));
    if (!corpusRel) die('usage: mapping --corpus <corpus file>');
    const { spawnSync } = await import('node:child_process');
    const args = [path.join(ROOT, 'backend', 'tools', 'naver-category-candidates.mjs'), '--corpus', corpusRel];
    const limit = flag('limit'); if (limit) args.push('--limit', String(limit));
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  },

  upload: async () => {
    const execute = hasFlag('execute');
    const runtime = await loadRuntime();
    const packages = loadPackages();
    const run = await runPilotImageUpload({ runtime, packages, env: process.env, execute });
    if (run.refused) { printGateRefusal(run); process.exit(2); }
    const outRel = String(flag('ledger-out', path.join(LIVE_DIR, 'upload_ledger.json')));
    const written = writeJson(outRel, { kind: 'cgi-ncom-live-upload-ledger', mode: run.mode, ran_at: new Date().toISOString(), ...run });
    console.log(`wrote ${path.relative(ROOT, written)}`);
    for (const batch of run.batches) console.log(`batch ${batch.batch}: ${batch.cgiId} files=${batch.files}`);
    for (const failure of run.failed_batches) console.error(`FAILED: ${failure.cgiId ?? '(no cgiId)'} — ${failure.note}`);
    console.log(`ledger_entries=${run.ledger.length} failed_batches=${run.failed_batches.length} naver_requests=${run.naver_requests} transmitted=${run.transmitted}`);
    process.exit(run.failed_batches.length ? 1 : 0);
  },

  dupcheck: async () => {
    const runtime = await loadRuntime();
    const packages = loadPackages();
    const run = await runPilotDuplicateCheck({ runtime, sellerCodes: packages.map((pkg) => pkg.sellerManagementCode), env: process.env });
    if (run.refused) { printGateRefusal(run); process.exit(2); }
    const outRel = String(flag('out', path.join(LIVE_DIR, 'dupcheck_latest.json')));
    const written = writeJson(outRel, { kind: 'cgi-ncom-live-dupcheck', mode: run.mode, ran_at: new Date().toISOString(), checks: run.checks, naver_requests: run.naver_requests });
    for (const check of run.checks) console.log(`${check.sellerManagementCode}: ${check.existing ? `EXISTING originProductNo=${check.originProductNo}` : 'no existing product'}`);
    console.log(`wrote ${path.relative(ROOT, written)} naver_requests=${run.naver_requests}`);
    process.exit(0);
  },

  build: async () => {
    const packages = loadPackages();
    const stockAck = hasFlag('stock-ack');
    const displayStatus = String(flag('display-status', 'SUSPENSION')).toUpperCase();
    const plan = planPilotRegister({
      packages,
      imagesByCgiId: imagesByCgiIdFromLedger(String(flag('upload-ledger', path.join(LIVE_DIR, 'upload_ledger.json'))), packages),
      leafByCgiId: readJsonMap(flag('category-file'), '--category-file'),
      detailByCgiId: readDetailDir(flag('detail-dir')),
      stockByCgiId: stockByCgiId(packages, { ack: stockAck }),
      deliveryByCgiId: readJsonMap(flag('policy-file'), '--policy-file (deliveryInfo)'),
      displayStatus,
      sellAck: hasFlag('sell-ack'),
    });
    const outRel = String(flag('out', path.join(LIVE_DIR, 'pilot_register_request.json')));
    const written = writeJson(outRel, {
      kind: 'cgi-ncom-live-register-request',
      built_at: new Date().toISOString(),
      displayStatus: plan.displayStatus,
      counts: plan.counts,
      rows: plan.rows.map((row) => ({
        cgiId: row.cgiId, sellerManagementCode: row.sellerManagementCode, productName: row.productName,
        displayStatus: row.displayStatus, body: row.body, problems: row.problems, pending: row.pending,
        stock: row.stock, registerable: row.registerable,
      })),
    });
    console.log(`wrote ${path.relative(ROOT, written)}`);
    for (const row of plan.rows) {
      console.log(`${row.sellerManagementCode}: registerable=${row.registerable} problems=${row.problems.length} pending=${row.pending.length} display=${row.displayStatus}`);
      for (const item of [...row.problems.map((p) => ({ field: p.field, note: p.reason })), ...row.pending]) console.log(`  - ${item.field}: ${item.note ?? ''}`);
    }
    console.log(`registerable ${plan.counts.registerable}/${plan.counts.products}`);
    process.exit(0);
  },

  register: async () => {
    const execute = hasFlag('execute');
    const confirmRegister = hasFlag('i-confirm-register');
    const runtime = await loadRuntime();
    const packages = loadPackages();
    const stockAck = hasFlag('stock-ack');
    const displayStatus = String(flag('display-status', 'SUSPENSION')).toUpperCase();
    let plan;
    try {
      plan = planPilotRegister({
        packages,
        imagesByCgiId: imagesByCgiIdFromLedger(String(flag('upload-ledger', path.join(LIVE_DIR, 'upload_ledger.json'))), packages),
        leafByCgiId: readJsonMap(flag('category-file'), '--category-file'),
        detailByCgiId: readDetailDir(flag('detail-dir')),
        stockByCgiId: stockByCgiId(packages, { ack: stockAck }),
        deliveryByCgiId: readJsonMap(flag('policy-file'), '--policy-file (deliveryInfo)'),
        displayStatus,
        sellAck: hasFlag('sell-ack'),
      });
    } catch (error) {
      die(error.message);
    }
    const run = await runPilotRegister({ runtime, plan, env: process.env, execute });
    if (run.refused) { printGateRefusal(run); process.exit(2); }
    const outRel = String(flag('report-out', path.join(LIVE_DIR, 'register_latest.json')));
    const written = writeJson(outRel, { kind: 'cgi-ncom-live-register-run', mode: run.mode, ran_at: new Date().toISOString(), displayStatus: plan.displayStatus, results: run.results, naver_requests: run.naver_requests });
    console.log(`wrote ${path.relative(ROOT, written)}`);
    for (const result of run.results) {
      const line = `${result.sellerManagementCode}: ${result.action}${result.originProductNo != null ? ` originProductNo=${result.originProductNo}` : ''}${result.smartstoreChannelProductNo != null ? ` channelProductNo=${result.smartstoreChannelProductNo}` : ''}`;
      (result.action === 'registered' || result.action === 'register_ready') ? console.log(line) : console.error(line);
    }
    // 실행 장부 병합 — 등록·중복확인 사실을 남긴다(재실행 시 검색이 먼저 막는다).
    const entries = ledgerEntriesFromRegisterRun({ run, displayStatus: plan.displayStatus, mode: run.mode });
    if (entries.length) {
      const ledgerPath = path.join(ROOT, LEDGER_REL);
      const existing = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : [];
      const merged = mergeRegistrationLedger({ existing: Array.isArray(existing) ? existing : [], entries });
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(`ledger: ${LEDGER_REL} (${merged.length} entries)`);
    }
    console.log(`naver_requests=${run.naver_requests}`);
    process.exit(run.results.some((r) => ['rejected', 'blocked_preconditions'].includes(r.action)) ? 1 : 0);
  },

  status: async () => {
    const ledgerPath = path.join(ROOT, LEDGER_REL);
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      console.log(`ledger ${LEDGER_REL}: ${ledger.length} entries`);
      for (const entry of ledger) console.log(`  - ${entry.cgiId} ${entry.kind} ${entry.originProductNo ?? entry.existingOriginProductNo ?? ''} ${entry.registered_at ?? entry.recorded_at ?? ''}`);
    } else {
      console.log(`ledger ${LEDGER_REL}: 없음 — 아직 등록 실행 기록이 없다`);
    }
    const liveDir = path.join(ROOT, LIVE_DIR);
    if (fs.existsSync(liveDir)) {
      for (const entry of fs.readdirSync(liveDir)) console.log(`live/${entry}`);
    } else {
      console.log('live/: 라이브 실행 산출물이 아직 없다');
    }
    process.exit(0);
  },
};

const usage = () => {
  console.log(`네이버 커머스API 라이브 실행 경로 — ${LIVE_LANE_DOC.purpose}
steps: token | categories | mapping | upload | dupcheck | build | register | status
gate: ${LIVE_LANE_DOC.gate.read}
      ${LIVE_LANE_DOC.gate.write}
      ${LIVE_LANE_DOC.gate.register}`);
};

if (!step || !summary[step]) { usage(); process.exit(step ? 2 : 0); }
summary[step]().catch((error) => {
  console.error(`${step} failed: ${error?.code ?? error?.name ?? 'error'} — ${error?.message}`);
  if (error?.verdict?.traceId) console.error(`traceId=${error.verdict.traceId}`);
  process.exit(1);
});
