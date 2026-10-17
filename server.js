require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const {
  BOT_TOKEN, ADMIN_TOKEN, ADMIN_CHAT_ID, BASE_URL, SUPPORT_USERNAME = '',
  PAY_API_KEY, PAY_BASE, PORT = 3000,
} = process.env;

const db = new Database('store.db');
db.exec(`
CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY, label TEXT, price INTEGER, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, tg_id TEXT, game_uid TEXT, package_id INTEGER, label TEXT, price INTEGER,
  status TEXT DEFAULT 'pending', invoice_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users(tg_id TEXT PRIMARY KEY, balance INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS deposits(id INTEGER PRIMARY KEY, tg_id TEXT, method TEXT, amount INTEGER, trx_id TEXT UNIQUE,
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Telegram Mini App auth (validates initData signature) ----
function tgUser(req) {
  const initData = req.get('x-init-data') || '';
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (!hash || calc !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
const needUser = (req, res, next) => {
  const u = tgUser(req);
  if (!u) return res.status(401).json({ error: 'Telegram থেকে অ্যাপ খুলুন' });
  req.tg = u; next();
};
const needAdmin = (req, res, next) =>
  ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.status(401).json({ error: 'unauthorized' });
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/ping', (_, res) => res.json({ ok: true, adminTokenSet: !!ADMIN_TOKEN }));

async function notify(chatId, text, extra = {}) {
  if (!chatId) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  }).catch(() => {});
}

// ---- Public API ----
app.get('/api/config', (_, res) => res.json({ support: SUPPORT_USERNAME, name: process.env.SHOP_NAME || 'Diamond Shop', bkash: process.env.BKASH_NUMBER || '', nagad: process.env.NAGAD_NUMBER || '' }));
app.get('/api/packages', (_, res) =>
  res.json(db.prepare('SELECT id,label,price FROM packages WHERE active=1 ORDER BY sort,id').all()));

app.post('/api/orders', needUser, async (req, res) => {
  const { uid, packageId } = req.body;
  if (!/^\d{8,12}$/.test(uid || '')) return res.status(400).json({ error: 'সঠিক UID দিন (কমপক্ষে ৮ ডিজিট)' });
  const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(packageId);
  if (!pkg) return res.status(400).json({ error: 'প্যাকেজ পাওয়া যায়নি' });

  const info = db.prepare('INSERT INTO orders(tg_id,game_uid,package_id,label,price) VALUES(?,?,?,?,?)')
    .run(String(req.tg.id), uid, pkg.id, pkg.label, pkg.price);
  const orderId = info.lastInsertRowid;

  // Payment gateway (UddoktaPay-style). Adjust endpoint/fields for your gateway.
  const r = await fetch(`${PAY_BASE}/api/checkout-v2`, {
    method: 'POST',
    headers: { 'RT-UDDOKTAPAY-API-KEY': PAY_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      full_name: req.tg.first_name || 'Customer', email: `tg${req.tg.id}@example.com`,
      amount: String(pkg.price), metadata: { order_id: orderId },
      redirect_url: `${BASE_URL}/paid.html`, cancel_url: `${BASE_URL}/`,
      webhook_url: `${BASE_URL}/api/webhook/pay`, return_type: 'GET',
    }),
  }).then(x => x.json()).catch(() => null);

  if (!r || !r.payment_url) return res.status(502).json({ error: 'পেমেন্ট শুরু করা যায়নি, আবার চেষ্টা করুন' });
  res.json({ orderId, paymentUrl: r.payment_url });
});

app.get('/api/my-orders', needUser, (req, res) =>
  res.json(db.prepare('SELECT id,game_uid,label,price,status,created_at FROM orders WHERE tg_id=? ORDER BY id DESC LIMIT 30')
    .all(String(req.tg.id))));

// Gateway webhook: always re-verify with the gateway before marking paid
app.post('/api/webhook/pay', async (req, res) => {
  if (req.get('rt-uddoktapay-api-key') !== PAY_API_KEY) return res.sendStatus(401);
  const { invoice_id } = req.body;
  const v = await fetch(`${PAY_BASE}/api/verify-payment`, {
    method: 'POST',
    headers: { 'RT-UDDOKTAPAY-API-KEY': PAY_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoice_id }),
  }).then(x => x.json()).catch(() => null);
  const orderId = v && v.metadata && v.metadata.order_id;
  const order = orderId && db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (order && v.status === 'COMPLETED' && Number(v.amount) >= order.price && order.status === 'pending') {
    db.prepare("UPDATE orders SET status='paid', invoice_id=? WHERE id=?").run(invoice_id, order.id);
    notify(ADMIN_CHAT_ID, `নতুন পেইড অর্ডার #${order.id}\nUID: ${order.game_uid}\n${order.label} — ${order.price}৳`);
    notify(order.tg_id, `পেমেন্ট পেয়েছি ✅ অর্ডার #${order.id} প্রসেস হচ্ছে।`);
  }
  res.sendStatus(200);
});

