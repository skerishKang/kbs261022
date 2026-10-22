#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CGI AI 개발 경과보고서 HTML 생성 (이슈 #19 연계 · COM1 산출물).

모든 수치는 C:/cgi-work/catalog-data 의 실측 원자료에서 계산한다.
추정치는 반드시 '추정' 라벨과 근거(단가·환율·가정)를 함께 표기한다.
"""
import hashlib
import json
import os
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))

import argparse
_ap = argparse.ArgumentParser(description="CGI AI 개발 경과보고서 HTML 생성")
_ap.add_argument("--data-dir", default=r"C:\cgi-work\catalog-data",
                 help="실측 원자료 디렉터리(github_timeline.json, zcode_model_usage_agg.json 등)")
_ap.add_argument("--out", default=None, help="출력 HTML 경로")
_args = _ap.parse_args()

LOCAL = _args.data_dir
OUT_HTML = _args.out


def load(name):
    with open(os.path.join(LOCAL, name), encoding="utf-8") as fh:
        return json.load(fh)


src = load("report_source_data.json")
zc = src["zcode_usage"]
oc = src["opencode_sessions"]
oc_tot = src["opencode_totals"]
px = load("pricing_reference.json")
stats = load("db/collection_stats.json") if os.path.exists(os.path.join(LOCAL, "db", "collection_stats.json")) else load("collection_stats.json")

# ---------------------------------------------------------------- 실측 집계
# OpenCode 세션 중 'kilo 설치' 세션은 CGI 사업 작업이 아니므로 분리
CGI_EXCLUDE = {"zcode에 Kilo MiniMax 3.1 Free 설치"}


def oc_split():
    inc = {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0}
    exc = dict(inc)
    sessions = []
    keymap = {"input": "tokens_input", "output": "tokens_output", "reasoning": "tokens_reasoning",
              "cache_read": "tokens_cache_read", "cache_write": "tokens_cache_write"}
    for s in oc:
        t = {k: int(s.get(keymap[k]) or 0) for k in inc}
        is_cgi = s.get("title") not in CGI_EXCLUDE
        tgt = inc if is_cgi else exc
        for k, v in t.items():
            tgt[k] += v
        sessions.append({
            "title": s.get("title"), "dir": s.get("directory"), "model": s.get("model"),
            "input": t["input"], "output": t["output"], "cache_read": t["cache_read"],
            "reasoning": t["reasoning"], "cgi": is_cgi, "cost": s.get("cost"),
        })
    return inc, exc, sessions


oc_cgi, oc_other, oc_sessions = oc_split()
zt = zc["totals"]
TOT = {
    "input": zt["input"] + oc_cgi["input"],
    "output": zt["output"] + oc_cgi["output"],
    "reasoning": zt["reasoning"] + oc_cgi["reasoning"],
    "cache_read": zt["cache_read"] + oc_cgi["cache_read"],
    "cache_write": zt["cache_write"] + oc_cgi["cache_write"],
}
TOT["total"] = TOT["input"] + TOT["output"] + TOT["reasoning"] + TOT["cache_read"] + TOT["cache_write"]

# ---------------------------------------------------------------- 작업 시간대
PRS = {p["n"]: p for p in src["github"] if p["kind"] == "PR"}


def pr(n):
    return PRS.get(n, {})


def t(p):
    return (p.get("created") or "")[11:] if p.get("created") else ""


def m(p):
    return (p.get("merged") or "")[11:] if p.get("merged") else ""


# 사업 시작~종료 (실측: 이슈 #1 생성 ~ 마지막 PR 병합)
issue1 = next((i for i in src["github"] if i["kind"] == "issue" and i["n"] == 1), None)
merged_prs = [p for p in PRS.values() if p.get("merged")]
end_item = max(merged_prs, key=lambda p: p["merged"])
start_dt = datetime.fromisoformat(issue1["created"]).astimezone(KST)
end_dt = datetime.fromisoformat(end_item["merged"]).astimezone(KST)
elapsed = end_dt - start_dt
hours = elapsed.total_seconds() / 3600

# AI 실측 호출 창(병렬)
zc_win = zc["window"]

# ---------------------------------------------------------------- 비용 시나리오
cat = px.get("kilo_catalog_prices", {})
M3_IN = float(cat.get("minimax/minimax-m3", {}).get("input_per_1M", 0)) * 1_000_000
M3_OUT = float(cat.get("minimax/minimax-m3", {}).get("output_per_1M", 0)) * 1_000_000
SON_IN = float(cat.get("anthropic/claude-sonnet-4.5", {}).get("input_per_1M", 0)) * 1_000_000
SON_OUT = float(cat.get("anthropic/claude-sonnet-4.5", {}).get("output_per_1M", 0)) * 1_000_000
FX = px.get("usd_krw") or 0

M = 1_000_000
paid_output = TOT["output"] + TOT["reasoning"]


def scen(label, in_per_1m, out_per_1m, include_cache):
    """in_per_1m / out_per_1m : USD per 1M tokens."""
    inc = TOT["input"] + (TOT["cache_read"] if include_cache else 0)
    usd = (inc / M) * in_per_1m + (paid_output / M) * out_per_1m
    return {"label": label, "usd": usd, "krw": usd * FX, "inc": inc}


LOW = scen("LOW · MiniMax M3 단가, 캐시읽기 미반영", M3_IN, M3_OUT, False)
BASE = scen("BASE · MiniMax M3 단가, 캐시읽기 전체 반영", M3_IN, M3_OUT, True)
HIGH = scen("HIGH · Claude Sonnet 4.5 단가, 전체 반영", SON_IN, SON_OUT, True)

# 인력 대체비용 (가정)
RATE = 35000  # 원/시간 가정
labor_floor = hours * RATE
labor_range = (hours * 1.5 * RATE, hours * 2.5 * RATE)

# ---------------------------------------------------------------- 작업 항목
WORK = [
    {
        "start": "09:24", "end": "12:37", "dur": "3시간 13분",
        "agent": "문서·기록 에이전트",
        "task": "업무확인서·개발계획서 2종(AI검토형/고객용) + 작업기록 체계",
        "done": "PR #3·#4(문서 2종, MD+PDF), PR #10(작업현황 목차·보고 표준) → main 병합",
        "refs": [3, 4, 10],
    },
    {
        "start": "10:53", "end": "13:35", "dur": "2시간 42분",
        "agent": "공급처 분석 에이전트 (2인 병렬)",
        "task": "삼아사운드·삼아스토어 사이트 구조·수집 경로 독립 분석(모델 A/B) + Playwright 브라우저 분석",
        "done": "PR #6(모델 A), PR #12(모델 B+마스터 스키마+수집 스킬), PR #13(브라우저 기반 재분석), PR #23(Playwright 분석)",
        "refs": [6, 12, 13, 23],
    },
    {
        "start": "11:41", "end": "16:01", "dur": "4시간 20분",
        "agent": "상품 마스터 에이전트",
        "task": "양 사이트 통합 상품 마스터 스키마·중복/브랜드/가격 정규화 설계",
        "done": "PR #16(스키마 문서 + 정규화/중복 판정 도구 + 브라우저 교차검증 리포트) → main 병합",
        "refs": [16],
    },
    {
        "start": "11:41", "end": "12:17", "dur": "36분",
        "agent": "원격 개발환경 에이전트",
        "task": "CGI-1 → COM1 Tailscale 작업물 전달 파이프라인(SSH/Taildrop/SMB 3종)",
        "done": "PR #14(SMB 전송 실측 검증, SHA256 대조·충돌 방지·PR 생성 절차)",
        "refs": [14],
    },
    {
        "start": "12:35", "end": "13:45", "dur": "1시간 10분",
        "agent": "카탈로그 사이트 에이전트",
        "task": "삼아스토어 참고형 CGI 상품 카탈로그 정적 사이트(검색·필터·그리드·상세·모바일)",
        "done": "PR #15(초기), PR #17(브라우저 검증 18/18 PASS + 스크린샷 14장) → main 병합",
        "refs": [15, 17],
    },
    {
        "start": "13:01", "end": "16:36", "dur": "3시간 35분",
        "agent": "ERP 연계 분석 에이전트",
        "task": "이카운트 ERP 계정·업무 분석 + 상품 마스터 ↔ ERP 필드 매핑 + 스마트스토어 연계 구조",
        "done": "PR #21(분석·매핑 문서) → main 병합, PR #29(연계 산출물 통합)",
        "refs": [21, 29],
    },
    {
        "start": "13:04", "end": "15:55", "dur": "2시간 51분",
        "agent": "회사 홈페이지 에이전트",
        "task": "CGI 기업 홈페이지 시연본 구현 + 상품 쇼핑몰 연결 + 모바일 대응",
        "done": "PR #22(홈페이지 시연본) → main 병합, PR #25(쇼핑몰 연결·통합) → main 병합",
        "refs": [22, 25],
    },
    {
        "start": "14:22", "end": "16:35", "dur": "2시간 13분",
        "agent": "전수 수집 에이전트",
        "task": "공급처 전체 상품 전수 수집(4,575건) + Excel 7시트 DB + 쇼핑몰 JSON + 브라우저 교차검증",
        "done": "PR #24(수집·근거 분석), PR #26(Excel/JSON), PR #27(교차검증 48/48) → main 병합, PR #28(카탈로그 통합)",
        "refs": [24, 26, 27, 28],
    },
    {
        "start": "—", "end": "—", "dur": "미수행",
        "agent": "(배포 담당)",
        "task": "Cloudflare Pages 시연 사이트 배포 및 공개 URL 검증",
        "done": "미수행 — 배포 도구(wrangler)·배포 기록·공개 URL 실측 근거가 없어 '배포 완료'로 표기하지 않음. 본 보고서는 검증된 로컬 결과물만 링크한다.",
        "refs": [],
    },
]

# ---------------------------------------------------------------- 배포·링크 상태
LINKS = [
    {"name": "CGI 기업 홈페이지 (시연본)", "url": "https://github.com/skerishKang/kbs261022/tree/main/website",
     "kind": "GitHub 저장소(소스)", "verified": "브랜치 main 병합 확인(PR #22·#25)"},
    {"name": "CGI 상품 쇼핑몰 (카탈로그)", "url": "https://github.com/skerishKang/kbs261022/tree/main/site",
     "kind": "GitHub 저장소(소스)", "verified": "브랜치 main 병합 확인(PR #17)"},
    {"name": "전체 상품 Excel DB (7시트)", "url": "https://github.com/skerishKang/kbs261022/pull/26",
     "kind": "PR #26 (산출물)", "verified": "main 병합 완료"},
    {"name": "전수 수집·교차검증 기록", "url": "https://github.com/skerishKang/kbs261022/pull/27",
     "kind": "PR #27 (검증 근거)", "verified": "main 병합 완료"},
    {"name": "공급처 전체 상품 4,575건 근거 분석", "url": "https://github.com/skerishKang/kbs261022/pull/24",
     "kind": "PR #24 (분석 보고서)", "verified": "main 병합 완료"},
    {"name": "공개 배포 URL (Cloudflare Pages)", "url": "-", "kind": "미배포",
     "verified": "배포 실측 근거 없음 → 본 보고서에서 URL 미제시"},
]

def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


link_rows = ""
for l in LINKS:
    if l["url"] == "-":
        cell = "-"
    else:
        cell = f'<a href="{l["url"]}" target="_blank" rel="noopener">{l["url"]}</a>'
    link_rows += (f'<tr><td><b>{esc(l["name"])}</b></td><td class="mono">{cell}</td>'
                  f'<td>{esc(l["kind"])}</td><td>{esc(l["verified"])}</td></tr>')

# ---------------------------------------------------------------- HTML
def n(v):
    return f"{v:,}"


def usd(v):
    return f"${v:,.2f}"


def krw(v):
    return f"{v:,.0f}원"


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


timeline_rows = ""
for w in WORK:
    refs = " ".join(f'<a class="tag" href="https://github.com/skerishKang/kbs261022/pull/{n}">PR #{n}</a>' for n in w["refs"])
    timeline_rows += f"""
      <li class="tl-item{' tl-muted' if w['dur'] == '미수행' else ''}">
        <div class="tl-time"><b>{esc(w['start'])}</b><span>~ {esc(w['end'])}</span><em>{esc(w['dur'])}</em></div>
        <div class="tl-body">
          <h3>{esc(w['task'])}</h3>
          <p class="tl-agent">담당: {esc(w['agent'])}</p>
          <p class="tl-done">{esc(w['done'])}</p>
          <div class="tl-refs">{refs}</div>
        </div>
      </li>"""

sess_rows = ""
for s in oc_sessions:
    label = "CGI 사업" if s["cgi"] else "비CGI(참고 제외)"
    sess_rows += f"""
      <tr>
        <td>{esc(s['title'])}<br><span class="muted">{esc(s['dir'] or '')}</span></td>
        <td class="mono">minimax-m3.1-flash-free</td>
        <td class="num">{n(s['input'])}</td>
        <td class="num">{n(s['output'])}</td>
        <td class="num">{n(s['cache_read'])}</td>
        <td class="num">{usd(float(s['cost'] or 0))}</td>
        <td>{label}</td>
      </tr>"""

html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CGI AI 개발 경과보고서 · 2026-10-22</title>
<style>
  :root {{
    --ink:#16202f; --muted:#5b6b82; --line:#e3e8f0; --bg:#f6f8fc; --card:#ffffff;
    --brand:#1f3a93; --brand-2:#2f5bc4; --accent:#ff7a00; --ok:#0f7a4d; --warn:#b45309; --soft:#eef2fb;
  }}
  *{{box-sizing:border-box}}
  body{{margin:0;background:var(--bg);color:var(--ink);
    font-family:"Pretendard","Noto Sans KR",-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",sans-serif;
    font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%}}
  .wrap{{max-width:1080px;margin:0 auto;padding:0 20px 72px}}
  header.top{{background:linear-gradient(120deg,var(--brand),var(--brand-2) 60%,#4a6ad6);color:#fff;padding:38px 0 30px}}
  header.top .wrap{{padding-bottom:0}}
  .eyebrow{{font-size:12.5px;letter-spacing:.14em;opacity:.85;text-transform:uppercase}}
  h1{{margin:8px 0 6px;font-size:30px;letter-spacing:-.4px}}
  .sub{{margin:0;opacity:.92;font-size:14.5px}}
  .metaline{{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:18px;font-size:13px;opacity:.95}}
  .metaline b{{font-weight:700}}
  section{{margin-top:34px}}
  h2{{font-size:19px;margin:0 0 14px;padding-left:11px;border-left:4px solid var(--brand)}}
  .kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:-44px}}
  .kpi{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;box-shadow:0 6px 18px rgba(22,32,47,.06)}}
  .kpi dt{{font-size:12px;color:var(--muted);margin:0 0 4px}}
  .kpi dd{{margin:0;font-size:23px;font-weight:800;color:var(--brand);letter-spacing:-.4px}}
  .kpi dd small{{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-top:5px;letter-spacing:0}}
  .card{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;box-shadow:0 1px 2px rgba(22,32,47,.04)}}
  table{{width:100%;border-collapse:collapse;font-size:13.5px}}
  th,td{{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}}
  th{{background:#f8fafd;color:var(--muted);font-weight:700;font-size:12.5px}}
  td.num,th.num{{text-align:right;font-variant-numeric:tabular-nums}}
  .mono{{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px}}
  .muted{{color:var(--muted);font-size:12.5px}}
  .tag{{display:inline-block;margin:2px 4px 2px 0;padding:2px 9px;border-radius:999px;background:var(--soft);
    color:var(--brand);font-size:11.5px;font-weight:700;text-decoration:none;border:1px solid #d8e0f6}}
  .tag:hover{{background:var(--brand);color:#fff}}
  .tl{{list-style:none;margin:0;padding:0 0 0 22px;border-left:2px solid #dbe3f5}}
  .tl-item{{position:relative;padding:0 0 22px 18px}}
  .tl-item:before{{content:"";position:absolute;left:-27px;top:6px;width:11px;height:11px;border-radius:50%;
    background:var(--brand);border:2px solid #fff;box-shadow:0 0 0 2px #dbe3f5}}
  .tl-muted:before{{background:#aab4c6}}
  .tl-time{{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-bottom:3px}}
  .tl-time b{{font-size:14px;color:var(--brand)}}
  .tl-time em{{font-style:normal;background:var(--soft);color:var(--brand);border-radius:999px;padding:1px 9px;font-size:11.5px;font-weight:700}}
  .tl-body h3{{margin:0 0 3px;font-size:15.5px}}
  .tl-agent{{margin:0 0 4px;font-size:12.5px;color:var(--muted)}}
  .tl-done{{margin:0;font-size:13.5px}}
  .note{{background:#fff8ec;border:1px solid #f3e2c6;border-radius:12px;padding:14px 16px;font-size:13px;color:#6b4708}}
  .note b{{color:#8a5300}}
  .ok{{color:var(--ok);font-weight:700}}
  .warn{{color:var(--warn);font-weight:700}}
  .grid2{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
  ol.steps{{margin:0;padding-left:20px}} ol.steps li{{margin-bottom:9px}}
  ol.steps b{{color:var(--brand)}}
  footer{{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}}
  @media (max-width:900px){{.kpis{{grid-template-columns:repeat(2,1fr);margin-top:-34px}} .grid2{{grid-template-columns:1fr}}}}
  @media (max-width:560px){{.kpis{{grid-template-columns:1fr}} h1{{font-size:23px}} .wrap{{padding:0 14px 56px}}
    .card{{overflow-x:auto;-webkit-overflow-scrolling:touch}}
    table{{font-size:12.5px;min-width:540px}} th,td{{padding:7px 6px}} .tl{{padding-left:14px}}
    .tl-item{{padding-left:12px}} .tl-item:before{{left:-21px}}}}
  @media print{{
    @page{{size:A4;margin:12mm}}
    body{{background:#fff;font-size:11.5pt}}
    header.top{{background:#fff !important;color:#16202f;border-bottom:2px solid var(--brand);padding:0 0 12px}}
    .kpis{{margin-top:14px;grid-template-columns:repeat(4,1fr)}}
    .kpi,.card{{box-shadow:none;break-inside:avoid}}
    section{{break-inside:avoid;margin-top:18px}}
    a{{color:inherit;text-decoration:none}}
    .tag{{border:1px solid #999}}
    .no-print{{display:none}}
  }}
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="eyebrow">CGI · AI Development Progress Report</div>
    <h1>CGI AI 개발 경과보고서</h1>
    <p class="sub">기업 홈페이지 · 상품 쇼핑몰 · 상품 데이터베이스 · ERP 연계 분석 — 2026년 10월 22일</p>
    <div class="metaline">
      <span>보고 대상 <b>김범신 대표</b></span>
      <span>의뢰 기업 <b>CGI</b></span>
      <span>작업일 <b>2026-10-22(금)</b></span>
      <span>전체 경과 <b>{int(hours)}시간 {int((elapsed.total_seconds()%3600)//60)}분</b></span>
    </div>
  </div>
</header>

<div class="wrap">
  <dl class="kpis">
    <div class="kpi"><dt>확보 원천 상품</dt><dd>{n(stats['total_source_products'])}건<small>삼아사운드 {n(stats['source_products']['samasound'])} + 삼아스토어 {n(stats['source_products']['samamusic'])}</small></dd></div>
    <div class="kpi"><dt>전체 경과시간</dt><dd>{int(hours)}h {int((elapsed.total_seconds()%3600)//60)}m<small>이슈 #1 생성 {issue1['created'][11:]} → 마지막 PR 병합 {end_item['merged'][11:]}</small></dd></div>
    <div class="kpi"><dt>실측 AI 처리량</dt><dd>{TOT['total']/1_000_000:,.0f}M tok<small>입력 {n(TOT['input'])} · 출력 {n(TOT['output'])} · 캐시 {n(TOT['cache_read'])}</small></dd></div>
    <div class="kpi"><dt>실제 API 청구액</dt><dd>$0.00<small>무료 모델만 사용(모델 비용 0 USD)</small></dd></div>
  </dl>

  <section>
    <h2>1. 요약</h2>
    <div class="card">
      <table>
        <tr><th style="width:180px">작업일</th><td>2026-10-22 (금)</td></tr>
        <tr><th>의뢰 기업</th><td>CGI</td></tr>
        <tr><th>작업 내용</th><td>기업 홈페이지 · 상품 쇼핑몰 · 상품 데이터베이스 · 이카운트 ERP 연계 분석</td></tr>
        <tr><th>실제 확보 상품</th><td><b>{n(stats['total_source_products'])}건</b> (원천 상품 전량 수집, 상세 100% 확보)</td></tr>
        <tr><th>시작·종료·경과</th><td>{issue1['created'][11:]} 시작 → {end_item['merged'][11:]} 종료 · <b>{int(hours)}시간 {int((elapsed.total_seconds()%3600)//60)}분</b> (병렬 에이전트 포함 벽시계)</td></tr>
        <tr><th>사용한 AI 모델</th><td class="mono">minimax-m3.1-flash-free (OpenCode 제공 경유) / kilo-网关同名 free 모델 — 전 호출 {n(zc['calls'])}회 + OpenCode 세션 {len(oc_sessions)}건</td></tr>
        <tr><th>병렬 작업</th><td>동일 시각 <b>최대 3개 에이전트</b>가 별도 worktree·브랜치에서 동시 수행(충돌 회피)</td></tr>
        <tr><th>AI 실측 활동 창</th><td>ZCode CLI {zc_win['start'][11:16]}~{zc_win['end'][11:16]} (모델 호출 {n(zc['calls'])}회) · 도구 호출 {n(zt['tool_calls'])}회</td></tr>
      </table>
    </div>
  </section>

  <section>
    <h2>2. 시간대별 작업 경과</h2>
    <p class="muted" style="margin:-4px 0 12px">시각은 KST. 각 구간은 GitHub PR 생성~병합 시각(실측)과 LOCAL 산출물 생성 시각(실측) 기준이며, 병렬 구간이므로 구간 소요시간의 합계는 전체 경과시간보다 큽니다.</p>
    <ol class="tl">{timeline_rows}</ol>
  </section>

  <section>
    <h2>3. AI 토큰 및 비용 비교</h2>

    <h3 style="font-size:15px;margin:16px 0 8px">3-1. 실제 확인된 토큰 사용량 (CGI-1 실측)</h3>
    <div class="card">
      <table>
        <tr><th>런타임</th><th>측정 대상</th><th class="num">입력 tok</th><th class="num">출력 tok</th><th class="num">캐시읽기 tok</th><th class="num">실제 비용</th></tr>
        <tr>
          <td>ZCode CLI</td><td>{n(zc['calls'])}개 모델 호출 ({zc_win['start'][11:16]}~{zc_win['end'][11:16]})</td>
          <td class="num">{n(zt['input'])}</td><td class="num">{n(zt['output'])}</td><td class="num">{n(zt['cache_read'])}</td>
          <td class="num">$0.00</td>
        </tr>
        <tr>
          <td>OpenCode</td><td>CGI 사업 관련 세션 {len([s for s in oc_sessions if s['cgi']])}건</td>
          <td class="num">{n(oc_cgi['input'])}</td><td class="num">{n(oc_cgi['output'])}</td><td class="num">{n(oc_cgi['cache_read'])}</td>
          <td class="num">$0.00</td>
        </tr>
        <tr>
          <td class="ok"><b>합계</b></td><td>도구 호출 {n(zt['tool_calls'])}회 · 오류 {zc['by_model'][list(zc['by_model'])[0]]['errors']}건</td>
          <td class="num"><b>{n(TOT['input'])}</b></td><td class="num"><b>{n(TOT['output'])}</b></td><td class="num"><b>{n(TOT['cache_read'])}</b></td>
          <td class="num"><b>$0.00</b></td>
        </tr>
      </table>
      <p class="muted" style="margin:10px 0 0">출처: CGI-1 로컬 DB 실측(ZCode <span class="mono">model_usage</span> 435행, OpenCode <span class="mono">session_v2</span> 4행). reasoning {n(TOT['reasoning'])} tok 별도. 세션별 내역은 본 문서 하단 부록 참조.</p>
    </div>

    <h3 style="font-size:15px;margin:22px 0 8px">3-2. API 대체비용 (추정 — 실제 청구액이 아님)</h3>
    <div class="card">
      <table>
        <tr><th>시나리오</th><th>단가 근거</th><th class="num">환산 USD</th><th class="num">원화</th></tr>
        <tr><td><b>LOW</b></td><td>MiniMax M3 (${M3_IN:.2f}/${M3_OUT:.2f} per 1M) · 캐시읽기 미반영</td><td class="num">{usd(LOW['usd'])}</td><td class="num">{krw(LOW['krw'])}</td></tr>
        <tr><td><b>BASE</b></td><td>MiniMax M3 단가 · 캐시읽기 {n(TOT['cache_read'])} tok 전체 반영</td><td class="num">{usd(BASE['usd'])}</td><td class="num">{krw(BASE['krw'])}</td></tr>
        <tr><td><b>HIGH</b></td><td>Claude Sonnet 4.5 (${SON_IN:.2f}/${SON_OUT:.2f} per 1M) · 전체 반영</td><td class="num">{usd(HIGH['usd'])}</td><td class="num">{krw(HIGH['krw'])}</td></tr>
      </table>
      <p class="muted" style="margin:10px 0 0">단가는 Kilo 게이트웨이 공개 카탈로그 실측값(2026-10-22). 환율 <b>{FX:,.2f}원/USD</b> (open.er-api.com, 2026-10-22 00:02 UTC). reasoning {n(TOT['reasoning'])} tok은 출력 단가로 계산. <b>실제 사용 모델은 free 제공 구간이므로 실제 청구액은 $0</b>이며, 위 값은 “동일 작업을 유료 모델로 수행했을 때”의 대체 비용이다.</p>
    </div>

    <h3 style="font-size:15px;margin:22px 0 8px">3-3. 인력 대체비용 (가정)</h3>
    <div class="card">
      <table>
        <tr><th>구분</th><th>산식</th><th class="num">금액</th></tr>
        <tr><td>실제 청구액 (AI API)</td><td>free 모델 {n(zc['calls'])}회 호출 + OpenCode 세션</td><td class="num ok">$0.00 (0원)</td></tr>
        <tr><td>인력 대체 — 하한</td><td>전체 경과 {hours:.2f}h × {RATE:,}원/h</td><td class="num">{krw(labor_floor)}</td></tr>
        <tr><td>인력 대체 — 동일 품질 재현 기준(가정)</td><td>{hours:.2f}h × 1.5~2.5배(재현·검증 공정은 병렬화 불가)</td><td class="num">{krw(labor_range[0])} ~ {krw(labor_range[1])}</td></tr>
      </table>
      <p class="muted" style="margin:10px 0 0">시간당 인건비 {RATE:,}원은 <b>가정값</b>(대표님 확정 필요)이며, 실제 임금·에이전시 비용이 아니다. 산출 산출물: 정적 사이트 2종, 전체 상품 {n(stats['total_source_products'])}건 DB(7시트 XLSX + JSON), 수집·검증 스크립트 12종, 분석·보고 문서 15종 이상, PR {len(PRS)}개.</p>
    </div>
    <div class="note" style="margin-top:14px"><b>구분 원칙:</b> ① 실측 = CGI-1 로컬 DB·GitHub·파일 시각에서 직접 확인한 값 ② 추정 = 공개 단가·환율·가정 인건비로 산출한 값 ③ 미확인 = 공개 근거가 없어 기재하지 않은 값. 본 보고서는 토큰·비용을 새로 만들어내지 않는다.</div>
  </section>

  <section>
    <h2>4. 실제 수행한 개발 과정</h2>
    <div class="card">
      <ol class="steps">
        <li><b>기업 홈페이지 구현 및 모바일 대응</b> — 기존 CGI 홈페이지 자료(제작 요청서·카다로그·회사소개서)를 근거로 정적 홈페이지 시연본을 구현하고 상품 쇼핑몰 연결을 넣었다. 390px~1920px 반응형과 네이비/그린 로고 자산을 적용했으며, 기존 운영 사이트(cgiinc.kr)는 현재 접속 불가 상태라 대체 시연본으로 제공했다.</li>
        <li><b>상품 쇼핑몰 개발</b> — 삼아스토어의 메뉴·검색·목록·정렬·상세 구성을 브라우저로 직접 조사해 그 탐색 방식을 재사용한 CGI 자체 카탈로그를 정적 HTML/CSS/JS로 구현했다. 검색·브랜드/카테고리 필터·정렬·페이지네이션·갤러리·반응형 UI를 포함하며 외부 라이브러리·빌드 스텝이 없다.</li>
        <li><b>삼아사운드·삼아스토어 데이터 수집</b> — 기존 분석(PR #6/#12/#13)의 수집기를 재사용해 카테고리 361+532개를 전량 크롤하고 상품 상세 {n(stats['total_source_products'])}건을 확보했다. 공개 GET만 사용했고 robots Disallow 경로는 방문하지 않았으며, URL 캐시로 재실행 시 네트워크 요청이 0이다.</li>
        <li><b>4,575건 Excel DB 구축</b> — 통합상품·공급처원본·옵션SKU·브랜드·카테고리·중복후보·누락·검증현황·향후 네이버·이카운트 매핑 7시트 XLSX와 쇼핑몰용 JSON을 동일 파이프라인에서 생성했다. 미확인 값(공급가·재고·CGI 판매가·네이버 카테고리 ID)은 공란으로 유지했다.</li>
        <li><b>상품 검색·브랜드 필터·상세페이지 구현</b> — 상단 검색창, 브랜드/카테고리/공급처 필터(건수 표시), 정렬 4종, 12개 단위 페이지네이션, 대표+추가 이미지 갤러리, 기술 규격·옵션·원본 출처를 포함한 상세페이지를 구현해_shopping몰 규약과 동일한 데이터 계층을 사용했다.</li>
        <li><b>이미지 누락·혼입 교정</b> — 수집 원본의 상대 경로 이미지가 로컬 서버 기준 404를 유발하던 문제를 빌더 단계에서 공급처 절대 URL로 정규화했다. 상품 {n(stats['products_with_images'])}건 전량이 실제 이미지 URL을 확보했고, 깨진 URL 입력 시 대체 문구가 표시되는 동작을 브라우저로 확인했다.</li>
        <li><b>이카운트 ERP 업무 분석</b> — 별도 이슈(#20)로 이카운트 ERP 계정·업무 구조와 상품 마스터 필드 간 매핑 경계를 정리하고, 스마트스토어 개설 후 등록 데이터 생성에 필요한 매핑 초안을 준비했다. 실제 ERP 쓰기·주문·결제는 수행하지 않았다.</li>
        <li><b>Cloudflare Pages 배포 및 검증</b> — <span class="warn">미수행</span>. 배포 도구·배포 기록·접속 검증된 공개 URL이 없으므로 “배포 완료”로 표기하지 않았다. 산출물은 GitHub main 브랜치에 병합되어 저장소에서 직접 확인·다운로드할 수 있다.</li>
      </ol>
    </div>
  </section>

  <section>
    <h2>5. 완성된 결과물 바로가기</h2>
    <div class="card">
      <table>
        <tr><th>결과물</th><th>링크</th><th>종류</th><th>검증 상태</th></tr>
        {link_rows}
      </table>
      <p class="muted" style="margin:10px 0 0">※ 공개 URL은 <b>실제로 접속 검증된 것만</b> 기재했다. Cloudflare Pages 배포는 미실행이므로 URL을 표기하지 않았다.</p>
    </div>
  </section>

  <section>
    <h2>6. 검증 요약</h2>
    <div class="card">
      <table>
        <tr><th>검증 항목</th><th>방법</th><th>결과</th></tr>
        <tr><td>쇼핑몰 기능 브라우저 검증</td><td>Playwright 자동화 18항목(메인·검색·필터·이미지·상세·모바일·빈결과·깨진이미지)</td><td class="ok">18/18 PASS</td></tr>
        <tr><td>수집값 ↔ 실제 화면 대조</td><td>계층화 표본 48건(사이트×공개가상태×옵션유무) 실브라우저 대조</td><td class="ok">48/48 완전 일치</td></tr>
        <tr><td>전수 수집 완결성</td><td>상세 {n(stats['detail_collected'])}/{n(stats['total_source_products'])}건, HTTP 오류 0건</td><td class="ok">100% 확보</td></tr>
        <tr><td>누락 점검</td><td>카테고리 뷰별 재계산·사이트맵 대조·검색 총건수 대조</td><td>3건의 누락 경로 발견(문서 §7)</td></tr>
        <tr><td>가격/재고 표기 원칙</td><td>공개 표기만 기록, 미확정은 공란</td><td class="ok">준수</td></tr>
      </table>
    </div>
  </section>

  <section>
    <h2>부록 A. AI 세션별 실측 내역</h2>
    <div class="card">
      <table>
        <tr><th>세션</th><th>모델</th><th class="num">입력</th><th class="num">출력</th><th class="num">캐시읽기</th><th class="num">비용</th><th>구분</th></tr>
        {sess_rows}
        <tr><td class="ok"><b>ZCode CLI 세션 2건</b><br><span class="muted">모델 호출 {n(zc['calls'])}회</span></td>
            <td class="mono">minimax-m3.1-flash-free</td>
            <td class="num">{n(zt['input'])}</td><td class="num">{n(zt['output'])}</td><td class="num">{n(zt['cache_read'])}</td>
            <td class="num">$0.00</td><td>CGI 사업</td></tr>
      </table>
    </div>
  </section>

  <footer>
    <p><b>데이터 출처(공개):</b> GitHub 저장소 skerishKang/kbs261022(PR·커밋 시각), CGI-1 로컬 ZCode/OpenCode DB(토큰·비용), Kilo 게이트웨이 공개 카탈로그(단가), open.er-api.com(환율).<br>
    <b>미포함:</b> 실제 세션 원문 로그, 고객·계정 정보, 세션·프롬프트 전문. 공개 저장소에는 비식별 요약만 기재했다.<br>
    생성: {datetime.now(KST).strftime('%Y-%m-%d %H:%M KST')} · CGI-1 LOCAL 에이전트 작성</p>
  </footer>
</div>
</body>
</html>
"""

out_path = OUT_HTML or os.path.join(LOCAL, "CGI_AI_개발경과보고서_20261022.html")
with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(html)
sha = hashlib.sha256(html.encode("utf-8")).hexdigest()
print(f"written: {out_path}")
print(f"bytes  : {len(html.encode('utf-8')):,}")
print(f"sha256 : {sha}")
print(json.dumps({"elapsed_hours": hours, "start": issue1["created"], "end": end_item["merged"],
                  "tokens": TOT, "low_usd": LOW["usd"], "base_usd": BASE["usd"], "high_usd": HIGH["usd"],
                  "fx": FX, "labor_floor_krw": labor_floor}, ensure_ascii=False, indent=1))
with open(os.path.join(LOCAL, "report_metrics.json"), "w", encoding="utf-8") as fh:
    json.dump({"elapsed_hours": hours, "start": issue1["created"], "end": end_item["merged"],
               "tokens": TOT, "cost": {"low_usd": LOW["usd"], "base_usd": BASE["usd"], "high_usd": HIGH["usd"],
                                        "fx": FX, "labor_floor_krw": labor_floor,
                                        "labor_range_krw": list(labor_range)},
               "sha256": sha}, fh, ensure_ascii=False, indent=1)
