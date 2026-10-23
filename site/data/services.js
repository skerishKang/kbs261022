// CGI 공급처 공개 정보 기반 서비스 옵션 (PoC: 금액 미확정)
// 고객 확정 전에는 단가를 넣지 않고, 견적 요청 흐름만 제공한다.
window.CGI_SERVICES = [
  {
    id: 'installation',
    name: '설치·시공',
    description: '장비 설치, 랙/배선, 현장 시공 지원. 세부 견적은 현장 조건 확인 후 안내합니다.',
    scope: 'product'
  },
  {
    id: 'dispatch',
    name: '출장·현장 지원',
    description: '엔지니어 출장, 현장 점검, 시운전 지원. 이동비/출장비는 별도 협의합니다.',
    scope: 'product'
  },
  {
    id: 'as',
    name: 'AS·유지보수',
    description: '하자/AS, 유지보수, 부품 교체 지원. 계약 조건에 따라 제공합니다.',
    scope: 'product'
  },
  {
    id: 'care',
    name: '케어·정기 점검',
    description: '정기 점검, 청소, 성능 최적화 등 케어 서비스. 주기와 범위는 협의합니다.',
    scope: 'product'
  }
];
