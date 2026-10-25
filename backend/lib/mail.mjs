// CGI customer mail adapter (issue #69).
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
//   sendgrid            Placeholder. Returns delivered=false with a note until a
//                       provider credential is wired up.
//
// This adapter NEVER marks an account as verified. Verification only happens
// when a client presents a valid, unexpired token.

export const MAIL_MODES = ['console', 'echo', 'sendgrid'];

export function createMailAdapter(env, log = () => {}) {
  const mode = String(env.MAIL_MODE || 'console').toLowerCase();
  const from = String(env.MAIL_FROM || 'CGI no-reply <no-reply@cgi.example>');
  const base = String(env.MAIL_BASE_URL || '').replace(/\/+$/, '');
  const siteBase = String(env.SITE_BASE_URL || base || 'https://skerishkang.github.io/kbs261022/site').replace(/\/+$/, '');

  return {
    mode: MAIL_MODES.includes(mode) ? mode : 'console',

    /** Build the public URL a mail recipient should open. */
    urlFor(path, token) {
      const clean = path.startsWith('/') ? path : `/${path}`;
      if (!token) return `${siteBase}${clean}`;
      const sep = clean.includes('?') ? '&' : '?';
      return `${siteBase}${clean}${sep}token=${encodeURIComponent(token)}`;
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
      if (this.mode === 'sendgrid') {
        return {
          delivered: false,
          channel: 'unconfigured',
          note: 'MAIL_MODE=sendgrid but no provider credential is configured; nothing was sent',
        };
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
