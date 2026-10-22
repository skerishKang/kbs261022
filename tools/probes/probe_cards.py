import re, sys, json
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch

def card(html, pid):
    m = re.search(r'<li[^>]*id="anchorBoxId_' + pid + r'"[^>]*>.*?</li>', html, re.S)
    return m.group(0) if m else "(card not found)"

print("############ SAMASOUND card 3884 ############")
h = fetch("https://www.samasound.co.kr/product/list.html?cate_no=23&page=1")
print(card(h, "3884"))

print()
print("############ SAMAMUSIC card 4167 ############")
h2 = fetch("https://www.samamusic.co.kr/product/list.html?cate_no=42")
print(card(h2, "4167"))

print()
print("############ SAMAMUSIC detail: spec table rows ############")
d = fetch("https://www.samamusic.co.kr/product/detail.html?product_no=4167&cate_no=42&display_group=1")
m = re.search(r'<table[^>]*>.*?기본 정보.*?</table>', d, re.S)
print((m.group(0)[:3000] if m else "not found"))
