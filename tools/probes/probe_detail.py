import re, sys, json
sys.stdout.reconfigure(encoding='utf-8')
html = open(sys.argv[1], encoding='utf-8').read()

print("=== elements whose id/class mentions price/spec/maker/option ===")
for m in re.finditer(r'<(div|span|li|td|th|strong|p|h\d)[^>]*\b(?:id|class)="([^"]*(?:price|Price|spec|Spec|maker|Maker|option|Option|stock|Stock)[^"]*)"[^>]*>', html):
    print(m.group(0)[:200])

print()
print("=== Korean keyword context ===")
for kw in ["판매가", "정가", "할인가", "제조사", "모델", "규격", "재고", "옵션", "상세설명", "상품명"]:
    for m in list(re.finditer(kw, html))[:3]:
        s = max(0, m.start()-180); e = min(len(html), m.end()+260)
        ctx = re.sub(r'\s+', ' ', html[s:e])
        print(f"[{kw}] ...{ctx}...")
        print()

print("=== JSON-LD / microdata / og: ===")
for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
    print("LD-JSON:", m.group(1)[:1200])
for m in re.finditer(r'<meta[^>]*(?:property|name)="(og:[^"]+|price[^"]*)"[^>]*>', html, re.I):
    print("META:", m.group(0)[:300])
for m in re.finditer(r'itemprop="(price|priceCurrency|name|sku|model)"[^>]*>?([^<]{0,80})', html):
    print("ITEMPROP:", m.group(0)[:200])

print()
print("=== main image candidates ===")
for m in list(re.finditer(r'//www\.samasound\.co\.kr/web/product/[a-z]+/\d+/[0-9a-f]+\.(?:jpg|png)', html))[:12]:
    print(m.group(0))
