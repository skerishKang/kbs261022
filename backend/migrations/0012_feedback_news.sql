-- Migration 0012: 운영센터(의견 보내기 · 받은함 · 답변 · 내 의견) + 새 소식.
--
-- feedback: 고객이 보낸 의견. 비회원도 보낼 수 있고(member_id NULL), 로그인
--   회원이면 member_id 로 연결한다. contact_email 은 관리자 상세에서만 열람한다.
--   ai_member 는 AI 명예회원 이름(관리자 지정 또는 페르소나 이메일 목록), 일반 의견은 NULL.
--   status: received(접수) / checking(확인 중) / fixed(고침) / answered(답변 완료) / on_hold(보류)
--   admin_reply 는 고객에게 보이는 답글, admin_note 는 내부 메모(고객에게 안 보임).
-- news: 공개 '새 소식'(버전 노트). source_tag 는 ai_member / user_feedback 두 묶음뿐이고
--   누가 말했는지는 저장하지 않는다. published_at 이 NULL 이면 초안.

CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  body          TEXT NOT NULL,
  page_url      TEXT,
  contact_email TEXT,
  member_id     INTEGER,
  ai_member     TEXT,
  status        TEXT NOT NULL DEFAULT 'received',
  admin_reply   TEXT,
  admin_note    TEXT,
  issue_ref     TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_member ON feedback(member_id, created_at);

CREATE TABLE IF NOT EXISTS news (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  source_tag   TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at);
