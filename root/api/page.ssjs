// page.ssjs - SPA fragment endpoint
// Returns page HTML content directly (not JSON)
// Metadata passed via response headers:
//   X-Page-Title: page title
//   X-Page-NoSidebar: true/false
//   X-Page-Redirect: URL (for .link files)
//
// XJS/SSJS pages use js.exec() which writes directly to the response,
// so we cannot capture their output into a JSON wrapper.

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load(settings.web_lib + 'pages.js');

http_reply.header['Content-Type'] = 'text/html; charset=utf-8';

if (typeof http_request.query.page === 'undefined') {
    http_reply.header['X-Page-Title'] = 'Error';
    http_reply.header['X-Page-NoSidebar'] = 'true';
    write('<div class="alert alert-danger">No page specified</div>');
} else {
    var page = http_request.query.page[0];

    // Security: reject absolute URLs
    if (page.search(/^http(s)*:\/\//) > -1) {
        http_reply.header['X-Page-Title'] = 'Error';
        http_reply.header['X-Page-NoSidebar'] = 'true';
        write('<div class="alert alert-danger">Invalid page</div>');
    } else if (page.search(/\.link$/) > -1) {
        // .link files: tell client to redirect
        try {
            var loc = getExternalLink(page);
            http_reply.header['X-Page-Redirect'] = loc;
            http_reply.header['X-Page-Title'] = 'Redirect';
        } catch (e) {
            http_reply.header['X-Page-Title'] = 'Error';
            write('<div class="alert alert-danger">Invalid link</div>');
        }
    } else {
        var pagePath = getPagePath(page);
        if (pagePath == null) {
            page = '000-home.xjs';
            pagePath = getPagePath('000-home.xjs');
        }

        var page_ctrl = getCtrlLine(pagePath);
        http_reply.header['X-Page-Title'] = page_ctrl.title;
        http_reply.header['X-Page-NoSidebar'] = String(
            page_ctrl.options.no_sidebar || settings.layout_sidebar_off
        );

        // Render page content - getPage() handles all file types:
        // .HTML/.TXT: returns content string (we write it)
        // .XJS/.SSJS: js.exec() writes directly to response, returns ''
        var pp = getPagePath(page);
        var ini = getWebCtrl(pp.replace(file_getname(page), ''));
        if ((typeof ini === 'boolean' && !ini) || webCtrlTest(ini, page)) {
            write(getPage(page));
        } else {
            write('<div class="alert alert-danger"><h3>You do not have access to this page</h3></div>');
        }
    }
}
