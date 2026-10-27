import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_CLASSES, normalizeString, normalizeModel, normalizeBarcode,
  matchScore, classifyMatch, matchProducts, summarizeMatches,
} from '../../lib/erp-duplicate-match.mjs';

test('normalizeString handles null/undefined', () => {
  assert.equal(normalizeString(null), '');
  assert.equal(normalizeString(undefined), '');
  assert.equal(normalizeString('  Hello World  '), 'hello world');
});

test('normalizeModel removes spaces and special chars', () => {
  assert.equal(normalizeModel('SQ-5+'), 'sq5');
  assert.equal(normalizeModel('SPX 8K'), 'spx8k');
});

test('normalizeBarcode trims whitespace', () => {
  assert.equal(normalizeBarcode('  12345  '), '12345');
  assert.equal(normalizeBarcode(null), '');
});

test('matchScore gives high score for exact part number match', () => {
  const cgi = { model: 'SQ5', prodDes: 'SQ5 Speaker', manufacturer: 'Yamaha' };
  const erp = { model: 'SQ5', PROD_DES: 'SQ5 Speaker', manufacturer: 'Yamaha' };
  const score = matchScore(cgi, erp);
  assert.ok(score >= 40, `score should be >= 40, got ${score}`);
});

test('matchScore gives high score for barcode match', () => {
  const cgi = { barCode: '1234567890', prodDes: 'Test' };
  const erp = { BAR_CODE: '1234567890', PROD_DES: 'Test' };
  const score = matchScore(cgi, erp);
  assert.ok(score >= 30, `score should be >= 30, got ${score}`);
});

test('classifyMatch returns NEW_PRODUCT when no erp item', () => {
  const cgi = { prodDes: 'Test' };
  assert.equal(classifyMatch(cgi, null, 0), MATCH_CLASSES.NEW_PRODUCT);
});

test('classifyMatch returns EXACT_MATCH for high score', () => {
  const cgi = { prodDes: 'Test', erpProdCd: 'SS-1' };
  const erp = { PROD_DES: 'Test', PROD_CD: 'SS-1' };
  assert.equal(classifyMatch(cgi, erp, 75), MATCH_CLASSES.EXACT_MATCH);
});

test('classifyMatch returns CONFLICT when same code but different name', () => {
  const cgi = { prodDes: 'Product A', erpProdCd: 'SS-1' };
  const erp = { PROD_DES: 'Product B', PROD_CD: 'SS-1' };
  assert.equal(classifyMatch(cgi, erp, 50), MATCH_CLASSES.CONFLICT);
});

test('classifyMatch returns PROBABLE_MATCH for medium score', () => {
  const cgi = { prodDes: 'Test' };
  const erp = { PROD_DES: 'Test' };
  assert.equal(classifyMatch(cgi, erp, 50), MATCH_CLASSES.PROBABLE_MATCH);
});

test('matchProducts returns one result per CGI product', () => {
  const cgiProducts = [
    { cgiId: 'a:1', prodDes: 'Product 1', model: 'M1', barCode: 'BC001' },
    { cgiId: 'a:2', prodDes: 'Product 2', model: 'M2' },
  ];
  const erpItems = [
    { PROD_CD: 'E1', PROD_DES: 'Product 1', model: 'M1', BAR_CODE: 'BC001' },
  ];
  const results = matchProducts(cgiProducts, erpItems);
  assert.equal(results.length, 2);
  assert.equal(results[0].matchClass, MATCH_CLASSES.EXACT_MATCH);
  assert.equal(results[1].matchClass, MATCH_CLASSES.NEW_PRODUCT);
});

test('matchProducts does not reuse ERP items', () => {
  const cgiProducts = [
    { cgiId: 'a:1', prodDes: 'Product 1', model: 'M1', barCode: 'BC001' },
    { cgiId: 'a:2', prodDes: 'Product 1', model: 'M1', barCode: 'BC002' },
  ];
  const erpItems = [
    { PROD_CD: 'E1', PROD_DES: 'Product 1', model: 'M1', BAR_CODE: 'BC001' },
  ];
  const results = matchProducts(cgiProducts, erpItems);
  assert.equal(results[0].matchClass, MATCH_CLASSES.EXACT_MATCH);
  assert.equal(results[1].matchClass, MATCH_CLASSES.NEW_PRODUCT); // ERP item already used
});

test('summarizeMatches counts correctly', () => {
  const results = [
    { matchClass: MATCH_CLASSES.EXACT_MATCH },
    { matchClass: MATCH_CLASSES.NEW_PRODUCT },
    { matchClass: MATCH_CLASSES.NEW_PRODUCT },
  ];
  const summary = summarizeMatches(results);
  assert.equal(summary.total, 3);
  assert.equal(summary.EXACT_MATCH, 1);
  assert.equal(summary.NEW_PRODUCT, 2);
});

test('matchProducts handles empty ERP list', () => {
  const cgiProducts = [{ cgiId: 'a:1', prodDes: 'Product 1' }];
  const results = matchProducts(cgiProducts, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].matchClass, MATCH_CLASSES.NEW_PRODUCT);
});

test('matchProducts handles empty CGI list', () => {
  const results = matchProducts([], [{ PROD_CD: 'E1', PROD_DES: 'Product 1' }]);
  assert.equal(results.length, 0);
});
