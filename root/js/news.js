/* news.js — Client-side News Reader for webv4 SPA
 *
 * Architecture:
 *   Server provides:  feed catalog (categories, feed URLs) + thin CORS proxy
 *   Client handles:   RSS/Atom fetching, XML parsing, rendering, navigation
 *
 * Views:  categories → feeds → articles → article
 */
(function () {
    'use strict';

    /* ── constants ───────────────────────────────────────────────────── */

    var API = './api/news.ssjs';
    var FEEDS_PER_PAGE = 25;
    var PROXY_CACHE_TTL = 5 * 60 * 1000;   // 5 min client-side

    /* ── state ───────────────────────────────────────────────────────── */

    var state = {
        view: 'categories',           // categories | feeds | articles | article
        categories: null,             // array from API
        currentCategory: null,        // { slug, name, ... }
        feeds: null,                  // current page of feeds
        feedsTotal: 0,
        feedsOffset: 0,
        searchTerm: '',
        favorites: [],                // array of URL strings
        currentFeed: null,            // { key, label, url, ... }
        favIconData: null,            // base64 heart_normal.bin
        articles: null,               // parsed from RSS
        currentArticle: null,         // single article object
        feedTitle: ''                 // channel title from the RSS
    };

    var feedXmlCache = {};            // url -> { body, time }

    /* ── DOM refs ────────────────────────────────────────────────────── */

    var $content    = document.getElementById('news-content');
    var $breadcrumb = document.getElementById('news-breadcrumb');
    var $bcOl       = $breadcrumb ? $breadcrumb.querySelector('.breadcrumb') : null;
    var $searchBar  = document.getElementById('news-search-bar');
    var $searchBtn  = document.getElementById('news-search-btn');
    var $searchIn   = document.getElementById('news-search-input');
    var $searchClr  = document.getElementById('news-search-clear');
    var $pagination = document.getElementById('news-pagination');
    var $pagUl      = $pagination ? $pagination.querySelector('.pagination') : null;
    var suppressNextHashChange = false;
    var hashChangeHandler = null;
    var beforeNavigateHandler = null;

    /* ── utilities ───────────────────────────────────────────────────── */

    function esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(s));
        return d.innerHTML;
    }

    function apiCall(call, params) {
        var qs = 'call=' + encodeURIComponent(call);
        if (params) Object.keys(params).forEach(function (k) {
            if (params[k] !== '' && params[k] !== undefined && params[k] !== null)
                qs += '&' + k + '=' + encodeURIComponent(params[k]);
        });
        return fetch(API + '?' + qs, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); });
    }

    function debounce(fn, ms) {
        var t;
        return function () {
            clearTimeout(t);
            t = setTimeout(fn, ms);
        };
    }

    function findCategoryBySlug(slug) {
        if (!slug) return null;
        if (slug === '__favorites__') {
            return { slug: '__favorites__', name: 'Favorites', feedCount: state.favorites.length };
        }
        if (!state.categories) return null;
        for (var i = 0; i < state.categories.length; i++) {
            if (state.categories[i].slug === slug) return state.categories[i];
        }
        return null;
    }

    function normalizeRoute(route) {
        var view = route && route.view ? route.view : 'categories';
        var allowed = { categories: true, feeds: true, articles: true, article: true };
        var category = route && route.category ? String(route.category) : '';
        var search = route && route.search ? String(route.search) : '';
        var offset = parseInt(route && route.offset, 10);
        var feedUrl = route && route.feedUrl ? String(route.feedUrl) : '';
        var feedLabel = route && route.feedLabel ? String(route.feedLabel) : '';
        var articleLink = route && route.articleLink ? String(route.articleLink) : '';
        var articleTitle = route && route.articleTitle ? String(route.articleTitle) : '';

        if (!allowed[view]) view = 'categories';
        if (isNaN(offset) || offset < 0) offset = 0;
        offset = Math.floor(offset / FEEDS_PER_PAGE) * FEEDS_PER_PAGE;

        if (search) category = '';

        if (view === 'categories') {
            category = '';
            search = '';
            offset = 0;
            feedUrl = '';
            feedLabel = '';
            articleLink = '';
            articleTitle = '';
        } else if (view === 'feeds') {
            feedUrl = '';
            feedLabel = '';
            articleLink = '';
            articleTitle = '';
            if (!category && !search) view = 'categories';
        } else if (view === 'articles') {
            articleLink = '';
            articleTitle = '';
            if (!feedUrl) view = category || search ? 'feeds' : 'categories';
        } else if (view === 'article') {
            if (!feedUrl) view = category || search ? 'feeds' : 'categories';
        }

        return {
            view: view,
            category: category,
            search: search,
            offset: offset,
            feedUrl: feedUrl,
            feedLabel: feedLabel,
            articleLink: articleLink,
            articleTitle: articleTitle
        };
    }

    function currentRoute() {
        return normalizeRoute({
            view: state.view,
            category: state.currentCategory ? state.currentCategory.slug : '',
            search: state.searchTerm || '',
            offset: state.feedsOffset || 0,
            feedUrl: state.currentFeed ? state.currentFeed.url : '',
            feedLabel: state.currentFeed ? state.currentFeed.label : '',
            articleLink: state.currentArticle ? state.currentArticle.link : '',
            articleTitle: state.currentArticle ? state.currentArticle.title : ''
        });
    }

    function buildNewsHash(route) {
        route = normalizeRoute(route);
        var params = new URLSearchParams();
        params.set('view', route.view);
        if (route.category) params.set('category', route.category);
        if (route.search) params.set('search', route.search);
        if (route.offset) params.set('offset', String(route.offset));
        if (route.feedUrl) params.set('feed_url', route.feedUrl);
        if (route.feedLabel) params.set('feed_label', route.feedLabel);
        if (route.articleLink) {
            params.set('article_link', route.articleLink);
        } else if (route.articleTitle) {
            params.set('article_title', route.articleTitle);
        }
        return '#news?' + params.toString();
    }

    function parseNewsHash() {
        if (!location.hash || location.hash.indexOf('#news') !== 0) return null;
        var raw = location.hash.slice(5);
        if (raw.charAt(0) === '?') raw = raw.slice(1);
        var params = new URLSearchParams(raw);
        return normalizeRoute({
            view: params.get('view'),
            category: params.get('category'),
            search: params.get('search'),
            offset: params.get('offset'),
            feedUrl: params.get('feed_url'),
            feedLabel: params.get('feed_label'),
            articleLink: params.get('article_link'),
            articleTitle: params.get('article_title')
        });
    }

    function newsUrlWithHash(hash) {
        return location.pathname + location.search + hash;
    }

    function syncRoute(mode) {
        var hash = buildNewsHash(currentRoute());
        if (mode === 'replace') {
            history.replaceState(history.state, document.title, newsUrlWithHash(hash));
            return;
        }
        if (location.hash === hash) return;
        suppressNextHashChange = true;
        location.hash = hash;
    }

    function findArticleFromRoute(route, articles) {
        var i;
        if (!articles || !articles.length) return null;
        if (route.articleLink) {
            for (i = 0; i < articles.length; i++) {
                if ((articles[i].link || '') === route.articleLink) return articles[i];
            }
        }
        if (route.articleTitle) {
            for (i = 0; i < articles.length; i++) {
                if ((articles[i].title || '') === route.articleTitle) return articles[i];
            }
        }
        return null;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        try {
            var d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            var months = ['Jan','Feb','Mar','Apr','May','Jun',
                          'Jul','Aug','Sep','Oct','Nov','Dec'];
            return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
        } catch (e) { return dateStr; }
    }

    function formatTime(dateStr) {
        if (!dateStr) return '';
        try {
            var d = new Date(dateStr);
            if (isNaN(d.getTime())) return '';
            var h = d.getHours(), m = d.getMinutes();
            var ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12; if (h === 0) h = 12;
            return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
        } catch (e) { return ''; }
    }

    function dateKey(dateStr) {
        if (!dateStr) return '__none';
        try {
            var d = new Date(dateStr);
            if (isNaN(d.getTime())) return '__none';
            return d.getFullYear() + '-' +
                   (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' +
                   (d.getDate() < 10 ? '0' : '') + d.getDate();
        } catch (e) { return '__none'; }
    }

    /* ── icon rendering (reuses GraphicsConverter from bin-icons.js) ── */

    function renderIconToImg(b64data, cols, rows, callback) {
        if (!b64data || typeof GraphicsConverter === 'undefined') {
            callback(null);
            return;
        }
        try {
            GraphicsConverter.shared().from_bin(
                atob(b64data), cols || 12, rows || 6,
                function (url) { callback(url); }, true
            );
        } catch (e) { callback(null); }
    }

    /* ── RSS / Atom parsing (client-side, native DOMParser) ──────────── */

    function getText(el, tagName) {
        if (!el) return '';
        /* Work around namespace issues: try direct child scan by local name */
        var children = el.childNodes;
        var local = tagName.toLowerCase();
        for (var i = 0; i < children.length; i++) {
            var nn = children[i].nodeName;
            if (!nn) continue;
            /* Match exact or namespaced (e.g. dc:creator matches 'creator') */
            var parts = nn.split(':');
            var localPart = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase();
            if (localPart === local) {
                return (children[i].textContent || '').trim();
            }
        }
        /* Fallback: querySelector */
        try {
            var t = el.querySelector(tagName);
            if (t) return (t.textContent || '').trim();
        } catch (e) {}
        return '';
    }

    function getAttr(el, selector, attr) {
        if (!el) return '';
        try {
            var t = el.querySelector(selector);
            return t ? (t.getAttribute(attr) || '') : '';
        } catch (e) { return ''; }
    }

    function getEnclosureImage(item) {
        var enclosures = item.querySelectorAll('enclosure');
        for (var i = 0; i < enclosures.length; i++) {
            var type = enclosures[i].getAttribute('type') || '';
            if (type.indexOf('image/') === 0)
                return enclosures[i].getAttribute('url') || '';
        }
        /* media:thumbnail or media:content */
        var mediaTags = ['thumbnail', 'content'];
        for (var m = 0; m < mediaTags.length; m++) {
            var els = item.getElementsByTagName('media:' + mediaTags[m]);
            if (!els.length) els = item.getElementsByTagName(mediaTags[m]);
            for (var j = 0; j < els.length; j++) {
                var mtype = els[j].getAttribute('medium') || els[j].getAttribute('type') || '';
                var murl = els[j].getAttribute('url') || '';
                if (murl && (mtype === 'image' || mtype.indexOf('image/') === 0 || !mtype))
                    return murl;
            }
        }
        return '';
    }

    function extractFirstImage(html) {
        if (!html) return '';
        var m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        return m ? m[1] : '';
    }

    function parseFeedXml(xmlText) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(xmlText, 'text/xml');
        var err = doc.querySelector('parsererror');
        if (err) return { error: 'Failed to parse feed XML' };

        /* Atom */
        var atomFeed = doc.querySelector('feed');
        if (atomFeed) return parseAtom(atomFeed);

        /* RSS 2.0 */
        var chan = doc.querySelector('channel');
        if (chan) return parseRSS(chan);

        /* RDF / RSS 1.0 */
        var items = doc.getElementsByTagName('item');
        if (items.length) return parseRDF(doc, items);

        return { error: 'Unknown feed format' };
    }

    function parseRSS(channel) {
        var items = channel.querySelectorAll('item');
        var articles = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var desc = getText(it, 'description');
            /* content:encoded — getElementsByTagName handles namespace prefix */
            var encoded = '';
            var ceList = it.getElementsByTagName('encoded');
            if (!ceList.length) ceList = it.getElementsByTagName('content:encoded');
            if (ceList.length) encoded = (ceList[0].textContent || '').trim();

            var thumb = getEnclosureImage(it) || extractFirstImage(encoded || desc);

            articles.push({
                title:       getText(it, 'title'),
                link:        getText(it, 'link'),
                description: desc,
                content:     encoded || desc,
                pubDate:     getText(it, 'pubDate') || getText(it, 'date'),
                author:      getText(it, 'author') || getText(it, 'creator'),
                thumbnail:   thumb
            });
        }
        return {
            title:       getText(channel, 'title'),
            description: getText(channel, 'description'),
            articles:    articles
        };
    }

    function parseAtom(feed) {
        var entries = feed.querySelectorAll('entry');
        var articles = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var content = getText(e, 'content') || getText(e, 'summary');
            var link = getAttr(e, 'link[rel="alternate"]', 'href')
                    || getAttr(e, 'link', 'href')
                    || getText(e, 'link');
            var thumb = getEnclosureImage(e) || extractFirstImage(content);
            articles.push({
                title:       getText(e, 'title'),
                link:        link,
                description: getText(e, 'summary'),
                content:     content,
                pubDate:     getText(e, 'published') || getText(e, 'updated'),
                author:      getText(e, 'name') || getText(e, 'author'),
                thumbnail:   thumb
            });
        }
        return {
            title:       getText(feed, 'title'),
            description: getText(feed, 'subtitle'),
            articles:    articles
        };
    }

    function parseRDF(doc, items) {
        var articles = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            articles.push({
                title:       getText(it, 'title'),
                link:        getText(it, 'link'),
                description: getText(it, 'description'),
                content:     getText(it, 'description'),
                pubDate:     getText(it, 'date'),
                author:      getText(it, 'creator'),
                thumbnail:   ''
            });
        }
        var chanTitle = '';
        var ch = doc.querySelector('channel');
        if (ch) chanTitle = getText(ch, 'title');
        return { title: chanTitle, articles: articles };
    }

    /* ── feed fetching (via CORS proxy, with client cache) ───────────── */

    function fetchFeed(url) {
        var cached = feedXmlCache[url];
        if (cached && (Date.now() - cached.time) < PROXY_CACHE_TTL) {
            return Promise.resolve(parseFeedXml(cached.body));
        }
        var proxyUrl = API + '?call=proxy-feed&url=' + encodeURIComponent(url);
        return fetch(proxyUrl, { credentials: 'same-origin' })
            .then(function (r) {
                if (!r.ok) throw new Error('Proxy returned ' + r.status);
                var ct = r.headers.get('Content-Type') || '';
                if (ct.indexOf('json') >= 0) {
                    /* Proxy returned a JSON error */
                    return r.json().then(function (j) {
                        throw new Error(j.message || 'Proxy error');
                    });
                }
                return r.text();
            })
            .then(function (xmlText) {
                feedXmlCache[url] = { body: xmlText, time: Date.now() };
                return parseFeedXml(xmlText);
            });
    }

    /* ── sanitise article HTML ───────────────────────────────────────── */

    function sanitizeHtml(raw) {
        if (!raw) return '';
        var div = document.createElement('div');
        div.innerHTML = raw;
        /* Remove dangerous elements */
        var dangerous = div.querySelectorAll(
            'script, style, iframe, object, embed, form, link, meta'
        );
        for (var i = 0; i < dangerous.length; i++)
            dangerous[i].parentNode.removeChild(dangerous[i]);
        /* Strip on* event attributes, force links to new tab */
        var all = div.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
            var attrs = all[j].attributes;
            for (var k = attrs.length - 1; k >= 0; k--) {
                if (attrs[k].name.toLowerCase().indexOf('on') === 0)
                    all[j].removeAttribute(attrs[k].name);
            }
            if (all[j].tagName === 'A') {
                all[j].setAttribute('target', '_blank');
                all[j].setAttribute('rel', 'noopener noreferrer');
            }
        }
        return div.innerHTML;
    }

    /* ── rendering ───────────────────────────────────────────────────── */

    function render() {
        switch (state.view) {
            case 'categories': renderCategories(); break;
            case 'feeds':      renderFeeds();      break;
            case 'articles':   renderArticles();   break;
            case 'article':    renderArticle();    break;
        }
        renderBreadcrumb();
        renderPagination();
        renderSearchBar();
    }

    /* ─ breadcrumb ─ */
    function renderBreadcrumb() {
        if (!$bcOl) return;
        var crumbs = [];
        crumbs.push({ label: 'News', view: 'categories' });

        if (state.view === 'feeds' || state.view === 'articles' || state.view === 'article') {
            if (state.currentCategory) {
                crumbs.push({
                    label: state.currentCategory.name,
                    view: 'feeds',
                    category: state.currentCategory
                });
            } else if (state.searchTerm) {
                crumbs.push({ label: 'Search: ' + state.searchTerm });
            }
        }
        if (state.view === 'articles' || state.view === 'article') {
            if (state.currentFeed) {
                crumbs.push({
                    label: state.currentFeed.label,
                    view: 'articles',
                    feed: state.currentFeed
                });
            }
        }
        $bcOl.innerHTML = '';
        for (var i = 0; i < crumbs.length; i++) {
            var li = document.createElement('li');
            li.className = 'breadcrumb-item' + (i === crumbs.length - 1 ? ' active' : '');
            if (i < crumbs.length - 1 && crumbs[i].view) {
                var a = document.createElement('a');
                a.href = '#';
                a.textContent = crumbs[i].label;
                a.setAttribute('data-no-spa', 'true');
                (function (c) {
                    a.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        navigateTo(c);
                    });
                })(crumbs[i]);
                li.appendChild(a);
            } else {
                li.textContent = crumbs[i].label;
            }
            $bcOl.appendChild(li);
        }
        $breadcrumb.style.display = crumbs.length > 1 ? '' : 'none';
    }

    function navigateTo(crumb) {
        if (crumb.view === 'categories') {
            applyRoute({ view: 'categories' }, 'push');
        } else if (crumb.view === 'feeds' && crumb.category) {
            openCategory(crumb.category, 'push');
        } else if (crumb.view === 'articles' && crumb.feed) {
            openFeed(crumb.feed, 'push');
        }
    }

    /* ─ search ─ */
    function renderSearchBar() {
        if (!$searchBar) return;
        var show = (state.view === 'categories' || state.view === 'feeds');
        $searchBar.style.display = show ? '' : 'none';
    }

    /* ─ pagination ─ */
    function renderPagination() {
        if (!$pagination || !$pagUl) return;
        if (state.view !== 'feeds' || state.feedsTotal <= FEEDS_PER_PAGE) {
            $pagination.style.display = 'none';
            return;
        }
        $pagination.style.display = '';
        $pagUl.innerHTML = '';
        var totalPages = Math.ceil(state.feedsTotal / FEEDS_PER_PAGE);
        var curPage = Math.floor(state.feedsOffset / FEEDS_PER_PAGE);

        function addPage(label, page, disabled, active) {
            var li = document.createElement('li');
            li.className = 'page-item' + (disabled ? ' disabled' : '') + (active ? ' active' : '');
            var a = document.createElement('a');
            a.className = 'page-link';
            a.href = '#';
            a.textContent = label;
            a.setAttribute('data-no-spa', 'true');
            if (!disabled && !active) {
                a.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    state.feedsOffset = page * FEEDS_PER_PAGE;
                    syncRoute('push');
                    loadFeeds();
                });
            }
            li.appendChild(a);
            $pagUl.appendChild(li);
        }

        addPage('\u00AB', curPage - 1, curPage === 0, false);
        var start = Math.max(0, curPage - 3);
        var end = Math.min(totalPages, start + 7);
        if (end - start < 7) start = Math.max(0, end - 7);
        for (var p = start; p < end; p++) {
            addPage(String(p + 1), p, false, p === curPage);
        }
        addPage('\u00BB', curPage + 1, curPage >= totalPages - 1, false);
    }

    /* ── categories view ─────────────────────────────────────────────── */

    function renderCategories() {
        if (!state.categories) {
            $content.innerHTML = '<div class="news-loading">Loading categories\u2026</div>';
            return;
        }

        var isLoggedIn = !!(window.sbbsConfig && window.sbbsConfig.isLoggedIn);
        var html = '<div class="news-cat-grid">';

        /* Favorites pseudo-category (logged-in users with favorites only) */
        if (isLoggedIn && state.favorites.length > 0) {
            html += '<div class="news-cat-card is-favorites" data-slug="__favorites__">'
                  + '<div class="news-cat-icon" data-fav-icon></div>'
                  + '<div class="news-cat-name">Favorites</div>'
                  + '<div class="news-cat-count">' + state.favorites.length + ' feeds</div>'
                  + '</div>';
        }

        for (var i = 0; i < state.categories.length; i++) {
            var cat = state.categories[i];
            html += '<div class="news-cat-card" data-slug="' + esc(cat.slug) + '">'
                  + '<div class="news-cat-icon" data-cat-icon="' + i + '"></div>'
                  + '<div class="news-cat-name">' + esc(cat.name) + '</div>'
                  + '<div class="news-cat-count">' + cat.feedCount + ' feeds</div>'
                  + '</div>';
        }
        html += '</div>';
        $content.innerHTML = html;

        /* Render bin icons for categories */
        var iconContainers = $content.querySelectorAll('[data-cat-icon]');
        for (var j = 0; j < iconContainers.length; j++) {
            var idx = parseInt(iconContainers[j].getAttribute('data-cat-icon'), 10);
            var catObj = state.categories[idx];
            if (catObj && catObj.iconData) {
                (function (container, data) {
                    renderIconToImg(data, 12, 6, function (url) {
                        if (url) {
                            container.innerHTML = '<img src="' + url + '">';
                        }
                    });
                })(iconContainers[j], catObj.iconData);
            }
        }

        /* Render favorites icon from heart_normal.bin */
        if (state.favIconData) {
            var favEl = $content.querySelector('[data-fav-icon]');
            if (favEl) {
                renderIconToImg(state.favIconData, 12, 6, function (url) {
                    if (url) favEl.innerHTML = '<img src="' + url + '">';
                });
            }
        }

        /* Click handlers */
        var cards = $content.querySelectorAll('.news-cat-card');
        for (var k = 0; k < cards.length; k++) {
            cards[k].addEventListener('click', function () {
                var slug = this.getAttribute('data-slug');
                if (slug === '__favorites__') {
                    openCategory({ slug: '__favorites__', name: 'Favorites', feedCount: state.favorites.length });
                    return;
                }
                for (var ci = 0; ci < state.categories.length; ci++) {
                    if (state.categories[ci].slug === slug) {
                        openCategory(state.categories[ci]);
                        break;
                    }
                }
            });
        }
    }

    function openCategory(cat, historyMode) {
        state.view = 'feeds';
        state.currentCategory = cat;
        state.currentFeed = null;
        state.currentArticle = null;
        state.articles = null;
        state.feeds = null;
        state.feedsTotal = 0;
        state.feedTitle = '';
        state.feedsOffset = 0;
        state.searchTerm = '';
        if ($searchIn) $searchIn.value = '';
        render();
        if (historyMode !== 'none') syncRoute(historyMode || 'push');
        return loadFeeds();
    }

    /* ── feeds view ──────────────────────────────────────────────────── */

    function loadFeeds() {
        $content.innerHTML = '<div class="news-loading">Loading feeds\u2026</div>';
        var params = { offset: state.feedsOffset, limit: FEEDS_PER_PAGE };
        if (state.searchTerm) {
            params.search = state.searchTerm;
        } else if (state.currentCategory) {
            params.category = state.currentCategory.slug;
        }
        return apiCall('get-feeds', params).then(function (data) {
            state.feeds = data.feeds || [];
            state.feedsTotal = data.total || 0;
            state.feedsOffset = data.offset || 0;
            renderFeeds();
            renderPagination();
        }).catch(function (e) {
            $content.innerHTML = '<div class="news-error">Failed to load feeds: ' + esc(String(e)) + '</div>';
        });
    }

    function renderFeeds() {
        if (!state.feeds) return;
        if (!state.feeds.length) {
            $content.innerHTML = '<div class="news-empty">No feeds found.</div>';
            return;
        }
        var isLoggedIn = !!(window.sbbsConfig && window.sbbsConfig.isLoggedIn);

        var html = '<ul class="news-feed-list">';
        for (var i = 0; i < state.feeds.length; i++) {
            var f = state.feeds[i];
            var isFav = state.favorites.indexOf(f.url) >= 0;
            html += '<li class="news-feed-item" data-url="' + esc(f.url) + '" data-idx="' + i + '">';
            if (isLoggedIn) {
                html += '<button class="news-feed-fav' + (isFav ? ' is-favorite' : '') + '" '
                      + 'data-url="' + esc(f.url) + '" title="Toggle favorite">'
                      + (isFav ? '\u2665' : '\u2661') + '</button>';
            }
            html += '<span class="news-feed-label">' + esc(f.label) + '</span>'
                  + '</li>';
        }
        html += '</ul>';
        $content.innerHTML = html;

        /* Click: open feed */
        var rows = $content.querySelectorAll('.news-feed-item');
        for (var j = 0; j < rows.length; j++) {
            rows[j].addEventListener('click', function (ev) {
                if (ev.target.closest && ev.target.closest('.news-feed-fav')) return;
                var idx = parseInt(this.getAttribute('data-idx'), 10);
                if (state.feeds[idx]) openFeed(state.feeds[idx]);
            });
        }

        /* Click: toggle favorite */
        var favBtns = $content.querySelectorAll('.news-feed-fav');
        for (var k = 0; k < favBtns.length; k++) {
            favBtns[k].addEventListener('click', function (ev) {
                ev.stopPropagation();
                var url = this.getAttribute('data-url');
                toggleFavorite(url, this);
            });
        }
    }

    function toggleFavorite(url, btn) {
        apiCall('toggle-favorite', { url: url }).then(function (data) {
            state.favorites = data.feeds || [];
            if (btn) {
                btn.classList.toggle('is-favorite', data.favorited);
                btn.textContent = data.favorited ? '\u2665' : '\u2661';
            }
        }).catch(function () {});
    }

    /* ── articles view ───────────────────────────────────────────────── */

    function openFeed(feed, historyMode) {
        state.view = 'articles';
        state.currentFeed = feed;
        state.currentArticle = null;
        state.articles = null;
        state.feedTitle = feed && feed.label ? feed.label : '';
        render();
        if (historyMode !== 'none') syncRoute(historyMode || 'push');

        $content.innerHTML = '<div class="news-loading">Fetching feed\u2026</div>';

        return fetchFeed(feed.url).then(function (data) {
            if (data.error) {
                $content.innerHTML = '<div class="news-error">' + esc(data.error) + '</div>';
                return;
            }
            state.articles = data.articles || [];
            state.feedTitle = data.title || feed.label;
            if (state.currentFeed && data.title) state.currentFeed.label = data.title;
            syncRoute('replace');
            renderArticles();
        }).catch(function (e) {
            $content.innerHTML = '<div class="news-error">Failed to load feed: ' + esc(String(e)) + '</div>';
        });
    }

    function renderArticles() {
        if (!state.articles) return;
        if (!state.articles.length) {
            $content.innerHTML = '<div class="news-empty">No articles found in this feed.</div>';
            return;
        }

        var html = '<ul class="news-article-list">';
        var lastDate = '';

        for (var i = 0; i < state.articles.length; i++) {
            var a = state.articles[i];
            var dk = dateKey(a.pubDate);
            if (dk !== lastDate) {
                lastDate = dk;
                html += '<li class="news-date-divider">'
                      + esc(formatDate(a.pubDate) || 'Unknown date')
                      + '</li>';
            }

            var thumbHtml;
            if (a.thumbnail) {
                thumbHtml = '<img class="news-article-thumb" src="' + esc(a.thumbnail)
                          + '" loading="lazy" onerror="this.style.display=\'none\'">';
            } else {
                thumbHtml = '<div class="news-article-thumb placeholder-thumb">\uD83D\uDCF0</div>';
            }

            var byline = '';
            if (a.author) byline += esc(a.author);
            if (a.pubDate) {
                var t = formatTime(a.pubDate);
                if (t) byline += (byline ? ' \u00B7 ' : '') + t;
            }

            html += '<li class="news-article-row" data-idx="' + i + '">'
                  + thumbHtml
                  + '<div class="news-article-meta">'
                  + '<div class="news-article-title">' + esc(a.title || 'Untitled') + '</div>'
                  + '<div class="news-article-byline">' + byline + '</div>'
                  + '</div></li>';
        }
        html += '</ul>';
        $content.innerHTML = html;

        var rows = $content.querySelectorAll('.news-article-row');
        for (var j = 0; j < rows.length; j++) {
            rows[j].addEventListener('click', function () {
                var idx = parseInt(this.getAttribute('data-idx'), 10);
                if (state.articles[idx]) openArticle(state.articles[idx]);
            });
        }
    }

    /* ── article detail view ─────────────────────────────────────────── */

    function openArticle(article, historyMode) {
        state.view = 'article';
        state.currentArticle = article;
        if (historyMode !== 'none') syncRoute(historyMode || 'push');
        render();
    }

    function renderArticle() {
        var a = state.currentArticle;
        if (!a) return;

        var byline = '';
        if (a.author) byline += esc(a.author);
        var fdate = formatDate(a.pubDate);
        var ftime = formatTime(a.pubDate);
        if (fdate) byline += (byline ? ' \u00B7 ' : '') + fdate;
        if (ftime) byline += ' at ' + ftime;

        var bodyHtml = sanitizeHtml(a.content || a.description || '');
        if (!bodyHtml) bodyHtml = '<p class="text-muted">No content available for this article.</p>';

        var html = '<div class="news-article-detail">'
                 + '<h2>' + esc(a.title || 'Untitled') + '</h2>'
                 + '<div class="article-byline">' + byline + '</div>';

        if (a.thumbnail) {
            html += '<img src="' + esc(a.thumbnail) + '" class="img-fluid rounded mb-3" '
                  + 'onerror="this.style.display=\'none\'">';
        }

        html += '<div class="article-body">' + bodyHtml + '</div>';

        if (a.link) {
            html += '<a class="news-article-link btn btn-sm btn-outline-primary mt-3" '
                  + 'href="' + esc(a.link) + '" target="_blank" rel="noopener noreferrer">'
                  + '\uD83D\uDD17 Read original</a>';
        }

        html += '</div>';
        $content.innerHTML = html;
        window.scrollTo(0, 0);
    }

    /* ── search handling ─────────────────────────────────────────────── */

    function handleSearch() {
        var hadSearch = !!state.searchTerm;
        var term = ($searchIn ? $searchIn.value : '').trim();
        state.searchTerm = term;
        state.feedsOffset = 0;

        if (term) {
            state.view = 'feeds';
            state.currentCategory = null;
            state.currentFeed = null;
            state.currentArticle = null;
            state.articles = null;
            state.feedTitle = '';
            state.feeds = null;
            render();
            syncRoute(hadSearch ? 'replace' : 'push');
            loadFeeds();
        } else if (state.view === 'feeds' && !state.currentCategory) {
            state.view = 'categories';
            state.currentFeed = null;
            state.currentArticle = null;
            state.articles = null;
            state.feeds = null;
            state.feedsTotal = 0;
            render();
            syncRoute('replace');
        } else if (state.view === 'feeds' && state.currentCategory) {
            syncRoute('replace');
            loadFeeds();
        }
    }

    if ($searchIn) {
        $searchIn.addEventListener('input', debounce(handleSearch, 350));
        $searchIn.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                handleSearch();
                return;
            }
            if (ev.key === 'Escape') {
                $searchIn.value = '';
                handleSearch();
            }
        });
    }
    if ($searchBtn) {
        $searchBtn.addEventListener('click', function () {
            handleSearch();
        });
    }
    if ($searchClr) {
        $searchClr.addEventListener('click', function () {
            if ($searchIn) $searchIn.value = '';
            handleSearch();
        });
    }

    /* ── init ────────────────────────────────────────────────────────── */

    function applyRoute(route, historyMode) {
        route = normalizeRoute(route || { view: 'categories' });

        state.searchTerm = route.search || '';
        state.feedsOffset = route.offset || 0;
        if ($searchIn) $searchIn.value = state.searchTerm;

        if (route.view === 'categories') {
            state.view = 'categories';
            state.currentCategory = null;
            state.currentFeed = null;
            state.currentArticle = null;
            state.feeds = null;
            state.feedsTotal = 0;
            state.articles = null;
            state.feedTitle = '';
            render();
            if (historyMode && historyMode !== 'none') syncRoute(historyMode);
            return Promise.resolve();
        }

        state.currentCategory = route.category ? findCategoryBySlug(route.category) : null;
        if (route.category && !state.currentCategory && !route.search) {
            return applyRoute({ view: 'categories' }, historyMode);
        }

        if (route.view === 'feeds') {
            state.view = 'feeds';
            state.currentFeed = null;
            state.currentArticle = null;
            state.articles = null;
            state.feedTitle = '';
            state.feeds = null;
            state.feedsTotal = 0;
            render();
            if (historyMode && historyMode !== 'none') syncRoute(historyMode);
            return loadFeeds();
        }

        state.currentFeed = {
            url: route.feedUrl,
            label: route.feedLabel || route.feedUrl
        };
        state.currentArticle = null;
        state.articles = null;
        state.feedTitle = route.feedLabel || '';
        state.view = 'articles';
        render();
        if (historyMode && historyMode !== 'none') syncRoute(historyMode);

        $content.innerHTML = '<div class="news-loading">Fetching feed\u2026</div>';
        return fetchFeed(route.feedUrl).then(function (data) {
            if (data.error) {
                $content.innerHTML = '<div class="news-error">' + esc(data.error) + '</div>';
                return;
            }
            state.articles = data.articles || [];
            state.feedTitle = data.title || state.currentFeed.label;
            if (state.currentFeed && data.title) state.currentFeed.label = data.title;

            if (route.view === 'article') {
                var article = findArticleFromRoute(route, state.articles);
                if (article) {
                    state.view = 'article';
                    state.currentArticle = article;
                }
            }
            syncRoute('replace');
            render();
        }).catch(function (e) {
            $content.innerHTML = '<div class="news-error">Failed to load feed: ' + esc(String(e)) + '</div>';
        });
    }

    function init() {
        var catP = apiCall('get-categories');
        var favP = apiCall('get-favorites');

        Promise.all([catP, favP]).then(function (results) {
            state.categories = results[0].categories || [];
            state.favIconData = results[0].favIconData || null;
            state.favorites = results[1].feeds || [];
            var route = parseNewsHash();
            if (route) {
                applyRoute(route, 'none');
            } else {
                render();
                syncRoute('replace');
            }
        }).catch(function (e) {
            $content.innerHTML = '<div class="news-error">Failed to initialize: '
                + esc(String(e)) + '</div>';
        });

        if (window.__sbbsNewsHashChangeHandler) {
            window.removeEventListener('hashchange', window.__sbbsNewsHashChangeHandler);
        }
        if (window.__sbbsNewsBeforeNavigateHandler) {
            window.removeEventListener('spa:beforeNavigate', window.__sbbsNewsBeforeNavigateHandler);
        }

        hashChangeHandler = function () {
            if (suppressNextHashChange) {
                suppressNextHashChange = false;
                return;
            }
            applyRoute(parseNewsHash() || { view: 'categories' }, 'none');
        };
        window.__sbbsNewsHashChangeHandler = hashChangeHandler;
        window.addEventListener('hashchange', hashChangeHandler);

        beforeNavigateHandler = function (ev) {
            if (ev && ev.detail && ev.detail.page === '009-news.xjs') return;
            if (window.__sbbsNewsHashChangeHandler === hashChangeHandler) {
                window.removeEventListener('hashchange', hashChangeHandler);
                delete window.__sbbsNewsHashChangeHandler;
            }
            if (window.__sbbsNewsBeforeNavigateHandler === beforeNavigateHandler) {
                window.removeEventListener('spa:beforeNavigate', beforeNavigateHandler);
                delete window.__sbbsNewsBeforeNavigateHandler;
            }
        };
        window.__sbbsNewsBeforeNavigateHandler = beforeNavigateHandler;
        window.addEventListener('spa:beforeNavigate', beforeNavigateHandler);

        /* Re-render bin icons after SPA navigation loads the page */
        if (typeof renderAllBinIcons === 'function') {
            setTimeout(renderAllBinIcons, 100);
        }
    }

    init();

})();
