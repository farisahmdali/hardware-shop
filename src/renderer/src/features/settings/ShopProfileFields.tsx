import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { z } from 'zod';
import { GST_STATES } from '@shared/gstStates';
import type { shopProfileSchema } from '@shared/settings';
import { Field, Input, Select, Textarea } from '../../components/ui/form';

export type ShopProfileInput = z.input<typeof shopProfileSchema>;

/** Shop profile form fields, shared by the setup wizard and the settings screen. */
export function ShopProfileFields({
  register,
  errors,
  showFooter = true,
}: {
  register: UseFormRegister<ShopProfileInput>;
  errors: FieldErrors<ShopProfileInput>;
  showFooter?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
      <Field label="Shop name" required error={errors.name?.message} className="col-span-2" hint="Printed at the top of every invoice.">
        {(p) => <Input {...p} {...register('name')} autoFocus />}
      </Field>
      <Field label="Address line 1" error={errors.addressLine1?.message} className="col-span-2">
        {(p) => <Input {...p} {...register('addressLine1')} />}
      </Field>
      <Field label="Address line 2" error={errors.addressLine2?.message} className="col-span-2">
        {(p) => <Input {...p} {...register('addressLine2')} />}
      </Field>
      <Field label="City / town" error={errors.city?.message}>
        {(p) => <Input {...p} {...register('city')} />}
      </Field>
      <Field label="PIN code" error={errors.pincode?.message}>
        {(p) => <Input {...p} {...register('pincode')} inputMode="numeric" maxLength={6} />}
      </Field>
      <Field
        label="State"
        required
        error={errors.stateCode?.message}
        hint="Decides CGST + SGST (same state) or IGST (other state)."
      >
        {(p) => (
          <Select {...p} {...register('stateCode')}>
            <option value="">Select state…</option>
            {GST_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} – {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="GSTIN" error={errors.gstin?.message} hint="Leave empty if the shop is not GST registered.">
        {(p) => <Input {...p} {...register('gstin')} className="uppercase" maxLength={15} />}
      </Field>
      <Field label="Phone" error={errors.phone?.message}>
        {(p) => <Input {...p} {...register('phone')} inputMode="tel" />}
      </Field>
      <Field label="Email" error={errors.email?.message}>
        {(p) => <Input {...p} {...register('email')} type="email" />}
      </Field>
      {showFooter && (
        <Field
          label="Invoice footer"
          error={errors.invoiceFooter?.message}
          className="col-span-2"
          hint="For example terms, bank details or a thank-you note."
        >
          {(p) => <Textarea {...p} {...register('invoiceFooter')} rows={2} />}
        </Field>
      )}
    </div>
  );
}
