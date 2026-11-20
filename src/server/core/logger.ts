import pino, { type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({ level, redact: ['req.headers.cookie', 'headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] });
}
