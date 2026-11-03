# 쇼핑몰 보관기간 분류 및 적용

정리 기준일: 2026-11-03. 정책표 6번에 따라 서비스 로그는 90일, 백업은 28일 보관한다.

## 90일 뒤 정리하는 서비스 로그

`backend/lib/retention.mjs`의 고정 목록만 매일 UTC 03:00 실행에서 표마다 최대 500행씩 정리한다. 기준 시각보다 엄격히 오래된 행만 대상으로 하며, 현재 회차에 남은 행은 다음 회차에 이어서 정리한다. 로그 값이나 식별자는 출력하지 않고 표별 삭제 건수만 기록한다.

| 표 | 기준 컬럼 | 분류 |
| --- | --- | --- |
| `auth_attempts` | `last_at` | 로그인 실패 횟수 및 잠금 계산용 인증 시도 상태 |
| `member_events` | `created_at` | 가입·인증·회원 변경 서비스 이벤트 |
| `product_change_log` | `detected_at` | 상품 동기화의 변경·재시도 서비스 로그 |

`member_events.created_at` 조회용 인덱스는 migration `0007_shop_retention_index.sql`에서 추가한다. 위 표 이외의 표는 정리 작업에서 조회하거나 삭제하지 않는다.

## 보존하는 사용자·거래 데이터

| 표 | 보존 이유 |
| --- | --- |
| `members`, `member_addresses` | 회원과 주소 데이터 |
| `auth_tokens` | 기존 `expires_at` 만료 및 폐기 규칙을 유지 |
| `quote_requests` | 고객 견적 요청 및 계약 관련 기록 |
| `orders`, `order_items`, `payments` | 주문·결제 거래 기록 |
| `order_events` | 주문·결제·환불 상태 이력과 거래 확인 기록 |
| `erp_sync` | 주문에 연결된 ERP 전달 상태, 재시도, 중복 방지 기록 |
| `product_sync_state` | 현재 동기화 상태, 잠금, 재시도 작업 상태 |

주문·결제·계약 관련 기록에는 이 정리 작업을 적용하지 않는다. 메일 발송 및 Worker 실행 로그는 D1 표로 저장하지 않고 외부 실행 로그 제공자가 관리한다.

## 백업

저장소에서 D1 백업 산출물을 생성하거나 보관기간에 따라 삭제하는 코드를 찾지 못했다. `tools/full_catalog/incremental_update.py`의 공급처 상품 목록 스냅샷과 `tools/store/build_price_index.py`의 공개 가격 인덱스는 카탈로그 동기화 산출물이며 회원·주문 D1 백업이 아니다. D1 백업은 Cloudflare 대시보드 등 저장소 밖에서 관리되므로 이 변경으로 28일 자동 삭제를 설정할 수 없다. 해당 백업 보관 설정은 운영 단계에서 별도로 확인해야 한다.
