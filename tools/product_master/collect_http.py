"""HTTP 수집기 — 반복 수집을 위한 경로 (issue #8: 브라우저는 검증용).

브라우저는 렌더된 화면을 그대로 볼 수 있지만 반복 수집에는 비효율적이다.
이 모듈은 같은 데이터를 HTTP/HTML 로 가져와 **브라우저 덤프와 동일한 원시
형식**으로 내보내므로, 이후 변환·검증 코드가 완전히 공유된다.

중요 발견 (브라우저·HTTP 양쪽에서 실측)
--------------------------------------
* ``python-requests/2.34.2`` 같은 UA 는 403 으로 차단된다. 브라우저/curl UA 는
  200 이다. UA 를 그대로 두면 "사이트가 죽었다" 고 오판하게 된다.
* ``robots.txt`` 는 ``/product/*`` 를 금지하지 않는다. 금지 경로(``/api``,
  ``/exec/front/``, ``/member/``, ``/myshop/``, ``/protected/``, ``/skin-*/``,
  게시판 쓰기 경로 등)는 방문하지 않는다.
* samamusic 목록의 ``<li>`` 는 ``data-price="^대리점 문의"`` 로 공개 가격
  미표시 상태를 표현한다. 이 경우 금액을 만들지 않는다.
"""

from __future__ import annotations

import html as html_mod
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Optional, Sequence

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

#: 403 을 유발하는 UA (차단 확인용).
BLOCKED_USER_AGENT = "python-requests/2.34.2"

_ROW_RE = re.compile(
    r"<tr\b[^>]*>(?P<body>.*?)</tr>", re.IGNORECASE | re.DOTALL
)
_TH_RE = re.compile(r"<th\b[^>]*>(?P<v>.*?)</th>", re.IGNORECASE | re.DOTALL)
_TD_RE = re.compile(r"<td\b[^>]*>(?P<v>.*?)</td>", re.IGNORECASE | re.DOTALL)
_LI_ITEM_RE = re.compile(
    r'<li[^>]*\bid="anchorBoxId_(?P<pid>\d+)"(?P<attrs>[^>]*)>(?P<body>.*?)(?=<li[^>]*\bid="anchorBoxId_|\Z)',
    re.IGNORECASE | re.DOTALL,
)
_DETAIL_LINK_RE = re.compile(
    r'<a[^>]*href="(?P<href>[^"]*(?:product/detail\.html\?product_no=\d+[^"]*|/product/[^"/]+/\d+/[^"]*))"',
    re.IGNORECASE,
)
_IMG_ALT_RE = re.compile(r'<img[^>]*\balt="(?P<alt>[^"]*)"[^>]*>', re.IGNORECASE)
_IMG_SRC_RE = re.compile(r'<img[^>]*\bsrc="(?P<src>[^"]*)"[^>]*>', re.IGNORECASE)
_CANONICAL_RE = re.compile(
    r'<link[^>]*\brel="canonical"[^>]*\bhref="(?P<href>[^"]*)"', re.IGNORECASE
)
_CANONICAL_RE_ALT = re.compile(
    r'<link[^>]*\bhref="(?P<href>[^"]*)"[^>]*\brel="canonical"', re.IGNORECASE
)
_DATA_PRICE_RE = re.compile(r'data-price="(?P<v>[^"]*)"', re.IGNORECASE)
_SCRIPT_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def html_to_text(fragment: str) -> str:
    """HTML 조각을 평문으로 바꾼다 (태그 제거 + 엔티티 해제 + 공백 축약)."""
    if not fragment:
        return ""
    text = _COMMENT_RE.sub(" ", fragment)
    text = _SCRIPT_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = html_mod.unescape(text)
    return _WS_RE.sub(" ", text).strip()


@dataclass
class HttpResult:
    url: str
    status: int
    text: str
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.status == 200 and not self.error


