-- Migration 0015: 관리자 견적서(정식 견적).
--
-- 고객이 쇼핑몰에서 담는 견적 요청(quote_requests)과 별개로, 관리자가 직접 만드는 견적서.
-- 1) admin_quotes: 견적서 한 장. 번호 Q-YYMMDD-NNN 은 서버가 한국 날짜 기준으로 발급한다.
--    금액은 서버가 품목으로 다시 계산해 저장한다(카탈로그 품목 단가는 공개가로 확정).
-- 2) admin_quote_items: 줄. 카탈로그 품목 또는 직접 입력 줄(설치비·출장비·공사비 등).
-- 이카운트 전송은 다음 단계라 ecount_status 는 'not_sent' 로만 쓴다.
-- 새 표만 만든다 — 기존 표는 바꾸지 않으며 여러 번 실행해도 안전하다.

CREATE TABLE IF NOT EXISTS admin_quotes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no           TEXT NOT NULL UNIQUE,              -- Q-YYMMDD-NNN (한국 날짜, 서버 발급)
  status             TEXT NOT NULL DEFAULT 'draft',     -- draft(작성 중)|sent(발송)|won(수주)|canceled(취소)
  quote_date         TEXT NOT NULL,                     -- 견적일 YYYY-MM-DD (한국 시각)
  valid_days         INTEGER NOT NULL DEFAULT 14,
  valid_until        TEXT NOT NULL,                     -- quote_date + valid_days
  recipient_company  TEXT NOT NULL,
  recipient_name     TEXT,
  recipient_phone    TEXT,
  recipient_email    TEXT,
  recipient_memo     TEXT,
  delivery_terms     TEXT,                              -- 납기 메모
  payment_terms      TEXT,                              -- 결제 조건 메모
  supplied_amount    INTEGER NOT NULL DEFAULT 0,
  vat_amount         INTEGER NOT NULL DEFAULT 0,
  total_amount       INTEGER NOT NULL DEFAULT 0,
  item_count         INTEGER NOT NULL DEFAULT 0,
  inquiry_count      INTEGER NOT NULL DEFAULT 0,        -- 단가 없는(별도 견적) 줄 수
  source_quote_id    INTEGER,                           -- 복제한 원본
  ecount_status      TEXT NOT NULL DEFAULT 'not_sent',  -- 이카운트 전송은 다음 단계(지금은 항상 not_sent)
  created_by_id      INTEGER,
  created_by_label   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_quotes_created ON admin_quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_quotes_status ON admin_quotes(status, created_at);

CREATE TABLE IF NOT EXISTS admin_quote_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id        INTEGER NOT NULL,
  line_no         INTEGER NOT NULL,
  kind            TEXT NOT NULL,                        -- product(카탈로그)|custom(직접 입력: 설치비·출장비 등)
  product_id      TEXT,
  name            TEXT NOT NULL,
  brand           TEXT,
  spec            TEXT,                                 -- 모델·규격
  qty             INTEGER NOT NULL,
  unit_price      INTEGER,                              -- NULL = 별도 견적(합계 제외)
  unit_source     TEXT NOT NULL,                        -- catalog(공개가)|manual(직접 입력)|inquiry(단가 없음)
  discount_type   TEXT NOT NULL DEFAULT 'none',         -- none|amount|pct
  discount_value  REAL NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  memo            TEXT,
  supplied_amount INTEGER,
  vat_amount      INTEGER,
  total_amount    INTEGER,
  UNIQUE (quote_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_admin_quote_items_quote ON admin_quote_items(quote_id, line_no);
