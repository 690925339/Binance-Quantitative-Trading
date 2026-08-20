import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ITERATIONS = 210_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const PASSWORD_MIN_LENGTH = 10;

function httpError(message, status = 400, code = null) {
  return Object.assign(new Error(message), { status, code });
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw httpError('登录账号需为 3 到 32 位字母、数字、点、横线或下划线');
  }
  return username;
}

function validateDisplayName(value, fallback) {
  const displayName = String(value || fallback || '').trim();
  if (displayName.length < 1 || displayName.length > 40) {
    throw httpError('用户名称需为 1 到 40 个字符');
  }
  return displayName;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    throw httpError(`密码需为 ${PASSWORD_MIN_LENGTH} 到 128 个字符`);
  }
  return password;
}

function validateRole(value) {
  const role = String(value || 'user');
  if (!['admin', 'user'].includes(role)) throw httpError('用户角色无效');
  return role;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    loginCount: user.loginCount,
  };
}

function derivePassword(password, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (error, value) => {
      if (error) reject(error);
      else resolve(value.toString('base64url'));
    });
  });
}

async function passwordRecord(password, iterations) {
  const salt = crypto.randomBytes(18).toString('base64url');
  return {
    algorithm: 'pbkdf2-sha256',
    iterations,
    salt,
    digest: await derivePassword(password, salt, iterations),
  };
}

async function passwordMatches(password, record) {
  if (!record || record.algorithm !== 'pbkdf2-sha256') return false;
  const actual = Buffer.from(await derivePassword(password, record.salt, record.iterations), 'base64url');
  const expected = Buffer.from(record.digest || '', 'base64url');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export class UserStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.iterations = options.iterations || DEFAULT_ITERATIONS;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async initialize(bootstrap = {}) {
    return this.#exclusive(async () => {
      await this.#load();
      if (this.state.users.length) return { setupRequired: false, bootstrapped: false };
      const username = String(bootstrap.username || '').trim();
      const password = String(bootstrap.password || '');
      if (!username || !password) return { setupRequired: true, bootstrapped: false };
      await this.#createUser({
        username,
        password,
        displayName: bootstrap.displayName || '系统管理员',
        role: 'admin',
      });
      return { setupRequired: false, bootstrapped: true };
    });
  }

  async setupRequired() {
    await this.#load();
    return this.state.users.length === 0;
  }

  async list() {
    await this.#load();
    return this.state.users
      .map(publicUser)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async findById(id) {
    await this.#load();
    return publicUser(this.state.users.find((user) => user.id === id));
  }

  async authenticate(usernameInput, passwordInput) {
    return this.#exclusive(async () => {
      await this.#load();
      const username = normalizeUsername(usernameInput);
      const password = String(passwordInput || '');
      const user = this.state.users.find((item) => item.normalizedUsername === username);
      if (!user || !(await passwordMatches(password, user.password))) {
        throw httpError('账号或密码错误', 401, 'INVALID_CREDENTIALS');
      }
      if (user.status !== 'active') throw httpError('该账号已停用，请联系管理员', 403, 'USER_DISABLED');
      user.lastLoginAt = new Date().toISOString();
      user.loginCount = Number(user.loginCount || 0) + 1;
      user.updatedAt = user.lastLoginAt;
      await this.#save();
      return publicUser(user);
    });
  }

  async create(input) {
    return this.#exclusive(async () => {
      await this.#load();
      return this.#createUser(input);
    });
  }

  async update(id, patch) {
    return this.#exclusive(async () => {
      await this.#load();
      const user = this.state.users.find((item) => item.id === id);
      if (!user) throw httpError('用户不存在', 404);
      if (patch.displayName !== undefined) user.displayName = validateDisplayName(patch.displayName, user.username);
      if (patch.role !== undefined) user.role = validateRole(patch.role);
      if (patch.status !== undefined) {
        if (!['active', 'disabled'].includes(patch.status)) throw httpError('用户状态无效');
        user.status = patch.status;
      }
      user.updatedAt = new Date().toISOString();
      await this.#save();
      return publicUser(user);
    });
  }

  async resetPassword(id, passwordInput) {
    return this.#exclusive(async () => {
      await this.#load();
      const user = this.state.users.find((item) => item.id === id);
      if (!user) throw httpError('用户不存在', 404);
      user.password = await passwordRecord(validatePassword(passwordInput), this.iterations);
      user.updatedAt = new Date().toISOString();
      await this.#save();
      return publicUser(user);
    });
  }

  async activeAdminCount() {
    await this.#load();
    return this.state.users.filter((user) => user.role === 'admin' && user.status === 'active').length;
  }

  async #createUser(input) {
    const username = validateUsername(input.username);
    const normalizedUsername = normalizeUsername(username);
    if (this.state.users.some((user) => user.normalizedUsername === normalizedUsername)) {
      throw httpError('该登录账号已存在', 409, 'USERNAME_EXISTS');
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      normalizedUsername,
      displayName: validateDisplayName(input.displayName, username),
      role: validateRole(input.role),
      status: 'active',
      password: await passwordRecord(validatePassword(input.password), this.iterations),
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      loginCount: 0,
    };
    this.state.users.push(user);
    await this.#save();
    return publicUser(user);
  }

  async #load() {
    if (this.state) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.users)) throw new Error('用户数据格式无效');
      this.state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, users: [] };
    }
  }

  async #save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, this.filePath);
  }

  #exclusive(action) {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export const USER_PASSWORD_MIN_LENGTH = PASSWORD_MIN_LENGTH;
