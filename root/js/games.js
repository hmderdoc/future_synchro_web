/* games.js - Usage viewer for web SPA
 * Mirrors logic from future_shell usage-viewer.js:
 *   sort modes, user filter, month navigation, icon rendering, top players
 */
(function () {
    'use strict';

    if (!window._gamesData) return;

    var data = window._gamesData;
    var gc = new GraphicsConverter('./images/cp437-ibm-vga8.png', 8, 16, 64, 4);

    var sortMode = 'time';
    var monthIndex = 0;
    var months = [];
    var userFilter = null;
    var userFilterAlias = null;
    var iconCache = {};

    /* ---------- Data aggregation ---------- */

    function buildMonths() {
        months = [];
        var raw = data.usage || {};
        var keys = Object.keys(raw).filter(function (k) {
            return /^\d{4}-\d{2}$/.test(k);
        }).sort();
        keys.reverse();

        var allTime = {
            month: 'All Time', count: 0, seconds: 0,
            programs: {}, users: {}
        };

        keys.forEach(function (key) {
            var entry = raw[key] || {};
            var totals = entry.totals || {};
            var programs = entry.programs || {};
            var users = entry.users || {};

            months.push({
                month: key,
                count: totals.count || 0,
                seconds: totals.seconds || 0,
                programs: programs,
                users: users
            });

            allTime.count += totals.count || 0;
            allTime.seconds += totals.seconds || 0;

            for (var pid in programs) {
                if (!programs.hasOwnProperty(pid)) continue;
                var p = programs[pid] || {};
                if (!allTime.programs[pid]) {
                    allTime.programs[pid] = { count: 0, seconds: 0, lastTimestamp: 0 };
                }
                var ap = allTime.programs[pid];
                ap.count += p.count || 0;
                ap.seconds += p.seconds || 0;
                if ((p.lastTimestamp || 0) > ap.lastTimestamp) ap.lastTimestamp = p.lastTimestamp;
            }

            for (var uk in users) {
                if (!users.hasOwnProperty(uk)) continue;
                var u = users[uk] || {};
                if (!allTime.users[uk]) {
                    allTime.users[uk] = { alias: u.alias || uk, number: u.number, programs: {} };
                }
                var srcProgs = u.programs || {};
                for (var upid in srcProgs) {
                    if (!srcProgs.hasOwnProperty(upid)) continue;
                    var usp = srcProgs[upid] || {};
                    if (!allTime.users[uk].programs[upid]) {
                        allTime.users[uk].programs[upid] = { count: 0, seconds: 0, lastTimestamp: 0 };
                    }
                    var dst = allTime.users[uk].programs[upid];
                    dst.count += usp.count || 0;
                    dst.seconds += usp.seconds || 0;
                    if ((usp.lastTimestamp || 0) > dst.lastTimestamp) dst.lastTimestamp = usp.lastTimestamp;
                }
            }
        });

        months.unshift(allTime);
    }

    /* ---------- Program list ---------- */

    function getVisiblePrograms() {
        var current = months[monthIndex] || { programs: {}, users: {} };
        var progMap = current.programs || {};

        var accessSet = {};
        data.programs.forEach(function (p) {
            accessSet[p.code.toUpperCase()] = p;
        });

        var list = [];
        var seen = {};

        if (userFilter) {
            var uEnt = (current.users || {})[userFilter];
            if (uEnt && uEnt.programs) {
                for (var pid in uEnt.programs) {
                    if (!uEnt.programs.hasOwnProperty(pid)) continue;
                    var st = uEnt.programs[pid] || {};
                    var upper = pid.toUpperCase();
                    var info = accessSet[upper];
                    if (!info) continue;
                    seen[upper] = true;
                    list.push(buildEntry(pid, info, st.count || 0, st.seconds || 0,
                        st.lastTimestamp || 0, current));
                }
            }
        } else {
            for (var pid in progMap) {
                if (!progMap.hasOwnProperty(pid)) continue;
                var p = progMap[pid] || {};
                var upper = pid.toUpperCase();
                var info = accessSet[upper];
                if (!info) continue;
                seen[upper] = true;
                list.push(buildEntry(pid, info, p.count || 0, p.seconds || 0,
                    p.lastTimestamp || 0, current));
            }

            data.programs.forEach(function (p) {
                var upper = p.code.toUpperCase();
                if (seen[upper]) return;
                seen[upper] = true;
                list.push(buildEntry(p.code, p, 0, 0, 0, current));
            });
        }

        sortPrograms(list);
        return list;
    }

    function buildEntry(pid, info, count, seconds, lastTimestamp, month) {
        return {
            id: pid,
            code: info.code,
            name: info.name,
            section: info.section,
            count: count,
            seconds: seconds,
            lastTimestamp: lastTimestamp,
            hasIcon: !!data.icons[pid.toUpperCase()],
            uniqueUsers: countUniqueUsers(month, pid)
        };
    }

    function countUniqueUsers(month, programId) {
        var users = month.users || {};
        var vu = data.validUsers || {};
        var count = 0;
        for (var key in users) {
            if (!users.hasOwnProperty(key)) continue;
            var u = users[key];
            if (!u || !u.number || !vu[String(u.number)]) continue;
            if (u.programs && u.programs[programId]) count++;
        }
        return count;
    }

    /* ---------- Sort ---------- */

    function sortPrograms(list) {
        list.sort(function (a, b) {
            if (sortMode === 'time') {
                if (b.seconds !== a.seconds) return b.seconds - a.seconds;
                if (b.count !== a.count) return b.count - a.count;
                return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
            }
            if (sortMode === 'launches') {
                if (b.count !== a.count) return b.count - a.count;
                if (b.seconds !== a.seconds) return b.seconds - a.seconds;
                return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
            }
            if (sortMode === 'recent') {
                if ((b.lastTimestamp || 0) !== (a.lastTimestamp || 0))
                    return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
                if (b.seconds !== a.seconds) return b.seconds - a.seconds;
                return b.count - a.count;
            }
            if (sortMode === 'name') {
                var A = (a.name || a.id || '').toLowerCase();
                var B = (b.name || b.id || '').toLowerCase();
                return A < B ? -1 : A > B ? 1 : 0;
            }
            if (sortMode === 'unique') {
                if (b.uniqueUsers !== a.uniqueUsers) return b.uniqueUsers - a.uniqueUsers;
                if (b.seconds !== a.seconds) return b.seconds - a.seconds;
                if (b.count !== a.count) return b.count - a.count;
                return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
            }
            return 0;
        });
    }

    /* ---------- Formatting ---------- */

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function formatDuration(seconds) {
        seconds = Math.max(0, Math.floor(Number(seconds) || 0));
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = seconds % 60;
        return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
    }

    function formatTimestamp(ts) {
        if (!ts) return 'Never';
        var d = new Date(ts);
        var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return mon[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    function formatProgramName(name) {
        if (!name) return 'Unknown';
        return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Unknown';
    }

    /* ---------- Top players ---------- */

    function getTopPlayers(month, programId) {
        var users = month.users || {};
        var vu = data.validUsers || {};
        var ranking = [];
        for (var key in users) {
            if (!users.hasOwnProperty(key)) continue;
            var info = users[key];
            if (!info || !info.programs || !info.programs[programId]) continue;
            var num = info.number;
            if (!num || !vu[String(num)]) continue;
            var stats = info.programs[programId];
            ranking.push({
                alias: vu[String(num)] || info.alias || key,
                number: num,
                seconds: stats.seconds || 0,
                count: stats.count || 0
            });
        }
        ranking.sort(function (a, b) {
            if (b.seconds !== a.seconds) return b.seconds - a.seconds;
            return b.count - a.count;
        });
        return ranking.slice(0, 3);
    }

    /* ---------- Icon rendering ---------- */

    function renderIcon(code, container) {
        var upper = code.toUpperCase();

        if (iconCache[upper]) {
            var img = new Image();
            img.src = iconCache[upper];
            img.className = 'game-icon-img';
            container.appendChild(img);
            return;
        }

        var b64 = data.icons[upper];
        if (!b64) {
            container.innerHTML = '<div class="game-icon-placeholder"></div>';
            return;
        }

        gc.from_bin(atob(b64), 12, 6, function (dataURL) {
            iconCache[upper] = dataURL;
            var img = new Image();
            img.src = dataURL;
            img.className = 'game-icon-img';
            container.innerHTML = '';
            container.appendChild(img);
        }, true);
    }

    /* ---------- Render ---------- */

    function render() {
        var current = months[monthIndex] || { month: 'All Time', count: 0, seconds: 0, programs: {}, users: {} };
        var programs = getVisiblePrograms();

        var monthLabel = document.getElementById('games-month-label');
        if (monthLabel) monthLabel.textContent = current.month;

        var prevBtn = document.getElementById('games-month-prev');
        var nextBtn = document.getElementById('games-month-next');
        if (prevBtn) prevBtn.classList.toggle('disabled', monthIndex <= 0);
        if (nextBtn) nextBtn.classList.toggle('disabled', monthIndex >= months.length - 1);

        var displayCount = current.count;
        var displaySeconds = current.seconds;
        if (userFilter) {
            var uEnt = (current.users || {})[userFilter];
            if (uEnt && uEnt.programs) {
                displayCount = 0; displaySeconds = 0;
                for (var pk in uEnt.programs) {
                    if (!uEnt.programs.hasOwnProperty(pk)) continue;
                    displayCount += uEnt.programs[pk].count || 0;
                    displaySeconds += uEnt.programs[pk].seconds || 0;
                }
            }
        }

        var statsEl = document.getElementById('games-stats');
        if (statsEl) {
            statsEl.innerHTML =
                '<span><strong>' + programs.length + '</strong> Programs</span>' +
                '<span><strong>' + displayCount + '</strong> Launches</span>' +
                '<span><strong>' + formatDuration(displaySeconds) + '</strong> Play Time</span>';
        }

        document.querySelectorAll('#games-sort .btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-sort') === sortMode);
        });

        var filterBtn = document.getElementById('games-user-filter');
        if (filterBtn) {
            filterBtn.innerHTML = '<span class="glyphicon glyphicon-user"></span> ' +
                escapeHtml(userFilterAlias || 'All Users');
        }

        var grid = document.getElementById('games-grid');
        if (!grid) return;
        grid.innerHTML = '';

        if (!programs.length) {
            grid.innerHTML = '<div class="text-muted p-3">No programs found.</div>';
            return;
        }

        programs.forEach(function (prog, idx) {
            var topPlayers = getTopPlayers(current, prog.id);

            var row = document.createElement('div');
            row.className = 'game-row d-flex align-items-start mb-2 p-2 rounded';
            row.setAttribute('data-code', prog.code);

            var rank = document.createElement('div');
            rank.className = 'game-rank me-2 text-muted';
            rank.textContent = '#' + (idx + 1);
            row.appendChild(rank);

            var iconDiv = document.createElement('div');
            iconDiv.className = 'game-icon me-3 flex-shrink-0';
            renderIcon(prog.id, iconDiv);
            row.appendChild(iconDiv);

            var infoDiv = document.createElement('div');
            infoDiv.className = 'game-info flex-grow-1 min-width-0';

            var titleRow = document.createElement('div');
            titleRow.className = 'd-flex align-items-baseline flex-wrap gap-2 mb-1';
            var title = document.createElement('strong');
            title.className = 'game-title';
            title.textContent = formatProgramName(prog.name);
            titleRow.appendChild(title);
            var section = document.createElement('small');
            section.className = 'text-muted';
            section.textContent = prog.section;
            titleRow.appendChild(section);
            infoDiv.appendChild(titleRow);

            var statsLine = document.createElement('div');
            statsLine.className = 'game-stats-line small d-flex flex-wrap gap-3';
            statsLine.innerHTML =
                '<span class="game-stat-time" title="Play Time"><span class="game-stat-label">Time</span> ' + formatDuration(prog.seconds) + '</span>' +
                '<span class="game-stat-launches" title="Launches"><span class="game-stat-label">Launches</span> ' + prog.count + '</span>' +
                '<span class="game-stat-recent" title="Last Played"><span class="game-stat-label">Last</span> ' + formatTimestamp(prog.lastTimestamp) + '</span>' +
                '<span class="game-stat-players" title="Unique Players"><span class="game-stat-label">Players</span> ' + prog.uniqueUsers + '</span>';
            infoDiv.appendChild(statsLine);

            if (topPlayers.length > 0) {
                var playersLine = document.createElement('div');
                playersLine.className = 'game-top-players small text-muted mt-1';
                playersLine.innerHTML = '<span class="game-stat-label">Top</span> ' +
                    topPlayers.map(function (p) {
                        return escapeHtml(p.alias) + ' <span class="text-muted">(' + p.count + ')</span>';
                    }).join(', ');
                infoDiv.appendChild(playersLine);
            }

            row.appendChild(infoDiv);

            var launchBtn = document.createElement('button');
            launchBtn.className = 'btn btn-sm btn-outline-success ms-2 flex-shrink-0 game-launch-btn';
            launchBtn.textContent = 'Play';
            launchBtn.title = 'Launch ' + formatProgramName(prog.name);
            if (data.isGuest) {
                launchBtn.disabled = true;
                launchBtn.title = 'Log in to play';
            } else {
                launchBtn.addEventListener('click', function () {
                    launchGame(prog.code);
                });
            }
            row.appendChild(launchBtn);

            grid.appendChild(row);
        });
    }

    /* ---------- Launch ---------- */

    function launchGame(code) {
        if (window.sbbsTerminal && window.sbbsTerminal.launchXtrn) {
            window.sbbsTerminal.launchXtrn(code);
        }
    }

    /* ---------- User filter ---------- */

    function getUserList() {
        var current = months[monthIndex] || {};
        var usersMap = current.users || {};
        var vu = data.validUsers || {};
        var seen = {};
        var entries = [{ key: null, alias: 'All Users', number: null }];
        for (var k in usersMap) {
            if (!usersMap.hasOwnProperty(k)) continue;
            var u = usersMap[k] || {};
            var num = u.number;
            if (!num || !vu[String(num)]) continue;
            if (seen[num]) continue;
            seen[num] = true;
            entries.push({ key: k, alias: vu[String(num)] || u.alias || k, number: num });
        }
        entries.sort(function (a, b) {
            if (a.key === null) return -1;
            if (b.key === null) return 1;
            return a.alias.toLowerCase().localeCompare(b.alias.toLowerCase());
        });
        return entries;
    }

    function showUserFilterDropdown() {
        var existing = document.getElementById('games-user-dropdown');
        if (existing) { existing.remove(); return; }

        var users = getUserList();
        var btn = document.getElementById('games-user-filter');
        if (!btn) return;

        var dropdown = document.createElement('div');
        dropdown.id = 'games-user-dropdown';
        dropdown.className = 'dropdown-menu show game-user-dropdown';

        var avatarUsers = [];

        users.forEach(function (u) {
            var item = document.createElement('a');
            item.className = 'dropdown-item d-flex align-items-center gap-2';
            item.href = '#';

            if (u.number) {
                var avatarDiv = document.createElement('div');
                avatarDiv.className = 'avatar-inline avatar-xs';
                avatarDiv.setAttribute('data-avatar', String(u.number));
                item.appendChild(avatarDiv);
                avatarUsers.push(u.number);
            }

            var nameSpan = document.createElement('span');
            nameSpan.textContent = u.alias;
            item.appendChild(nameSpan);

            if ((u.key === null && !userFilter) || u.key === userFilter) {
                item.classList.add('active');
            }

            item.addEventListener('click', function (ev) {
                ev.preventDefault();
                userFilter = u.key;
                userFilterAlias = u.key ? u.alias : null;
                dropdown.remove();
                render();
            });

            dropdown.appendChild(item);
        });

        btn.parentElement.appendChild(dropdown);

        if (avatarUsers.length && typeof Avatars !== 'undefined' && Avatars.draw) {
            Avatars.draw(avatarUsers);
        }

        setTimeout(function () {
            function handler(ev) {
                if (!dropdown.contains(ev.target) && ev.target !== btn) {
                    dropdown.remove();
                    document.removeEventListener('click', handler);
                }
            }
            document.addEventListener('click', handler);
        }, 0);
    }

    /* ---------- Helpers ---------- */

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    /* ---------- Init ---------- */

    function init() {
        buildMonths();

        document.querySelectorAll('#games-sort .btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                sortMode = btn.getAttribute('data-sort');
                render();
            });
        });

        var prevBtn = document.getElementById('games-month-prev');
        if (prevBtn) prevBtn.addEventListener('click', function () {
            if (monthIndex > 0) { monthIndex--; render(); }
        });

        var nextBtn = document.getElementById('games-month-next');
        if (nextBtn) nextBtn.addEventListener('click', function () {
            if (monthIndex < months.length - 1) { monthIndex++; render(); }
        });

        var filterBtn = document.getElementById('games-user-filter');
        if (filterBtn) filterBtn.addEventListener('click', function () {
            showUserFilterDropdown();
        });

        render();
    }

    init();
})();
