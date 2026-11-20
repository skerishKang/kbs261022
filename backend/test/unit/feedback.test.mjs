// 운영센터 공통 로직 단위 시험 (backend/lib/feedback.mjs).
//
//   node --test test/unit/feedback.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  NEWS_SOURCE_LABELS,
  countLinks,
  validateFeedbackInput,
  validateFeedbackPatch,
  validateNewsInput,
  normalizeIssueRef,
  normalizePageUrl,
  normalizeForDuplicate,
  parseAiPersonas,
  aiMemberFor,
  maskEmail,
  newFeedbackId,
  feedbackListView,
  feedbackAdminView,
  feedbackMemberView,
  newsPublicView,
} from '../../lib/feedback.mjs';

const ROW = {
  id: 'FB-261120-ABCDEF',
  created_at: '2026-11-20T01:00:00.000Z',
  updated_at: '2026-11-20T01:00:00.000Z',
  kind: 'bug',
  body: '장바구니 버튼이 안 눌려요',
  page_url: 'https://cgishop.pages.dev/site/index.html#/quote-cart',
  contact_email: 'customer@example.com',
  member_id: 7,
  ai_member: null,
  status: 'received',
  admin_reply: '확인했습니다',
  admin_note: '재현됨 — 모바일 사파리',
  issue_ref: '#230',
};

test('kinds and statuses carry the agreed Korean labels', () => {
  assert.deepEqual(FEEDBACK_KINDS, ['bug', 'idea', 'product', 'other']);
  assert.deepEqual(Object.values(FEEDBACK_KIND_LABELS), ['불편·오류', '기능 제안', '상품·가격 문의', '기타']);
  assert.deepEqual(FEEDBACK_STATUSES, ['received', 'checking', 'fixed', 'answered', 'on_hold']);
  assert.deepEqual(Object.values(FEEDBACK_STATUS_LABELS), ['접수', '확인 중', '고침', '답변 완료', '보류']);
  assert.deepEqual(Object.values(NEWS_SOURCE_LABELS), ['AI 명예회원이 알려 준 것', '사용자 의견으로 고친 것']);
});

test('feedback input: kind and body are required, body capped at 2,000 chars', () => {
  assert.equal(validateFeedbackInput({ kind: 'nope', body: 'x' }).error, 'invalid kind');
  assert.equal(validateFeedbackInput({ kind: 'bug', body: '   ' }).error, 'body required');
  assert.ok(validateFeedbackInput({ kind: 'bug', body: '가'.repeat(2000) }).ok, '2,000자는 받는다');
  assert.equal(validateFeedbackInput({ kind: 'bug', body: '가'.repeat(2001) }).error, 'body too long');
  assert.equal(validateFeedbackInput(null).error, 'invalid body');
  const ok = validateFeedbackInput({ kind: 'idea', body: '  비교 기능이 있으면 좋겠어요 \r\n', contact_email: ' Me@Example.COM ' });
  assert.equal(ok.body, '비교 기능이 있으면 좋겠어요');
  assert.equal(ok.contact_email, 'me@example.com');
});

test('three or more links are refused', () => {
  assert.equal(countLinks('a https://a.com b http://b.com c www.c.com'), 3);
  assert.ok(validateFeedbackInput({ kind: 'other', body: 'https://a.com https://b.com 두 개' }).ok);
  assert.equal(validateFeedbackInput({ kind: 'other', body: 'https://a.com https://b.com www.c.kr' }).error, 'too many links');
});

test('contact email is optional but must look like an email', () => {
  assert.equal(validateFeedbackInput({ kind: 'bug', body: 'x', contact_email: '' }).contact_email, null);
  assert.equal(validateFeedbackInput({ kind: 'bug', body: 'x', contact_email: 'not-an-email' }).error, 'invalid contact_email');
});

test('page url keeps http(s) only and masks token-like query values', () => {
  assert.equal(normalizePageUrl('javascript:alert(1)'), null);
  assert.equal(normalizePageUrl('/relative'), null);
  const masked = normalizePageUrl('https://cgishop.pages.dev/site/auth/verify?token=secret123&x=1');
  assert.ok(!masked.includes('secret123'));
  assert.match(masked, /x=1/);
});

