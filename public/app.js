const state = {
  user: null,
  desks: [],
  myTickets: [],
  teacherHistory: [],
  teachers: [],
  selectedDeskId: null,
  activeView: 'auth', // 'auth' | 'user' | 'teacher' | 'display'
  teacherTab: 'console', // 'console' | 'manage'
  eventSource: null,
  lastAnnouncement: null,
};

const STATUS_LABELS = {
  waiting: { text: 'รอเรียกคิว', cls: 'pill-warning' },
  called: { text: 'กำลังเรียกคิว!', cls: 'pill-success' },
  completed: { text: 'เสร็จสิ้น', cls: 'pill-primary' },
  skipped: { text: 'ข้ามคิว', cls: 'pill-danger' },
  cancelled: { text: 'ยกเลิกแล้ว', cls: 'pill-muted' },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(isoOrSqlite) {
  if (!isoOrSqlite) return '-';
  const normalized = isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite.replace(' ', 'T') + 'Z';
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return isoOrSqlite;
  return dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
  }
  return data;
}

/**
 * Play a pleasant 2-tone chime using Web Audio API and optional Thai TTS announcement.
 */
function playQueueAlert(ticketNumber, deskName, speak = true) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration);
      };

      playTone(659.25, now, 0.28); // E5
      playTone(880, now + 0.22, 0.45); // A5
    }
  } catch {
    // Ignore audio context restrictions if user hasn't interacted yet
  }

  if (speak && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const spokenCode = String(ticketNumber).split('').join(' ');
      const utter = new SpeechSynthesisUtterance(
        `ขอเชิญหมายเลขคิว ${spokenCode} ที่ ${deskName}`
      );
      utter.lang = 'th-TH';
      utter.rate = 0.95;
      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore TTS errors
    }
  }
}

function connectSSE() {
  if (state.eventSource) {
    state.eventSource.close();
  }
  const es = new EventSource('/api/events');

  es.addEventListener('queue_update', () => {
    refreshQueues();
  });

  es.addEventListener('queue_called', (e) => {
    const payload = JSON.parse(e.data || '{}');
    state.lastAnnouncement = payload;
    refreshQueues();

    const isMyTurn = state.user && payload.userId === state.user.id;
    const userSoundOn = document.getElementById('user-sound-toggle')?.checked;
    const displaySoundOn = document.getElementById('display-sound-toggle')?.checked;

    if (isMyTurn) {
      showToast(`ถึงคิวของคุณแล้ว! (${payload.ticketNumber} - ${payload.deskName})`, 'success');
      if (userSoundOn) {
        playQueueAlert(payload.ticketNumber, payload.deskName, true);
      }
    } else if (state.activeView === 'display' && displaySoundOn) {
      playQueueAlert(payload.ticketNumber, payload.deskName, true);
    }
  });

  state.eventSource = es;
}

async function refreshSessionAndData() {
  const { user } = await api('/api/auth/me');
  state.user = user;
  if (!user) {
    if (state.activeView !== 'display') {
      state.activeView = 'auth';
    }
  } else if (state.activeView === 'auth') {
    state.activeView = user.role === 'teacher' ? 'teacher' : 'user';
  }
  await refreshQueues();
}

async function refreshQueues() {
  const data = await api('/api/queues');
  state.desks = data.desks || [];
  state.myTickets = data.myTickets || [];

  if (!state.selectedDeskId && state.desks.length > 0) {
    state.selectedDeskId = state.desks[0].id;
  } else if (
    state.selectedDeskId &&
    !state.desks.some((d) => d.id === state.selectedDeskId) &&
    state.desks.length > 0
  ) {
    state.selectedDeskId = state.desks[0].id;
  }

  if (state.user?.role === 'teacher') {
    const hist = await api('/api/teacher/history');
    state.teacherHistory = hist.history || [];
    state.teachers = hist.teachers || [];
  } else {
    state.teacherHistory = [];
    state.teachers = [];
  }

  render();
}

function setView(viewName) {
  state.activeView = viewName;
  render();
}

