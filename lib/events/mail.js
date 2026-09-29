var last_run = 0;
var frequency = 10;
var last_count = -1;

/* Unread mail count, pushed when it changes (and every check while it is
   above zero, so a badge lost to a re-render comes back). The stream's user
   object lives for the whole connection: drop its cache each time so mail
   read in the terminal or on another tab shows here within `frequency`. */
function cycle() {
    if (user.number < 1 || user.alias == settings.guest) return;
    if (time() - last_run <= frequency) return;
    last_run = time();
    try { user.cached = false; } catch (e) { }
    const count = user.stats.unread_mail_waiting;
    if (count !== last_count || count > 0) {
        emit({ event: 'mail', data: JSON.stringify({ count: count })});
    }
    last_count = count;
}

this;
