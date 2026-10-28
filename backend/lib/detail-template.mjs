// M1 — detailContent draft TEMPLATE for the Naver register body.
//
// Builds on lib/registration-content.mjs (buildDetailDraft) without replacing
// it: the content-plan lane keeps its minimal draft as the readiness authority.
// This module renders the richer responsive HTML a real listing needs, under
// the same fail-closed rules:
//
//   - only data the repository actually holds goes in. Every block names the
//     source column it was read from; an absent field is reported as a reason,
//     never filled with an invented spec, certification or origin.
//   - 가격 shows only when the supplier published a number (가격확인필요 != 예).
//     An inquiry price is not a price to display.
//   - the representative image uses the supplier URL as-is (detailContent HTML
//     may reference external images; the product-image fields may not) and
//     carries the measured width/height so both viewports reserve the box.
//     The measurement verdict is a note, never a pass/fail of the draft.
//   - the option table renders only an emittable option plan — a truncated or
//     ambiguous supplier list would advertise choices the supplier does not
//     sell (buildOptionPlan already refuses those).
//   - the draft never claims to satisfy the required field: it ships with
//     counts_as_detail_content=false and operator_approval_required=true, the
//     same contract findPlanViolations() enforces on the content-plan lane.
//
// No network, no fs. The sample tool and the render checker read/write files.

