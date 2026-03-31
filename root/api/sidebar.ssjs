// sidebar.ssjs - Sidebar fragment endpoint

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load(settings.web_lib + 'sidebar.js');

http_reply.header['Content-Type'] = 'text/html; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
http_reply.header['Pragma'] = 'no-cache';
http_reply.header['Expires'] = '0';

writeSidebarModules();
