/* lightbox.js - see a picture bigger without leaving the app
 *
 * Any image on the site opens in a full-window overlay instead of a new tab:
 *   - a link to an image file (chat image embeds, forum attachments, file
 *     downloads that are pictures) opens the linked picture
 *   - a picture sitting in the content on its own (wiki embeds, inline
 *     forum images, rendered ANSI) opens itself
 * Avatars, icons and buttons are left alone. Click the picture to toggle
 * between fit-to-window and full size, Esc or the backdrop closes, and
 * "Open original" still hands the file to a new tab when wanted.
 */
(function () {
    'use strict';
    var IMAGE_URL = /\.(png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#].*)?$/i;
    var IMAGE_PARAM = /[?&]file=([^&#]+)/i;
    var SKIP = '[data-avatar], .avatar-inline, .tdf-heading, .bin-icon, .bin-icon-img, .forum-icon-img, .brand-icon, .nav-avatar, .person-menu, .person-picker, .ib-avatar, .avatar-marker, .lightbox, .chat-web-avatar, .pp-avatar, .rv-row .avatar-inline, .chat-rich-link-media, .chat-rich-media-thumb, .files-preview-panel, .leaflet-container';
    var overlay = null;
    var lastFocus = null;
    var parts = null;   /* the open overlay's pieces, for in-place swaps */

    function isImageUrl(url) {
        if (!url) return false;
        if (IMAGE_URL.test(url)) return true;
        var m = IMAGE_PARAM.exec(url);
        if (m) { try { return IMAGE_URL.test(decodeURIComponent(m[1])); } catch (e) { return false; } }
        return false;
    }
    function fileName(url) {
        var m = IMAGE_PARAM.exec(url);
        var name = m ? m[1] : String(url).replace(/[?#].*$/, '').replace(/^.*\//, '');
        try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
        return name;
    }

    function injectStyle() {
        if (document.getElementById('lightbox-style')) return;
        var style = document.createElement('style');
        style.id = 'lightbox-style';
        style.textContent =
            '.lightbox{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:auto;cursor:zoom-out}' +
            '.lightbox-img{max-width:100vw;max-height:calc(100vh - 44px);image-rendering:auto;cursor:zoom-in;display:block;box-shadow:0 0 24px #000}' +
            '.lightbox.is-full{justify-content:flex-start;align-items:flex-start;cursor:default}' +
            '.lightbox.is-full .lightbox-img{max-width:none;max-height:none;cursor:zoom-out;margin:44px auto 0}' +
            '.lightbox-img.is-pixel{image-rendering:pixelated}' +
            '.lightbox-bar{position:fixed;top:0;left:0;right:0;height:44px;display:flex;align-items:center;gap:12px;padding:0 12px;background:rgba(0,0,0,.7);color:#aaa;font-size:13px;font-family:inherit;z-index:1;cursor:default}' +
            '.lightbox-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#55ffff}' +
            '.lightbox-bar a,.lightbox-bar button{background:none;border:1px solid #555;color:#ddd;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;text-decoration:none;border-radius:2px}' +
            '.lightbox-bar a:hover,.lightbox-bar button:hover{border-color:#55ffff;color:#fff}' +
            '.lightbox-loading{color:#888;font-size:13px}' +
            '.lightbox-nav{position:fixed;top:50%;transform:translateY(-50%);z-index:1;background:rgba(0,0,0,.7);border:1px solid #55ff55;color:#fff;font-family:inherit;font-size:28px;line-height:1;padding:14px 12px;cursor:pointer;border-radius:2px}' +
            '.lightbox-nav:hover{background:#55ff55;color:#000}' +
            '.lightbox-nav[hidden]{display:none}' +
            '.lightbox-prev{left:10px}.lightbox-next{right:10px}' +
            '.lightbox.is-busy .lightbox-img{opacity:.4;transition:opacity .2s}';
        document.head.appendChild(style);
    }

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        parts = null;
        document.removeEventListener('keydown', onKey);
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
        lastFocus = null;
    }
    function step(dir) {
        var fn = parts && (dir < 0 ? parts.onPrev : parts.onNext);
        if (!fn) return;
        overlay.classList.add('is-busy');
        fn();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowLeft' && parts && parts.onPrev) { e.preventDefault(); step(-1); }
        else if (e.key === 'ArrowRight' && parts && parts.onNext) { e.preventDefault(); step(1); }
    }

    /* Put a picture into the open overlay: name, size, link, arrows. */
    function fill(url, opts) {
        var p = parts;
        p.onPrev = typeof opts.onPrev === 'function' ? opts.onPrev : null;
        p.onNext = typeof opts.onNext === 'function' ? opts.onNext : null;
        p.prev.hidden = !p.onPrev;
        p.next.hidden = !p.onNext;
        overlay.classList.remove('is-busy');
        p.name.textContent = opts.name || fileName(url);
        p.size.textContent = '';
        p.openLink.href = url;
        p.loading.textContent = 'Loading...';
        if (!p.loading.parentNode) overlay.insertBefore(p.loading, p.img);
        var img = p.img;
        img.className = 'lightbox-img' + (opts.pixel ? ' is-pixel' : '');
        img.alt = p.name.textContent;
        img.onload = function () {
            p.loading.remove();
            p.size.textContent = img.naturalWidth + ' x ' + img.naturalHeight;
            if (img.naturalWidth <= 320 && img.naturalHeight <= 200) img.classList.add('is-pixel');
        };
        img.onerror = function () { p.loading.textContent = 'Could not load that picture.'; };
        img.src = url;
        overlay.scrollTop = 0;
    }

    /* opts: name, pixel; onPrev / onNext (functions) add arrows and the
       Left/Right keys. They are expected to call open() again with
       replace: true, which swaps the picture without closing the overlay
       (full-size mode and focus stay as they are). */
    function open(url, opts) {
        opts = opts || {};
        if (overlay && opts.replace) { fill(url, opts); return; }
        injectStyle();
        close();
        lastFocus = document.activeElement;
        overlay = document.createElement('div');
        overlay.className = 'lightbox';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-label', 'Picture');
        var bar = document.createElement('div');
        bar.className = 'lightbox-bar';
        var name = document.createElement('span');
        name.className = 'lightbox-name';
        var size = document.createElement('span');
        var openLink = document.createElement('a');
        openLink.target = '_blank'; openLink.rel = 'noopener'; openLink.textContent = 'Open original';
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button'; closeBtn.textContent = 'Close'; closeBtn.setAttribute('aria-label', 'Close');
        bar.appendChild(name); bar.appendChild(size); bar.appendChild(openLink); bar.appendChild(closeBtn);
        var loading = document.createElement('div');
        loading.className = 'lightbox-loading';
        var img = new Image();
        function navButton(dir, label, glyph) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'lightbox-nav lightbox-' + (dir < 0 ? 'prev' : 'next');
            b.setAttribute('aria-label', label); b.title = label;
            b.innerHTML = glyph;
            b.addEventListener('click', function (e) { e.stopPropagation(); step(dir); });
            return b;
        }
        var prev = navButton(-1, 'Previous', '&laquo;'), next = navButton(1, 'Next', '&raquo;');
        overlay.appendChild(bar);
        overlay.appendChild(loading);
        overlay.appendChild(img);
        overlay.appendChild(prev);
        overlay.appendChild(next);
        parts = { name: name, size: size, openLink: openLink, loading: loading, img: img, prev: prev, next: next };
        fill(url, opts);
        overlay.addEventListener('click', function (e) {
            if (e.target === img) { overlay.classList.toggle('is-full'); return; }
            if (e.target.closest('.lightbox-bar') && !e.target.closest('button')) return;
            close();
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
        closeBtn.focus();
    }

    /* Which picture a click means, or null to let the click through. */
    function pictureFor(target) {
        if (!target || target.closest(SKIP)) return null;
        var link = target.closest('a[href]');
        if (link) {
            if (link.closest(SKIP) || link.hasAttribute('download') || link.getAttribute('data-no-lightbox') !== null) return null;
            var href = link.getAttribute('href') || '';
            if (isImageUrl(href)) return { url: link.href, name: fileName(href) };
            var inner = link.querySelector('img');
            if (inner && link.href && isImageUrl(link.href)) return { url: link.href, name: fileName(link.href) };
            /* A link wrapping its own picture (chat image cards) is a picture
               link even with no extension to go on: a short link (tinyurl)
               or a download endpoint that would save the file instead. */
            if (inner && link.href && (inner.currentSrc || inner.src) === link.href) {
                return { url: link.href, name: inner.getAttribute('alt') || fileName(link.href) };
            }
            return null;
        }
        var img = target.closest('img');
        if (!img || !img.closest('#content')) return null;
        if (img.closest('button, [role="button"], .card-header, label')) return null;
        if (img.getAttribute('data-no-lightbox') !== null) return null;
        var big = (img.naturalWidth || img.width) >= 160 || (img.naturalHeight || img.height) >= 120;
        if (!big) return null;
        return { url: img.currentSrc || img.src, name: img.getAttribute('alt') || img.getAttribute('title') || fileName(img.src), pixel: /ansi-canvas-img/.test(img.className) };
    }

    document.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var pic = pictureFor(e.target);
        if (!pic || !pic.url) return;
        e.preventDefault();
        e.stopPropagation();
        open(pic.url, { name: pic.name, pixel: pic.pixel });
    }, true);

    window.Lightbox = { open: open, close: close };
})();
