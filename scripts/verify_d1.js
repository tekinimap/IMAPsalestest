import { spawn } from 'child_process';

console.log("Verifying D1 data...");

function runQuery(query) {
    return new Promise((resolve, reject) => {
        const cmd = spawn('npx', ['wrangler', 'd1', 'execute', 'imap-sales-db', '--command', query, '--local', '--json'], { shell: true });
        let stdout = '';
        let stderr = '';

        cmd.stdout.on('data', (data) => { stdout += data; });
        cmd.stderr.on('data', (data) => { stderr += data; });

        cmd.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Command failed with code ${code}: ${stderr}`));
            } else {
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    resolve(stdout);
                }
            }
        });
    });
}

async function verify() {
    try {
        const entriesResult = await runQuery("SELECT count(*) as count FROM entries");
        const peopleResult = await runQuery("SELECT count(*) as count FROM people");

        console.log("Entries count:", entriesResult[0]?.results?.[0]?.count);
        console.log("People count:", peopleResult[0]?.results?.[0]?.count);

    } catch (err) {
        console.error("Verification failed:", err);
    }
}

verify();
