import re, sys, json
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags, BASE

for no in (23, 24, 25):
    url = f"{BASE}/product/list.html?cate_no={no}"
    html = fetch(url)
    if not html:
        print(f"cate {no}: FETCH FAIL")
        continue
    print(f"===== cate_no={no}  len={len(html)} =====")

    # 사이드바 카테고리 트리: cate_no 를 가진 모든 링크
    print("-- cate_no links (all, incl. empty-text) --")
    seen = {}
    for m in re.finditer(r'<a[^>]+href="([^"]*cate_no=(\d+)[^"]*)"[^>]*>(.*?)</a>', html, re.S):
        href, cno, inner = m.group(1), int(m.group(2)), m.group(3)
        text = strip_tags(inner)
        if cno not in seen:
            seen[cno] = [text, href]
    for cno in sorted(seen):
        t, h = seen[cno]
        print(f"  cate_no={cno:<5} name={t[:40]!r:<44} {h[:90]}")

    # 브랜드 링크
    br = sorted(set(re.findall(r'href="(/category/([^/"]+)/(\d+)/)"', html)))
    print(f"-- brand links ({len(br)}) --")
    for href, slug, bid in br[:40]:
        print(f"  /category/{slug}/{bid}/")
    print()
