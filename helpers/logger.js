// helpers/logger.js
const fs = require('fs');
const path = require('path');

function createLogger(fileName) {
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFilePath = path.join(logsDir, fileName);
  const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const levelOrder = ['debug', 'info', 'warn', 'error'];
  const envLevel = process.env.LOG_LEVEL || 'info';
  const minLevelIndex = levelOrder.indexOf(envLevel);
  const shouldLog = (level) => levelOrder.indexOf(level) >= minLevelIndex;

  function write(level, message, extra) {
    if (!shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    if (extra instanceof Error) {
      line += ` | ${extra.message}\n${extra.stack}`;
    } else if (extra) {
      try {
        line += ` | ${JSON.stringify(extra)}`;
      } catch (e) {
        line += ` | ${String(extra)}`;
      }
    }

    stream.write(line + '\n');

    // También a consola
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
  };
}

module.exports = createLogger;
