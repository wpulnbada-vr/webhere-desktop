const EXCLUDE_PATTERNS = [
  'rating_off', 'rating_on', 'loading.gif', 'avatar', 'logo', 'icon',
  'favicon', 'emoji', 'star', 'close-icon', 'wp-postratings',
  'advertisement', 'banner', 'placeholder', 'spinner',
];

const BLOCKED_SCRIPTS = ['disabley', 'disable-devtool', 'devtools-detect'];
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp|gif|bmp)(![a-z]+)?(\?|$)/i;

const DEFAULT_CONTENT_SELECTORS = ['article', '.entry-content', '.post-content', 'main', '#content'];
const DEFAULT_EXCLUDE_SELECTORS = ['aside', '.sidebar', '.widget', 'nav', 'footer', '.related-posts'];

module.exports = { EXCLUDE_PATTERNS, BLOCKED_SCRIPTS, IMAGE_EXTENSIONS, DEFAULT_CONTENT_SELECTORS, DEFAULT_EXCLUDE_SELECTORS };
