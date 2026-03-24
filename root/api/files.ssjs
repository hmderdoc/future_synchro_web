load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load(settings.web_lib + 'files.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
var Filebase = require({}, 'filebase.js', 'OldFileBase');

var CHUNK_SIZE = 1024;

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
					fb.close();
					reply = [];
					for (var fi = 0; fi < flist.length; fi++) {
						reply.push({
							name: flist[fi].name,
							desc: flist[fi].desc || '',
							added: flist[fi].added || 0
						});
					}
				} else {
					reply.error = 'Could not open file directory';
				}
			} else {
				reply.error = 'Invalid directory or access denied';
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
