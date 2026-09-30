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
    var SKIP = '[data-avatar], .avatar-inline, .bin-icon, .bin-icon-img, .forum-icon-img, .brand-icon, .nav-avatar, .person-menu, .person-picker, .ib-avatar, .avatar-marker, .lightbox, .chat-web-avatar, .pp-avatar, .rv-row .avatar-inline, .chat-rich-link-media, .chat-rich-media-thumb, .files-preview-panel, .leaflet-container';
    var overlay = null;
    var lastFocus = null;

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
            '.lightbox-loading{color:#888;font-size:13px}';
        document.head.appendChild(style);
    }

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        document.removeEventListener('keydown', onKey);
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } }
        lastFocus = null;
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

    function open(url, opts) {
        opts = opts || {};
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
        name.textContent = opts.name || fileName(url);
        var size = document.createElement('span');
        var openLink = document.createElement('a');
        openLink.href = url; openLink.target = '_blank'; openLink.rel = 'noopener'; openLink.textContent = 'Open original';
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button'; closeBtn.textContent = 'Close'; closeBtn.setAttribute('aria-label', 'Close');
        bar.appendChild(name); bar.appendChild(size); bar.appendChild(openLink); bar.appendChild(closeBtn);
        var loading = document.createElement('div');
        loading.className = 'lightbox-loading';
        loading.textContent = 'Loading...';
        var img = new Image();
        img.className = 'lightbox-img' + (opts.pixel ? ' is-pixel' : '');
        img.alt = name.textContent;
        img.onload = function () {
            loading.remove();
            size.textContent = img.naturalWidth + ' x ' + img.naturalHeight;
            if (img.naturalWidth <= 320 && img.naturalHeight <= 200) img.classList.add('is-pixel');
        };
        img.onerror = function () { loading.textContent = 'Could not load that picture.'; };
        img.src = url;
        overlay.appendChild(bar);
        overlay.appendChild(loading);
        overlay.appendChild(img);
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
