import pino from 'pino';
import { config } from './config.js';

const level = config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL;

// JSON logs go to the terminal and, when LOG_FILE is set, to that file as well.
const streams = [{ level, stream: process.stdout }];
if (config.logFile && level !== 'silent') {
  streams.push({ level, stream: pino.destination({ dest: config.logFile, mkdir: true, sync: false }) });
}

/** Shared JSON logger. Child loggers add a `mod` field, e.g. logger.child({ mod: 'seed' }). */
export const logger = pino({ level }, pino.multistream(streams));

export default logger;
