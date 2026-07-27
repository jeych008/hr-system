function createStorage(config, jsonAdapter) {
  if (config.storageDriver === "mysql") {
    const { createMysqlStore } = require("./mysql-store");
    return createMysqlStore(config);
  }
  return {
    async init() { await jsonAdapter.init(); },
    async read() { return jsonAdapter.read(); },
    async write(db) { return jsonAdapter.write(db); },
    async counts() {
      const db = await jsonAdapter.read();
      return Object.fromEntries(Object.entries(db).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
    },
    async close() {}
  };
}

module.exports = { createStorage };
