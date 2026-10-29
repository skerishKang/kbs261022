// M2 후속 — 이미지 업로드 러너. 계획(planImageUpload)과 전송(createNcomAuthRuntime)은
// 이미 검증된 모듈을 재사용하고, 여기서는 '러너의 계약'만 추가한다:
//
//   1. 상품 본문에 들어갈 이미지는 대표 1 + 추가 9 이다 — 이 10장만 업로드한다.
//      (planImageUpload 의 dropped_over_limit 는 업로드조차 하지 않는다.)
//   2. execute=false 는 호출 0건 — 배치 계획과 차단 사유만 돌려준다(dry-run).
//   3. execute=true 는 NCOM_MODE=mock 에서만 허용된다. 실제 업로드는 운영자 승인 레인이며
//      러너는 라이브 모드를 스스로 거부한다.
//   4. 응답 URL 수 != 보낸 파일 수 인 배치는 부분 채택하지 않는다 — 배치 전체가 대기.
//   5. 상품 본문에 쓸 수 있는 URL 은 ledger.uploaded 뿐이다. 공급처 원본 URL 은 절대
//      복사되지 않는다(not_from_image_upload_api 게이트의 러너 쪽 절반).
//
// 순수 계약은 계약 테스트(m2-image-upload-contract)가, 러너 동작은 이 모듈의 테스트가 고정한다.

import { planImageUpload } from './naver-images.mjs';
import { NcomError, NCOM_LIMITS } from './ncommerce.mjs';

const chunk = (items, size) => {
  const out = [];
  for (let offset = 0; offset < items.length; offset += size) out.push(items.slice(offset, offset + size));
  return out;
};

export function createImageUploadRunner({ runtime } = {}) {
  if (!runtime || typeof runtime.call !== 'function') {
    throw new NcomError('runner_runtime_missing', 'createImageUploadRunner needs a createNcomAuthRuntime instance', { operation: 'imageUpload' });
  }

  /**
   * images: [{ url, formatAllowed, bytes, filename }] — url·formatAllowed 는
   * planImageUpload 계약, bytes·filename 은 multipart 파트 재료. bytes 가 없는 항목은
   * dry-run 계획에만 쓰인다(execute 시 파일 재료 없이는 보낼 수 없다).
   */
  async function runUploads({ images = [], execute = false } = {}) {
    const plan = planImageUpload(images);
    // 본문에 들어갈 10장만 업로드 대상이다 — 대표 1 + 추가 9(NCOM_LIMITS.imagesPerUploadCall 와 같은 수).
    const selected = [plan.representative, ...plan.additional].filter(Boolean)
      .map((url) => images.find((image) => image.url === url))
      .filter(Boolean);
    const batches = chunk(selected, NCOM_LIMITS.imagesPerUploadCall).map((items, index) => ({ batch: index + 1, items }));

    if (!execute) {
      return {
        plan,
        batches: batches.map((batch) => ({ batch: batch.batch, files: batch.items.length })),
        batches_run: 0,
        ledger: [],
        uploaded_urls: [],
        failed_batches: [],
        naver_requests: 0,
        transmitted: false,
        note: 'dry-run — 호출 0건. 실행은 판매자 토큰(운영자 승인) 선행이고, 실행 모드는 mock 검증만 이 레인에 있다.',
      };
    }
    if (runtime.mode !== 'mock') {
      throw new NcomError('upload_runner_live_refused', `이미지 업로드 러너는 이 레인에서 NCOM_MODE=mock 만 허용된다(현재 ${JSON.stringify(runtime.mode)}) — 실제 업로드는 운영자 승인 레인이다`, { operation: 'imageUpload' });
    }

    const ledger = [];
    const failed_batches = [];
    for (const batch of batches) {
      const form = new FormData();
      for (const item of batch.items) {
        form.append('imageFiles', new File([item.bytes ?? Buffer.alloc(0)], item.filename ?? 'image.png', { type: 'image/png' }));
      }
      const response = await runtime.call('imageUpload', { body: form });
      const urls = response?.data?.urls;
      if (!Array.isArray(urls) || urls.length !== batch.items.length) {
        failed_batches.push({
          batch: batch.batch,
          sent: batch.items.length,
          received: Array.isArray(urls) ? urls.length : null,
          note: '응답 URL 수가 보낸 파일 수와 다르다 — 부분 채택 없이 배치 전체가 대기 상태로 남는다',
        });
        continue;
      }
      batch.items.forEach((item, index) => ledger.push({ source: item.url, uploaded: urls[index] }));
    }

    return {
      plan,
      batches: batches.map((batch) => ({ batch: batch.batch, files: batch.items.length })),
      batches_run: batches.length,
      ledger,
      uploaded_urls: ledger.map((entry) => entry.uploaded),
      failed_batches,
      naver_requests: runtime.stats.attempts,
      transmitted: failed_batches.length === 0 && ledger.length > 0,
      mode: runtime.mode,
    };
  }

  return { runUploads };
}

/**
 * 러너 ledger → 상품 등록 본문의 images 필드. ledger 에 없는 원본 URL 은 여기서도
 * 절대 복사되지 않는다 — buildRegisterBody 의 not_from_image_upload_api 게이트와 맞물린다.
 */
export function imagesFromLedger({ ledger = [], plan = null } = {}) {
  const bySource = new Map(ledger.map((entry) => [entry.source, entry.uploaded]));
  const representative = bySource.get(plan?.representative || '') || '';
  const additional = (plan?.additional || []).map((url) => bySource.get(url)).filter(Boolean);
  return {
    representative,
    additional,
    uploadedViaImageApi: Boolean(representative),
    source: 'image-upload-runner ledger',
  };
}
