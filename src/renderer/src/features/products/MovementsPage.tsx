import { Card, PageHeader } from '../../components/ui/layout';
import { MovementsTable } from './MovementsTable';
import { ProductsTabs } from './shared';

export function MovementsPage() {
  return (
    <>
      <PageHeader title="Products & Stock" />
      <ProductsTabs />
      <Card>
        <MovementsTable />
      </Card>
    </>
  );
}
