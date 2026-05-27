/**
 * Provider 适配器注册表
 */

const adapters = {
  qwen:     require('./qwen'),
  deepseek: require('./deepseek'),
  kimi:     require('./kimi'),
  doubao:   require('./doubao'),
  zhipu:    require('./zhipu'),
  minimax:  require('./minimax'),
  mimo:     require('./mimo'),
};

module.exports = {
  getAdapter(name) {
    return adapters[name] || null;
  },
  listAdapters() {
    return Object.keys(adapters);
  },
};
