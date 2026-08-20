const state = { session: null, users: [], query: '', toastTimer: null };
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace(`/login.html?next=${encodeURIComponent('/admin.html')}`);
    throw new Error('登录状态已失效');
  }
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后重试');
  return payload;
}

function showToast(message, type = 'success') {
  const toast = $('#adminToast');
  toast.textContent = message;
  toast.className = `admin-toast show ${type === 'error' ? 'error' : ''}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.className = 'admin-toast'; }, 3200);
}

function formatDate(value) {
  if (!value) return '从未登录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function filteredUsers() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.users;
  return state.users.filter((user) => `${user.username} ${user.displayName}`.toLowerCase().includes(query));
}

function renderStats() {
  $('#totalUsers').textContent = state.users.length;
  $('#activeUsers').textContent = state.users.filter((user) => user.status === 'active').length;
  $('#adminUsers').textContent = state.users.filter((user) => user.role === 'admin').length;
  $('#disabledUsers').textContent = state.users.filter((user) => user.status === 'disabled').length;
}

function renderUsers() {
  const users = filteredUsers();
  const body = $('#userTableBody');
  if (!users.length) {
    body.innerHTML = '<tr><td colspan="6" class="table-empty">没有匹配的用户</td></tr>';
    return;
  }
  body.innerHTML = users.map((user) => {
    const self = user.id === state.session.user.id;
    const statusAction = user.status === 'active' ? 'disable' : 'enable';
    const statusText = user.status === 'active' ? '停用' : '启用';
    return `<tr>
      <td><div class="user-cell"><span class="user-avatar">${escapeHtml(user.displayName.slice(0, 1))}</span><div><strong>${escapeHtml(user.displayName)}${self ? '（我）' : ''}</strong><small>${escapeHtml(user.username)}</small></div></div></td>
      <td><span class="role-badge ${user.role}">${user.role === 'admin' ? '管理员' : '普通用户'}</span></td>
      <td><span class="status-badge ${user.status}">${user.status === 'active' ? '启用' : '停用'}</span></td>
      <td>${formatDate(user.lastLoginAt)}${user.loginCount ? `<br><small>累计 ${user.loginCount} 次</small>` : ''}</td>
      <td>${formatDate(user.createdAt)}</td>
      <td class="action-column"><div class="row-actions">
        <button type="button" data-action="reset" data-user-id="${user.id}">重置密码</button>
        <button class="${statusAction === 'disable' ? 'danger' : 'positive'}" type="button" data-action="${statusAction}" data-user-id="${user.id}" ${self ? 'disabled title="不能停用自己"' : ''}>${statusText}</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function loadUsers() {
  const payload = await api('/api/admin/users');
  state.users = payload.users;
  renderStats();
  renderUsers();
}

function setButtonLoading(button, loading, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = loading;
  button.textContent = loading ? text : button.dataset.label;
}

const session = await api('/api/auth/session');
if (!session.authenticated) window.location.replace('/login.html?next=%2Fadmin.html');
else if (session.user.role !== 'admin') window.location.replace('/');
else {
  state.session = session;
  $('#adminName').textContent = session.user.displayName;
  $('#adminUsername').textContent = session.user.username;
  $('#adminAvatar').textContent = session.user.displayName.slice(0, 1);
  try { await loadUsers(); } catch (error) { showToast(error.message, 'error'); }
}

$('#userSearch').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderUsers();
});

$('#openCreateUser').addEventListener('click', () => {
  $('#createUserForm').reset();
  $('#createUserError').textContent = '';
  $('#createUserDialog').showModal();
  $('#newUsername').focus();
});

$('#createUserForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const button = $('#createUserButton');
  $('#createUserError').textContent = '';
  setButtonLoading(button, true, '正在创建…');
  try {
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#newUsername').value.trim(),
        displayName: $('#newDisplayName').value.trim(),
        role: $('#newRole').value,
        password: $('#newPassword').value,
      }),
    });
    $('#createUserDialog').close();
    await loadUsers();
    showToast('用户已创建，可以使用新账号登录');
  } catch (error) {
    $('#createUserError').textContent = error.message;
  } finally {
    setButtonLoading(button, false);
  }
});

$('#userTableBody').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const user = state.users.find((item) => item.id === button.dataset.userId);
  if (!user) return;
  if (button.dataset.action === 'reset') {
    $('#resetPasswordForm').reset();
    $('#resetPasswordError').textContent = '';
    $('#resetUserId').value = user.id;
    $('#resetUserName').textContent = `${user.displayName}（${user.username}）`;
    $('#resetPasswordDialog').showModal();
    $('#resetPassword').focus();
    return;
  }
  const nextStatus = button.dataset.action === 'disable' ? 'disabled' : 'active';
  if (nextStatus === 'disabled' && !window.confirm(`确定停用“${user.displayName}”吗？该用户将立即无法登录。`)) return;
  setButtonLoading(button, true, '处理中…');
  try {
    await api(`/api/admin/users/${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    await loadUsers();
    showToast(nextStatus === 'active' ? '用户已启用' : '用户已停用');
  } catch (error) {
    showToast(error.message, 'error');
    setButtonLoading(button, false);
  }
});

$('#resetPasswordForm').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const button = $('#resetPasswordButton');
  $('#resetPasswordError').textContent = '';
  setButtonLoading(button, true, '正在保存…');
  try {
    await api(`/api/admin/users/${$('#resetUserId').value}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: $('#resetPassword').value }),
    });
    $('#resetPasswordDialog').close();
    await loadUsers();
    showToast('密码已重置');
  } catch (error) {
    $('#resetPasswordError').textContent = error.message;
  } finally {
    setButtonLoading(button, false);
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  window.location.replace('/login.html');
});
