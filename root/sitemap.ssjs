/* sitemap.ssjs - XML sitemap of the public sections, for search engines.
   Keep the list in step with the Allow side of robots.txt. */
var base = 'https://' + (system.inet_addr || system.name) + '/';
var pages = [
    '001-chat.xjs',
    '002-forum.xjs',
    '003-games.xjs',
    '006-files.xjs',
    '009-news.xjs',
    '010-wiki.xjs',
    '011-futureland-records.xjs',
    '012-futureland-gallery.xjs'
];

http_reply.header['Content-Type'] = 'application/xml; charset=utf-8';
writeln('<?xml version="1.0" encoding="UTF-8"?>');
writeln('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
writeln('  <url><loc>' + base + '</loc><changefreq>daily</changefreq><priority>1.0</priority></url>');
pages.forEach(function (p) {
    writeln('  <url><loc>' + base + '?page=' + p + '</loc><changefreq>daily</changefreq></url>');
});
writeln('</urlset>');
