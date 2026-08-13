import { TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import Transactions from '@models/transactions.model';
import { linkTransactions } from '@services/transactions/transactions-linking/link-transactions';
import { Op } from 'sequelize';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 4;

/**
 * Auto-detect internal transfers among a user's transactions and link them.
 *
 * When money moves between a user's own accounts it lands as an expense in one
 * account and an income in the other. Imported one account at a time, those two
 * legs arrive as unrelated income/expense rows that double-count in reports.
 * This finds the matching legs — same currency, same amount, opposite
 * direction, different accounts, close in time — and links each pair via the
 * canonical `linkTransactions` service so they collapse into a single transfer
 * (which drops out of income/expense totals). Linking only stamps
 * transferId/transferNature; it never moves balances, so re-running is safe.
 *
 * Deliberately conservative to avoid false positives: an exact amount + currency
 * match, opposite type, different account, and a tight time window. Anything it
 * gets wrong the user can unlink.
 */
export async function autoDetectAndLinkTransfers({
  userId,
  fromDate,
  toDate,
  windowDays = DEFAULT_WINDOW_DAYS,
}: {
  userId: number;
  fromDate: Date;
  toDate: Date;
  windowDays?: number;
}): Promise<{ linkedCount: number }> {
  const windowMs = windowDays * DAY_MS;
  const rangeStart = new Date(fromDate.getTime() - windowMs);
  const rangeEnd = new Date(toDate.getTime() + windowMs);

  // Only the user's own, not-yet-linked rows within the padded date window are
  // candidates. Already-linked transfers carry a non-`not_transfer` nature and
  // are excluded, which also makes repeated runs idempotent.
  const candidates = await Transactions.findAll({
    where: {
      userId,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      time: { [Op.between]: [rangeStart, rangeEnd] },
    },
    order: [['time', 'ASC']],
  });

  if (candidates.length < 2) return { linkedCount: 0 };

  const expenses = candidates.filter((tx) => tx.transactionType === TRANSACTION_TYPES.expense);

  // Bucket the income legs by currency+amount so each expense only scans the
  // handful of income rows that could possibly be its counterpart.
  const incomeByKey = new Map<string, Transactions[]>();
  for (const income of candidates) {
    if (income.transactionType !== TRANSACTION_TYPES.income) continue;
    const key = `${income.currencyCode}:${income.amount.toCents()}`;
    const bucket = incomeByKey.get(key);
    if (bucket) bucket.push(income);
    else incomeByKey.set(key, [income]);
  }

  const usedIds = new Set<string>();
  const pairs: [string, string][] = [];

  for (const expense of expenses) {
    if (usedIds.has(expense.id)) continue;
    const bucket = incomeByKey.get(`${expense.currencyCode}:${expense.amount.toCents()}`);
    if (!bucket) continue;

    // Pick the closest-in-time income leg in a different account that is still
    // free and within the window.
    let best: Transactions | null = null;
    let bestDelta = Infinity;
    for (const income of bucket) {
      if (usedIds.has(income.id)) continue;
      if (income.accountId === expense.accountId) continue;
      const delta = Math.abs(income.time.getTime() - expense.time.getTime());
      if (delta > windowMs) continue;
      if (delta < bestDelta) {
        best = income;
        bestDelta = delta;
      }
    }

    if (best) {
      usedIds.add(expense.id);
      usedIds.add(best.id);
      pairs.push([expense.id, best.id]);
    }
  }

  if (pairs.length === 0) return { linkedCount: 0 };

  // Link one pair at a time so a single rejected candidate (e.g. a loan-account
  // leg `linkTransactions` refuses) can't roll back the rest.
  let linkedCount = 0;
  for (const pair of pairs) {
    try {
      await linkTransactions({ userId, ids: [pair] });
      linkedCount += 1;
    } catch (err) {
      logger.warn({ message: '[CSV import] Skipped an auto transfer-link candidate', error: err as Error });
    }
  }

  return { linkedCount };
}
