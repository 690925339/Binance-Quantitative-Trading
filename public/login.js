const form = document.querySelector('#loginForm');
const button = document.querySelector('#loginButton');
const message = document.querySelector('#loginMessage');
const setupMessage = document.querySelector('#setupMessage');

function nextPath() {
  const value = new URLSearchParams(window.location.search).get('next');
  return value === '/admin.html' ? '/admin.html' : '/';
}

function setLoading(loading) {
  button.disabled = loading;
  button.textContent = loading ? '正在验证…' : '登录';
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败，请稍后重试');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

try {
  const session = await jsonRequest('/api/auth/session');
  if (session.authenticated) window.location.replace(nextPath());
  if (session.setupRequired) {
    setupMessage.classList.remove('hidden');
    form.querySelectorAll('input, button').forEach((element) => { element.disabled = true; });
  }
} catch (error) {
  message.textContent = error.message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  setLoading(true);
  try {
    await jsonRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.querySelector('#username').value.trim(),
        password: document.querySelector('#password').value,
      }),
    });
    window.location.replace(nextPath());
  } catch (error) {
    message.textContent = error.message;
    document.querySelector('#password').select();
  } finally {
    setLoading(false);
  }
});
