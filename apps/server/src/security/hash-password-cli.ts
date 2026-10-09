/**
 * Prints an AUTH_PASSWORD_HASH for single-user login. The password is read from stdin (hidden
 * when interactive), never from argv, so it does not land in shell history.
 *   npm run hash-password -w @planner/server
 *   printf '%s' "$PASSWORD" | npm run -s hash-password -w @planner/server
 */
import { hashPassword } from './auth';

async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  process.stderr.write('Password (hidden): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let pw = '';
    stdin.on('data', (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolve(pw);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('cancelled'));
          return;
        }
        pw = c === '\u007f' || c === '\b' ? pw.slice(0, -1) : pw + c;
      }
    });
  });
}

const pw = await readPassword();
if (pw.length < 12) {
  console.error('Use at least 12 characters (a passphrase is best).');
  process.exit(1);
}
process.stdout.write(`${await hashPassword(pw)}\n`);
