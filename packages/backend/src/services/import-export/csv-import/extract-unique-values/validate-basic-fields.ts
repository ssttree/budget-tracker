import type { ColumnMappingConfig } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';

export function validateBasicFields({
  headers,
  columnMapping,
}: {
  headers: string[];
  columnMapping: ColumnMappingConfig;
}): void {
  if (!headers.includes(columnMapping.date)) {
    throw new ValidationError({
      message: t({ key: 'csvImport.dateColumnNotFound', variables: { columnName: columnMapping.date } }),
    });
  }

  // Amount comes either from a single signed column or from a debit/credit column
  // pair. Validate whichever mode the mapping actually uses — in split mode the
  // `amount` field is intentionally blank and must not be checked.
  const usesSplitAmount = Boolean(columnMapping.debitColumn || columnMapping.creditColumn);
  if (usesSplitAmount) {
    for (const column of [columnMapping.debitColumn, columnMapping.creditColumn]) {
      if (column && !headers.includes(column)) {
        throw new ValidationError({
          message: t({ key: 'csvImport.amountColumnNotFound', variables: { columnName: column } }),
        });
      }
    }
  } else if (!headers.includes(columnMapping.amount)) {
    throw new ValidationError({
      message: t({ key: 'csvImport.amountColumnNotFound', variables: { columnName: columnMapping.amount } }),
    });
  }
}
