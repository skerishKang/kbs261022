/* ==========================================================================
   CGI 환불 요청 규칙 — 관리자 주문 콘솔(cgi-staff-orders.js)이 사용한다.
   서버(backend/worker.js cancelPayment) 계약의 거울:
     - cancelAmount 를 생략하면 결제 잔액 전체를 환불한다 (최소금액 검사 없음)
     - cancelAmount 를 보내면 그 값이 부분 환불 최소금액 이상이어야 한다
   즉 1,000원 미만 주문도 "전액 환불"은 가능하다. 이 파일은 DOM 을 touch 하지
   않으므로 node 테스트에서 그대로 로드할 수 있다.
   ========================================================================== */
(function (root) {
  'use strict';

  /* backend MIN_PARTIAL_REFUND 기본값과 일치시킨다. 서버가 400 으로 거절하면
     응답의 detail.min 이 실제 적용 값이므로 그 값을 화면에 보여준다. */
  var MIN_PARTIAL_REFUND = 1000;

  /**
   * 환불 요청 본문을 서버 계약에 맞게 만든다.
   * @param rawAmount  입력란 값(빈 문자열/undefined = 전액 환불)
   * @param refundable 환불 가능 잔액
   * @param reason     사유
   * @returns {{ok:boolean, mode?:string, body?:object, error?:string, min?:number}}
   */
  function buildRefundRequest(rawAmount, refundable, reason) {
    var balance = Number(refundable);
    if (!Number.isFinite(balance) || balance <= 0) {
      return { ok: false, error: '환불 가능 잔액이 없습니다.' };
    }
    var body = { cancelReason: String(reason || '').trim() || '고객 요청 취소/환불' };
    var text = rawAmount == null ? '' : String(rawAmount).trim();

    if (text === '') return { ok: true, mode: 'full', body: body };

    var amount = Number(text);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: '환불 금액은 1원 이상의 정수로 입력하세요.' };
    }
    if (amount > balance) {
      return { ok: false, error: '환불 금액이 잔액보다 많습니다.', max: balance };
    }
    /* 잔액과 같은 금액은 부분 환불이 아니라 전액 환불이다. cancelAmount 를
       그대로 보내면 최소금액 아래 주문에서 거절되므로 생략한다. */
    if (amount === balance) return { ok: true, mode: 'full', body: body };
    if (amount < MIN_PARTIAL_REFUND) {
      return {
        ok: false,
        error: '부분 환불은 ' + MIN_PARTIAL_REFUND.toLocaleString('ko-KR') + '원 이상입니다. 전액 환불은 금액 칸을 비우고 진행하세요.',
        min: MIN_PARTIAL_REFUND,
      };
    }
    body.cancelAmount = amount;
    return { ok: true, mode: 'partial', body: body };
  }

  root.CGI_REFUND = { MIN_PARTIAL_REFUND: MIN_PARTIAL_REFUND, buildRefundRequest: buildRefundRequest };
})(typeof window !== 'undefined' ? window : globalThis);
