# cgiinc.co.kr 도메인 이전 준비 — DNS/호스팅 실시간 감사 보고서

## 1. 조사 개요

| 항목 | 내용 |
|---|---|
| 조사일 | **2026-10-26** (KST, 모든 UTC 타임스탬프는 `Date: Mon, 26 Oct 2026 …` 헤더로 확인) |
| 대상 | `cgiinc.co.kr` (주식회사 시지아이) 및 연결된 콘텐츠 호스트 |
| 방법 | **읽기 전용(read-only) 공개 질의만 사용** — `nslookup`, DNS-over-HTTPS(`dns.google/resolve`), `curl -sSI` / `curl -sS`(공개 HTTP GET), `ping -n 1`, `openssl s_client`(TLS handshake), 공개 RDAP(`rdap.apnic.net`, `rdap.nic.or.kr`, `rdap.org`) |
| 작업 머신 | Windows 10, Git Bash. cwd `E:\cgi1025-1\kbs261022` |
| 도구 가용성 | **있음**: `nslookup`, `curl 8.15.0`, `ping`, `python 3.11.0`, `openssl` <br> **없음**: `dig`, `whois`, `host` (`which` 결과 `no dig`, `no whois`, `no host`) → WHOIS는 **RDAP로 대체** 수행 |
| 세션 내 도구 실패 | `WebFetch` 사용 불가 (`Qoder API error: FORBIDDEN code 115`). 이 때문에 외부 프로바이더(Resend 등) 문서의 리터럴 값은 실시간 검증하지 못함 → §7에 TBD로 표시 |

> **무변경 확인 (명시)**
>本次 조사는 **DNS 레코드 추가/수정/삭제를 전혀 수행하지 않았고**, 대상 서버(121.254.178.250 / 117.52.91.239)에 **로그인하지 않았으며**, 파일을 업로드·수정·삭제하지 않았고, **임의의 설정 변경(写操作)을 하지 않았습니다.**
> 수행된 모든 요청은 공개 DNS 질의와 공개 HTTP GET/HEAD, TLS handshake, 공개 RDAP 조회뿐입니다. 저장소 내에서도 본 보고서 파일(과 그 디렉터리) 외에는 어떠한 파일도 수정하지 않았습니다.

---

## 2. DNS 레코드 현황

### 2.1 원본 증거 (`nslookup`, 로컬 리졸버 192.168.0.1)

```
C:\> nslookup cgiinc.co.kr
Name:    cgiinc.co.kr
Address:  121.254.178.250
```
→ **사전 확인된 A = 121.254.178.250 은 정확함(확정).** 추가 A 레코드는 없음(1개).

```
C:\> nslookup -type=ns cgiinc.co.kr
cgiinc.co.kr  nameserver = ns.gabia.co.kr
cgiinc.co.kr  nameserver = ns.gabia.net
cgiinc.co.kr  nameserver = ns1.gabia.co.kr

ns.gabia.co.kr   internet address = 43.201.170.100
ns.gabia.net     internet address = 121.78.117.39
ns.gabia.net     internet address = 211.234.124.90
ns1.gabia.co.kr  internet address = 20.200.205.248
```

```
C:\> nslookup -type=soa cgiinc.co.kr
cgiinc.co.kr
    primary name server = ns.gabia.co.kr.cgiinc.co.kr
    responsible mail addr = hosting.gabia.com
    serial  = 1475281817
    refresh = 1800 (30 mins)
    retry   = 600 (10 mins)
    expire  = 1209600 (14 days)
    default TTL = 86400 (1 day)
```

```
C:\> nslookup -type=mx cgiinc.co.kr   → (MX 없음, 응답 섹션 비어 SOA만 표시)
C:\> nslookup -type=txt cgiinc.co.kr  → (TXT 없음)
C:\> nslookup -type=aaaa cgiinc.co.kr → (AAAA 없음)
```

### 2.2 권한 응답 + TTL (Google DoH, `Comment`이 가비아 권한 NS IP를 지칭)

```
A     {"Answer":[{"name":"cgiinc.co.kr.","type":1,"TTL":21600,"data":"121.254.178.250"}],"Comment":"Response from 121.78.117.39."}
AAAA  Status:0, Answer 없음 → Authority에 SOA(NODATA)          TTL 1800
CNAME Status:0, Answer 없음 → Authority에 SOA(NODATA)          TTL 1800
MX    Status:0, Answer 없음 → Authority에 SOA(NODATA)          TTL 1800
TXT   Status:0, Answer 없음 → Authority에 SOA(NODATA)          TTL 1800
CAA   Status:0, Answer 없음 → Authority에 SOA(NODATA)          TTL 1800
NS    {"Answer":[...TTL 21600 ns1.gabia.co.kr / ns.gabia.net / ns.gabia.co.kr]}
SOA   ns.gabia.co.kr.cgiinc.co.kr. hosting.gabia.com. 1475281817 1800 600 1209600 86400   TTL 21600
```

### 2.3 레코드 요약표

| 구분 | 이름(Host) | 값 | TTL | 상태 |
|---|---|---|---|---|
| **A** | `cgiinc.co.kr` | `121.254.178.250` | 21600 (6h) | ✅ 존재 (유일) |
| **AAAA** | `cgiinc.co.kr` | — | — | ❌ 없음 (IPv6 미지원) |
| **CNAME** | `cgiinc.co.kr` (apex) | — | — | ❌ 없음 (apex라 불가/미사용) |
| **MX** | `cgiinc.co.kr` | **없음** | — | ❌ **존재하지 않음** |
| **TXT / SPF** | `cgiinc.co.kr` | **없음** | — | ❌ **SPF 미설정** |
| **TXT / DMARC** | `_dmarc.cgiinc.co.kr` | **없음** | — | ❌ **DMARC 미설정** (DoH NXDOMAIN, NS도 SOA만 반환) |
| **TXT / DKIM** | `mail._domainkey.cgiinc.co.kr` | 없음 | — | ❌ 없음 |
| **TXT** | `_acme-challenge.cgiinc.co.kr` | 없음 | — | ❌ 없음 (ACME DNS-01 이력 없음) |
| **TXT** | `google.com.cgiinc.co.kr`, `naver.com.cgiinc.co.kr`, `_spf` | 없음 | — | ❌ 없음 |
| **CAA** | `cgiinc.co.kr` | 없음 | — | ❌ 없음 → 인증서 발급사 제한 없음(이전 시 유리) |
| **NS** | `cgiinc.co.kr` | `ns.gabia.co.kr` / `ns.gabia.net` / `ns1.gabia.co.kr` | 21600 | ✅ **DNS 호스팅 = 가비아(Gabia)** |
| **SOA MNAME** | `cgiinc.co.kr` | `ns.gabia.co.kr.cgiinc.co.kr` ⚠️ | 21600 | ⚠️ **비정상 표기**(접두 병합처럼 보임) |
| **SOA RNAME** | `cgiinc.co.kr` | `hosting.gabia.com` (= `hosting@hosting.gabia.com`) | 21600 | ✅ 가비아 운영 흔적 |
| **SOA serial** | — | `1475281817` | — | Unix epoch 해석 시 **2016-10-01 (KST)** |
| **SOA refresh/retry/expire/min** | — | 1800 / 600 / 1209600 / 86400 | — | 기본값 그대로 |
| **ワイル드카드 A** | `*.cgiinc.co.kr` | `121.254.178.250` | 21600 | ✅ **존재 (§2.4에서 증명)** |

### 2.4 서브도메인 / 와일드카드 판정 (중요)

요청된 `www / m / shop / mail` 외에 **존재할 리 없는 랜덤 라벨**을 질의해 와일드카드 여부를 확정했다.

```
zzq-nonexistent-12345.cgiinc.co.kr  A → {"TTL":21600,"data":"121.254.178.250"}   ← !!!
api.cgiinc.co.kr                    A → 121.254.178.250
admin.cgiinc.co.kr                  A → 121.254.178.250
www / m / shop / mail / ftp / blog / en / cgiinc.cgiinc   A → 모두 121.254.178.250
```

**결론: 개별 레코드가 아니라 `*.cgiinc.co.kr` ワイルド카드 A 1개가 전부다.**
- `www`, `m`, `shop`, `mail`, `api` 등은 **명시적으로 설정된 레코드가 존재하지 않는다** (§6의 "확인 필요" 항목과 직결).
- 이 와일드카드는 **가비아 DNS 존 파일 레벨 설정**으로 보이나, 설정 주체는 read-only로 확인 불가.
- ⚠️ **이전 시 함정**: 와일드카드를 Cloudflare로 그대로 복사하면 `anything.cgiinc.co.kr`이 신규 프론트로 계속 Falling-back 되어, 오타/구인바운드 트래픽이 새 사이트에 유입되고 **존재하지 않는 경로가 200을 반환**하는 SEO 페널티를 만든다. Cloudflare에서는 와일드카드를 복제하지 말고 필요한 이름만 명시하는 것을 권장(§7).

### 2.5 DNS 서버(가비아) 자체의 귀속 — 다중 클라우드 구성 (RDAP 증명)

| Nameserver | IP | RDAP `name` | remarks | CIDR |
|---|---|---|---|---|
| `ns.gabia.co.kr` | 43.201.170.100 | `AMAZON-AS-AP` (US) | `Amazon.com, Inc.` | 43.200.0.0/13 → **AWS** |
| `ns.gabia.net` | 121.78.117.39 | `KINXINC-KR` (KR) | `KINX` | 121.78.0.0/16 → **KINX** |
| `ns.gabia.net` | 211.234.124.90 | `KIDC-KR` (KR) | `LG DACOM KIDC` | 211.234.96.0/19 → **KIDC** |
| `ns1.gabia.co.kr` | 20.200.205.248 | `MSFT` | — | 20.192.0.0/10 → **Microsoft Azure** |

```
ns1.gabia.co.kr → 20.200.205.248 → name: MSFT, cidr: 20.192.0.0/10
```
→ 가비아 DNS는 **AWS + Azure + KINX + KIDC 멀티클라우드/anycast**로 운영됨. 이전 시 NS 3组(6 IP)를 그대로 유지할지 여부가 핵심 결정 사항.