function renderNav() {
  const nav = document.getElementById('nav-actions');
  const buttons = [];

  if (state.user) {
    const roleLabel = state.user.role === 'teacher' ? 'คุณครู' : 'ผู้ใช้งาน';
    buttons.push(`
      <div class="user-pill">
        <span class="role-badge ${state.user.role}">${roleLabel}</span>
        <span>${escapeHtml(state.user.fullName)}</span>
      </div>
    `);

    if (state.user.role === 'teacher') {
      buttons.push(`
        <button type="button" class="btn btn-outline ${state.activeView === 'teacher' ? 'active' : ''}" data-nav="teacher">
          หน้าคุณครู
        </button>
      `);
    } else {
      buttons.push(`
        <button type="button" class="btn btn-outline ${state.activeView === 'user' ? 'active' : ''}" data-nav="user">
          คิวของฉัน
        </button>
      `);
    }

    buttons.push(`
      <button type="button" class="btn btn-outline ${state.activeView === 'display' ? 'active' : ''}" data-nav="display">
        จอแสดงคิวรวม
      </button>
      <button type="button" class="btn btn-danger btn-sm" id="btn-logout">ออกจากระบบ</button>
    `);
  } else {
    buttons.push(`
      <button type="button" class="btn btn-outline ${state.activeView === 'auth' ? 'active' : ''}" data-nav="auth">
        เข้าสู่ระบบ / สมัครสมาชิก
      </button>
      <button type="button" class="btn btn-outline ${state.activeView === 'display' ? 'active' : ''}" data-nav="display">
        จอแสดงคิวรวม
      </button>
    `);
  }

  nav.innerHTML = buttons.join('');
}

