import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const packageJson = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const appVersion = packageJson.version || '0.0.0';

// index.html only loads the entry graph; main.js starts the register route (PosTerminal) after that graph
// has run. Preload the route's chunks and CSS so they download alongside the entry instead of after it.
// CSS is a preload, not a stylesheet, so POS CSS never blocks first paint of /tables or /order-notes.
function preloadRegisterRoute() {
    return {
        name: 'preload-register-route',
        transformIndexHtml: {
            order: 'post',
            handler(html, ctx) {
                if (!ctx.bundle || !/index\.html$/.test(ctx.filename || '')) return;
                const route = Object.values(ctx.bundle).find(
                    (c) => c.type === 'chunk' && c.facadeModuleId?.replaceAll('\\', '/').endsWith('/src/components/PosTerminal.vue'),
                );
                if (!route) return;
                const files = new Set();
                const pending = [route.fileName];
                while (pending.length) {
                    const file = pending.pop();
                    if (files.has(file)) continue;
                    files.add(file);
                    pending.push(...(ctx.bundle[file]?.imports || []));
                }
                const tags = [];
                const add = (attrs) => {
                    if (!html.includes(`"${attrs.href}"`)) tags.push({ tag: 'link', attrs: { ...attrs, crossorigin: '' }, injectTo: 'head' });
                };
                for (const file of files) add({ rel: 'modulepreload', href: `/${file}` });
                for (const file of files) {
                    for (const css of ctx.bundle[file]?.viteMetadata?.importedCss || []) add({ rel: 'preload', as: 'style', href: `/${css}` });
                }
                return tags;
            },
        },
    };
}

// Vue DevTools is a devDependency: load it only for the dev server, so a production build
// works where only production dependencies are installed (Hostinger's build).
export default defineConfig(async ({ command }) => ({
    define: {
        __POS_APP_VERSION__: JSON.stringify(appVersion)
    },
    // The root .env belongs to the Node server; Vite must not inherit NODE_ENV=development from it.
    envDir: false,
    // Dev-server only: component tree, Pinia inspector, render timeline.
    plugins: [
        tailwindcss(), vue(), preloadRegisterRoute(),
        ...(command === 'serve' ? (await import('vite-plugin-vue-devtools')).default() : []),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@posapp/permission-policy': fileURLToPath(new URL('./backend/config/permissionPolicy.cjs', import.meta.url)),
        },
    },
    optimizeDeps: { include: ['@posapp/permission-policy'] },
    build: {
        // Vite 6 default; Vite 8 would raise this to Chrome 111 / Safari 16.4.
        target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
        // Keep tiny Font Awesome subsets cacheable by style. Inlining the
        // regular/brands subsets would charge every screen for fonts it never uses.
        assetsInlineLimit(filePath) {
            if (filePath.endsWith('.woff2')) return false;
            return undefined;
        },
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 1000,
        rolldownOptions: {
            onwarn(warning, warn) {
                const warningPath = String(warning.id || '').replaceAll('\\', '/');
                if (warning.code === 'INVALID_ANNOTATION'
                    && warningPath.includes('/node_modules/@daybrush/utils/')) {
                    return;
                }
                warn(warning);
            },
            input: {
                index: 'index.html',
                login: 'login.html',
                admin: 'admin.html',
                print_receipt: 'print_receipt.html',
                menu: 'menu.html'
            },
            output: {
                entryFileNames: '[name]-[hash].js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
                codeSplitting: {
                    groups: [
                        { name: 'vendor-xlsx', test: /node_modules[\\/]xlsx[\\/]/ },
                        { name: 'vendor-chartjs', test: /node_modules[\\/](chart\.js|@kurkle[\\/]color)[\\/]/ },
                        { name: 'vendor-socketio', test: /node_modules[\\/](socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser)[\\/]/ },
                    ],
                },
            }
        }
    }
}));
