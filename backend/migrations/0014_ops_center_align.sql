-- Migration 0014: 운영센터를 러브트리 운영센터와 같은 값·구성으로 맞춘다.
--
-- 1) feedback 코드 값 맞추기 (화면 글자는 한국어 그대로)
--    상태: checking → reviewing(확인 중), answered → closed(닫음), on_hold → later(다음에)
--    종류: idea → feature(요청). bug/other/product 는 그대로, inconvenient(불편) 새로 받음.
--    모르는 값이 남아 있어도 화면이 깨지지 않게 상태는 received, 종류는 other 로 모은다.
--    값이 하나도 없어도, 이미 새 값이어도 그대로 안전하다(WHERE 로 해당 줄만 바꾼다).
-- 2) feedback_followup: 고객이 자기 의견에 덧붙인 말. 지우기는 status='deleted'(표시만 숨김).
-- 3) feedback_journal: AI 명예회원 사용 일지. 회원·한국 날짜당 한 건, 같은 날 다시 쓰면 아래에 덧붙인다.
-- 4) admin_customer_views: 운영센터에서 고객 자세히 보기를 연 기록. 90일 뒤 지운다.
-- 5) members.role 에 'ai_member' 를 쓴다(열 형식은 TEXT 그대로, 바뀌는 열 없음).

UPDATE feedback SET status = 'reviewing' WHERE status = 'checking';
UPDATE feedback SET status = 'closed' WHERE status = 'answered';
UPDATE feedback SET status = 'later' WHERE status = 'on_hold';
UPDATE feedback SET status = 'received'
 WHERE status IS NULL OR status NOT IN ('received', 'reviewing', 'fixed', 'later', 'closed');

UPDATE feedback SET kind = 'feature' WHERE kind = 'idea';
UPDATE feedback SET kind = 'other'
 WHERE kind IS NULL OR kind NOT IN ('bug', 'inconvenient', 'feature', 'other', 'product');

CREATE TABLE IF NOT EXISTS feedback_followup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL,
  member_id   INTEGER NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible',  -- visible|deleted
  created_at  TEXT NOT NULL,
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_followup_feedback ON feedback_followup(feedback_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_followup_member ON feedback_followup(member_id);

CREATE TABLE IF NOT EXISTS feedback_journal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id    INTEGER NOT NULL,
  journal_date TEXT NOT NULL,                 -- 한국 시각 날짜 YYYY-MM-DD
  title        TEXT,
  body         TEXT NOT NULL,
  score        INTEGER,                       -- 다시 올 점수 1~5
  append_count INTEGER NOT NULL DEFAULT 0,
  admin_note   TEXT,                          -- 내부 메모(고객에게 안 보임)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (member_id, journal_date)
);
CREATE INDEX IF NOT EXISTS idx_feedback_journal_date ON feedback_journal(journal_date);

CREATE TABLE IF NOT EXISTS admin_customer_views (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_member_id INTEGER,
  admin_label     TEXT NOT NULL,
  customer_id     INTEGER NOT NULL,
  viewed_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_customer_views_viewed ON admin_customer_views(viewed_at);
CREATE INDEX IF NOT EXISTS idx_admin_customer_views_customer ON admin_customer_views(customer_id, viewed_at);
