#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""이카운트 엑셀 일괄등록 템플릿 → 컬럼/규격 텍스트 변환.

사용법:
  python ecount_template_dump.py Template.xlsx [출력.txt]

이카운트 템플릿의 진짜 규격은 셀 **주석(xl/comments1.xml)** 에 들어있다.
헤더 셀만 읽으면 허용값·최대길이를 놓치므로 주석을 반드시 파싱한다.
"""
from __future__ import annotations

import html
import re
import sys
import zipfile


def dump(path: str) -> str:
    out: list[str] = []
    z = zipfile.ZipFile(path)

    wb = z.read("xl/workbook.xml").decode("utf-8")
    out.append("SHEETS: " + ", ".join(re.findall(r"<sheet[^>]*name=\"([^\"]+)\"", wb)))

    shared: list[str] = []
    try:
        ss = z.read("xl/sharedStrings.xml").decode("utf-8")
        for si in re.findall(r"<si>(.*?)</si>", ss, re.S):
            shared.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
    except KeyError:
        pass

    for name in z.namelist():
        if not name.startswith("xl/worksheets/sheet"):
            continue
        xml = z.read(name).decode("utf-8")
        out.append(f"\n--- {name}")
        for row in re.findall(r"<row[^>]*r=\"(\d+)\"[^>]*>(.*?)</row>", xml, re.S)[:8]:
            cells = []
            for ref, attrs, inner in re.findall(r"<c[^>]*r=\"([A-Z]+\d+)\"([^>]*)>(.*?)</c>", row[1], re.S):
                t = re.search(r't="([^"]+)"', attrs)
                v = re.search(r"<v>(.*?)</v>", inner, re.S)
                val = v.group(1) if v else ""
                if t and t.group(1) == "s" and val.isdigit():
                    val = shared[int(val)]
                elif t and t.group(1) == "inlineStr":
                    val = "".join(re.findall(r"<t[^>]*>(.*?)</t>", inner, re.S))
                val = html.unescape(val)
                if val != "":
                    cells.append(f"{ref}={val}")
            if cells:
                out.append(f"  row{row[0]}: " + " | ".join(cells))

    try:
        c = z.read("xl/comments1.xml").decode("utf-8")
        out.append("\n--- 셀 주석 (필드 규격)")
        for m in re.finditer(r"<comment ref=\"([A-Z]+\d+)\"[^>]*>(.*?)</comment>", c, re.S):
            ref, body = m.group(1), m.group(2)
            txt = "".join(re.findall(r"<t[^>]*>(.*?)</t>", body, re.S))
            txt = html.unescape(txt)
            txt = re.sub(r"<[^>]+>", "", txt)
            out.append(f"  {ref} :: " + " / ".join(x.strip() for x in txt.split("\n") if x.strip()))
    except KeyError:
        out.append("  (주석 없음)")

    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    text = dump(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"written: {sys.argv[2]}")
    else:
        print(text)
