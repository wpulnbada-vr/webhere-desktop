const BaseSiteAdapter = require('../base-adapter');

class FourKHDAdapter extends BaseSiteAdapter {
  static match(url) { return /4khd\.com/i.test(url); }

  getSearchStrategy() { return 'auto'; }

  getCustomSearchUrl(origin, keyword) {
    return `${origin}/search/${encodeURIComponent(keyword)}`;
  }

  getContentSelectors() {
    return ['.entry-content', '.post-content', 'article', '.content', 'main'];
  }

  getExcludeSelectors() {
    return [
      'aside', '.sidebar', '.widget', 'nav', 'footer',
      '[class*="sidebar"]', '[id*="sidebar"]',
      '.related-posts', '.comments',
    ];
  }
}

module.exports = FourKHDAdapter;
