"""HTTP 경로 vs BrowserSkill 경로 동일 페이지 추출 결과 비교 (검증 아티팩트)."""
import json, re, sys, time
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"D:\1022\1022-0-computeruse\tools")
from samasound_collect import fetch
from collect_samples import list_cards

SM = "https://www.samamusic.co.kr"
url = f"{SM}/product/list.html?cate_no=42"

t0 = time.time()
html = fetch(url)
t_http = time.time() - t0
http_rows = list_cards(html)
http_map = {c["id"]: c for c in http_rows}

bsk = json.load(open(r"C:\Users\sji\AppData\Local\Temp\opencode\bsk-list.json", encoding="utf-8-sig"))
if isinstance(bsk.get("result"), dict):
    bsk = bsk["result"].get("value", bsk["result"])
bsk_map = {str(r["id"]): r for r in bsk["rows"]}

print(f"HTTP  : {len(http_map)} rows, {t_http:.2f}s, {len(html):,} bytes")
print(f"BSK   : {len(bsk_map)} rows (Agent Window DOM, rendered)")
print()
def norm_num(s):
    return re.sub(r"[^0-9]", "", s or "")


print(f"{'id':>6} {'name':<4} {'price':<8} {'image':<8} {'url':<6}")
same = diff = 0
for pid in sorted(set(http_map) | set(bsk_map), key=lambda x: -int(x)):
    h, b = http_map.get(pid), bsk_map.get(pid)
    def cmp(a, bv, fn):
        if a is None or b is None:
            return "MISS"
        av = fn(a) or ""
        bvv = (bv or "")
        return "ok" if av.strip() == bvv.strip() else "DIFF"
    n = cmp(h, b.get("name") if b else None, lambda x: x["name"])
    # 가격은 통화 표기(219,000원 vs 219000) 차이를 제거하고 숫자만 비교한다
    hp = norm_num(h["data_price"]) if h else ""
    bp = norm_num(b.get("price_text")) if b else ""
    p = "ok" if (hp and hp == bp) else ("DIFF" if hp or bp else "MISS")
    im = cmp(h, b.get("image") if b else None, lambda x: x["image"].replace("https:", ""))
    u = cmp(h, b.get("url") if b else None, lambda x: x["href"])
    mark = all(x == "ok" for x in (n, p, im, u))
    same += mark
    diff += (not mark)
    print(f"{pid:>6} {n:<4} {p:<8} {im:<8} {u:<6}  {'OK' if mark else 'MISMATCH'}  "
          f"{(h['name'][:52] if h else '')}")
print()
print(f"identical rows: {same}/{same+diff}")

# 가격 텍스트 정규화 비교 (HTTP 는 data-price 숫자, BSK 는 '219,000원')
def norm(s):
    return re.sub(r"[^0-9]", "", s or "")
mism = []
for pid in set(http_map) & set(bsk_map):
    a = norm(http_map[pid]["data_price"])
    b = norm(bsk_map[pid].get("price_text"))
    if a != b:
        mism.append((pid, http_map[pid]["data_price"], bsk_map[pid].get("price_text")))
print(f"price numeric mismatches: {len(mism)}", mism[:5])
