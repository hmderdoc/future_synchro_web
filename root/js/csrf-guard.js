/* csrf-guard.js — site-wide recovery from stale CSRF tokens.
 *
 * Every write in this UI goes through fetch() with an `x-csrf-token` header,
 * sourced from window.sbbsConfig.csrfToken or from a copy the page baked into
 * a local variable at render time. When the session's token changes under a
 * long-lived page (re-login in another tab, recycled session), those writes
 * 403 and the user loses whatever they were submitting.
 *
 * This wrapper intercepts exactly the requests that carry the token header:
 *  1. outgoing, it substitutes the page's live token for any stale baked-in
 *     copy (window.sbbsConfig.csrfToken is the single source of truth);
 *  2. when the reply says the token was invalid, it fetches the session's
 *     current token from api/csrf-token.ssjs, updates sbbsConfig and the
 *     <meta name="csrf-token"> tag, and replays the request ONCE.
 * Requests without the header (reads, downloads) pass through untouched.
 *
 * Load this before any app script so every later fetch call is wrapped.
 */
(function () {
    'use strict';
    if (window.__csrfGuardInstalled) return;
    window.__csrfGuardInstalled = true;
    if (!window.fetch) return;
    var nativeFetch = window.fetch;

    /* wiki: {error:true,message:'Invalid CSRF token'} (403)
       files: {error:'Invalid CSRF token'} (200)
       webmonitor: {error:'Invalid or missing CSRF token'} */
    var ERROR_PATTERN = /invalid (or missing )?csrf token/i;

    function currentToken() {
        return (window.sbbsConfig && window.sbbsConfig.csrfToken)
            ? String(window.sbbsConfig.csrfToken) : '';
    }

    function rememberToken(token) {
        if (!token) return false;
        window.sbbsConfig = window.sbbsConfig || {};
        window.sbbsConfig.csrfToken = String(token);
        var meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) meta.setAttribute('content', String(token));
        return true;
    }

    function refreshToken() {
        return nativeFetch('./api/csrf-token.ssjs', { credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) { return rememberToken(data && data.csrf_token); })
            .catch(function () { return false; });
    }

    function getHeader(headers, name) {
        if (!headers) return null;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return headers.get(name);
        }
        for (var key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === name) {
                return headers[key];
            }
        }
        return null;
    }

    function setHeader(headers, name, value) {
        if (!headers) return;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            headers.set(name, value);
            return;
        }
        for (var key in headers) {
            if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === name) {
                headers[key] = value;
                return;
            }
        }
        headers[name] = value;
    }

    window.fetch = function (input, init) {
        var headers = init && init.headers;
        var sent = getHeader(headers, 'x-csrf-token');
        if (sent === null || sent === undefined) {
            return nativeFetch.apply(window, arguments);
        }

        /* The live token wins over any copy baked in at page render. */
        var live = currentToken();
        if (live && live !== sent) setHeader(headers, 'x-csrf-token', live);

        return nativeFetch(input, init).then(function (response) {
            var probe;
            try {
                probe = response.clone();
            } catch (_cloneError) {
                return response; /* already-consumed or opaque: hands off */
            }
            return probe.text().then(function (text) {
                /* Token-failure replies are tiny JSON; skip anything big. */
                if (text.length > 4096 || !ERROR_PATTERN.test(text)) return response;
                return refreshToken().then(function (ok) {
                    if (!ok) return response;
                    setHeader(headers, 'x-csrf-token', currentToken());
                    return nativeFetch(input, init); /* replay ONCE, unwrapped */
                });
            }, function () { return response; });
        });
    };
})();
