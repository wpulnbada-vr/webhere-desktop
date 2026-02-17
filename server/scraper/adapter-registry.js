const fs = require('fs');
const path = require('path');
const BaseSiteAdapter = require('./base-adapter');

class AdapterRegistry {
  constructor() {
    this._adapters = [];
  }

  register(AdapterClass) {
    this._adapters.push(AdapterClass);
  }

  resolve(url) {
    for (const A of this._adapters) {
      if (A !== BaseSiteAdapter && A.match(url)) return new A();
    }
    return new BaseSiteAdapter();
  }

  autoLoad(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const AdapterClass = require(path.join(dir, file));
        if (AdapterClass && typeof AdapterClass.match === 'function') {
          this.register(AdapterClass);
        }
      } catch {}
    }
  }
}

const registry = new AdapterRegistry();
registry.autoLoad(path.join(__dirname, 'adapters'));

module.exports = registry;
