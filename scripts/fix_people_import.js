import fs from 'fs';
import { execSync } from 'child_process';

const SQL_FILE = 'migrations/0002_import_data.sql';

console.log(`Reading ${SQL_FILE}...`);
const content = fs.readFileSync(SQL_FILE, 'utf-8');

// Extract all people INSERT statements
const allLines = content.split('\n');
const peopleLinesRaw = allLines.filter(line =>
    line.includes('INTO people (') && line.trim().startsWith('INSERT')
);

console.log(`Found ${peopleLinesRaw.length} people INSERT statements.`);

// Fix each people INSERT by removing the 'name' column
const fixedPeopleLines = peopleLinesRaw.map(line => {
    // The original format is:
    // INSERT OR IGNORE INTO people (id, name, email, data, updatedAt) VALUES ('id', 'name', 'email', 'data', ts);
    // We need:
    // INSERT OR IGNORE INTO people (id, email, data, updatedAt) VALUES ('id', 'email', 'data', ts);

    // Find the VALUES part
    const valuesMatch = line.match(/VALUES \(([^)]+)\)/);
    if (!valuesMatch) {
        console.error('Could not parse line:', line.substring(0, 100));
        return null;
    }

    // Split the values by comma, but be careful with commas inside JSON strings
    const valuesStr = valuesMatch[1];

    // Simple approach: extract the values using regex
    const match = line.match(/VALUES \('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'(\{[^}]+\})',\s*(\d+)\)/);
    if (!match) {
        console.error('Could not extract values from line:', line.substring(0, 100));
        return null;
    }

    const [, id, name, email, jsonData, updatedAt] = match;

    // Reconstruct without the name column
    return `INSERT OR IGNORE INTO people (id, email, data, updatedAt) VALUES ('${id}', '${email}', '${jsonData}', ${updatedAt});`;
});

const validLines = fixedPeopleLines.filter(Boolean);
console.log(`Fixed ${validLines.length} people INSERT statements.`);

// Now import them
console.log(`Starting migration...`);

let successCount = 0;
let errorCount = 0;

for (let i = 0; i < validLines.length; i++) {
    const sql = validLines[i];
    const tempFile = `temp_person_correct_${i}.sql`;

    try {
        fs.writeFileSync(tempFile, sql);

        execSync(`npx wrangler d1 execute imap-sales-db --file=${tempFile} --local`, {
            stdio: 'pipe',
            encoding: 'utf-8'
        });

        successCount++;
        fs.unlinkSync(tempFile);

        if ((i + 1) % 10 === 0) {
            console.log(`Progress: ${i + 1}/${validLines.length} people inserted`);
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
