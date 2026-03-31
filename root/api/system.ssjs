require('sbbsdefs.js', 'SYS_CLOSED');
require('nodedefs.js', 'NODE_WFC');
require("presence_lib.js", 'node_status');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');

var handled = false;
var reply = {};

function getAvatarLib() {
	return load({}, 'avatar_lib.js');
}

function getSauceLib() {
	return load({}, 'sauce_lib.js');
}

function avatarCollectionDir() {
	return backslash(system.text_dir + 'avatars/');
}

function isValidAvatarBin(avatar_lib, bin) {
	if (!bin || typeof bin !== 'string') return false;
	if (bin.length !== avatar_lib.size) return false;
	if (typeof avatar_lib.is_valid === 'function') return avatar_lib.is_valid(bin);
	return true;
}

function getAvatarCollectionFiles() {
	var dir = avatarCollectionDir();
	var files = directory(dir + '*.bin') || [];
	files = files.filter(function (filePath) {
		return file_getname(filePath).search(/\.\d+\.bin$/i) < 0;
	});
	files.sort();
	return files;
}

function getAvatarCollectionFile(collectionId) {
	var want = file_getname(collectionId || '');
	if (!want || want !== collectionId) return false;
	var files = getAvatarCollectionFiles();
	for (var i = 0; i < files.length; i++) {
		if (file_getname(files[i]) === want) return files[i];
	}
	return false;
}

function readAvatarCollectionChunk(filePath, index, avatar_lib) {
	var file = new File(filePath);
	var count;
	var bin;
	if (!file.open('rb')) return false;
	count = Math.floor(file.length / avatar_lib.size);
	if (index < 0 || index >= count) {
		file.close();
		return false;
	}
	file.position = index * avatar_lib.size;
	bin = file.read(avatar_lib.size);
	file.close();
	if (!isValidAvatarBin(avatar_lib, bin)) return false;
	return {
		count: count,
		bin: bin
	};
}

function summarizeAvatarCollection(filePath, avatar_lib, sauce) {
	var file = new File(filePath);
	var count;
	var previewIndex = 0;
	var previewChunk = null;
	var comments;
	if (!file.open('rb')) return false;
	count = Math.floor(file.length / avatar_lib.size);
	file.close();
	if (count < 1) return false;
	if (!sauce) sauce = getSauceLib().read(filePath);
	if (!sauce) return false;
	if (sauce.tinfo4) {
		var candidate = parseInt(sauce.tinfo4, 10) - 1;
		if (!isNaN(candidate) && candidate >= 0 && candidate < count) previewIndex = candidate;
	}
	previewChunk = readAvatarCollectionChunk(filePath, previewIndex, avatar_lib);
	if (!previewChunk) return false;
	comments = Array.isArray(sauce.comment) ? sauce.comment : [];
	return {
		id: file_getname(filePath),
		title: sauce.title && sauce.title.length ? sauce.title : file_getname(filePath).replace(/\.bin$/i, ''),
		author: sauce.author && sauce.author.length ? sauce.author : 'Unknown',
		group: sauce.group && sauce.group.length ? sauce.group : 'Unknown',
		count: count,
		previewIndex: previewIndex,
		preview: base64_encode(previewChunk.bin),
		description: comments[previewIndex] || '',
		updated: sauce.date || null
	};
}

function listAvatarCollections() {
	var avatar_lib = getAvatarLib();
	var sauce_lib = getSauceLib();
	var files = getAvatarCollectionFiles();
	var collections = [];
	files.forEach(function (filePath) {
		var sauce = sauce_lib.read(filePath);
		var summary = summarizeAvatarCollection(filePath, avatar_lib, sauce);
		if (summary) collections.push(summary);
	});
	return collections;
}

function getAvatarCollection(collectionId) {
	var avatar_lib = getAvatarLib();
	var sauce_lib = getSauceLib();
	var filePath = getAvatarCollectionFile(collectionId);
	var summary;
	var sauce;
	var comments;
	var avatars = [];
	var i;
	var chunk;
	if (!filePath) return false;
	sauce = sauce_lib.read(filePath);
	summary = summarizeAvatarCollection(filePath, avatar_lib, sauce);
	if (!summary) return false;
	comments = Array.isArray(sauce.comment) ? sauce.comment : [];
	for (i = 0; i < summary.count; i++) {
		chunk = readAvatarCollectionChunk(filePath, i, avatar_lib);
		if (!chunk) continue;
		avatars.push({
			index: i,
			label: comments[i] || ('Avatar ' + (i + 1)),
			data: base64_encode(chunk.bin)
		});
	}
	summary.avatars = avatars;
	return summary;
}

