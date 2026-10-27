// Image facts measured from bytes, for the Naver SmartStore upload path.
//
// Nothing here guesses a limit. Naver's transcribed v2.90.x contract states the
// accepted formats, the 1 representative + 9 additional shape and the
// 10-images-per-upload-call batch cap; it states 1000x1000 as a *recommendation*
// (권장) and never as a floor, and it documents no byte-size ceiling and no
// minimum resolution. Those two absences are carried as `null` so a caller can
// see that the check is unconfirmed rather than silently passing.

import crypto from 'node:crypto';

import { NCOM_LIMITS } from './ncommerce.mjs';

/** Formats named in the contract: "업로드할 수 있는 이미지의 형식은 JPG, GIF, PNG, BMP입니다." */
export const NAVER_ALLOWED_FORMATS = ['jpg', 'jpeg', 'gif', 'png', 'bmp'];

export const NAVER_IMAGE_DOC = {
  source: 'apicenter.commerce.naver.com v2.90.x transcriptions',
  allowedFormats: NAVER_ALLOWED_FORMATS,
  representativePixels: { width: 1000, height: 1000, wording: '권장(recommended, not a stated floor)' },
  extraImagesMax: NCOM_LIMITS.extraImagesMax,
  imagesPerUploadCall: NCOM_LIMITS.imagesPerUploadCall,
  byteSizeLimit: null,
  minimumResolution: null,
  unconfirmed: [
    'max image file size in bytes — not documented',
    'minimum or maximum pixel resolution — only a 1000x1000 recommendation exists',
    'animated GIF policy — not documented',
    'whether a non-square representative is accepted — the recommendation is square',
  ],
};

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32le = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
/** BMP heights are signed: a negative value means the rows run top-down, not a bad file. */
const i32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
const tag = (b, o, n) => String.fromCharCode(...b.slice(o, o + n));
const asciiHead = (b, n) => String.fromCharCode(...b.slice(0, Math.min(n, b.length)));

/** FourCC for WebP sub-spans, and the frame size each one encodes. */
function webpMeta(b) {
  const fourcc = tag(b, 12, 4);
  if (fourcc === 'VP8 ') {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, variant: 'VP8 lossy' };
  }
  if (fourcc === 'VP8L') {
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, variant: 'VP8L lossless' };
  }
  if (fourcc === 'VP8X') {
    return { width: (u16le(b, 24) | (b[26] << 16)) + 1, height: (u16le(b, 27) | (b[29] << 16)) + 1, variant: 'VP8X extended' };
  }
  return { width: null, height: null, variant: fourcc };
}

/**
 * Reads the container header only — enough to name the format and frame size
 * without decoding pixels, so a whole catalogue can be measured in memory.
 */
export function readImageMeta(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  const bytes = b.length;
  const short = (n) => ({ format: 'unknown', width: null, height: null, bytes, parsed: false, reason: `fewer than ${n} bytes` });
  if (bytes < 4) return short(4);

  if (b[0] === 0x89 && tag(b, 1, 3) === 'PNG' && bytes >= 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { format: 'png', width: dv.getUint32(16), height: dv.getUint32(20), bytes, parsed: true, interlaced: b[28] === 1 };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes) {
      if (b[offset] !== 0xff) { offset += 1; continue; }
      const marker = b[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: u16be(b, offset + 5), width: u16be(b, offset + 7), bytes, parsed: true, progressive: marker === 0xc2 };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      offset += 2 + u16be(b, offset + 2);
    }
    return { format: 'jpeg', width: null, height: null, bytes, parsed: false, reason: 'no start-of-frame marker found' };
  }
  if (tag(b, 0, 3) === 'GIF' && bytes >= 10) {
    return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), bytes, parsed: true, variant: `GIF${tag(b, 3, 3)}`, animationIndicator: asciiHead(b, 4096).includes('NETSCAPE2.0') };
  }
  if (tag(b, 0, 2) === 'BM' && bytes >= 26) {
    const width = u32le(b, 18);
    const rawHeight = i32le(b, 22);
    return { format: 'bmp', width, height: Math.abs(rawHeight), bytes, parsed: true, flipped: rawHeight < 0 };
  }
  if (tag(b, 0, 4) === 'RIFF' && tag(b, 8, 4) === 'WEBP' && bytes >= 30) {
    const { width, height, variant } = webpMeta(b);
    return { format: 'webp', width, height, bytes, parsed: width != null, variant, reason: width == null ? `unhandled ${variant} chunk` : undefined };
  }
  return { format: 'unknown', width: null, height: null, bytes, parsed: false, reason: `unrecognised signature 0x${[...b.slice(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join('')}` };
}

