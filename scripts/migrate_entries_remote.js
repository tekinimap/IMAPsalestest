import fs from 'fs';
import { execSync } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');
const lines = content.split('\n').filter(line => line.trim().startsWith('INSERT') && line.includes('INTO entries'));

console.log(`Found ${lines.length} entries INSERT statements.`);
console.log(`Starting REMOTE migration...`);

let successCount = 0;
let errorCount = 0;

for (let i = 0; i < lines.length; i++) {
    const sql = lines[i];
    const tempFile = `temp_remote_entry_${i}.sql`;

    try {
        fs.writeFileSync(tempFile, sql);

        execSync(`npx wrangler d1 execute imap-sales-db --file=${tempFile} --remote`, {
            stdio: 'pipe',
            encoding: 'utf-8'
        });

        successCount++;
        fs.unlinkSync(tempFile);

        if ((i + 1) % 10 === 0) {
            console.log(`Progress: ${i + 1}/${lines.length} entries inserted`);
        }
    } catch (error) {
        errorCount++;
        console.error(`Failed to insert entry ${i + 1}:`, error.message.substring(0, 100));
        try { fs.unlinkSync(tempFile); } catch (e) { }
    }
}

console.log(`\nMigration complete!`);
console.log(`Success: ${successCount} entries`);
console.log(`Errors: ${errorCount} entries`);
