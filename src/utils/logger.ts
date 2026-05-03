/**
 * Production-safe logging utility
 * Only logs in development mode or when explicitly enabled
 */

const isDevelopment = typeof import.meta !== 'undefined' && ((import.meta as any).env?.DEV ?? false);
const isDebugEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('debug') === 'true';

export const logger = {
  debug: (message: string, ...args: any[]) => {
    if (isDevelopment || isDebugEnabled) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
  
  info: (message: string, ...args: any[]) => {
    if (isDevelopment || isDebugEnabled) {
      console.info(`[INFO] ${message}`, ...args);
    }
  },
  
  warn: (message: string, ...args: any[]) => {
    console.warn(`[WARN] ${message}`, ...args);
  },
  
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${message}`, ...args);
  },
  
  // Always log important operations
  operation: (message: string, ...args: any[]) => {
    console.log(`[OP] ${message}`, ...args);
  }
};

export default logger;