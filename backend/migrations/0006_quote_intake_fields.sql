-- Migration 0006: quote intake fields (2026-11-01 security/trust audit)
-- 개인정보 동의 게이트 + 세금계산서/나라장터 접수 경로.
-- 기존 행은 기본값(무동의 표시·발행 없음)이지만 접수 당시 구 양식이므로 소급 적용하지 않는다.
ALTER TABLE quote_requests ADD COLUMN privacy_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quote_requests ADD COLUMN invoice_type TEXT;
ALTER TABLE quote_requests ADD COLUMN biz_no TEXT;
ALTER TABLE quote_requests ADD COLUMN agency_no TEXT;
