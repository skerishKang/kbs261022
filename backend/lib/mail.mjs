// CGI customer mail adapter (issue #69, #72, #79).
//
// Selected by the MAIL_MODE worker variable:
//
//   console  (default)  Writes the message body and link to the Worker logs.
//                       No external delivery is configured, so the result is
//                       delivered=false with channel='console-log'.
//   echo                Like console, but the returned object also carries the
//                       token and link so a local/test environment can finish
//                       email verification without an external provider. Never
//                       use in production: it is equivalent to publishing the
//                       verification token to the caller.
//   resend            Sends via the Resend v1 API using B66_ALERT_RESEND_API_KEY.
//                       Reuses the same Resend infrastructure as PADIEM.NET
//                       via Cloudflare Secrets Store binding.
//   sendgrid            Sends via the SendGrid v3 API using SENDGRID_API_KEY.
//                       Requires a verified sending domain and the API key
//                       stored as a Worker Secret.
//
// This adapter NEVER marks an account as verified. Verification only happens
// when a client presents a valid, unexpired token.

export const MAIL_MODES = ['console', 'echo', 'resend', 'sendgrid'];

/** Parse "Name <email>" into { name, email }. Falls back to the raw string. */
function parseFrom(fromStr) {
  const m = String(fromStr || '').match(/^([^<]+)<([^>]+)>$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const single = String(fromStr || '').trim();
  return single.includes('@') ? { name: '', email: single } : { name: single, email: '' };
}

/** Build the HTML body for a verification or reset email. */
function htmlBody(message) {
  const { subject, text, url, to } = message || {};
  const safeUrl = url ? String(url).replace(/&/g, '&amp;') : '';
  const safeSubject = subject ? String(subject).replace(/</g, '&lt;') : '';
  const safeText = text ? String(text).replace(/</g, '&lt;') : '';
  return [
    '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${safeSubject}</title></head><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0">',
    '<tr><td align="center"><table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden">',
    '<tr><td style="background:#1a73e8;padding:20px 24px"><h1 style="color:#fff;font-size:18px;margin:0">CGI 상품 카탈로그</h1></td></tr>',
    '<tr><td style="padding:24px">',
    `<p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 16px">안녕하세요<span>${to ? ' ' + String(to).replace(/</g, '&lt;') : ''}</span>님,</p>`,
    `<p style="color:#333;font-size:14px;line-height:1.6;margin:0 0 24px">${safeText}</p>`,
    safeUrl ? `<p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-size:14px;font-weight:500">확인하기</a></p>` : '',
    '<p style="color:#999;font-size:12px;line-height:1.5;margin:24px 0 0">이 메시지는 요청에 따라 전송되었습니다. 해당 요청이 본인이 하지 않은 작업이라면 비밀번호 재설정을 이용하세요.</p>',
    '</td></tr>',
    '<tr><td style="background:#f8f9fa;padding:16px 24px;text-align:center"><p style="color:#999;font-size:11px;margin:0">CGI 상품 카탈로그 | (주)시지아이</p></td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('\n');
}

/** Read a secret value, handling both plain Worker Secrets and Secrets Store bindings. */
async function readSecret(env, name, fallback = '') {
  const val = env[name];
  if (val === undefined || val === null) return fallback;
  // Secrets Store bindings are objects with a .get() method returning a Promise
  if (typeof val === 'object' && typeof val.get === 'function') {
    return await val.get();
  }
  // Plain Worker Secret is a string
  return String(val);
}

export function createMailAdapter(env, log = () => {}) {
  const mode = String(env.MAIL_MODE || 'console').toLowerCase();
  const from = String(env.MAIL_FROM || 'CGI no-reply <no-reply@cgi.example>');
  const base = String(env.MAIL_BASE_URL || '').replace(/\/+$/, '');
  const siteBase = String(env.SITE_BASE_URL || base || 'https://skerishkang.github.io/kbs261022/site').replace(/\/+$/, '');
  const sgEndpoint = String(env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send').replace(/\/+$/, '');
  const resendEndpoint = String(env.RESEND_API_URL || 'https://api.resend.com/emails').replace(/\/+$/, '');

  const fromParts = parseFrom(from);

  return {
    mode: MAIL_MODES.includes(mode) ? mode : 'console',

    /** Build the public URL a mail recipient should open.
     *
     * The storefront is a static GitHub Pages app with hash routing, so a
     * path-style link like /site/auth/verify returns GitHub's 404 page. Put the
     * route after #/ instead; the SPA reads the token from the hash query.
     */
    urlFor(path, token) {
      const clean = path.startsWith('/') ? path : `/${path}`;
      const sep = clean.includes('?') ? '&' : '?';
      const suffix = token ? `${clean}${sep}token=${encodeURIComponent(token)}` : clean;
      const base = siteBase.replace(/#.*$/, '');
      return `${base}/#${suffix}`;
    },

    /**
     * Deliver a message. Returns:
     *   { delivered, channel, note?, token?, url? }
     * `token` is only present in echo mode.
     */
    async deliver(message) {
      const { to, subject, text, url, token } = message || {};
      const rendered = `${from}\n\nTo: ${to || '(no recipient)'}\nSubject: ${subject || ''}\n\n${text || ''}\n\n${url || ''}`;

      log(`[MAIL:${this.mode}] ${subject || ''} -> ${to || 'unknown'} ${url || ''}`);

      if (this.mode === 'echo') {
        return {
          delivered: false,
          channel: 'echo',
          note: 'MAIL_MODE=echo: no external provider, token returned in the response',
          token: token || null,
          url: url || null,
        };
      }
      if (this.mode === 'resend') {
        // Read the Resend API key, handling both Secrets Store bindings and plain secrets
        const resendKey = (await readSecret(env, 'B66_ALERT_RESEND_API_KEY')).trim();
        if (!resendKey) {
          return {
            delivered: false,
            channel: 'unconfigured',
            note: 'MAIL_MODE=resend but B66_ALERT_RESEND_API_KEY is not configured; nothing was sent',
          };
        }
        // Validate key format (Resend keys start with 're_') before calling the API
        if (!resendKey.startsWith('re_')) {
          log('[MAIL:resend] invalid key format, blocking API call');
          return {
            delivered: false,
            channel: 'resend',
            note: 'resend: API key format is invalid (expected re_... prefix)',
          };
        }
        if (!to) {
          return {
            delivered: false,
            channel: 'resend',
            note: 'resend: missing recipient',
          };
        }
        try {
          // Resend API: POST https://api.resend.com/emails
          // Auth: Authorization: Bearer <key>
          // Body: { from, to: [email], subject, text, html? }
          const fromValue = fromParts.email || from;
          const payload = {
            from: fromValue,
            to: [to],
            subject: subject || 'CGI',
            text: `${text}\n\n${url}`,
            html: htmlBody(message),
          };
          const resp = await fetch(resendEndpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          const responseBody = await resp.text();
          if (resp.ok) {
            return { delivered: true, channel: 'resend' };
          }
          let detail = responseBody.slice(0, 300);
          try { const parsed = JSON.parse(responseBody); detail = parsed.message || detail; } catch (e) { /* keep raw */ }
          log(`[MAIL:resend] API error ${resp.status}: ${detail}`);
          return {
            delivered: false,
            channel: 'resend',
            note: `resend API ${resp.status}: ${detail}`,
          };
        } catch (e) {
          log(`[MAIL:resend] fetch error: ${e && e.message || e}`);
          return {
            delivered: false,
            channel: 'resend',
            note: `resend fetch error: ${e && e.message || e}`,
          };
        }
      }
      if (this.mode === 'sendgrid') {
        // Read the SendGrid API key, handling both Secrets Store bindings and plain secrets
        const apiKey = (await readSecret(env, 'SENDGRID_API_KEY')).trim();
        if (!apiKey) {
          return {
            delivered: false,
            channel: 'unconfigured',
            note: 'MAIL_MODE=sendgrid but SENDGRID_API_KEY is not configured; nothing was sent',
          };
        }
        if (!to) {
          return {
            delivered: false,
            channel: 'sendgrid',
            note: 'sendgrid: missing recipient',
          };
        }
        try {
          const body = {
            personalizations: [{ to: [{ email: to }] }],
            from: { email: fromParts.email || from, name: fromParts.name || 'CGI' },
            subject: subject || 'CGI',
            content: [
              { type: 'text/plain', value: `${text}\n\n${url}` },
              { type: 'text/html', value: htmlBody(message) },
            ],
          };
          const resp = await fetch(sgEndpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
          const responseBody = await resp.text();
          if (resp.ok) {
            return { delivered: true, channel: 'sendgrid' };
          }
          let detail = responseBody.slice(0, 300);
          try { const parsed = JSON.parse(responseBody); detail = (parsed.errors || []).map(e => e.message).join('; ') || detail; } catch (e) { /* keep raw */ }
          log(`[MAIL:sendgrid] API error ${resp.status}: ${detail}`);
          return {
            delivered: false,
            channel: 'sendgrid',
            note: `sendgrid API ${resp.status}: ${detail}`,
          };
        } catch (e) {
          log(`[MAIL:sendgrid] fetch error: ${e && e.message || e}`);
          return {
            delivered: false,
            channel: 'sendgrid',
            note: `sendgrid fetch error: ${e && e.message || e}`,
          };
        }
      }
      return {
        delivered: false,
        channel: 'console-log',
        note: 'EMAIL 발송 미연결: 메시지는 Worker 로그로만 기록되었습니다',
      };
    },

    get from() {
      return from;
    },
  };
}
