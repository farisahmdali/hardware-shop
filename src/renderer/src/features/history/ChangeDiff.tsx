import { cn } from '../../lib/cn';
import { fieldLabel, flattenValues as flatten, showValue as show } from '@shared/auditFormat';

/** Field-by-field before/after table. Unchanged fields are listed after the changes and dimmed. */
export function ChangeDiff({ before, after }: { before: unknown; after: unknown }) {
  const b = flatten(before);
  const a = flatten(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (keys.length === 0) return <p className="text-ink-3">No field values were recorded for this action.</p>;
  const changed = keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  const unchanged = before && after ? keys.filter((k) => !changed.includes(k)) : [];
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;

  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-left text-ink-3">
          <th className="w-1/4 py-1.5 pr-3 font-medium">Field</th>
          {hasBefore && <th className="py-1.5 pr-3 font-medium">Before</th>}
          {hasAfter && <th className="py-1.5 font-medium">{hasBefore ? 'After' : 'Value'}</th>}
        </tr>
      </thead>
      <tbody>
        {[...changed, ...unchanged].map((k) => {
          const isChanged = changed.includes(k);
          return (
            <tr key={k} className={cn('border-t border-line', !isChanged && 'text-ink-3')}>
              <td className="py-1.5 pr-3" title={k}>
                {fieldLabel(k)}
              </td>
              {hasBefore && (
                <td className={cn('py-1.5 pr-3 break-all', isChanged && hasAfter && 'text-danger line-through decoration-danger/40')}>
                  {show(k, b[k])}
                </td>
              )}
              {hasAfter && <td className={cn('py-1.5 break-all', isChanged && hasBefore && 'font-medium text-success')}>{show(k, a[k])}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
