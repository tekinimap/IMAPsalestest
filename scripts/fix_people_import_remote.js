import fs from 'fs';
import { execSync } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';
const REMOTE_FLAG = '--remote';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');

// Extract all people INSERT statements
const lines = content.split('\n');
const peopleLines = lines.filter(line => line.includes('INTO people (') && line.trim().startsWith('INSERT'));

console.log(`Found ${peopleLines.length} people INSERT statements.`);

let success = 0;
let errors = 0;

peopleLines.forEach((line, idx) => {
    // Expected format: INSERT OR IGNORE INTO people (id, name, email, data, updatedAt) VALUES ('id','name','email','data',ts);
    const match = line.match(/VALUES \('([^']+)',\s*'[^']*',\s*'([^']*)',\s*'(\{[^}]*\})',\s*(\d+)\)/);
    if (!match) {
        console.error(`Could not parse line ${idx + 1}: ${line.substring(0, 80)}`);
        errors++;
        return;
    }
    const [, id, email, jsonData, updatedAt] = match;
    const fixedSql = `INSERT OR IGNORE INTO people (id, email, data, updatedAt) VALUES ('${id}', '${email}', '${jsonData}', ${updatedAt});`;
    const tempFile = `temp_person_${idx}.sql`;
    try {
        fs.writeFileSync(tempFile, fixedSql);
        execSync(`npx wrangler d1 execute imap-sales-db --file=${tempFile} ${REMOTE_FLAG}`, { stdio: 'ignore' });
        success++;
        fs.unlinkSync(tempFile);
        if ((success % 10) === 0) console.log(`Inserted ${success} people...`);
    } catch (e) {
        errors++;
        console.error(`Failed to insert person ${id}: ${e.message}`);
        try { fs.unlinkSync(tempFile); } catch (_) { }
    }
});

console.log('\nMigration complete!');
console.log(`Success: ${success} people`);
console.log(`Errors: ${errors} people`);
