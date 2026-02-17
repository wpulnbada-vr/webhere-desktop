const BaseSiteAdapter = require('../base-adapter');

class EveriaClubAdapter extends BaseSiteAdapter {
  static match(url) { return /everiaclub\.com/i.test(url); }

  getSearchStrategy() { return 'auto'; }

  getCustomSearchUrl(origin, keyword) {
    return `${origin}/search/?keyword=${encodeURIComponent(keyword)}`;
  }

  getContentSelectors() {
    return ['.entry-content', '.post-content', 'article .content', 'article'];
  }

  getExcludeSelectors() {
    return [
      'aside', '.sidebar', '.widget', 'nav', 'footer',
      '.widget_recent_entries', '.recent-posts',
      '[class*="sidebar"]', '[id*="sidebar"]',
    ];
  }
}

module.exports = EveriaClubAdapter;
