import pino from 'pino';
import { config } from './config.js';

/** Shared JSON logger. Child loggers add a `mod` field, e.g. logger.child({ mod: 'seed' }). */
export const logger = pino({ level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL });

export default logger;