### 2.6 도메인 등록 정보 (공개 RDAP, `whois` 부재로 대체)

```
GET https://rdap.nic.or.kr/domain/cgiinc.co.kr   → HTTP 200 application/rdap+json  (size 3692)
  ldhName / unicodeName : cgiinc.co.kr
  status                : ['client transfer prohibited']
  events:
     registration        = 2016-08-30T15:00:00Z
     last changed        = 2018-08-20T02:31:50Z
     expiration          = 2027-08-30T15:00:00Z
  nameservers           : ns.gabia.co.kr, ns.gabia.net, ns1.gabia.co.kr
  secureDNS             : {'delegationSigned': False}     ← DNSSEC 미서명
  port43                : whois.kisa.or.kr
  entity[registrant/administrative] kind=org
     en.name  : K.B.S
     ko.name  : (주)시지아이
     ko.addr  : (62215) 광주광역시 광산구 하남산단천변좌로 19
     en.addr  : 19, Hanamsandancheonbyeonjwa-ro, Gwangsan-gu, Gwangju, , 62215
     tel      : +82.625768100
     email    : idkorea_@naver.com
  entity[registrar]  Megazone / 메가존(주)   url: http://HOSTING.KR
```

- **등록대행(레지스트라) = 메가존(주) / HOSTING.KR** — 가비아 **아님**. 즉 “도메인은 메가존, DNS는 가비아” 구성.
- 만료 **2027-08-30** → 이전 준비에 약 10개월 여유. 다만 `client transfer prohibited`(등록자 잠금) 상태라 **이전 시 해제 필요**.
- `rdap.koreanic.or.kr`은 DNS 실패 (`Could not resolve host`) → **한국인터넷진입 RDAP는 이 도메인 미제공**, `rdap.nic.or.kr`(KISA/KR NIC) 및 `rdap.org` 부트스트랩이 200 반환.

---

## 3. IP·호스팅 귀속 (증명된 것 vs 미해결)

### 3.1 PTR (역방향) — **실패 / 레코드 없음**

```
C:\> nslookup -type=ptr 121.254.178.250
*** UnKnown에서 250.178.254.121.in-addr.arpa.을(를) 찾을 수 없습니다. Non-existent domain

C:\> nslookup 250.178.254.121.in-addr.arpa
*** … 250.178.254.121.in-addr.arpa을(를) 찾을 수 없습니다. Non-existent domain
```
→ **PTR 레코드 존재하지 않음(NXDOMAIN).** 호스팅 귀속을 PTR로는 결정 불가.

### 3.2 ICMP — **무응답(필터링)**

```
C:\> ping -n 1 cgiinc.co.kr
Ping cgiinc.co.kr [121.254.178.250] 32바이트 데이터 사용:
요청 시간이 만료되었습니다.
121.254.178.250에 대한 Ping 통계:
    패킷: 보냄 = 1, 받음 = 0, 손실 = 1 (100% 손실),
```
→ **100% 손실.** 단, HTTP:80은 정상 응답하므로 **ICMP만 차단된 것**(호스팅 다운 아님).

### 3.3 IP 블록 귀속 (APNIC RDAP — 증명됨)

```
GET https://rdap.apnic.net/ip/121.254.178.250   → 301 → /ip/121.254.128.0/17
{
  "name": "KIDC",  "country": "KR",  "status": ["active"],
  "events": [ registration 2008-09-04T07:07:08Z, last changed 2017-02-02T05:47:34Z ],
  "remarks": [{ "title":"description", "description": ["LG DACOM KIDC"] }],
  "entities": [
    { roles:["abuse"], handle:"IRT-KRNIC-KR", fn:"IRT-KRNIC-KR",
      email:"irt@nic.or.kr", adr:"9, Jinheung-gil, Naju-si, Jeollanam-do" },
    { roles:["administrative","technical"], handle:"IM673-AP", fn:"IP Manager",
      adr:"Seoul Yongsan-gu Hangang-daero 32",
      tel:"+82-2-2086-2500", email:"lguidc@lguplus.co.kr" }
  ],
  "handle":"121.254.128.0 - 121.254.255.255",
  "type":"ALLOCATED PORTABLE",
  "cidr0_cidrs":[{"v4prefix":"121.254.128.0","length":17}],
  "port43":"whois.apnic.net"
}
```

**증명된 사실**
- 네트워크 블록 소유자: **`KIDC` / remarks `LG DACOM KIDC`**, 국가 **KR**, `121.254.128.0/17`, 유형 `ALLOCATED PORTABLE`, 등록 2008-09-04.
- 기술/관리 담당 연락처: `lguidc@lguplus.co.kr`, `+82-2-2086-2500`, 주소 `Seoul Yongsan-gu Hangang-daero 32` → **LG Uplus/LG DACOM 계열 IDC(비용 회선)** 반납.
- 남용(abuse) 신고 창구:KR NIC `IRT-KRNIC-KR`.
- 두 번째 서버 `117.52.91.239`도 동일 계열: `117.52.0.0/16`, `name: KIDC-KR`, `remarks: LG DACOM KIDC` → **같은 KIDC/LG U+ 대역**.

### 3.4 호스팅 업체 귀속 — 판단

| 귀속 근거 | 출처 | 판정 |
|---|---|---|
| **DNS 호스팅 = 가비아(Gabia)** | NS 3개 모두 `ns*.gabia.co.kr`/`ns.gabia.net`, SOA RNAME `hosting.gabia.com` | ✅ **증명됨** |
| **IP 대역 네트워크 소유 = LG DACOM KIDC (LG U+)** | APNIC RDAP `KIDC`/`KIDC-KR`, `lguidc@lguplus.co.kr` | ✅ **증명됨** |
| **웹 서버 SW = Apache/2.4.28 (Unix) + OpenSSL/1.0.2k-fips + PHP/5.6.9** | `Server:`, `X-Powered-By:` 헤더 | ✅ **증명됨** |
| **동일 서버가 다른 임차 도메인 `iwoony.com`도 서빙** | TLS 인증서 `CN=iwoony.com` (§6.6) | ✅ **증명됨 → 공유호스팅/멀티테넌트** |
| **`se-cu.com` = 가비아注册, Rocky Linux 독립 서버** | RDAP(`registrar: Gabia, Inc.`, NS 가비아) + `Server: Apache/2.4.37 (Rocky Linux) OpenSSL/1.1.1k` | ✅ **증명됨** |
| **결제된 호스팅 상품명이 “가비아 withme/웹호스팅”인지** | — | ❌ **미해결 (계약서 필요)** |
| **Cafe24 / KOSA / 네이버 / AWS-kr 여부** | 어떤 근거에서도 미발생 | ❌ **해당 없음(추정 불가) → “unresolved”** |

> ⚠️ **본 보고서는 호스팅 상품명을 임의 지정하지 않는다.** 공개 질의로 확정한 것은 위 4개(가비아 DNS / KIDC 네트워크 / Apache·PHP 스택 / iwoony.com 공유 서버)까지이며, **최종 호스팅 업체명은_owner의 호스팅 계약서·가비아/메가존 콘솔 확인 없이는 "unresolved"_**다.

### 3.5 실제 콘텐츠 호스트는 **이미 Cloudflare 사용 중** (매우 중요)

프레임 대상 `영상기기.한국`(= `xn--ok0ba173lu3e.xn--3e0b707e`) 은 **이미 Cloudflare DNS + 프록시**로 운영 중이다.

```
DoH NS  : alex.ns.cloudflare.com / roxy.ns.cloudflare.com     TTL 21600
DoH A   : 172.67.164.26, 104.21.65.146                       TTL 300
DoH AAAA: 2606:4700:3031::ac43:a41a, 2606:4700:3037::6815:4192 TTL 300
GET http://xn--ok0ba173lu3e.xn--3e0b707e/
  HTTP/1.1 301 Moved Permanently
  Server: cloudflare
  CF-RAY: a5053c5bd89fb82e-LAX
  Nel: {"report_to":"cf-nel",…}
  alt-svc: h3=":443"; ma=86400
```
```
rdap.nic.or.kr/domain/xn--ok0ba173lu3e.xn--3e0b707e
  registration 2016-08-29T15:00:00Z | last changed 2026-09-08T00:24:08Z | expiration 2027-08-29T15:00:00Z
  status ['client transfer prohibited'] | NS alex/roxy.ns.cloudflare.com | DNSSEC 미서명
  registrant ko.name (주)시지아이 / ko.addr (62215) 광주광역시 광산구 하남산단천변좌로 19 / email idkorea_@naver.com
  registrar Megazone(메가존주)
```
→ `last changed 2026-09-08` 은 **최근(약 7주 전)에 Cloudflare로 NS 이전이 이뤄졌음**을 시사한다. 즉 **이 프로젝트의 “신규 목표 플랫폼(Cloudflare)”은 부분적으로 이미 착수된 상태**다. `se-cu.com` RDAP: registration 2019-01-23, expiration 2032-01-23, registrar **Gabia, Inc.**, NS 가비아 3개.

---

## 4. HTTP/HTTPS 응답·리디렉션·프레임 구조

### 4.1 `http://cgiinc.co.kr/` — 200 OK, 리다이렉트 없음

```
C:\> curl -sSI http://cgiinc.co.kr/
HTTP/1.1 200 OK
Date: Mon, 26 Oct 2026 00:08:33 GMT
Server: Apache/2.4.28 (Unix) OpenSSL/1.0.2k-fips
X-Powered-By: PHP/5.6.9
Content-Type: text/html; charset=UTF-8

C:\> curl -s -o /dev/null -w '%{http_code} %{redirect_url} %{scheme} %{ssl_verify_result}\n' http://cgiinc.co.kr/
200   http 0
   (상세: code=200 redirect= scheme=http sslverify=0 ip=121.254.178.250 port=80)
```

