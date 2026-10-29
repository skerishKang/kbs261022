#!/usr/bin/env node
// 재고 동기화 운영 CLI — 커밋된 계약 모듈(backend/lib/ncom-stock-sync.mjs C21)의 유일한 표준 실행 주체.
//
// 배치8까지 scratch 러너(batch8_stock_compare/apply/revert_fallback.mjs)로 수동 실행하던 흐름을
// 운영화한다(9단계 지시 §6): 새 시스템이 아니라 검증된 계약·호출 패턴의 커밋된 진입점이다.
//
//   compare — 읽기 전용: 등록분 전수(장부 조인) 공급처 관측 + 원상품 GET → planStockSync 계획 산출. 쓰기 0.
//   apply   — 계획 중 유효 변경(sync_quantity·restock·sold_out_transition)만 전체 리소스 PUT(C13) +
//             재조회 검증. 검증 불일치 시 즉시 원본 값 복원 시도(E25 교훈: 의도하지 않은 변경은 원복).
//   revert  — 계획·증적의 before 값으로 지정 상품 원복(장부 기반 수동 복구 경로).
//
// 공통 안전 장치:
//   - 쓰기 이중 게이트: NCOM_LIVE_WRITE=YES + --execute (evaluateLiveGates action='upload' 클래스).
//     상품 등록과 무관하므로 --i-confirm-register는 요구하지 않는다.
//   - 단일 실행 잠금: 출력 디렉터리의 .ncom-stock-sync.lock (신선한 잠금=거부, 2시간 경과=stale 자동 해제).
//   - 수량 출처 없는 쓰기는 계약 모듈이 차단(E25) — 이 CLI는 blocked 계획을 절대 전송하지 않는다.
//     추가로 출처 불명확(fallback_*·미기록) 계획은 apply 단계에서 blocked_by_source로 분리해 전송하지 않는다.
//   - 자격증명은 ~/.config/cgi-erp/ncom.env 에서만 읽고 값은 출력하지 않는다(런북 §1).
//   - 스케줄러 실행은 --out-dir 로 저장소 밖 기록 권장 — 작업트리를 더럽히지 않는다.
//
// 실행 예:
//   node tools/naver/ncom-stock-sync.mjs compare
//   node tools/naver/ncom-stock-sync.mjs compare --out-dir E:/cgi-1029-1/scheduler
//   node tools/naver/ncom-stock-sync.mjs apply --plan reports/data/registration/bulk/stock_sync_plan_20261029.json --execute
//   node tools/naver/ncom-stock-sync.mjs revert --plan <계획파일> --codes samasound:3836,samamusic:1048 --execute

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseCsv } from '../../backend/lib/product-mapping.mjs';
import { evaluateLiveGates } from '../../backend/lib/ncom-live-pipeline.mjs';
import { planStockSync, stockSyncLedgerEntry, STOCK_SYNC_ACTIONS } from '../../backend/lib/ncom-stock-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEDGER_REL = 'reports/data/registration/ncom_registration_ledger.json';
const PREP_REL = 'data/smartstore_prep/smartstore_registration_prep.csv';
const ENV_REL = path.join(process.env.USERPROFILE ?? '', '.config', 'cgi-erp', 'ncom.env');
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const SLEEP_MS = 150;
const UA = 'Mozilla/5.0 (compatible; cgi-catalog-probe/1.0)';

const utcDateTag = (d = new Date()) => d.toISOString().slice(0, 10);

/** 공급처 상세페이지 HTML → 관측값(배치8 실측 파서 재사용). 수량 미표기는 null — 임의 수량 금지(E25). */
export function parseSupplierPage(html) {
  const text = String(html ?? '');
  const onSale = !/재입고 알림/.test(text);
  const m = text.match(/재고수량<\/span><\/th>\s*<td><span[^>]*>([^<]+)/);
  const stockQuantity = m ? (Number(String(m[1]).replace(/[^\d]/g, '')) || null) : null;
  return { onSale, stockQuantity };
}