if ((http_request.method === 'GET' || http_request.method === 'POST') && http_request.query.call !== undefined) {

	switch (http_request.query.call[0]) {
		case 'get-avatar':
			var avatar_lib = load({}, 'avatar_lib.js');
			reply = http_request.query.user.map(function (e) {
				const u = e.split('@');
				var ret;
				if (u.length === 1) {
					var usernum = parseInt(u[0], 10) || system.matchuser(u[0]);
					ret = avatar_lib.read_localuser(usernum) || {};
				} else {
					ret = avatar_lib.read_netuser(u[0], u[1]) || {};
				}
				ret.user = e;
				return ret;
			});
			handled = true;
			break;

		case 'avatar-settings-init':
			var avatarSettingsLib = getAvatarLib();
			reply = {
				success: true,
				current: (user.number > 0 && user.alias !== settings.guest)
					? (avatarSettingsLib.read_localuser(user.number) || null)
					: null,
				dimensions: {
					width: avatarSettingsLib.defs.width,
					height: avatarSettingsLib.defs.height
				},
				collections: listAvatarCollections()
			};
			handled = true;
			break;

		case 'avatar-collection':
			if (typeof http_request.query.collection === 'undefined') {
				reply = { success: false, error: 'No collection specified' };
				handled = true;
				break;
			}
			reply = getAvatarCollection(http_request.query.collection[0]) || {
				success: false,
				error: 'Collection not found'
			};
			handled = true;
			break;

		default:
			break;
	}

		if (!handled && http_request.query.call[0] === 'node-list') {
			var sessions = directory(system.data_dir + 'user/*.web');
			var usr = new User(1);
			reply = system.node_list.reduce(function (a, c, i) {
				if (c.status !== NODE_INUSE) return a;
				usr.number = c.useron;
				a.push({
					node: i + 1,
					useron: c.useron,
					status: format(NodeStatus[c.status], c.aux, c.extaux),
					action: node_status(c, user.is_sysop, {exclude_username: true, exclude_connection: true}, i),
					user: usr.alias,
					connection: usr.connection
				});
				return a;
			}, []);
			sessions.forEach(function (sessionPath) {
				var base = file_getname(sessionPath).replace(file_getext(sessionPath), '');
				var un = parseInt(base, 10);
				var webAction;
				if (isNaN(un) || un < 1 || un > system.lastuser) return;
				usr.number = un;
				if (usr.alias === settings.guest) return;
				if (usr.settings & USER_QUIET) return;
				if (time() - file_date(sessionPath) >= settings.inactivity) return;
				webAction = getSessionValue(usr.number, 'action') || '';
				reply.push({
					node: 'W',
					useron: usr.number,
					status: '',
					action: webAction || '',
					user: usr.alias,
					connection: 'Web'
				});
			});
		usr = undefined;
		handled = true;
	}

	if (!handled && user.number > 0) {

		switch (http_request.query.call[0]) {

			case 'send-telegram':
				if (user.alias === settings.guest) break;
				if (typeof http_request.query.user === 'undefined') break;
				if (typeof http_request.query.telegram === 'undefined' ||
					http_request.query.telegram[0] === ''
				) {
					break;
				}
				if (http_request.query.telegram[0].length >
					settings.maximum_telegram_length
				) {
					break;
				}
				var un = system.matchuser(http_request.query.user[0]);
				if (un < 1) break;
				system.put_telegram(
					un, format(
						locale.strings.api_system.telegram_header_format,
						user.alias, (new Date()).toLocaleString()
					) + '\r\n' + utf8_decode(http_request.query.telegram[0]) + '\r\n'
				);
				break;

			case 'get-telegram':
				if (user.alias === settings.guest) break;
				reply.telegram = system.get_telegram(user.number);
				break;

			case 'set-xtrn-intent':
				if (user.alias === settings.guest) break;
				if (typeof http_request.query.code === 'undefined') break;
				if (http_request.query.code[0].length > 8) break;
				if (typeof xtrn_area.prog[http_request.query.code[0]] === 'undefined') {
					break;
				}
				setSessionValue(user.number, 'xtrn', http_request.query.code[0]);
				break;

			case 'set-avatar-collection':
				if (user.alias === settings.guest) {
					reply = { success: false, error: 'Login required' };
					break;
				}
				if (typeof http_request.query.collection === 'undefined') {
					reply = { success: false, error: 'No collection specified' };
					break;
				}
				var avatar_lib = getAvatarLib();
				var collectionFile = getAvatarCollectionFile(http_request.query.collection[0]);
				var index = 0;
				var selected;
				var updated;
				if (!collectionFile) {
					reply = { success: false, error: 'Collection not found' };
					break;
				}
				if (typeof http_request.query.index !== 'undefined') {
					index = parseInt(http_request.query.index[0], 10);
					if (isNaN(index) || index < 0) index = 0;
				}
				selected = readAvatarCollectionChunk(collectionFile, index, avatar_lib);
				if (!selected) {
					reply = { success: false, error: 'Avatar not found' };
					break;
				}
				updated = avatar_lib.update_localuser(user.number, base64_encode(selected.bin));
				if (updated) avatar_lib.enable_localuser(user.number, true);
				reply = {
					success: !!updated,
					avatar: avatar_lib.read_localuser(user.number) || null
				};
				break;

			case 'set-avatar-data':
				if (user.alias === settings.guest) {
					reply = { success: false, error: 'Login required' };
					break;
				}
				if (typeof http_request.query.data === 'undefined' || !http_request.query.data[0]) {
					reply = { success: false, error: 'No avatar data supplied' };
					break;
				}
				var avatar_lib = getAvatarLib();
				var data = http_request.query.data[0];
				var bin = '';
				var updated;
				try {
					bin = base64_decode(data);
				} catch (err) {
					bin = '';
				}
				if (!isValidAvatarBin(avatar_lib, bin)) {
					reply = { success: false, error: 'Invalid avatar data' };
					break;
				}
				updated = avatar_lib.update_localuser(user.number, data);
				if (updated) avatar_lib.enable_localuser(user.number, true);
				reply = {
					success: !!updated,
					avatar: avatar_lib.read_localuser(user.number) || null
				};
				break;

			default:
				break;

		}

	}

}

reply = JSON.stringify(reply);
http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Content-Length'] = reply.length;
write(reply);

reply = undefined;
