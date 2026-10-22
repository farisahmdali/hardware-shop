import { forwardRef, useEffect, useState, type InputHTMLAttributes } from 'react';
import { paiseToDecimalString, parseMoney } from '@shared/money';
import { parseQty, qtyToDecimalString } from '@shared/qty';
import { Input } from './form';
import { cn } from '../../lib/cn';

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>;

interface MoneyInputProps extends BaseProps {
  /** Paise, or null when empty/invalid. */
  value: number | null;
  onValueChange(paise: number | null, valid: boolean): void;
}

/** Rupee amount input that keeps what the user typed and reports exact paise. */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onValueChange, className, ...rest },
  ref,
) {
  const [text, setText] = useState(value === null ? '' : paiseToDecimalString(value));
  useEffect(() => {
    // Follow external changes (form reset) without fighting the user's typing.
    setText((t) => {
      const parsed = parseMoney(t);
      return parsed === value ? t : value === null ? '' : paiseToDecimalString(value);
    });
  }, [value]);
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">₹</span>
      <Input
        ref={ref}
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = e.target.value.trim() === '' ? null : parseMoney(e.target.value);
          onValueChange(parsed !== null && parsed >= 0 ? parsed : null, e.target.value.trim() === '' || (parsed !== null && parsed >= 0));
        }}
        className={cn('pl-7 text-right tabular', className)}
        {...rest}
      />
    </div>
  );
});

interface QtyInputProps extends BaseProps {
  value: number | null;
  allowDecimal: boolean;
  unit?: string;
  onValueChange(milli: number | null, valid: boolean): void;
}

/** Quantity input in units (3 decimals where the unit allows), reporting milli-units. */
export const QtyInput = forwardRef<HTMLInputElement, QtyInputProps>(function QtyInput(
  { value, allowDecimal, unit, onValueChange, className, ...rest },
  ref,
) {
  const [text, setText] = useState(value === null ? '' : qtyToDecimalString(value));
  useEffect(() => {
    setText((t) => {
      const parsed = parseQty(t, true);
      return parsed === value ? t : value === null ? '' : qtyToDecimalString(value);
    });
  }, [value]);
  useEffect(() => {
    const parsed = text.trim() === '' ? null : parseQty(text, allowDecimal);
    onValueChange(parsed, text.trim() === '' || parsed !== null);
    // Re-validate when the unit changes between whole and decimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowDecimal]);
  return (
    <div className="relative">
      <Input
        ref={ref}
        inputMode={allowDecimal ? 'decimal' : 'numeric'}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = e.target.value.trim() === '' ? null : parseQty(e.target.value, allowDecimal);
          onValueChange(parsed, e.target.value.trim() === '' || parsed !== null);
        }}
        className={cn('text-right tabular', unit && 'pr-14', className)}
        {...rest}
      />
      {unit && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[13px] text-ink-3">{unit}</span>}
    </div>
  );
});

export const newRequestId = (): string => crypto.randomUUID();
