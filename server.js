require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- База даних ---
const db = new Database(path.join(__dirname, 'reminders.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    remind_at TEXT NOT NULL,      -- ISO 8601, напр. 2026-09-15T18:30:00.000Z
    notified_5min INTEGER DEFAULT 0,
    notified_due INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// --- Telegram ---
async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID не налаштовані — повідомлення не надіслано.');
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
    if (!res.ok) {
      console.error('Telegram API помилка:', await res.text());
    }
  } catch (err) {
    console.error('Не вдалося надіслати повідомлення в Telegram:', err.message);
  }
}

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Отримати всі нагадування (спочатку найближчі)
app.get('/api/reminders', (req, res) => {
  const rows = db.prepare('SELECT * FROM reminders ORDER BY remind_at ASC').all();
  res.json(rows);
});

// Створити нагадування
app.post('/api/reminders', (req, res) => {
  const { text, remind_at } = req.body;
  if (!text || !remind_at) {
    return res.status(400).json({ error: 'Потрібні поля text і remind_at' });
  }
  const remindDate = new Date(remind_at);
  if (isNaN(remindDate.getTime())) {
    return res.status(400).json({ error: 'Некоректна дата remind_at' });
  }
  const stmt = db.prepare('INSERT INTO reminders (text, remind_at) VALUES (?, ?)');
  const info = stmt.run(text, remindDate.toISOString());
  const created = db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

// Видалити нагадування
app.delete('/api/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Сервер запущено: http://localhost:${PORT}`);
});

// --- Перевірка нагадувань кожну хвилину ---
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const in5min = new Date(now.getTime() + 5 * 60 * 1000);

  // Нагадування, до яких залишилось <= 5 хв, і ще не сповіщені за 5 хв
  const upcoming = db.prepare(`
    SELECT * FROM reminders
    WHERE notified_5min = 0
      AND remind_at <= ?
      AND remind_at >= ?
  `).all(in5min.toISOString(), now.toISOString());

  for (const r of upcoming) {
    await sendTelegramMessage(`⏰ Через 5 хв: ${r.text}`);
    db.prepare('UPDATE reminders SET notified_5min = 1 WHERE id = ?').run(r.id);
  }

  // Нагадування, час яких вже настав, і ще не сповіщені про сам момент
  const due = db.prepare(`
    SELECT * FROM reminders
    WHERE notified_due = 0
      AND remind_at <= ?
  `).all(now.toISOString());

  for (const r of due) {
    await sendTelegramMessage(`🔔 Зараз: ${r.text}`);
    db.prepare('UPDATE reminders SET notified_due = 1 WHERE id = ?').run(r.id);
  }
});
