const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-menu-test-'));
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    const output = path.join(dist, 'public_menu.json');
    const previous = JSON.stringify({ products: [{ id: 99 }] });
    fs.writeFileSync(output, previous);
    const io = { ...fs.promises, writeFile: vi.fn(fs.promises.writeFile) };
    const db = { query: vi.fn(async sql => sql.includes('FROM categories') ? [[{ id: 1 }]] : [[{ id: 1, name: 'Burger' }]]) };
    const logger = { info: vi.fn(), error: vi.fn() };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve('backend/config/menuCache.js'), 'utf8'), {
        module, __dirname: path.join(root, 'backend', 'config'), process,
        require: name => {
            if (name === 'fs') return { ...fs, promises: io };
            if (name === './db') return db;
            if (name === './logger') return logger;
            if (name === './settingsHelper') return { getSettings: async () => ({ admin_language: 'ar' }) };
            return require(name);
        },
    });
    return { ...module.exports, root, output, previous, io, db, logger };
}

describe('public digital menu publication', () => {
    const fixtures = [];
    afterEach(() => {
        for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.root, { recursive: true, force: true });
    });
    const create = () => { const fixture = harness(); fixtures.push(fixture); return fixture; };

    it('keeps the last complete JSON visible while its replacement is being written', async () => {
        const h = create();
        const started = deferred();
        const resume = deferred();
        h.io.writeFile.mockImplementationOnce(async (file, value) => {
            await fs.promises.writeFile(file, value.slice(0, 8));
            started.resolve();
            await resume.promise;
            await fs.promises.writeFile(file, value);
        });
        const generation = h.generateStaticMenu();
        await started.promise;
        const duringWrite = fs.readFileSync(h.output, 'utf8');
        resume.resolve();
        await generation;
        expect(duringWrite).toBe(h.previous);
        expect(JSON.parse(fs.readFileSync(h.output, 'utf8')).products[0].name).toBe('Burger');
    });

    it('preserves the old menu and cleans partial output when disk writing fails', async () => {
        const h = create();
        h.io.writeFile.mockImplementationOnce(async file => {
            await fs.promises.writeFile(file, '{broken');
            throw new Error('disk full');
        });
        await h.generateStaticMenu();
        expect(fs.readFileSync(h.output, 'utf8')).toBe(h.previous);
        expect(fs.readdirSync(path.dirname(h.output))).toEqual(['public_menu.json']);
        expect(h.logger.error).toHaveBeenCalledOnce();
        await h.generateStaticMenu();
        expect(JSON.parse(fs.readFileSync(h.output, 'utf8')).products).toHaveLength(1);
    });

    it('lets concurrent cold-menu callers await publication and coalesces rebuild notifications', async () => {
        const h = create();
        fs.unlinkSync(h.output);
        const started = deferred();
        const resume = deferred();
        h.io.writeFile.mockImplementationOnce(async (file, value) => {
            started.resolve();
            await resume.promise;
            await fs.promises.writeFile(file, value);
        });
        const first = h.generateStaticMenu();
        await started.promise;
        let finished = 0;
        const others = Array.from({ length: 10 }, () => h.generateStaticMenu().then(() => { finished++; }));
        await Promise.resolve();
        const premature = finished;
        resume.resolve();
        await Promise.all([first, ...others]);
        expect(premature).toBe(0);
        expect(finished).toBe(10);
        expect(h.io.writeFile).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fs.readFileSync(h.output, 'utf8')).store.admin_language).toBe('ar');
    });
});
