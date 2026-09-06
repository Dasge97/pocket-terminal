import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password, salt, 64);
  return { passwordSalt: salt, passwordHash: hash.toString('hex') };
}

export class Auth {
  constructor(config) { this.config = config; this.tokens = new Map(); this.attempts = []; this.pending = 0; }
  async login(password) {
    const now = Date.now();
    this.attempts = this.attempts.filter(t => now - t < 60_000);
    if (this.attempts.length >= 10 || this.pending >= 2) return { status: 429 };
    // Una petición malformada no gasta cupo: si lo gastara, diez peticiones sin
    // contraseña dejarían al dueño fuera durante un minuto sin haber probado
    // ninguna clave. El límite existe para frenar la fuerza bruta, y la fuerza
    // bruta necesita llegar a comprobar el hash.
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return { status: 400 };
    this.attempts.push(now);
    this.pending++;
    let valid;
    try {
      const hash = await derive(password, this.config.passwordSalt, 64);
      valid = timingSafeEqual(hash, Buffer.from(this.config.passwordHash, 'hex'));
    } finally { this.pending--; }
    if (!valid) return { status: 401 };
    this.sweep();
    if (this.tokens.size >= 20) this.tokens.delete(this.tokens.keys().next().value);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { expires: now + this.config.authLifetimeMs });
    return { status: 200, token };
  }
  token(request) {
    return (request.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith('pocket_session='))?.slice(15);
  }
  valid(token) { return Boolean(token && this.tokens.get(token)?.expires > Date.now()); }
  check(request) { return this.valid(this.token(request)); }
  sweep() { for (const token of this.tokens.keys()) if (!this.valid(token)) this.tokens.delete(token); }
  cookie(token, clear = false) {
    return `pocket_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(this.config.authLifetimeMs / 1000)}${this.config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`;
  }
}
