import fs from 'fs';
import { spawn } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';
const BATCH_SIZE = 10;

async function runQuery(query) {
    const tempFile = 'temp_migration.sql';
    fs.writeFileSync(tempFile, query);

    return new Promise((resolve, reject) => {
        const cmd = spawn('npx', ['wrangler', 'd1', 'execute', 'imap-sales-db', `--file=${tempFile}`, '--local'], { shell: true });

        let stdout = '';
        let stderr = '';

        cmd.stdout.on('data', (data) => { stdout += data; });
        cmd.stderr.on('data', (data) => { stderr += data; });

        cmd.on('close', (code) => {
            // Clean up temp file
            try { fs.unlinkSync(tempFile); } catch (e) { }

            if (code !== 0) {
                if (stderr.includes("UNIQUE constraint failed")) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr}`));
                }
            } else {
                resolve(stdout);
            }
        });
    });
}

async function main() {
    console.log(`Reading ${SQL_FILE}...`);
    const content = fs.readFileSync(SQL_FILE, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().startsWith('INSERT'));

    console.log(`Found ${lines.length} INSERT statements.`);

    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
        const batch = lines.slice(i, i + BATCH_SIZE);
        const query = batch.join(';\n');

        console.log(`Executing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(lines.length / BATCH_SIZE)}...`);

        try {
            await runQuery(query);
            console.log(`Batch ${i / BATCH_SIZE + 1} complete.`);
        } catch (e) {
            console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, e);
            process.exit(1);
        }
    }

    console.log("Migration complete.");
}

main();
