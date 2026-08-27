const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

let store = { orders: {}, payments: {} };
let saveTimer = null;

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      store = {
        orders: parsed.orders && typeof parsed.orders === 'object' ? parsed.orders : {},
        payments: parsed.payments && typeof parsed.payments === 'object' ? parsed.payments : {},
      };
    }
  } catch (err) {
    console.error('store load failed:', err.message);
    store = { orders: {}, payments: {} };
  }
}

function saveStoreNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStoreNow, 150);
}

loadStore();

class Bucket {
  constructor(key) {
    this.key = key;
  }

  has(id) {
    return Object.prototype.hasOwnProperty.call(store[this.key], id);
  }

  get(id) {
    return store[this.key][id];
  }

  set(id, value) {
    store[this.key][id] = value;
    scheduleSave();
    return this;
  }

  delete(id) {
    if (!this.has(id)) return false;
    delete store[this.key][id];
    scheduleSave();
    return true;
  }

  entries() {
    return Object.entries(store[this.key]);
  }

  values() {
    return Object.values(store[this.key]);
  }
}

const orders = new Bucket('orders');
const payments = new Bucket('payments');

function flush() {
  clearTimeout(saveTimer);
  saveStoreNow();
}

module.exports = {
  orders,
  payments,
  flush,
  DATA_DIR,
};