function renderUserView() {
  const activeContainer = document.getElementById('user-active-section');
  const activeTickets = state.myTickets.filter((t) => ['waiting', 'called'].includes(t.status));

  if (activeTickets.length === 0) {
    activeContainer.innerHTML = `
      <div class="empty-ticket-box">
        <strong>คุณยังไม่มีคิวที่กำลังรออยู่</strong>
        <p class="muted" style="margin-top:6px;">เลือกจุดบริการด้านล่างเพื่อรับบัตรคิวได้เลย</p>
      </div>
    `;
  } else {
    activeContainer.innerHTML = activeTickets
      .map((t) => {
        const isCalled = t.status === 'called';
        const statusInfo = STATUS_LABELS[t.status] || STATUS_LABELS.waiting;
        const posText = isCalled ? 'ถึงคิวแล้ว' : `ลำดับที่ ${t.position}`;
        const aheadText = isCalled ? '0 คิว' : `${t.aheadCount} คิว`;
        const currentNow = t.currentCalledNumber || '-';

        return `
          <div class="my-ticket-card ${isCalled ? 'is-called' : ''}">
            <div class="ticket-hero-row">
              <div>
                <div class="muted">${escapeHtml(t.deskName)}</div>
                <div style="font-size:13px;font-weight:600;margin-top:2px;">${escapeHtml(t.teacherName)}</div>
              </div>
              <span class="pill ${statusInfo.cls}">${statusInfo.text}</span>
            </div>

            <div class="ticket-hero-row" style="margin-bottom:0;">
              <div>
                <div class="muted" style="font-size:12px;">หมายเลขบัตรคิวของคุณ</div>
                <div class="ticket-big-num">${escapeHtml(t.ticketNumber)}</div>
              </div>
              ${
                t.status === 'waiting'
                  ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-ticket="${t.id}">ยกเลิกคิว</button>`
                  : ''
              }
            </div>

            ${
              t.note
                ? `<div class="muted" style="margin-top:8px;">เรื่องที่ติดต่อ: <strong>${escapeHtml(t.note)}</strong></div>`
                : ''
            }

            ${
              isCalled
                ? `<div class="called-banner">🎉 ถึงคิวของคุณแล้ว! กรุณาเข้าพบ ${escapeHtml(t.teacherName)}</div>`
                : `
                <div class="queue-position-box">
                  <div>
                    <div class="pos-stat-label">ลำดับในแถวรอ</div>
                    <div class="pos-stat-val" style="color:var(--primary);">${posText}</div>
                  </div>
                  <div>
                    <div class="pos-stat-label">คิวก่อนหน้าคุณ</div>
                    <div class="pos-stat-val">${aheadText}</div>
                  </div>
                  <div>
                    <div class="pos-stat-label">คิวที่เรียกตอนนี้</div>
                    <div class="pos-stat-val" style="color:var(--success);">${escapeHtml(currentNow)}</div>
                  </div>
                </div>
              `
            }
          </div>
        `;
      })
      .join('');
  }

  // Service desks for booking
  const desksGrid = document.getElementById('user-desks-grid');
  desksGrid.innerHTML = state.desks
    .map((d) => {
      const alreadyHasActive = activeTickets.some((t) => t.deskId === d.id);
      const statusBadge = d.isOpen
        ? '<span class="pill pill-success">เปิดรับคิว</span>'
        : '<span class="pill pill-danger">ปิดรับชั่วคราว</span>';

      return `
        <div class="desk-card">
          <div>
            <div class="desk-head">
              <div style="display:flex;gap:10px;align-items:center;">
                <div class="desk-code-badge">${escapeHtml(d.code)}</div>
                <div>
                  <div style="font-weight:700;">${escapeHtml(d.name)}</div>
                  <div class="muted" style="font-size:13px;">${escapeHtml(d.teacherName)}</div>
                </div>
              </div>
              ${statusBadge}
            </div>
            ${d.description ? `<p class="muted" style="margin-top:10px;font-size:13px;">${escapeHtml(d.description)}</p>` : ''}
          </div>

          <div class="desk-meta">
            <span>กำลังเรียก: <strong>${escapeHtml(d.currentCalled?.ticketNumber || '-')}</strong></span>
            <span>รอคิว: <strong>${d.waitingCount} คิว</strong></span>
          </div>

          <button
            type="button"
            class="btn btn-primary"
            data-book-desk="${d.id}"
            ${!d.isOpen || alreadyHasActive ? 'disabled' : ''}
          >
            ${alreadyHasActive ? 'คุณมีคิวที่จุดนี้แล้ว' : d.isOpen ? 'รับบัตรคิว' : 'ปิดรับคิว'}
          </button>
        </div>
      `;
    })
    .join('');

  // Live Queue Orders across desks
  const ordersGrid = document.getElementById('user-queue-orders');
  ordersGrid.innerHTML = state.desks
    .map((d) => {
      const items = [];
      if (d.currentCalled) {
        items.push(`
          <div class="order-item is-serving">
            <span>🔔 กำลังเรียก: <strong>${escapeHtml(d.currentCalled.ticketNumber)}</strong> ${
          d.currentCalled.isMine ? '(คิวของคุณ!)' : ''
        }</span>
            <span class="pill pill-success">กำลังให้บริการ</span>
          </div>
        `);
      }

      if (d.waitingQueue.length === 0 && !d.currentCalled) {
        items.push('<div class="muted" style="font-size:13px;padding:6px 0;">ยังไม่มีคิวในขณะนี้</div>');
      } else {
        for (const w of d.waitingQueue) {
          items.push(`
            <div class="order-item ${w.isMine ? 'is-mine' : ''}">
              <span>ลำดับที่ ${w.position} — <strong>${escapeHtml(w.ticketNumber)}</strong> ${
            w.isMine ? '⭐ (คิวของคุณ)' : ''
          }</span>
              <span class="muted" style="font-size:12px;">รอ ${w.aheadCount} คิวก่อนหน้า</span>
            </div>
          `);
        }
      }

      return `
        <div class="order-panel">
          <div class="order-panel-header">
            <span>[${escapeHtml(d.code)}] ${escapeHtml(d.name)}</span>
            <span class="pill pill-muted">รอ ${d.waitingCount}</span>
          </div>
          <div class="order-list">${items.join('')}</div>
        </div>
      `;
    })
    .join('');

  // User history
  const histEl = document.getElementById('user-history-list');
  const pastTickets = state.myTickets.filter((t) => !['waiting', 'called'].includes(t.status));
  if (pastTickets.length === 0) {
    histEl.innerHTML = '<p class="muted">ยังไม่มีประวัติคิวก่อนหน้า</p>';
  } else {
    histEl.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>บัตรคิว</th>
              <th>จุดบริการ</th>
              <th>เรื่องที่ติดต่อ</th>
              <th>สถานะ</th>
              <th>เวลาจอง</th>
            </tr>
          </thead>
          <tbody>
            ${pastTickets
              .map((t) => {
                const st = STATUS_LABELS[t.status] || STATUS_LABELS.cancelled;
                return `
                  <tr>
                    <td><strong>${escapeHtml(t.ticketNumber)}</strong></td>
                    <td>${escapeHtml(t.deskName)} (${escapeHtml(t.teacherName)})</td>
                    <td>${escapeHtml(t.note || '-')}</td>
                    <td><span class="pill ${st.cls}">${st.text}</span></td>
                    <td>${formatTime(t.createdAt)}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}

function renderTeacherView() {
  // Subtabs
  document.querySelectorAll('[data-teacher-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.teacherTab === state.teacherTab);
  });
  document
    .getElementById('teacher-tab-console')
    .classList.toggle('hidden', state.teacherTab !== 'console');
  document
    .getElementById('teacher-tab-manage')
    .classList.toggle('hidden', state.teacherTab !== 'manage');

  // Desk selector tabs
  const tabsEl = document.getElementById('teacher-desk-tabs');
  tabsEl.innerHTML = state.desks
    .map(
      (d) => `
      <button type="button" class="desk-tab ${d.id === state.selectedDeskId ? 'active' : ''}" data-select-desk="${d.id}">
        <span>[${escapeHtml(d.code)}] ${escapeHtml(d.name)}</span>
        <span class="pill ${d.waitingCount > 0 ? 'pill-primary' : 'pill-muted'}">รอ ${d.waitingCount}</span>
      </button>
    `
    )
    .join('');

  const desk = state.desks.find((d) => d.id === state.selectedDeskId) || state.desks[0];
  const callerCard = document.getElementById('teacher-caller-card');
  const waitingListEl = document.getElementById('teacher-waiting-list');
  const waitingSubtitle = document.getElementById('teacher-waiting-subtitle');

  if (!desk) {
    callerCard.innerHTML = '<p class="muted">ยังไม่มีจุดบริการ</p>';
    waitingListEl.innerHTML = '';
  } else {
    const cur = desk.currentCalled;
    callerCard.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div>
          <h3 style="margin:0;">[${escapeHtml(desk.code)}] ${escapeHtml(desk.name)}</h3>
          <div class="muted">${escapeHtml(desk.teacherName)}</div>
        </div>
        <span class="pill ${desk.isOpen ? 'pill-success' : 'pill-danger'}">
          ${desk.isOpen ? 'เปิดรับคิว' : 'ปิดรับคิว'}
        </span>
      </div>

      <div class="caller-now-box">
        <div class="muted" style="font-size:13px;">คิวที่กำลังเรียก / ให้บริการอยู่</div>
        <div class="caller-ticket-num">${cur ? escapeHtml(cur.ticketNumber) : '---'}</div>
        ${
          cur
            ? `
            <div style="font-weight:700;font-size:16px;">${escapeHtml(cur.userName)} ${
                cur.studentCode ? `(${escapeHtml(cur.studentCode)})` : ''
              }</div>
            ${cur.note ? `<div class="muted" style="margin-top:4px;">เรื่อง: ${escapeHtml(cur.note)}</div>` : ''}
            <div class="muted" style="margin-top:4px;font-size:12px;">เรียกแล้ว ${cur.recallCount} ครั้ง</div>
          `
            : '<div class="muted">ยังไม่มีคิวที่กำลังเรียกในขณะนี้</div>'
        }
      </div>

      <div class="caller-actions">
        <button type="button" class="btn btn-primary btn-lg" data-call-next="${desk.id}" ${
      desk.waitingCount === 0 && !cur ? 'disabled' : ''
    }>
          📢 ${desk.waitingCount > 0 ? 'เรียกคิวถัดไป' : 'ปิดคิวปัจจุบัน (ไม่มีคิวรอ)'}
        </button>

        <div class="caller-secondary-row">
          <button type="button" class="btn btn-outline" data-recall="${desk.id}" ${!cur ? 'disabled' : ''}>
            🔔 เรียกซ้ำ
          </button>
          <button type="button" class="btn btn-success" data-complete-ticket="${cur?.id || ''}" ${!cur ? 'disabled' : ''}>
            ✅ เสร็จสิ้น
          </button>
          <button type="button" class="btn btn-warning" data-skip-ticket="${cur?.id || ''}" ${!cur ? 'disabled' : ''}>
            ⏭️ ข้ามคิว
          </button>
        </div>
      </div>

      <div class="desk-admin-row">
        <button type="button" class="btn btn-outline btn-sm" data-toggle-desk="${desk.id}">
          ${desk.isOpen ? '⏸️ ปิดรับคิวชั่วคราว' : '▶️ เปิดรับคิว'}
        </button>
        <button type="button" class="btn btn-danger btn-sm" data-reset-desk="${desk.id}">
          🔄 รีเซ็ตคิว (เริ่ม ${escapeHtml(desk.code)}001)
        </button>
      </div>
    `;

    waitingSubtitle.textContent = `จุดบริการ ${desk.name} — มีผู้รอทั้งหมด ${desk.waitingCount} คิว`;
    if (desk.waitingQueue.length === 0) {
      waitingListEl.innerHTML = '<div class="empty-ticket-box">ไม่มีผู้รอคิวในขณะนี้</div>';
    } else {
      waitingListEl.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ลำดับ</th>
                <th>บัตรคิว</th>
                <th>ชื่อผู้รับบริการ</th>
                <th>เรื่องที่ติดต่อ</th>
                <th>เวลาจอง</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              ${desk.waitingQueue
                .map(
                  (w) => `
                <tr>
                  <td><strong>#${w.position}</strong></td>
                  <td><span class="pill pill-primary">${escapeHtml(w.ticketNumber)}</span></td>
                  <td>
                    <div style="font-weight:600;">${escapeHtml(w.userName || '-')}</div>
                    ${w.studentCode ? `<div class="muted" style="font-size:12px;">${escapeHtml(w.studentCode)}</div>` : ''}
                  </td>
                  <td>${escapeHtml(w.note || '-')}</td>
                  <td>${formatTime(w.createdAt)}</td>
                  <td>
                    <button type="button" class="btn btn-warning btn-sm" data-skip-ticket="${w.id}">ข้าม</button>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // Teacher History
  const historyEl = document.getElementById('teacher-history-table');
  if (state.teacherHistory.length === 0) {
    historyEl.innerHTML = '<p class="muted">ยังไม่มีประวัติการให้บริการ</p>';
  } else {
    historyEl.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>บัตรคิว</th>
              <th>จุดบริการ</th>
              <th>ผู้รับบริการ</th>
              <th>เรื่อง</th>
              <th>สถานะ</th>
              <th>เวลาจบคิว</th>
            </tr>
          </thead>
          <tbody>
            ${state.teacherHistory
              .slice(0, 15)
              .map((h) => {
                const st = STATUS_LABELS[h.status] || STATUS_LABELS.completed;
                return `
                  <tr>
                    <td><strong>${escapeHtml(h.ticket_number)}</strong></td>
                    <td>[${escapeHtml(h.desk_code)}] ${escapeHtml(h.desk_name)}</td>
                    <td>${escapeHtml(h.user_name)} ${h.student_code ? `(${escapeHtml(h.student_code)})` : ''}</td>
                    <td>${escapeHtml(h.note || '-')}</td>
                    <td><span class="pill ${st.cls}">${st.text}</span></td>
                    <td>${formatTime(h.finished_at || h.created_at)}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Teachers directory
  const teachersEl = document.getElementById('teacher-accounts-list');
  teachersEl.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ชื่อ - นามสกุล</th>
            <th>ชื่อผู้ใช้ (Username)</th>
            <th>รหัสประจำตัว</th>
          </tr>
        </thead>
        <tbody>
          ${state.teachers
            .map(
              (t) => `
            <tr>
              <td><strong>${escapeHtml(t.fullName)}</strong></td>
              <td><code>${escapeHtml(t.username)}</code></td>
              <td>${escapeHtml(t.teacherCode || '-')}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderDisplayView() {
  const banner = document.getElementById('display-announcement');
  if (state.lastAnnouncement) {
    banner.classList.remove('hidden');
    banner.textContent = `📢 ขอเชิญคิวหมายเลข ${state.lastAnnouncement.ticketNumber} — ${state.lastAnnouncement.deskName} (${state.lastAnnouncement.teacherName})`;
  } else {
    banner.classList.add('hidden');
  }

  const grid = document.getElementById('display-board-grid');
  grid.innerHTML = state.desks
    .map(
      (d) => `
      <div class="display-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="pill pill-primary">ช่อง ${escapeHtml(d.code)}</span>
          <span style="font-size:13px;color:#94a3b8;">${d.isOpen ? 'เปิดให้บริการ' : 'ปิดรับชั่วคราว'}</span>
        </div>
        <h3 style="margin:10px 0 2px;font-size:20px;">${escapeHtml(d.name)}</h3>
        <div style="font-size:13px;color:#94a3b8;">${escapeHtml(d.teacherName)}</div>

        <div style="margin-top:16px;font-size:12px;color:#94a3b8;">กำลังเรียกคิวหมายเลข</div>
        <div class="display-ticket">${escapeHtml(d.currentCalled?.ticketNumber || '---')}</div>

        <div style="font-size:13px;color:#cbd5e1;">
          คิวถัดไปที่รอ (${d.waitingCount} คิว):
        </div>
        <div class="display-next-chips">
          ${
            d.waitingQueue.length === 0
              ? '<span style="color:#64748b;font-size:13px;">ไม่มีคิวรอ</span>'
              : d.waitingQueue
                  .slice(0, 6)
                  .map((w) => `<span class="display-chip">${escapeHtml(w.ticketNumber)}</span>`)
                  .join('')
          }
        </div>
      </div>
    `
    )
    .join('');
}

function render() {
  renderNav();

  document.getElementById('view-auth').classList.toggle('hidden', state.activeView !== 'auth');
  document.getElementById('view-user').classList.toggle('hidden', state.activeView !== 'user');
  document.getElementById('view-teacher').classList.toggle('hidden', state.activeView !== 'teacher');
  document.getElementById('view-display').classList.toggle('hidden', state.activeView !== 'display');

  if (state.activeView === 'user' && state.user) {
    renderUserView();
  } else if (state.activeView === 'teacher' && state.user?.role === 'teacher') {
    renderTeacherView();
  } else if (state.activeView === 'display') {
    renderDisplayView();
  }
}

// ==================== EVENT LISTENERS ====================

document.addEventListener('click', async (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) {
    setView(navBtn.dataset.nav);
    return;
  }

  if (e.target.closest('#brand-home')) {
    if (!state.user) setView('auth');
    else setView(state.user.role === 'teacher' ? 'teacher' : 'user');
    return;
  }

  const authTab = e.target.closest('[data-auth-tab]');
  if (authTab) {
    const mode = authTab.dataset.authTab;
    document.querySelectorAll('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === authTab));
    document.getElementById('form-login').classList.toggle('hidden', mode !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', mode !== 'register');
    return;
  }

  const fillBtn = e.target.closest('[data-fill-login]');
  if (fillBtn) {
    document.querySelector('[data-auth-tab="login"]').click();
    document.getElementById('login-username').value = fillBtn.dataset.fillLogin;
    document.getElementById('login-password').value = fillBtn.dataset.fillPass;
    return;
  }

  if (e.target.closest('#btn-logout')) {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.myTickets = [];
    state.activeView = 'auth';
    showToast('ออกจากระบบเรียบร้อยแล้ว');
    await refreshQueues();
    return;
  }

  const bookBtn = e.target.closest('[data-book-desk]');
  if (bookBtn) {
    const deskId = Number(bookBtn.dataset.bookDesk);
    const note = document.getElementById('user-booking-note').value.trim();
    try {
      const { ticket } = await api('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({ deskId, note }),
      });
      document.getElementById('user-booking-note').value = '';
      showToast(`จองคิวสำเร็จ! บัตรคิวของคุณคือ ${ticket.ticketNumber}`, 'success');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const cancelBtn = e.target.closest('[data-cancel-ticket]');
  if (cancelBtn) {
    const id = Number(cancelBtn.dataset.cancelTicket);
    if (!confirm('ยืนยันการยกเลิกบัตรคิวนี้?')) return;
    try {
      await api(`/api/tickets/${id}/cancel`, { method: 'POST' });
      showToast('ยกเลิกคิวเรียบร้อยแล้ว');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const teacherTabBtn = e.target.closest('[data-teacher-tab]');
  if (teacherTabBtn) {
    state.teacherTab = teacherTabBtn.dataset.teacherTab;
    renderTeacherView();
    return;
  }

  const selectDeskBtn = e.target.closest('[data-select-desk]');
  if (selectDeskBtn) {
    state.selectedDeskId = Number(selectDeskBtn.dataset.selectDesk);
    renderTeacherView();
    return;
  }

  const callNextBtn = e.target.closest('[data-call-next]');
  if (callNextBtn) {
    const deskId = Number(callNextBtn.dataset.callNext);
    try {
      const res = await api(`/api/teacher/desks/${deskId}/call-next`, { method: 'POST' });
      if (res.called) {
        showToast(`เรียกคิว ${res.called.ticketNumber} (${res.called.userName})`, 'success');
      } else {
        showToast(res.message || 'ไม่มีคิวรอแล้ว');
      }
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const recallBtn = e.target.closest('[data-recall]');
  if (recallBtn) {
    const deskId = Number(recallBtn.dataset.recall);
    try {
      const res = await api(`/api/teacher/desks/${deskId}/recall`, { method: 'POST' });
      showToast(`เรียกคิว ${res.ticketNumber} ซ้ำแล้ว`, 'success');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const completeBtn = e.target.closest('[data-complete-ticket]');
  if (completeBtn && completeBtn.dataset.completeTicket) {
    const id = Number(completeBtn.dataset.completeTicket);
    try {
      await api(`/api/teacher/tickets/${id}/complete`, { method: 'POST' });
      showToast('บันทึกให้บริการเสร็จสิ้นแล้ว', 'success');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const skipBtn = e.target.closest('[data-skip-ticket]');
  if (skipBtn && skipBtn.dataset.skipTicket) {
    const id = Number(skipBtn.dataset.skipTicket);
    try {
      await api(`/api/teacher/tickets/${id}/skip`, { method: 'POST' });
      showToast('ข้ามคิวเรียบร้อยแล้ว');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const toggleDeskBtn = e.target.closest('[data-toggle-desk]');
  if (toggleDeskBtn) {
    const deskId = Number(toggleDeskBtn.dataset.toggleDesk);
    try {
      const res = await api(`/api/teacher/desks/${deskId}/toggle`, { method: 'POST' });
      showToast(res.isOpen ? 'เปิดรับคิวแล้ว' : 'ปิดรับคิวชั่วคราวแล้ว');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const resetDeskBtn = e.target.closest('[data-reset-desk]');
  if (resetDeskBtn) {
    const deskId = Number(resetDeskBtn.dataset.resetDesk);
    if (!confirm('ต้องการล้างคิวที่รออยู่ทั้งหมดของจุดบริการนี้ และเริ่มนับหมายเลข 001 ใหม่หรือไม่?')) {
      return;
    }
    try {
      await api(`/api/teacher/desks/${deskId}/reset`, { method: 'POST' });
      showToast('รีเซ็ตคิวเรียบร้อยแล้ว');
      await refreshQueues();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});

// Login submit
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.username.value.trim(),
        password: form.password.value,
      }),
    });
    state.user = user;
    state.activeView = user.role === 'teacher' ? 'teacher' : 'user';
    form.reset();
    showToast(`ยินดีต้อนรับ ${user.fullName}`, 'success');
    await refreshQueues();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Self-register submit
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const { user } = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        fullName: form.fullName.value.trim(),
        studentCode: form.studentCode.value.trim(),
        username: form.username.value.trim(),
        password: form.password.value,
      }),
    });
    state.user = user;
    state.activeView = 'user';
    form.reset();
    showToast(`สมัครสมาชิกสำเร็จ! ยินดีต้อนรับ ${user.fullName}`, 'success');
    await refreshQueues();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Create desk submit (teacher)
document.getElementById('form-create-desk').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const created = await api('/api/teacher/desks', {
      method: 'POST',
      body: JSON.stringify({
        code: form.code.value.trim(),
        name: form.name.value.trim(),
        teacherName: form.teacherName.value.trim(),
        description: form.description.value.trim(),
      }),
    });
    form.reset();
    state.selectedDeskId = created.id;
    showToast(`สร้างจุดบริการ [${created.code}] ${created.name} สำเร็จ`, 'success');
    await refreshQueues();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Create teacher account submit (teacher)
document.getElementById('form-create-teacher').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const { teacher } = await api('/api/teacher/accounts', {
      method: 'POST',
      body: JSON.stringify({
        fullName: form.fullName.value.trim(),
        username: form.username.value.trim(),
        teacherCode: form.teacherCode.value.trim(),
        password: form.password.value,
      }),
    });
    form.reset();
    showToast(`เพิ่มบัญชีคุณครู ${teacher.fullName} (${teacher.username}) สำเร็จ`, 'success');
    await refreshQueues();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Boot
(async function init() {
  try {
    connectSSE();
    await refreshSessionAndData();
  } catch (err) {
    showToast(err.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้', 'error');
  }
})();
