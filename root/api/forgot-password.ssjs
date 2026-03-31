/* forgot-password.ssjs – Password recovery via email
 * POST: email=<address>
 * Always returns { sent: true } to avoid leaking whether an account exists.
 */
require('sbbsdefs.js', 'NET_INTERNET');

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');

var reply = { sent: true };

http_reply.header['Content-Type'] = 'application/json';

/* Only accept POST with an email parameter */
if (http_request.method !== 'POST' || !request.has_param('email')) {
    reply.sent = false;
    write(JSON.stringify(reply));
    exit();
}

var email = request.get_param('email').trim().toLowerCase();

/* Basic email format check */
if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 2) {
    /* Still return generic success – don't reveal validity */
    write(JSON.stringify(reply));
    exit();
}

/* Walk the user database and find a match on netmail */
var matched_user = null;
var lastuser = system.lastuser;
for (var n = 1; n <= lastuser; n++) {
    try {
        var u = new User(n);
        if (u.settings & (USER_DELETED | USER_INACTIVE)) continue;
        if (u.is_sysop) continue; /* don't email sysop credentials */
        if (!u.netmail) continue;
        if (u.netmail.toLowerCase() === email) {
            matched_user = u;
            break;
        }
    } catch (e) {
        continue;
    }
}

if (matched_user && matched_user.security && matched_user.security.password) {
    try {
        var msgbase = new MsgBase('mail');
        if (msgbase.open()) {
            var hdr = {
                to:           matched_user.alias,
                to_net_addr:  matched_user.netmail,
                to_net_type:  NET_INTERNET,
                from:         system.operator,
                from_ext:     '1',
                subject:      system.name + ' – Account Recovery'
            };

            var body = 'Your account recovery was requested on '
                     + system.timestr() + '\r\n'
                     + 'from ' + client.ip_address + ' via ' + client.protocol
                     + ' (port ' + client.port + ')\r\n\r\n'
                     + 'Account Alias: ' + matched_user.alias + '\r\n'
                     + 'Password: ' + matched_user.security.password + '\r\n\r\n'
                     + 'If you did not request this, you can safely ignore this message.\r\n';

            if (msgbase.save_msg(hdr, body)) {
                log(LOG_NOTICE,
                    'Forgot-password recovery emailed to: ' + matched_user.netmail);
            } else {
                log(LOG_ERR,
                    'Forgot-password save_msg error: ' + msgbase.last_error);
            }
            msgbase.close();
        } else {
            log(LOG_ERR, 'Forgot-password: could not open mail base');
        }
    } catch (err) {
        log(LOG_ERR, 'Forgot-password error: ' + err);
    }
}

/* Always the same response – never reveal whether a user was found */
write(JSON.stringify(reply));
