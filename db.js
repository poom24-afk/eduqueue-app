const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

/**
 * Initialize SQLite database, schema, and seed data (teachers and default desks).
 */
function initDatabase(dbPath = path.join(__dirname, 'data', 'queue.db')) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      student_code TEXT DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('user', 'teacher')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_desks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      teacher_name TEXT NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      desk_id INTEGER NOT NULL REFERENCES service_desks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_number TEXT NOT NULL,
      seq_num INTEGER NOT NULL,
      note TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('waiting', 'called', 'completed', 'skipped', 'cancelled')),
      recall_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      called_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_desk_status ON tickets(desk_id, status, seq_num);
    CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets(user_id, status);
  `);

  seedDefaults(db);
  return db;
}

/**
 * Seed initial teacher accounts and service desks if the database is empty.
 */
function seedDefaults(db) {
  const teacherCount = db
    .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'teacher'")
    .get().cnt;

  if (teacherCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (username, full_name, student_code, role, password_hash) VALUES (?, ?, ?, ?, ?)'
    );
    const t1 = insertUser.run(
      'teacher1',
      'อ.สมชาย ใจดี',
      'T-001',
      'teacher',
      hashPassword('teacher123')
    );
    const t2 = insertUser.run(
      'teacher2',
      'อ.วิภาวรรณ รักเรียน',
      'T-002',
      'teacher',
      hashPassword('teacher123')
    );

    const deskCount = db.prepare('SELECT COUNT(*) AS cnt FROM service_desks').get().cnt;
    if (deskCount === 0) {
      const insertDesk = db.prepare(
        'INSERT INTO service_desks (code, name, description, teacher_id, teacher_name, is_open) VALUES (?, ?, ?, ?, ?, 1)'
      );
      insertDesk.run(
        'A',
        'ปรึกษาการเรียน / ครูที่ปรึกษา',
        'พูดคุยแนะแนวการเรียน ลงทะเบียน และคำปรึกษาทั่วไป',
        t1.lastInsertRowid,
        'อ.สมชาย ใจดี'
      );
      insertDesk.run(
        'B',
        'ตรวจงาน / ส่งโปรเจกต์',
        'ตรวจชิ้นงาน แก้ไขงาน และรับคะแนนเก็บรายวิชา',
        t2.lastInsertRowid,
        'อ.วิภาวรรณ รักเรียน'
      );
      insertDesk.run(
        'C',
        'ขอเอกสาร / สอบถามทะเบียน',
        'ออกใบรับรอง แก้ไขข้อมูล และยื่นคำร้อง',
        t1.lastInsertRowid,
        'อ.สมชาย ใจดี'
      );
    }
  }
}

/**
 * Format sequence number as zero-padded ticket string (e.g., A001).
 */
function formatTicketNumber(code, seq) {
  return `${code}${String(seq).padStart(3, '0')}`;
}

/**
 * Compute full queue state for all desks, optionally enriched with a user's ticket positions.
 */
function getQueueOverview(db, currentUserId = null) {
  const desks = db
    .prepare(
      `SELECT d.id, d.code, d.name, d.description, d.teacher_id, d.teacher_name, d.is_open, d.next_seq
       FROM service_desks d
       ORDER BY d.code ASC, d.id ASC`
    )
    .all();

  const activeTickets = db
    .prepare(
      `SELECT t.id, t.desk_id, t.user_id, t.ticket_number, t.seq_num, t.note, t.status,
              t.recall_count, t.created_at, t.called_at,
              u.full_name AS user_name, u.student_code AS student_code, u.username AS username
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.status IN ('waiting', 'called')
       ORDER BY t.seq_num ASC, t.id ASC`
    )
    .all();

  const deskSummaries = desks.map((desk) => {
    const deskTickets = activeTickets.filter((t) => t.desk_id === desk.id);
    const currentCalled = deskTickets.find((t) => t.status === 'called') || null;
    const waitingList = deskTickets.filter((t) => t.status === 'waiting');

    const queueOrder = waitingList.map((t, index) => ({
      id: t.id,
      deskId: t.desk_id,
      ticketNumber: t.ticket_number,
      seqNum: t.seq_num,
      status: t.status,
      note: t.note,
      createdAt: t.created_at,
      position: index + 1,
      aheadCount: index + (currentCalled ? 1 : 0),
      waitingAhead: index,
      isMine: currentUserId ? t.user_id === currentUserId : false,
      userName: t.user_name,
      studentCode: t.student_code,
    }));

    return {
      id: desk.id,
      code: desk.code,
      name: desk.name,
      description: desk.description,
      teacherId: desk.teacher_id,
      teacherName: desk.teacher_name,
      isOpen: Boolean(desk.is_open),
      waitingCount: waitingList.length,
      currentCalled: currentCalled
        ? {
            id: currentCalled.id,
            deskId: currentCalled.desk_id,
            ticketNumber: currentCalled.ticket_number,
            note: currentCalled.note,
            recallCount: currentCalled.recall_count,
            calledAt: currentCalled.called_at,
            isMine: currentUserId ? currentCalled.user_id === currentUserId : false,
            userName: currentCalled.user_name,
            studentCode: currentCalled.student_code,
          }
        : null,
      waitingQueue: queueOrder,
    };
  });

  return deskSummaries;
}

/**
 * Get the current user's active & recent tickets with live queue position details.
 */
function getUserTickets(db, userId) {
  const desksOverview = getQueueOverview(db, userId);
  const deskMap = new Map(desksOverview.map((d) => [d.id, d]));

  const rows = db
    .prepare(
      `SELECT t.id, t.desk_id, t.ticket_number, t.seq_num, t.note, t.status,
              t.recall_count, t.created_at, t.called_at, t.finished_at,
              d.code AS desk_code, d.name AS desk_name, d.teacher_name AS teacher_name
       FROM tickets t
       JOIN service_desks d ON d.id = t.desk_id
       WHERE t.user_id = ?
       ORDER BY
         CASE t.status
           WHEN 'called' THEN 0
           WHEN 'waiting' THEN 1
           ELSE 2
         END,
         t.id DESC
       LIMIT 25`
    )
    .all(userId);

  return rows.map((row) => {
    const desk = deskMap.get(row.desk_id);
    let position = null;
    let waitingAhead = null;
    let aheadCount = null;
    let waitingTotal = desk ? desk.waitingCount : 0;
    let currentCalledNumber = desk?.currentCalled?.ticketNumber || null;

    if (row.status === 'waiting' && desk) {
      const match = desk.waitingQueue.find((w) => w.id === row.id);
      if (match) {
        position = match.position;
        waitingAhead = match.waitingAhead;
        aheadCount = match.aheadCount;
      }
    } else if (row.status === 'called') {
      position = 0;
      waitingAhead = 0;
      aheadCount = 0;
    }

    return {
      id: row.id,
      deskId: row.desk_id,
      deskCode: row.desk_code,
      deskName: row.desk_name,
      teacherName: row.teacher_name,
      ticketNumber: row.ticket_number,
      seqNum: row.seq_num,
      note: row.note,
      status: row.status,
      recallCount: row.recall_count,
      createdAt: row.created_at,
      calledAt: row.called_at,
      finishedAt: row.finished_at,
      position,
      waitingAhead,
      aheadCount,
      waitingTotal,
      currentCalledNumber,
    };
  });
}

module.exports = {
  initDatabase,
  formatTicketNumber,
  getQueueOverview,
  getUserTickets,
};