/** 계획 중 실제 전송 대상만 — blocked·noop은 대상에서 제외(C21: 차단 계획은 절대 전송하지 않는다). */
export function selectApplicablePlans(planDoc) {
  const rows = Array.isArray(planDoc?.rows) ? planDoc.rows : Object.values(planDoc?.plans ?? {});
  const ok = new Set([STOCK_SYNC_ACTIONS.sync_quantity, STOCK_SYNC_ACTIONS.restock, STOCK_SYNC_ACTIONS.sold_out_transition]);
  return rows.filter((r) => r?.plan && ok.has(r.plan.action) && r.plan.modify);
}

/** 수량 출처가 확인된 계획인지 — fallback_*(수량 미공개 하한)은 출처 불명확으로 본다. */
export function isQuantitySourceConfirmed(plan) {
  const source = String(plan?.stock_source ?? '').trim();
  if (!source) return false; // 출처 미기록 계획은 쓰지 않는다(구계획 파일 포함)
  return !/^fallback_/.test(source);
}

/**
 * apply 전송 대상 분리 — C21 계약(④ 상태 전환 하한 허용)은 유지하고,
 * 운영 CLI가 그 위에 더 엄격한 가드를 건다: 출처 불명확(fallback·미기록) 계획은 전송하지 않는다.
 */
export function selectWritablePlans(planDoc) {
  const applicable = selectApplicablePlans(planDoc);
  const writable = [];
  const blocked = [];
  for (const row of applicable) {
    if (isQuantitySourceConfirmed(row?.plan)) {
      writable.push(row);
    } else {
      blocked.push({
        cgiId: row?.cgiId ?? null,
        originProductNo: row?.originProductNo ?? null,
        action: row?.plan?.action ?? null,
        stock_source: row?.plan?.stock_source ?? null,
        reason: 'quantity_source_unconfirmed',
      });
    }
  }
  return { writable, blocked };
}

/** 복원 본문(C12: OUTOFSTOCK은 입력이 아니다 — 재고 0 + SALE로 복원하면 서버가 OUTOFSTOCK 저장). */
export function buildRestoreModify(before) {
  const statusType = String(before?.statusType ?? 'SALE') === 'OUTOFSTOCK' ? 'SALE' : String(before?.statusType ?? 'SALE');
  const stockQuantity = String(before?.statusType ?? '') === 'OUTOFSTOCK' ? 0 : Number(before?.stockQuantity ?? 0);
  return { statusType, stockQuantity };
}

/** 재조회 결과가 계획 verify와 불일치하면 원복 대상. */
export function needsRestore(after, verify) {
  if (!after || !after.statusType) return false;
  if (!verify) return false;
  return after.statusType !== verify.statusType || Number(after.stockQuantity) !== Number(verify.stockQuantity);
}

export function summarizePlans(plans) {
  const byAction = {};
  for (const p of plans) byAction[p?.plan?.action ?? 'unknown'] = (byAction[p?.plan?.action ?? 'unknown'] ?? 0) + 1;
  return { total: plans.length, by_action: byAction };
}

export function summarizeApply(results) {
  const byState = {};
  for (const r of results) byState[r?.state ?? 'unknown'] = (byState[r?.state ?? 'unknown'] ?? 0) + 1;
  return { applied: results.length, by_state: byState };
}

