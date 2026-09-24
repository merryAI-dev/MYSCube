import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAnalyticsQuery } from './analytics-engine.mjs';

const sales = { datasetId: 'sales', schema: [{ name: 'id', type: 'integer' }, { name: 'amount', type: 'decimal', scale: 2 }, { name: 'cost', type: 'integer' }, { name: 'period', type: 'date' }, { name: 'customer', type: 'string' }], rows: [
  { id: 1, amount: '100.50', cost: null, period: '2026-08-01', customer: '가' },
  { id: 2, amount: '0', cost: 0, period: '2026-09-01', customer: '나' },
  { id: 3, amount: '20.25', cost: 10, period: '2026-09-12', customer: '가' },
] };
const query = (sql, datasets = [sales], options) => executeAnalyticsQuery({ sql, datasets }, options);

describe('disposable native DuckDB analytics', () => {
  it('calculates exact decimals and preserves unknown versus confirmed zero', async () => {
    const result = await query('select sum(amount) as total, count(cost) as confirmed, count(*) as all_rows from sales');
    expect(result.rows).toEqual([{ total: '120.75', confirmed: '2', all_rows: '3' }]);
    expect(result.columns[0]).toEqual({ name: 'total', type: 'DECIMAL(38,2)' });
    const raw = await query('select cost from sales order by id');
    expect(raw.rows).toEqual([{ cost: null }, { cost: '0' }, { cost: '10' }]);
    expect(result.executedSql).toContain('LIMIT 501');
    expect(result.normalizedSql).toContain('sum(amount)');
  });
  it('supports generic date filtering, CTE, joins, grouping and ranking', async () => {
    const customers = { datasetId: 'customers', schema: [{ name: 'customer', type: 'string' }, { name: 'team', type: 'string' }], rows: [{ customer: '가', team: 'CIC1' }, { customer: '나', team: 'CIC2' }] };
    const result = await query("with monthly as (select * from sales where period >= DATE '2026-09-01') select c.team, sum(s.amount) as total, row_number() over(order by sum(s.amount) desc) as position from monthly s left join customers c on s.customer=c.customer group by c.team order by total desc", [sales, customers]);
    expect(result.rows).toEqual([{ team: 'CIC1', total: '20.25', position: '1' }, { team: 'CIC2', total: '0.00', position: '2' }]);
    expect(result.usedDatasetIds).toEqual(['customers', 'sales']);
  });
  it('does not reinterpret quoted SQL keywords as instructions', async () => {
    expect((await query("select 'DROP TABLE sales; INSTALL httpfs;' as note from sales limit 1")).rows[0].note).toBe('DROP TABLE sales; INSTALL httpfs;');
  });
  it('does not claim an unused or shadowed CTE as evidence for fabricated constant rows', async () => {
    await expect(query('with unused as (select * from sales) select 999 as fabricated')).rejects.toMatchObject({ code: 'analytics_sql_without_dataset' });
    await expect(query('with sales as (select 999 as fabricated) select * from sales')).rejects.toMatchObject({ code: 'analytics_sql_not_allowed' });
    const extra = { datasetId: 'extra', schema: [{ name: 'id', type: 'integer' }], rows: [{ id: 1 }] };
    const result = await query('with unused as (select * from extra), actual as (select * from sales) select count(*) as n from actual', [sales, extra]);
    expect(result.usedDatasetIds).toEqual(['sales']);
    expect(result.rows).toEqual([{ n: '3' }]);
  });
  it('rejects undefined arithmetic instead of silently turning it into a missing or zero value', async () => {
    await expect(query('select 1/cost as ratio from sales')).rejects.toMatchObject({ code: 'analytics_non_finite_result' });
    expect((await query('select 1/nullif(cost,0) as ratio from sales order by id')).rows).toEqual([{ ratio: null }, { ratio: null }, { ratio: 0.1 }]);
  });
  it.each([
    "select * from read_csv('/etc/passwd')", "select * from 'https://example.com/data.csv'", "select * from read_json('https://example.com')", "select * from duckdb_settings()",
    'select getenv(\'SECRET\') from sales', "select current_setting('enable_external_access') from sales", 'select * from information_schema.tables', 'select * from other_tenant',
    'select * from sales; delete from sales', 'COPY sales TO \'/tmp/axr-secret.csv\'', 'INSTALL httpfs', "ATTACH '/tmp/database.db' AS remote", 'SET enable_external_access=true',
    "select query('SELECT * FROM sales') from sales", 'select * from range(100000000000)', 'with recursive a(x) as (select 1 union all select x+1 from a) select * from a',
    "select repeat('x',1000000000) from sales", "select json_execute_serialized_sql('{}') from sales",
  ])('rejects external access, settings, catalog functions, writes or unbounded generators: %s', async (sql) => {
    await expect(query(sql)).rejects.toMatchObject({ code: 'analytics_sql_not_allowed' });
  });
  it('caps result rows and declares truncation', async () => {
    const dataset = { datasetId: 'items', schema: [{ name: 'id', type: 'integer' }], rows: Array.from({ length: 700 }, (_, id) => ({ id })) };
    const result = await query('select * from items order by id', [dataset]);
    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
  it('does not reach a real local network canary or modify a real filesystem canary', async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('id\n1\n'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const directory = await mkdtemp(join(tmpdir(), 'axr-analytics-'));
    const file = join(directory, 'canary.csv');
    await writeFile(file, 'unchanged');
    try {
      await expect(query(`select * from read_csv('http://127.0.0.1:${server.address().port}/canary.csv')`)).rejects.toMatchObject({ code: 'analytics_sql_not_allowed' });
      await expect(query(`COPY sales TO '${file}'`)).rejects.toMatchObject({ code: 'analytics_sql_not_allowed' });
      expect(requests).toBe(0);
      expect(await readFile(file, 'utf8')).toBe('unchanged');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('kills a costly native join within the caller budget and leaves later queries usable', async () => {
    const data = { datasetId: 'items', schema: [{ name: 'id', type: 'integer' }], rows: Array.from({ length: 5000 }, (_, id) => ({ id })) };
    await expect(query('select sum(a.id*b.id*c.id) as total from items a cross join items b cross join items c', [data], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await query('select count(*) as n from sales')).rows[0].n).toBe('3');
  });
  it('enforces a process deadline, rejects concurrency, and recovers for a later request', async () => {
    const pending = query('select * from sales', [sales], { timeoutMs: 1 });
    const concurrent = query('select * from sales');
    await expect(concurrent).rejects.toMatchObject({ code: 'analytics_query_busy' });
    await expect(pending).rejects.toMatchObject({ code: 'analytics_query_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await query('select count(*) as n from sales')).rows).toEqual([{ n: '3' }]);
  });
  it('honors cancellation before spawning and never inherits a query-selected environment or path', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(query('select * from sales', [sales], { signal: controller.signal })).rejects.toMatchObject({ code: 'analytics_query_cancelled' });
    await expect(query('select * from sales', [{ ...sales, datasetId: 'sales"; DROP TABLE sales; --' }])).rejects.toMatchObject({ code: 'analytics_identifier_invalid' });
  });
});
