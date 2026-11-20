const path = require('node:path');
const express = require('express');
const { initDatabase, formatTicketNumber, getQueueOverview, getUserTickets } = require('./db');
const {
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  extractToken,
} = require('./auth');

function createApp(dbPath) {
  const db = initDatabase(dbPath);
  const app = express();
  const sseClients = new Set();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  /**
   * Broadcast an SSE event to all connected clients.
   */
  function broadcast(eventName, payload = {}) {
    const data = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(message);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  /**
   * Attach req.user if a valid session cookie or bearer token is present.
   */
  app.use((req, _res, next) => {
    const token = extractToken(req);
    req.sessionToken = token;
    req.user = getSessionUser(db, token);
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ' });
    }
    next();
  }

  function requireTeacher(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ' });
    }
    if (req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'สิทธิ์เฉพาะบัญชีคุณครูเท่านั้น' });
    }
    next();
  }

  // ==================== AUTH ROUTES ====================

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user || null });
  });

  app.post('/api/auth/register', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim();
    const studentCode = String(req.body?.studentCode || '').trim();

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      return res.status(400).json({
        error: 'ชื่อผู้ใช้ต้องมีความยาว 3-32 ตัวอักษร (ใช้ได้เฉพาะ a-z, 0-9, ., _, -)',
      });
    }
    if (fullName.length < 2) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อ-นามสกุลให้ถูกต้อง' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว กรุณาใช้ชื่ออื่น' });
    }

    const passwordHash = hashPassword(password);
    // Self-registration always creates a standard 'user' role.
    const result = db
      .prepare(
        "INSERT INTO users (username, full_name, student_code, role, password_hash) VALUES (?, ?, ?, 'user', ?)"
      )
      .run(username, fullName, studentCode, passwordHash);

    const userId = Number(result.lastInsertRowid);
    const { token } = createSession(db, userId);
    setSessionCookie(res, token);

    const user = {
      id: userId,
      username,
      fullName,
      studentCode,
      role: 'user',
    };

    res.status(201).json({ user, token });
  });

  app.post('/api/auth/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    const row = db
      .prepare(
        'SELECT id, username, full_name, student_code, role, password_hash FROM users WHERE username = ?'
      )
      .get(username);

    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }

    const { token } = createSession(db, row.id);
    setSessionCookie(res, token);

    res.json({
      user: {
        id: row.id,
        username: row.username,
        fullName: row.full_name,
        studentCode: row.student_code,
        role: row.role,
      },
      token,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ==================== REAL-TIME SSE ====================

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // ==================== QUEUE OVERVIEW & USER TICKETS ====================

  app.get('/api/queues', (req, res) => {
    const userId = req.user ? req.user.id : null;
    const isTeacher = req.user?.role === 'teacher';
    const rawDesks = getQueueOverview(db, userId);

    // Mask other users' personal names on non-teacher responses while keeping full order visibility.
    const desks = rawDesks.map((desk) => ({
      ...desk,
      currentCalled: desk.currentCalled
        ? {
            id: desk.currentCalled.id,
            deskId: desk.currentCalled.deskId,
            ticketNumber: desk.currentCalled.ticketNumber,
            recallCount: desk.currentCalled.recallCount,
            calledAt: desk.currentCalled.calledAt,
            isMine: desk.currentCalled.isMine,
            ...(isTeacher || desk.currentCalled.isMine
              ? {
                  note: desk.currentCalled.note,
                  userName: desk.currentCalled.userName,
                  studentCode: desk.currentCalled.studentCode,
                }
              : {}),
          }
        : null,
      waitingQueue: desk.waitingQueue.map((item) => ({
        id: item.id,
        deskId: item.deskId,
        ticketNumber: item.ticketNumber,
        seqNum: item.seqNum,
        status: item.status,
        createdAt: item.createdAt,
        position: item.position,
        aheadCount: item.aheadCount,
        waitingAhead: item.waitingAhead,
        isMine: item.isMine,
        ...(isTeacher || item.isMine
          ? {
              note: item.note,
              userName: item.userName,
              studentCode: item.studentCode,
            }
          : {}),
      })),
    }));

    const myTickets = req.user ? getUserTickets(db, req.user.id) : [];
    res.json({ desks, myTickets });
  });

  app.post('/api/tickets', requireAuth, (req, res) => {
    const deskId = Number(req.body?.deskId);
    const note = String(req.body?.note || '').trim().slice(0, 200);

    if (!Number.isInteger(deskId) || deskId <= 0) {
      return res.status(400).json({ error: 'กรุณาเลือกจุดบริการ / คุณครู' });
    }

    try {
      db.exec('BEGIN IMMEDIATE');
      const desk = db
        .prepare('SELECT id, code, name, teacher_name, is_open, next_seq FROM service_desks WHERE id = ?')
        .get(deskId);

      if (!desk) {
        db.exec('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบจุดบริการที่เลือก' });
      }
      if (!desk.is_open) {
        db.exec('ROLLBACK');
        return res.status(400).json({ error: 'จุดบริการนี้ปิดรับคิวชั่วคราว' });
      }

      const activeExisting = db
        .prepare(
          "SELECT id, ticket_number FROM tickets WHERE desk_id = ? AND user_id = ? AND status IN ('waiting', 'called')"
        )
        .get(deskId, req.user.id);

      if (activeExisting) {
        db.exec('ROLLBACK');
        return res.status(409).json({
          error: `คุณมีคิวที่จุดบริการนี้อยู่แล้ว (${activeExisting.ticket_number})`,
        });
      }

      const seqNum = desk.next_seq;
      const ticketNumber = formatTicketNumber(desk.code, seqNum);

      db.prepare('UPDATE service_desks SET next_seq = next_seq + 1 WHERE id = ?').run(deskId);
      const insert = db
        .prepare(
          "INSERT INTO tickets (desk_id, user_id, ticket_number, seq_num, note, status) VALUES (?, ?, ?, ?, ?, 'waiting')"
        )
        .run(deskId, req.user.id, ticketNumber, seqNum, note);

      db.exec('COMMIT');

      const ticketId = Number(insert.lastInsertRowid);
      broadcast('queue_update', { action: 'ticket_created', deskId, ticketId, ticketNumber });

      const myTickets = getUserTickets(db, req.user.id);
      const created = myTickets.find((t) => t.id === ticketId);
      res.status(201).json({ ticket: created });
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    }
  });

  app.post('/api/tickets/:id/cancel', requireAuth, (req, res) => {
    const ticketId = Number(req.params.id);
    const ticket = db.prepare('SELECT id, desk_id, user_id, status, ticket_number FROM tickets WHERE id = ?').get(ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'ไม่พบบัตรคิวนี้' });
    }
    if (ticket.user_id !== req.user.id && req.user.role !== 'teacher') {
      return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ยกเลิกคิวนี้' });
    }
    if (ticket.status !== 'waiting') {
      return res.status(400).json({ error: 'สามารถยกเลิกได้เฉพาะคิวที่กำลังรอเรียกเท่านั้น' });
    }

    db.prepare(
      "UPDATE tickets SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?"
    ).run(ticketId);

    broadcast('queue_update', {
      action: 'ticket_cancelled',
      deskId: ticket.desk_id,
      ticketId,
      ticketNumber: ticket.ticket_number,
    });

    res.json({ ok: true });
  });

  // ==================== TEACHER ROUTES ====================

  app.get('/api/teacher/history', requireTeacher, (req, res) => {
    const deskId = req.query.deskId ? Number(req.query.deskId) : null;
    const params = [];
    let whereClause = "WHERE t.status IN ('completed', 'skipped', 'cancelled')";
    if (deskId) {
      whereClause += ' AND t.desk_id = ?';
      params.push(deskId);
    }

    const history = db
      .prepare(
        `SELECT t.id, t.desk_id, t.ticket_number, t.note, t.status, t.created_at, t.called_at, t.finished_at,
                d.code AS desk_code, d.name AS desk_name,
                u.full_name AS user_name, u.student_code AS student_code
         FROM tickets t
         JOIN service_desks d ON d.id = t.desk_id
         JOIN users u ON u.id = t.user_id
         ${whereClause}
         ORDER BY t.id DESC
         LIMIT 50`
      )
      .all(...params);

    const teachers = db
      .prepare("SELECT id, username, full_name, student_code, created_at FROM users WHERE role = 'teacher' ORDER BY id ASC")
      .all()
      .map((t) => ({
        id: t.id,
        username: t.username,
        fullName: t.full_name,
        teacherCode: t.student_code,
        createdAt: t.created_at,
      }));

    res.json({ history, teachers });
  });

  app.post('/api/teacher/desks/:deskId/call-next', requireTeacher, (req, res) => {
    const deskId = Number(req.params.deskId);
    const finishStatus = req.body?.skipCurrent ? 'skipped' : 'completed';

    try {
      db.exec('BEGIN IMMEDIATE');
      const desk = db
        .prepare('SELECT id, code, name, teacher_name FROM service_desks WHERE id = ?')
        .get(deskId);

      if (!desk) {
        db.exec('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบจุดบริการ' });
      }

      // Close out any existing called ticket on this desk before calling the next one.
      db.prepare(
        `UPDATE tickets
         SET status = ?, finished_at = datetime('now')
         WHERE desk_id = ? AND status = 'called'`
      ).run(finishStatus, deskId);

      const nextTicket = db
        .prepare(
          `SELECT t.id, t.user_id, t.ticket_number, t.note, u.full_name AS user_name
           FROM tickets t
           JOIN users u ON u.id = t.user_id
           WHERE t.desk_id = ? AND t.status = 'waiting'
           ORDER BY t.seq_num ASC, t.id ASC
           LIMIT 1`
        )
        .get(deskId);

      if (!nextTicket) {
        db.exec('COMMIT');
        broadcast('queue_update', { action: 'desk_cleared_current', deskId });
        return res.json({ called: null, message: 'ไม่มีคิวที่กำลังรอในขณะนี้' });
      }

      db.prepare(
        "UPDATE tickets SET status = 'called', called_at = datetime('now'), recall_count = 1 WHERE id = ?"
      ).run(nextTicket.id);

      db.exec('COMMIT');

      broadcast('queue_called', {
        deskId,
        deskCode: desk.code,
        deskName: desk.name,
        teacherName: desk.teacher_name,
        ticketId: nextTicket.id,
        ticketNumber: nextTicket.ticket_number,
        userId: nextTicket.user_id,
        userName: nextTicket.user_name,
        isRecall: false,
      });

      res.json({
        called: {
          id: nextTicket.id,
          ticketNumber: nextTicket.ticket_number,
          userName: nextTicket.user_name,
          note: nextTicket.note,
        },
      });
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  });

  app.post('/api/teacher/desks/:deskId/recall', requireTeacher, (req, res) => {
    const deskId = Number(req.params.deskId);
    const desk = db
      .prepare('SELECT id, code, name, teacher_name FROM service_desks WHERE id = ?')
      .get(deskId);

    if (!desk) {
      return res.status(404).json({ error: 'ไม่พบจุดบริการ' });
    }

    const current = db
      .prepare(
        `SELECT t.id, t.user_id, t.ticket_number, u.full_name AS user_name
         FROM tickets t
         JOIN users u ON u.id = t.user_id
         WHERE t.desk_id = ? AND t.status = 'called'
         LIMIT 1`
      )
      .get(deskId);

    if (!current) {
      return res.status(400).json({ error: 'ยังไม่มีคิวที่กำลังเรียกอยู่ในขณะนี้' });
    }

    db.prepare('UPDATE tickets SET recall_count = recall_count + 1 WHERE id = ?').run(current.id);

    broadcast('queue_called', {
      deskId,
      deskCode: desk.code,
      deskName: desk.name,
      teacherName: desk.teacher_name,
      ticketId: current.id,
      ticketNumber: current.ticket_number,
      userId: current.user_id,
      userName: current.user_name,
      isRecall: true,
    });

    res.json({ ok: true, ticketNumber: current.ticket_number });
  });

  app.post('/api/teacher/tickets/:id/complete', requireTeacher, (req, res) => {
    const ticketId = Number(req.params.id);
    const ticket = db.prepare('SELECT id, desk_id, status FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) return res.status(404).json({ error: 'ไม่พบบัตรคิว' });
    if (ticket.status !== 'called') {
      return res.status(400).json({ error: 'คิวนี้ไม่ได้อยู่ในสถานะกำลังเรียก' });
    }

    db.prepare("UPDATE tickets SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(
      ticketId
    );
    broadcast('queue_update', { action: 'ticket_completed', deskId: ticket.desk_id, ticketId });
    res.json({ ok: true });
  });

  app.post('/api/teacher/tickets/:id/skip', requireTeacher, (req, res) => {
    const ticketId = Number(req.params.id);
    const ticket = db.prepare('SELECT id, desk_id, status FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) return res.status(404).json({ error: 'ไม่พบบัตรคิว' });
    if (!['called', 'waiting'].includes(ticket.status)) {
      return res.status(400).json({ error: 'ไม่สามารถข้ามคิวที่เสร็จสิ้นแล้วได้' });
    }

    db.prepare("UPDATE tickets SET status = 'skipped', finished_at = datetime('now') WHERE id = ?").run(
      ticketId
    );
    broadcast('queue_update', { action: 'ticket_skipped', deskId: ticket.desk_id, ticketId });
    res.json({ ok: true });
  });

  app.post('/api/teacher/desks/:deskId/toggle', requireTeacher, (req, res) => {
    const deskId = Number(req.params.deskId);
    const desk = db.prepare('SELECT id, is_open FROM service_desks WHERE id = ?').get(deskId);
    if (!desk) return res.status(404).json({ error: 'ไม่พบจุดบริการ' });

    const nextOpen = desk.is_open ? 0 : 1;
    db.prepare('UPDATE service_desks SET is_open = ? WHERE id = ?').run(nextOpen, deskId);
    broadcast('queue_update', { action: 'desk_toggled', deskId, isOpen: Boolean(nextOpen) });
    res.json({ ok: true, isOpen: Boolean(nextOpen) });
  });

  app.post('/api/teacher/desks/:deskId/reset', requireTeacher, (req, res) => {
    const deskId = Number(req.params.deskId);
    const desk = db.prepare('SELECT id FROM service_desks WHERE id = ?').get(deskId);
    if (!desk) return res.status(404).json({ error: 'ไม่พบจุดบริการ' });

    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      "UPDATE tickets SET status = 'cancelled', finished_at = datetime('now') WHERE desk_id = ? AND status IN ('waiting', 'called')"
    ).run(deskId);
    db.prepare('UPDATE service_desks SET next_seq = 1 WHERE id = ?').run(deskId);
    db.exec('COMMIT');

    broadcast('queue_update', { action: 'desk_reset', deskId });
    res.json({ ok: true });
  });

  app.post('/api/teacher/desks', requireTeacher, (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    const teacherName = String(req.body?.teacherName || req.user.fullName).trim();

    if (!/^[A-Z0-9]{1,3}$/.test(code)) {
      return res.status(400).json({ error: 'รหัสจุดบริการต้องเป็นตัวอักษรภาษาอังกฤษหรือตัวเลข 1-3 ตัว (เช่น D)' });
    }
    if (name.length < 2) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อจุดบริการ' });
    }

    const exists = db.prepare('SELECT id FROM service_desks WHERE code = ?').get(code);
    if (exists) {
      return res.status(409).json({ error: `รหัสจุดบริการ ${code} มีอยู่แล้ว` });
    }

    const insert = db
      .prepare(
        'INSERT INTO service_desks (code, name, description, teacher_id, teacher_name, is_open) VALUES (?, ?, ?, ?, ?, 1)'
      )
      .run(code, name, description, req.user.id, teacherName);

    broadcast('queue_update', { action: 'desk_created', deskId: Number(insert.lastInsertRowid) });
    res.status(201).json({ id: Number(insert.lastInsertRowid), code, name, teacherName });
  });

  app.post('/api/teacher/accounts', requireTeacher, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const fullName = String(req.body?.fullName || '').trim();
    const password = String(req.body?.password || '');
    const teacherCode = String(req.body?.teacherCode || '').trim();

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องมีความยาว 3-32 ตัวอักษร (a-z, 0-9, ., _, -)' });
    }
    if (fullName.length < 2) {
      return res.status(400).json({ error: 'กรุณากรอกชื่อ-นามสกุลคุณครู' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
    }

    const result = db
      .prepare(
        "INSERT INTO users (username, full_name, student_code, role, password_hash) VALUES (?, ?, ?, 'teacher', ?)"
      )
      .run(username, fullName, teacherCode, hashPassword(password));

    res.status(201).json({
      teacher: {
        id: Number(result.lastInsertRowid),
        username,
        fullName,
        teacherCode,
        role: 'teacher',
      },
    });
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
  });

  return { app, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { app } = createApp();
  app.listen(port, () => {
    console.log(`EduQueue server running at http://localhost:${port}`);
  });
}

module.exports = { createApp };