import { assessMeasuredImage } from './naver-images.mjs';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Locale-independent 1,234,567 formatting so CI and local runs agree byte for byte. */
export function formatWon(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(Math.round(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const DETAIL_TEMPLATE_DOC = {
  source: 'apicenter.commerce.naver.com docs/commerce-api/current — POST /v2/products originProduct.detailContent (HTML string)',
  detailImageRule: '상세설명 본문 내부의 이미지는 외부 URL이 허용된다 — 제품 대표/추가 이미지 필드와 달리 업로드 API 반환 URL만이 요구되지 않는다',
  stylePolicy: 'inline style 로 기본 레이아웃을 유지하고 <style> 블록은 보강만 담당한다 — 편집기가 style 태그를 걷어내도 본문이 무너지지 않는다',
  unconfirmed: [
    'detailContent 의 최소 길이·필수 구조 — 문서에 인쇄되지 않았다',
    '스마트스토어 편집기가 <style> 태그를 보존하는지 — 첫 실등록 전 검증 필요',
    '옵션 표기의 문자 제한 — 옵션 25자 규칙은 엑셀 일괄등록 기준이며 API 본문과의 동등성 미확인',
  ],
};

const SOURCE = {
  name: '상품명',
  brand: '브랜드',
  manufacturer: '제조사',
  model: '모델명',
  category: '카테고리경로_CGI',
  price: '판매가 + 가격확인필요',
  sentence: '상세설명(공급처 한 줄)',
  options: '옵션SKU요약 + options_compact',
  image: '대표이미지URL + reports/data/naver/image_measurements',
  sourceUrl: '출처URL',
};

/**
 * One responsive detailContent draft. `optionPlan` is the plan built by
 * registration-content.buildOptionPlan; `evidence` is the joined measurement
 * index from naver-images.joinImageEvidence.
 */
export function buildDetailTemplate({ prepRow = {}, optionPlan = null, evidence = null } = {}) {
  const name = String(prepRow['상품명'] ?? '').trim();
  const brand = String(prepRow['브랜드'] ?? '').trim();
  const manufacturer = String(prepRow['제조사'] ?? '').trim();
  const model = String(prepRow['모델명'] ?? '').trim();
  const categoryPath = String(prepRow['카테고리경로_CGI'] ?? '').trim();
  const sentence = String(prepRow['상세설명'] ?? '').trim();
  const imageUrl = String(prepRow['대표이미지URL'] ?? '').trim();
  const sourceUrl = String(prepRow['출처URL'] ?? '').trim();
  const priceText = String(prepRow['판매가'] ?? '').trim();
  const priceNeedsConfirm = String(prepRow['가격확인필요'] ?? '').trim() === '예';
  const priceValue = priceNeedsConfirm || priceText === '' ? null : Number(priceText.replace(/[^\d]/g, ''));

  const blocks = [];
  const reasons = [];
  const notes = [];

  const assess = assessMeasuredImage({ url: imageUrl, evidence });
  let imageTag = '';
  if (imageUrl) {
    blocks.push({ key: 'image', present: true, source: SOURCE.image, state: assess.state, width: assess.width, height: assess.height });
    const dims = assess.width && assess.height ? ` width="${assess.width}" height="${assess.height}"` : '';
    imageTag = `<p style="text-align:center;margin:16px 0;"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" style="max-width:100%;height:auto;"${dims}></p>`;
    if (assess.state === 'ok_via_segment') notes.push('대표 이미지는 실측상 더 큰 세그먼트가 권장 해상도를 충족 — 등록 시 그 URL을 이미지 업로드에 사용한다');
    if (assess.state === 'below_recommended') notes.push('대표 이미지가 1000x1000 권장 미만 — 등록 차단 사유는 아니지만 품질 보완 큐로 분리된다');
    if (assess.state === 'unmeasured') notes.push('대표 이미지 실측 레코드가 없다 — URL은 공급처 게시값이므로 초안에는 넣되 등록 전 실측이 필요하다');
  } else {
    blocks.push({ key: 'image', present: false, source: SOURCE.image });
    reasons.push('image_representative_blank');
  }

  const chips = [
    ['브랜드', brand, SOURCE.brand],
    ['제조사', manufacturer, SOURCE.manufacturer],
    ['모델명', model, SOURCE.model],
  ].filter(([, value]) => value !== '');
  if (brand === '') reasons.push('brand_absent');
  if (manufacturer === '') reasons.push('manufacturer_absent');
  if (model === '') reasons.push('model_absent');
  if (chips.length > 0) blocks.push({ key: 'meta', present: true, source: chips.map(([, , source]) => source).join(', ') });

  let priceTag = '';
  if (priceValue != null && Number.isFinite(priceValue)) {
    blocks.push({ key: 'price', present: true, source: SOURCE.price, value: priceValue });
    priceTag = `<p style="font-size:20px;font-weight:700;margin:14px 0 10px;">판매가 ${formatWon(priceValue)}원</p>`;
  } else {
    blocks.push({ key: 'price', present: false, source: SOURCE.price });
    reasons.push(priceNeedsConfirm ? 'price_inquiry_omitted' : 'price_absent_omitted');
  }

  if (sentence) blocks.push({ key: 'sentence', present: true, source: SOURCE.sentence });
  else reasons.push('detail_sentence_absent');

  const specRows = [
    ['브랜드', brand, SOURCE.brand],
    ['제조사', manufacturer, SOURCE.manufacturer],
    ['모델명', model, SOURCE.model],
    ['공급처 분류', categoryPath, SOURCE.category],
  ].filter(([, value]) => value !== '');
  if (specRows.length > 0) blocks.push({ key: 'spec_table', present: true, source: SOURCE.category + ', ' + specRows.map(([, , s]) => s).join(', ') });
  else reasons.push('spec_fields_absent');

  let optionTag = '';
  const optionInfo = optionPlan && optionPlan.emittable
    ? {
      groups: [...new Set(optionPlan.children.map((c) => c.groupName))].map((groupName) => ({
        groupName,
        children: optionPlan.children.filter((c) => c.groupName === groupName),
      })),
    }
    : null;
  if (optionInfo) {
    blocks.push({ key: 'options_table', present: true, source: SOURCE.options, groups: optionInfo.groups.length, children: optionPlan.children.length });
    const rows = optionInfo.groups.map((group) => group.children.map((child) => {
      const price = child.addPrice != null ? ` <span style="color:#c0392b;">(+${formatWon(child.addPrice)}원)</span>` : '';
      const soldOut = child.usable === false ? ' <span style="color:#888;">[품절]</span>' : '';
      return `<tr><th style="white-space:nowrap;">${escapeHtml(group.groupName)}</th><td>${escapeHtml(child.childName)}${price}${soldOut}</td></tr>`;
    }).join('')).join('');
    optionTag = `<h3 style="font-size:17px;margin:18px 0 8px;">옵션</h3><table>${rows}</table>`;
  } else {
    blocks.push({ key: 'options_table', present: false, source: SOURCE.options });
    if (optionPlan) reasons.push('options_not_emittable');
  }

  if (name === '') reasons.push('product_name_blank');
  if (sourceUrl) blocks.push({ key: 'source_link', present: true, source: SOURCE.sourceUrl });
  else reasons.push('source_url_absent');

  const specTable = specRows.length > 0
    ? `<h3 style="font-size:17px;margin:18px 0 8px;">제품 정보</h3><table>${specRows.map(([label, value]) => `<tr><th style="white-space:nowrap;width:110px;">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table>`
    : '';

  const html = [
    '<div class="cgi-detail" style="max-width:780px;margin:0 auto;padding:0 12px;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;color:#222;line-height:1.6;word-break:keep-all;">',
    '<style>.cgi-detail table{width:100%;border-collapse:collapse;margin:0 0 8px;}.cgi-detail th,.cgi-detail td{border:1px solid #e5e5e5;padding:8px;text-align:left;vertical-align:top;font-weight:normal;}@media (max-width:480px){.cgi-detail{font-size:14px;}}</style>',
    imageTag,
    `<h2 style="font-size:24px;margin:10px 0 6px;">${escapeHtml(name)}</h2>`,
    chips.length > 0 ? `<p style="color:#666;margin:0 0 10px;">${chips.map(([label, value]) => `${escapeHtml(label)} ${escapeHtml(value)}`).join(' &middot; ')}</p>` : '',
    priceTag,
    sentence ? `<p style="margin:12px 0;">${escapeHtml(sentence)}</p>` : '',
    specTable,
    optionTag,
    sourceUrl ? `<p style="margin:14px 0 6px;">출처: <a href="${escapeHtml(sourceUrl)}">상품 원본 페이지</a></p>` : '',
    '<p style="color:#888;font-size:12px;margin:10px 0 18px;">본 상세설명은 공급처 게시 정보만으로 구성된 등록 초안입니다. 실제 판매 전 운영자 확인이 필요하며, 공급처 자료에 없는 사양·인증·원산지 정보는 포함하지 않습니다.</p>',
    '</div>',
  ].filter(Boolean).join('');

  return {
    kind: 'template_draft',
    counts_as_detail_content: false,
    operator_approval_required: true,
    html,
    textLength: html.length,
    blocks,
    reasons,
    notes,
    sources: Object.values(SOURCE),
  };
}

/**
 * Standalone preview document for the PC/mobile render check. The wrapper is a
 * viewing artifact only — the register body is template.html.
 */
export function buildDetailSampleDocument({ template, cgiId, supplierSite = '' } = {}) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>상세설명 시안 — ${escapeHtml(cgiId)}</title>
</head>
<body style="margin:0;background:#fafafa;">
<p style="margin:0;padding:8px 12px;background:#222;color:#fff;font-size:12px;">시안 프리뷰 · ${escapeHtml(cgiId)}${supplierSite ? ` · ${escapeHtml(supplierSite)}` : ''} · 등록 전 운영자 승인 필요</p>
${template.html}
</body>
</html>`;
}
