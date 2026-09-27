/* /w/?<slug> — short link to a wiki page (the terminal's Settings > My
 * Profile prints it; the full SPA URL is too wide for its page).
 * Anything that is not a valid wiki slug goes to the wiki home. */
var slug = String(http_request.query_string || '').toLowerCase();
if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) slug = '';
http_reply.status = '302 Found';
http_reply.header['Location'] = '/?page=010-wiki.xjs' + (slug ? '#wiki/' + slug : '');
write('');
