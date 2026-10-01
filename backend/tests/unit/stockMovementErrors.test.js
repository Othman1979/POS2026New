const {appendIngredientRows}=require('../../services/StockLedgerService');

test('preserves the deadlock error when InnoDB has already rolled back the transaction and its savepoint', async () => {
    const deadlock=Object.assign(new Error('Deadlock fixture'),{code:'ER_LOCK_DEADLOCK'});
    const queries=[];
    const conn={async query(sql) {
        queries.push(sql);
        if(sql.startsWith('SELECT CAST(id AS CHAR) ingredient_id'))return [[{ingredient_id:'1',stock_item_id:'1',last_count_id:'0'}]];
        if(sql==='SAVEPOINT ingredient_movement_post')return [{}];
        if(sql.startsWith('SELECT id FROM stock_items'))throw deadlock;
        if(sql.startsWith('ROLLBACK TO SAVEPOINT'))throw Object.assign(new Error('Savepoint no longer exists'),{code:'ER_SP_DOES_NOT_EXIST'});
        throw new Error('Unexpected query: '+sql);
    }};
    await expect(appendIngredientRows(conn,[{ingredient_id:1,kind:'receipt',qty:1,source_type:'manual',business_date:'2026-09-12',client_key:'deadlock-fixture'}])).rejects.toBe(deadlock);
    expect(queries.some(sql=>sql.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(false);
});