class HttpClient:
    """robots.txt 를 존중하는,politeness 지연이 있는 소규모 수집기."""

    def __init__(
        self,
        user_agent: str = DEFAULT_USER_AGENT,
        delay: float = 1.2,
        timeout: float = 20.0,
        respect_robots: bool = True,
        max_retries: int = 2,
    ) -> None:
        self.user_agent = user_agent
        self.delay = delay
        self.timeout = timeout
        self.respect_robots = respect_robots
        self.max_retries = max_retries
        self._last_request_at: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser] = {}
        self.request_log: list[dict[str, Any]] = []

    # -- robots ------------------------------------------------------------
    def _robots_for(self, url: str) -> Optional[urllib.robotparser.RobotFileParser]:
        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin in self._robots:
            return self._robots[origin]
        parser: Optional[urllib.robotparser.RobotFileParser] = None
        if self.respect_robots:
            robots_url = origin + "/robots.txt"
            result = self._raw_get(robots_url)
            if result.ok:
                parser = urllib.robotparser.RobotFileParser()
                parser.parse(result.text.splitlines())
        self._robots[origin] = parser  # type: ignore[assignment]
        return parser

    def allowed(self, url: str) -> bool:
        parser = self._robots_for(url)
        if parser is None:
            return True
        try:
            return bool(parser.can_fetch(self.user_agent, url))
        except Exception:  # pragma: no cover - 방어적
            return True

    def crawl_delay(self, url: str) -> float:
        parser = self._robots_for(url)
        if parser is None:
            return 0.0
        try:
            value = parser.crawl_delay(self.user_agent)
        except Exception:  # pragma: no cover
            value = None
        if not value:
            return 0.0
        return float(value)

    # -- fetch -------------------------------------------------------------
    def _raw_get(self, url: str) -> HttpResult:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": self.user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
                "Connection": "close",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                body = response.read().decode(charset, errors="replace")
                return HttpResult(url=url, status=response.status, text=body)
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover
                pass
            return HttpResult(url=url, status=exc.code, text=body, error=f"http_{exc.code}")
        except Exception as exc:  # pragma: no cover - 네트워크 오류
            return HttpResult(url=url, status=0, text="", error=str(exc))

    def get(self, url: str) -> HttpResult:
        """robots 허용 여부를 확인하고 politeness 지연을 두고 GET."""
        if not self.allowed(url):
            self.request_log.append({"url": url, "status": 0, "skipped": "robots_disallow"})
            return HttpResult(url=url, status=0, text="", error="robots_disallow")

        parts = urllib.parse.urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        now = time.monotonic()
        last = self._last_request_at.get(origin)
        wait = max(self.delay, self.crawl_delay(url))
        if last is not None:
            remaining = wait - (now - last)
            if remaining > 0:
                time.sleep(remaining)
        self._last_request_at[origin] = time.monotonic()

        result = self._raw_get(url)
        self.request_log.append(
            {"url": url, "status": result.status, "error": result.error, "bytes": len(result.text)}
        )
        return result

    def get_with_retry(self, url: str) -> HttpResult:
        result = self.get(url)
        attempts = 0
        while not result.ok and attempts < self.max_retries:
            attempts += 1
            time.sleep(self.delay * attempts)
            result = self.get(url)
        return result


# --------------------------------------------------------------------------
# 파서
# --------------------------------------------------------------------------


def parse_spec_rows(page_html: str) -> dict[str, str]:
    """상세 페이지의 ``<th>/<td>`` 스펙행을 dict 로 추출."""
    rows: dict[str, str] = {}
    for row in _ROW_RE.finditer(page_html):
        body = row.group("body")
        th = _TH_RE.search(body)
        td = _TD_RE.search(body)
        if not th or not td:
            continue
        label = html_to_text(th.group("v"))
        value = html_to_text(td.group("v"))
        if label and label not in rows:
            rows[label] = value
    return rows


