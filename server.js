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
    remind_at TEXT,                      -- ISO 8601, може бути NULL (нагадування без дати)
    note TEXT DEFAULT '',
    completed INTEGER DEFAULT 0,
    recurrence_type TEXT DEFAULT 'none',  -- none | daily | weekly | monthly | yearly
    recurrence_interval INTEGER DEFAULT 1,
    recurrence_days TEXT DEFAULT '',      -- напр. "mon,wed,fri"
    notified_5min INTEGER DEFAULT 0,
    notified_due INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// На випадок, якщо база вже існувала зі старою схемою — додаємо відсутні колонки
const existingCols = db.prepare("PRAGMA table_info(reminders)").all().map(c => c.name);
function ensureColumn(name, def) {
  if (!existingCols.includes(name)) {
    db.exec(`ALTER TABLE reminders ADD COLUMN ${name} ${def}`);
  }
}
ensureColumn('note', "TEXT DEFAULT ''");
ensureColumn('completed', 'INTEGER DEFAULT 0');
ensureColumn('recurrence_type', "TEXT DEFAULT 'none'");
ensureColumn('recurrence_interval', 'INTEGER DEFAULT 1');
ensureColumn('recurrence_days', "TEXT DEFAULT ''");

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

// --- Розрахунок наступного повторення ---
const DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function addOccurrence(fromDate, type, interval, daysCsv) {
  const d = new Date(fromDate);
  const n = Math.max(1, parseInt(interval, 10) || 1);
  const days = (daysCsv || '').split(',').map(s => s.trim()).filter(Boolean);

  if (type === 'hours') {
    d.setUTCHours(d.getUTCHours() + n);
  } else if (type === 'daily') {
    d.setUTCDate(d.getUTCDate() + n);
  } else if (type === 'weekly') {
    if (days.length) {
      for (let i = 1; i <= 8; i++) {
        const cand = new Date(d);
        cand.setUTCDate(d.getUTCDate() + i);
        if (days.includes(DAY_ORDER[cand.getUTCDay()])) return cand;
      }
      d.setUTCDate(d.getUTCDate() + 7 * n);
    } else {
      d.setUTCDate(d.getUTCDate() + 7 * n);
    }
  } else if (type === 'monthly') {
    d.setUTCMonth(d.getUTCMonth() + n);
  } else if (type === 'yearly') {
    d.setUTCFullYear(d.getUTCFullYear() + n);
  }
  return d;
}

// --- Express ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Отримати всі нагадування
app.get('/api/reminders', (req, res) => {
  const rows = db.prepare('SELECT * FROM reminders ORDER BY (remind_at IS NULL), remind_at ASC').all();
  const mapped = rows.map(r => ({
    ...r,
    completed: !!r.completed,
    recurrence_days: r.recurrence_days ? r.recurrence_days.split(',').filter(Boolean) : []
  }));
  res.json(mapped);
});

// Створити нагадування
app.post('/api/reminders', (req, res) => {
  const { text, remind_at, note, recurrence_type, recurrence_interval, recurrence_days } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Потрібне поле text' });
  }
  let remindIso = null;
  if (remind_at) {
    const d = new Date(remind_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Некоректна дата remind_at' });
    }
    remindIso = d.toISOString();
  }
  const daysCsv = Array.isArray(recurrence_days) ? recurrence_days.join(',') : (recurrence_days || '');
  const stmt = db.prepare(`
    INSERT INTO reminders (text, remind_at, note, recurrence_type, recurrence_interval, recurrence_days)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    text,
    remindIso,
    note || '',
    recurrence_type || 'none',
    recurrence_interval || 1,
    daysCsv
  );
  const created = db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...created, completed: !!created.completed, recurrence_days: created.recurrence_days ? created.recurrence_days.split(',').filter(Boolean) : [] });
});

// Оновити нагадування (редагування, позначення виконаним)
app.patch('/api/reminders/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });

  const fields = [];
  const values = [];

  if (req.body.text !== undefined) { fields.push('text = ?'); values.push(req.body.text); }
  if (req.body.note !== undefined) { fields.push('note = ?'); values.push(req.body.note); }
  if (req.body.completed !== undefined) { fields.push('completed = ?'); values.push(req.body.completed ? 1 : 0); }
  if (req.body.recurrence_type !== undefined) { fields.push('recurrence_type = ?'); values.push(req.body.recurrence_type); }
  if (req.body.recurrence_interval !== undefined) { fields.push('recurrence_interval = ?'); values.push(req.body.recurrence_interval); }
  if (req.body.recurrence_days !== undefined) {
    const daysCsv = Array.isArray(req.body.recurrence_days) ? req.body.recurrence_days.join(',') : req.body.recurrence_days;
    fields.push('recurrence_days = ?'); values.push(daysCsv);
  }
  if (req.body.remind_at !== undefined) {
    let remindIso = null;
    if (req.body.remind_at) {
      const d = new Date(req.body.remind_at);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Некоректна дата remind_at' });
      remindIso = d.toISOString();
    }
    fields.push('remind_at = ?'); values.push(remindIso);
    // якщо час змінили вручну — скидаємо позначки сповіщень
    fields.push('notified_5min = 0');
    fields.push('notified_due = 0');
  }

  if (!fields.length) return res.status(400).json({ error: 'Немає полів для оновлення' });

  values.push(req.params.id);
  db.prepare(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  res.json({ ...updated, completed: !!updated.completed, recurrence_days: updated.recurrence_days ? updated.recurrence_days.split(',').filter(Boolean) : [] });
});

// Видалити ВСІ нагадування (кнопка "Очистити все" в налаштуваннях)
app.delete('/api/reminders', (req, res) => {
  db.prepare('DELETE FROM reminders').run();
  res.status(204).end();
});

// Видалити одне нагадування
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

  // За 5 хв до нагадування
  const upcoming = db.prepare(`
    SELECT * FROM reminders
    WHERE notified_5min = 0
      AND completed = 0
      AND remind_at IS NOT NULL
      AND remind_at <= ?
      AND remind_at >= ?
  `).all(in5min.toISOString(), now.toISOString());

  for (const r of upcoming) {
    const noteSuffix = r.note ? `\nНотатка: ${r.note}` : '';
    await sendTelegramMessage(`⏰ Через 5 хв: ${r.text}${noteSuffix}`);
    db.prepare('UPDATE reminders SET notified_5min = 1 WHERE id = ?').run(r.id);
  }

  // Момент настання нагадування
  const due = db.prepare(`
    SELECT * FROM reminders
    WHERE notified_due = 0
      AND completed = 0
      AND remind_at IS NOT NULL
      AND remind_at <= ?
  `).all(now.toISOString());

  for (const r of due) {
    const noteSuffix = r.note ? `\nНотатка: ${r.note}` : '';
    await sendTelegramMessage(`🔔 Зараз: ${r.text}${noteSuffix}`);
    if (r.recurrence_type && r.recurrence_type !== 'none') {
      const next = addOccurrence(r.remind_at, r.recurrence_type, r.recurrence_interval, r.recurrence_days);
      db.prepare(`
        UPDATE reminders
        SET remind_at = ?, notified_5min = 0, notified_due = 0
        WHERE id = ?
      `).run(next.toISOString(), r.id);
    } else {
      db.prepare('UPDATE reminders SET notified_due = 1 WHERE id = ?').run(r.id);
    }
  }
});