/**
 * What the bytes say about Naver's documented gates. `formatAllowed` is the only
 * hard rule; resolution is compared against the recommendation and never used to
 * reject, because no floor is documented.
 */
export function assessImageBytes({ url, status = 200, meta } = {}) {
  if (status === 0 || status == null) {
    return { codes: ['image_probe_not_fetched'], fetched: false, formatAllowed: false, meetsRecommendedPixels: false, aspect: null };
  }
  if (status !== 200) {
    return { codes: ['image_probe_http_error'], fetched: true, formatAllowed: false, meetsRecommendedPixels: false, aspect: null };
  }
  if (!meta?.parsed) {
    return { codes: ['image_bytes_unreadable'], fetched: true, formatAllowed: false, meetsRecommendedPixels: false, aspect: null };
  }
  const codes = ['image_bytes_measured'];
  const formatAllowed = NAVER_ALLOWED_FORMATS.includes(meta.format);
  if (!formatAllowed) codes.push('image_format_not_allowed');
  if (meta.animationIndicator === true) codes.push('image_gif_animation_indicator');
  const { width, height } = meta;
  const square = width && height && width === height;
  if (!square) codes.push('image_non_square_measured');
  const meetsRecommendedPixels = Boolean(square && width >= NAVER_IMAGE_DOC.representativePixels.width);
  codes.push(meetsRecommendedPixels ? 'image_meets_recommended_pixels' : 'image_below_recommended_pixels');
  return {
    codes,
    fetched: true,
    formatAllowed,
    meetsRecommendedPixels,
    aspect: width && height ? `${width}x${height}` : null,
  };
}

/**
 * Cafe24 stores one file per size segment under /web/product/<segment>/. A
 * representative that measures below the recommendation is only worth re-sourcing
 * if a bigger segment actually exists, so the candidates are derived from the URL
 * shape that was measured — never invented.
 */
export const SUPPLIER_SIZE_SEGMENTS = ['big', 'large', 'medium', 'original'];
export function variantUrlCandidates(url, segments = SUPPLIER_SIZE_SEGMENTS) {
  const text = String(url || '');
  const match = text.match(/^(https?:\/\/[^/]+)\/web\/product\/([^/]+)\/(.+)$/i);
  if (!match) return [];
  const [, origin, segment, rest] = match;
  const out = [];
  const seen = new Set([segment.toLowerCase()]);
  for (const candidate of segments) {
    if (seen.has(candidate.toLowerCase())) continue;
    seen.add(candidate.toLowerCase());
    out.push({ segment: candidate, url: `${origin}/web/product/${candidate}/${rest}` });
  }
  if (!seen.has('')) out.push({ segment: '', url: `${origin}/web/product/${rest}` });
  return out;
}

