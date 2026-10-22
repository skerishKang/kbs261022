import re, sys, json, urllib.request, gzip, io
sys.stdout.reconfigure(encoding='utf-8')

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"

def get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://www.samasound.co.kr/",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        return data.decode("utf-8", errors="replace")

if __name__ == "__main__":
    url = sys.argv[1]
    html = get(url)
    print("LEN", len(html))
    open(sys.argv[2], "w", encoding="utf-8").write(html)
    # product detail structure probe
    for pat, label in [
        (r'<span class="memo">.*?</span>', "memo"),
        (r'id="productPrice".*', "productPrice"),
        (r'class="price".*', "price"),
        (r'<li[^>]*id="productPrice".*?</li>', "li productPrice"),
    ]:
        m = re.search(pat, html, re.S)
        print(f"--- {label} ---")
        print((m.group(0)[:900] if m else "NOT FOUND"))
    print("--- title ---")
    print(re.search(r'<title>(.*?)</title>', html, re.S).group(1) if re.search(r'<title>(.*?)</title>', html, re.S) else "?")
