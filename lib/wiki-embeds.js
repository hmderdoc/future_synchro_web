/* wiki-embeds.js - server-side renderer for wiki media embeds
 *
 * The wiki markup carries `![ansi](file.ans)`, `![track](song.mp3)`,
 * `![image](pic.png)` and `![avatar](Alias)` (xtrn/wiki README, "Media
 * embeds"). WikiCore only parses them; this turns each into HTML for the web
 * page and the profile page's About Me, resolving targets ONLY inside the
 * creation directories (social_lib's creationPath), so a page can never
 * point at an arbitrary file.
 *
 * Usage (after load(social_lib) and load(wiki-core)):
 *   load(settings.web_lib + 'wiki-embeds.js');
 *   WikiCore.renderHtml(WikiCore.parse(body), resolver, WikiEmbeds.renderer(settings));
 *
 * Targets: `file.ans` looks in the kind's default area (ANSI / MP3S / IMGS);
 * `dir_code:file` names another creation area (e.g. artwork_bbs_ads:spudz.ans);
 * `wiki:file.png` is the Wiki > Images area the editor uploads into
 * (api/wiki-upload.ssjs). Any dir of the Wiki library also resolves.
 */
var WikiEmbeds = (function () {
    var DEFAULT_DIR = { ansi: 'originalcontent_ansi', track: 'originalcontent_mp3s', image: 'originalcontent_imgs' };
    var _ansiViewer = null;

    function esc(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function urlEncode(value) {
        return String(value).replace(/[^A-Za-z0-9_.~-]/g, function (ch) {
            var code = ch.charCodeAt(0);
            return '%' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase();
        });
    }

    /* "dir_code:file" or "file" -> { dir, name } (never a path). */
    function splitTarget(kind, target) {
        var raw = String(target || '').replace(/^\s+|\s+$/g, '');
        var colon = raw.indexOf(':');
        var dir = DEFAULT_DIR[kind] || '';
        var name = raw;
        if (colon > 0 && /^[a-z0-9_]+$/i.test(raw.substring(0, colon))) {
            dir = raw.substring(0, colon).toLowerCase();
            name = raw.substring(colon + 1);
            if (dir === 'wiki') dir = 'wiki_images';
        }
        name = name.replace(/^.*[\\\/]/, '');
        return { dir: dir, name: name };
    }

    /* Like Social.creationPath, but for the Wiki library's own dirs. */
    function wikiPath(dirCode, name) {
        var dir = file_area.dir[dirCode];
        if (!dir || String(dir.lib_name || '').toLowerCase() !== 'wiki') return '';
        if (!name.length || /[\/\\\x00]/.test(name) || name === '.' || name === '..') return '';
        return file_exists(dir.path + name) ? dir.path + name : '';
    }

    function ansiViewer(settings) {
        if (_ansiViewer === null) {
            try { _ansiViewer = load({}, settings.web_lib + 'ansi-viewer.js'); } catch (e) { _ansiViewer = false; }
        }
        return _ansiViewer || null;
    }

    function placeholder(embed, text) {
        return '<span class="wiki-embed wiki-embed-' + esc(embed.kind) + ' wiki-embed-missing" title="' + esc(embed.target) + '">' + esc(text) + '</span>';
    }

    /* The renderer WikiCore.renderHtml takes as its third argument. */
    function renderer(settings) {
        return function (embed) {
            var kind = embed.kind;
            var label = embed.label || '';
            var t, path, viewer, rendered, name;
            if (typeof Social === 'undefined') return null;
            if (kind === 'avatar') {
                name = String(embed.target || '').replace(/[\x00-\x1f<>"']/g, '').substr(0, 60);
                if (!name.length) return null;
                return '<span class="wiki-embed wiki-embed-avatar"><span class="wiki-avatar" data-avatar="' + esc(name) + '"></span>' +
                    '<a href="./?page=013-profile.xjs&amp;user=' + urlEncode(name) + '">' + esc(label || name) + '</a></span>';
            }
            t = splitTarget(kind, embed.target);
            path = wikiPath(t.dir, t.name) || Social.creationPath(t.dir, t.name);
            if (!path) return placeholder(embed, '[' + kind + ' not found: ' + t.name + ']');
            if (kind === 'ansi') {
                if (!/\.(ans|asc|bin)$/i.test(path)) return placeholder(embed, '[not an ANSI file: ' + t.name + ']');
                viewer = ansiViewer(settings);
                /* Canvas rendering (js/ansi-render.js upgrades the wrapper) with the <pre> as fallback. */
                rendered = viewer ? viewer.render_file_wrapper(path) : null;
                if (!rendered || !rendered.ok) return placeholder(embed, '[ansi: ' + t.name + ']');
                return '<figure class="wiki-embed wiki-embed-ansi">' + rendered.html +
                    (label ? '<figcaption>' + esc(label) + '</figcaption>' : '') + '</figure>';
            }
            if (kind === 'track') {
                if (!/\.mp3$/i.test(path)) return placeholder(embed, '[not a track: ' + t.name + ']');
                return '<span class="wiki-embed wiki-embed-track" data-track="' + esc(t.name) + '">' +
                    '<button type="button" class="wiki-track-play" data-track="' + esc(t.name) + '">&#9654;</button> ' +
                    '<a href="./radio-stream/' + urlEncode(t.name) + '" target="_blank" rel="noopener">' + esc(label || t.name.replace(/\.mp3$/i, '').replace(/_/g, ' ')) + '</a></span>';
            }
            if (kind === 'image') {
                if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return placeholder(embed, '[not an image: ' + t.name + ']');
                return '<figure class="wiki-embed wiki-embed-image"><img src="./api/files.ssjs?call=download-file&amp;dir=' + esc(t.dir) +
                    '&amp;file=' + urlEncode(t.name) + '" alt="' + esc(label || t.name) + '" loading="lazy">' +
                    (label ? '<figcaption>' + esc(label) + '</figcaption>' : '') + '</figure>';
            }
            return null;
        };
    }

    return { renderer: renderer, splitTarget: splitTarget };
}());
