const sanitize = require('sanitize-filename');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractAlbumName(title, keyword) {
  if (!title || title === 'Direct URL') return '';
  let album = title;
  if (keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    album = album.replace(new RegExp(escaped, 'gi'), '');
  }
  album = album.replace(/\[[^\]]*\]\s*/g, '');
  album = album.replace(/^[\s\-–—|:,·]+|[\s\-–—|:,·]+$/g, '').trim();
  album = sanitize(album).replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (album.length > 50) album = album.substring(0, 50).replace(/_$/, '');
  return album;
}

function normalizeImageUrl(url) {
  return url.replace(/!sml$/i, '!lrg');
}

module.exports = { sleep, extractAlbumName, normalizeImageUrl };
