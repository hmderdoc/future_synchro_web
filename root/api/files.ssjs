load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load(settings.web_lib + 'files.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
var Filebase = require({}, 'filebase.js', 'OldFileBase');

var CHUNK_SIZE = 1024;
var TRACK_OVERRIDE_DIR = system.data_dir + 'futureland-records/';
var TRACK_OVERRIDE_FILE = TRACK_OVERRIDE_DIR + 'track-overrides.ini';
var TRACK_TAG_FIELDS = ['title', 'artist', 'composer', 'genre', 'year', 'album'];
var _bodyParams = null;

function trimText(value) {
	return String(value || '').replace(/^\s+|\s+$/g, '');
}

function getBodyParams() {
	var params = {};
	var pairs;
	var index;
	var parts;
	var key;
	var value;

	if (_bodyParams !== null) {
		return _bodyParams;
	}

	_bodyParams = params;

	if (http_request.method !== 'POST' || typeof http_request.body !== 'string' || !http_request.body.length) {
		return _bodyParams;
	}

	pairs = http_request.body.split('&');
	for (index = 0; index < pairs.length; index += 1) {
		parts = pairs[index].split('=');
		key = decodeURIComponent(String(parts.shift() || '').replace(/\+/g, ' '));
		value = decodeURIComponent(String(parts.join('=') || '').replace(/\+/g, ' '));

		if (!key.length) {
			continue;
		}

		if (!Array.isArray(_bodyParams[key])) {
			_bodyParams[key] = [];
		}
		_bodyParams[key].push(value);
	}

	return _bodyParams;
}

function hasRequestParam(name) {
	return (
		(Array.isArray(http_request.query[name]) && http_request.query[name].length) ||
		(Array.isArray(getBodyParams()[name]) && getBodyParams()[name].length)
	);
}

function getRequestValue(name, fallback) {
	if (Array.isArray(http_request.query[name]) && http_request.query[name].length) {
		return String(http_request.query[name][0]);
	}

	if (Array.isArray(getBodyParams()[name]) && getBodyParams()[name].length) {
		return String(getBodyParams()[name][0]);
	}

	return typeof fallback === 'undefined' ? '' : String(fallback);
}

function ensureTrackOverrideDir() {
	return file_isdir(TRACK_OVERRIDE_DIR) || mkpath(TRACK_OVERRIDE_DIR);
}

function trackOverrideSection(filename) {
	return String(filename || '').toLowerCase();
}

function copyTags(source) {
	var result = {};
	var key;

	if (!source || typeof source !== 'object') {
		return result;
	}

	for (key in source) {
		if (!Object.prototype.hasOwnProperty.call(source, key)) {
			continue;
		}
		result[key] = source[key];
	}

	return result;
}

function cleanTrackOverrideTags(tags) {
	var clean = {};
	var index;
	var field;
	var value;

	if (!tags || typeof tags !== 'object') {
		return clean;
	}

	for (index = 0; index < TRACK_TAG_FIELDS.length; index += 1) {
		field = TRACK_TAG_FIELDS[index];
		if (typeof tags[field] === 'undefined' || tags[field] === null) {
			continue;
		}
		value = trimText(tags[field]);
		if (value.length) {
			clean[field] = value;
		}
	}

	return clean;
}

function hasOwnValues(obj) {
	var key;
	if (!obj || typeof obj !== 'object') {
		return false;
	}
	for (key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			return true;
		}
	}
	return false;
}

function loadTrackOverrides() {
	var overrides = {};
	var file;
	var sections;
	var index;
	var section;

	if (!file_exists(TRACK_OVERRIDE_FILE)) {
		return overrides;
	}

	file = new File(TRACK_OVERRIDE_FILE);
	if (!file.open('r')) {
		return overrides;
	}

	try {
		sections = file.iniGetSections();
		for (index = 0; index < sections.length; index += 1) {
			section = sections[index];
			overrides[String(section).toLowerCase()] = cleanTrackOverrideTags(file.iniGetObject(section) || {});
		}
	} finally {
		file.close();
	}

	return overrides;
}

