const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function startTestServer() {
  const { app, db } = createApp(':memory:');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

async function jsonReq(baseUrl, path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('Full queue lifecycle: self-registration, teacher management, and user queue order', async () => {
  const srv = await startTestServer();
  try {
    // 1. User 1 self-registers
    const reg1 = await jsonReq(srv.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        username: 'student01',
        password: 'pass1234',
        fullName: 'นักเรียน คนที่หนึ่ง',
        studentCode: '66001',
      },
    });
    assert.equal(reg1.status, 201);
    assert.equal(reg1.data.user.role, 'user');
    const user1Token = reg1.data.token;

    // Duplicate username rejected
    const dupReg = await jsonReq(srv.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        username: 'student01',
        password: 'pass1234',
        fullName: 'ซ้ำ',
      },
    });
    assert.equal(dupReg.status, 409);

    // 2. User 2 self-registers
    const reg2 = await jsonReq(srv.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        username: 'student02',
        password: 'pass1234',
        fullName: 'นักเรียน คนที่สอง',
        studentCode: '66002',
      },
    });
    assert.equal(reg2.status, 201);
    const user2Token = reg2.data.token;

    // 3. Normal user cannot call teacher endpoints
    const forbidden = await jsonReq(srv.baseUrl, '/api/teacher/desks/1/call-next', {
      method: 'POST',
      token: user1Token,
    });
    assert.equal(forbidden.status, 403);

    // 4. Both users book tickets on Desk 1 (code A)
    const book1 = await jsonReq(srv.baseUrl, '/api/tickets', {
      method: 'POST',
      token: user1Token,
      body: { deskId: 1, note: 'ส่งการบ้าน' },
    });
    assert.equal(book1.status, 201);
    assert.equal(book1.data.ticket.ticketNumber, 'A001');
    assert.equal(book1.data.ticket.position, 1);
    assert.equal(book1.data.ticket.aheadCount, 0);

    // Prevent duplicate active booking on same desk
    const book1Dup = await jsonReq(srv.baseUrl, '/api/tickets', {
      method: 'POST',
      token: user1Token,
      body: { deskId: 1 },
    });
    assert.equal(book1Dup.status, 409);

    const book2 = await jsonReq(srv.baseUrl, '/api/tickets', {
      method: 'POST',
      token: user2Token,
      body: { deskId: 1, note: 'ปรึกษาโปรเจกต์' },
    });
    assert.equal(book2.status, 201);
    assert.equal(book2.data.ticket.ticketNumber, 'A002');
    assert.equal(book2.data.ticket.position, 2);
    assert.equal(book2.data.ticket.aheadCount, 1);

    // 5. Teacher logs in
    const teacherLogin = await jsonReq(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'teacher1', password: 'teacher123' },
    });
    assert.equal(teacherLogin.status, 200);
    assert.equal(teacherLogin.data.user.role, 'teacher');
    const teacherToken = teacherLogin.data.token;

    // Teacher creates a new teacher account
    const newTeacher = await jsonReq(srv.baseUrl, '/api/teacher/accounts', {
      method: 'POST',
      token: teacherToken,
      body: {
        username: 'teacher3',
        fullName: 'อ.ทดสอบ ใหม่',
        teacherCode: 'T-003',
        password: 'secret123',
      },
    });
    assert.equal(newTeacher.status, 201);
    assert.equal(newTeacher.data.teacher.role, 'teacher');

    // 6. Teacher calls next queue -> A001 is called
    const call1 = await jsonReq(srv.baseUrl, '/api/teacher/desks/1/call-next', {
      method: 'POST',
      token: teacherToken,
    });
    assert.equal(call1.status, 200);
    assert.equal(call1.data.called.ticketNumber, 'A001');

    // Check User 1 & User 2 queue positions now
    const u1Queues = await jsonReq(srv.baseUrl, '/api/queues', { token: user1Token });
    assert.equal(u1Queues.data.myTickets[0].status, 'called');
    assert.equal(u1Queues.data.myTickets[0].position, 0);

    const u2Queues = await jsonReq(srv.baseUrl, '/api/queues', { token: user2Token });
    assert.equal(u2Queues.data.myTickets[0].status, 'waiting');
    assert.equal(u2Queues.data.myTickets[0].position, 1);
    assert.equal(u2Queues.data.myTickets[0].waitingAhead, 0);
    assert.equal(u2Queues.data.myTickets[0].aheadCount, 1);
    assert.equal(u2Queues.data.myTickets[0].currentCalledNumber, 'A001');

    // Teacher recalls A001
    const recall = await jsonReq(srv.baseUrl, '/api/teacher/desks/1/recall', {
      method: 'POST',
      token: teacherToken,
    });
    assert.equal(recall.status, 200);
    assert.equal(recall.data.ticketNumber, 'A001');

    // Teacher calls next -> A001 completed, A002 called
    const call2 = await jsonReq(srv.baseUrl, '/api/teacher/desks/1/call-next', {
      method: 'POST',
      token: teacherToken,
    });
    assert.equal(call2.status, 200);
    assert.equal(call2.data.called.ticketNumber, 'A002');

    // 7. User 1 books on Desk 2 (B001) and cancels it
    const bookB1 = await jsonReq(srv.baseUrl, '/api/tickets', {
      method: 'POST',
      token: user1Token,
      body: { deskId: 2, note: 'ขอยกเลิกทีหลัง' },
    });
    assert.equal(bookB1.status, 201);
    assert.equal(bookB1.data.ticket.ticketNumber, 'B001');

    const cancelB1 = await jsonReq(srv.baseUrl, `/api/tickets/${bookB1.data.ticket.id}/cancel`, {
      method: 'POST',
      token: user1Token,
    });
    assert.equal(cancelB1.status, 200);

    // Check teacher history records A001 completed
    const hist = await jsonReq(srv.baseUrl, '/api/teacher/history', { token: teacherToken });
    assert.equal(hist.status, 200);
    assert.ok(hist.data.history.some((h) => h.ticket_number === 'A001' && h.status === 'completed'));
  } finally {
    await srv.close();
  }
});

test('Frontend static assets and SSE stream respond properly', async () => {
  const srv = await startTestServer();
  try {
    const htmlRes = await fetch(`${srv.baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('EduQueue'));

    const jsRes = await fetch(`${srv.baseUrl}/app.js`);
    assert.equal(jsRes.status, 200);

    const cssRes = await fetch(`${srv.baseUrl}/styles.css`);
    assert.equal(cssRes.status, 200);

    const controller = new AbortController();
    const sseRes = await fetch(`${srv.baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(sseRes.status, 200);
    assert.ok(sseRes.headers.get('content-type').includes('text/event-stream'));
    controller.abort();
  } finally {
    await srv.close();
  }
});
