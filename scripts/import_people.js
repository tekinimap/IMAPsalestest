import fs from 'fs';
import { execSync } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');

// Extract all people INSERT statements - they contain "INTO people ("
const allLines = content.split('\n');
const peopleLines = allLines.filter(line =>
    line.includes('INTO people (') && line.trim().startsWith('INSERT')
);

console.log(`Found ${peopleLines.length} people INSERT statements.`);

if (peopleLines.length === 0) {
    console.log('No people statements found. Checking file structure...');
    const sampleLines = allLines.slice(220, 230);
    sampleLines.forEach((line, idx) => {
        console.log(`Line ${220 + idx}: ${line.substring(0, 100)}`);
    });
    process.exit(1);
}

console.log(`Starting migration...`);

let successCount = 0;
let errorCount = 0;

for (let i = 0; i < peopleLines.length; i++) {
    const sql = peopleLines[i];
    const tempFile = `temp_person_${i}.sql`;

    try {
        fs.writeFileSync(tempFile, sql);

        execSync(`npx wrangler d1 execute imap-sales-db --file=${tempFile} --local`, {
            stdio: 'pipe',
            encoding: 'utf-8'
        });

        successCount++;
        fs.unlinkSync(tempFile);

        if ((i + 1) % 10 === 0) {
            console.log(`Progress: ${i + 1}/${peopleLines.length} people inserted`);
        }
    } catch (error) {
        errorCount++;
        console.error(`Failed to insert person ${i + 1}:`, error.message.substring(0, 100));
        try { fs.unlinkSync(tempFile); } catch (e) { }
    }
}

console.log(`\nMigration complete!`);
console.log(`Success: ${successCount} people`);
console.log(`Errors: ${errorCount} people`);
