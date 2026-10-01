const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const builder = path.resolve(__dirname, '../../../scripts/build-hostinger-source.ps1');

it('builds a portable source ZIP through Windows PowerShell without packaging private files or dependencies', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-source-archive-test-'));
    const repo = path.join(fixture, 'source with spaces'), output = path.join(fixture, 'candidate');
    const write = (file, content) => {
        const target = path.join(repo, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const execute = (command, args) => {
        const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 60000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return result.stdout.trim();
    };
    try {
        fs.mkdirSync(output);
        write('package.json', JSON.stringify({ name: 'archive-fixture', version: '1.0.0', scripts: { build: 'node src/build.cjs && node scripts/verify-production-build.cjs' } }));
        write('package-lock.json', '{}');
        for (const file of ['index.html', 'login.html', 'admin.html', 'menu.html', 'print_receipt.html', 'server.js', 'vite.config.mjs', 'manifest.json']) write(file, 'fixture');
        write('src/build.cjs', `const fs=require('node:fs');
            process.stderr.write('Informational native stderr\\n');
            fs.mkdirSync('dist/chunks',{recursive:true});
            for(const name of ['index','login','admin','menu','print_receipt']) fs.writeFileSync('dist/'+name+'.html','built');
            fs.writeFileSync('dist/chunks/nested.js','nested');`);
        // The real build ends with this verifier, so the archive must carry it.
        write('scripts/verify-production-build.cjs', "require('node:fs').accessSync('dist/index.html');");
        write('src/nested space/source.js', 'source');
        write('.env', 'PRIVATE_FIXTURE_VALUE=excluded');
        write('backend/.env', 'PRIVATE_FIXTURE_VALUE=excluded');
        write('backend/tests/private.test.js', 'excluded');
        write('.gitignore', 'node_modules/\n');
        write('backend/migrations/fixture.sql', '\uFEFFSELECT 1;\r\n');
        write('backend/migrations/auto-manifest.json', JSON.stringify({ migrations: [{ file: 'fixture.sql', sha256: createHash('sha256').update('SELECT 1;\n').digest('hex') }] }));
        write('deployment/database/manifest.json', JSON.stringify({ baseline: { id: 'fixture-baseline' } }));
        write('pos-spooler-printer/package.json', JSON.stringify({ version: '1.0.0' }));
        write('node_modules/vite/bin/vite.js', 'fixture-dependency');
        execute('git', ['init', '--quiet']);
        execute('git', ['-c', 'core.autocrlf=false', 'add', '.']);
        execute('git', ['-c', 'user.name=Archive fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
        execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', builder, '-Repo', repo, '-OutputDirectory', output]);

        const inspector = path.join(fixture, 'inspect.ps1');
        fs.writeFileSync(inspector, `param([string]$Zip)
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive=[IO.Compression.ZipFile]::OpenRead($Zip)
            try {
                $stream=$archive.GetEntry('release.json').Open()
                $buffer=[IO.MemoryStream]::new()
                try {$stream.CopyTo($buffer);$metadata=[Convert]::ToBase64String($buffer.ToArray())}
                finally {$stream.Dispose();$buffer.Dispose()}
                @{names=@($archive.Entries | ForEach-Object {$_.FullName});metadata=$metadata} | ConvertTo-Json -Compress
            } finally {$archive.Dispose()}`);
        const archive = JSON.parse(execute('powershell.exe', ['-NoProfile', '-File', inspector, '-Zip', path.join(output, 'POSAPP-Hostinger-source.zip')]));
        expect(archive.names).toEqual(expect.arrayContaining(['src/nested space/source.js', 'dist/chunks/nested.js', 'dist/index.html', 'dist/login.html', 'backend/migrations/fixture.sql', 'scripts/verify-production-build.cjs']));
        expect(archive.names.every(name => !name.includes('\\') && !name.includes('.env') && !name.includes('node_modules') && !name.includes('/tests/'))).toBe(true);
        const metadata = Buffer.from(archive.metadata, 'base64').toString('utf8');
        expect(metadata.startsWith('\uFEFF')).toBe(false);
        expect(JSON.parse(metadata).commit).toBe(execute('git', ['rev-parse', 'HEAD']));
        expect(execute('git', ['status', '--porcelain'])).toBe('');
        expect(fs.readFileSync(path.join(repo, 'node_modules/vite/bin/vite.js'), 'utf8')).toBe('fixture-dependency');
    } finally {
        expect(path.dirname(fs.realpathSync(fixture))).toBe(fs.realpathSync(os.tmpdir()));
        fs.rmSync(fixture, { recursive: true });
    }
}, 90000);
