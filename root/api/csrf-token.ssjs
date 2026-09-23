/* csrf-token.ssjs — Return the session's CURRENT CSRF token.
 *
 * Long-lived pages carry the token that was baked in at render time; when it
 * goes stale (re-login in another tab, recycled session) every write fails
 * with "Invalid CSRF token" until a full reload. This endpoint lets the
 * client resync and retry instead (see js/csrf-guard.js). Same exposure as
 * the <meta name="csrf-token"> tag in index.xjs: the token belongs to the
 * cookie-authenticated session making the request; guests get ''.
 */
require('sbbsdefs.js', 'SYS_CLOSED');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
write(JSON.stringify({ csrf_token: getCsrfToken() || '' }));
