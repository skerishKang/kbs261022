import re, sys, json
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch, strip_tags, BASE

home = fetch(BASE + "/")
open(r"C:\Users\sji\AppData\Local\Temp\opencode\home.html", "w", encoding="utf-8").write(home or "")
print("home len", len(home or ""))

print("=== homepage: every cate_no occurrence w/ 200 char context ===")
for i, m in enumerate(re.finditer(r"cate_no=(\d+)", home or "")):
    if i > 45:
        print("... (truncated)")
        break
    s = max(0, m.start() - 200)
    ctx = re.sub(r"\s+", " ", home[s:m.end() + 60])
    print(f"[{m.group(1)}] ...{ctx}")
    print()

print("=== homepage: all /category/ hrefs with anchor text ===")
for m in re.finditer(r'<a[^>]+href="(/category/[^"]+)"[^>]*>(.*?)</a>', home or "", re.S):
    print(f"  {m.group(1):<40} {strip_tags(m.group(2))[:40]!r}")

print()
print("=== homepage: nav/menu blocks (t_menu / t_view / gnb) ===")
for m in re.finditer(r'<(ul|div)[^>]*class="[^"]*(?:t_menu|t_view|cate|gallery|gnb)[^"]*"[^>]*>', home or ""):
    s = m.start()
    blk = re.sub(r"\s+", " ", home[s:s + 1400])
    print(blk[:1400])
    print("-----")
