"""Combined restaurant acceptance against the isolated review server on port 3013.

Start recipe-ledger-phase3-browser-server.cjs with a fresh POSAPP_REVIEW_DB.
Business writes use the built UI; HTTP reads provide independent numeric evidence.
"""
import argparse
import json
import re
import os
import subprocess
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--language', choices=['en', 'ar'], default='en')
parser.add_argument('--output', required=True)
parser.add_argument('--database', required=True, help='The dedicated database used by the review server')
args = parser.parse_args()
if not re.fullmatch(r'posapp_review_recipe_p1_[a-f0-9]{12}', args.database):
    parser.error('--database must be a dedicated recipe review database')
screenshots = Path(args.output).parent / (Path(args.output).stem + '-screenshots')
screenshots.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:3013'
translations = json.loads(Path('src/shared/i18n/ar.json').read_text(encoding='utf-8'))
steps = []
stage = 'start'

def t(value):
    return translations.get(value, value) if args.language == 'ar' else value

def button(scope, name):
    return scope.get_by_role('button', name=re.compile('^' + re.escape(t(name)) + '$', re.I))

def api(method, path, data=None):
    response = getattr(context.request, method)(base + '/api/' + path, data=data)
    assert response.ok, f'{path}: {response.status}: {response.text()}'
    return response.json()

def go(path):
    page.goto(base + path)
    page.wait_for_load_state('networkidle')

def capture(name, evidence):
    steps.append({'step': name, 'evidence': evidence})
    print(json.dumps(steps[-1], ensure_ascii=True), flush=True)

def row(name):
    return page.get_by_role('row').filter(has=page.get_by_text(name, exact=True))

def summary(item):
    return next(r for r in api('get', 'admin/ingredients')['ingredients'] if r['id'] == item['id'])

def remaining(item, qty):
    actual = summary(item)['expected_remaining']
    assert actual == qty, f'{item["name"]}: expected {qty}, got {actual}'

def save_dialog(path):
    with page.expect_response(lambda r: path in r.url and r.request.method in ['POST', 'PUT']) as caught:
        button(page.get_by_role('dialog'), 'Save').click()
    response = caught.value
    assert response.ok, response.text()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.wait_for_load_state('networkidle')
    return response.json()

def toggle(enabled):
    go('/admin/settings')
    box = page.locator('label').filter(has_text=t('Recipe ingredients')).locator('input[type=checkbox]')
    box.set_checked(enabled)
    with page.expect_response(lambda r: '/api/system/settings' in r.url and r.request.method == 'POST') as saved:
        button(page, 'Save settings').first.click()
    assert saved.value.ok, saved.value.text()
    page.wait_for_load_state('networkidle')

def create_ingredient(name, measure, unit, cost, pack, size, par=None):
    button(page, 'Add ingredient').click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label(t('Name'), exact=True).fill(name)
    dialog.get_by_label(t('Measure'), exact=True).select_option(measure)
    dialog.get_by_label(t('Display unit'), exact=True).select_option(unit)
    for label, value in [('Cost', cost), ('Pack name', pack), ('Pack size', size), ('Par', par)]:
        if value is not None:
            dialog.get_by_label(t(label), exact=True).fill(str(value))
    return save_dialog('/api/admin/ingredients')['ingredient']

def edit_recipe(product, ingredient, qty):
    go('/admin/inventory')
    button(row(product), 'Edit Item').click()
    dialog = page.get_by_role('dialog')
    button(dialog, 'Recipe').click()
    dialog.get_by_label(t('Add ingredient'), exact=True).select_option(str(ingredient['id']))
    button(dialog, 'Add').click()
    dialog.get_by_role('row').filter(has=page.get_by_text(ingredient['name'], exact=True)).locator('input').fill(str(qty))
    with page.expect_response(lambda r: '/recipe' in r.url and r.request.method == 'PUT') as saved:
        button(dialog, 'Save').click()
    assert saved.value.ok, saved.value.text()
    expect(dialog.get_by_text('0.90' if product == 'Test Burger' else '0.35', exact=True)).to_be_visible()
    if product == 'Test Burger':
        expect(dialog.get_by_text('82%', exact=True)).to_be_visible()
    page.keyboard.press('Escape')