// ---- Admin API ----
app.get('/api/admin/packages', needAdmin, (_, res) => res.json(db.prepare('SELECT * FROM packages ORDER BY sort,id').all()));
app.post('/api/admin/packages', needAdmin, (req, res) => {
  const { id, label, price, active = 1, sort = 0 } = req.body;
  if (id) db.prepare('UPDATE packages SET label=?,price=?,active=?,sort=? WHERE id=?').run(label, price, active, sort, id);
  else db.prepare('INSERT INTO packages(label,price,active,sort) VALUES(?,?,?,?)').run(label, price, active, sort);
  res.json({ ok: true });
});
app.delete('/api/admin/packages/:id', needAdmin, (req, res) => {
  db.prepare('DELETE FROM packages WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.get('/api/admin/orders', needAdmin, (_, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all()));
app.post('/api/admin/orders/:id/status', needAdmin, (req, res) => {
  const { status } = req.body; // paid | delivered | failed | refunded
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.sendStatus(404);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, o.id);
  if (status === 'delivered') notify(o.tg_id, `অর্ডার #${o.id} ডেলিভারি হয়েছে ✅ (${o.label})`);
  res.json({ ok: true });
});

// ---- Wallet: balance, add money (Send Money + TrxID), pay from balance ----
const getBal = id => (db.prepare('SELECT balance FROM users WHERE tg_id=?').get(String(id)) || { balance: 0 }).balance;

app.get('/api/me', needUser, (req, res) => {
  const id = String(req.tg.id);
  res.json({ balance: getBal(id),
    deposits: db.prepare('SELECT id,method,amount,status,created_at FROM deposits WHERE tg_id=? ORDER BY id DESC LIMIT 20').all(id) });
});

app.post('/api/deposits', needUser, (req, res) => {
  const method = req.body.method;
  const amount = parseInt(req.body.amount, 10);
  const trx = String(req.body.trxId || '').trim().toUpperCase();
  if (!['bkash', 'nagad'].includes(method)) return res.status(400).json({ error: 'পেমেন্ট মেথড ভুল' });
  if (!(amount >= 10 && amount <= 50000)) return res.status(400).json({ error: 'পরিমাণ ১০ থেকে ৫০,০০০ টাকার মধ্যে দিন' });
  if (!/^[A-Z0-9]{8,12}$/.test(trx)) return res.status(400).json({ error: 'সঠিক TrxID দিন' });
  try {
    const i = db.prepare('INSERT INTO deposits(tg_id,method,amount,trx_id) VALUES(?,?,?,?)').run(String(req.tg.id), method, amount, trx);
    notify(ADMIN_CHAT_ID, `নতুন ডিপোজিট #${i.lastInsertRowid}\n${method} — ${amount}৳\nTrxID: ${trx}\nযাচাই করে অ্যাডমিন প্যানেল থেকে Approve করুন।`);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'এই TrxID আগেই জমা দেওয়া হয়েছে' }); }
});

app.post('/api/orders/balance', needUser, (req, res) => {
  const { uid, packageId } = req.body;
  if (!/^\d{8,12}$/.test(uid || '')) return res.status(400).json({ error: 'সঠিক UID দিন (কমপক্ষে ৮ ডিজিট)' });
  const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND active=1').get(packageId);
  if (!pkg) return res.status(400).json({ error: 'প্যাকেজ পাওয়া যায়নি' });
  const id = String(req.tg.id);
  const orderId = db.transaction(() => {
    const r = db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=? AND balance>=?').run(pkg.price, id, pkg.price);
    if (!r.changes) return null;
    return db.prepare("INSERT INTO orders(tg_id,game_uid,package_id,label,price,status) VALUES(?,?,?,?,?,'paid')")
      .run(id, uid, pkg.id, pkg.label, pkg.price).lastInsertRowid;
  })();
  if (!orderId) return res.status(402).json({ error: 'ব্যালেন্স কম। Add Money করে ব্যালেন্স যোগ করুন।' });
  notify(ADMIN_CHAT_ID, `নতুন পেইড অর্ডার #${orderId}\nUID: ${uid}\n${pkg.label} — ${pkg.price}৳`);
  res.json({ orderId, balance: getBal(id) });
});

app.get('/api/admin/deposits', needAdmin, (_, res) =>
  res.json(db.prepare('SELECT * FROM deposits ORDER BY id DESC LIMIT 200').all()));
app.post('/api/admin/deposits/:id/:act', needAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM deposits WHERE id=?').get(req.params.id);
  if (!d || d.status !== 'pending') return res.status(400).json({ error: 'already processed' });
  if (req.params.act === 'approve') {
    db.transaction(() => {
      db.prepare("UPDATE deposits SET status='approved' WHERE id=?").run(d.id);
      db.prepare('INSERT INTO users(tg_id,balance) VALUES(?,?) ON CONFLICT(tg_id) DO UPDATE SET balance=balance+excluded.balance').run(d.tg_id, d.amount);
    })();
    notify(d.tg_id, `ডিপোজিট অনুমোদিত ✅ ${d.amount}৳ ব্যালেন্সে যোগ হয়েছে।`);
  } else {
    db.prepare("UPDATE deposits SET status='rejected' WHERE id=?").run(d.id);
    notify(d.tg_id, `ডিপোজিট #${d.id} যাচাই করা যায়নি। সমস্যা হলে সাপোর্টে জানান।`);
  }
  res.json({ ok: true });
});

// ---- Bot: webhook for /start ----
app.post('/api/bot', (req, res) => {
  const m = req.body.message;
  if (m && m.text && m.text.startsWith('/start'))
    notify(m.chat.id, 'স্বাগতম! নিচের বাটনে চাপ দিয়ে স্টোর খুলুন।', {
      reply_markup: { inline_keyboard: [[{ text: 'স্টোর খুলুন', web_app: { url: BASE_URL } }]] },
    });
  res.sendStatus(200);
});

app.listen(PORT, () => console.log('running on', PORT));
