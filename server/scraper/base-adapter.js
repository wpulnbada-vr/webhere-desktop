const { DEFAULT_CONTENT_SELECTORS, DEFAULT_EXCLUDE_SELECTORS } = require('./constants');
const { normalizeImageUrl } = require('./utils');

class BaseSiteAdapter {
  static match(url) { return true; }

  getSearchStrategy() { return 'auto'; }

  getContentSelectors() {
    return DEFAULT_CONTENT_SELECTORS;
  }

  getExcludeSelectors() {
    return DEFAULT_EXCLUDE_SELECTORS;
  }

  filterSearchPageImages() { return false; }

  // Custom search URL for sites with non-standard search endpoints
  // Return null to use default WP/form/category strategies
  getCustomSearchUrl(origin, keyword) { return null; }

  extractPosts(page, html, origin) { return null; }

  extractImages(page, minWidth, minHeight) { return null; }

  getDownloadHeaders(imgUrl, pageUrl) { return {}; }

  normalizeImageUrl(url) { return normalizeImageUrl(url); }
}

module.exports = BaseSiteAdapter;
