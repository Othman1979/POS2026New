"""Browser regressions against the isolated Phase 3 server on port 3013.

Run with a Python environment containing Playwright and an installed Chromium.
The server seeds its own scratch database; these cases create named test data.
"""
import argparse
import json
import re
import time
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

BASE = 'http://127.0.0.1:3013'
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='scripts/reviews/recipe-ledger-phase3-browser-results.json')
parser.add_argument('--case')
args = parser.parse_args()
results = []
Path('scripts/reviews/screenshots').mkdir(exist_ok=True)

def api(context, method, path, data=None):
    response = getattr(context.request, method)(BASE + '/api/' + path, data=data)
    payload = response.json()
    assert response.ok, f'{method} {path}: {response.status}: {payload}'
    return payload

def ingredient(context, **extra):
    return api(context, 'post', 'admin/ingredients', {
        'name': 'Review ' + uuid.uuid4().hex[:8], 'measure': 'weight', 'display_unit': 'kg',
        'unit_cost': 4.5, 'par_qty': 5, 'pack_name': 'sack', 'pack_size': 10, **extra
    })['ingredient']

def movement(context, item, kind, qty, **extra):
    return api(context, 'post', f'admin/ingredients/{item["id"]}/movements', {
        'kind': kind, 'qty': qty, 'unit': 'kg', 'client_key': str(uuid.uuid4()), **extra
    })

def open_page(page, path='ingredients'):
    page.goto(BASE + '/admin/' + path)
    page.wait_for_load_state('networkidle')

def row_for(page, item):
    return page.get_by_role('row').filter(has=page.get_by_text(item['name'], exact=True))

def summary(context, item):
    return next(row for row in api(context, 'get', 'admin/ingredients')['ingredients'] if row['id'] == item['id'])