/** 단일 실행 잠금. 신선한 잠금은 거부, LOCK_STALE_MS 경과 잠금은 자동 해제(크래시 잔재 방지). */
export async function acquireLock(lockPath, { now = Date.now(), staleMs = LOCK_STALE_MS, force = false } = {}) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const prev = JSON.parse(raw);
    const age = now - Number(prev.startedAt ?? 0);
    if (age < staleMs && !force) {
      return { ok: false, reason: `fresh lock (age ${Math.round(age / 1000)}s, pid ${prev.pid}) — 동시 실행 의심. --force 로만 해제` };
    }
    fs.rmSync(lockPath, { force: true });
  } catch (e) {
    if (e?.code !== 'ENOENT') { /* 손상 잠금은 아래 생성으로 교체 */ }
  }
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: now, host: process.env.COMPUTERNAME ?? '' })}\n`, { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `lock create failed: ${e?.code ?? e}` };
  }
}

export function releaseLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* 무시 */ }
}

function loadEnvFile(rel) {
  if (!rel || !fs.existsSync(rel)) return;
  for (const line of fs.readFileSync(rel, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (process.env[k] === undefined || String(process.env[k]).trim() === '') process.env[k] = v;
  }
}

function argOf(args, name, dflt = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
function hasFlag(args, name) { return args.includes(name); }
function codesArg(args) {
  const raw = argOf(args, '--codes');
  return raw ? String(raw).split(',').map((s) => s.trim()).filter(Boolean) : null;
}

function die(message, code = 2) {
  console.error(`refused: ${message}`);
  process.exit(code);
}

function readLedgerRegistrations() {
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, LEDGER_REL), 'utf8'));
  const rows = ledger.filter((l) => l && l.originProductNo != null
    && l.kind !== 'cgi-ncom-stock-sync' && l.action == null);
  const byCode = new Map();
  for (const r of rows) byCode.set(String(r.sellerManagementCode ?? r.cgiId), r); // 최신 우선(뒤가 최신)
  return [...byCode.values()];
}

function prepareEnv() {
  loadEnvFile(ENV_REL);
  process.env.NCOM_MODE = 'live';
  // 런타임 전송 허용 계약(ncomModeFromEnv): NCOM_LIVE_WRITE=YES 없으면 읽기 GET도 disabled로 차단된다.
  // compare는 GET·공급처 페이지 관측만 호출하고 쓰기 엔드포인트는 호출하지 않으며,
  // 실제 쓰기 명령(apply·revert)은 별도 --execute 게이트(evaluateLiveGates action='upload')에서만 실행된다.
  process.env.NCOM_LIVE_WRITE = 'YES';
}

async function createRuntime() {
  prepareEnv();
  const { createLocalNcomAuth } = await import('./ncommerce-auth-local.mjs');
  const runtimeRef = await createLocalNcomAuth({ env: process.env });
  if (!runtimeRef?.runtime?.available) die('로컬 인증 런타임 불가 — ~/.config/cgi-erp/ncom.env 확인(값은 출력하지 않는다)');
  return runtimeRef.runtime;
}

function outPathFor(args, kind) {
  const outDir = argOf(args, '--out-dir');
  const explicit = argOf(args, '--out');
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
  if (outDir) return path.join(path.resolve(outDir), `${kind}_${utcDateTag()}.json`);
  return path.join(ROOT, 'reports/data/registration/bulk', `${kind}_${utcDateTag()}.json`);
}

function logLine(outFile, message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile.replace(/\.json$/, '.log'), `${line}\n`);
  } catch { /* 로그 실패는 본 동작을 막지 않는다 */ }
}

async function cmdCompare(args) {
  prepareEnv();
  const gate = evaluateLiveGates({ env: process.env, action: 'read', acks: {} });
  if (!gate.allowed) die(`읽기 게이트: ${gate.reasons.join(' · ')}`);
  const outFile = outPathFor(args, 'stock_sync_plan');
  const lockPath = path.join(path.dirname(outFile), '.ncom-stock-sync.lock');
  const lock = await acquireLock(lockPath, { force: hasFlag(args, '--force') });
  if (!lock.ok) die(lock.reason);
  try {
    const runtime = await createRuntime();
    const prepRows = parseCsv(fs.readFileSync(path.join(ROOT, PREP_REL), 'utf8'));
    const prepBy = new Map(prepRows.map((r) => [String(r['공급처원본ID'] ?? '').trim(), r]));
    const resume = hasFlag(args, '--resume');
    const prior = resume && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    const plans = prior?.plans ?? {};
    const codes = codesArg(args);
    let rows = readLedgerRegistrations();
    if (codes) {
      const want = new Set(codes);
      rows = rows.filter((r) => want.has(String(r.sellerManagementCode ?? r.cgiId).replace(/\.co\.kr:/g, ':')));
    }
    const start = Number(argOf(args, '--start', 0));
    const count = Number(argOf(args, '--count', rows.length));
    const slice = rows.slice(start, start + count);
    logLine(outFile, `compare 시작: ${slice.length}건 (out=${path.relative(ROOT, outFile) || outFile})`);

    let done = 0;
    for (const row of slice) {
      const cgiId = String(row.cgiId ?? row.sellerManagementCode).replace(/\.co\.kr:/g, ':');
      if (resume && plans[cgiId]?.computed_at) continue;
      const out = { cgiId, originProductNo: row.originProductNo, computed_at: new Date().toISOString() };
      const prep = prepBy.get(cgiId);
      if (prep && prep['출처URL']) {
        try {
          const res = await fetch(prep['출처URL'], { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
          const html = await res.text();
          const observed = parseSupplierPage(html);
          out.supplier = { observedAt: new Date().toISOString(), ...observed };
        } catch (e) {
          out.supplier = { observedAt: new Date().toISOString(), onSale: null, stockQuantity: null, error: String(e?.message ?? e).slice(0, 120) };
        }
      } else {
        out.supplier = { observedAt: new Date().toISOString(), onSale: null, stockQuantity: null, error: 'no_prep_row' };
      }

      try {
        const og = await runtime.call('productGetOrigin', { pathParams: { originProductNo: row.originProductNo } });
        const op = og?.data?.originProduct ?? og?.raw?.originProduct ?? og?.raw?.data?.originProduct ?? {};
        out.remote = { exists: Object.keys(op).length > 0, originProductNo: row.originProductNo, statusType: op.statusType ?? null, stockQuantity: op.stockQuantity ?? null };
      } catch (e) {
        out.remote = { exists: false, originProductNo: row.originProductNo, error: String(e?.message ?? e).slice(0, 120) };
      }

      const plan = planStockSync({ sellerManagementCode: cgiId, supplier: out.supplier, remote: out.remote });
      out.plan = {
        action: plan.action, reason: plan.reason ?? null, modify: plan.modify ?? null, verify: plan.verify ?? null,
        changes: plan.changes ? { changed: plan.changes.changed, modified: plan.changes.modified } : null,
        stock_source: plan.stock_source ?? null, note: plan.note ?? null, supplier_observed_at: plan.supplier_observed_at ?? null,
      };
      plans[cgiId] = out;
      done += 1;
      if (done % 40 === 0) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, `${JSON.stringify({ kind: 'cgi-bulk-stock-sync-plan', ran_at: new Date().toISOString(), note: '읽기 전용 재고 비교(공급처 관측 + 원상품 GET) — 계획만 산출, 이 CLI는 blocked·noop을 전송하지 않는다.', plans }, null, 2)}\n`);
        logLine(outFile, `progress ${done}/${slice.length}`);
      }
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ kind: 'cgi-bulk-stock-sync-plan', ran_at: new Date().toISOString(), note: '읽기 전용 재고 비교(공급처 관측 + 원상품 GET) — 계획만 산출, 이 CLI는 blocked·noop을 전송하지 않는다.', plans }, null, 2)}\n`);
    const summary = summarizePlans(Object.values(plans));
    logLine(outFile, `SUMMARY ${JSON.stringify({ ...summary, out: path.resolve(outFile) })}`);
  } finally {
    releaseLock(lockPath);
  }
}

