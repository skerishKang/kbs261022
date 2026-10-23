// Cloudflare Worker + D1 backend for CGI quote requests.
// Deploy with: wrangler deploy
// Required secrets: ADMIN_TOKEN

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/quotes (public)
    if (url.pathname === '/api/quotes' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
      if (!body || !Array.isArray(body.items) || !body.items.length) {
        return json({ error: 'items required' }, 400);
      }
      if (!body.company || !body.name || !body.phone) {
        return json({ error: 'company, name, phone required' }, 400);
      }
      const id = 'Q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const createdAt = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO quote_requests (id, created_at, company, contact_name, phone, email, location, note, services, items, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`
      ).bind(
        id, createdAt, body.company, body.name, body.phone, body.email || null, body.location || null, body.note || null,
        JSON.stringify(body.services || []), JSON.stringify(body.items), createdAt
      ).run();
      return json({ id, created_at: createdAt, status: 'received' }, 201);
    }

    // GET /api/quotes (admin)
    if (url.pathname === '/api/quotes' && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const status = url.searchParams.get('status');
      let stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests ORDER BY created_at DESC');
      if (status) stmt = env.DB.prepare('SELECT id, created_at, company, contact_name, phone, status, total FROM quote_requests WHERE status = ? ORDER BY created_at DESC').bind(status);
      const { results } = await stmt.all();
      return json({ items: results });
    }

    // GET /api/quotes/:id (admin)
    const getMatch = url.pathname.match(/^\/api\/quotes\/([^/]+)$/);
    if (getMatch && request.method === 'GET') {
      if (!isAdmin(request, env)) return unauthorized();
      const id = decodeURIComponent(getMatch[1]);
      const row = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(row);
    }

    // PATCH /api/quotes/:id (admin)
    if (getMatch && request.method === 'PATCH') {
      if (!isAdmin(request, env)) return unauthorized();
      const id = decodeURIComponent(getMatch[1]);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
      const existing = await env.DB.prepare('SELECT * FROM quote_requests WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'not found' }, 404);
      const status = body.status || existing.status;
      const adminPrices = body.admin_prices !== undefined ? JSON.stringify(body.admin_prices) : existing.admin_prices;
      const total = body.total !== undefined ? body.total : existing.total;
      const updatedAt = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE quote_requests SET status = ?, admin_prices = ?, total = ?, updated_at = ? WHERE id = ?'
      ).bind(status, adminPrices, total, updatedAt, id).run();
      return json({ id, status, total, updated_at: updatedAt });
    }

    return json({ error: 'not found' }, 404);
  },
};