| 항목 | 값 |
|---|---|
| 상태 코드 | **200 OK** |
| 리다이렉트 | **없음** (`redirect_url` 빈 값) |
| `Server` | `Apache/2.4.28 (Unix) OpenSSL/1.0.2k-fips` |
| `X-Powered-By` | `PHP/5.6.9` (EOL, 2016년경-support 중단) |
| `Content-Type` | `text/html; charset=UTF-8` ← **헤더는 UTF-8** |
| 응답 크기 | **702 bytes** |
| HTTP 버전 | 1.1 (HTTP/2 없음) |
| HSTS / CSP / X-Frame-Options / Cache-Control | **전부 없음** (헤더에 미표기) |

### 4.2 `https://cgiinc.co.kr/` — **TLS 실패 (인증서 이름 불일치 + 만료 + 폐지)**

```
C:\> curl -sSI https://cgiinc.co.kr/
curl: (35) schannel: next InitializeSecurityContext failed:
      CRYPT_E_REVOKED (0x80092010) - 인증서가 취소되었습니다.

C:\> curl -s -o /dev/null -w '…' https://cgiinc.co.kr/
code=000 redirect= scheme=https sslverify=0 ip=
```
- **Windows Schannel 판정: `CRYPT_E_REVOKED` = 인증서 폐지됨.**
- **OpenSSL 판정(§6.6): `verify error:num=10:certificate has expired`, `notAfter=Jan 13 01:20:50 2020 GMT`.**
- `-k`(검증 생략)으로는 **200 + 동일 702 bytes**가 나오므로, **포트 443은 열려 있고 콘텐츠는 존재하나, 인증서 때문에 실질적으로 HTTPS가 사용 불가.**

→ **HTTP 전용(80)으로만 정상 서빙 중.** `code=000`은 TLS 단계에서 중단되어 HTTP 상태를 받지 못한 것.

### 4.3 apex 경로_probe (가비아 구간에 앱이 거의 없음)

```
/                          code=200 size=702
/index.php                 code=200 size=702   ← 같은 frameset (alias)
/index.html                code=404            ← 파일 없음
/robots.txt                code=404 size=208   ← 없음
/sitemap.xml               code=404 size=209   ← 없음
/favicon.ico               code=404 size=209   ← 없음
/bbs/                      code=404 size=202   ← GnuBoard 없음(콘텐츠는 원격)
/admin/                    code=404 size=204
/.well-known/security.txt  code=404 size=222
```
404 페이지 서명: `Content-Type: text/html; charset=iso-8859-1`, `The requested URL /robots.txt was not found on this server.` (구형 Apache 기본 오류문)

### 4.4 프레임 구조 — apex 페이지 원문 (702 bytes, **전체 원문**)

```html
<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=EUC-KR">
<meta name="description" content="(주)시지아이, 영상기기 ">
<meta name="keywords" content="(주)시지아이, 영상기기 ">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>여러분의 방문을 환영합니다.</title>

</head>
<frameset rows="100%,*" border="0">
	<frame name="noframe" src="http://영상기기.한국"></frame>
	<noframes>
		<body>
		<p>This page uses frames. The current browser you are using does not support frames.</p>
		</body>
	</noframes>
</frameset>
</html>
```

| 항목 | 값 |
|---|---|
| frame 개수 | **1개** (`rows="100%,*"` → 실질 화면 100% + 높이 0 빈 frame) |
| frame name | `noframe` |
| **frame src URL** | **`http://영상기기.한국`** ← **`http://` 하드코딩(평문)** |
| page title (apex) | `여러분의 방문을 환영합니다.` |
| description/keywords | `(주)시지아이, 영상기기` |
| 서브도메인 사용 | **없음** (`www.` 미사용, IDN 도메인 직접 참조) |
| 실제 콘텐츠 호스트 | `영상기기.한국` (punycode `xn--ok0ba173lu3e.xn--3e0b707e`) → Cloudflare → 최종 기원 `se-cu.com` 계통 |

#### ⚠️ 4.4.1 인코딩 관련 **기존 인식 정정**

과업 가정은 “EUC-KR frameset”이었으나 **실측 결과 파일 바이트는 UTF-8이며, meta만 EUC-KR을 선언**한다.

```
STRICT DECODE OK  : utf-8
STRICT DECODE FAIL : cp949  -> UnicodeDecodeError  'cp949' codec can't decode byte 0xbc in position 180
STRICT DECODE FAIL : euc-kr -> UnicodeDecodeError  'euc_kr' codec can't decode byte 0xbc in position 180
```
- HTTP 헤더 `charset=UTF-8` / meta `charset=EUC-KR` / 실바이트 `UTF-8` → **3자 불일치**. (HTTP 헤더 우선이라 브라우저는 UTF-8로 해석, meta는 무효)
- cp949로 강제 디코드시 `(二)떆吏븘씠` 류 mojibake 발생 → **EUC-KR 가정으로 마이그레이션하면 깨짐.**
- 반대로 IDN 호스트의 `robots.txt`는 **strict UTF-8 실패 / strict cp949 성공** → **같은 property 안에 인코딩이 혼재**함.
  ```
  --- strict utf-8 FAIL ---  /  --- strict cp949 OK ---
  # 시스템 및 개인정보 관련 페이지 수집 차단
  ```

#### 4.4.2 프레임 이후 리다이렉트 체인 (실측, UA에 따라 결과가 다름)

**(a) 기본 curl UA (`curl/8.15.0`)** — 오류 페이지로 빠짐
```
hop1 http://xn--ok0ba173lu3e.xn--3e0b707e/       -> 301 | https://xn--ok0ba173lu3e.xn--3e0b707e/
hop2 https://xn--ok0ba173lu3e.xn--3e0b707e/      -> 302 | http://se-cu.com/error.html
hop3 http://se-cu.com/error.html                 -> 200 |
final_url=http://se-cu.com/error.html  size=1272  ip=117.52.91.239  redirects=2
```
각 Hop 헤더:
```
301  Location: https://xn--ok0ba173lu3e.xn--3e0b707e/   Server: cloudflare   CF-RAY: a5053cc85aa4f7b1-LAX
302  Location: http://se-cu.com/error.html              Server: cloudflare   CF-RAY: a5053ccbfd11cb9e-LAX
200  Server: Apache/2.4.37 (Rocky Linux) OpenSSL/1.1.1k  charset=UTF-8        ← 기원(직접, Cloudflare 아님)
```

**(b) 실제 브라우저 UA (Chrome 129)** — 정상 서빙
```
code=200 size=265  final=https://xn--ok0ba173lu3e.xn--3e0b707e/
HTTP/1.1 200 OK
Content-Type: text/html; charset=UTF-8
Server: cloudflare
X-Powered-By: PHP/5.3.6          ← 기원 앱 PHP 5.3.6 (apex PHP 5.6.9와 다름)
cf-cache-status: DYNAMIC
CF-RAY: a5053d7d2f5afc03-LAX
```
→ **동일 URL이 User-Agent에 따라 302(오류) / 200(정상)으로 갈린다.** 봇·curl·구버전 클라이언트는 404 오류 페이지를 받게 되는 **실서빙 결함**이며, 이전 후 회귀 테스트 시 **반드시 브라우저 UA로 검증**해야 한다.

**(c) 265바이트 문서 (내부 frameset, `TITLE=시지아이`)**
```html
<!DOCTYPE HTML PUBLIC '-//W3C//DTD HTML 4.01 Frameset//EN' 'http://www.w3.org/TR/html4/frameset.dtd'>
<HTML>
<HEAD><TITLE>시지아이</TITLE></HEAD>
<FRAMESET cols='100%'>
  <FRAME src='./0-siji/'>
</FRAMESET>
</HTML>
```
→ **2중 frameset.** 최종 본문은 `/0-siji/` (25,874 bytes, `lang="ko"`, `<title>(주)시지아이</title>`).

**(d) 오류 페이지 본문 (`http://se-cu.com/error.html`, strict UTF-8 OK)**
```
<title>404 Not Found</title>
… 404 / Not Found …
찾으시는 웹페이지의 주소가 변경되었거나 현재 사용할 수 없는 상태입니다.
입력하신 페이지 주소가 정확한지 다시 한번 확인해 주십시오.
같은 문제가 계속 발생할 경우 사이트 관리자에게 연락 주시기 바랍니다.
<input type="button" value="◀ 이전 페이지" />
```
→ `se-cu.com` 루트는 **403 Forbidden** (`Server: Apache/2.4.37 (Rocky Linux)`), `/index.html` 404, `www.se-cu.com` **403**. 즉 `se-cu.com`은 **가비아注册의 별개 Rocky Linux 서버이며 열려 있지 않다(디렉터리 리스팅 금지/인덱스 없음).**

### 4.5 robots.txt / sitemap.xml (§5 요구) 및 mixed-content

| 대상 | robots.txt | sitemap.xml |
|---|---|---|
| `cgiinc.co.kr` (apex) | **404 없음** | **404 없음** |
| `xn--ok0ba173lu3e.xn--3e0b707e` (IDN) | **200 있음** (390B, cp949) | **404 없음** |
| `xn--ok0ba173lu3e.xn--3e0b707e/0-siji/` | 404 | — |

IDN `robots.txt` 원문 (cp949 → 한국어 주석 정상 복원):
```
User-agent: *
Allow: /

# 시스템 및 개인정보 관련 페이지 수집 차단
Disallow: /bbs/login.php
Disallow: /bbs/register.php
Disallow: /bbs/write.php
Disallow: /bbs/password.php
Disallow: /bbs/memo.php
Disallow: /bbs/scrap.php

# (핵심) 무의미한 게시판 페이징 및 정렬 주소 차단
Disallow: /*?bo_table=*&page=
Disallow: /*&sfl=
Disallow: /*&stx=
Disallow: /*&sst=
Disallow: /*&sod=
```
→ **그누보드5/GroomEE 기본형 robots**. `Allow: /`이며 **Sitemap: 지시 없음**.

**mixed-content 경고**: apex frameset이 `http://`(평문)로 IDN을 참조하는데, IDN은 `http→https` 301을 강제한다. → 브라우저가 **업그레이드 자동 처리**하지만(301), frameset 자체와 `/0-siji/`의 모든 asset·nav 링크가 **IDN 절대 URL로 하드코딩**되어 있어 **`cgiinc.co.kr`로도 콘텐츠를 서빙할 수 없는 구조**이다. 이것이 이번 도메인 이전의 실질적 동기다.