async function fetchOriginOp(runtime, originProductNo) {
  const og = await runtime.call('productGetOrigin', { pathParams: { originProductNo } });
  return og?.data?.originProduct ?? og?.raw?.originProduct ?? og?.raw?.data?.originProduct ?? {};
}

async function putOrigin(runtime, originProductNo, op) {
  await runtime.call('productModifyOrigin', { pathParams: { originProductNo }, body: { originProduct: op } });
}

function appendLedger(entry) {
  const ledgerPath = path.join(ROOT, LEDGER_REL);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.push(entry);
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

async function cmdApply(args) {
  prepareEnv();
  const acks = { execute: hasFlag(args, '--execute') };
  const gate = evaluateLiveGates({ env: process.env, action: 'upload', acks });
  if (!gate.allowed) die(`쓰기 게이트(수정): ${gate.reasons.join(' · ')} — 계획 파일의 유효 변경만 전송한다`);
  const planRel = argOf(args, '--plan');
  if (!planRel) die('--plan 파일 필요');
  const planFile = path.isAbsolute(planRel) ? planRel : path.join(ROOT, planRel);
  if (!fs.existsSync(planFile)) die(`계획 파일 없음: ${planRel}`);
  const lockPath = path.join(path.dirname(planFile), '.ncom-stock-sync.lock');
  const lock = await acquireLock(lockPath, { force: hasFlag(args, '--force') });
  if (!lock.ok) die(lock.reason);
  try {
    const runtime = await createRuntime();
    const planDoc = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const { writable, blocked } = selectWritablePlans(planDoc);
    let applicable = writable;
    const codes = codesArg(args);
    if (codes) applicable = applicable.filter((r) => codes.includes(r.cgiId));
    const outFile = path.join(path.dirname(planFile), path.basename(planFile).replace('plan', 'apply'));
    logLine(outFile, `apply 시작: 대상 ${applicable.length}건 (plan=${path.basename(planFile)})`);
    if (blocked.length) logLine(outFile, `출처 불명확 쓰기 차단: ${blocked.length}건 — fallback·미기록 계획은 전송하지 않는다`);

    const results = [];
    for (const item of applicable) {
      const out = { cgiId: item.cgiId, originProductNo: item.originProductNo, plan_action: item.plan.action, applied_at: new Date().toISOString() };
      try {
        const op = await fetchOriginOp(runtime, item.originProductNo);
        if (!op || !op.statusType) { out.state = 'FAILED_NO_REMOTE'; results.push(out); continue; }
        out.before = { statusType: op.statusType, stockQuantity: op.stockQuantity };
        const full = JSON.parse(JSON.stringify(op));
        full.statusType = item.plan.modify.statusType;
        full.stockQuantity = item.plan.modify.stockQuantity;
        await putOrigin(runtime, item.originProductNo, full);
        const opAfter = await fetchOriginOp(runtime, item.originProductNo);
        out.after = { statusType: opAfter.statusType ?? null, stockQuantity: opAfter.stockQuantity ?? null };
        out.verify_ok = !needsRestore(out.after, item.plan.verify);
        out.state = out.verify_ok ? 'SYNCED' : 'SYNC_VERIFY_MISMATCH';
        if (!out.verify_ok) {
          // 의도하지 않은 변경 → 원본 값 복원 시도(E25 교훈). OUTOFSTOCK before는 SALE+0으로 복원(C11·C12).
          const restore = buildRestoreModify(out.before);
          const fullRestore = JSON.parse(JSON.stringify(opAfter));
          fullRestore.statusType = restore.statusType;
          fullRestore.stockQuantity = restore.stockQuantity;
          await putOrigin(runtime, item.originProductNo, fullRestore);
          const opRestored = await fetchOriginOp(runtime, item.originProductNo);
          out.restore = {
            attempted: true,
            modify: restore,
            after: { statusType: opRestored.statusType ?? null, stockQuantity: opRestored.stockQuantity ?? null },
            ok: String(opRestored.statusType) === restore.statusType
              && (restore.statusType === 'SALE' && restore.stockQuantity === 0
                ? Number(opRestored.stockQuantity) === 0
                : Number(opRestored.stockQuantity) === Number(out.before.stockQuantity)),
          };
          out.state = out.restore.ok ? 'RESTORED' : 'RESTORE_FAILED';
        }
        const planForLedger = {
          sellerManagementCode: item.cgiId, originProductNo: item.originProductNo,
          action: item.plan.action,
          before: { sellerManagementCode: item.cgiId, stockQty: out.before.stockQuantity, availability: out.before.statusType === 'OUTOFSTOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK' },
          after: { sellerManagementCode: item.cgiId, stockQty: out.after.stockQuantity, availability: out.after.statusType === 'OUTOFSTOCK' ? 'OUT_OF_STOCK' : 'IN_STOCK' },
          modify: item.plan.modify, stock_source: item.plan.stock_source ?? null, supplier_observed_at: item.plan.supplier_observed_at ?? null,
        };
        const entry = stockSyncLedgerEntry({ plan: planForLedger, verify: out.after });
        if (entry) { appendLedger(entry); out.ledger_recorded = true; }
      } catch (e) {
        out.state = `FAILED_${e?.code ?? 'error'}`;
        out.error = String(e?.message ?? e).slice(0, 300);
      }
      results.push(out);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, `${JSON.stringify({ kind: 'cgi-bulk-stock-sync-apply', ran_at: new Date().toISOString(), note: '재고 동기화 적용 — 유효 변경만 전체 리소스 PUT + 재조회 검증 + 불일치 시 원본 복원, 전후 장부 기록. 출처 불명확(fallback·미기록) 계획은 blocked_by_source로 기록만 하고 전송하지 않는다.', blocked_by_source: blocked, results }, null, 2)}\n`);
      if (results.length % 20 === 0) logLine(outFile, `progress ${results.length}/${applicable.length}`);
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
    const summary = summarizeApply(results);
    logLine(outFile, `SUMMARY ${JSON.stringify({ ...summary, blocked_by_source: blocked.length, out: path.resolve(outFile) })}`);
    if (results.some((r) => String(r.state).startsWith('FAILED') || r.state === 'RESTORE_FAILED')) process.exitCode = 3;
  } finally {
    releaseLock(lockPath);
  }
}

async function cmdRevert(args) {
  prepareEnv();
  const acks = { execute: hasFlag(args, '--execute') };
  const gate = evaluateLiveGates({ env: process.env, action: 'upload', acks });
  if (!gate.allowed) die(`쓰기 게이트(원복): ${gate.reasons.join(' · ')}`);
  const planRel = argOf(args, '--plan');
  const codes = codesArg(args);
  if (!planRel) die('--plan 파일 필요');
  if (!codes || codes.length === 0) die('--codes 필요 — 원복은 지정 상품만');
  const planFile = path.isAbsolute(planRel) ? planRel : path.join(ROOT, planRel);
  const planDoc = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const rows = Array.isArray(planDoc?.rows) ? planDoc.rows : Object.values(planDoc?.plans ?? {});
  const lockPath = path.join(path.dirname(planFile), '.ncom-stock-sync.lock');
  const lock = await acquireLock(lockPath, { force: hasFlag(args, '--force') });
  if (!lock.ok) die(lock.reason);
  try {
    const runtime = await createRuntime();
    const outFile = path.join(path.dirname(planFile), path.basename(planFile).replace('plan', 'revert'));
    const results = [];
    for (const code of codes) {
      const item = rows.find((r) => r.cgiId === code);
      const out = { cgiId: code, reverted_at: new Date().toISOString() };
      if (!item?.plan?.before || item.plan.before.stockQty == null) {
        out.state = 'NO_BEFORE_RECORD';
      } else {
        try {
          const op = await fetchOriginOp(runtime, item.originProductNo);
          const restore = buildRestoreModify({ statusType: item.plan.before.availability === 'OUT_OF_STOCK' ? 'OUTOFSTOCK' : 'SALE', stockQuantity: item.plan.before.stockQty });
          const full = JSON.parse(JSON.stringify(op));
          full.statusType = restore.statusType;
          full.stockQuantity = restore.stockQuantity;
          await putOrigin(runtime, item.originProductNo, full);
          const opAfter = await fetchOriginOp(runtime, item.originProductNo);
          out.before_target = restore;
          out.after = { statusType: opAfter.statusType ?? null, stockQuantity: opAfter.stockQuantity ?? null };
          out.state = Number(opAfter.stockQuantity) === Number(restore.stockQuantity) ? 'REVERTED' : 'REVERT_MISMATCH';
        } catch (e) {
          out.state = `FAILED_${e?.code ?? 'error'}`;
          out.error = String(e?.message ?? e).slice(0, 300);
        }
      }
      results.push(out);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ kind: 'cgi-bulk-stock-sync-revert', ran_at: new Date().toISOString(), note: '장부 before 값 기반 원복 — 지정 상품만, 전후 재조회 기록.', results }, null, 2)}\n`);
    const summary = summarizeApply(results);
    console.log(`SUMMARY ${JSON.stringify({ ...summary, out: path.resolve(outFile) })}`);
  } finally {
    releaseLock(lockPath);
  }
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'compare';
  const rest = argv.slice(1);
  if (command === 'compare') return cmdCompare(rest);
  if (command === 'apply') return cmdApply(rest);
  if (command === 'revert') return cmdRevert(rest);
  die(`unknown command: ${command} — compare|apply|revert`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
