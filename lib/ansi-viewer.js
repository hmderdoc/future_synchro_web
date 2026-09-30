load('graphic.js');
var Sauce = load({}, 'sauce_lib.js');

var ansi_viewer = {
    settings_path: '/sbbs/xtrn/ansiview/settings.ini',
    default_gallery_key: 'futureland',
    supported_extensions: ['.ans', '.asc', '.bin'],
    slideshow_extensions: ['.ans'],
    hidden_files: ['.', 'ansiview.ini', 'ANSIVIEW.INI'],
    _galleries: null,
    _directories_cache: {},
    _files_cache: {}
};

ansi_viewer.trim = function (value) {
    return String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
};

ansi_viewer.escape_html = function (value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

ansi_viewer.normalize_key = function (value) {
    return ansi_viewer.trim(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
};

ansi_viewer.slugify = function (value) {
    var slug = ansi_viewer.trim(value).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    slug = slug.replace(/^-+|-+$/g, '');
    return slug || 'gallery';
};

ansi_viewer.ensure_trailing_slash = function (value) {
    value = String(value || '').replace(/[\\\/]+$/, '');
    return value.length ? value + '/' : '';
};

ansi_viewer.read_text_file = function (path) {
    var f = new File(path);
    if (!f.open('r')) return '';
    var text = f.read();
    f.close();
    return text;
};

ansi_viewer.safe_directory = function (pattern) {
    try {
        return directory(pattern) || [];
    } catch (_) {
        return [];
    }
};

ansi_viewer.safe_file_isdir = function (path) {
    try {
        return file_isdir(path);
    } catch (_) {
        return false;
    }
};

ansi_viewer.parse_settings = function () {
    if (ansi_viewer._galleries !== null) return ansi_viewer._galleries;

    var text = ansi_viewer.read_text_file(ansi_viewer.settings_path);
    var lines = text.replace(/\r/g, '').split('\n');
    var galleries = [];
    var current = null;
    var seen_ids = {};

    lines.forEach(function (raw_line) {
        var line = ansi_viewer.trim(raw_line);
        var section_match;
        var idx;
        var key;
        var value;

        if (!line.length || line.charAt(0) === ';' || line.charAt(0) === '#') return;

        section_match = line.match(/^\[(.+)\]$/);
        if (section_match) {
            current = { name: ansi_viewer.trim(section_match[1]) };
            galleries.push(current);
            return;
        }

        idx = line.indexOf('=');
        if (idx < 0) return;

        key = ansi_viewer.trim(line.substr(0, idx));
        value = ansi_viewer.trim(line.substr(idx + 1));

        if (current !== null) current[key] = value;
    });

    galleries = galleries.reduce(function (acc, gallery) {
        var label;
        var id;
        if (!gallery.path || !file_isdir(gallery.path)) return acc;
        if (gallery.module && gallery.module.toLowerCase() !== 'local.js') return acc;

        label = gallery.description || gallery.name || gallery.path;
        id = ansi_viewer.slugify(label);
        if (seen_ids[id]) {
            seen_ids[id] += 1;
            id += '-' + seen_ids[id];
        } else {
            seen_ids[id] = 1;
        }

        acc.push({
            id: id,
            name: gallery.name || label,
            description: gallery.description || label,
            path: String(gallery.path).replace(/[\\\/]+$/, ''),
            hide: gallery.hide || ''
        });
        return acc;
    }, []);

    ansi_viewer._galleries = galleries;
    return galleries;
};

ansi_viewer.get_default_gallery = function (galleries) {
    var fallback = galleries.length ? galleries[0] : null;
    var preferred = ansi_viewer.default_gallery_key;

    galleries.forEach(function (gallery) {
        if (ansi_viewer.normalize_key(gallery.id) === preferred) fallback = gallery;
        if (ansi_viewer.normalize_key(gallery.name) === preferred) fallback = gallery;
        if (ansi_viewer.normalize_key(gallery.description) === preferred) fallback = gallery;
    });

    return fallback;
};

ansi_viewer.get_gallery = function (gallery_id) {
    var galleries = ansi_viewer.parse_settings();
    var default_gallery = ansi_viewer.get_default_gallery(galleries);
    var ret = default_gallery;

    galleries.forEach(function (gallery) {
        if (gallery.id === gallery_id) ret = gallery;
    });

    return ret;
};

ansi_viewer.normalize_relative_path = function (value) {
    var parts;
    if (!value) return '';

    parts = String(value).replace(/\\/g, '/').split('/');
    parts = parts.reduce(function (acc, part) {
        part = ansi_viewer.trim(part);
        if (!part.length || part === '.') return acc;
        if (part === '..') return acc;
        acc.push(part);
        return acc;
    }, []);

    return parts.join('/');
};

ansi_viewer.resolve_directory = function (gallery, relative_dir) {
    relative_dir = ansi_viewer.normalize_relative_path(relative_dir);
    return ansi_viewer.ensure_trailing_slash(gallery.path) + (relative_dir.length ? relative_dir + '/' : '');
};

ansi_viewer.get_hide_patterns = function (gallery) {
    var patterns = ansi_viewer.hidden_files.slice(0);
    if (!gallery || !gallery.hide) return patterns;
    gallery.hide.split(',').forEach(function (pattern) {
        pattern = ansi_viewer.trim(pattern);
        if (pattern.length) patterns.push(pattern);
    });
    return patterns;
};

ansi_viewer.should_hide_name = function (name, gallery) {
    var lower_name = String(name || '').toLowerCase();
    return ansi_viewer.get_hide_patterns(gallery).some(function (pattern) {
        var lower_pattern = String(pattern).toLowerCase();
        return lower_name === lower_pattern || wildmatch(false, lower_name, lower_pattern);
    });
};

ansi_viewer.list_directories = function (gallery) {
    var cache_key = gallery && gallery.id ? gallery.id : String((gallery && gallery.path) || '');
    var root = ansi_viewer.ensure_trailing_slash(gallery.path);
    var result = [''];

    if (Object.prototype.hasOwnProperty.call(ansi_viewer._directories_cache, cache_key)) {
        return ansi_viewer._directories_cache[cache_key];
    }

    function walk(relative_dir) {
        var abs = root + (relative_dir.length ? relative_dir + '/' : '');
        ansi_viewer.safe_directory(abs + '*').forEach(function (entry) {
            var entry_name;
            var child_relative;

            if (!ansi_viewer.safe_file_isdir(entry)) return;
            try {
                entry_name = file_getname(String(entry).replace(/[\\\/]+$/, ''));
            } catch (_) {
                return;
            }
            if (!entry_name.length || ansi_viewer.should_hide_name(entry_name, gallery)) return;

            child_relative = relative_dir.length ? relative_dir + '/' + entry_name : entry_name;
            result.push(child_relative);
            walk(child_relative);
        });
    }

    walk('');
    result.sort(function (a, b) {
        var aa = a.toLowerCase();
        var bb = b.toLowerCase();
        if (aa < bb) return -1;
        if (aa > bb) return 1;
        return 0;
    });
    ansi_viewer._directories_cache[cache_key] = result;
    return result;
};

ansi_viewer.read_descriptions = function (abs_dir) {
    var desc_file = ansi_viewer.ensure_trailing_slash(abs_dir) + 'ansiview.ini';
    var f;
    var obj;

    if (!file_exists(desc_file)) return {};
    f = new File(desc_file);
    if (!f.open('r')) return {};
    obj = f.iniGetObject('descriptions') || {};
    f.close();
    return obj;
};

ansi_viewer.is_supported_file = function (name, extensions) {
    var ext = String(file_getext(name) || '').toLowerCase();
    var allowed = extensions && extensions.length ? extensions : ansi_viewer.supported_extensions;
    return allowed.indexOf(ext) >= 0;
};

ansi_viewer.normalize_scope = function (value) {
    value = ansi_viewer.trim(value).toLowerCase();
    if (value === 'all' || value === 'global') return 'all';
    if (value === 'gallery') return 'gallery';
    return 'directory';
};

ansi_viewer.normalize_order = function (value) {
    return ansi_viewer.trim(value).toLowerCase() === 'ordered' ? 'ordered' : 'random';
};

ansi_viewer.get_scope_label = function (scope, gallery, relative_dir) {
    scope = ansi_viewer.normalize_scope(scope);
    if (scope === 'all') return 'All Galleries';
    if (scope === 'gallery') return gallery ? gallery.description : 'Gallery';
    return relative_dir && relative_dir.length
        ? relative_dir
        : (gallery ? gallery.description : 'Directory');
};

ansi_viewer.list_files = function (gallery, relative_dir, options) {
    var allowed_extensions = (
        options &&
        options.extensions &&
        options.extensions.length
    ) ? options.extensions : ansi_viewer.supported_extensions;
    var normalized_dir = ansi_viewer.normalize_relative_path(relative_dir);
    var cache_key = [
        gallery && gallery.id ? gallery.id : String((gallery && gallery.path) || ''),
        normalized_dir,
        allowed_extensions.join(',')
    ].join('|');
    var abs_dir;
    var descriptions;
    var files;

    if (Object.prototype.hasOwnProperty.call(ansi_viewer._files_cache, cache_key)) {
        return ansi_viewer._files_cache[cache_key];
    }

    abs_dir = ansi_viewer.resolve_directory(gallery, normalized_dir);
    descriptions = ansi_viewer.read_descriptions(abs_dir);
    files = ansi_viewer.safe_directory(abs_dir + '*').reduce(function (acc, entry) {
        var name;
        var label;

        if (ansi_viewer.safe_file_isdir(entry)) return acc;
        try {
            name = file_getname(entry);
        } catch (_) {
            return acc;
        }
        if (!name.length || ansi_viewer.should_hide_name(name, gallery)) return acc;
        if (!ansi_viewer.is_supported_file(name, allowed_extensions)) return acc;

        label = descriptions[String(name).toLowerCase()];
        acc.push({
            name: name,
            label: label ? name + ' - ' + ansi_viewer.trim(label) : name
        });
        return acc;
    }, []);

    files.sort(function (a, b) {
        var aa = a.name.toLowerCase();
        var bb = b.name.toLowerCase();
        if (aa < bb) return -1;
        if (aa > bb) return 1;
        return 0;
    });
    ansi_viewer._files_cache[cache_key] = files;
    return files;
};

/* Slideshow pools. A directory pool is small and built in memory. The
   gallery and all-galleries pools cover the whole 16colo.rs archive (~54k
   pieces), so they come from an on-disk index instead of a directory walk
   per request: slides.txt holds one "gallery_id TAB dir TAB name TAB label"
   line per piece in slideshow order, slides.idx the byte offset of each line
   as 8 hex digits, slides.json the gallery and directory ranges. A request
   reads only the lines it needs. The index is rebuilt when settings.ini
   changes or it is older than slide_index_ttl seconds; while one request
   rebuilds, the others keep reading the old index. */
ansi_viewer.slide_index_dir = system.data_dir + 'ansi-viewer/';
ansi_viewer.slide_index_ttl = 60 * 60;
ansi_viewer.slide_index_version = 1;

ansi_viewer.slide_index_clean = function (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[\t\r\n]+/g, ' ');
};

ansi_viewer.read_slide_index_meta = function () {
    var text;
    var meta;
    if (!file_exists(ansi_viewer.slide_index_dir + 'slides.json')) return null;
    text = ansi_viewer.read_text_file(ansi_viewer.slide_index_dir + 'slides.json');
    try { meta = JSON.parse(text); } catch (_) { return null; }
    if (!meta || meta.version !== ansi_viewer.slide_index_version) return null;
    if (!file_exists(ansi_viewer.slide_index_dir + 'slides.txt') || !file_exists(ansi_viewer.slide_index_dir + 'slides.idx')) return null;
    return meta;
};

ansi_viewer.slide_index_is_fresh = function (meta) {
    return !!meta &&
        meta.settings_mtime === file_date(ansi_viewer.settings_path) &&
        time() - meta.built < ansi_viewer.slide_index_ttl;
};

/* Walks every gallery once and writes the index files. Galleries, directories
   and files are visited in slideshow order, so lines are written as they are
   found and the pool never has to be held in memory. */
ansi_viewer.build_slide_index = function (galleries) {
    var dir = ansi_viewer.slide_index_dir;
    var tag = format('.%d.%d', time(), Math.floor(Math.random() * 1000000));
    var txt = new File(dir + 'slides.txt' + tag);
    var idx = new File(dir + 'slides.idx' + tag);
    var meta = {
        version: ansi_viewer.slide_index_version,
        settings_mtime: file_date(ansi_viewer.settings_path),
        built: time(),
        count: 0,
        galleries: []
    };
    var ordered = galleries.slice().sort(function (a, b) {
        var aa = String(a.description || a.name || '').toLowerCase();
        var bb = String(b.description || b.name || '').toLowerCase();
        if (aa < bb) return -1;
        if (aa > bb) return 1;
        return 0;
    });

    if (!txt.open('wb')) return null;
    if (!idx.open('wb')) { txt.close(); file_remove(txt.name); return null; }
    try {
        ordered.forEach(function (entry) {
            var gallery = ansi_viewer.get_gallery(entry.id);
            var range = { id: gallery.id, start: meta.count, count: 0, dirs: {} };

            ansi_viewer.list_directories(gallery).forEach(function (dir_entry) {
                var start = meta.count;
                var cache_key = [gallery.id, dir_entry, ansi_viewer.slideshow_extensions.join(',')].join('|');

                ansi_viewer.list_files(
                    gallery,
                    dir_entry,
                    { extensions: ansi_viewer.slideshow_extensions }
                ).forEach(function (file) {
                    idx.write(format('%08x', txt.position));
                    txt.write([
                        gallery.id,
                        ansi_viewer.slide_index_clean(dir_entry),
                        ansi_viewer.slide_index_clean(file.name),
                        ansi_viewer.slide_index_clean(file.label)
                    ].join('\t') + '\n');
                    meta.count++;
                });
                delete ansi_viewer._files_cache[cache_key];
                if (meta.count > start) range.dirs[dir_entry] = [start, meta.count - start];
            });
            range.count = meta.count - range.start;
            meta.galleries.push(range);
        });
    } finally {
        txt.close();
        idx.close();
    }

    if (!ansi_viewer.write_text_file(dir + 'slides.json' + tag, JSON.stringify(meta)) ||
        !file_rename(idx.name, dir + 'slides.idx') ||
        !file_rename(txt.name, dir + 'slides.txt') ||
        !file_rename(dir + 'slides.json' + tag, dir + 'slides.json')) {
        file_remove(txt.name);
        file_remove(idx.name);
        file_remove(dir + 'slides.json' + tag);
        return null;
    }
    return meta;
};

ansi_viewer.write_text_file = function (path, text) {
    var f = new File(path);
    if (!f.open('wb')) return false;
    try { return f.write(text); } finally { f.close(); }
};

/* The current index, rebuilt first when stale unless another request holds
   the rebuild lock (then the stale one is used). null when there is none. */
ansi_viewer._slide_index_meta = undefined;
ansi_viewer.slide_index_meta = function (galleries) {
    var meta;
    var lock_path = ansi_viewer.slide_index_dir + 'slides.lock';
    var lock;

    if (ansi_viewer._slide_index_meta !== undefined) return ansi_viewer._slide_index_meta;
    meta = ansi_viewer.read_slide_index_meta();
    if (!ansi_viewer.slide_index_is_fresh(meta)) {
        if (!file_isdir(ansi_viewer.slide_index_dir)) mkdir(ansi_viewer.slide_index_dir);
        /* A lock left by a request that died mid-build is taken over after 5 minutes. */
        if (file_exists(lock_path) && time() - file_date(lock_path) > 300) file_remove(lock_path);
        lock = new File(lock_path);
        if (lock.open('wx')) {
            lock.close();
            try {
                meta = ansi_viewer.build_slide_index(galleries) || meta;
            } finally {
                file_remove(lock_path);
            }
        }
    }
    ansi_viewer._slide_index_meta = meta;
    return meta;
};

/* A slideshow pool: { count, at(i) -> entry | null, find(ref, hint) -> index | -1 }.
   Entries carry gallery_id, gallery_name, gallery_description, relative_dir,
   current_dir_label, name and label. */
ansi_viewer.slide_entry = function (gallery, relative_dir, name, label) {
    return {
        gallery_id: gallery.id,
        gallery_name: gallery.name,
        gallery_description: gallery.description,
        relative_dir: relative_dir,
        current_dir_label: relative_dir.length ? relative_dir : gallery.description,
        name: name,
        label: label
    };
};

ansi_viewer.slide_ref_matches = function (entry, ref) {
    return !!entry && !!ref &&
        entry.gallery_id === ref.gallery_id &&
        ansi_viewer.normalize_relative_path(entry.relative_dir) === ansi_viewer.normalize_relative_path(ref.relative_dir) &&
        entry.name === ref.file_name;
};

ansi_viewer.array_slide_source = function (pool) {
    return {
        count: pool.length,
        at: function (i) { return i >= 0 && i < pool.length ? pool[i] : null; },
        find: function (ref, hint) {
            var i;
            if (ansi_viewer.slide_ref_matches(this.at(hint), ref)) return hint;
            for (i = 0; i < pool.length; i++) {
                if (ansi_viewer.slide_ref_matches(pool[i], ref)) return i;
            }
            return -1;
        }
    };
};

/* Pool positions [start, start + count) of the index. Lines are read by
   seeking through slides.idx, so a lookup never loads the whole file. */
ansi_viewer.file_slide_source = function (meta, start, count) {
    var dir_ranges = {};
    meta.galleries.forEach(function (range) { dir_ranges[range.id] = range.dirs; });

    function read_line(txt, idx, line) {
        var offset;
        idx.position = line * 8;
        offset = parseInt(idx.read(8), 16);
        if (isNaN(offset)) return null;
        txt.position = offset;
        return txt.readln(4096);
    }

    function parse(text) {
        var parts;
        var gallery;
        if (typeof text !== 'string') return null;
        parts = text.split('\t');
        if (parts.length < 4) return null;
        gallery = ansi_viewer.get_gallery(parts[0]);
        if (!gallery || gallery.id !== parts[0]) return null;
        return ansi_viewer.slide_entry(gallery, parts[1], parts[2], parts[3]);
    }

    /* Calls fn(txt, idx) with both index files open. */
    function with_files(fn) {
        var txt = new File(ansi_viewer.slide_index_dir + 'slides.txt');
        var idx = new File(ansi_viewer.slide_index_dir + 'slides.idx');
        if (!txt.open('rb', true)) return null;
        if (!idx.open('rb', true)) { txt.close(); return null; }
        try { return fn(txt, idx); } finally { txt.close(); idx.close(); }
    }

    return {
        count: count,
        at: function (i) {
            if (i < 0 || i >= count) return null;
            return with_files(function (txt, idx) { return parse(read_line(txt, idx, start + i)); });
        },
        /* Checks the hinted position first, then scans only the piece's own
           directory, which the index records as a range. */
        find: function (ref, hint) {
            var found = with_files(function (txt, idx) {
                var dirs;
                var range;
                var line;
                var n;
                if (typeof hint === 'number' && hint >= 0 && hint < count &&
                    ansi_viewer.slide_ref_matches(parse(read_line(txt, idx, start + hint)), ref)) {
                    return hint;
                }
                if (!ref) return -1;
                dirs = dir_ranges[ref.gallery_id];
                range = dirs && dirs[ansi_viewer.normalize_relative_path(ref.relative_dir)];
                if (!range || range[0] < start || range[0] + range[1] > start + count) return -1;
                idx.position = range[0] * 8;
                line = parseInt(idx.read(8), 16);
                if (isNaN(line)) return -1;
                txt.position = line;
                for (n = 0; n < range[1]; n++) {
                    line = txt.readln(4096);
                    if (typeof line !== 'string') break;
                    if (line.split('\t')[2] === ref.file_name) return range[0] + n - start;
                }
                return -1;
            });
            return typeof found === 'number' ? found : -1;
        }
    };
};

ansi_viewer.directory_slide_source = function (gallery, relative_dir) {
    return ansi_viewer.array_slide_source(ansi_viewer.list_files(
        gallery,
        relative_dir,
        { extensions: ansi_viewer.slideshow_extensions }
    ).map(function (file) {
        return ansi_viewer.slide_entry(gallery, relative_dir, file.name, file.label);
    }));
};

/* The pool for a scope. Without an index (first build failed, or another
   request is building the first one) the gallery and all scopes fall back to
   the current directory rather than walking every gallery here. */
ansi_viewer.slideshow_source = function (galleries, gallery, relative_dir, scope) {
    var meta;
    var range = null;

    scope = ansi_viewer.normalize_scope(scope);
    relative_dir = ansi_viewer.normalize_relative_path(relative_dir);
    if (scope !== 'directory') {
        meta = ansi_viewer.slide_index_meta(galleries);
        if (meta && scope === 'all') return ansi_viewer.file_slide_source(meta, 0, meta.count);
        if (meta) {
            meta.galleries.forEach(function (entry) {
                if (entry.id === gallery.id) range = entry;
            });
            if (range) return ansi_viewer.file_slide_source(meta, range.start, range.count);
        }
    }
    return ansi_viewer.directory_slide_source(gallery, relative_dir);
};

ansi_viewer.select_slideshow_file = function (source, action, current_ref, order_mode, hint) {
    var index;
    var file;

    if (!source.count) return null;

    index = source.find(current_ref, hint);

    action = ansi_viewer.trim(action).toLowerCase();
    order_mode = ansi_viewer.normalize_order(order_mode);

    switch (action) {
        case 'current':
        case 'select':
            if (index < 0) {
                index = order_mode === 'ordered'
                    ? 0
                    : Math.floor(Math.random() * source.count);
            }
            break;
        case 'random':
            index = Math.floor(Math.random() * source.count);
            break;
        case 'prev':
            index = index < 0
                ? source.count - 1
                : (index + source.count - 1) % source.count;
            break;
        case 'next':
            index = index < 0
                ? 0
                : (index + 1) % source.count;
            break;
        case 'first':
        default:
            index = index < 0 ? 0 : index;
            break;
    }

    file = source.at(index);
    if (!file) return null;
    return {
        file: file,
        index: index
    };
};

ansi_viewer.find_file_index = function (files, file_name) {
    var index = -1;
    files.forEach(function (file, idx) {
        if (file.name === file_name) index = idx;
    });
    return index;
};

ansi_viewer.select_file = function (files, mode, file_name) {
    var index;

    if (!files.length) return null;

    index = ansi_viewer.find_file_index(files, file_name);
    if (index < 0) index = 0;

    switch (mode) {
        case 'random':
            index = Math.floor(Math.random() * files.length);
            break;
        case 'next':
            index = (index + 1) % files.length;
            break;
        case 'prev':
            index = (index + files.length - 1) % files.length;
            break;
        case 'select':
            if (file_name && ansi_viewer.find_file_index(files, file_name) >= 0) {
                index = ansi_viewer.find_file_index(files, file_name);
            }
            break;
        case 'first':
        default:
            break;
    }

    return {
        file: files[index],
        index: index
    };
};

/* The art bytes without the SAUCE trailer: the 128-byte record at the end
   ("SAUCE00" + fields), any comment block before it ("COMNT" + 64 bytes per
   comment line), and the Ctrl-Z that precedes them. null when unreadable. */
ansi_viewer.read_art_bytes = function (file_path) {
    var f = new File(file_path);
    var data;
    if (!f.open('rb', true)) return null;
    try { data = f.read(); } finally { f.close(); }
    if (typeof data !== 'string') return null;
    if (data.length >= 128 && data.substr(data.length - 128, 7) === 'SAUCE00') {
        var comments = data.charCodeAt(data.length - 128 + 104) & 0xff;
        var cut = data.length - 128;
        if (comments > 0) {
            var block = 5 + comments * 64;
            if (cut - block >= 0 && data.substr(cut - block, 5) === 'COMNT') cut -= block;
        }
        data = data.substr(0, cut);
    }
    var eof = data.lastIndexOf('\x1a');
    if (eof >= 0 && eof >= data.length - 2) data = data.substr(0, eof);
    return data;
};

/* The cell grid + SAUCE facts for one piece, for the browser's VGA-font
   canvas (GraphicsConverter.from_bin with { ice, spacing9 }): the same
   rendering every ANSI on the site should get. { ok, cols, rows, bin (base64
   char+attr pairs), ice, spacing (0|8|9), ratio (legacy|rect|square), font,
   credit: { title, author, group, year } } or { ok: false, message }. */
/* Where a piece came from, when it is one of the 16colo.rs archive files
   (/sbbs/text/16Colors/...): a link back to their site. A file that still
   sits in its pack folder links straight to the pack; the flattened years
   (packs merged, pack name not kept) link to a search for the piece. null
   for our own art. */
ansi_viewer.source_link = function (file_path) {
    var path = String(file_path || '').replace(/\\/g, '/');
    var root = '/sbbs/text/16Colors/sixteencolors-archive-master/';
    var rest, parts, name, year, pack;
    if (path.indexOf(root) !== 0) return null;
    rest = path.substr(root.length);
    parts = rest.split('/');
    name = parts[parts.length - 1] || '';
    year = parts[0] || '';
    if (!name.length) return null;
    if (parts.length >= 3) pack = parts[1];                       /* still in its pack folder */
    else pack = ansi_viewer.pack_for_file(year, name);           /* flattened year: the index (mods/index_16colors.py) */
    if (pack) {
        return { label: 'View on 16c', url: 'https://16colo.rs/pack/' + encodeURIComponent(pack) + '/' + encodeURIComponent(name), kind: 'pack' };
    }
    if (/^\d{4}$/.test(year)) {
        return { label: 'View on 16c', url: 'https://16colo.rs/year/' + year + '/', kind: 'year' };
    }
    return null;
};

/* /sbbs/text/16Colors/index/<year>.json: { "FILE.ANS": "pack", ... } built by
   mods/index_16colors.py from the 16colo.rs API. '' when unknown. */
ansi_viewer._pack_index = {};
ansi_viewer.pack_for_file = function (year, name) {
    var path, f, raw, index;
    if (!/^\d{4}$/.test(String(year || ''))) return '';
    if (!ansi_viewer._pack_index.hasOwnProperty(year)) {
        index = null;
        path = '/sbbs/text/16Colors/index/' + year + '.json';
        if (file_exists(path)) {
            f = new File(path);
            if (f.open('r')) {
                try { raw = f.read(); } finally { f.close(); }
                try { index = JSON.parse(raw); } catch (e) { index = null; }
            }
        }
        ansi_viewer._pack_index[year] = index;
    }
    index = ansi_viewer._pack_index[year];
    if (!index) return '';
    return index[name] || index[String(name).toUpperCase()] || '';
};

ansi_viewer.render_file_cells = function (file_path, max_rows) {
    var ext = String(file_getext(file_path) || '').toLowerCase();
    var sauce, graphic, raw, cellRows, flags, spacingBits, ratioBits;
    try {
        sauce = Sauce.read(file_path);
        if (ext === '.bin' && !(sauce && sauce.cols && sauce.rows)) return { ok: false, message: 'This BIN file is missing usable SAUCE dimensions.' };
        if (sauce && sauce.cols && sauce.rows) graphic = new Graphic(sauce.cols, sauce.rows);
        else { graphic = new Graphic(80, 25); graphic.auto_extend = true; }
        if (ext === '.ans' || ext === '.bin') {
            raw = ansi_viewer.read_art_bytes(file_path);
            if (raw === null) return { ok: false, message: 'Could not load ANSI file.' };
            if (ext === '.bin') graphic.BIN = raw; else graphic.ANSI = raw;
        } else if (!graphic.load(file_path)) {
            return { ok: false, message: 'Could not load ANSI file.' };
        }
        cellRows = Math.min(graphic.height, max_rows > 0 ? max_rows : 600);
        flags = sauce && typeof sauce.tflags === 'number' ? sauce.tflags : 0;
        spacingBits = (flags >> 1) & 3;
        ratioBits = (flags >> 3) & 3;
        return {
            ok: true,
            cols: graphic.width,
            rows: cellRows,
            bin: base64_encode(graphic.BIN.substr(0, graphic.width * cellRows * 2)),
            ice: !!(sauce && sauce.ice_color),
            spacing: spacingBits === 2 ? 9 : (spacingBits === 1 ? 8 : 0),
            ratio: ratioBits === 1 ? 'rect' : (ratioBits === 2 ? 'square' : 'legacy'),
            font: sauce && sauce.tinfos ? String(sauce.tinfos) : '',
            credit: sauce ? {
                title: String(sauce.title || ''),
                author: String(sauce.author || ''),
                group: String(sauce.group || ''),
                year: sauce.date instanceof Date && !isNaN(sauce.date.getTime()) ? String(sauce.date.getFullYear()) : ''
            } : null
        };
    } catch (err) {
        return { ok: false, message: 'ANSI render failed: ' + err };
    }
};

/* The forum-style upgradeable wrapper: a <pre> fallback inside
   <div class="ansi-render" data-ansi-cells ...> that js/ansi-render.js turns
   into the canvas image, carrying the SAUCE facts as data attributes. */
ansi_viewer.render_file_wrapper = function (file_path, max_rows) {
    var cells = ansi_viewer.render_file_cells(file_path, max_rows);
    var fallback = ansi_viewer.render_file_html(file_path);
    if (!cells.ok) return fallback;
    var attrs = ' data-ansi-w="' + cells.cols + '" data-ansi-h="' + cells.rows + '" data-ansi-cells="' + cells.bin + '"' +
        (cells.ice ? ' data-ansi-ice="1"' : '') + (cells.spacing === 9 ? ' data-ansi-spacing="9"' : '') +
        (cells.ratio === 'rect' ? ' data-ansi-aspect="1.35"' : '');
    return {
        ok: true,
        cells: cells,
        credit: cells.credit,
        html: '<div class="ansi-render"' + attrs + '>' + (fallback.ok ? fallback.html : '') + '</div>'
    };
};

ansi_viewer.render_file_html = function (file_path) {
    var ext = String(file_getext(file_path) || '').toLowerCase();
    var graphic;
    var html;
    var sauce;

    try {
        sauce = Sauce.read(file_path);
        if (ext === '.bin') {
            if (!sauce || !sauce.cols || !sauce.rows) {
                return {
                    ok: false,
                    message: 'This BIN file is missing usable SAUCE dimensions.'
                };
            }
            graphic = new Graphic(sauce.cols, sauce.rows);
        } else if (sauce && sauce.cols && sauce.rows) {
            graphic = new Graphic(sauce.cols, sauce.rows);
        } else {
            graphic = new Graphic();
        }

        /* Read the file ourselves and cut off the SAUCE record (and its
           comment block) first: Graphic stops at a Ctrl-Z, but plenty of
           art has none before the trailer, which then got drawn as text
           and scrolled the top of the piece away. */
        if (ext === '.ans' || ext === '.bin') {
            var raw = ansi_viewer.read_art_bytes(file_path);
            if (raw === null) return { ok: false, message: 'Could not load ANSI file.' };
            if (ext === '.bin') graphic.BIN = raw;
            else graphic.ANSI = raw;
        } else if (!graphic.load(file_path)) {
            return {
                ok: false,
                message: 'Could not load ANSI file.'
            };
        }

        html = graphic.HTML;
        html = html.replace(/background-color: black;/g, '');
        html = html.replace(/\"color: #a8a8a8;/g, '"');
        html = html.replace(/\ style=\" \"/g, '');
        html = html.replace(/<span>([^<]*)<\/span>/g, '$1');

        /* The cell grid for the browser's VGA-font canvas (exact glyphs, no
           web-font gaps) with what SAUCE says about how to show it: iCE
           colours, 8/9-pixel letter spacing, pixel aspect and the font it
           was drawn for. The <pre> stays as the fallback. */
        var MAX_CELL_ROWS = 600;
        var cellRows = Math.min(graphic.height, MAX_CELL_ROWS);
        var flags = sauce && typeof sauce.tflags === 'number' ? sauce.tflags : 0;
        var spacingBits = (flags >> 1) & 3;
        var ratioBits = (flags >> 3) & 3;
        return {
            ok: true,
            html: '<pre class="ansi ahv-ansi-pre">' + html + '</pre>',
            cells: {
                cols: graphic.width,
                rows: cellRows,
                bin: base64_encode(graphic.BIN.substr(0, graphic.width * cellRows * 2)),
                ice: !!(sauce && sauce.ice_color),
                spacing: spacingBits === 2 ? 9 : (spacingBits === 1 ? 8 : 0),
                ratio: ratioBits === 1 ? 'rect' : (ratioBits === 2 ? 'square' : 'legacy'),
                font: sauce && sauce.tinfos ? String(sauce.tinfos) : ''
            },
            /* Who made it, from the SAUCE record: shown next to the file name. */
            credit: sauce ? {
                title: String(sauce.title || ''),
                author: String(sauce.author || ''),
                group: String(sauce.group || ''),
                year: sauce.date instanceof Date && !isNaN(sauce.date.getTime()) ? String(sauce.date.getFullYear()) : ''
            } : null
        };
    } catch (err) {
        return {
            ok: false,
            message: 'ANSI render failed: ' + err
        };
    }
};

ansi_viewer.build_state = function (options) {
    var galleries = ansi_viewer.parse_settings();
    var gallery = ansi_viewer.get_gallery(options && options.gallery_id);
    var directories;
    var current_dir;
    var files;
    var selection;
    var slideshow_scope = ansi_viewer.normalize_scope(options && options.slide_scope);
    var slideshow_order = ansi_viewer.normalize_order(options && options.slide_order);
    var slideshow_action = ansi_viewer.trim(options && options.slide_action);
    var slideshow_pool;
    var slideshow_hint = parseInt(options && options.slide_index, 10);
    var slideshow_selection;
    var slideshow_index = -1;
    var slideshow_scope_label;
    var render;
    var current_path;
    var current_file_name;
    var current_file_label;

    if (!gallery) {
        return {
            ok: false,
            error: 'No ANSI galleries are configured.',
            galleries: []
        };
    }

    directories = ansi_viewer.list_directories(gallery);
    current_dir = ansi_viewer.normalize_relative_path(options && options.relative_dir);
    if (directories.indexOf(current_dir) < 0) current_dir = '';

    files = ansi_viewer.list_files(gallery, current_dir);

    if (slideshow_action.length) {
        slideshow_pool = ansi_viewer.slideshow_source(
            galleries,
            gallery,
            current_dir,
            slideshow_scope
        );
        slideshow_selection = ansi_viewer.select_slideshow_file(
            slideshow_pool,
            slideshow_action,
            {
                gallery_id: gallery.id,
                relative_dir: current_dir,
                file_name: options && options.file_name
            },
            slideshow_order,
            slideshow_hint
        );
        if (slideshow_selection !== null) {
            gallery = ansi_viewer.get_gallery(slideshow_selection.file.gallery_id);
            current_dir = ansi_viewer.normalize_relative_path(slideshow_selection.file.relative_dir);
            directories = ansi_viewer.list_directories(gallery);
            if (directories.indexOf(current_dir) < 0) current_dir = '';
            files = ansi_viewer.list_files(gallery, current_dir);
            selection = {
                file: slideshow_selection.file,
                index: ansi_viewer.find_file_index(files, slideshow_selection.file.name)
            };
            slideshow_index = slideshow_selection.index;
        }
    }

    if (!selection) {
        selection = ansi_viewer.select_file(
            files,
            (options && options.mode) || ((options && options.file_name) ? 'select' : 'random'),
            options && options.file_name
        );
    }

    render = {
        ok: false,
        html: '<div class="ahv-empty">No renderable ANSI files in this directory.</div>'
    };
    current_path = '';
    current_file_name = '';
    current_file_label = '';

    if (selection !== null) {
        current_file_name = selection.file.name;
        current_file_label = selection.file.label;
        current_path = ansi_viewer.resolve_directory(gallery, current_dir) + current_file_name;
        render = ansi_viewer.render_file_html(current_path);
        if (!render.ok) {
            render.html = '<div class="ahv-empty">' + ansi_viewer.escape_html(render.message) + '</div>';
        }
    }

    if (slideshow_pool === undefined) {
        slideshow_pool = ansi_viewer.slideshow_source(
            galleries,
            gallery,
            current_dir,
            slideshow_scope
        );
    }
    if (slideshow_index < 0 && current_file_name.length) {
        slideshow_index = slideshow_pool.find({
            gallery_id: gallery.id,
            relative_dir: current_dir,
            file_name: current_file_name
        }, slideshow_hint);
    }
    slideshow_scope_label = ansi_viewer.get_scope_label(slideshow_scope, gallery, current_dir);

    return {
        ok: true,
        galleries: galleries.map(function (entry) {
            return {
                id: entry.id,
                name: entry.name,
                description: entry.description
            };
        }),
        gallery: {
            id: gallery.id,
            name: gallery.name,
            description: gallery.description
        },
        directories: directories.map(function (entry) {
            return {
                path: entry,
                label: entry.length ? entry : gallery.description
            };
        }),
        current_dir: current_dir,
        current_dir_label: current_dir.length ? current_dir : gallery.description,
        files: files,
        current_file: current_file_name,
        current_file_label: current_file_label || current_file_name,
        render_cells: render.cells || null,
        render_credit: render.credit || null,
        source_link: current_path ? ansi_viewer.source_link(current_path) : null,
        current_index: selection === null ? -1 : selection.index,
        current_count: files.length,
        render_html: render.html,
        error: render.ok ? '' : (render.message || ''),
        slide_scope: slideshow_scope,
        slide_order: slideshow_order,
        slide_index: slideshow_index,
        slide_count: slideshow_pool.count,
        slide_scope_label: slideshow_scope_label,
        slideshow_active: !!(options && options.slideshow_active),
        slide_status_text: slideshow_pool.count
            ? format(
                '%s slideshow | %s | %u .ans files',
                slideshow_order === 'ordered' ? 'Ordered' : 'Random',
                slideshow_scope_label,
                slideshow_pool.count
            )
            : format('No .ans files available in %s', slideshow_scope_label),
        status_text: files.length
            ? format(
                '%s | %u of %u',
                current_dir.length ? current_dir : gallery.description,
                selection.index + 1,
                files.length
            )
            : format('%s | no ANSI files', current_dir.length ? current_dir : gallery.description)
    };
};

ansi_viewer;
