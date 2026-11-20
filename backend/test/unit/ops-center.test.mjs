// 운영센터 정렬 순수 함수 단위 시험 — maskPersonal·seoulDate·일지 덧붙임·덧붙임 모양·계정 나누기.
//
//   node --test test/unit/ops-center.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maskPersonal,
  seoulDate,
  appendJournalBody,
  validateJournalInput,
  validateFollowupBody,
  publicFollowup,
  feedbackMemberView,
  REOPEN_STATUSES,
  JOURNAL_BODY_MAX,
} from '../../lib/feedback.mjs';
import { customerKind, isTestAccount, ASSIGNABLE_ROLES, ROLE_LABELS, CUSTOMER_VIEW_RETENTION_DAYS } from '../../lib/ops-center.mjs';

test('maskPersonal hides emails and Korean phone numbers (러브트리와 같은 규칙)', () => {
  assert.equal(maskPersonal('메일 a.b+c@cgi.co.kr 로'), '메일 [이메일] 로');
  for (const phone of ['010-1234-5678', '01012345678', '062 576 8100', '02-123-4567']) {
    assert.equal(maskPersonal(`전화 ${phone}`), '전화 [전화번호]', phone);
  }
  assert.equal(maskPersonal('주문 2026-11-20 수량 3'), '주문 2026-11-20 수량 3', '날짜는 건드리지 않는다');
});

test('journal date is the Seoul calendar day', () => {
  // UTC 2026-11-19 16:30 = 한국 2026-11-20 01:30
  assert.equal(seoulDate(Date.parse('2026-11-19T16:30:00Z')), '2026-11-20');
  assert.equal(seoulDate(Date.parse('2026-11-19T14:59:00Z')), '2026-11-19');
});

test('journal input: body required, score 1~5, 8,000 chars, title falls back to the first line', () => {
  assert.equal(validateJournalInput({ body: ' ' }).error, 'body required');
  assert.equal(validateJournalInput({ body: 'x', score: 0 }).error, 'score invalid');
  assert.equal(validateJournalInput({ body: 'x'.repeat(JOURNAL_BODY_MAX + 1) }).error, 'body too long');
  const ok = validateJournalInput({ body: '\n첫 줄 제목\n둘째 줄 01099998888', score: '3' });
  assert.equal(ok.title, '첫 줄 제목');
  assert.equal(ok.score, 3);
  assert.match(ok.body, /\[전화번호\]/);
});

test('same-day journal appends below with a time line and refuses past 8,000 chars', () => {
  const r = appendJournalBody('오전 기록', '오후 기록', Date.parse('2026-11-20T05:07:00Z'));
  assert.equal(r.body, '오전 기록\n\n— 덧붙임 14:07 —\n오후 기록');
  assert.equal(appendJournalBody('가'.repeat(7990), '나'.repeat(20)).error, 'journal full');
});

test('followups: masked body, public shape hides deleted rows and author identity', () => {
  assert.equal(validateFollowupBody('').error, 'body required');
  assert.equal(validateFollowupBody('연락 x@y.kr').body, '연락 [이메일]');
  const row = { id: 1, member_id: 7, body: 'b', created_at: 't', edited_at: 't2', status: 'visible' };
  assert.deepEqual(publicFollowup(row, 7), { id: 1, body: 'b', created_at: 't', edited: true, mine: true, canEdit: true, canDelete: true });
  assert.equal(publicFollowup(row, 8).canEdit, false);
  const view = feedbackMemberView({ id: 'FB', member_id: 7, kind: 'bug', status: 'reviewing', body: 'x' }, [row, { ...row, id: 2, status: 'deleted' }], 7);
  assert.deepEqual(view.followups.map((f) => f.id), [1]);
  assert.ok(!('member_id' in view.followups[0]));
  assert.deepEqual(REOPEN_STATUSES, ['fixed', 'closed']);
});

test('accounts split into real / ai_member / tester without overlap', () => {
  assert.equal(customerKind({ role: 'ai_member', email: 'bot@example.com' }), 'ai_member', 'AI 명예회원이 먼저');
  assert.equal(customerKind({ role: 'member', email: 'bot@example.com' }), 'tester');
  assert.equal(customerKind({ role: 'member', email: 'qa@cgi.kr' }, { TEST_ACCOUNT_EMAILS: 'QA@cgi.kr' }), 'tester');
  assert.equal(customerKind({ role: 'admin', email: 'boss@cgi.kr' }), 'real');
  assert.equal(isTestAccount(''), false);
  assert.deepEqual(ASSIGNABLE_ROLES, ['member', 'ai_member']);
  assert.equal(ROLE_LABELS.ai_member, 'AI 명예회원');
  assert.equal(CUSTOMER_VIEW_RETENTION_DAYS, 90);
});
