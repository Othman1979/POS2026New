"""Read request amplification through the real built Ingredients page on scratch port 3013."""
import json
import uuid
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = 'http://127.0.0.1:3013'
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='scripts/reviews/recipe-ledger-performance-browser-after.json')
parser.add_argument('--expected-outstanding', type=int, default=1)
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context()
    def post(path, body):
        response = context.request.post(base + '/api/' + path, data=body)
        assert response.ok, response.text()
        return response.json()
    post('auth/login', {'user_number':'9001'})
    post('system/settings', {'recipe_ledger_enabled':'1','admin_language':'en'})
    probe_name = 'Request probe ' + uuid.uuid4().hex[:8]
    saved_name = 'Saved request probe ' + uuid.uuid4().hex[:8]
    inactive_name = 'Inactive request probe ' + uuid.uuid4().hex[:8]
    item = post('admin/ingredients', {'name':probe_name,'measure':'weight','display_unit':'g'})['ingredient']
    page = context.new_page()
    page.goto(base + '/admin/ingredients')
    page.wait_for_load_state('networkidle')
    requests = []
    page.on('request', lambda req: requests.append(req.url) if req.method == 'GET' and req.url.split('?')[0].endswith('/api/admin/ingredients') else None)
    page.get_by_role('button',name='Add ingredient',exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_label('Name',exact=True).fill(saved_name)
    dialog.get_by_role('button',name='Save',exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.get_by_text(saved_name, exact=True)).to_be_visible()
    page.wait_for_load_state('networkidle')
    after_save = len(requests)
    requests.clear()
    held=[]
    hold_requests = True
    def intercept(route):
        if hold_requests:
            held.append(route)
        else:
            route.continue_()
    page.route('**/api/admin/ingredients**', intercept)
    post(f'admin/ingredients/{item["id"]}/movements', {'kind':'receipt','qty':1,'unit':'g','client_key':str(uuid.uuid4())})
    page.wait_for_timeout(150)
    assert len(held) == 1
    for _ in range(9):
        post(f'admin/ingredients/{item["id"]}/movements', {'kind':'receipt','qty':1,'unit':'g','client_key':str(uuid.uuid4())})
    # Allow the real socket notifications to start their page GETs.
    page.wait_for_timeout(500)
    result={'save_causes_list_gets':after_save,'receipt_events':10,'list_gets_while_previous_get_held':len(requests),'held_requests':len(held)}
    assert len(held)==args.expected_outstanding, result
    hold_requests = False
    for route in held: route.continue_()
    page.wait_for_load_state('networkidle')
    row = page.get_by_role('row').filter(has=page.get_by_text(probe_name, exact=True))
    expect(row.get_by_role('cell').nth(3)).to_have_text('10')
    result['burst_total_gets_after_followup'] = len(requests)
    if args.expected_outstanding == 1:
        assert len(requests) == 2, result
    result['latest_receipt_total_visible'] = 10

    # Filter changes during a held refresh must be applied by the follow-up.
    inactive = post('admin/ingredients', {'name':inactive_name,'measure':'count','display_unit':'unit'})['ingredient']
    response = context.request.put(base + f'/api/admin/ingredients/{inactive["id"]}', data={'is_active':False})
    assert response.ok, response.text()
    page.wait_for_timeout(150)
    page.wait_for_load_state('networkidle')
    requests.clear(); held.clear(); hold_requests = True
    page.evaluate("window.dispatchEvent(new Event('ingredients_changed'))")
    page.wait_for_timeout(150)
    assert len(held) == 1
    page.get_by_role('checkbox', name='Show inactive').check()
    page.wait_for_timeout(100)
    assert len(held) == 1
    hold_requests = False
    held[0].continue_()
    expect(page.get_by_text(inactive_name, exact=True)).to_be_visible()
    page.wait_for_load_state('networkidle')
    assert len(requests) == 2, requests
    assert requests[-1].endswith('?include_inactive=1'), requests
    result['filter_during_refresh_uses_latest_state'] = True
    browser.close()
Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
