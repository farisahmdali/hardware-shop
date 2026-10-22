import { Card } from '../../components/ui/layout';
import { InvoicesTable } from './InvoicesTable';
import { SalesTabs } from './SalesTabs';

export function InvoicesPage() {
  return (
    <>
      <div className="mb-4">
        <SalesTabs />
      </div>
      <Card>
        <InvoicesTable />
      </Card>
    </>
  );
}
