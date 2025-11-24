import fs from 'fs';
import { execSync } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');
const lines = content.split('\n').filter(line => line.trim().startsWith('INSERT'));

console.log(`Found ${lines.length} INSERT statements.`);
console.log(`Starting migration...`);

let successCount = 0;
let errorCount = 0;

for (let i = 0; i < lines.length; i++) {
    const sql = lines[i];
    const tempFile = `temp_insert_${i}.sql`;

    try {
        // Write single INSERT to temp file
        fs.writeFileSync(tempFile, sql);

        // Execute using wrangler
        execSync(`npx wrangler d1 execute imap-sales-db --file=${tempFile} --local`, {
            stdio: 'pipe',
            encoding: 'utf-8'
        });

        successCount++;

        // Delete temp file
        fs.unlinkSync(tempFile);

        if ((i + 1) % 10 === 0) {
            console.log(`Progress: ${i + 1}/${lines.length} rows inserted`);
        }
    } catch (error) {
        errorCount++;
        console.error(`Failed to insert row ${i + 1}:`, error.message.substring(0, 100));

        // Clean up temp file on error
        try { fs.unlinkSync(tempFile); } catch (e) { }

        // Continue with next row instead of stopping
    }
}

console.log(`\nMigration complete!`);
console.log(`Success: ${successCount} rows`);
console.log(`Errors: ${errorCount} rows`);
