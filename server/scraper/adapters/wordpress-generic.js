const BaseSiteAdapter = require('../base-adapter');

class WordPressGenericAdapter extends BaseSiteAdapter {
  static match(url) { return false; }

  getSearchStrategy() { return 'wordpress'; }

  getContentSelectors() {
    return ['.entry-content', '.post-content', 'article', '.content-area'];
  }

  getExcludeSelectors() {
    return ['aside', '.sidebar', '.widget-area', 'nav', 'footer', '.comments-area'];
  }
}

module.exports = WordPressGenericAdapter;