---

## 5. TLS 인증서 상세

### 5.1 `cgiinc.co.kr:443` — **부정확한 이름 + 만료 + 폐지 (사용 불가)**

```
C:\> echo | openssl s_client -connect 121.254.178.250:443 -servername cgiinc.co.kr
depth=1 C=US, O=Let's Encrypt, CN=Let's Encrypt Authority X3
verify error:num=20:unable to get local issuer certificate
depth=0 CN=iwoony.com
verify error:num=10:certificate has expired
notAfter=Jan 13 01:20:50 2020 GMT

Certificate chain
 0 s:CN=iwoony.com    i:C=US, O=Let's Encrypt, CN=Let's Encrypt Authority X3
   v:NotBefore: Oct 15 01:20:50 2019 GMT; NotAfter: Jan 13 01:20:50 2020 GMT
 2 s:C=US, O=Let's Encrypt, CN=Let's Encrypt Authority X3
   i:O=Digital Signature Trust Co., CN=DST Root CA X3
   v:NotBefore: Mar 17 16:40:46 2016 GMT; NotAfter: Mar 17 16:40:46 2021 GMT

subject=CN=iwoony.com
issuer =C=US, O=Let's Encrypt, CN=Let's Encrypt Authority X3
notBefore=Oct 15 01:20:50 2019 GMT
notAfter =Jan 13 01:20:50 2020 GMT
serial   =03F0F8F31915E32A2957C900B83FA95F5586
X509v3 Subject Alternative Name:  DNS:iwoony.com
```

| 필드 | 값 | 평가 |
|---|---|---|
| **Subject / CN** | `iwoony.com` | ❌ **`cgiinc.co.kr`과 무관한 타 도메인** (SAN 불일치 → SNI 실패 시 기본 vhost 인증서 반환) |
| **SAN** | `DNS:iwoony.com` (1개뿐) | ❌ `cgiinc.co.kr`, `*.cgiinc.co.kr` 없음 |
| **Issuer** | `C=US, O=Let's Encrypt, CN=Let's Encrypt Authority X3` | 중간 CA 만료(2021-03-17), 루트 `DST Root CA X3` 만료(2021-09-30 경) |
| **Validity** | 2019-10-15 → **2020-01-13** | ❌ **약 6년 9개월 전 만료** |
| **Key / SigAlg** | RSA 2048 / RSA-SHA256 | — |
| **SNI 거동** | `servername=cgiinc.co.kr` / no-SNI(IP 직접) / `servername=iwoony.com` **3경우 모두 `CN=iwoony.com` 동일** | → **가상호스트 분리 없음**, 기본(기본) vhost 인증서만 반환. `cgiinc.co.kr`용 인증서가 서버에 **존재하지 않음**을 시사 |
| **클라이언트 판정** | Schannel `CRYPT_E_REVOKED` / OpenSSL `num=10 certificate has expired` | ❌ **HTTPS 사실상 사용 불가** |

> ⚠️ Schannel(폐지)와 OpenSSL(만료)이 **다른 오류 코드**를 낸다. 둘 다 “부정”이지만 원인은 서로 다르다 — Windows는 체인 루트/중간 CA 폐지 상태까지 참조하고, OpenSSL은 로트 루트 미보유(`num=20`)+만료(`num=10`)만 본다. **어느 쪽이든 이전 후 `Full (strict)`를 쓰려면 새 인증서가 필요**하다.

### 5.2 `영상기기.한국:443` (Cloudflare 프록시) — **정상, 유효**

```
subject=CN=xn--ok0ba173lu3e.xn--3e0b707e
issuer =C=US, O=Let's Encrypt, CN=YE1
notBefore=Sep  7 23:31:04 2026 GMT
notAfter =Dec  6 23:31:03 2026 GMT
SAN: DNS:*.xn--ok0ba173lu3e.xn--3e0b707e, DNS:xn--ok0ba173lu3e.xn--3e0b707e
```
→ **와일드카드 포함 90일 유효 인증서가 자동 갱신 중** (Cloudflare 관리). 이전 시 `cgiinc.co.kr`에도 동일한 자동 갱신이 적용되므로, §5.1의 폐지·만료 문제는 **이전 즉시 해소**된다.

---

## 6. 기존 게시 회사정보 (디코딩 완료)

### 6.1 푸터 원문 (그대로, 디코딩 결과)

```
상호명: (주)시지아이 | 대표자: 김범신, 백정아 | 주소 : 전라남도 장선군 남면 나노산단로 102 (삼태리)
사업자등록번호: 410-86-46283
대표전화: 062)576-8100 | FAX: 062)-576-8181 | E-Mail: [Cloudflare 이메일 보호로 난독화]
| 기업은행 408-064563-01-016 (주)시지아이
Copyright ⓒ (주)시지아이. All rights reserved
```

**이메일 복원** — Cloudflare `[email protected]` 난독화(`data-cfemail`)는 XOR 방식이라 평문 복원 가능:
```
data-cfemail = f89b9f9191969bb896998e9d8ad69b9795
XOR key      = 0xf8
DECODED      = cgiinc@naver.com
```

### 6.2 공개된 회사 사실 (2025 프로필 대조용)

| 항목 | 구(舊) 사이트 게시값 | 근거 | 주의/판정 |
|---|---|---|---|
| 상호명 | **(주)시지아이** | 푸터·`<title>`·`<h1>`·로고 alt·`hd_h1` | 일관됨 |
| 로컬 네임/EN 표기 | `K.B.S` | RDAP registrant `en.name` | ⚠️ 사이트 영문표기는 **어디에도 없음** |
| **대표자** | **김범신, 백정아 (공동 2인)** | 푸터 | ⚠️ 2025 프로필이 대표 1인이면 **불일치 확인 필요** |
| **주소 (웹사이트)** | **전라남도 장선군 남면 나노산단로 102 (삼태리)** | 푸터 3개 페이지 공통 | ⚠️⚠️ **“장선군”은 실존하지 않는 행정구역 → “장성군” 오기 추정.** 확정 불가 |
| **주소 (도메인 등록정보)** | **광주광역시 광산구 하남산단천변좌로 19, 62215** | `rdap.nic.or.kr` registrant (양 도메인 동일) | ⚠️⚠️ **사이트 주소와 상충.** 어느 쪽이 현행인지 read-only로 판정 불가 |
| 사업자등록번호 | **410-86-46283** | 푸터 | 확인 필요(공식 API 조회 미시행) |
| 대표전화 | **062-576-8100** (표기 `062)576-8100` 및 `대표: 062-576-8100`) | 푸터 + 메인 Contact 박스 + RDAP `+82.625768100` | ✅ RDAP와 **일치** (062 = 광주광역시) |
| **FAX** | **062)-576-8181** | 푸터 | ⚠️ **표기 오손**(`)-`). 실제값은 062-576-8181로 추정하나 확정 불가 |
| 이메일 | **cgiinc@naver.com** | cfemail XOR 복원 | RDAP 등록 연락처는 **`idkorea_@naver.com`** (다름) |
| 계좌 | **기업은행 408-064563-01-016 (주)시지아이** | 푸터 | 무통장 입금 안내로 게시됨 |
| 저작권 | Copyright ⓒ (주)시지아이. All rights reserved | 푸터 | 연도 표기 없음 |
| 슬로건/인사 | `여러분의 방문을 환영합니다.` / `안녕하세요. 음향 및 영상 전문기업 시지아이입니다.` | apex `<title>` / 메인 Greetings 카드 | — |
| **사업영역** | **음향, 영상, 방송, 조명 설계·시공·렌탈 전문기업** | 메인 Contact 카드 문구 (`음향,영상,방송,조명 설계,시공,렌탈 전문기업니다.`) | ⚠️ 원문 `기업니다` **오타(기업입니다)** |
| 비활성 사업영역 | `신재생에너지 개발, 설계, 보급 전문기업` | 메인 카드 **HTML 주석 처리**(`<!-- -->`) | ❌ **게시 중단됨** — 2025 프로필에 있으면 대조 필요 |
| **설립연도 / 연혁** | **게시된 값 없음** | `co_id=history` 페이지 **본문 완전 비어있음** (`visible text len=1` = BOM `\ufeff` 뿐, 이미지 0개) | ❌ **구 사이트에서 설립연도·연혁을 알 수 없음** → 2025 프로필과 대조 불가 |
| **실적/수행실적** | **메뉴·페이지 없음** |全站 nav에 `실적/수행실적/납품실적` 미존재 | ❌ 없음 |
| **채용/careers** | **메뉴·페이지 없음** |全站 nav에 `채용/인재채용/Recruit` 미존재 | ❌ 없음 |
| 영문/다국어 | 없음 (`lang="ko"` 단일) | `/0-siji/` | ❌ i18n 없음 |
| 게시판/고객지원 | `SUPPORT` = Q&A / FAQ / CONTACT | nav | 세 게시판 모두 **0건** |

### 6.3 내비게이션 / 메뉴 구조 (실측 전체)

```
상단 보조 (tnb):   HOME · 공지사항 · 온라인문의 · Login
1depth:          회사소개 | 제품정보 | SUPPORT  (+ 조달제품)
2depth:
  회사소개  → 인사말(greetings) · 연혁(history) · 사업부서(introduction) · 오시는길(location)
  제품정보  → 음향 · 영상 · 무대조명 · 일반조명 · LED전광판 · 스마트팜
  조달제품  → LED전광판
  SUPPORT   → Q&A · FAQ · CONTACT
```

### 6.4 게시판/URL 구조 — 그누보드5(G5) 기반 (`g5_*` 전역변수 실측)

```js
var g5_url       = "https://xn--ok0ba173lu3e.xn--3e0b707e/0-siji";
var g5_bbs_url   = "https://xn--ok0ba173lu3e.xn--3e0b707e/0-siji/bbs";
var g5_cookie_domain = "";      ← 호스트 전용 쿠키 (도메인 공유 아님)
```

