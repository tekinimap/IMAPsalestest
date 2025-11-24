import fs from 'fs';

const SQL_FILE = 'migrations/0002_import_data.sql';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');
const lines = content.split('\n').filter(line => line.trim().startsWith('INSERT'));

console.log(`Total INSERT statements: ${lines.length}`);

// Check which entries are already in the database
import { execSync } from 'child_process';

console.log('\nChecking existing entries in D1...');

const existingIds = [];
try {
    const result = execSync('npx wrangler d1 execute imap-sales-db --command "SELECT id FROM entries" --local --json', {
        encoding: 'utf-8',
        stdio: 'pipe'
    });

    const parsed = JSON.parse(result);
    if (parsed && parsed[0] && parsed[0].results) {
        parsed[0].results.forEach(row => {
            existingIds.push(row.id);
        });
    }
    console.log(`Found ${existingIds.length} existing entries in D1`);
} catch (e) {
    console.error('Failed to query existing entries:', e.message);
}

// Determine which IDs are missing
const allIds = [];
lines.forEach((line, idx) => {
    // Extract ID from INSERT statement
    const match = line.match(/VALUES \('([^']+)'/);
    if (match) {
        allIds.push({ id: match[1], lineNum: idx });
    }
});

const missingIds = allIds.filter(entry => !existingIds.includes(entry.id));

console.log(`\nMissing entries: ${missingIds.length}`);
console.log('\nFirst 10 missing IDs:');
missingIds.slice(0, 10).forEach(entry => {
    console.log(`- ${entry.id} (line ${entry.lineNum})`);
});

// Write missing IDs to file
fs.writeFileSync('missing_entries.txt', missingIds.map(e => `${e.id} (line ${e.lineNum})`).join('\n'));
console.log('\nFull list written to missing_entries.txt');
