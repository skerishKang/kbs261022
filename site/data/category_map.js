/*
 * category_map.js — 공급처 분류 211종을 CGI 대분류로 묶는 매핑표 (이슈 #209 B1)
 *
 * - rules 는 순서대로 첫 매칭이 이긴다. keywords 는 원본 카테고리 이름의 부분 문자열,
 *   exactKeywords 는 카테고리 이름 전체와 정확히 일치할 때만 적용한다 (#213 E8).
 * - exact 는 카테고리 이름 전체가 일치할 때 우선 적용한다.
 * - 어느 규칙에도 걸리지 않으면 fallback 을 쓴다.
 * - 대분류는 13개(10~15 범위)이고, 브랜드명 분류(KLOTZ·PRESONUS 등)는 남기지 않는다.
 * - 시험: site/test/category-map-209.test.mjs 가 catalog.json 전체를 대상으로 고정한다.
 */
window.CGI_CATEGORY_MAP = {
  version: '2026-11-12',
  fallback: '액세서리·소모품',
  groups: [
    '마이크·무선',
    '스피커',
    '이어폰·헤드폰',
    '케이블·커넥터',
    '레코딩·인터페이스',
    '소프트웨어·플러그인',
    '믹서·프로세서',
    '네트워크·회의영상',
    '악기·앰프',
    '스탠드·거치',
    '액세서리·소모품',
    '음향 튜닝·방음',
    '특가·기획'
  ],
  rules: [
    { group: '특가·기획', keywords: ['특가', '할인 상품', '전시상품', '클리어런스'] },
    { group: '스탠드·거치', keywords: ['스탠드', '랙 마운트', 'K&M'] },
    {
      group: '스피커',
      keywords: ['스피커', '서브우퍼', '라우드', '라인어레이', 'PORTABLE SUB', '파워앰프',
        'Power Amplifier', 'GENELEC', 'DYNAUDIO', 'LUNAR', 'Q Acoustics', 'Wavefront', 'Loudspeaker']
    },
    {
      group: '케이블·커넥터',
      keywords: ['케이블', '커넥터', 'XLR', '어댑터', '스플리터', '파워콘', '이더콘', 'D-Sub',
        'RCA', 'Phone Plug', 'TS/TRS', '3.5mm', '1/4', 'Hi-Fi', 'KLOTZ', 'QED', '파워', '디지털']
    },
    {
      group: '믹서·프로세서',
      keywords: ['믹서', 'DSP', '프로세서', '매트릭스', 'Zone Mixer', '스위처', 'ZED',
        'Allen&Heath', 'A&H', 'Avantis']
    },
    {
      group: '네트워크·회의영상',
      keywords: ['네트워크', '네트워킹', 'I/O', 'AV & Control', '인터컴', 'Vaddio', '회의', 'Microflex',
        'MXA', 'STEM']
    },
    {
      group: '레코딩·인터페이스',
      keywords: ['레코딩', '인터페이스', '프리앰프', '컴프레셔', '채널스트립', '리앰프', '리앰퍼', 'DI',
        '아이솔레이터', '브레이크아웃', '모니터 컨트롤러', '시그널 드라이버', '헤드폰 앰프',
        '스튜디오 툴', '오디오플레이어', 'Fidelice', '컨트롤러', 'PRESONUS', 'APOGEE',
        'IK MULTIMEDIA', 'Matrix Audio', '다이렉트 박스']
    },
    { group: '소프트웨어·플러그인', keywords: ['소프트웨어', '플러그인', 'DAW', 'Melodyne'] },
    {
      group: '이어폰·헤드폰',
      keywords: ['이어폰', '헤드폰', '이어팁', 'COMPLY', '컴플라이', '리스닝']
    },
    {
      group: '액세서리·소모품',
      keywords: ['액세서리', '카트리지', '바늘', 'JICO', 'ETC', 'Other', '브랜드 미확인']
    },
    { group: '음향 튜닝·방음', keywords: ['어쿠스틱', '방음', '튜닝재', 'VICOUSTIC', 'AGS'] },
    {
      group: '마이크·무선',
      keywords: ['마이크', '무선', 'KSM', 'BETA', 'SM 시리즈', 'PGA', 'PG ALTA', 'BLX', 'GLX', 'ULX',
        'QLX', 'SLX', 'Axient', 'Nexadyne', 'TwinPlex', 'DuraPlex', 'MOTIV', 'MV', 'VP',
        'CV 시리즈', '라발리어', 'Classic 시리즈', 'SVX'],
      // 'SM' 은 부분 문자열로 쓰면 KEN SMITH(베이스 기타)까지 잡는다 — 정확 일치만 (#213 E8)
      exactKeywords: ['SM']
    },
    {
      group: '악기·앰프',
      keywords: ['기타', '베이스', '앰프', '이펙터', '신디사이저', '키보드', '악기', 'MESA',
        'NASH', 'ROSCOE', 'KEN SMITH', 'RICKENBACKER', 'GRAY LONDON', 'MICHAEL TUTTLE',
        'ROCK AND ROLL', 'ARTURIA', 'POSITIVE GRID', 'NATIVE INSTRUMENTS']
    }
  ],
  exact: {
    '전체보기': '악기·앰프',
    'SHURE': '레코딩·인터페이스',
    'K&M': '스탠드·거치',
    '브랜드 미확인': '스피커'
  }
};