| `bo_table` | 용도 | 실측 게시글 수(`wr_id` unique) |
|---|---|---|
| `allhea` | 음향 | **7** (`10–16`) |
| `hkaudio` | 영상 | **3** (`1–3`) |
| `radial` | 무대조명 | **2** (`1–2`) |
| `shure` | 일반조명 | **1** (단 `wr_id=22` → **과거 21건 삭제/갭 존재**) |
| `notice` | 공지사항 | **0** |
| `qanda` | 온라인문의/Q&A | **0** |
| `faq` | FAQ | **0** |
| `contact` | CONTACT | **0** |

`content.php?co_id` 페이지 7종 실측 (이미지 vs 텍스트):

| co_id | 타이틀 | 본문 이미지 | 본문 **텍스트** 길이 |
|---|---|---|---|
| `greetings` | 인사말\|회사소개 | 1 (`/data/editor/1702/…_1487567164_9965.jpg`) | **0** |
| `history` | 연혁\|회사소개 | 0 | **1** (BOM만) → **완전 비움** |
| `introduction` | 사업부서\|회사소개 | 1 (`/data/editor/1703/…_1488778886_9716.jpg`) | **0** |
| `location` | 오시는길\|회사소개 | (지도 JS) `ssl.daumcdn.net/…/roughmapLoader.js` | 133 (설치코드) |
| `led_dispay` | LED전광판\|제품정보 | 2 (`/data/editor/2509/…_1758085471_*.PNG`) | **0** |
| `smart_farm` | 스마트팜\|제품정보 | **14** (`/data/editor/2601/…_1767844636~753_*.JPG`) | **0** |
| `g2b_led` | LED전광판\|조달제품 | **11** (`/data/editor/2601/…_1767840016~030_*.JPG`) | **0** |

> ⚠️ **모든 회사정보 페이지가 “이미지 한 장”뿐이고 크롤러블 텍스트가 0자입니다.** → 검색엔진이 회사정보를 읽지 못하며, **이미지 OCR/재작성 없이는 마이그레이션 시 정보 자체가 유실**됨.
> ⚠️ `co_id` 네이밍에 오타 2건: `led_dispay`(→display), 라벨 표기 `조달제품`의 href는 `g2b_led`(→g2b?).

### 6.5 브랜드 / 외부 링크 (메인 배너 슬라이더 실측)

```
leftrightslide[0..3,5] → http://www.samasound.co.kr/product/list.php?ca_id=20b0 | 2020 | 2070 | 2010 | 2080   (logo1~4,6.jpg)
leftrightslide[4]      → http://leem.kr                                                                       (logo5.jpg)
스크롤 skin 이미지      → http://tyl.co.kr/skin/latest/banner_move/img/left.png|right.png
```
- 확인된 제휴/취급 브랜드: **SAM / Samasound (`samasound.co.kr`, 5개 카테고리 링크)**, **`leem.kr`** (이미지 1개 링크).
- `bo_table` 이름 `shure`, `radial`은 각각 **일반조명**, **무대조명** 게시판에 매핑됨. ⚠️ `shure`는 마이크 브랜드명과 일치하는데 **조명 게시판에 붙어 있어 실제 의도(브랜드 vs 단순 테이블명)를 read-only로 확정 불가**. → 확인 필요.
- 메인 배너 이미지: `mainSkin.png`, `mainSkin2.png` (링크는 `#1`,`#2` **더미 값** → 배너 클릭 시 이동 없음).

### 6.6 스택 및 노후도 (실측)

| 구성요소 | 실측값 |
|---|---|
| CMS | **그누보드5 / GroomEE** (`g5_*`, `wrest.js`, `theme/basic/skin/latest/slideLatest`, `bo_table`, `co_id`) |
| PHP | apex `PHP/5.6.9` · 콘텐츠 기원 `PHP/5.3.6` — **모두 EOL** |
| Web | `Apache/2.4.28 (Unix) OpenSSL/1.0.2k-fips` (apex) · `Apache/2.4.37 (Rocky Linux) OpenSSL/1.1.1k` (se-cu) |
| jQuery | **1.8.3** (로컬) + **1.9.1** + **1.11.1** (ajax.googleapis.com) — 3종 동시 로드 |
| 에셋 버전 스탬프 | `?ver=161020` → **2016-10-20** |
| 호스팅 계층 | Cloudflare (IDN) / 가비아 DNS (apex) |

**콘텐츠 갱신 시점 (파일명 epoch → KST 환산)** — 사이트가 **버려지지 않았음**을 증명:
| 시점(KST) | 대상 |
|---|---|
| 2016-10-01 | SOA serial (`1475281817`) |
| 2016-10-20 | 에셋 `ver=161020` |
| 2017-02-20 | 인사말 이미지 |
| 2017-03-06 | 사업부서 이미지 |
| **2025-08-20** | 오시는길 다음 로우프맵(`timestamp 1755648612347`) |
| **2025-09-17** | LED전광판(제품정보) 이미지 |
| **2026-01-08** | 스마트팜·조달제품 이미지 25장 |
| **2026-09-08** | IDN 도메인 RDAP `last changed`(Cloudflare NS 전환 추정) |

> 결론: **회사소개 4편은 2017년定格(8년 방치), 제품정보는 2025~2026년 갱신.** 2025 프로필 문서와 대조 시 “인사말/연혁/사업부서”가 불일치할 가능성이 가장 높다.

---

## 7. 이전 준비 체크리스트 — Cloudflare Pages(프론트) + Worker(API)

> 전제: **§2·§3·§5의 실측 사실** + “IDN 도메인은 이미 Cloudflare” + “apex는 가비아 DNS/만료 인증서/와일드카드/무MX·무SPF·무DMARC”.
> 아래 `TBD` 값은 **콘솔에서만 확인 가능한 값**으로, 본 조사로 확정 불가한 항목이다(추측 기입 금지).

### 7.1 선행(切替 전) 작업

- [ ] **TTL 선인하**: 현행 apex A·ワイル드카드·NS의 TTL = **21600 (6h)**. 절체 **24~48시간 전**에 A/와일드카드 TTL을 **300초**로 낮춘 뒤(가비아 콘솔에서) 절체. `refresh=1800`이므로 전파 창은 최대 30분.
- [ ] **와일드카드 처리 결정**: `*.cgiinc.co.kr → 121.254.178.250` **복사 금지**. Cloudflare에서는 와일드카드를 만들지 않고 필요 이름만 명시(§7.2). (§2.4 함정)
- [ ] **레지스트라 잠금 해제**: `client transfer prohibited` 상태이므로 메가존/HOSTING.KR 콘솔에서 언록 (전체 이전 시). 단, **DNS만 데려오는 방식이면 불필요** → 권장 경로.
- [ ] **기존 A 값 보존 기록** (본 보고서 §2.2 = `121.254.178.250`) — 롤백 기준값.
- [ ] Cloudflare 계정 NS 쌍 확보 → `TBD` (read-only로 확인 불가, §8).
- [ ] `iwoony.com` 임차인 확인 (공유 서버 잔존 여부, §3.4) — 절체 후 그 서버는 건드리지 않음.

### 7.2 DNS 레코드 생성 (Cloudflare Zone: `cgiinc.co.kr`)

| # | Type | Name | Target/Value | TTL | Proxy | 목적 |
|---|---|---|---|---|---|---|
| 1 | AAAA | `cgiinc.co.kr` | `100::` | Auto | 🟠 **Proxied** | Pages apex (Cloudflare 매직 IP; CNAME은 apex 불가 → A `192.0.77.1` 또는 AAAA `100::` 대입) |
| 2 | CNAME | `www` | `<project>.pages.dev` | Auto | 🟠 Proxied | Pages **권장(canonical) 호스트** |
| 3 | CNAME | `api` | `<worker>.<acct>.workers.dev` 또는 Worker 커스텀 도메인으로 라우팅 | Auto | 🟠 Proxied | **Worker API** |
| 4 | TXT | `_dmarc` | `v=DMARC1; p=none; pct=100; rua=mailto:<TBD>` | Auto | — | §7.6 **현재 전무 → 필수 신설** |
| 5 | TXT | `@` (SPF) | `v=spf1 include:<TBD-resend> ~all` | Auto | — | §7.6 |
| 6 | TXT | `resend._domainkey` | `p=<TBD-resend>` | Auto | — | §7.6 DKIM |
| 7 | CNAME | `email` | `<TBD-resend-tracking-target>` | Auto | 🟠 | 열람/클릭 트래킹 |
| 8 | MX | `@` | **필요 시에만** (수신 메일 요구 정해지지 않음) | Auto | — | §7.6 |
| — | (미생성) `*` | | | | | **와일드카드 의도적 배제** |

- **`m.` / `shop.` / `mail.` / `blog.` / `en.` / `ftp.` 는 개별 레코드로 만들지 말 것.** 실측 결과 전부 와일드카드 산물(§2.4)이며, 실존 서비스가 아님(모두 같은 IP, 경로 404).
- IDN `영상기기.한국`은 **같은 Cloudflare 계정으로 consolidation 후 → 301 Redirect to `https://www.cgiinc.co.kr`** (NS 이미 Cloudflare, §3.5). 가비아 구간 frameset은 절체 후 제거.
- DNSSEC: 현재 양 도메인 모두 `delegationSigned: False`. Cloudflare 전환 시 **켜도 되지만, 반드시 KR NIC/KISA 측 DS 등록 경로 확인 후** (미확인 상태로 활성화하면 보류).

### 7.3 TLS/SSL 모드

