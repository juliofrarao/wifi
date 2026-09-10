/**
 * `npm run restore -- <snapshot.sqlite> --yes` — copy a backup snapshot over
 * DATA_DIR/creche.sqlite. Run ONLY with the server stopped. The current
 * database is kept as creche.sqlite.before-restore-<timestamp>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from './config.js';

const SQLITE_HEADER = 'SQLite format 3\u0000';

function usage(): never {
  console.error('Uso: npm run restore -- <arquivo.sqlite> --yes\n(Pare o servidor antes. O banco atual é preservado como creche.sqlite.before-restore-<data>.)');
  process.exit(2);
}

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  const args = process.argv.slice(2);
  const confirm = args.includes('--yes') || args.includes('-y');
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) usage();
  const source = path.resolve(process.cwd(), file);
  if (!fs.existsSync(source)) {
    console.error(`Arquivo não encontrado: ${source}`);
    process.exit(1);
  }
  const fd = fs.openSync(source, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== SQLITE_HEADER) {
    console.error('O arquivo informado não é um banco SQLite.');
    process.exit(1);
  }
  const target = path.join(config.dataDir, 'creche.sqlite');
  if (!confirm) {
    console.error(`Isto vai substituir ${target} por ${source}.\nPare o servidor e repita o comando com --yes para confirmar.`);
    process.exit(2);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.before-restore-${stamp}`);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(`${target}${suffix}`);
    } catch {
      // absent
    }
  }
  fs.copyFileSync(source, target);
  console.log(`Banco restaurado de ${source} para ${target}. Inicie o servidor novamente.`);
}

main();
