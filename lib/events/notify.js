/* Unread notification count (mods/load/notify_lib.js), pushed when it
   changes. Each cycle only stats the user's file; it is read again only when
   its date moves (a new notification, or one read here or in the terminal). */
load(system.mods_dir + 'load/notify_lib.js');

var last_date = -1;
var last_count = -1;

function cycle() {
    if (user.number < 1 || user.alias == settings.guest) return;
    var date = file_date(Notify.path(user.number));
    if (date === last_date) return;
    last_date = date;
    var count = Notify.unread(user.number);
    if (count === last_count) return;
    last_count = count;
    emit({ event: 'notify', data: JSON.stringify({ count: count }) });
}

this;
