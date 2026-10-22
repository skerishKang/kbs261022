"""통합 상품 마스터 CLI.

사용 예시
--------
    python -m tools.product_master.cli build-sample --dump reports/data/_browser_dump_samasound.json ...
    python -m tools.product_master.cli validate --records reports/data/product_master_sample.json
    python -m tools.product_master.cli dedupe --records reports/data/product_master_sample.json
    python -m tools.product_master.cli collect --site samamusic --cate-no 671 --pages 2
    python -m tools.product_master.cli crosscheck --browser ... --http ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

from . import build_records as BR
from . import crosscheck as CC
from . import dedupe as DD
from . import schema as SC
from . import validate as VA


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_dumps(paths: Sequence[str]) -> list[Mapping[str, Any]]:
    out: list[Mapping[str, Any]] = []
    for path in paths:
        payload = _read_json(path)
        if isinstance(payload, list):
            out.extend(payload)
        else:
            out.extend(payload.get("records") or payload.get("dumps") or [])
    return out


def cmd_build_sample(args: argparse.Namespace) -> int:
    dumps = _load_dumps(args.dump)
    records = BR.build_records(
        dumps,
        extraction_time=args.extraction_time or _now_iso(),
        extraction_method=args.method,
        verification_status=args.status,
    )
    os.makedirs(os.path.dirname(os.path.abspath(args.out_json)) or ".", exist_ok=True)
    SC.write_json(records, args.out_json)
    count = SC.write_csv(records, args.out_csv)
    print(f"records={len(records)} json={args.out_json} csv={args.out_csv} csv_rows={count}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    records = SC.load_json(args.records)
    result = VA.validate_dataset(records)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
    print(VA.format_report(result))
    return 0 if result["ok"] else 1


def cmd_dedupe(args: argparse.Namespace) -> int:
    records = SC.load_json(args.records)
    candidates = DD.find_candidates(records)
    groups = DD.build_groups(records, candidates)

    counts: dict[str, int] = {}
    for candidate in candidates:
        counts[candidate.verdict] = counts.get(candidate.verdict, 0) + 1

    same_site = DD.find_same_site_duplicates(records)

    print("=== 교차 사이트 중복 후보 ===")
    print(f"records={len(records)} candidates={len(candidates)}")
    for verdict in DD.VERDICTS:
        if verdict in counts:
            print(f"  {verdict}: {counts[verdict]}")
    print(f"자동 병합 그룹 수: {len(groups)}")
    for gid, members in sorted(groups.items()):
        print(f"  {gid} -> {', '.join(members)}")
    if same_site:
        print("같은 사이트 복합키 중복:")
        for a, b in same_site:
            print(f"  {a} / {b}")

    if args.json_out:
        payload = {
            "record_count": len(records),
            "verdict_counts": counts,
            "group_count": len(groups),
            "groups": {k: list(v) for k, v in groups.items()},
            "same_site_duplicates": same_site,
            "candidates": [c.to_dict() for c in candidates],
        }
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)

    if args.apply_groups:
        updated = DD.apply_groups(records, groups)
        SC.write_json(updated, args.records)
        SC.write_csv(updated, args.out_csv or args.records.replace(".json", ".csv"))
        print(f"dedupe_group_id 기록 완료 -> {args.records}")
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    from . import collect_http as CH

    client = CH.HttpClient(
        user_agent=args.user_agent, delay=args.delay, respect_robots=not args.ignore_robots
    )
    dumps: list[dict[str, Any]] = []

    if args.from_dump:
        # 브라우저 덤프와 *같은 URL* 을 HTTP 로 다시 가져와 교차 검증에 쓴다.
        for entry in _load_dumps(args.from_dump):
            url = entry.get("collection_url") or entry.get("final_url")
            if not url:
                continue
            result = client.get_with_retry(url)
            if not result.ok:
                print(f"collect_failed url={url} status={result.status} error={result.error}")
                continue
            dumps.append(
                CH.parse_detail(
                    result.text,
                    entry["site"],
                    product_id=str(entry["source_product_id"]),
                    collection_url=url,
                    final_url=url,
                )
            )
            print(
                f"collected site={entry['site']} product_no={entry['source_product_id']} "
                f"fields={len(dumps[-1]['raw_fields'])}"
            )
    else:
        for spec in args.target:
            site, product_no = spec.split(":", 1)
            slug = None
            cate_no = ""
            if "," in product_no:
                product_no, extra = product_no.split(",", 1)
                parts = extra.split("|")
                slug = parts[0] or None
                cate_no = parts[1] if len(parts) > 1 else ""
            dump = CH.collect_detail(
                client, site, product_no, slug=slug, cate_no=cate_no, display="1"
            )
            if dump is None:
                print(f"collect_failed site={site} product_no={product_no}")
                continue
            dumps.append(dump)
            print(f"collected site={site} product_no={product_no} fields={len(dump['raw_fields'])}")

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(dumps, fh, ensure_ascii=False, indent=2)
    print(f"dumps={len(dumps)} out={args.out} requests={len(client.request_log)}")
    for entry in client.request_log:
        if entry.get("status") != 200:
            print(f"  non-200: {entry}")
    return 0


def cmd_crosscheck(args: argparse.Namespace) -> int:
    browser_records = SC.load_json(args.browser)
    http_records = SC.load_json(args.http)
    comparisons = CC.compare_records(browser_records, http_records)
    report = CC.format_report(comparisons)
    print(report)
    if args.json_out:
        payload = {
            "summary": CC.summarize(comparisons),
            "records": [c.to_dict() for c in comparisons],
        }
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
    return 0 if CC.summarize(comparisons)["mismatched_records"] == 0 else 1


def cmd_schema(args: argparse.Namespace) -> int:
    schema = SC.json_schema()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(schema, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"schema={args.out} version={SC.SCHEMA_VERSION}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="product_master", description="CGI 통합 상품 마스터 도구")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build-sample", help="브라우저 덤프 → 마스터 레코드")
    p.add_argument("--dump", action="append", required=True, help="브라우저 원시 덤프 JSON (반복 가능)")
    p.add_argument("--out-json", default="reports/data/product_master_sample.json")
    p.add_argument("--out-csv", default="reports/data/product_master_sample.csv")
    p.add_argument("--extraction-time", default=None)
    p.add_argument("--method", default="browser_zcode_iab")
    p.add_argument("--status", default="browser_verified")
    p.set_defaults(func=cmd_build_sample)

    p = sub.add_parser("validate", help="마스터 레코드 검증")
    p.add_argument("--records", default="reports/data/product_master_sample.json")
    p.add_argument("--json-out", default=None)
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("dedupe", help="교차 사이트 중복 후보 탐지")
    p.add_argument("--records", default="reports/data/product_master_sample.json")
    p.add_argument("--json-out", default="reports/data/dedupe_report.json")
    p.add_argument("--apply-groups", action="store_true", help="dedupe_group_id 를 레코드에 기록")
    p.add_argument("--out-csv", default=None)
    p.set_defaults(func=cmd_dedupe)

    p = sub.add_parser("collect", help="HTTP 로 상세페이지 수집")
    p.add_argument(
        "--target",
        action="append",
        default=[],
        help="site:product_no[,slug|cate_no] (예: samamusic:5564,|671)",
    )
    p.add_argument(
        "--from-dump",
        action="append",
        default=[],
        help="브라우저 덤프 JSON — 같은 URL 을 HTTP 로 다시 수집",
    )
    p.add_argument("--out", default="reports/data/_http_dump.json")
    p.add_argument("--delay", type=float, default=1.2)
    p.add_argument("--user-agent", default=CH_DEFAULT_UA)
    p.add_argument("--ignore-robots", action="store_true")
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("crosscheck", help="브라우저 ↔ HTTP 교차 검증")
    p.add_argument("--browser", required=True)
    p.add_argument("--http", required=True)
    p.add_argument("--json-out", default="reports/data/crosscheck_report.json")
    p.set_defaults(func=cmd_crosscheck)

    p = sub.add_parser("schema", help="JSON Schema 출력")
    p.add_argument("--out", default="schemas/product-master-record.schema.json")
    p.set_defaults(func=cmd_schema)

    return parser


CH_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
