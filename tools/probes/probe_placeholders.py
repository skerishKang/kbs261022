"""raw SSR HTML 이 템플릿 플레이스홀더를 남기는지 전수 점검 (HTTP 경로 신뢰도)."""
import re, sys
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch
from collect_samples import list_cards

SA = "https://www.samasound.co.kr"
SM = "https://www.samamusic.co.kr"

for label, base, cates, pages in [("samasound", SA, [23], [1, 2, 3]),
                                  ("samamusic", SM, [42, 84, 1152], [1, 2])]:
    tot = ph = ph_price = 0
    ph_samples = []
    for c in cates:
        for pg in pages:
            h = fetch(f"{base}/product/list.html?cate_no={c}&page={pg}")
            if not h:
                continue
            cards = list_cards(h)
            for cd in cards:
                tot += 1
                if re.search(r'\{\$[A-Za-z_]+\}', cd["name"]):
                    ph += 1
                    if len(ph_samples) < 8:
                        ph_samples.append((c, pg, cd["id"], cd["name"], cd["data_price"]))
                if not cd["data_price"]:
                    ph_price += 1
    print(f"{label}: rows={tot} name_placeholder={ph} missing_data_price={ph_price}")
    for s in ph_samples:
        print("   ", s)

print()
print("=== product_no=4558 (placeholder row) detail check ===")
d = fetch(f"{SM}/product/detail.html?product_no=4558&cate_no=42&display_group=1")
t = re.search(r"<title>(.*?)</title>", d, re.S)
print("title:", (t.group(1).strip() if t else "?"))
print("placeholders in detail:", sorted(set(re.findall(r'\{\$[A-Za-z_]+\}', d)))[:10])
print("JSON-LD present:", "application/ld+json" in d)
m = re.search(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', d, re.S)
print("LD:", (m.group(1)[:400] if m else "-"))
print("price:", re.findall(r'[0-9][0-9,]{2,}\s*원', d)[:5])