- **`Full (strict)`** 권장. Pages/Workers는 §5.2와 동일하게 **자동 갱신되는 유효 인증서**(LE/Google Trust)를 제공 → 즉시 해소.
- ❌ **`Flexible` 금지**: 구 환경은 443이 열려 있으나 인증서가 `iwoony.com` + 만료 + 폐지(§5.1). Flexible로 두면 Cloudflare→기원이 평문으로 내려가고 **구 서버의 깨진 443을 건드리지 못하게 강제**되어 리다이렉트 루프 위험.
- ❌ **`Full`(비strict)도 비권장**: 기원 `121.254.178.250`은 `cgiinc.co.kr`용 SAN이 없으므로 strict 검증 시 **실패하는 것이 정상** → 기원을 Cloudflare Pages/Worker로 옮기는 순간에만 의미 있음.
- 전환 후 설정: **`Always Use HTTPS` = ON**, HSTS(최소 `max-age=31536000; includeSubDomains`) → 단 **preload는 §7.4 canonical 확정 후에**.
- ⚠️ **구 서버를 향하는 한 `Full (strict)`는 절대 통과하지 못함** (SAN 불일치) — 이것이 “frameset을 버리고 기원을 Cloudflare로 옮겨야 하는” 기술적 근거.

### 7.4 www / apex 전략

| 항목 | 실측 근거 | 권고 |
|---|---|---|
| 현행 거동 | apex와 `www`가 **와일드카드로 동일 IP·동일 702바이트 frameset** (§2.4, §4.1) → **구분 없음** | 이제 **정규화(canonical)를 결정**해야 함 |
| 권장 | `https://www.cgiinc.co.kr` = canonical, `https://cgiinc.co.kr` → **308** redirect | Google는 www/apex 혼재를 duplicate으로 본다. 현행은 **frameset라 canonical/robots가 아예 없음**(§4.5)이므로 정규화 여지가 큼 |
| 주의 | apex에 `_acme-challenge`(없음, §2.3) 포함 모든 TXT는 apex에 둔다 | 쿠키는 `.cgiinc.co.kr`로 공유 (§7.7) |
| IDN | `영상기기.한국` 301 → www | 링크 자산/백링크 이관 |
| HTTP→HTTPS | apex는 443이 깨져 있어 **redirect 규칙으로** 처리 (Cloudflare 전환 전에는 건드릴 수 없음) | 절체와 동시에 |

### 7.5 OAuth 콜백 URL (미리 등록)

동일 provider 설정에 **아래 4종을 모두** 등록 (1개 누락 시 절체 직후 로그인 유실):
```
https://www.cgiinc.co.kr/auth/callback      ← canonical
https://cgiinc.co.kr/auth/callback          ← apex
https://<project>.pages.dev/auth/callback   ← Pages 프리뷰/검증
https://<worker>.<acct>.workers.dev/auth/callback   ← Worker 프리뷰
(그리고 Pages Deployment Preview URLs — *.pages.dev 프리뷰용 와일드카드 허용 필요)
```
- Kakao/Naver는 **콜백 URL 정확 일치**(와일드카드 불가) → 각 앱별로 위 URL을 개별 등록.
- 절체 후 **불필요해질 구 콜백**(IDN 호스트 기반) 삭제는 “확정” 단계에서.
-구 사이트에는 로그인 기능만 있고(`Login` → `/0-siji/bbs/login.php`, 그누보드 세션)** OAuth 연동 흔적은 실측되지 않았다**(§6.6 third-party hosts에 provider 없음). 즉 OAuth는 **신규 도입**이며 “기존 콜백 이전”이 아니라 “신규 등록”.

### 7.6 이메일/DNS 마이그레이션 준비 (★ 현 상태: 전부 없음)

