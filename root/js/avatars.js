function Avatarizer() {

    const cache = { local : {}, network : {} };
    const graphics_converter = GraphicsConverter.shared();

    function populate_image(target, image) {
        document.querySelectorAll("[name='avatar-" + target + "']").forEach(
            function (el) { el.appendChild(image.cloneNode(true)); }
        );
    }

    this.get_localuser = function (usernumber, bin) {
        if (typeof cache.local[usernumber] == 'undefined') {
            cache.local[usernumber] = null;
            graphics_converter.from_bin(
                atob(bin), 10, 6, function (img) {
                    cache.local[usernumber] = img;
                    populate_image(usernumber, img);
                }
            );
        }
    }

    this.get_netuser = function (username, netaddr, bin) {
        if (typeof cache.network[netaddr] == 'undefined') {
            cache.network[netaddr] = {};
        }
        if (typeof cache.network[netaddr][username] == 'undefined') {
            cache.network[netaddr][username] = null;
            graphics_converter.from_bin(
                atob(bin), 10, 6, function (img) {
                    cache.network[netaddr][username] = img;
                    populate_image(username + '@' + netaddr, img);
                }
            );
        }
    }

}

const Avatars = new ( function () {

    const gc = GraphicsConverter.shared();

    function draw(data) {
        const img = new Image();
        img.addEventListener('load', () => {
            document.querySelectorAll(`div[data-avatar="${data.user}"]:empty`).forEach(e => {
                e.appendChild(img.cloneNode(true))
            });
        });
        img.src = data.dataURL || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABgCAYAAACKa/UAAAABiUlEQVR4Xu3c0YqCUBiFUXtKX1Gfcga6TPBgn6LDrG5zSy3377EQX8uy/ExeXwu8AH5t9w4CbH4Aox9AgFUg5p0Dnw44z3P8iC2+rmvbwSB9eQMBxuMHEOCugBGOBQEIcF/AKhwbAvC/Ad592TLyPruRpy8iAEeHcPA+QICHBIzwIa7txgABHhOwCh/z2mwNEGAUiHENBBgFYlwDAUaBGNdAgFEgxjUQYBSIcQ0EGAViXAMBRoEY10CAUSDGNRBgFIhxDQQYBWJcAwFGgRjXQIBRIMYf38DP73f33Vpng31+v9PvjQEYRwQgwEMCRvgQ13ZjgAD3BR6/Ct99mRILNFXgPMIA44N3AAJMZwEjHJ+pABBgmkCrcOObAD4e8K9fplwNPFxEAO4/+QjgoKKjn3oAAdazXPs3RwM1UAOvFYh7t4gAjAIxroEAo0CMayDAKBDjGggwCsS4BgKMAjGugQCjQIxrIMAoEOMaCDAKxLgGAowCMa6BAKNAjGsgwCgQ4xoIMArE+KiBv6PnKB+V8OyaAAAAAElFTkSuQmCC';
    }

    /* Cached avatars are keyed by whatever string asked for them (a user
       number from the sidebar, an alias from a profile or post), and the
       browser store never expired them: an entry fetched before someone
       changed their avatar stayed wrong under that key forever. Cached art
       is drawn at once and revalidated in the background once it is older
       than this; a changed avatar is swapped in. */
    const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;

    async function fetchAndStore(list, previous) {
        // Batch into chunks of 20 to avoid URL length limits
        for (let i = 0; i < list.length; i += 20) {
            const batch = list.slice(i, i + 20);
            const a = await v4_get(`./api/system.ssjs?call=get-avatar&user=${batch.join('&user=')}`);
            if (!a) continue;
            a.forEach(e => {
                const old = previous[e.user];
                if (old && old.data === (e.data || null)) {
                    // Unchanged: just refresh the stamp, nothing to redraw.
                    sbbs.avatars.set({ ...old, fetchedAt: Date.now() });
                    return;
                }
                if (old) {
                    // Changed since it was cached: clear so draw() refills.
                    document.querySelectorAll(`div[data-avatar="${e.user}"]`).forEach(el => { el.innerHTML = ''; });
                }
                if (e.data) {
                    gc.from_bin(atob(e.data), 10, 6, dataURL => {
                        const o = { ...e, dataURL, fetchedAt: Date.now() };
                        sbbs.avatars.set(o);
                        draw(o);
                    }, true);
                } else {
                    const o = { user: e.user, data: null, dataURL: null, created: -1, updated: -1, fetchedAt: Date.now() };
                    sbbs.avatars.set(o);
                    draw(o);
                }
            });
        }
    }

    this.draw = async function (user) {

        const missing = [];
        const stale = [];
        const previous = {};
        for (let e of [].concat(user)) {
            const a = await sbbs.avatars.get(e);
            if (!a) {
                missing.push(e);
            } else {
                draw(a);
                if (!a.fetchedAt || Date.now() - a.fetchedAt > AVATAR_TTL_MS) { stale.push(e); previous[e] = a; }
            }
        }
        if (missing.length) await fetchAndStore(missing, {});
        if (stale.length) await fetchAndStore(stale, previous);

    }

} )();
