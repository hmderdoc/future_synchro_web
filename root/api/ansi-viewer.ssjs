var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');

var ansi_viewer = load({}, settings.web_lib + 'ansi-viewer.js');
var response = JSON.stringify(
    ansi_viewer.build_state({
        gallery_id: (
            http_request.query.gallery !== undefined &&
            http_request.query.gallery.length
        ) ? http_request.query.gallery[0] : '',
        relative_dir: (
            http_request.query.dir !== undefined &&
            http_request.query.dir.length
        ) ? http_request.query.dir[0] : '',
        file_name: (
            http_request.query.file !== undefined &&
            http_request.query.file.length
        ) ? http_request.query.file[0] : '',
        mode: (
            http_request.query.mode !== undefined &&
            http_request.query.mode.length
        ) ? http_request.query.mode[0] : 'random',
        slide_scope: (
            http_request.query.slide_scope !== undefined &&
            http_request.query.slide_scope.length
        ) ? http_request.query.slide_scope[0] : '',
        slide_order: (
            http_request.query.slide_order !== undefined &&
            http_request.query.slide_order.length
        ) ? http_request.query.slide_order[0] : '',
        slide_action: (
            http_request.query.slide_action !== undefined &&
            http_request.query.slide_action.length
        ) ? http_request.query.slide_action[0] : '',
        slideshow_active: (
            http_request.query.slideshow !== undefined &&
            http_request.query.slideshow.length &&
            http_request.query.slideshow[0] === '1'
        )
    })
);

http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Content-Length'] = response.length;

write(response);

response = undefined;
