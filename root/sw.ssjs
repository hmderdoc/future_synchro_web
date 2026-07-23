http_reply.header['Content-Type'] = 'application/javascript; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
http_reply.header['Pragma'] = 'no-cache';
http_reply.header['Expires'] = '0';

var ROOT_DIR = backslash(fullpath(js.exec_dir));
var ASSET_DIRS = ['js', 'css', 'lib', 'images'];
var ASSET_EXTENSIONS = {
    '.css': true,
    '.eot': true,
    '.gif': true,
    '.ico': true,
    '.jpg': true,
    '.js': true,
    '.png': true,
    '.svg': true,
    '.ttf': true,
    '.woff': true,
    '.woff2': true
};
var CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js'
];
var SHELL_URLS = [
    './',
    './?page=000-home.xjs'
];

function walkAssetFiles(dirPath, files) {
    if (!file_isdir(dirPath)) return;
    var entries = directory(backslash(dirPath) + '*') || [];
    entries.sort();
    entries.forEach(function (entry) {
        if (file_isdir(entry)) {
            walkAssetFiles(entry, files);
            return;
        }
        var ext = file_getext(entry).toLowerCase();
        if (ASSET_EXTENSIONS[ext]) files.push(fullpath(entry));
    });
}

function toWebPath(filePath) {
    var rel = fullpath(filePath).replace(ROOT_DIR, '').replace(/\\/g, '/');
    rel = rel.replace(/^\/+/, '');
    return './' + rel;
}

function revisionToken(filePath) {
    return md5_calc(filePath + ':' + file_size(filePath) + ':' + file_date(filePath), true).substr(0, 12);
}

var files = [];
ASSET_DIRS.forEach(function (dirName) {
    walkAssetFiles(backslash(ROOT_DIR + dirName), files);
});

var terminalIframe = backslash(ROOT_DIR + 'terminal-iframe.html');
if (file_exists(terminalIframe)) files.push(fullpath(terminalIframe));

files.sort();

var manifest = {};
var combined = '';

files.forEach(function (filePath) {
    var webPath = toWebPath(filePath);
    var token = revisionToken(filePath);
    manifest[webPath] = token;
    combined += webPath + ':' + token + '\n';
});

CDN_ASSETS.forEach(function (url) {
    manifest[url] = 'cdn-pinned';
    combined += url + ':cdn-pinned\n';
});