def parse_list_items(page_html: str, site: str) -> list[dict[str, Any]]:
    """목록 페이지에서 상품 항목 목록을 추출.

    반환 필드: ``product_no``, ``name``, ``href``, ``price_text``, ``data_price``,
    ``image_urls``.
    """
    items: list[dict[str, Any]] = []
    for match in _LI_ITEM_RE.finditer(page_html):
        product_no = match.group("pid")
        body = match.group("body")
        attrs = match.group("attrs") or ""

        name = ""
        for img in _IMG_ALT_RE.finditer(body):
            alt = html_mod.unescape(img.group("alt")).strip()
            if alt and not alt.startswith(("좋아요", "관심상품", "상품 큰 이미지", "장바구니")):
                name = alt
                break

        href = None
        for link in _DETAIL_LINK_RE.finditer(body):
            candidate = link.group("href")
            if f"/{product_no}/" in candidate or f"product_no={product_no}" in candidate:
                href = candidate
                break

        price_text = ""
        data_price = None
        dp = _DATA_PRICE_RE.search(attrs)
        if dp:
            data_price = html_mod.unescape(dp.group("v"))
        spec_match = re.search(
            r'<strong class="title displaynone"><span[^>]*>판매가</span>\s*:</strong>\s*<span[^>]*>(?P<v>.*?)</span>',
            body,
            re.IGNORECASE | re.DOTALL,
        )
        if spec_match:
            price_text = html_to_text(spec_match.group("v"))

        images: list[str] = []
        for img in _IMG_SRC_RE.finditer(body):
            src = img.group("src")
            if "/web/product/" in src and src not in images:
                images.append(src)

        items.append(
            {
                "product_no": product_no,
                "name": name or None,
                "href": href,
                "price_text": price_text or None,
                "data_price": data_price,
                "image_urls": images[:3],
            }
        )
    return items


def parse_detail(
    page_html: str,
    site: str,
    *,
    product_id: str,
    collection_url: str,
    final_url: Optional[str] = None,
    page_title: Optional[str] = None,
) -> dict[str, Any]:
    """상세 페이지를 브라우저 덤프와 **동일한 원시 형식**으로 변환."""
    raw = parse_spec_rows(page_html)
    canonical = None
    cm = _CANONICAL_RE.search(page_html) or _CANONICAL_RE_ALT.search(page_html)
    if cm:
        canonical = html_mod.unescape(cm.group("href"))

    images: list[str] = []
    for img in _IMG_SRC_RE.finditer(page_html):
        src = img.group("src")
        if re.search(r"/web/product/(big|small|extra|medium)/", src) and src not in images:
            images.append(src)

    title = None
    tm = re.search(r"<title>(?P<v>.*?)</title>", page_html, re.IGNORECASE | re.DOTALL)
    if tm:
        title = html_to_text(tm.group("v"))

    body_text = html_to_text(page_html)
    return {
        "site": site,
        "source_product_id": str(product_id),
        "collection_url": collection_url,
        "final_url": final_url or collection_url,
        "page_title": page_title or title,
        "raw_fields": raw,
        "options": [],
        "selects": [],
        "image_urls": images[:6],
        "canonical_url": canonical,
        "soldout_text": "판매완료" in body_text,
    }


# --------------------------------------------------------------------------
# 수집 진입점
# --------------------------------------------------------------------------

SAMASOUND_LIST = "https://www.samasound.co.kr/product/list.html?cate_no={cate_no}&page={page}"
SAMAMUSIC_LIST = "https://www.samamusic.co.kr/product/list.html?cate_no={cate_no}&page={page}"
SAMASOUND_DETAIL = "https://www.samasound.co.kr/product/{slug}/{product_no}/category/{cate_no}/display/{display}/"
SAMAMUSIC_DETAIL = "https://www.samamusic.co.kr/product/detail.html?product_no={product_no}&cate_no={cate_no}&display_group={display}"


def collect_detail(
    client: HttpClient,
    site: str,
    product_no: str,
    *,
    slug: Optional[str] = None,
    cate_no: str = "",
    display: str = "1",
) -> Optional[dict[str, Any]]:
    """상세 페이지 1건을 브라우저 덤프 형식으로 수집."""
    if site == "samasound":
        url = SAMASOUND_DETAIL.format(
            slug=slug or product_no, product_no=product_no, cate_no=cate_no, display=display
        )
    else:
        url = SAMAMUSIC_DETAIL.format(
            product_no=product_no, cate_no=cate_no, display=display
        )
    result = client.get_with_retry(url)
    if not result.ok:
        return None
    return parse_detail(
        result.text, site, product_id=product_no, collection_url=url, final_url=url
    )


def collect_list(
    client: HttpClient, site: str, cate_no: str, pages: int = 1
) -> list[dict[str, Any]]:
    """목록 페이지를 순회해 상품 항목 목록을 수집."""
    template = SAMASOUND_LIST if site == "samasound" else SAMAMUSIC_LIST
    out: list[dict[str, Any]] = []
    for page in range(1, pages + 1):
        url = template.format(cate_no=cate_no, page=page)
        result = client.get_with_retry(url)
        if not result.ok:
            continue
        out.extend(parse_list_items(result.text, site))
    return out
