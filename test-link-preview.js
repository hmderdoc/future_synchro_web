/* test-link-preview.js — offline checks for lib/link-preview.js.
 * Run with: /sbbs/exec/jsexec /sbbs/webv4_custom/test-link-preview.js
 * Exercises the pure parts (URL validation, SSRF guards, metadata parsing);
 * no network fetches.
 */

load('/sbbs/webv4_custom/lib/link-preview.js');

var failures = 0;

function check(label, condition) {
    if (condition) return;
    failures++;
    writeln('FAIL: ' + label);
}

/* ------------------------------------------------------ URL validation */

check('plain https accepted', linkPreview.validateTarget('https://example.com/a').ok);
check('http accepted', linkPreview.validateTarget('http://example.com').ok);
check('ftp rejected', !linkPreview.validateTarget('ftp://example.com/a').ok);
check('userinfo rejected', !linkPreview.validateTarget('https://evil@example.com/').ok);
check('odd port rejected', !linkPreview.validateTarget('https://example.com:8080/').ok);
check('port 443 accepted', linkPreview.validateTarget('https://example.com:443/').ok);
check('oversized url rejected', !linkPreview.validateTarget('https://example.com/' + new Array(3000).join('a')).ok);

/* ------------------------------------------------------------ SSRF guard */

check('loopback private', linkPreview.isPrivateAddress('127.0.0.1'));
check('rfc1918 10/8', linkPreview.isPrivateAddress('10.1.2.3'));
check('rfc1918 172.16/12', linkPreview.isPrivateAddress('172.20.0.1'));
check('rfc1918 192.168/16', linkPreview.isPrivateAddress('192.168.1.1'));
check('link-local', linkPreview.isPrivateAddress('169.254.10.10'));
check('cgnat', linkPreview.isPrivateAddress('100.100.1.1'));
check('multicast', linkPreview.isPrivateAddress('224.0.0.1'));
check('broadcast', linkPreview.isPrivateAddress('255.255.255.255'));
check('v6 loopback', linkPreview.isPrivateAddress('::1'));
check('v6 unique-local', linkPreview.isPrivateAddress('fd00::1'));
check('v6 link-local', linkPreview.isPrivateAddress('fe80::1'));
check('v6 mapped private', linkPreview.isPrivateAddress('::ffff:192.168.0.1'));
check('malformed treated private', linkPreview.isPrivateAddress('not-an-ip'));
check('public v4 allowed', !linkPreview.isPrivateAddress('93.184.216.34'));
check('public v6 allowed', !linkPreview.isPrivateAddress('2606:2800:220:1::1'));

check('ip literal target blocked', linkPreview.checkHostPublic('127.0.0.1') !== null);
check('ip literal public ok', linkPreview.checkHostPublic('93.184.216.34') === null);
check('localhost blocked via resolver', linkPreview.checkHostPublic('localhost') !== null);

/* --------------------------------------------------------- URL resolving */

check('absolute passthrough',
    linkPreview.resolveUrl('https://x.test/a', 'https://base.test/') === 'https://x.test/a');
check('protocol-relative',
    linkPreview.resolveUrl('//cdn.test/i.png', 'https://base.test/page') === 'https://cdn.test/i.png');
check('root-relative',
    linkPreview.resolveUrl('/img/i.png', 'https://base.test/deep/page') === 'https://base.test/img/i.png');
check('path-relative',
    linkPreview.resolveUrl('i.png', 'https://base.test/deep/page') === 'https://base.test/deep/i.png');

/* ------------------------------------------------------ metadata parsing */

var html = '<!doctype html><html><head>' +
    '<title>Fallback &amp; Title</title>' +
    '<meta property="og:title" content="An OG &quot;Title&quot;">' +
    "<meta content='Description here' property='og:description'>" +
    '<meta property="og:image" content="/images/hero.png">' +
    '<meta property="og:site_name" content="Example Site">' +
    '</head><body></body></html>';
var meta = linkPreview.parseMetadata(html, 'https://example.com/article/page');
check('og title wins + entities decode', meta.title === 'An OG "Title"');
check('attribute order agnostic', meta.description === 'Description here');
check('relative og:image resolves', meta.image === 'https://example.com/images/hero.png');
check('site name', meta.siteName === 'Example Site');

var fallbackMeta = linkPreview.parseMetadata(
    '<title>Only &#x74;itle</title><meta name="description" content="md">', 'https://x.test/');
check('title fallback + hex entity', fallbackMeta.title === 'Only title');
check('meta description fallback', fallbackMeta.description === 'md');
check('no image -> empty', fallbackMeta.image === '');

var hostileMeta = linkPreview.parseMetadata(
    '<meta property="og:title" content="A\x01B   C&#0;">', 'https://x.test/');
check('control chars stripped', hostileMeta.title === 'A B C');

/* Numeric entities decode to UTF-8 BYTE SEQUENCES (byte-oriented write()
   and File.write round-trip them losslessly; real codepoints > 0xff would
   be truncated to their low byte). */
check('numeric entity -> utf8 bytes', linkPreview.parseMetadata(
    '<meta property="og:title" content="a&#8230;b">', 'https://x.test/').title === 'a\xe2\x80\xa6b');
check('hex entity above 0xff -> utf8 bytes', linkPreview.parseMetadata(
    '<meta property="og:title" content="&#x2764;">', 'https://x.test/').title === '\xe2\x9d\xa4');

var longTitle = new Array(500).join('x');
var cappedMeta = linkPreview.parseMetadata(
    '<meta property="og:title" content="' + longTitle + '">', 'https://x.test/');
check('title capped', cappedMeta.title.length <= 200);

check('javascript og:image dropped', linkPreview.parseMetadata(
    '<meta property="og:title" content="t">' +
    '<meta property="og:image" content="javascript:alert(1)">', 'https://x.test/').image === '');

if (failures) {
    writeln('LINK-PREVIEW TESTS FAILED: ' + failures);
    exit(1);
}
writeln('LINK-PREVIEW TESTS OK');