function writeTrackOverride(filename, tags) {
	var clean = cleanTrackOverrideTags(tags);
	var file;
	var openMode;
	var section = trackOverrideSection(filename);

	if (!ensureTrackOverrideDir()) {
		throw new Error('Could not create track override directory');
	}

	file = new File(TRACK_OVERRIDE_FILE);
	openMode = file_exists(TRACK_OVERRIDE_FILE) ? 'r+' : 'w+';
	if (!file.open(openMode)) {
		throw new Error('Could not open track override file');
	}

	try {
		if (hasOwnValues(clean)) {
			file.iniSetObject(section, clean);
		} else {
			file.iniRemoveSection(section);
		}
	} finally {
		file.close();
	}

	return clean;
}

function findFileRecord(dirCode, filename) {
	var lower = String(filename || '').toLowerCase();
	var fileBase = new OldFileBase(dirCode);
	var file = null;

	fileBase.some(function (entry) {
		if (!entry || String(entry.name || '').toLowerCase() !== lower) {
			return false;
		}
		if (entry.path !== undefined) {
			file = entry;
			return true;
		}
		return false;
	});

	fileBase = undefined;
	return file;
}

function lyricPathFor(filePath) {
	if (/\.[^\\/]+$/.test(filePath)) {
		return filePath.replace(/\.[^\\/]+$/, '.lrc');
	}
	return filePath + '.lrc';
}

