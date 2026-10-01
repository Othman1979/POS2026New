// Real Settings component and HTTP helper; generated responses only. No DB or printer.
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
    const root = path.resolve(__dirname, '../..');
    const out = path.join(root, 'scratch/order-type-numbering-browser');
    fs.mkdirSync(out, { recursive: true });
    const { createServer } = await import('vite');
    const vue = (await import('@vitejs/plugin-vue')).default;
    const tailwind = (await import('@tailwindcss/vite')).default;
    const boot = `import { createApp } from 'vue';
        import Settings from '/src/admin/pages/Settings.vue';
        import { t } from '/src/shared/i18n.js';
        import '/src/admin/styles.css';
        window.alerts=[]; window.uiErrors=[];
        window.showAdminAlert=async message=>window.alerts.push(message);
        const app=createApp(Settings); app.config.globalProperties.$t=t;
        app.config.errorHandler=error=>window.uiErrors.push(error.message);
        app.mount('#app');`;
    const server = await createServer({ configFile:false, envFile:false, root,
        optimizeDeps:{noDiscovery:true,include:['vue','qrcode']},
        resolve:{alias:{'@':path.join(root,'src')}},
        plugins:[{name:'numbering-review',
            resolveId(id){if(id==='/numbering-entry.js')return '\0numbering-entry';},
            load(id){if(id==='\0numbering-entry')return boot;},
            configureServer(s){s.middlewares.use(async(req,res,next)=>{
                if(req.url!=='/__numbering_review')return next();
                res.setHeader('Content-Type','text/html');
                res.end(await s.transformIndexHtml('/__numbering_review','<div id="app" style="height:100vh;padding:16px"></div><script type="module" src="/numbering-entry.js"></script>'));
            });}
        },tailwind(),vue()],server:{host:'127.0.0.1',port:0}
    });
    let browser;
    const results=[];
    try {
        await server.listen();
        browser=await chromium.launch({headless:true});
        for(const [language,width] of [['en',1280],['ar',390]]) {
            const page=await browser.newPage({viewport:{width,height:900}});
            const errors=[];page.on('pageerror',e=>errors.push(e.message));
            let saved='0';
            await page.route('**/api/**',async route=>{
                const request=route.request(), url=new URL(request.url());
                let body={success:true,data:[],categories:[],stations:[],settings:{enabled:false}};
                if(url.pathname.endsWith('/system/settings')) {
                    if(request.method()==='POST') saved=request.postDataJSON().order_type_numbering;
                    body={success:true,order_type_numbering:saved,admin_language:language};
                }
                await route.fulfill({json:body});
            });
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__numbering_review`);
            await page.waitForLoadState('networkidle');
            fs.writeFileSync(path.join(out,`${language}-diagnostics.json`),JSON.stringify({errors,ui:await page.evaluate(()=>({errors:window.uiErrors,alerts:window.alerts,text:document.body.innerText}))},null,2));
            const title=language==='ar'?'تسلسل أرقام مستقل لكل نوع طلب':'Separate order numbers by order type';
            const toggle=page.getByRole('checkbox',{name:new RegExp(title)});
            const save=page.getByRole('button',{name:language==='ar'?'حفظ الإعدادات':'Save settings',exact:true});
            await expect(toggle).not.toBeChecked();
            await toggle.check();
            await save.click();
            await expect.poll(()=>saved).toBe('1');
            await page.reload();await page.waitForLoadState('networkidle');
            await expect(toggle).toBeChecked();
            await toggle.scrollIntoViewIfNeeded();
            await toggle.locator('..').screenshot({path:path.join(out,`${language}-setting.png`)});
            await toggle.uncheck();await save.click();
            await expect.poll(()=>saved).toBe('0');
            await page.reload();await expect(toggle).not.toBeChecked();
            expect(await page.evaluate(()=>window.alerts)).toEqual([]);
            expect(await page.evaluate(()=>window.uiErrors)).toEqual([]);
            expect(errors).toEqual([]);
            results.push({language,width,defaultOff:true,enabledPersisted:true,disabledPersisted:true,errors});
            await page.close();
        }
        fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
        console.log(JSON.stringify(results));
    } finally {await browser?.close();await server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