/** Resume key: a probe is identified by the URL it fetched, never by row order. */
export function probeKey(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

/**
 * Turns a measured image list into the upload calls the API will accept:
 * one representative, at most nine additional, ten files per call. Anything past
 * the ninth additional image is reported as dropped so a human can choose scenes.
 */
export function planImageUpload(images = [], { extraImagesMax = NAVER_IMAGE_DOC.extraImagesMax, perCall = NAVER_IMAGE_DOC.imagesPerUploadCall } = {}) {
  const usable = images.filter((image) => image?.url && image.formatAllowed !== false);
  const representative = usable[0] ?? null;
  const additional = usable.slice(1, 1 + extraImagesMax);
  const dropped = usable.slice(1 + extraImagesMax);
  const batches = [];
  for (let offset = 0; offset < usable.length; offset += perCall) {
    batches.push({ batch: batches.length + 1, urls: usable.slice(offset, offset + perCall).map((image) => image.url) });
  }
  return {
    representative: representative?.url ?? '',
    additional: additional.map((image) => image.url),
    dropped_over_limit: dropped.map((image) => image.url),
    upload_calls: batches.length,
    batches,
    over_extra_limit: dropped.length > 0,
  };
}

/** Aggregate census over probe rows, keyed so the published report stays de-identified. */
export function summarizeProbe(probeRows = []) {
  const tally = (values) => values.reduce((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});
  const fetched = probeRows.filter((row) => Number(row.http_status) === 200);
  const dims = fetched.filter((row) => row.width && row.height);
  const sizes = fetched.map((row) => Number(row.bytes) || 0).filter(Boolean).sort((a, b) => a - b);
  return {
    urls_probed: probeRows.length,
    distinct_urls: new Set(probeRows.map((row) => row.url)).size,
    fetched_ok: fetched.length,
    by_status: tally(probeRows.map((row) => row.http_status)),
    by_format: tally(fetched.map((row) => row.format || 'unknown')),
    by_header_variant: tally(fetched.filter((row) => row.variant || row.header_variant).map((row) => row.variant || row.header_variant)),
    format_allowed: fetched.filter((row) => NAVER_ALLOWED_FORMATS.includes(row.format)).length,
    format_rejected: fetched.filter((row) => row.format && !NAVER_ALLOWED_FORMATS.includes(row.format)).length,
    unreadable_bytes: probeRows.filter((row) => Number(row.http_status) === 200 && !row.parsed).length,
    dimensions_measured: dims.length,
    square: dims.filter((row) => row.width === row.height).length,
    non_square: dims.filter((row) => row.width !== row.height).length,
    meets_recommended_1000: dims.filter((row) => row.width === row.height && Number(row.width) >= NAVER_IMAGE_DOC.representativePixels.width).length,
    distinct_dimensions: tally(dims.map((row) => `${row.width}x${row.height}`)),
    bytes_min: sizes.length ? sizes[0] : null,
    bytes_p50: sizes.length ? sizes[Math.floor(sizes.length / 2)] : null,
    bytes_max: sizes.length ? sizes[sizes.length - 1] : null,
    bytes_over_1mb: sizes.filter((size) => size > 1_048_576).length,
  };
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Joins the two committed measurement tables (representative bytes and size-segment
 * variants, both keyed by probeKey(url)) into one evidence index. Rows that got no
 * HTTP answer are kept as `base: null` so "measured as unreachable" stays
 * distinguishable from "never measured" — the two must not collapse into one code.
 */
export function joinImageEvidence(measurementRows = [], variantRows = []) {
  const variants = new Map();
  for (const row of variantRows) {
    const key = String(row.probe_key || '');
    if (key) variants.set(key, row);
  }
  const index = new Map();
  for (const row of measurementRows) {
    const key = String(row.probe_key || '');
    if (!key || !Number.isFinite(Number(row.http_status))) continue;
    const status = Number(row.http_status);
    const variant = variants.get(key);
    index.set(key, {
      base: status === 0 ? null : {
        httpStatus: status,
        container: row.container || '',
        width: num(row.width),
        height: num(row.height),
        bytes: num(row.bytes),
        // Recomputed from the measured container rather than read from the
        // format_allowed column: a flag a caller set is not evidence, and the
        // allow-list has exactly one authority (NAVER_ALLOWED_FORMATS).
        formatAllowed: NAVER_ALLOWED_FORMATS.includes(String(row.container || '').toLowerCase()),
        animationIndicator: row.animation_indicator === 'yes',
      },
      variant: variant ? {
        answered: variant.variants_answered === 'yes',
        found: Number(variant.variants_found) || 0,
        largerAvailable: variant.larger_available || 'not_measured',
        bestSegment: variant.best_segment || '',
        bestWidth: num(variant.best_width),
        bestHeight: num(variant.best_height),
        bestBytes: num(variant.best_bytes),
        meetsNow: variant.meets_recommended_now || 'not_measured',
      } : null,
    });
  }
  return index;
}

/**
 * The readiness judgement the classifier asks for: what the measured bytes say
 * about this URL, or explicitly that nothing was measured. A missing measurement is
 * reported as missing — it is never upgraded into a pass, and never downgraded into
 * a defect. `image_below_recommended_pixels` is a note, not a rejection: the
 * contract documents no minimum resolution.
 */
export function assessMeasuredImage({ url, evidence } = {}) {
  const none = (state, codes, extra = {}) => ({ state, codes, measured: false, formatAllowed: false, width: null, height: null, bytes: null, bestSegment: '', ...extra });
  if (!url) return none('no_url', ['image_representative_blank']);
  const hit = evidence?.get(probeKey(url));
  if (!hit) return none('unmeasured', ['image_measurement_missing']);
  if (!hit.base) return none('unreachable', ['image_probe_not_fetched'], { measured: true });
  if (hit.base.httpStatus !== 200) return none('http_error', ['image_probe_http_error'], { measured: true, httpStatus: hit.base.httpStatus });
  if (!hit.base.container) return none('unreadable', ['image_bytes_unreadable'], { measured: true });

  const codes = ['image_bytes_measured'];
  if (!hit.base.formatAllowed) codes.push('image_format_not_allowed');
  if (hit.base.animationIndicator) codes.push('image_gif_animation_indicator');
  const square = hit.base.width && hit.base.width === hit.base.height;
  if (!square) codes.push('image_non_square_measured');
  const meets = square && hit.base.width >= NAVER_IMAGE_DOC.representativePixels.width;
  codes.push(meets ? 'image_meets_recommended_pixels' : 'image_below_recommended_pixels');

  const variant = hit.variant;
  const drop = (code) => { const index = codes.indexOf(code); if (index !== -1) codes.splice(index, 1); };
  let state = hit.base.formatAllowed ? (meets ? 'ok' : 'below_recommended') : 'format_rejected';
  let width = hit.base.width;
  let height = hit.base.height;
  let bytes = hit.base.bytes;
  let bestSegment = 'representative';
  if (variant && variant.answered) {
    codes.push('image_size_segment_measured');
    if (variant.found > 0 && variant.meetsNow === 'yes') {
      codes.push('image_larger_segment_meets');
      drop('image_below_recommended_pixels');
      drop('image_non_square_measured');
      state = 'ok_via_segment';
      width = variant.bestWidth;
      height = variant.bestHeight;
      bytes = variant.bestBytes ?? bytes;
      bestSegment = variant.bestSegment;
    } else if (variant.found > 0) {
      codes.push(variant.largerAvailable === 'yes' ? 'image_larger_segment_still_small' : 'image_no_larger_segment_measured');
      if (variant.bestWidth && variant.bestWidth > (width || 0)) {
        width = variant.bestWidth;
        height = variant.bestHeight;
        bytes = variant.bestBytes ?? bytes;
        bestSegment = variant.bestSegment;
      }
    } else {
      codes.push('image_no_larger_segment_measured');
    }
  } else if (variant) {
    codes.push('image_size_segment_not_fully_measured');
  }

  return { state, codes, measured: true, formatAllowed: hit.base.formatAllowed, width, height, bytes, bestSegment, container: hit.base.container };
}
