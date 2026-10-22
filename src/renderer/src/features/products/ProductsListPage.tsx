import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Boxes, FileDown, FileUp, Plus, Search } from 'lucide-react';
import type { ProductFilter } from '@shared/contracts';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { call, errorMessage, useCommandQuery } from '../../lib/api';
import { useCan, useCanSeeCost } from '../../lib/session';
import { useToast } from '../../lib/toast';
import { useDebounced } from '../../lib/useDebounced';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/form';
import { Card, EmptyState, ErrorBanner, PageHeader, Spinner, Badge } from '../../components/ui/layout';
import { Pagination, Table, Td, Th, THead, Tr } from '../../components/ui/table';
import { ProductFormDialog } from './ProductFormDialog';
import { ImportDialog } from './ImportDialog';
import { ProductsTabs, StockBadge } from './shared';
import { cn } from '../../lib/cn';

const PAGE_SIZE = 50;
type Sort = ProductFilter['sort'];

export function ProductsListPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const can = useCan();
  const toast = useToast();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const debounced = useDebounced(search.trim(), 200);

  const num = (k: string) => (params.get(k) ? Number(params.get(k)) : undefined);
  const filter = {
    search: debounced || undefined,
    categoryId: num('category'),
    brandId: num('brand'),
    supplierId: num('supplier'),
    stock: (params.get('stock') as ProductFilter['stock']) ?? 'ALL',
    active: (params.get('active') as ProductFilter['active']) ?? 'ACTIVE',
    sort: (params.get('sort') as Sort) ?? 'name',
    dir: (params.get('dir') as 'asc' | 'desc') ?? 'asc',
  };
  const page = num('page') ?? 1;
  const list = useCommandQuery('products.list', { ...filter, page, pageSize: PAGE_SIZE }, { placeholderData: (prev) => prev });
  const catalog = useCommandQuery('catalog.get');

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const sortBy = (s: Sort) => {
    const next = new URLSearchParams(params);
    const dir = filter.sort === s && filter.dir === 'asc' ? 'desc' : 'asc';
    next.set('sort', s);
    next.set('dir', dir);
    setParams(next, { replace: true });
  };

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      const { search: s, categoryId, brandId, supplierId, stock, active, sort, dir } = filter;
      const result = await call('products.export', { format, filter: { search: s, categoryId, brandId, supplierId, stock, active, sort, dir } });
      if (result) toast.success('Products exported', result.path);
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const showCost = useCanSeeCost();
  const SortHead = ({ s, children, align }: { s: Sort; children: string; align?: 'right' }) => (
    <Th align={align}>
      <button
        type="button"
        onClick={() => sortBy(s)}
        className={cn('inline-flex items-center gap-1 uppercase hover:text-ink', filter.sort === s && 'text-ink')}
      >
        {children}
        {filter.sort === s && (filter.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </Th>
  );

  return (
    <>
      <PageHeader
        title="Products & Stock"
        actions={
          <>
            <Button variant="ghost" icon={<FileDown className="size-4" />} busy={exporting} onClick={() => exportAs('xlsx')}>
              Export Excel
            </Button>
            <Button variant="ghost" onClick={() => exportAs('csv')} disabled={exporting}>
              CSV
            </Button>
            {can('products.manage') && (
              <>
                <Button variant="outline" icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
                  Import
                </Button>
                <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  Add product
                </Button>
              </>
            )}
          </>
        }
      />
      <ProductsTabs />
      <Card>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3.5">
          <div className="relative min-w-72 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input
              aria-label="Search products"
              placeholder="Search by name, code, brand or category…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setParam('page', undefined);
              }}
              className="pl-9"
              autoFocus
            />
          </div>
          <Select aria-label="Category" className="w-44" value={params.get('category') ?? ''} onChange={(e) => setParam('category', e.target.value)}>
            <option value="">All categories</option>
            {catalog.data?.categories
              .filter((c) => c.kind === 'PRODUCT')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
          <Select aria-label="Brand" className="w-40" value={params.get('brand') ?? ''} onChange={(e) => setParam('brand', e.target.value)}>
            <option value="">All brands</option>
            {catalog.data?.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          {catalog.data && catalog.data.suppliers.length > 0 && (
            <Select aria-label="Supplier" className="w-40" value={params.get('supplier') ?? ''} onChange={(e) => setParam('supplier', e.target.value)}>
              <option value="">All suppliers</option>
              {catalog.data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label="Stock status" className="w-40" value={filter.stock} onChange={(e) => setParam('stock', e.target.value === 'ALL' ? undefined : e.target.value)}>
            <option value="ALL">Any stock level</option>
            <option value="LOW_OR_OUT">Low or out</option>
            <option value="LOW">Low stock</option>
            <option value="OUT">Out of stock</option>
            <option value="IN_STOCK">In stock</option>
          </Select>
          <Select aria-label="Status" className="w-32" value={filter.active} onChange={(e) => setParam('active', e.target.value === 'ACTIVE' ? undefined : e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ALL">All</option>
          </Select>
        </div>

        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <div className="p-4">
            <ErrorBanner message={list.error.message} onRetry={() => void list.refetch()} />
          </div>
        ) : list.data.rows.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={list.data.total === 0 && !filter.search && filter.stock === 'ALL' ? 'No products yet' : 'No products match'}
            description={
              list.data.total === 0 && !filter.search && filter.stock === 'ALL'
                ? 'Add products one at a time, or import your existing list from Excel or CSV.'
                : 'Try a different search or clear the filters.'
            }
            action={
              can('products.manage') && !filter.search ? (
                <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                  Add product
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table>
              <THead>
                <tr>
                  <SortHead s="sku">Code</SortHead>
                  <SortHead s="name">Product</SortHead>
                  <SortHead s="qty" align="right">
                    In stock
                  </SortHead>
                  <SortHead s="price" align="right">
                    Selling price
                  </SortHead>
                  {showCost && <Th align="right">Cost</Th>}
                  {showCost && (
                    <SortHead s="value" align="right">
                      Stock value
                    </SortHead>
                  )}
                </tr>
              </THead>
              <tbody>
                {list.data.rows.map((p) => (
                  <Tr
                    key={p.id}
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() => navigate(`/products/${p.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/products/${p.id}`)}
                  >
                    <Td className="font-mono text-[13px] whitespace-nowrap text-ink-2">{p.sku}</Td>
                    <Td>
                      <span className="font-medium text-ink">{p.name}</span>
                      {!p.isActive && (
                        <Badge className="ml-2" tone="neutral">
                          Inactive
                        </Badge>
                      )}
                      <span className="block text-[12px] text-ink-3">{[p.categoryName, p.brandName].filter(Boolean).join(' · ')}</span>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      <span className={cn(p.status === 'OUT' && 'text-danger', p.status === 'LOW' && 'text-warning', 'font-medium')}>
                        {formatQty(p.qty)}
                      </span>{' '}
                      <span className="text-ink-3">{p.unitCode}</span>
                      <div className="mt-0.5">
                        <StockBadge status={p.status} />
                      </div>
                    </Td>
                    <Td align="right">
                      {formatMoney(p.sellingPrice)}
                      <span className="block text-[12px] text-ink-3">{p.priceIncludesTax ? 'incl.' : '+'} GST {p.gstRateBp / 100}%</span>
                    </Td>
                    {showCost && <Td align="right">{p.purchasePrice === null ? '' : formatMoney(p.purchasePrice)}</Td>}
                    {showCost && <Td align="right">{p.stockValue === null ? '' : formatMoney(p.stockValue)}</Td>}
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(n) => setParam('page', String(n))} />
          </>
        )}
      </Card>

      {adding && <ProductFormDialog product={null} onClose={() => setAdding(false)} onSaved={(p) => navigate(`/products/${p.id}`)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
