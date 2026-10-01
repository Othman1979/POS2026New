# Dependency and spooler warning cleanup

The application audit reported six affected packages (two high, four moderate); the spooler audit reported five high findings. Both final lockfiles now report zero known vulnerabilities. This is an npm advisory result, not proof of absence of all security defects.

The application uses Multer 2.3.0, mysql2 3.24.4 and Vitest/coverage 4.1.11, with the compatible qs transitive update. The spooler uses Puppeteer 25.10.0 and Canvas 3.2.3. The user explicitly approved dropping Node 20 support; the minimum is now Node 22.12. Obsolete transitive overrides were removed, retaining the existing disabled request adapter.

Puppeteer 25 removes Browser.isConnected(). A real renderer run caught that incompatibility; browser reuse and health now use Browser.connected, including matching test doubles. Unsupported Node versions fail before dependency or configuration loading. The installer already ships Node 22.23. The updater checks installed Node before stopping the service or copying files. Its runtime transition replaces node_modules/browser cache, not Node itself; a legacy Node 20 installation must upgrade Node first.

The unused C# pageStarted assignments were removed. Error cleanup still uses documentStarted and AbortPrinter, and normal EndPagePrinter/EndDocPrinter calls remain unchanged. The helper compiled successfully with /warnaserror+.

Verification:

- Clean spooler npm ci under the packaged Node 22.23: passed; zero audit findings.
- All 31 spooler test files passed under Node 22.23, including real Chromium rendering, page reuse, transport/retry tests and old-runtime rejection.
- Database pool/runtime, package and print golden/parity tests: 91/91.
- Product upload and system-icon tests: 49/49.
- Windows installer/update contracts: 72/72.
- Production frontend build: passed.
- Final app and spooler npm audits: zero findings.

The prebuild-install 7.1.3 deprecation remains upstream: Canvas 3.2.3 still uses it to obtain its native binary. Funding messages are informational. Neither message is hidden or treated as an audit vulnerability. No physical-printer validation or installer EXE rebuild is claimed here.

Sources: [Multer advisory](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm), [mysql2 advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr), [unpatched extract-zip advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), [Canvas 3.2.3 dependency manifest](https://github.com/Automattic/node-canvas/blob/v3.2.3/package.json). Raw local evidence is in scratch/*audit-final.json, scratch/spooler-clean-final-tests.log, scratch/dependency-focused-tests.log, scratch/dependency-upload-tests.log and scratch/dependency-installer-final.log.
