export { actionLabel, fieldLabel, formatFieldValue, pretty } from '@shared/auditFormat';

export function actionTone(action: string): 'danger' | 'warning' | 'success' | 'neutral' | 'info' {
  if (action.includes('FAILED') || action === 'DENIED' || action.includes('LOCKED') || action === 'STOCK_DAMAGE' || action === 'STOCK_LOSS')
    return 'danger';
  if (action.includes('DELETE') || action.includes('DEACTIVATE') || action.includes('CANCEL') || action.includes('REVERS'))
    return 'warning';
  if (action === 'PRICE_CHANGE') return 'info';
  if (action === 'CREATE' || action.includes('CREATED') || action === 'IMPORT' || action === 'ISSUE') return 'success';
  if (action === 'RETURN' || action === 'EXTEND' || action === 'RESERVE') return 'info';
  if (action === 'VOID' || action === 'CASH_SHORT' || action === 'CASH_OVER') return 'warning';
  if (action === 'SUPPLIER_PAID' || action === 'COST_UPDATED' || action === 'SUPPLIER_RETURN') return 'info';
  return 'neutral';
}
