load('graphic.js');
var Sauce = load({}, 'sauce_lib.js');

var ansi_viewer = {
    settings_path: '/sbbs/xtrn/ansiview/settings.ini',
    default_gallery_key: 'futureland',
    supported_extensions: ['.ans', '.asc', '.bin'],
    hidden_files: ['.', 'ansiview.ini', 'ANSIVIEW.INI'],
    _galleries: null
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
    var root = ansi_viewer.ensure_trailing_slash(gallery.path);
    var result = [''];

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

ansi_viewer.is_supported_file = function (name) {
    var ext = String(file_getext(name) || '').toLowerCase();
    return ansi_viewer.supported_extensions.indexOf(ext) >= 0;
};

ansi_viewer.list_files = function (gallery, relative_dir) {
    var abs_dir = ansi_viewer.resolve_directory(gallery, relative_dir);
    var descriptions = ansi_viewer.read_descriptions(abs_dir);
    var files = ansi_viewer.safe_directory(abs_dir + '*').reduce(function (acc, entry) {
        var name;
        var label;

        if (ansi_viewer.safe_file_isdir(entry)) return acc;
        try {
            name = file_getname(entry);
        } catch (_) {
            return acc;
        }
        if (!name.length || ansi_viewer.should_hide_name(name, gallery)) return acc;
        if (!ansi_viewer.is_supported_file(name)) return acc;

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
    return files;
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

        if (!graphic.load(file_path)) {
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

        return {
            ok: true,
            html: '<pre class="ansi ahv-ansi-pre">' + html + '</pre>'
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
    selection = ansi_viewer.select_file(
        files,
        (options && options.mode) || ((options && options.file_name) ? 'select' : 'random'),
        options && options.file_name
    );

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
        current_index: selection === null ? -1 : selection.index,
        current_count: files.length,
        render_html: render.html,
        error: render.ok ? '' : (render.message || ''),
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