test('admin patch validates each field and normalizes the issue ref', () => {
  assert.equal(validateFeedbackPatch({}).error, 'nothing to update');
  assert.equal(validateFeedbackPatch({ status: 'done' }).error, 'invalid status');
  const p = validateFeedbackPatch({ status: 'answered', admin_reply: '답변', admin_note: '', issue_ref: 'https://github.com/o/r/issues/231', ai_member: '리모네' });
  assert.deepEqual(p.fields, { status: 'answered', admin_reply: '답변', admin_note: null, issue_ref: '#231', ai_member: '리모네' });
  assert.equal(validateFeedbackPatch({ ai_member: false }).fields.ai_member, null);
  assert.equal(normalizeIssueRef('42'), '#42');
  assert.equal(normalizeIssueRef('#42'), '#42');
  assert.equal(normalizeIssueRef(''), null);
  assert.equal(validateFeedbackPatch({ admin_reply: '가'.repeat(2001) }).error, 'admin_reply too long');
});

test('AI persona list parses email:name pairs', () => {
  const personas = parseAiPersonas(' bot1@example.com:리모네 , bad , bot2@example.com ');
  assert.equal(personas.get('bot1@example.com'), '리모네');
  assert.equal(personas.get('bot2@example.com'), 'bot2');
  assert.equal(personas.size, 2);
  assert.equal(aiMemberFor(personas, null, 'BOT1@example.com'), '리모네');
  assert.equal(aiMemberFor(personas, 'someone@example.com'), null);
});

test('list view masks the contact email; admin view has it; member view omits internals', () => {
  assert.equal(maskEmail('customer@example.com'), 'cu***@ex***.com');
  const list = feedbackListView(ROW);
  assert.equal(list.contact_email_masked, 'cu***@ex***.com');
  assert.ok(!('contact_email' in list), '목록에는 원문 이메일이 없다');
  assert.ok(!('admin_note' in list), '목록에는 내부 메모 본문이 없다');
  assert.equal(list.has_note, true);
  const admin = feedbackAdminView(ROW);
  assert.equal(admin.contact_email, 'customer@example.com');
  assert.equal(admin.admin_note, '재현됨 — 모바일 사파리');
  const mine = feedbackMemberView(ROW);
  for (const hidden of ['contact_email', 'admin_note', 'issue_ref', 'ai_member', 'member_id']) {
    assert.ok(!(hidden in mine), `${hidden} 은 회원 화면에 없다`);
  }
  assert.equal(mine.admin_reply, '확인했습니다');
  assert.equal(mine.status_label, '접수');
});

test('AI member label reads "AI 명예회원 <이름>"', () => {
  assert.equal(feedbackListView({ ...ROW, ai_member: '리모네' }).ai_member_label, 'AI 명예회원 리모네');
  assert.equal(feedbackListView(ROW).ai_member_label, null);
});

test('feedback id is FB-YYMMDD-XXXXXX', () => {
  assert.match(newFeedbackId(new Date('2026-11-20T00:00:00Z')), /^FB-261120-[A-Z2-9]{6}$/);
  assert.notEqual(newFeedbackId(), newFeedbackId());
});

test('duplicate normalization ignores whitespace and case', () => {
  assert.equal(normalizeForDuplicate('  Hello\n  World '), normalizeForDuplicate('hello world'));
});

test('news input and public view never carry who said it', () => {
  assert.equal(validateNewsInput({ title: '', body: 'x', source_tag: 'ai_member' }).error, 'title required');
  assert.equal(validateNewsInput({ title: 't', body: 'x', source_tag: 'someone' }).error, 'invalid source_tag');
  assert.equal(validateNewsInput({ title: 't', body: 'x', source_tag: 'user_feedback', published: 'yes' }).error, 'published must be boolean');
  assert.deepEqual(validateNewsInput({ published: true }, { partial: true }).fields, { published: true });
  const view = newsPublicView({ id: 1, title: 't', body: 'b', source_tag: 'ai_member', published_at: '2026-11-20T00:00:00Z', author: 'x' });
  assert.deepEqual(Object.keys(view).sort(), ['body', 'id', 'published_at', 'source_label', 'source_tag', 'title']);
  assert.equal(view.source_label, 'AI 명예회원이 알려 준 것');
});