var revision = md5_calc(combined + 'salt-20260328m-chat-cga-restyle', true).substr(0, 12);
var workerSource = [
    '// Dynamic service worker for webv4_custom.',
    '// Revision: ' + revision,
    '',
    'var CACHE_PREFIX = "futureland-";',
    'var CACHE_NAME = CACHE_PREFIX + "' + revision + '";',
    'var ASSET_MANIFEST = ' + JSON.stringify(manifest, null, 4) + ';',
    'var PRECACHE_URLS = Object.keys(ASSET_MANIFEST);',
    'var SHELL_URLS = ' + JSON.stringify(SHELL_URLS, null, 4) + ';',
    '',
    'self.addEventListener("install", function (event) {',
    '    event.waitUntil(',
    '        caches.open(CACHE_NAME).then(function (cache) {',
    '            return cache.addAll(PRECACHE_URLS);',
    '        }).then(function () {',
    '            return caches.open(CACHE_NAME).then(function (cache) {',
    '                return Promise.all(SHELL_URLS.map(function (url) {',
    '                    return cache.add(url).catch(function () {',
    '                        console.log("[SW] Shell URL skipped:", url);',
    '                    });',
    '                }));',
    '            });',
    '        }).then(function () {',
    '            return self.skipWaiting();',
    '        })',
    '    );',
    '});',
    '',
    'self.addEventListener("activate", function (event) {',
    '    event.waitUntil(',
    '        caches.keys().then(function (names) {',
    '            return Promise.all(',
    '                names.filter(function (name) {',
    '                    return name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME;',
    '                }).map(function (name) {',
    '                    console.log("[SW] Purging old cache:", name);',
    '                    return caches.delete(name);',
    '                })',
    '            );',
    '        }).then(function () {',
    '            return self.clients.claim();',
    '        })',
    '    );',
    '});',
    '',
    'self.addEventListener("fetch", function (event) {',
    '    var url = new URL(event.request.url);',
    '    if (event.request.method !== "GET") return;',
    '    if (url.pathname.indexOf("/api/") !== -1) return;',
    '    if (url.pathname.indexOf("/events/") !== -1) return;',
    '    if (url.pathname.indexOf("/ws") !== -1) return;',
    '    if (url.pathname.indexOf("/radio-stream/") !== -1) return;',
    '',
    '    // Terminal code must be network-first. A stale cache here can pair an',
    '    // old iframe with newly deployed protocol/audio support indefinitely.',
    '    var isLiveTerminalAsset = /\\/(terminal-iframe\\.html|js\\/(terminal|ansi-music)\\.js)$/.test(url.pathname);',
    '    if (isLiveTerminalAsset) {',
    '        event.respondWith(',
    '            fetch(event.request, { cache: "no-store" }).then(function (response) {',
    '                if (response && response.status === 200) {',
    '                    var copy = response.clone();',
    '                    caches.open(CACHE_NAME).then(function (cache) {',
    '                        cache.put(event.request, copy);',
    '                    });',
    '                }',
    '                return response;',
    '            }).catch(function () {',
    '                return caches.match(event.request).then(function (cached) {',
    '                    return cached || caches.match(event.request.url.split("?")[0]);',
    '                });',
    '            })',
    '        );',
    '        return;',
    '    }',
    '',
    '    var requestUrl = event.request.url;',
    '    var bareUrl = requestUrl.split("?")[0];',
    '    var isManifested = false;',
    '    var keys = Object.keys(ASSET_MANIFEST);',
    '    for (var i = 0; i < keys.length; i++) {',
    '        var abs = new URL(keys[i], self.location.href).href;',
    '        if (abs === bareUrl || abs === requestUrl) {',
    '            isManifested = true;',
    '            break;',
    '        }',
    '    }',
    '',
    '    if (isManifested) {',
    '        event.respondWith(',
    '            caches.match(event.request).then(function (cached) {',
    '                if (cached) return cached;',
    '                return caches.match(bareUrl).then(function (cachedBare) {',
    '                    if (cachedBare) return cachedBare;',
    '                    return fetch(event.request).then(function (response) {',
    '                        if (response && response.status === 200) {',
    '                            try {',
    '                                var cloned = response.clone();',
    '                                caches.open(CACHE_NAME).then(function (cache) {',
    '                                    cache.put(event.request, cloned);',
    '                                });',
    '                            } catch (e) { /* body already consumed — skip caching */ }',
    '                        }',
    '                        return response;',
    '                    });',
    '                });',
    '            })',
    '        );',
    '        return;',
    '    }',
    '',
    '    var accept = event.request.headers.get("Accept") || "";',
    '    if (accept.indexOf("text/html") !== -1) {',
    '        event.respondWith(',
    '            fetch(event.request).then(function (response) {',
    '                if (response && response.status === 200) {',
    '                    try {',
    '                        var cloned = response.clone();',
    '                        caches.open(CACHE_NAME).then(function (cache) {',
    '                            cache.put(event.request, cloned);',
    '                        });',
    '                    } catch (e) { /* body already consumed — skip caching */ }',
    '                }',
    '                return response;',
    '            }).catch(function () {',
    '                return caches.match(event.request);',
    '            })',
    '        );',
    '        return;',
    '    }',
    '',
    '    event.respondWith(',
    '        fetch(event.request).then(function (response) {',
    '            if (response && response.status === 200 && url.origin === self.location.origin) {',
    '                try {',
    '                    var cloned = response.clone();',
    '                    caches.open(CACHE_NAME).then(function (cache) {',
    '                        cache.put(event.request, cloned);',
    '                    });',
    '                } catch (e) { /* body already consumed — skip caching */ }',
    '            }',
    '            return response;',
    '        }).catch(function () {',
    '            return caches.match(event.request);',
    '        })',
    '    );',
    '});',
    '',
    'self.addEventListener("message", function (event) {',
    '    if (event.data && event.data.type === "SKIP_WAITING") {',
    '        self.skipWaiting();',
    '    }',
    '});',
    ''
].join('\n');

write(workerSource);
