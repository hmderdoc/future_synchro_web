/* chat-media-config.js - the [chatmedia] section of ctrl/modopts.ini.
 *
 * Limits for the web chat's drag-and-drop attachments. api/chat-upload.ssjs
 * enforces them; pages/001-chat.xjs hands the browser-facing ones to
 * js/chat-upload.js so an oversize drop fails before it uploads. With no
 * section present every value is the built-in default below, which is what
 * the code did before the section existed.
 *
 *   [chatmedia]
 *       enabled = true
 *       max_image_mb = 20
 *       max_audio_mb = 20
 *       max_video_mb = 100        ; before re-encoding
 *       max_ansi_mb = 1
 *       video_max_seconds = 15
 *       video_max_height = 720
 *       retention_days = 7        ; mods/chat-media-purge.sh reads this too
 *       allowed_types =           ; comma list of extensions, blank = all
 *       max_open_uploads = 3      ; unfinished uploads per user
 *
 * Storage stays at <web_root>/chatmedia/<date>/ served as /chatmedia/: that
 * path is how every chat client recognises an attachment (js/chat-embeds.js
 * MEDIA_PATH, api/chat-ansi.ssjs), so it is not a setting.
 */

/* Every extension chat accepts, mapped to what it is stored as. */
var CHAT_MEDIA_TYPES = {
    png:  { ext: 'png',  kind: 'image', stream: 'video' },
    jpg:  { ext: 'jpg',  kind: 'image', stream: 'video' },
    jpeg: { ext: 'jpg',  kind: 'image', stream: 'video' },
    gif:  { ext: 'gif',  kind: 'image', stream: 'video' },
    webp: { ext: 'webp', kind: 'image', stream: 'video' },
    mp3:  { ext: 'mp3',  kind: 'audio', stream: 'audio' },
    m4a:  { ext: 'm4a',  kind: 'audio', stream: 'audio' },
    ogg:  { ext: 'ogg',  kind: 'audio', stream: 'audio' },
    oga:  { ext: 'ogg',  kind: 'audio', stream: 'audio' },
    wav:  { ext: 'wav',  kind: 'audio', stream: 'audio' },
    flac: { ext: 'flac', kind: 'audio', stream: 'audio' },
    mp4:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    m4v:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    mov:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    webm: { ext: 'mp4',  kind: 'video', stream: 'video' },
    ans:  { ext: 'ans',  kind: 'ansi',  stream: null },
    asc:  { ext: 'asc',  kind: 'ansi',  stream: null },
    nfo:  { ext: 'asc',  kind: 'ansi',  stream: null }
};

function chatMediaConfig() {
    var raw = null;
    try { raw = load({}, 'modopts.js', 'chatmedia'); } catch (_e) { raw = null; }
    if (!raw || typeof raw !== 'object') raw = {};

    function num(key, fallback) {
        var value = parseFloat(raw[key]);
        return isNaN(value) || value <= 0 ? fallback : value;
    }

    function mb(key, fallback) {
        return Math.floor(num(key, fallback) * 1024 * 1024);
    }

    var enabled = raw.enabled === undefined ? true : !(raw.enabled === false || /^(false|no|off|0)$/i.test(String(raw.enabled)));

    var types = {};
    var wanted = String(raw.allowed_types === undefined || raw.allowed_types === null ? '' : raw.allowed_types)
        .toLowerCase().split(/[\s,]+/);
    var ext;
    var any = false;
    for (var i = 0; i < wanted.length; i++) {
        ext = wanted[i].replace(/^\./, '');
        if (ext.length && CHAT_MEDIA_TYPES[ext]) { types[ext] = CHAT_MEDIA_TYPES[ext]; any = true; }
    }
    if (!any) {
        for (ext in CHAT_MEDIA_TYPES) types[ext] = CHAT_MEDIA_TYPES[ext];
    }

    return {
        enabled: enabled,
        types: types,
        maxBytes: {
            image: mb('max_image_mb', 20),
            audio: mb('max_audio_mb', 20),
            video: mb('max_video_mb', 100),
            ansi:  mb('max_ansi_mb', 1)
        },
        videoMaxSeconds: num('video_max_seconds', 15),
        videoMaxHeight: Math.floor(num('video_max_height', 720)),
        retentionDays: Math.floor(num('retention_days', 7)),
        maxOpenUploads: Math.floor(num('max_open_uploads', 3))
    };
}

/* The part the browser needs: extension -> kind, and the size caps. */
function chatMediaClientConfig(cfg) {
    var kinds = {};
    for (var ext in cfg.types) kinds[ext] = cfg.types[ext].kind;
    return { enabled: cfg.enabled, kinds: kinds, maxBytes: cfg.maxBytes, retentionDays: cfg.retentionDays };
}
