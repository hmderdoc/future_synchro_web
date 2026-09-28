/* /u/?<alias> — short link to a member's profile page (the terminal prints
 * it; the full SPA URL is too wide). Anything that is not a plausible alias
 * goes to your own profile. */
var who = decodeURIComponent(String(http_request.query_string || '')).replace(/[\x00-\x1f<>"']/g, '').substr(0, 25);
http_reply.status = '302 Found';
function urlEncode(value) {
    return String(value).replace(/[^A-Za-z0-9_.~-]/g, function (ch) {
        var code = ch.charCodeAt(0);
        return '%' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase();
    });
}
http_reply.header['Location'] = '/?page=013-profile.xjs' + (who ? '&user=' + urlEncode(who) : '');
write('');
