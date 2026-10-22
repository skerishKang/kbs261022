// 이카운트 ERP 메뉴 트리 전수 덤프 (읽기 전용)
// 사용법: node ecount_menu_tree.js --out ecount_menu_tree.json
//
// 주의:
//   - 'version' 파라미터는 브라우저가 이미 받은 URL 의 값을 그대로 재사용해야 한다.
//     임의로 바꾸면 빈 응답이 돌아온다(실측).
//   - 세션 토큰(ec_req_sid)은 출력에 포함하지 않는다.

const fs = require('fs');

const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const outFile = arg('--out', 'ecount_menu_tree.json');
const url = arg('--url', null);
const depth = Number(arg('--depth', '3'));

if (!url) {
  console.error(
    '사용법: node ecount_menu_tree.js --url "<GetNavigationTopMenuAction URL>"\n' +
      '  (브라우저 DevTools Network 에서 sid=root 요청 URL 을 복사해 넣는다. ec_req_sid 는 스크립트가 잘라서 사용한다)'
  );
  process.exit(2);
}

const base = url.split('&ec_req_sid=')[0].replace(/ec_req_sid=[^&]*/, '');

async function getJson(u) {
  const res = await fetch(u, { headers: { xce: 'none' } });
  return res.json();
}

(async () => {
  const cache = {};
  async function get(sid) {
    if (cache[sid]) return cache[sid];
    const u = base.replace(/sid=[^&]*/, 'sid=' + sid);
    const j = await getJson(u);
    const sm = (j.Data && j.Data.selected_menu) || {};
    const rec = {
      sid,
      label: sm.name || sm.resource_name || '',
      prg_id: sm.prg_id || '',
      depth: sm.depth || 0,
      children: Object.keys(sm.children_order || {}),
    };
    cache[sid] = rec;
    return rec;
  }

  const root = await get('root');
  const rootRaw = await getJson(base.replace(/sid=[^&]*/, 'sid=root'));
  const depth2 = Object.values(((rootRaw.Data || {}).menu_info || {})).filter((m) => m.depth === 2);

  const out = [];
  for (const g of depth2) {
    const gr = await get(g.sid);
    const kids = [];
    for (const cs of gr.children) {
      const cr = await get(cs);
      const leaves = [];
      if (depth >= 3) {
        for (const ls of cr.children) {
          const lr = await get(ls);
          leaves.push({ label: lr.label, prg_id: lr.prg_id, sid: lr.sid });
        }
      }
      kids.push({ label: cr.label, prg_id: cr.prg_id, sid: cr.sid, leaves });
    }
    out.push({ group: gr.label, prg_id: gr.prg_id, sid: gr.sid, children: kids });
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log('groups=' + out.length);
  for (const g of out) {
    console.log('\n' + g.group + ' [' + g.prg_id + ']');
    for (const c of g.children) {
      console.log('  ' + c.label + ' [' + c.prg_id + ']');
      for (const l of c.leaves) console.log('    - ' + l.label + ' [' + l.prg_id + '] ' + l.sid);
    }
  }
})();
