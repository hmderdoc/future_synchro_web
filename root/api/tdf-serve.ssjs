// tdf-serve.ssjs — Serve TDF font data for client-side rendering
// ?map         → font height map JSON (figlet_font_map.json)
// ?font=NAME   → base64-encoded TDF font file as JSON { name, b64 }

load('sbbsdefs.js');

var qs = http_request.query;

if (qs.map !== undefined) {
    // Serve the font-height map
    http_reply.header['Content-Type'] = 'application/json';
    http_reply.header['Cache-Control'] = 'public, max-age=86400';
    var f = new File(system.data_dir + 'figlet_font_map.json');
    if (f.open('r')) {
        write(f.read());
        f.close();
    } else {
        http_reply.status = '500 Internal Server Error';
        write(JSON.stringify({ error: 'font map not found' }));
    }

} else if (qs.font) {
    // Serve a TDF font file as base64 JSON
    var name = String(qs.font).replace(/[^a-zA-Z0-9_\-!#]/g, '');
    var path = system.ctrl_dir + 'tdfonts/' + name + '.tdf';
    http_reply.header['Content-Type'] = 'application/json';
    http_reply.header['Cache-Control'] = 'public, max-age=604800';  // 7 days
    var f = new File(path);
    if (f.open('rb')) {
        var data = f.read(f.length);
        f.close();
        write(JSON.stringify({ name: name, b64: base64_encode(data) }));
    } else {
        http_reply.status = '404 Not Found';
        write(JSON.stringify({ error: 'font not found: ' + name }));
    }

} else {
    http_reply.header['Content-Type'] = 'application/json';
    write(JSON.stringify({ usage: '?map or ?font=NAME' }));
}
