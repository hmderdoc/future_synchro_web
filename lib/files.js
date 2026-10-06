require('filebase.js', 'OldFileBase');
require('file_size.js', 'file_size_str');

function count_files(dir) {
    return file_area.dir[dir].files;
}

/* Every library and directory the user can see is listed, empty ones
   included (shown with a count of 0): hiding them made new areas look missing. */
function listLibraries() {
	return file_area.lib_list.filter(function (lib) {
        return lib.dir_list.length >= 1;
    });
}

function listDirectories(lib) {
	return file_area.lib_list[lib].dir_list.map(function (c) {
        return { dir: c, fileCount: count_files(c.code) };
    });
}

function listFiles(dir) {
	return (new OldFileBase(file_area.dir[dir].code)).map(function (df) {
        df.size = df.path ? file_size_str(file_size(df.path)) : 'Unknown';
        df._size = df.path ? file_size(df.path) : 0;
		return df;
	});
}

// Where file is a FileBase file record
function getMimeType(file) {
    if (file.ext) {
        const f = new File(system.ctrl_dir + 'mime_types.ini');
        if (f.open('r')) {
            const mimes = f.iniGetObject();
            f.close();
            if (mimes[file.ext] !== undefined) return mimes[file.ext];
        }
    }
    return 'application/octet-stream';
}
