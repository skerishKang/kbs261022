import re, sys, json
sys.stdout.reconfigure(encoding='utf-8')
html = open(sys.argv[1], encoding='utf-8').read()

print("=== all cate_no anchors with surrounding text ===")
seen = {}
for m in re.finditer(r'<a[^>]+href="([^"]*cate_no=(\d+)[^"]*)"[^>]*>(.*?)</a>', html, re.S):
    href, no, text = m.group(1), m.group(2), re.sub(r'<[^>]+>', '', m.group(3))
    text = re.sub(r'\s+', ' ', text).strip()
    if no not in seen and text:
        seen[no] = (href, text)
for no in sorted(seen, key=int):
    print(f"cate_no={no:>4}  {seen[no][1][:50]:<52} {seen[no][0]}")

print()
print("=== brand/category view links ===")
for m in sorted(set(re.findall(r'href="(/category/[^"]+)"', html))):
    print(m)

print()
print("=== menu blocks containing cate_no (context 300 chars) ===")
for m in list(re.finditer(r'cate_no=', html))[:6]:
    s = max(0, m.start()-320); e = min(len(html), m.end()+120)
    print("...", re.sub(r'\s+', ' ', html[s:e]), "...")
    print("---")