function writeLyricsFile(trackPath, lyrics) {
	var normalized = String(lyrics || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	var lyricPath = lyricPathFor(trackPath);
	var lyricFile;

	if (!normalized.length) {
		if (file_exists(lyricPath) && !file_remove(lyricPath)) {
			throw new Error('Could not remove lyrics file');
		}
		return false;
	}

	lyricFile = new File(lyricPath);
	if (!lyricFile.open('w+')) {
		throw new Error('Could not open lyrics file for writing');
	}

	try {
		lyricFile.write(normalized);
	} finally {
		lyricFile.close();
	}

	return true;
}

var reply = {};
if ((http_request.method === 'GET' || http_request.method === 'POST') && request.has_param('call') && user.number > 0) {

	switch (request.get_param('call').toLowerCase()) {
		case 'download-file':
			var dir = request.get_param('dir');
			if (dir !== undefined
				&& file_area.dir[dir] !== undefined && file_area.dir[dir].lib_index >= 0 && file_area.dir[dir].index >= 0 && file_area.dir[dir].can_download
				&& request.has_param('file')
				&& user.compare_ars(file_area.dir[dir].download_ars)
			) {
				var dircode = file_area.dir[dir].code;
				var fn = request.get_param('file').toLowerCase();
				var fileBase = new OldFileBase(dircode);
				var file = null;
				fileBase.some(function (e) {
					if (e.name.toLowerCase() !== fn) {
						return false;
					} else if (e.path !== undefined) {
						file = e;
						return true;
					}
				});
				fileBase = undefined;
				if (file === null) {
					reply.error = 'File not found';
					break;
				}
				if (!file_area.dir[dir].is_exempt && file.credits > (user.security.credits + user.security.free_credits)) {
					reply.error = 'Not enough credits to download this file';
					break;
				}
				var mt;
				if (!settings.files_inline || settings.files_inline_blacklist.indexOf(file.ext) > -1) {
					mt = 'application/octet-stream';
				} else {
					mt = getMimeType(file);
				}
				http_reply.header['Content-Type'] = mt;
				if (mt === 'application/octet-stream') {
					http_reply.header['Content-Disposition'] = 'attachment; filename="' + file.name + '"';
				} else {
					http_reply.header['Content-Disposition'] = 'inline';
				}
				http_reply.header['Content-Encoding'] = 'binary';
				http_reply.header['Content-Length'] = file_size(file.path);
				var f = new File(file.path);
				f.open('rb');
				for (var n = 0; n < f.length; n += CHUNK_SIZE) {
					var r = f.length - f.position;
					write(f.read(r > CHUNK_SIZE ? CHUNK_SIZE : r));
					yield(false);
				}
				f.close();
				f = undefined;
				reply = false;
				user.downloaded_file(dircode, file_getname(file.path));
			}
			break;
		case 'stream-file':
			var sdir = request.get_param('dir');
			var sfn  = request.has_param('file') ? request.get_param('file').toLowerCase() : '';
			if (sdir !== undefined
				&& file_area.dir[sdir] !== undefined
				&& file_area.dir[sdir].can_download
				&& user.compare_ars(file_area.dir[sdir].download_ars)
				&& sfn
			) {
				var sfileBase = new OldFileBase(sdir);
				var sfile = null;
				sfileBase.some(function (e) {
					if (e.name.toLowerCase() !== sfn) return false;
					if (e.path !== undefined) { sfile = e; return true; }
				});
				sfileBase = undefined;
				if (sfile === null) { reply.error = 'File not found'; break; }
				http_reply.header['Content-Type'] = 'audio/mpeg';
				http_reply.header['Content-Disposition'] = 'inline';
				http_reply.header['Content-Length'] = file_size(sfile.path);
				http_reply.header['Accept-Ranges'] = 'bytes';
				http_reply.header['Cache-Control'] = 'public, max-age=86400';
				var sf = new File(sfile.path);
				sf.open('rb');
				for (var sn = 0; sn < sf.length; sn += CHUNK_SIZE) {
					var sr = sf.length - sf.position;
					write(sf.read(sr > CHUNK_SIZE ? CHUNK_SIZE : sr));
					yield(false);
				}
				sf.close();
				sf = undefined;
				reply = false;
			}
			break;
		                case 'view-file':
                        var vdir = request.get_param('dir');
                        var vfn  = request.has_param('file') ? request.get_param('file').toLowerCase() : '';
                        if (vdir !== undefined
                                && file_area.dir[vdir] !== undefined
                                && file_area.dir[vdir].can_download
                                && user.compare_ars(file_area.dir[vdir].download_ars)
                                && vfn
                        ) {
                                var vfileBase = new OldFileBase(vdir);
                                var vfile = null;
                                vfileBase.some(function (e) {
                                        if (e.name.toLowerCase() !== vfn) return false;
                                        if (e.path !== undefined) { vfile = e; return true; }
                                });
                                vfileBase = undefined;
                                if (vfile === null) { reply.error = 'File not found'; break; }
                                /* OldFileBase does not map .ext; derive from filename */
                                if (!vfile.ext) {
                                        var _em = String(vfile.name || '').match(/\.([^.]+)$/);
                                        if (_em) vfile.ext = _em[1].toLowerCase();
                                }
                                var vext = (vfile.ext || '').toLowerCase();
                                if (vext === 'ans') {
                                        /* Render ANSI to HTML server-side using graphic.js */
                                        load('graphic.js');
                                        var vSauce = load({}, 'sauce_lib.js');
                                        var vGraphic;
                                        try {
                                                var sauce = vSauce.read(vfile.path);
                                                if (sauce && sauce.cols && sauce.rows) {
                                                        vGraphic = new Graphic(sauce.cols, sauce.rows);
                                                } else {
                                                        vGraphic = new Graphic();
                                                }
                                                if (!vGraphic.load(vfile.path)) {
                                                        reply.error = 'Could not load ANSI file';
                                                        break;
                                                }
                                                var vhtml = vGraphic.HTML;
                                                vhtml = vhtml.replace(/background-color: black;/g, '');
                                                vhtml = vhtml.replace(/"color: #a8a8a8;/g, '"');
                                                vhtml = vhtml.replace(/ style=" "/g, '');
                                                vhtml = vhtml.replace(/<span>([^<]*)<\/span>/g, '$1');
                                                http_reply.header['Content-Type'] = 'text/html; charset=utf-8';
                                                http_reply.header['Content-Length'] = vhtml.length;
                                                write(vhtml);
                                                reply = false;
                                        } catch (err) {
                                                reply.error = 'ANSI render error: ' + String(err);
                                        }
                                } else {
                                        /* Serve file inline with proper MIME type */
                                        var vmt = getMimeType(vfile);
                                        http_reply.header['Content-Type'] = vmt;
                                        http_reply.header['Content-Disposition'] = 'inline';
                                        http_reply.header['Content-Length'] = file_size(vfile.path);
                                        http_reply.header['Cache-Control'] = 'public, max-age=3600';
                                        if (vmt.indexOf('audio/') === 0) {
                                                http_reply.header['Accept-Ranges'] = 'bytes';
                                        }
                                        var vf = new File(vfile.path);
                                        vf.open('rb');
                                        for (var vn = 0; vn < vf.length; vn += CHUNK_SIZE) {
                                                var vr = vf.length - vf.position;
                                                write(vf.read(vr > CHUNK_SIZE ? CHUNK_SIZE : vr));
                                                yield(false);
                                        }
                                        vf.close();
                                        vf = undefined;
                                        reply = false;
                                }
                        } else {
                                reply.error = 'Invalid directory or access denied';
                        }
                        break;

		case 'list-files':
			var ldir = request.get_param('dir');
			if (ldir !== undefined
				&& file_area.dir[ldir] !== undefined
				&& file_area.dir[ldir].can_download
				&& user.compare_ars(file_area.dir[ldir].download_ars)
			) {
				var fb = new FileBase(ldir);
				if (fb.open()) {
					var flist = fb.get_list('*.mp3', FileBase.DETAIL.NORM, 0, true, FileBase.SORT.DATE_D);
					var overrides = loadTrackOverrides();
					fb.close();
					reply = [];
					for (var fi = 0; fi < flist.length; fi++) {
						reply.push({
							name: flist[fi].name,
							desc: flist[fi].desc || '',
							added: flist[fi].added || 0,
							tags: copyTags(overrides[trackOverrideSection(flist[fi].name)] || {})
						});
					}
				} else {
					reply.error = 'Could not open file directory';
				}
			} else {
				reply.error = 'Invalid directory or access denied';
			}
			break;
		case 'update-track-meta':
			var udir = request.get_param('dir');
			if (!user.is_sysop) {
				reply.error = 'Sysop access required';
				break;
			}
			if (http_request.method !== 'POST') {
				reply.error = 'POST required';
				break;
			}
			if (!validateCsrfToken()) {
				reply.error = 'Invalid CSRF token';
				break;
			}
			if (udir === undefined
				|| file_area.dir[udir] === undefined
				|| !file_area.dir[udir].can_download
				|| !user.compare_ars(file_area.dir[udir].download_ars)
			) {
				reply.error = 'Invalid directory or access denied';
				break;
			}

			var updateFile = trimText(getRequestValue('file', ''));
			var updateArtist = trimText(getRequestValue('artist', ''));
			var updateLyrics = hasRequestParam('lyrics') ? getRequestValue('lyrics', '') : '';
			var updateRecord = null;
			var overrideState = {};

			if (!updateFile.length) {
				reply.error = 'Track file is required';
				break;
			}

			updateRecord = findFileRecord(udir, updateFile);
			if (!updateRecord || !updateRecord.path) {
				reply.error = 'File not found';
				break;
			}

			overrideState = copyTags(loadTrackOverrides()[trackOverrideSection(updateRecord.name)] || {});
			if (updateArtist.length) {
				overrideState.artist = updateArtist;
			} else {
				delete overrideState.artist;
			}

			try {
				overrideState = writeTrackOverride(updateRecord.name, overrideState);
				writeLyricsFile(updateRecord.path, updateLyrics);
				reply = {
					success: true,
					file: updateRecord.name,
					tags: overrideState,
					has_lyrics: !!String(updateLyrics || '').length
				};
			} catch (updateErr) {
				log(LOG_ERR, 'files.ssjs update-track-meta error: ' + updateErr);
				reply.error = updateErr && updateErr.message
					? String(updateErr.message)
					: 'Could not update track metadata';
			}
			break;
		default:
			break;
	}

}

if (!reply) exit();

reply = JSON.stringify(reply);
http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Content-Length'] = reply.length;
write(reply);

reply = undefined;