def movement(item, kind, qty, **fields):
    go('/admin/ingredients')
    button(row(item['name']), kind).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label(t('Quantity'), exact=True).fill(str(qty))
    for label, value in fields.items():
        control = dialog.get_by_label(t(label), exact=True)
        if label == 'Reason': control.select_option(value)
        else: control.fill(str(value))
    return save_dialog(f'/api/admin/ingredients/{item["id"]}/movements')

def pay():
    expect(page.locator('.divide-y tr').first).to_be_visible()
    button(page, 'Pay').click()
    dialog = page.get_by_role('dialog', name=t('Complete Payment'))
    with page.expect_response(lambda r: '/api/pos/checkout' in r.url and r.request.method == 'POST') as paid:
        dialog.get_by_role('button', name=re.compile(re.escape(t('CONFIRM PAYMENT')), re.I)).click()
    assert paid.value.ok, paid.value.text()
    payload = paid.value.json()
    if page.locator('.swal2-confirm').is_visible(): page.locator('.swal2-confirm').click()
    page.wait_for_load_state('networkidle')
    return payload

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script("window.print = () => { window.__printed = true; };")
    context.add_init_script(f"localStorage.setItem('pos_admin_language', '{args.language}')")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    result = {'language': args.language, 'steps': steps}
    try:
        api('post', 'auth/login', {'user_number': '9001'})
        api('post', 'system/settings', {'admin_language': args.language})
        stage = 'disabled sale'
        toggle(False)
        go('/admin/inventory')
        expect(page.locator('a[href="/admin/ingredients"]')).to_have_count(0)
        go('/pos')
        button(page, 'Start Shift').click()
        page.locator('.btn-3d').filter(has_text='Test Burger').first.click()
        disabled_sale = pay()
        capture(stage, {'invoice': disabled_sale['invoice_id']})
        stage = 'ingredient and recipe setup'
        toggle(True)
        go('/admin/ingredients')
        suffix = args.language + ' ' + uuid.uuid4().hex[:5]
        chicken = create_ingredient('Chicken ' + suffix, 'weight', 'kg', 4.5, 'sack', 10, 5)
        pepsi = create_ingredient('Pepsi ' + suffix, 'count', 'unit', 0.35, 'carton', 24)
        edit_recipe('Test Burger', chicken, 0.2)
        edit_recipe('Test Drink', pepsi, 1)
        capture(stage, {'chicken_id': chicken['id'], 'pepsi_id': pepsi['id'], 'plate_cost': 0.9, 'margin_percent': 82})
        # A receipt before opening must remain excluded after correcting it later.
        movement(chicken, 'Receive', 1)
        go('/admin/ingredients')
        button(page, "Set today's opening").click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label(chicken['name'] + ' (kg)', exact=True).fill('10')
        dialog.get_by_label(pepsi['name'] + ' (unit)', exact=True).fill('100')
        save_dialog('/api/admin/ingredients/opening')
        remaining(chicken, 10000)
        remaining(pepsi, 100)
        stage = 'table save and resave'
        go('/tables')
        page.locator('[data-testid="table-card"][data-table-number="1"]').click()
        burger = page.locator('.btn-3d').filter(has_text='Test Burger').first
        drink = page.locator('.btn-3d').filter(has_text='Test Drink').first
        for _ in range(3): burger.click()
        for _ in range(2): drink.click()
        with page.expect_response(lambda r: '/api/pos/table_order' in r.url and r.request.method == 'POST') as saved:
            button(page, 'Save Table').click()
        assert saved.value.ok, saved.value.text()
        page.wait_for_load_state('networkidle')
        remaining(chicken, 9400)
        remaining(pepsi, 98)
        with page.expect_response(lambda r: '/api/pos/table_order' in r.url and r.request.method == 'POST') as resaved:
            button(page, 'Save Table').click()
        assert resaved.value.ok, resaved.value.text()
        page.wait_for_load_state('networkidle')
        remaining(chicken, 9400)
        burger.click()
        expect(page.locator('.divide-y tr').filter(has_text='Test Burger')).to_have_count(4)
        with page.expect_response(lambda r: '/api/pos/table_order' in r.url and r.request.method == 'POST') as added:
            button(page, 'Save Table').click()
        assert added.value.ok, added.value.text()
        page.wait_for_load_state('networkidle')
        remaining(chicken, 9200)
        capture(stage, {'after_resave_chicken_g': 9400, 'after_added_burger_g': 9200, 'pepsi': 98})
        stage = 'split and settle'
        button(page, 'Split').click()
        dialog = page.get_by_role('dialog', name=t('Split Check'))
        source = dialog.locator('.split-source-pane')
        # Two burgers per seat; both drinks go to seat one.
        for _ in range(2): source.get_by_role('button', name=re.compile('Test Burger')).first.click()
        for _ in range(2): source.get_by_role('button', name=re.compile('Test Drink')).first.click()
        button(dialog, 'Finalize Splits').click()
        page.wait_for_url(re.compile('/tables$'))
        remaining(chicken, 9200)
        paid_invoices = []
        for _ in range(2):
            go('/table-splits')
            button(page, 'Pay').first.click()
            page.wait_for_url(re.compile('/pos$'))
            page.wait_for_load_state('networkidle')
            paid_invoices.append(pay()['invoice_id'])
            # Payment commits before the POS finishes its return navigation.
            # Wait for that transition before opening the next split check.
            page.wait_for_url(re.compile('/tables$'))
            page.wait_for_load_state('networkidle')
        remaining(chicken, 9200)
        remaining(pepsi, 98)
        capture(stage, {'invoices': paid_invoices, 'settlement_does_not_repeat_usage': True})
        stage = 'partial refund'
        go('/admin/orders')
        button(page, 'Tables').click()
        page.wait_for_load_state('networkidle')
        # The latest invoice is the second seat and contains burgers only.
        order = page.locator('tbody tr').first
        button(order, 'More').click()
        button(order, 'Refund').click()
        dialog = page.get_by_role('dialog', name=t('Refund'), exact=True)
        button(dialog, 'Deselect All').click()
        dialog.locator('button').filter(has=page.locator('.fa-plus')).first.click()
        with page.expect_response(lambda r: '/api/pos/refunds' in r.url and r.request.method == 'POST') as refund:
            button(dialog, 'Confirm Refund').click()
        assert refund.value.ok, refund.value.text()
        assert refund.value.request.post_data_json['invoice_id'] == paid_invoices[-1]
        expect(dialog).not_to_be_visible()
        remaining(chicken, 9400)
        assert summary(chicken)['today']['used_cost'] == 2.7, summary(chicken)
        portions = api('get', 'admin/ingredients/portions?product_id=1')
        assert portions['portions'][0]['portions_possible'] == 47, portions
        capture(stage, {'chicken_g': 9400, 'used_cost': 2.7, 'portions_response': portions})
        stage = 'receipt waste correction and count'
        movement(chicken, 'Receive', 2, **{'Receipt cost': 4.2})
        movement(chicken, 'Waste', 0.5, Reason='spoiled')
        remaining(chicken, 10900)
        button(row(chicken['name']), 'History').click()
        dialog = page.get_by_role('dialog')
        with page.expect_response(lambda r: '/correct' in r.url and r.request.method == 'POST') as corrected:
            button(dialog, 'Correct').first.click()
        assert corrected.value.ok, corrected.value.text()
        page.wait_for_load_state('networkidle')
        remaining(chicken, 11400)
        # The oldest remaining correctable row is the receipt before opening.
        with page.expect_response(lambda r: '/correct' in r.url and r.request.method == 'POST') as corrected:
            button(dialog, 'Correct').last.click()
        assert corrected.value.ok, corrected.value.text()
        page.wait_for_load_state('networkidle')
        remaining(chicken, 11400)
        page.keyboard.press('Escape')
        movement(chicken, 'Count', 11.1)
        remaining(chicken, 11100)
        assert summary(chicken)['last_count']['variance_qty'] == -300, summary(chicken)
        capture(stage, {'expected_before_count_g': 11400, 'counted_g': 11100, 'variance_g': -300})
        stage = 'day report and print'
        go('/admin/reports-ingredients')
        date = page.locator('.ingredients-report input[type=date]').input_value()
        report = api('get', 'admin/reports/ingredients?date=' + date)
        report_row = next(r for r in report['ingredients'] if r['id'] == chicken['id'])
        for key, value in {'opening': 10000, 'used': 600, 'closing_expected': 11100, 'used_cost': 2.7}.items():
            assert report_row[key] == value, report_row
        assert report_row['counts'][-1]['variance_qty'] == -300, report_row
        assert next(r for r in report['ingredients'] if r['id'] == pepsi['id'])['closing_expected'] == 98
        expect(row(chicken['name'])).to_contain_text('11.1')
        for label in ['Thermal (80mm)', 'Detailed A4']:
            button(page, 'Print').click()
            with page.expect_popup() as popup_event:
                page.get_by_role('menuitem').filter(has_text=t(label)).click()
            popup = popup_event.value
            popup.wait_for_function('() => window.__printed === true')
            expect(popup.locator('body')).to_contain_text('11.1 kg')
            popup.close()
        page.screenshot(path=str(screenshots / f'phase4-{args.language}-report.png'), full_page=True)
        capture(stage, {'chicken_report': report_row, 'a4_and_thermal_rendered': True})
        stage = 'opening prefill and refund while disabled'
        rollover = subprocess.run(['node', 'scripts/reviews/recipe-ledger-phase4-rollover.cjs',
            json.dumps([{'id': i['id'], 'name': i['name']} for i in [chicken, pepsi]])],
            env={**os.environ, 'POSAPP_REVIEW_DB': args.database}, capture_output=True, text=True, encoding='utf-8', check=True)
        assert json.loads(rollover.stdout.splitlines()[-1])['shiftedRows'] > 0
        assert summary(chicken)['today']['used'] == 0, summary(chicken)
        go('/admin/ingredients')
        button(page, "Set today's opening").click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_label(chicken['name'] + ' (kg)', exact=True)).to_have_value('11.1')
        dialog.get_by_label(chicken['name'] + ' (kg)', exact=True).fill('11')
        save_dialog('/api/admin/ingredients/opening')
        remaining(chicken, 11000)
        toggle(False)
        go('/admin/orders')
        button(page, 'Tables').click()
        page.wait_for_load_state('networkidle')
        order = page.locator('tbody tr').first
        button(order, 'More').click()
        button(order, 'Refund').click()
        dialog = page.get_by_role('dialog', name=t('Refund'), exact=True)
        button(dialog, 'Deselect All').click()
        dialog.locator('button:enabled').filter(has=page.locator('.fa-plus')).first.click()
        with page.expect_response(lambda r: '/api/pos/refunds' in r.url and r.request.method == 'POST') as refund:
            button(dialog, 'Confirm Refund').click()
        assert refund.value.ok, refund.value.text()
        assert sum(item['qty'] for item in refund.value.request.post_data_json['items']) == 1
        expect(dialog).not_to_be_visible()
        remaining(chicken, 11200)
        remaining(pepsi, 98)
        capture(stage, {'prior_history_shifted_to_yesterday': True, 'opening_prefill_kg': 11.1, 'opening_saved_kg': 11, 'disabled_refund_remaining_g': 11200})
        assert not errors, errors
        result['status'] = 'passed'
    except Exception as error:
        result.update(status='failed', failed_stage=stage, error=str(error), page_errors=errors)
        page.screenshot(path=str(screenshots / f'phase4-{args.language}-failure.png'), full_page=True)
        result['visible_text'] = page.locator('body').inner_text()[-12000:]
    finally:
        Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(json.dumps({k: v for k, v in result.items() if k != 'steps'}, ensure_ascii=True), flush=True)
        browser.close()
raise SystemExit(0 if result['status'] == 'passed' else 1)
