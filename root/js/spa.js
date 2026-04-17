/* spa.js - Client-side SPA router for Synchronet webv4
 *
 * Uses History API (pushState/popstate) to intercept navigation.
 * Fetches page fragments from /api/page.ssjs and swaps #content.
 * Terminal panel and MQTT connection survive navigation.
 */
(function () {
    'use strict';

    var contentEl = document.getElementById('content');
    var sidebarEl = document.getElementById('sidebar');
    var isNavigating = false;
    var sidebarRefreshMs = 60000;

    /* ---------- helpers ---------- */

    function getPageFromUrl(url) {
        try {
            var u = new URL(url, location.origin);
            return u.searchParams.get('page') || '000-home.xjs';
        } catch (e) {
            return '000-home.xjs';
        }
    }

    /** Build the query string to send to the fragment endpoint.
     *  Preserves all params (page, group, sub, msg, etc). */
    function getQueryString(url) {
        try {
            var u = new URL(url, location.origin);
            if (!u.searchParams.get('page')) u.searchParams.set('page', '000-home.xjs');
            return u.searchParams.toString();
        } catch (e) {
            return 'page=000-home.xjs';
        }
    }

    /** Build the user-facing URL for pushState */
    function buildDisplayUrl(url) {
        try {
            var u = new URL(url, location.origin);
            var page = u.searchParams.get('page') || '000-home.xjs';
            if (page === '000-home.xjs' && u.searchParams.size <= 1) return './';
            return './' + u.search;
        } catch (e) {
            return './';
        }
    }

    function isInternalLink(a) {
        if (!a || !a.href) return false;
        if (a.target === '_blank') return false;
        if (a.hasAttribute('download')) return false;
        if (a.hasAttribute('data-no-spa')) return false;
        try {
            var u = new URL(a.href, location.origin);
            if (u.origin !== location.origin) return false;
        } catch (e) { return false; }
        var href = a.getAttribute('href') || '';
        if (href.charAt(0) === '#') return false;
        if (href.indexOf('./api/') === 0 || href.indexOf('/api/') === 0) return false;
        if (href.match(/\.(zip|gz|tar|pdf|jpg|png|gif|mp3|mp4)$/i)) return false;
        return true;
    }

    function executeScripts(container) {
        var scripts = Array.from(container.querySelectorAll('script'));
        var i = 0;
        function next() {
            if (i >= scripts.length) return;
            var old = scripts[i++];
            var s = document.createElement('script');
            Array.from(old.attributes).forEach(function (attr) {
                if (attr.name !== 'src') s.setAttribute(attr.name, attr.value);
            });
            if (old.src) {
                s.src = old.src + (old.src.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
                s.onload = next;
                s.onerror = next;
            } else {
                s.textContent = old.textContent;
            }
            old.parentNode.replaceChild(s, old);
            if (!old.src) next();
        }
        next();
    }

    function dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    }

    function drawAvatars(container) {
        if (typeof Avatars === 'undefined' || !Avatars.draw || !container) return;
        var avatarEls = container.querySelectorAll('div[data-avatar]');
        if (!avatarEls.length) return;
        var users = [];
        avatarEls.forEach(function (el) {
            var u = el.getAttribute('data-avatar');
            if (u && users.indexOf(u) < 0) users.push(u);
        });
        if (users.length) Avatars.draw(users);
    }

    function refreshSidebar() {
        if (!sidebarEl || sidebarEl.style.display === 'none') return Promise.resolve();
        // Skip when visualizer or terminal is active — reduce main-thread work
        if (document.body.classList.contains('viz-open')) return Promise.resolve();
        return fetch('./api/sidebar.ssjs', {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'SPA' }
        }).then(function (res) {
            return res.text();
        }).then(function (html) {
            if (!sidebarEl) return;
            sidebarEl.innerHTML = html;
            executeScripts(sidebarEl);
            drawAvatars(sidebarEl);
            dispatch('spa:sidebarRefreshed', {});
        }).catch(function (err) {
            console.error('Sidebar refresh error:', err);
        });
    }

    /* ---------- navigation ---------- */

    /** Navigate via SPA. href is a full or relative URL like "./?page=X&group=0" */
    function navigate(href, pushState) {
        if (isNavigating) return;
        isNavigating = true;

        var page = getPageFromUrl(href);
        var qs = getQueryString(href);
        dispatch('spa:beforeNavigate', { page: page });

        var url = './api/page.ssjs?' + qs;
        fetch(url, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'SPA' }
        }).then(function (res) {
            var title = res.headers.get('X-Page-Title') || '';
            var noSidebar = res.headers.get('X-Page-NoSidebar') === 'true';
            var redirect = res.headers.get('X-Page-Redirect');

            if (redirect) {
                window.open(redirect, '_blank');
                isNavigating = false;
                return;
            }

            return res.text().then(function (html) {
                contentEl.innerHTML = html;
                executeScripts(contentEl);

                document.title = title ? (title + ': ' + window.sbbsConfig.systemName) : window.sbbsConfig.systemName;

                if (sidebarEl) {
                    sidebarEl.style.display = noSidebar ? 'none' : '';
                    contentEl.className = noSidebar ? 'col-md-12' : 'col-md-9';
                }

                if (pushState !== false) {
                    var displayUrl = buildDisplayUrl(href);
                    history.pushState({ href: href, page: page }, title, displayUrl);
                }

                window.scrollTo(0, 0);
                drawAvatars(contentEl);

                var finishNavigate = function () {
                    window.sbbsConfig.currentPage = page;
                    dispatch('spa:afterNavigate', { page: page, title: title });
                    isNavigating = false;
                };

                if (noSidebar) {
                    finishNavigate();
                    return;
                }

                refreshSidebar().then(finishNavigate);
            });
        }).catch(function (err) {
            console.error('SPA navigation error:', err);
            window.location.href = href;
            isNavigating = false;
        });
    }

    /* ---------- event handlers ---------- */

    document.addEventListener('click', function (e) {
        var a = e.target.closest('a');
        if (!a) return;

        // Force external links to open in a new tab (critical for PWA)
        if (a.href && !a.target) {
            try {
                var u = new URL(a.href, location.origin);
                if (u.origin !== location.origin) {
                    e.preventDefault();
                    window.open(a.href, '_blank', 'noopener');
                    return;
                }
            } catch (ex) {}
        }

        if (!isInternalLink(a)) return;

        e.preventDefault();
        // Build a full URL from the href attribute for navigate()
        var href = a.getAttribute('href') || '';
        // Resolve relative to current page
        var fullUrl = new URL(href, location.href).href;
        navigate(fullUrl, true);
    });

    window.addEventListener('popstate', function (e) {
        /* Let page overlays (e.g. article readers) intercept back button */
        var check = new CustomEvent('spa:popstate', {
            cancelable: true, detail: { state: e.state }
        });
        if (!document.dispatchEvent(check)) return; /* overlay handled it */

        var href;
        if (e.state && e.state.href) {
            href = e.state.href;
        } else {
            href = location.href;
        }
        navigate(href, false);
    });

    history.replaceState(
        { href: location.href, page: window.sbbsConfig.currentPage },
        document.title,
        location.href
    );

    // On first load, draw avatars in SSR content
    drawAvatars(contentEl);
    refreshSidebar();
    window.setInterval(refreshSidebar, sidebarRefreshMs);
})();