def case(name):
    def decorate(fn):
        if args.case and args.case != name:
            return fn
        start = time.monotonic()
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        try:
            api(context, 'post', 'auth/login', {'user_number': '9001'})
            api(context, 'post', 'system/settings', {'recipe_ledger_enabled': '1', 'admin_language':'en'})
            evidence = fn(page, context)
            results.append({'case': name, 'status': 'passed', 'evidence': evidence})
        except Exception as error:
            results.append({'case': name, 'status': 'failed', 'error': str(error)[:1800]})
            Path('scripts/reviews/screenshots').mkdir(exist_ok=True)
            page.screenshot(path=f'scripts/reviews/screenshots/phase3-{name}.png', full_page=True)
        finally:
            results[-1]['seconds'] = round(time.monotonic() - start, 2)
            print(json.dumps(results[-1], ensure_ascii=True), flush=True)
            context.close()
        return fn
    return decorate

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)

    @case('ingredient-controls')
    def controls(page, context):
        item = ingredient(context)
        open_page(page)
        button = page.get_by_role('button', name='Add ingredient', exact=True)
        height = button.bounding_box()['height']
        assert height >= 36, f'Add ingredient button is {height}px high'
        return {'button_height': height}

    @case('display-unit-preserves-values')
    def display_unit(page, context):
        item = ingredient(context)
        open_page(page)
        row_for(page, item).get_by_role('button', name='Edit', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.locator('select').nth(1).select_option('g')
        with page.expect_response(lambda r: f'/api/admin/ingredients/{item["id"]}' in r.url and r.request.method == 'PUT') as response:
            dialog.get_by_role('button', name='Save', exact=True).click()
        stored = response.value.json()['ingredient']
        expected = {'unit_cost': 0.0045, 'par_qty': 5000, 'pack_size': 10000}
        actual = {key: stored[key] for key in expected}
        assert actual == expected, f'display change altered stored values: {actual}'
        return actual

    @case('blank-count-is-not-zero')
    def blank_count(page, context):
        item = ingredient(context)
        open_page(page)
        row_for(page, item).get_by_role('button', name='Count', exact=True).click()
        try:
            with page.expect_response(lambda r: '/movements' in r.url and r.request.method == 'POST', timeout=2000) as response:
                page.get_by_role('dialog').get_by_role('button', name='Save', exact=True).click()
            assert not response.value.ok, 'blank Count was submitted successfully'
        except PlaywrightTimeout:
            pass
        state = summary(context, item)
        assert state['expected_remaining'] is None, f'blank form wrote Count {state["expected_remaining"]}'
        expect(page.get_by_role('dialog')).to_be_visible()
        return {'expected_remaining': state['expected_remaining']}

    @case('opening-lost-response-retry')
    def opening_retry(page, context):
        item = ingredient(context)
        open_page(page)
        page.get_by_role('button', name="Set today's opening", exact=True).click()
        dialog = page.get_by_role('dialog')
        draft = dialog.locator('div').filter(has=page.get_by_text(item['name'], exact=True)).filter(has=page.locator('input')).last
        # The ingredient name and quantity share one row in the opening form.
        page.get_by_text(item['name'], exact=True).last.locator('..').locator('input').first.fill('10')
        sent = []
        def lose_first_response(route):
            sent.append(route.request.post_data_json)
            response = route.fetch()
            if len(sent) == 1:
                assert response.ok
                route.abort('failed')
            else:
                route.fulfill(response=response)
        page.route('**/api/admin/ingredients/opening', lose_first_response)
        dialog.get_by_role('button', name='Save', exact=True).click()
        page.get_by_text('Failed to fetch', exact=True).wait_for()
        movement(context, item, 'receipt', 1)
        dialog.get_by_role('button', name='Save', exact=True).click()
        expect(dialog).not_to_be_visible()
        state = summary(context, item)
        assert len(sent) == 2
        assert sent[0]['client_key'] == sent[1]['client_key'], 'retry changed the opening client key'
        assert state['expected_remaining'] == 11000, f'retry erased intervening receipt: {state["expected_remaining"]}'
        return {'same_key': True, 'expected_remaining': state['expected_remaining']}

    @case('shopping-loose-quantity')
    def shopping(page, context):
        item = ingredient(context, pack_name=None, pack_size=None)
        movement(context, item, 'count', 4)
        open_page(page)
        page.get_by_role('button', name='Shopping list', exact=True).click()
        dialog = page.get_by_role('dialog')
        item_row = dialog.get_by_text(item['name'], exact=True).locator('..')
        expect(item_row).to_contain_text('1 kg')
        return {'item': item_row.inner_text()}

    @case('history-readable-units')
    def history_units(page, context):
        item = ingredient(context)
        movement(context, item, 'count', 10)
        open_page(page)
        row_for(page, item).get_by_role('button', name='History', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog).to_contain_text('10 kg')
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        return {'quantity': '10 kg', 'escape_closes': True}

    @case('ingredient-load-error')
    def load_error(page, context):
        page.route('**/api/admin/ingredients', lambda route: route.fulfill(status=500, json={'success':False,'message':'Review ingredient load failed'}))
        open_page(page)
        expect(page.get_by_text('Review ingredient load failed', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Retry', exact=True)).to_be_visible()
        return {'error_visible': True}

    @case('recipe-loading-cannot-clear-lines')
    def recipe_loading(page, context):
        item = ingredient(context)
        api(context, 'put', 'admin/products/1/recipe', {'lines':[{'ingredient_id':item['id'],'qty':0.2,'unit':'kg'}]})
        open_page(page, 'inventory')
        held = []
        def hold_recipe(route):
            if route.request.method == 'GET':
                held.append(route)
            else:
                route.continue_()
        page.route('**/api/admin/products/1/recipe', hold_recipe)
        page.get_by_role('row').filter(has=page.get_by_text('Test Burger', exact=True)).get_by_role('button', name='Edit Item', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='Recipe', exact=True).click()
        expect(dialog.get_by_role('button', name='Save', exact=True)).to_be_disabled()
        for route in held:
            route.continue_()
        expect(dialog.get_by_text(item['name'], exact=True)).to_be_visible()
        expect(dialog.get_by_role('button', name='Save', exact=True)).to_be_enabled()
        return {'save_disabled_until_recipe_loaded': True}

    @case('recipe-draft-hides-stale-cost')
    def recipe_cost(page, context):
        item = ingredient(context)
        api(context, 'put', 'admin/products/1/recipe', {'lines':[{'ingredient_id':item['id'],'qty':0.2,'unit':'kg'}]})
        open_page(page, 'inventory')
        page.get_by_role('row').filter(has=page.get_by_text('Test Burger', exact=True)).get_by_role('button', name='Edit Item', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='Recipe', exact=True).click()
        expect(dialog.get_by_text(item['name'], exact=True)).to_be_visible()
        expect(dialog.get_by_text('0.90', exact=True)).to_be_visible()
        dialog.get_by_role('row').filter(has=page.get_by_text(item['name'], exact=True)).locator('input').fill('0.4')
        expect(dialog.get_by_text('0.90', exact=True)).not_to_be_visible()
        return {'stale_cost_hidden_for_draft': True}

    @case('report-date-error-cannot-print-old-day')
    def report_error(page, context):
        open_page(page, 'reports-ingredients')
        expect(page.get_by_role('button', name='Print', exact=True)).to_be_enabled()
        page.route('**/api/admin/reports/ingredients?date=2026-08-01', lambda route: route.fulfill(
            status=500, json={'success':False, 'message':'Review day unavailable'}))
        page.locator('.ingredients-report input[type=date]').fill('2026-08-01')
        page.locator('.ingredients-report input[type=date]').dispatch_event('change')
        expect(page.get_by_text('Review day unavailable', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Print', exact=True)).to_be_disabled()
        expect(page.locator('.ingredients-report tbody tr')).to_have_count(0)
        expect(page.locator('.ingredients-report input[type=date]')).to_be_visible()
        return {'old_day_print_disabled': True, 'date_picker_still_available': True}

    @case('ingredient-report-is-one-day')
    def report_period(page, context):
        page.add_init_script("sessionStorage.setItem('pos_reports_start_date','2026-08-01'); sessionStorage.setItem('pos_reports_end_date','2026-08-03');")
        open_page(page, 'reports-ingredients')
        expect(page.locator('.report-period__count')).to_have_count(0)
        expect(page.locator('.ingredients-report input[type=date]')).to_have_value('2026-08-01')
        expect(page.get_by_role('button', name='Custom period', exact=True)).to_have_count(0)
        return {'report_and_header_use_one_business_day': True}

    @case('history-pagination-and-late-response')
    def history_pages(page, context):
        item = ingredient(context)
        movement(context, item, 'count', 10)
        for _ in range(51):
            movement(context, item, 'receipt', 0.001)
        open_page(page)
        row_for(page, item).get_by_role('button', name='History', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('button', name='Correct', exact=True)).to_have_count(50)
        dialog.get_by_role('button', name='Load more', exact=True).click()
        expect(dialog.get_by_role('button', name='Correct', exact=True)).to_have_count(51)
        expect(dialog).to_contain_text('10 kg')
        expect(dialog.get_by_role('button', name='Load more', exact=True)).to_have_count(0)
        page.keyboard.press('Escape')
        other = ingredient(context)
        movement(context, other, 'count', 3)
        open_page(page)
        held = []
        page.route(f'**/api/admin/ingredients/{item["id"]}/movements?*', lambda route: held.append(route))
        row_for(page, item).get_by_role('button', name='History', exact=True).click()
        expect(dialog.get_by_role('status')).to_be_visible()
        page.keyboard.press('Escape')
        row_for(page, other).get_by_role('button', name='History', exact=True).click()
        expect(dialog).to_contain_text('3 kg')
        for route in held:
            try: route.continue_()
            except Exception: pass  # The old request can already be aborted on close.
        expect(dialog).not_to_contain_text('10 kg')
        return {'paginated_rows':52,'old_request_cannot_replace_new_ingredient':True}

    @case('report-print-a4-and-thermal')
    def report_print(page, context):
        item = ingredient(context)
        movement(context, item, 'count', 10)
        movement(context, item, 'waste', 0.5, reason='spoiled')
        context.add_init_script('window.print = () => { window.__printed = true; };')
        open_page(page, 'reports-ingredients')
        for layout, label in [('thermal','Thermal (80mm)'),('a4','Detailed A4')]:
            page.get_by_role('button', name='Print', exact=True).click()
            with page.expect_popup() as popup_event:
                page.get_by_role('menuitem').filter(has_text=label).click()
            popup = popup_event.value
            popup.wait_for_function('() => window.__printed === true')
            expect(popup.locator('body')).to_contain_text('9.5 kg')
            expect(popup.locator('body')).to_contain_text('0.5 kg')
            expect(popup.locator('body')).to_contain_text('Spoiled')
            popup.screenshot(path=f'scripts/reviews/screenshots/phase3-print-{layout}.png',full_page=True)
            popup.close()
        return {'a4_and_thermal_rendered':True,'display_units_and_waste_reason':True,'physical_print':False}

    @case('arabic-mobile-ingredient-flow')
    def arabic_mobile(page, context):
        api(context, 'post', 'system/settings', {'admin_language':'ar'})
        page.set_viewport_size({'width':390,'height':844})
        page.add_init_script("localStorage.setItem('pos_admin_language','ar')")
        item = ingredient(context, name='دجاج اختبار ' + uuid.uuid4().hex[:5])
        open_page(page)
        expect(page.locator('.ingredients-page')).to_have_css('direction','rtl')
        overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
        assert not overflow, 'page overflows mobile viewport'
        page.get_by_role('button', name='إضافة مكون', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_label('الاسم',exact=True)).to_be_visible()
        dialog.get_by_label('الاسم',exact=True).fill('مكون جديد ' + uuid.uuid4().hex[:5])
        dialog.get_by_role('button', name='حفظ',exact=True).click()
        expect(dialog).not_to_be_visible()
        page.screenshot(path='scripts/reviews/screenshots/phase3-arabic-mobile.png',full_page=True)
        row_for(page,item).get_by_role('button',name='العدد',exact=True).click()
        dialog.get_by_role('button',name='حفظ',exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('أدخل الكمية')
        page.screenshot(path='scripts/reviews/screenshots/phase3-arabic-count.png',full_page=True)
        return {'rtl':True,'mobile_width':390,'create_saved':True,'blank_count_error_arabic':True}

    browser.close()

Path(args.output).write_text(json.dumps(results, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
raise SystemExit(1 if any(result['status'] == 'failed' for result in results) else 0)