| 요구 항목 | 현재 실측 | 판정 | 조치 |
|---|---|---|---|
| **MX** | **없음** (DoH NODATA, `nslookup -type=mx` 빈 응답) | ❌ 미설정 | 수신 메일 요구 확정 후 신설 |
| **SPF (TXT @)** | **없음** | ❌ 미설정 | Resend include 추가 (§7.2 #5) |
| **DKIM** `mail._domainkey` | 없음 (Resend용은 `resend._domainkey`로 별도) | ❌ 미설정 | Resend 콘솔 문자열 그대로 |
| **DMARC** `_dmarc` | **없음 (NXDOMAIN)** | ❌ **전무** | `p=none`으로 시작 → 모니터링 후 강화 |
| CAA | 없음 | ✅ 자유 (발급사 제약 없음) | 전환 후 발급사 제한 추가 여부 판단 |
| 이메일 도메인 | 푸터 게시 주소 `cgiinc@naver.com` | ⚠️ **네이버 개인/그룹 메일** (도메인 MX 없음과 모순 아님 = 네이버메일이 호스팅하는 다른 도메인일 가능성) | 실제 회신 채널 확인(§8) |

> ⚠️ **Resend의 literal SPF/DKIM/트래킹 타깃 값은 이번 세션에서 검증하지 못했다** (`WebFetch` FORBIDDEN, §1). **콘솔에서 그대로 복사**하고, 이 문서에 추측값을 적지 않는다.
> ⚠️ Resend 전환 시 **SPF 충돌 주의**: 현재 SPF가 없으므로 `~all` 단 1개로 시작. 기존 네이버/가비아 발송 채널이 SPF 없이 운용됐다면, 신설 `~all`이 **기존 발송을 차단할 수 있다** — 절체 전 발송 경로 목록 확정 필수(§8).
> ⚠️ **Cloudflare Email Routing / Email Service** 를 쓸지 Resend로 통일할지도 미결정.

### 7.7 CORS / 쿠키 도메인

**CORS (Worker)** — 허용 Origin 목록(실측 호스트 기반):
```
https://www.cgiinc.co.kr
https://cgiinc.co.kr
https://<project>.pages.dev
https://<hash>.<project>.pages.dev        (Pages Deployment Preview)
https://<worker>.<acct>.workers.dev       (Worker 미리보기)
```
- `credentials: include` 를 쓰므로 **`Access-Control-Allow-Origin: *` 금지** — echo-origin + `Vary: Origin`.
- `Access-Control-Allow-Credentials: true`, 노출 헤더·메서드 명시.
- ⚠️ **`xn--ok0ba173lu3e.xn--3e0b707e` 를 Origin에 남겨야 하는 과도 기간**이 존재(frameset 절체 전) → 이전 순서에 따라 필요. 최종 제거 시점 기록.
- ⚠️ 그누보드 `wrest.js`(XSRF 토큰) 로컬 의존 → 신규 프론트는 Worker측 토큰/CSRF 방식으로 재설계 필요.

**쿠키 도메인**
- 현재 실측: `g5_cookie_domain = ""` → **host-only 쿠키** (`Host:` 일치 요구). 즉 **apex 세션이 `www`로 공유되지 않는다**.
- 신구조 권고: **`Domain=.cgiinc.co.kr; Secure; HttpOnly; SameSite=Lax; Path=/`**
  - 리드닷 접두(host-suffix)로 apex/www 공유.
  - ❌ **`.co.kr` 로 설정 금지** (국가별 public suffix — 전체 .co.kr에 쿠키 심는 셈).
  - ❌ `www.cgiinc.co.kr` 고정 도메인도 비권장(apex 세션 유실).
- 전환 시 구 그누보드 PHPSE션 쿠키명은 재사용하지 말고 **신규 이름**(예: `cgiinc_session`)로 분리 → 롤백 시 세션 혼선 방지(§9).

### 7.8 토스페이먼츠 (Toss Payments) webhook/callback

- 실측 근거: **구 사이트 결제 흔적 없음** — `/0-siji/` 전 페이지에 `tosspayments`, `payment.js`, `clientKey`, 카카오페이/네이버페이 스크립트 미존재(§6.6 파서 결과 hit 없음). 즉 **결제 신규 도입**이다.
- 따라서 “이전”이 아니라 **신규 등록**이며, 도메인이 바뀌면 다음을 모두 갱신해야 함:
  - [ ] **Dev Portal → Webhook URL** 을 신규 Worker 엔드포인트로 등록 (MID별 설정, 다수 이벤트 선택). 공식 문서: <https://docs.tosspayments.com/en/webhooks> (“registered endpoint”에送信되므로 도메인/URL 변경 = 재등록 필요).
  - [ ] **webhook 서명 검증 키(Private Key)** 발급/저장 → Cloudflare Worker **Secret**으로만 (`wrangler secret put`), 절대 리포지토리/프론트 코드 금지.
  - [ ] 프론트 리다이렉트 URL: `https://www.cgiinc.co.kr/payment/success` · `…/payment/fail` · 위젯 취소 URL (+ apex · pages.dev 프리뷰)
  - [ ] **서버사이드 `결제확인` API 호출은 도메인 비의존**이라 쿠키/CORS 영향 없음 — 콜백 URL과 혼동 금지.
  - [ ] `clientKey` 는 **가맹점/환경별 값**이며 도메인에 묶이지 않는 것이 일반적이나, **본 확인으로 gated** (§8) — 임의로 “도메인 무관” 결론 내리지 말 것.
  - [ ] Localhost/preview 도메인 승인 (테스트 clientKey 별도 사용).
  - [ ] 웹훈 재통지(retry)·중복 처리( paymentId 멱등) 구현 후 절체.

### 7.9 정적 자산 경로 (마이그레이션 대상 확정 목록)

구 사이트 자산은 **IDN 절대 URL로 하드코딩**되어 있어 상대경로화 없이는 이전 불가(§4.5).

**CSS/JS**
```
/0-siji/theme/basic/css/default.css?ver=161020
/0-siji/theme/basic/css/banner.css?ver=161020
/0-siji/theme/basic/skin/latest/slideLatest/style.css?ver=161020
/0-siji/theme/basic/skin/latest/slideLatest/css/amazon_scroller.css
/0-siji/theme/basic/skin/latest/slideLatest/js/amazon_scroller.js
/0-siji/js/jquery-1.8.3.min.js   /0-siji/js/jquery.menu.js   /0-siji/js/common.js   /0-siji/js/wrest.js   /0-siji/js/html5.js
/0-siji/img/logo.png   /0-siji/img/footLogo.png
/0-siji/img/mainBtt1.png  mainBtt2.png  mainSkin.png  mainSkin2.png  letsgo.png  subBg.jpg
/0-siji/img/g_left.png  g_right.png  minus.png  btn_on.png  btn_off.png
외부 CDN: https://ajax.googleapis.com/ajax/libs/jquery/{1.9.1,1.11.1}/jquery.min.js   ← 자체 호스팅/제거 권장
```
**콘텐츠 파일 (그누보드 업로드 영역 — DB와 함께 이관)**
```
/0-siji/data/editor/1702/  …_1487567164_9965.jpg                (인사말, 2017)
/0-siji/data/editor/1703/  …_1488778886_9716.jpg                (사업부서, 2017)
/0-siji/data/editor/2509/  …_1758085471_*.{PNG×2}               (LED전광판, 2025-09)
/0-siji/data/editor/2601/  …_1767840016~030_*.JPG ×11           (조달 LED, 2026-01)
/0-siji/data/editor/2601/  …_1767844636~753_*.JPG ×14           (스마트팜, 2026-01)
/0-siji/data/file/allhea/  1795135286_<rand>_<sha1>.png ×7      (음향 제품 이미지)
```
**지도**: `ssl.daumcdn.net/dmaps/map_js_init/roughmapLoader.js` + `daum.roughmap.Lander` 임베드, `key: "7b4ghf9j546"`, `timestamp 1755648612347`(2025-08-20) → **로ウ프맵 key는 도메인 비종속이나, 신규 주소 반영 시 재생성 필요**.
**외부 링크**: `samasound.co.kr`(5개 `ca_id`), `leem.kr`, `tyl.co.kr`(skin 이미지 — **hotlink 제거 필요**).

- 신구조 자산 정책: `/_astro/` 등 빌드 산출물은 hash 포함이므로 **`Cache-Control: public, max-age=31536000, immutable`**, `/images/`·`/data/` 이관분은 **max-age=2592000** + URL 구조 유지(구 이미지 hotlink 대응).
- ⚠️ **`/data/` 경로를 그대로 가져가면 구 그누보드 hotlink(타 사이트/카탈로그)가 살아남음.** 가능하면 `/assets/…` 정규화로 재작성 + 301 매핑표 작성.

### 7.10 SEO / 리다이렉트

- [ ] **frameset 전면 폐지** — `<frameset>`/`<frame>`은 HTML5에서 제거됨. 현행 apex는 **frame에 갇혀 콘텐츠가 0자**(§4.4)이고 **meta description도 `(주)시지아이, 영상기기`**뿐.
- [ ] **301/308 리다이렉트 매핑**:
  ```
  http://cgiinc.co.kr/*               → https://www.cgiinc.co.kr/*    (301)
  https://cgiinc.co.kr/*              → https://www.cgiinc.co.kr/*    (308)
  *://xn--ok0ba173lu3e.xn--3e0b707e/* → https://www.cgiinc.co.kr/*    (301, IDN 이관)
  /0-siji/bbs/content.php?co_id=X     → /company/<slug>              (301, 7종)
  /0-siji/bbs/board.php?bo_table=Y&wr_id=N → /products/<Y>/<N>       (301, 총 13건)
  ```
- [ ] **robots.txt**: apex(현행 404)에 신설. 구 IDN robots의 G5 disallow는 신규 구조엔 불필요 — 단 `?sfl=&stx=&sst=&sod=` 등 **쿼리 파라미터 정규화 규칙**은 유지할 가치 있음.
- [ ] **sitemap.xml**: apex·IDN 모두 **404** → 신규 생성 필수 + `robots.txt`에 `Sitemap:` 지시.
- [ ] `<link rel="canonical">`, 구조화 데이터(`Organization`: `name`(주)시지아이, `telephone` 0625768100, `address` — **§6.2 주소 상충 해소 후 기재**), `og:`/`twitter:` 태그.
- [ ] **이미지전용 페이지 7종(§6.4)을 텍스트로 재작성** — 그대로 옮기면 검색 유실.
- [ ] 오타 교정 목록: `장선군`→? , `전문기업니다`→`전문기업입니다`, `led_dispay`→`led_display`, `062)-576-8181`.
- [ ] `location` 페이지의 더미 배너 링크(`#1`,`#2`) 및 배너 미동작 확인.

### 7.11 애널리틱스

- **실측: 현재 분석 도구 전무.** `gtag`/`googletagmanager`/`google-analytics.com`/GA4(`G-…`)/`UA-…`/네이버 `wcs.add`/Kakao/Facebook 픽셀 **모두 0 hits**(§6.6). 외래 호스트는 `ajax.googleapis.com`(jQuery), `samasound.co.kr`, `leem.kr`, `tyl.co.kr`, Cloudflare(`/cdn-cgi/`)뿐.
- → **측정 기준선(baseline)이 없다는 뜻**: 절체 후 트래픽 “감소”를 판정할 비교 데이터가 없다. **절체 최소 2주 전 계측 시작** 권장.
- 권고: **Cloudflare Web Analytics**(쿠키 불필요, 개인정보위 걱정 낮음) + **GA4** 병행, Cookie consent 배너 신설(현재 없음), 전환 이벤트(문의하기 = `qanda`/`contact` 게시판, **현재 0건**) 정의.
- 참고: Cloudflare **email-decode.min.js** (`/cdn-cgi/scripts/…/email-decode.min.js`) 가 이미 활성 → 신규 사이트에서도 이메일 난독화 유지 여부 결정.

---

## 8. 롤백 경로 (즉시 원복)

**원칙: 파괴적 절체 없음. 구 환경을 삭제하지 않는다. 8절은 문서화된 값만 되돌리는 절차다.**

1. **TTL 선인하 (§7.1)** — 절체 전 apex A/와일드카드를 **300초**로. 이렇게 하면 롤백 전파 ≤5분.
2. **기준값 문서화** — 아래 값이 **유일한 롤백 대상**이며 본 보고서 §2가 원본 증거다:
   ```
   cgiinc.co.kr    A   121.254.178.250   TTL 21600 → (절체 전 300)
   *.cgiinc.co.kr  A   121.254.178.250   (와일드카드)
   NS = ns.gabia.co.kr / ns.gabia.net / ns1.gabia.co.kr
   SOA = ns.gabia.co.kr.cgiinc.co.kr  hosting.gabia.com. 1475281817 1800 600 1209600 86400
   ```
3. **NSDelegation을 마지막 단계로** — 권고 순서: (a) Cloudflare Zone 생성·레코드 준비 → (b) **메가존/HOSTING.KR에서 `client transfer prohibited` 해제 불필요한 DNS 위임만** 변경 → (c) 확인 → (d) 최종 전환. 가비아 존을 지우지 말고 **동시 유지**한다.
4. **즉시 롤백 동작(2가지 수준)**
   - **DNS 레벨**: Cloudflare Zone를 **“Pause”** 또는 NS를 가비아 3개로 되돌림 → 문서화된 A 값이 그대로 유효하므로 구 frameset/apex가 즉시 복귀. **가비아 존·서버는 건드리지 않았으므로 무손실.**
   - **CDN 레벨**: Pages/Worker 커스텀 도메인을 **Detached**하고 DNS를 구 IP로 되돌림. Cloudflare 구성 삭제와 무관하게 복원 가능.
5. **GitHub Pages 무변경 확인** — 본 조사에서 **GitHub Pages 엔드포인트(예: `*.github.io`)·CNAME 파일·GitHub Actions 배포는 대상/언급되지 않았고, 변경하지 않았다.** 절체에서도 건드리지 않는다 (§1 무변경 확인 참조). *참고: 현행 실측에서 GitHub Pages 흔적은 발견되지 않았다.*
6. **비파괴 확인** — 구 서버 `121.254.178.250` / `117.52.91.239` 에는 **로그인·파일쓰기·서비스 재시작을 하지 않는다.** 절체 후에도 최소 1个 만료 주기(권장 30일) 동안 그대로 유지 후 반납 결정.
7. **쿠키/세션 롤백 안전** — 신규 세션 쿠키명을 별도로 쓰면(§7.7) 롤백 시 구 그누보드 세션과 충돌하지 않는다.
8. **IDN 도메인 롤백** — `영상기기.한국` NS는 Cloudflare 전환 이력이 있으므로(§3.5, `last changed 2026-09-08`) **구 NS(가비아) 목록을 미리 확보**해 두지 않으면 롤백 불가 → 절체 전 백업 필수(§9).
9. **최종 검증 기준(roll-forward 게이트)** — 브라우저 UA 기준 테스트(§4.2(b) 의 UA 종속 회귀 방지)로 아래를 확인:
   ```
   curl  -A "<Chrome UA>" https://www.cgiinc.co.kr/            → 200
   curl -sSI https://www.cgiinc.co.kr/ | grep -i server        → cloudflare
   openssl s_client … | openssl x509 -noout -subject -dates    → CN=cgiinc.co.kr, notAfter 미래
   GET /robots.txt → 200 ; GET /sitemap.xml → 200 ; GET /favicon.ico → 200
   ```
   실패 시 §4 단계로 복귀.

---

## 9. 확인 필요 항목 (read-only로 판정 불가 — owner 확인 요청)

### A. 계약·계정 자격이 필요한 것
1. **호스팅 실제 상품명/공급자** — 가비아 웹호스팅 계약인지, KIDC(`LG DACOM KIDC`, `lguidc@lguplus.co.kr`) 회선을 별도 임차한 것인지. (§3.4 — “unresolved”)
2. **`iwoony.com` 의 정체** — 같은 서버에 인증서가 걸려 있는 별개 임차 도메인. 같은 회사 소유인지, 호스팅사 기본(vhost) 값인지. **해당 서버 재사용 가능 여부 판단의 핵심.**
3. **`se-cu.com` 소유/목적** (RDAP 등록대행 = Gabia, 등록 2019-01-23, 만료 2032-01-23). 루트가 **403**이고 `/index.html` 404 — 이 서버가 실제 기원(origin)인지, 별도 프로젝트인지. Rocky Linux/Apache 2.4.37 운영 주체.
4. **가비아 DNS 콘솔 접속** — `*.cgiinc.co.kr` **와일드카드 A 레코드가 존 설정에 실제로 존재하는지**(또는 가비아 기본 제공인지), 삭제 권한.
5. **메가존/HOSTING.KR 계정** — 도메인 등록 기관이 메가존이므로 **전체 이전(레지스트라 변경) 시 필요**. DNS 위임만 바꾸려면 불필요.
6. **Cloudflare 계정/Zone NS 쌍** — `TBD`. IDN 도메인이 속한 계정이 곧 이전 목표 계정인지, 신규 분리인지.
7. **그누보드5 DB 접속** (`/0-siji/`) — `content.php`(7종)·`board.php`(게시글 13건)·`/data/` 업로드 파일, **회원/문의 데이터 포함 여부**. 이미지전용 페이지(§6.4)의 **원문 텍스트는 DB 이미지가 유일한 사본**일 수 있음 → 원본 확보 선행.

### B. 사실 확인이 필요한 정보 (§6 대조)
8. **주소 상충** — 웹사이트 푸터 `전라남도 장선군 남면 나노산단로 102 (삼태리)` vs 도메인 등록정보 `광주광역시 광산구 하남산단천변좌로 19 (62215)`. **어느 것이 현행 본사/공장(나노산단)인지.** “장선군”은 실존하지 않는 지명 → **“장성군” 오기인지** 확인 필요.
9. **대표자** — 푸터는 `김범신, 백정아` (공동 2인). 현행 등기부 기준 확인.
10. **설립연도·연혁** — 구 사이트에 **전무**(`co_id=history` 본문 빈 쪽, §6.2). 2025 프로필의 연혁과 대조할 기준값이 **구 사이트에는 없다**.
11. **실적/수행실적·채용 페이지** — 구 사이트에 없음. 신규 필요 여부 결정.
12. **사업자등록번호 `410-86-46283`** 유효성 — 공개 정보 조회 미시행.
13. **FAX `062)-576-8181`** 의 정확한 숫자 (표기 오손).
14. **이메일 실채널** — 게시 메일 `cgiinc@naver.com`(복원값, §6.1) vs 도메인 등록 연락처 `idkorea_@naver.com`. **도메인 MX가 없으므로 `cgiinc.co.kr` 주소로는 수신 불가** → 사내 메일 도메인이 뭔지 확인(Resend/DMARC 설계 전제).
15. **브랜드/게시판 매핑** — `bo_table=shure` 가 **일반조명** 게시판에 붙은 이유(브랜드 vs 단순 명명), `radial`, `hkaudio`, `allhea` 의 실제 제조사 대응. `wr_id=22` 1건뿐인 `shure` 에 **삭제된 21건 이력** 확인.
16. **동시 취급 브랜드 확정** — 실측 링크는 `samasound.co.kr`(ca_id 20b0/2010/2020/2070/2080), `leem.kr` 2곳뿐. 이미지 `logo1~6.jpg` 와의 대응(6개 중 5개만 samasound)은 확인 불가.

### C. 기능·의사결정 미결
17. **`신재생에너지` 사업** — 메인 카드가 **HTML 주석으로 비활성**(§6.2). 현재 사업 범위에서 제외된 것이 맞는지.
18. **UA 종속 리다이렉트 원인** — IDN URL이 비브라우저 UA엔 `302 → se-cu.com/error.html`, 브라우저 UA엔 `200` (§4.2). Cloudflare Worker/규칙인지 기원 PHP 분기인지 **콘솔 없이는 판정 불가**. 절체 시 이 분기를 제거해야 하는지 확인.
19. **HTTP/2·h3 미사용** (apex HTTP/1.1, §4.1) vs IDN `alt-svc: h3` — 의도한 설정인지.
20. **결제 수단 요구사양** — 구 사이트 결제 흔적 없음(§7.8). **토스 신규 도입 여부/미정**, 카드무통장(푸터에 기업은행 계좌 게시 중) 병행 정책.
21. **로그인 기능存续 여부** — `Login` (`/0-siji/bbs/login.php`) 은 nav에 있으나 게시판 0건·비회원 구조로 실제 사용자 존재 불명. 신규에서 유지할지.
22. **영문 사이트** — 현재 없음. 2025 프로필에 EN이 있으면 별도 i18n 설계.
23. **접근성/모바일** — 현행 `viewport` 메타는 apex에만 있고, 본문(`usePxArea`, `min-width:1200px`)은 **데스크톱 고정** → 반응형 재설계 확인.
24. **DNSSEC** — 양 도메인 모두 미서명(`delegationSigned: False`). 활성화 요구 여부.
25. **IDN 도메인 존속 정책** — `영상기기.한국` 만료 2027-08-29. 유지(리다이렉트) vs 방기 결정. `.한국` 등록/갱신 주체 확인.

### D. 이번 세션 도구 한계 (명시)
26. `whois` CLI **미설치** → RDAP으로 대체함(§2.6, §3.3). KR NIC 원문 WHOIS(`whois.kisa.or.kr`) 및 APNIC 원문(`whois.apnic.net`) 텍스트는 미조회.
27. `dig` / `host` **미설치** → `nslookup` + DoH로 대체. **SOA 스냅샷/zone transfer/권한 NS 직접 질의(AAA query)는 수행하지 않음.**
28. **PTR 미존재**(§3.1)·**ICMP 무응답**(§3.2) → 역조회·생존성 검증 경로 실패.
29. `WebFetch` **FORBIDDEN(limit)** → Resend 등 프로바이더 요구 문자열 실시간 검증 실패(§7.6). `rdap.koreanic.or.kr` **DNS 해석 실패**(`rdap.nic.or.kr`로 성공).
30. **JavaScript 실행 미 수행** — IDN 기원 페이지는 JS 배너/banner 로직이 있고, 그누보드 콘텐츠 중 JS 렌더분은 미탐사. **`/0-siji/` 정적 HTML만 근거.** 쿠키/로그인 필요 페이지(`/bbs/login.php`, 관리자)는 **미접근(당연히 로그인하지 않음)**.

---

## 10. 원본 명령 증거 요약 (재현 커맨드)

```bash
# DNS
nslookup cgiinc.co.kr                       # 121.254.178.250
nslookup -type=ns  cgiinc.co.kr             # 가비아 NS 3
nslookup -type=soa cgiinc.co.kr             # serial 1475281817, RNAME hosting.gabia.com
nslookup -type=mx  cgiinc.co.kr             # 없음
nslookup -type=txt cgiinc.co.kr             # 없음
nslookup -type=txt _dmarc.cgiinc.co.kr      # 없음(NXDOMAIN)
nslookup -type=ptr 121.254.178.250          # Non-existent domain
nslookup -type=aaaa cgiinc.co.kr            # 없음

# DoH (TTL + NODATA/NXDOMAIN 판정)
curl -sS "https://dns.google/resolve?name=cgiinc.co.kr&type=A"
curl -sS "https://dns.google/resolve?name=cgiinc.co.kr&type={MX|TXT|NS|SOA|CAA|AAAA|CNAME}"
curl -sS "https://dns.google/resolve?name=zzq-nonexistent-12345.cgiinc.co.kr&type=A"  # ★ 와일드카드 증명
curl -sS "https://dns.google/resolve?name=xn--ok0ba173lu3e.xn--3e0b707e&type=A"

# ICMP
ping -n 1 cgiinc.co.kr                      # 100% 손실

# HTTP/HTTPS
curl -sSI http://cgiinc.co.kr/
curl -sSI https://cgiinc.co.kr/             # curl(35) CRYPT_E_REVOKED
curl -s -o /dev/null -w '%{http_code} %{redirect_url} %{scheme} %{ssl_verify_result}\n' http://cgiinc.co.kr/
curl -sS  http://cgiinc.co.kr/ -o home.html
curl -sS -o /dev/null -w '%{http_code} %{url_effective} %{remote_ip}\n' http://cgiinc.co.kr/robots.txt

# TLS
echo | openssl s_client -connect 121.254.178.250:443 -servername cgiinc.co.kr \
  | openssl x509 -noout -subject -issuer -dates -serial -ext subjectAltName
echo | openssl s_client -connect xn--ok0ba173lu3e.xn--3e0b707e:443 -servername xn--ok0ba173lu3e.xn--3e0b707e \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName

# 콘텐츠 체인 (UA 주의)
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
curl -sSI -L "http://xn--ok0ba173lu3e.xn--3e0b707e/"                 # 301→302→200 (error.html)
curl -sSL -A "$UA" "https://xn--ok0ba173lu3e.xn--3e0b707e/"          # 200 frameset
curl -sSL -A "$UA" "https://xn--ok0ba173lu3e.xn--3e0b707e/0-siji/"   # 200 본문 25,874B
curl -sS  -A "$UA" "https://xn--ok0ba173lu3e.xn--3e0b707e/0-siji/bbs/content.php?co_id=history"

# 인코딩 검증
python -c "b=open(r'C:\Users\limone\AppData\Local\Temp\cgiinc_home.html','rb').read(); \
[print(e, b.decode(e)) if True else 0 for e in ('utf-8',)]   # utf-8 성공 / cp949·euc-kr 실패"

# RDAP (IP + 도메인)
curl -sSL "https://rdap.apnic.net/ip/121.254.178.250"    # → /121.254.128.0/17 KIDC "LG DACOM KIDC"
curl -sSL "https://rdap.apnic.net/ip/117.52.91.239"      # → /117.52.0.0/16 KIDC-KR
curl -sSL "https://rdap.nic.or.kr/domain/cgiinc.co.kr"                  # 등록 2016-08-30 / 만료 2027-08-30 / Megazone
curl -sSL "https://rdap.nic.or.kr/domain/xn--ok0ba173lu3e.xn--3e0b707e" # NS cloudflare / last changed 2026-09-08
curl -sSL "https://rdap.org/domain/se-cu.com"                            # registrar Gabia, Inc.

# Cloudflare 이메일 난독화 복원
python -c "h='f89b9f9191969bb896998e9d8ad69b9795';b=bytes.fromhex(h);k=b[0]; \
print(''.join(chr(c^k) for c in b[1:]))"                   # cgiinc@naver.com
```

---

*본 문서는 읽기 전용 조사 결과이며, DNS·서버·외부 서비스에 대한 변경 지시나 자격 증명을 포함하지 않는다. 모든 진술은 위 §10 명령 출력으로 뒷받침되며, 뒷받침 없는 항목은 명시적으로 `TBD`/`미해결`/`unresolved` 로 표기했다.*
